import copy
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-177-tests-'))
import pulse_core as core
from pulse_core import discovery, discovery_crossencoder as cross, literature_search as literature
from pulse_core.discovery_queries import search_query_plan
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank, foundational_support
from pulse_performance import REQUEST_CONTEXT, DiscoveryCancelled

SEED = {'title': 'Urban transport safety research', 'doi': '10.1234/seed'}


def paper(index, **fields):
    return dict(title=f'Protected bicycle lanes reduce intersection injuries study {index}',
                abstract='Protected bicycle lanes reduce intersection injuries.',
                doi=f'10.1234/article-{index}', **fields)


class ExtraHopTests(unittest.TestCase):
    def tearDown(self):
        REQUEST_CONTEXT.deadline = None

    def test_one_hop_is_default_and_does_not_resolve_neighbors(self):
        with patch.object(core, 's2_paper_id_for_paper', return_value='seed') as identify, \
             patch.object(core, 's2_fetch_citations', return_value=[paper('cite')]) as citing, \
             patch.object(core, 's2_fetch_references', return_value=[paper('ref')]) as refs:
            found = discovery.fetch_citation_graph_branch([SEED])
        self.assertEqual(len(found), 2)
        self.assertTrue(all(p['hop'] == 1 for p in found))
        identify.assert_called_once(); citing.assert_called_once(); refs.assert_called_once()

    def test_extra_hops_share_eight_seconds_preserve_results_and_restore_outer_budget(self):
        clock = [0.0]
        REQUEST_CONTEXT.deadline = 40
        def references(identifier, **kwargs):
            if identifier == 'seed': return [paper('ref')]
            self.assertEqual(REQUEST_CONTEXT.deadline, 8)
            clock[0] = 9
            return [paper('hop-two')]
        with patch.object(discovery.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(core, 's2_paper_id_for_paper', side_effect=['seed', 'neighbor']), \
             patch.object(core, 's2_fetch_citations', return_value=[paper('cite')]), \
             patch.object(core, 's2_fetch_references', side_effect=references):
            found = discovery.fetch_citation_graph_branch([SEED], depth=3)
        self.assertEqual(len(found), 3)
        self.assertFalse(found.warning)
        self.assertEqual(found.notices[0]['code'], 'extra-hop-limit')
        self.assertIn('time budget', found.notices[0]['message'])
        self.assertEqual(REQUEST_CONTEXT.deadline, 40)

    def test_extra_hop_cancellation_propagates_and_keeps_shorter_outer_deadline(self):
        REQUEST_CONTEXT.deadline = 4
        def identify(paper, **kwargs):
            if paper == SEED: return 'seed'
            self.assertEqual(REQUEST_CONTEXT.deadline, 4)
            raise DiscoveryCancelled()
        with patch.object(discovery.time, 'monotonic', return_value=0), \
             patch.object(core, 's2_paper_id_for_paper', side_effect=identify), \
             patch.object(core, 's2_fetch_citations', return_value=[paper('cite')]), \
             patch.object(core, 's2_fetch_references', return_value=[paper('ref')]):
            with self.assertRaises(DiscoveryCancelled):
                discovery.fetch_citation_graph_branch([SEED], depth=2)
        self.assertEqual(REQUEST_CONTEXT.deadline, 4)


class DisplayBandTests(unittest.TestCase):
    def test_seven_hundred_candidates_do_not_make_two_hundred_results_related(self):
        records = [paper(i, retrievalEvidence=[{'channel': 'concepts:q1', 'rank': i+1}]) for i in range(700)]
        found = rank({'concepts': records}, [SEED], {'limit': 200, 'diversify': False})
        self.assertEqual(len(found), 200)
        self.assertEqual(sum(p['matchLabel'] == 'Related' for p in found), 80)
        self.assertEqual(sum(p['matchLabel'] == 'Explore' for p in found), 120)
        self.assertTrue(all(p['matchPoolSize'] == 700 and p['matchDisplaySize'] == 200 for p in found))


class FoundationalTests(unittest.TestCase):
    def test_relevant_cited_landmark_receives_a_bounded_non_velocity_prior(self):
        year = datetime.date.today().year
        records = [paper('old', year=str(year-30), citationCount=5000, hop=1,
                         retrievalEvidence=[{'channel': 'citations:0:backward', 'rank': 2}]),
                   paper('new', year=str(year), citationCount=100, hop=1,
                         retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}]),
                   paper('third', year=str(year), citationCount=5, hop=1,
                         retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 3}])]
        options = {'diversify': False, 'citationVelocityPrior': False, 'citationLinkBonus': False, 'backwardCitationWeight': 0}
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[.8]*3):
            boosted = rank({'citationGraph': records}, [SEED], options.copy())
            baseline = rank({'citationGraph': records}, [SEED], dict(options, foundationalPrior=False))
        old = next(p for p in boosted if p['doi'].endswith('-old'))
        original = next(p for p in baseline if p['doi'] == old['doi'])
        self.assertAlmostEqual(old['score']-original['score'], 4.8, places=2)
        self.assertLess(old['rank'], original['rank'])

    def test_popularity_alone_missing_counts_and_off_topic_work_receive_no_foundational_bonus(self):
        evidence = [{'channel': 'citations:0:backward'}]
        for fields, relevance in [({'citationCount': 5000}, .8),
                                  ({'citationCount': 5000, 'retrievalEvidence': evidence}, 0),
                                  ({'retrievalEvidence': evidence}, .8),
                                  ({'citationCount': True, 'retrievalEvidence': evidence}, .8),
                                  ({'citationCount': -1, 'retrievalEvidence': evidence}, .8)]:
            self.assertEqual(foundational_support(paper('test', **fields), relevance), 0)


