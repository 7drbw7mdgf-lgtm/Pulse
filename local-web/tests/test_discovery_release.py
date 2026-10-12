import copy
import datetime
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-release-tests-'))
import pulse_core as core
from pulse_core import discovery
from pulse_core.constants import ClientError
from pulse_core.discovery_matches import match_label, independent_channel_count
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_performance import DiscoveryCancelled, DiscoveryBudgetExceeded

SEED = {'title': 'Urban transport research', 'doi': '10.1234/seed'}


def paper(index, **fields):
    return dict(title=f'Protected bicycle lanes improve intersection safety in study {index}',
                abstract='Protected bicycle lanes reduce intersection injuries.',
                doi=f'10.1234/result-{index}', **fields)


class CitationFallbackTests(unittest.TestCase):
    def run_branch(self, references, citations, oa_references=None, oa_citations=None):
        with patch.object(core, 's2_paper_id_for_paper', return_value='seed-id'), \
             patch.object(core, 's2_fetch_references', side_effect=references if isinstance(references, Exception) else None, return_value=references), \
             patch.object(core, 's2_fetch_citations', side_effect=citations if isinstance(citations, Exception) else None, return_value=citations), \
             patch.object(core, 'openalex_work_for_paper', return_value={'id':'https://openalex.org/W1', 'referenced_works':['W2']}) as identify, \
             patch.object(discovery, 'openalex_reference_works', side_effect=oa_references if isinstance(oa_references, Exception) else None, return_value=oa_references or [{'id':'W2','title':'A foundational transport paper','doi':'https://doi.org/10.1234/oa-ref'}]) as backward, \
             patch.object(discovery, 'openalex_citing_works', side_effect=oa_citations if isinstance(oa_citations, Exception) else None, return_value=oa_citations or [{'id':'W3','title':'A later transport paper','doi':'https://doi.org/10.1234/oa-cite'}]) as forward:
            result = discovery.fetch_citation_graph_branch([SEED], depth=1)
        return result, identify, backward, forward

    def test_forward_failure_falls_back_even_when_backward_succeeds(self):
        result, _, backward, forward = self.run_branch([paper('ref')], ClientError(429, 'Rate limited'))
        self.assertEqual(len(result), 2)
        backward.assert_not_called(); forward.assert_called_once()
        self.assertEqual(result[-1]['subType'], 'Forward')
        self.assertEqual(result[-1]['retrievalEvidence'][0]['provider'], 'OpenAlex')
        self.assertEqual(result[-1]['hop'], 1)

    def test_backward_failure_does_not_repeat_successful_forward_search(self):
        result, _, backward, forward = self.run_branch(ClientError(503, 'Unavailable'), [paper('cite')])
        backward.assert_called_once(); forward.assert_not_called()
        self.assertEqual({row['subType'] for row in result}, {'Backward', 'Forward'})

    def test_both_successful_directions_skip_openalex(self):
        _, identify, backward, forward = self.run_branch([paper('ref')], [paper('cite')])
        identify.assert_not_called(); backward.assert_not_called(); forward.assert_not_called()

    def test_empty_forward_response_also_uses_fallback(self):
        _, _, backward, forward = self.run_branch([paper('ref')], [])
        backward.assert_not_called(); forward.assert_called_once()

    def test_openalex_backward_error_does_not_block_forward_fallback(self):
        result, _, _, forward = self.run_branch([], [], oa_references=RuntimeError('Reference lookup failed'))
        forward.assert_called_once()
        self.assertEqual(result[0]['subType'], 'Forward')
        self.assertIn('Reference lookup failed', result.warning)

    def test_citations_fetched_before_references_in_s2_and_openalex(self):
        call_order = []
        with patch.object(core, 's2_paper_id_for_paper', return_value='seed-id'), \
             patch.object(core, 's2_fetch_citations', side_effect=lambda *args, **kwargs: call_order.append('s2_cites') or [paper('c1')]), \
             patch.object(core, 's2_fetch_references', side_effect=lambda *args, **kwargs: call_order.append('s2_refs') or [paper('r1')]):
            discovery.fetch_citation_graph_branch([SEED], depth=1)
        self.assertEqual(call_order, ['s2_cites', 's2_refs'])

        oa_order = []
        with patch.object(core, 's2_paper_id_for_paper', return_value=None), \
             patch.object(core, 'openalex_work_for_paper', return_value={'id':'https://openalex.org/W1'}), \
             patch.object(discovery, 'openalex_citing_works', side_effect=lambda *args, **kwargs: oa_order.append('oa_cites') or [{'id':'W3'}]), \
             patch.object(discovery, 'openalex_reference_works', side_effect=lambda *args, **kwargs: oa_order.append('oa_refs') or [{'id':'W2'}]):
            discovery.fetch_citation_graph_branch([SEED], depth=1)
        self.assertEqual(oa_order, ['oa_cites', 'oa_refs'])

    def test_openalex_reference_works_uses_cited_by_query(self):
        with patch.object(discovery, 'openalex_discovery_works', return_value=[{'id': 'W2', 'title': 'Landmark ref'}]) as disc_mock:
            results = discovery.openalex_reference_works('W1', limit=20)
            disc_mock.assert_called_once_with('cited_by:W1', 20, sort='cited_by_count:desc')
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]['id'], 'W2')

    def test_established_forward_stream_survives_recent_stream_failure(self):
        def fetch(work_filter, limit, sort):
            if sort == 'publication_date:desc': raise ClientError(503, 'Recent stream unavailable')
            self.assertEqual(sort, 'cited_by_count:desc')
            return [{'id':'W3'}]
        with patch.object(discovery, 'openalex_discovery_works', side_effect=fetch) as lookup:
            result = discovery.openalex_citing_works('W1', 20)
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual(result[0]['id'], 'W3')
        self.assertIn('Recent stream unavailable', result.warning)

    def test_cancel_and_budget_exhaustion_do_not_start_fallback(self):
        for error in (DiscoveryCancelled(), DiscoveryBudgetExceeded('Budget exhausted')):
            with patch.object(core, 's2_paper_id_for_paper', return_value='seed-id'), \
                 patch.object(core, 's2_fetch_references', return_value=[paper('ref')]), \
                 patch.object(core, 's2_fetch_citations', side_effect=error), \
                 patch.object(core, 'openalex_work_for_paper') as lookup:
                with self.assertRaises(type(error)): discovery.fetch_citation_graph_branch([SEED], depth=1)
                lookup.assert_not_called()


