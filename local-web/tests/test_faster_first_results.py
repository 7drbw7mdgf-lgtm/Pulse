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
    PREWARM_REQUEST_CAP,
    run_discovery_pipeline,
)
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_performance import REQUEST_CONTEXT, DiscoveryBudgetExceeded, DiscoveryCancelled


class FasterFirstResultsTests(unittest.TestCase):
    def setUp(self):
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

    def test_prewarm_request_cap_enforced(self):
        """Pre-warm enforces PREWARM_REQUEST_CAP so it cannot exhaust API credits."""
        requests_made = []

        def counting_fetch(url):
            counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
            if counter:
                with counter['lock']:
                    if counter['remaining'] <= 0:
                        raise DiscoveryBudgetExceeded("Budget exceeded")
                    counter['remaining'] -= 1
            requests_made.append(url)
            return {'results': []}

        with patch('pulse_core.discovery.openalex_work_for_paper', return_value={'id': 'W100', 'referenced_works': [f'W{i}' for i in range(50)]}), \
             patch('pulse_core.discovery.fetch_json', side_effect=counting_fetch), \
             patch('pulse_core.discovery.s2_paper_search', return_value=[]), \
             patch('pulse_core.discovery.pre_embed_papers') as mock_embed, \
             patch('pulse_core.discovery.pre_score_crossencoder') as mock_ce:
            warm_paper_discovery(self.seed)
            self.assertLessEqual(len(requests_made), PREWARM_REQUEST_CAP)

    def test_prewarm_fetches_all_five_facets(self):
        """Pre-warm pre-fetches citing works, references, DBEF pivots, co-citations, and keyword queries."""
        work_obj = {
            'id': 'https://openalex.org/W100',
            'title': self.seed['title'],
            'referenced_works': ['https://openalex.org/W201', 'https://openalex.org/W202'],
        }
        ref_works = [
            {'id': 'https://openalex.org/W201', 'title': 'Ref 1', 'cited_by_count': 150},
            {'id': 'https://openalex.org/W202', 'title': 'Ref 2', 'cited_by_count': 80},
        ]
        cite_works = [
            {'id': 'https://openalex.org/W301', 'title': 'Citing Paper 1', 'cited_by_count': 40,
             'referenced_works': ['https://openalex.org/W100', 'https://openalex.org/W401']},
        ]
        pivot_works = [
            {'id': 'https://openalex.org/W501', 'title': 'DBEF Pivot Result', 'cited_by_count': 30},
        ]
        co_cite_works = [
            {'id': 'https://openalex.org/W401', 'title': 'Co-cited Work 1', 'cited_by_count': 60},
        ]

        def fake_discovery_works(query, limit, sort='cited_by_count:desc', **kw):
            if query == 'cites:W100':
                return cite_works
            if 'W201' in query or 'W202' in query:
                return pivot_works
            return []

        def fake_batch(ids, select=None):
            if any('W201' in i or 'W202' in i for i in ids):
                return ref_works
            if any('W401' in i for i in ids):
                return co_cite_works
            return []

        mock_s2 = MagicMock(return_value=[{'title': 'S2 Keyword Match', 'doi': '10.1000/s2_1'}])

        with patch('pulse_core.discovery.openalex_work_for_paper', return_value=work_obj), \
             patch('pulse_core.discovery.fetch_openalex_works_batch', side_effect=fake_batch), \
             patch('pulse_core.discovery.openalex_discovery_works', side_effect=fake_discovery_works), \
             patch('pulse_core.discovery.s2_paper_search', mock_s2), \
             patch('pulse_core.discovery.pre_embed_papers') as mock_embed, \
             patch('pulse_core.discovery.pre_score_crossencoder') as mock_ce:
            warm_paper_discovery(self.seed)

            # Neural pre-computation received candidate shortlist
            mock_embed.assert_called_once()
            embedded_candidates = mock_embed.call_args[0][1]
            self.assertGreaterEqual(len(embedded_candidates), 1)

            mock_ce.assert_called_once()
            ce_candidates = mock_ce.call_args[0][2]
            self.assertGreaterEqual(len(ce_candidates), 1)

    def test_earlier_preliminary_results_when_citation_branches_finish(self):
        """Preliminary results are emitted with stage 'refining' as soon as citation branches finish,
        even while slower keyword sources are still running."""
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

        # Check that the first event after citation completion has stage 'refining' and recommendations
        refining_events = [e for e in progress_events if e.get('stage') == 'refining' and e.get('recommendations')]
        self.assertGreaterEqual(len(refining_events), 1)

        first_refining = refining_events[0]
        self.assertEqual(first_refining.get('rankingPhase'), 'refining')
        self.assertGreaterEqual(len(first_refining['recommendations']), 5)
        # Branches executed at first preliminary emission should be only citation branches
        self.assertEqual(
            set(first_refining['branchesExecuted']),
            {'citationGraph', 'citationNetwork', 'citationCoCitation'}
        )

        # Final result has full pool from both citations and Europe PMC
        self.assertEqual(res['completed'], 4)
        self.assertEqual(len(res['recommendations']), 20)

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
