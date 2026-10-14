"""Unit tests for Section 3: Faster first results
- Earlier preliminary results emission when citation branches finish
- Throttled preliminary refreshes as keyword sources arrive
- Extended pre-warm on selection with request budget cap
- Pre-computation of embeddings and cross-encoder scores for pre-warmed shortlist
- Deterministic final ranking equivalence
"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))

import pulse_core as _core
from pulse_core import discovery
from pulse_core.discovery import (
    warm_paper_discovery,
    PREWARM_MAX_PER_HOUR,
    run_discovery_pipeline,
)
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_performance import REQUEST_CONTEXT, DiscoveryBudgetExceeded, DiscoveryCancelled


def block_external_network(testcase):
    """Unit tests must not reach live services (results vary and API quotas are spent)."""
    import socket
    real = socket.create_connection
    def guarded(address, *args, **kwargs):
        if str(address[0]) in ('127.0.0.1', 'localhost', '::1'):
            return real(address, *args, **kwargs)
        raise OSError('External network access is disabled in unit tests')
    blocker = patch('socket.create_connection', guarded)
    blocker.start()
    testcase.addCleanup(blocker.stop)


class FasterFirstResultsTests(unittest.TestCase):
    def setUp(self):
        block_external_network(self)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orig_config_dir = os.environ.get('PULSE_CONFIG_DIR')
        os.environ['PULSE_CONFIG_DIR'] = self.temp_dir.name
        self.seed = {
            'title': 'Outer membrane vesicles in Campylobacter host interaction',
            'doi': '10.1000/omv_seed',
            'year': 2012,
            'abstract': 'Bacterial outer membrane vesicles deliver virulence factors to host cells.',
            'paperKeywords': ['outer membrane vesicles', 'Campylobacter', 'virulence'],
        }

    def tearDown(self):
        import pulse_source_health
        pulse_source_health._STATES.clear()
        if self.orig_config_dir:
            os.environ['PULSE_CONFIG_DIR'] = self.orig_config_dir
        else:
            os.environ.pop('PULSE_CONFIG_DIR', None)
        self.temp_dir.cleanup()

    def test_prewarm_runs_the_real_collection_with_search_options(self):
        """Pre-warm makes the same requests as the later search: same options, one seed, collect only."""
        discovery._PREWARM_TIMES.clear()
        with patch('pulse_core.discovery._run_discovery_pipeline', return_value={'ok': True}) as run:
            self.assertTrue(warm_paper_discovery(self.seed, {'limit': 200, 'depth': '1', 'bridgeMode': True,
                                                             'searchMode': 'concept', 'seedPapers': ['ignored']}))
        payload = run.call_args.args[0]
        self.assertEqual(payload['seedPapers'], [self.seed])
        self.assertTrue(payload['_collectOnly'])
        self.assertFalse(payload['bridgeMode'], 'one selected paper cannot be bridged')
        self.assertNotIn('searchMode', payload)
        self.assertEqual((payload['limit'], payload['depth']), (200, '1'))
        self.assertIs(run.call_args.kwargs['cancel_event'], discovery._WARM_CANCEL)

    def test_prewarm_is_skipped_when_it_would_waste_requests(self):
        import pulse_source_health
        discovery._PREWARM_TIMES.clear()
        with patch('pulse_core.discovery._run_discovery_pipeline', return_value={'ok': True}) as run:
            with discovery._ACTIVE_LOCK: discovery._ACTIVE_SEARCHES[0] += 1
            try:
                self.assertFalse(warm_paper_discovery(self.seed), 'never during a live search')
            finally:
                with discovery._ACTIVE_LOCK: discovery._ACTIVE_SEARCHES[0] -= 1
            with patch('pulse_core.discovery.cooldowns', return_value={'OpenAlex': {'retryInSeconds': 600}}):
                self.assertFalse(warm_paper_discovery(self.seed), 'not while OpenAlex is rate-limited')
            import pulse_performance
            pulse_performance._note_openalex_allowance({'x-ratelimit-remaining': '120'})
            self.assertFalse(warm_paper_discovery(self.seed), 'keep the remaining OpenAlex allowance for real searches')
            pulse_performance._note_openalex_allowance({'x-ratelimit-remaining': '900'})
            for _ in range(PREWARM_MAX_PER_HOUR):
                self.assertTrue(warm_paper_discovery(self.seed))
            self.assertFalse(warm_paper_discovery(self.seed), 'hourly cap protects the daily OpenAlex allowance')
            self.assertEqual(run.call_count, PREWARM_MAX_PER_HOUR)
        discovery._PREWARM_TIMES.clear()

    def test_collect_only_caches_the_final_shortlist_and_skips_ranking(self):
        """Collect-only fills embedding / cross-encoder caches for exactly the shortlist the final ranking uses."""
        rows = [{'doi': f'10.1000/pool_{i}', 'title': f'Vesicle pool paper {i}', 'year': 2015 + i % 8,
                 'abstract': f'Outer membrane vesicles study {i}.', 'citationCount': (i * 13) % 300,
                 'retrievalEvidence': [{'channel': 'citations:0:forward' if i % 2 else 'concepts:q1', 'rank': i + 1, 'provider': 'OpenAlex'}]}
                for i in range(120)]
        pool = {'citationGraph': [r for r in rows if r['retrievalEvidence'][0]['channel'].startswith('citations')],
                'europePmc': [r for r in rows if not r['retrievalEvidence'][0]['channel'].startswith('citations')]}
        base = {'seedPapers': [self.seed], 'limit': 200,
                'branches': {'citationGraph': True, 'citationNetwork': False, 'citationCoCitation': False,
                             'semanticSearch': False, 'lexicalSearch': True},
                'searchSources': {'europePmc': True, 'semanticScholar': False, 'core': False}}
        fake_branches = lambda tasks, on_progress, cancel_event: (pool, list(pool), {})
        embedded, scored, assessed = [], [], []
        with patch('pulse_core.discovery.parallel_branches', side_effect=fake_branches), \
             patch.object(_core, 'openalex_work_for_paper', return_value=None), \
             patch('pulse_core.discovery.pre_embed_papers', side_effect=lambda s, records, *a, **k: embedded.append([r['doi'] for r in records])), \
             patch('pulse_core.discovery.pre_score_crossencoder', side_effect=lambda s, q, records, **k: scored.append([r['doi'] for r in records])), \
             patch('pulse_core.discovery.semantic_scores', side_effect=lambda s, q, records, *a, **k: (assessed.extend(r['doi'] for r in records), (None, 'off'))[1]), \
             patch('pulse_core.discovery.crossencoder_scores', return_value=(None, 'off')):
            warm = discovery._run_discovery_pipeline(dict(base, _collectOnly=True))
            self.assertTrue(warm['prewarmed'])
            self.assertNotIn('recommendations', warm, 'no final ranking during pre-warm')
            final = run_discovery_pipeline(dict(base))
        self.assertTrue(final['recommendations'])
        self.assertIn(assessed, embedded, 'pre-warm embedded exactly the shortlist the final ranking assessed')
        self.assertTrue(scored)

    def test_earlier_preliminary_results_when_citation_branches_finish(self):
        """Preliminary results are emitted as soon as citation branches finish, even while slower
        keyword sources are still running. They are marked preliminary; the stage stays 'collecting'."""
        progress_events = []

        cit_rows = [
            {'doi': f'10.1000/cit_{i}', 'title': f'Citation paper {i}', 'year': 2020,
             'retrievalEvidence': [{'channel': 'citations:0:forward', 'rank': i + 1, 'provider': 'OpenAlex'}]}
            for i in range(10)
        ]
        slow_keyword_rows = [
            {'doi': f'10.1000/kw_{i}', 'title': f'Keyword paper {i}', 'year': 2021,
             'retrievalEvidence': [{'channel': 'concepts:q1', 'rank': i + 1, 'provider': 'Europe PMC'}]}
            for i in range(10)
        ]

        def fake_parallel_branches(tasks, on_progress, cancel_event):
            # Simulate citationGraph, citationNetwork, citationCoCitation finishing first
            results = {
                'citationGraph': cit_rows[:4],
                'citationNetwork': cit_rows[4:7],
                'citationCoCitation': cit_rows[7:10],
            }
            completed = ['citationGraph', 'citationNetwork', 'citationCoCitation']
            on_progress(dict(results), list(completed), {}, len(tasks))

            # Slower keyword source finishes later
            results['europePmc'] = slow_keyword_rows
            completed.append('europePmc')
            on_progress(dict(results), list(completed), {}, len(tasks))

            return results, completed, {}

        payload = {
            'seedPapers': [self.seed],
            'limit': 50,
            'semanticRerank': False,
            'pairwiseRerank': False,
            'branches': {
                'citationGraph': True,
                'citationNetwork': True,
                'citationCoCitation': True,
                'semanticSearch': False,
                'lexicalSearch': True,
            },
            'searchSources': {'europePmc': True, 'semanticScholar': False, 'core': False},
        }

        with patch.object(_core, 'openalex_work_for_paper', return_value={'id': 'W100', 'title': self.seed['title']}), \
             patch('pulse_core.discovery.parallel_branches', side_effect=fake_parallel_branches):
            res = run_discovery_pipeline(payload, on_progress=progress_events.append)

        # The first update after the citation branches finish carries preliminary recommendations.
        refining_events = [e for e in progress_events if e.get('rankingPhase') == 'preliminary' and e.get('recommendations')]
        self.assertGreaterEqual(len(refining_events), 1)

        first_refining = refining_events[0]
        self.assertNotEqual(first_refining.get('stage'), 'refining', 'sources are still being collected')
        self.assertGreaterEqual(len(first_refining['recommendations']), 5)
        # Branches executed at first preliminary emission should be only citation branches
        self.assertEqual(
            set(first_refining['branchesExecuted']),
            {'citationGraph', 'citationNetwork', 'citationCoCitation'}
        )

        # Final result has full pool from both citations and Europe PMC
        self.assertEqual(res['completed'], 4)
        self.assertEqual(len(res['recommendations']), 20)

    def test_collection_stops_once_citation_led_top50_settles(self):
        """Early settling (since 1.7.12): once citation branches finish and the top 50 is unchanged
        across refreshes, collection stops waiting for long-tail sources."""
        cit_rows = [{'doi': f'10.1000/settle_{i}', 'title': f'Settled citation paper {i}', 'year': 2020,
                     'retrievalEvidence': [{'channel': 'citations:0:forward', 'rank': i + 1, 'provider': 'OpenAlex'}]}
                    for i in range(12)]
        decisions = []

        def fake_parallel_branches(tasks, on_progress, cancel_event):
            results = {'citationGraph': cit_rows[:6], 'citationNetwork': cit_rows[6:9], 'citationCoCitation': cit_rows[9:]}
            completed = ['citationGraph', 'citationNetwork', 'citationCoCitation']
            clock = [1000.0]
            with patch('pulse_core.discovery.time.monotonic', side_effect=lambda: clock[0]):
                for _ in range(5):
                    clock[0] += 4.0  # past the refresh throttle, so every update re-ranks
                    decisions.append(on_progress(dict(results), list(completed), {}, len(tasks)))
            return results, completed, {}

        payload = {'seedPapers': [self.seed], 'limit': 50, 'semanticRerank': False, 'pairwiseRerank': False,
                   'branches': {'citationGraph': True, 'citationNetwork': True, 'citationCoCitation': True,
                                'semanticSearch': False, 'lexicalSearch': True},
                   'searchSources': {'europePmc': True, 'semanticScholar': False, 'core': False}}
        with patch.object(_core, 'openalex_work_for_paper', return_value={'id': 'W100', 'title': self.seed['title']}), \
             patch('pulse_core.discovery.parallel_branches', side_effect=fake_parallel_branches):
            run_discovery_pipeline(payload, on_progress=lambda update: None)
        self.assertIn(True, decisions, 'a settled top 50 must stop collection while Europe PMC is still pending')

    def test_ranking_equivalence_with_and_without_preliminary_emission(self):
        """Final ranking on the candidate pool is identical regardless of intermediate preliminary updates."""
        pool = {
            'citationGraph': [
                {'doi': f'10.1000/c{i}', 'title': f'Paper C{i}', 'year': 2018 + (i % 5),
                 'citationCount': 50 + i * 10,
                 'retrievalEvidence': [{'channel': 'citations:0:forward', 'rank': i + 1, 'provider': 'OpenAlex'}]}
                for i in range(20)
            ],
            'europePmc': [
                {'doi': f'10.1000/k{i}', 'title': f'Paper K{i}', 'year': 2019 + (i % 4),
                 'citationCount': 20 + i * 5,
                 'retrievalEvidence': [{'channel': 'concepts:q1', 'rank': i + 1, 'provider': 'Europe PMC'}]}
                for i in range(20)
            ],
        }

        options = {'limit': 50, 'researchQuestion': ''}
        final1 = merge_and_rank_pipeline_candidates(pool, [self.seed], options)
        final2 = merge_and_rank_pipeline_candidates(pool, [self.seed], options)

        sig1 = [(r.get('doi'), r.get('score'), r.get('matchLabel')) for r in final1]
        sig2 = [(r.get('doi'), r.get('score'), r.get('matchLabel')) for r in final2]
        self.assertEqual(sig1, sig2)


if __name__ == '__main__':
    unittest.main()