class CoreRecoveryTests(unittest.TestCase):
    def test_transient_500_recovers_once(self):
        with patch.object(literature, 'fetch_search', side_effect=[core.ClientError(500, 'CORE: HTTP 500'),
                          {'results': [paper('recovered')], 'totalHits': 1}]) as fetch, \
             patch.object(literature, '_wait') as wait:
            found = literature.search_core('transport')
        self.assertEqual(len(found), 1); self.assertEqual(fetch.call_count, 2)
        wait.assert_called_once_with(.5)

    def test_persistent_500_stops_plan_and_rate_limit_has_no_retry(self):
        for status, attempts in [(500, 2), (429, 1), (401, 1), (403, 1)]:
            with patch.object(literature, 'fetch_search', side_effect=core.ClientError(status, f'CORE: HTTP {status}')) as fetch, \
                 patch.object(literature, '_wait'):
                plan = [{'kind': 'seed', 'id': str(i), 'text': 'urban transport'} for i in range(5)]
                with self.assertRaises(RuntimeError):
                    search_query_plan(plan, 'core', literature.search_core, 200)
            self.assertEqual(fetch.call_count, attempts)


class PortableRuntimeTests(unittest.TestCase):
    def test_runtime_prefers_relative_bundled_executable_and_rejects_model_only_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = root / 'pulse-backend'
            runtime = backend / '.search-runtime'
            model = runtime / 'model'; model.mkdir(parents=True)
            for name in ('model.onnx', 'tokenizer.json'): (model / name).touch()
            exe = runtime / 'bin/pulse-reranker'; exe.parent.mkdir(); exe.touch()
            manifest = runtime / 'manifest.json'
            manifest.write_text(json.dumps({'format': 'onnx-executable-v1', 'executable': 'bin/pulse-reranker', 'modelDirectory': 'model'}))
            with patch.object(cross, '__file__', str(backend / 'pulse_core/discovery_crossencoder.py')), \
                 patch.object(cross.Path, 'home', return_value=root), patch.dict(os.environ, {'PULSE_CONFIG_DIR': str(root)}, clear=True):
                self.assertEqual(cross._find_search_runtime({}), (exe.resolve(), model.resolve()))
                manifest.write_text(json.dumps({'python': sys.executable}))
                self.assertEqual(cross._find_search_runtime({}), (None, None))

    def test_pairwise_failure_notice_is_shown_in_main_ranking_notice(self):
        notice = 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
        options = {'_pairwiseReranker': lambda queries, records: (None, notice)}
        rank({'concepts': [paper(1)]}, [SEED], options)
        self.assertEqual(options['_rankingNotice'], notice)


if __name__ == '__main__': unittest.main()