class DefaultVelocityTests(unittest.TestCase):
    def candidates(self):
        year = datetime.date.today().year
        return [paper('recent', year=str(year), citationCount=20),
                paper('old', year=str(year-19), citationCount=100),
                paper('low', year=str(year), citationCount=1)]

    def test_default_prior_is_nine_points_scaled_by_relevance_and_age(self):
        records = self.candidates()
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[.5]*3):
            found = rank({'concepts':records}, [SEED], {'diversify':False})
            off = rank({'concepts':records}, [SEED], {'diversify':False,'citationVelocityPrior':False})
        by_id = {p['doi']:p for p in found}; baseline = {p['doi']:p for p in off}
        self.assertGreater(by_id[records[0]['doi']]['scoreBreakdown']['citationVelocityPrior'], by_id[records[1]['doi']]['scoreBreakdown']['citationVelocityPrior'])
        for row in found:
            delta = row['score'] - baseline[row['doi']]['score']
            self.assertGreaterEqual(delta, 0); self.assertLessEqual(delta, 9)
            self.assertAlmostEqual(row['scoreBreakdown']['citationVelocityPrior'],
                                   .09 * row['scoreBreakdown']['optionalImpact'] * .5, delta=.0001)
            self.assertEqual(baseline[row['doi']]['scoreBreakdown']['citationVelocityPrior'], 0)

    def test_fully_relevant_high_velocity_paper_approaches_nine_point_prior(self):
        year = str(datetime.date.today().year)
        records = [paper(index, year=year, citationCount=index+1) for index in range(100)]
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[1]*100):
            found = rank({'concepts':records}, [SEED], {'diversify':False,'limit':100})
        top_velocity = next(row for row in found if row['doi']==records[-1]['doi'])
        self.assertEqual(top_velocity['scoreBreakdown']['citationVelocityPrior'], .0891)

    def test_lower_relevance_reduces_the_prior_proportionally(self):
        records = self.candidates()
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[1]*3):
            full = rank({'concepts':records}, [SEED], {'diversify':False})
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[.25]*3):
            partial = rank({'concepts':records}, [SEED], {'diversify':False})
        full_by_id = {row['doi']:row for row in full}
        for row in partial:
            self.assertAlmostEqual(row['scoreBreakdown']['citationVelocityPrior'] * 4,
                                   full_by_id[row['doi']]['scoreBreakdown']['citationVelocityPrior'])

    def test_prior_cannot_promote_an_unrelated_popular_paper(self):
        records = self.candidates()
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[0]*3):
            found = rank({'concepts':records}, [SEED], {'diversify':False})
        self.assertTrue(all(row['scoreBreakdown']['citationVelocityPrior'] == 0 for row in found))

    def test_unknown_invalid_and_future_metadata_has_no_prior(self):
        year = datetime.date.today().year
        for fields in ({}, {'citationCount':None}, {'citationCount':True}, {'citationCount':-1}, {'citationCount':float('nan')}, {'citationCount':100, 'year':str(year+1)}):
            with self.subTest(fields=fields):
                records = self.candidates()+[paper('unknown', **fields)]
                found = rank({'concepts':records}, [SEED], {'diversify':False})
                row = next(p for p in found if p['doi'].endswith('-unknown'))
                self.assertEqual(row['scoreBreakdown']['citationVelocityPrior'], 0)


class StrongMatchTests(unittest.TestCase):
    def test_all_three_requirements_and_feedback_override(self):
        self.assertEqual(match_label(.9, pool_rank=1, pool_size=20, channel_count=2), 'Strong match')
        self.assertEqual(match_label(.9, pool_rank=3, pool_size=20, channel_count=2), 'Related')
        self.assertEqual(match_label(.9, pool_rank=1, pool_size=20, channel_count=1), 'Related')
        self.assertEqual(match_label(.1, pool_rank=1, pool_size=20, channel_count=2), 'Related')
        self.assertEqual(match_label(.9), 'Related')
        self.assertEqual(match_label(.9, grade=0, pool_rank=1, pool_size=20, channel_count=2), 'Not relevant')

    def test_related_cutoff_is_top_forty_percent_even_across_evidence_threshold(self):
        self.assertEqual(match_label(.1, pool_rank=8, pool_size=20), 'Related')
        self.assertEqual(match_label(.95, pool_rank=9, pool_size=20, channel_count=2), 'Explore')
        self.assertEqual(match_label(.1, pool_rank=2, pool_size=3), 'Related')
        self.assertEqual(match_label(.95, pool_rank=3, pool_size=3), 'Explore')
        self.assertEqual(match_label(.1, grade=2, pool_rank=20, pool_size=20), 'Relevant')

    def test_related_band_uses_final_full_pool_before_display_limit(self):
        records = [paper(index, retrievalEvidence=[{'channel':'concepts:q1','rank':index+1}]) for index in range(30)]
        for diversify in (False, True):
            found = rank({'concepts':records}, [SEED], {'limit':15,'diversify':diversify})
            self.assertEqual([row['rank'] for row in found if row['matchLabel']=='Related'], list(range(1,13)))
            self.assertEqual([row['rank'] for row in found if row['matchLabel']=='Explore'], [13,14,15])
            self.assertTrue(all(row['matchPoolSize']==30 for row in found))
            self.assertTrue(all(row['matchStrengthVersion']=='evidence-v3' for row in found))

    def test_provider_mirrors_and_query_variants_are_not_independent(self):
        evidence = [{'channel':'concepts:q1','provider':'CORE'}, {'channel':'concepts:q1','provider':'Semantic Scholar'}, {'channel':'concepts:q2','provider':'Europe PMC'}]
        self.assertEqual(independent_channel_count({'retrievalEvidence':evidence}), 1)
        evidence += [{'channel':'citations:0:forward','provider':'Semantic Scholar'}, {'channel':'citations:0:forward','provider':'OpenAlex'}]
        self.assertEqual(independent_channel_count({'retrievalEvidence':evidence}), 2)

    def test_gate_uses_full_pool_before_result_limit_and_after_diversity(self):
        records = [paper(i, retrievalEvidence=[{'channel':'concepts:q1','rank':i+1}, {'channel':'semanticSearch','rank':i+1}]) for i in range(30)]
        original = copy.deepcopy(records)
        for diversify in (False, True):
            found = rank({'concepts':records}, [SEED], {'limit':10, 'researchQuestion':'Protected bicycle lanes reduce intersection injuries', 'diversify':diversify})
            self.assertEqual([row['rank'] for row in found if row['matchLabel']=='Strong match'], [1,2,3])
            self.assertTrue(all(row['matchPoolSize']==30 for row in found))
        self.assertEqual(records, original)

    def test_merged_provider_duplicates_do_not_unlock_strong_match(self):
        record = paper(1, retrievalEvidence=[{'channel':'concepts:q1','provider':'CORE'}])
        mirror = copy.deepcopy(record); mirror['retrievalEvidence'][0]['provider']='Europe PMC'
        found = rank({'core':[record], 'europePmc':[mirror]}, [SEED], {'researchQuestion':'Protected bicycle lanes reduce intersection injuries'})
        self.assertEqual(found[0]['independentChannelCount'], 1)
        self.assertEqual(found[0]['matchLabel'], 'Related')
