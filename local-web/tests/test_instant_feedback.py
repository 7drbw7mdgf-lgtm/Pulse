import os
from pathlib import Path
import sys
import statistics
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-feedback-test-'))

from pulse_core import discovery_feedback
from pulse_core.discovery_feedback import (
    concept_features,
    contrastive_profile,
    feedback_adjustment,
    rerank_pool_with_feedback,
)
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates


class TestInstantFeedback(unittest.TestCase):
    def setUp(self):
        self.pool = [
            {
                'title': 'Paper 0: Seed neighbor on outer membrane vesicles',
                'doi': '10.1000/p0',
                'score': 85.0,
                'rank': 1,
                'matchLabel': 'Strong match',
                'strongMatchEligible': True,
                'scoreBreakdown': {'preFeedbackScore': 0.85},
                'authors': ['Jane Doe', 'Richard Roe'],
                'journal': 'Nature Microbiology',
                'paperKeywords': ['outer membrane vesicles', 'biofilm'],
                'sharedConcepts': ['biofilm'],
                'referenceIds': ['W100', 'W101'],
                'dbef': {'sharedReferenceIds': ['W100'], 'seedMatches': [{'seedId': 'S1', 'shared': 2}]},
                'retrievalEvidence': [{'channel': 'citations:0:backward', 'subType': 'Backward Citation', 'seedIndices': [0]}],
                'abstract': 'Outer membrane vesicles mediate biofilm matrix assembly in Gram-negative bacteria.',
            },
            {
                'title': 'Paper 1: Unrelated compiler register allocation',
                'doi': '10.1000/p1',
                'score': 80.0,
                'rank': 2,
                'matchLabel': 'Strong match',
                'strongMatchEligible': True,
                'scoreBreakdown': {'preFeedbackScore': 0.80},
                'authors': ['Alan Turing', 'Grace Hopper'],
                'journal': 'IEEE Software',
                'paperKeywords': ['compiler optimization', 'register allocation'],
                'sharedConcepts': ['compiler'],
                'referenceIds': ['W200', 'W201'],
                'abstract': 'Register allocation and instruction scheduling in optimizing compilers.',
            },
            {
                'title': 'Paper 2: Judged relevant vesicle peptidoglycan study',
                'doi': '10.1000/p2',
                'score': 75.0,
                'rank': 3,
                'matchLabel': 'Strong match',
                'strongMatchEligible': True,
                'scoreBreakdown': {'preFeedbackScore': 0.75},
                'authors': ['Carlos Gomez', 'Jane Doe'],
                'journal': 'Journal of Bacteriology',
                'paperKeywords': ['outer membrane vesicles', 'peptidoglycan', 'secretion'],
                'sharedConcepts': ['outer membrane vesicles', 'secretion'],
                'referenceIds': ['W100', 'W102'],
                'dbef': {'sharedReferenceIds': ['W100', 'W102'], 'seedMatches': [{'seedId': 'S1', 'shared': 3}]},
                'retrievalEvidence': [{'channel': 'dbef', 'subType': 'Bibliographic Coupling', 'seedIndices': [0]}],
                'abstract': 'Secretion of outer membrane vesicles and peptidoglycan remodeling during bacterial stress.',
            },
            {
                'title': 'Paper 3: Unrelated compiler static analysis',
                'doi': '10.1000/p3',
                'score': 71.0,
                'rank': 4,
                'matchLabel': 'Related',
                'strongMatchEligible': False,
                'scoreBreakdown': {'preFeedbackScore': 0.71},
                'authors': ['Alan Turing'],
                'journal': 'IEEE Software',
                'paperKeywords': ['compiler optimization', 'static analysis'],
                'referenceIds': ['W200'],
                'abstract': 'Static analysis and loop unrolling in optimizing compilers.',
            },
            {
                'title': 'Paper 4: Matching vesicle peptidoglycan secretion paper',
                'doi': '10.1000/p4',
                'score': 69.0,
                'rank': 5,
                'matchLabel': 'Related',
                'strongMatchEligible': False,
                'scoreBreakdown': {'preFeedbackScore': 0.69},
                'authors': ['Elena Vance', 'Jane Doe'],
                'journal': 'Journal of Bacteriology',
                'paperKeywords': ['outer membrane vesicles', 'peptidoglycan', 'secretion'],
                'sharedConcepts': ['outer membrane vesicles', 'secretion'],
                'referenceIds': ['W100', 'W102'],
                'dbef': {'sharedReferenceIds': ['W100', 'W102'], 'seedMatches': [{'seedId': 'S1', 'shared': 3}]},
                'retrievalEvidence': [{'channel': 'dbef', 'subType': 'Bibliographic Coupling', 'seedIndices': [0]}],
                'abstract': 'Outer membrane vesicles and peptidoglycan turnover in bacterial secretion pathways.',
            },
        ]

    def test_structured_concept_features(self):
        feats = concept_features(self.pool[0])
        self.assertIn('ref:w100', feats)
        self.assertIn('pivot:s1', feats)
        self.assertIn('cite:backward', feats)
        self.assertIn('concept:outer membrane vesicles', feats)
        self.assertIn('author:doe', feats)
        self.assertIn('venue:nature microbiology', feats)

    def test_rerank_below_index_preserves_prefix(self):
        feedback = [
            {'grade': 0, 'paper': self.pool[1]},
            {'grade': 2, 'paper': self.pool[2]},
        ]
        reranked, moved_up = rerank_pool_with_feedback(self.pool, feedback, below_index=2)
        self.assertEqual([r['doi'] for r in reranked[:3]], ['10.1000/p0', '10.1000/p1', '10.1000/p2'])
        self.assertEqual([r['doi'] for r in reranked[3:]], ['10.1000/p4', '10.1000/p3'])
        self.assertEqual(moved_up, 1)

    def test_warmed_2000_candidate_rerank_reuses_features_and_stays_bounded(self):
        big_pool = [
            {
                'title': f'Candidate paper {i} on bacterial vesicles and transport',
                'doi': f'10.9999/cand.{i}',
                'score': round(90.0 - (i * 0.04), 3),
                'rank': i + 1,
                'matchLabel': 'Strong match' if i < 100 else ('Related' if i < 800 else 'Worth exploring'),
                'strongMatchEligible': i < 100,
                'scoreBreakdown': {'preFeedbackScore': (90.0 - (i * 0.04)) / 100.0},
                'authors': [f'Author{i % 50} Smith', 'Jane Doe' if i % 7 == 0 else 'Other Researcher'],
                'journal': 'Journal of Bacteriology' if i % 5 == 0 else 'General Science',
                'paperKeywords': ['outer membrane vesicles', 'peptidoglycan'] if i % 3 == 0 else ['metabolism', 'transport'],
                'referenceIds': ['W100', 'W102'] if i % 4 == 0 else [f'W{300 + (i % 80)}'],
                'abstract': f'Study {i} investigates outer membrane vesicles and peptidoglycan secretion in bacteria.',
            }
            for i in range(2000)
        ]
        cache = {}
        for r in big_pool:
            cache[r['doi']] = concept_features(r)
        # Warm title key cache once as pool load does
        rerank_pool_with_feedback(big_pool, [], below_index=0, feature_cache=cache)
        feedback = [
            {'grade': 0, 'paper': self.pool[1]},
            {'grade': 2, 'paper': self.pool[2]},
        ]
        # The cached pool must never be tokenized again when feedback changes.
        cached_features = dict(cache)
        with patch.object(discovery_feedback, 'concept_features', wraps=concept_features) as extract:
            reranked, moved = rerank_pool_with_feedback(big_pool, feedback, below_index=10, feature_cache=cache)
        self.assertEqual(extract.call_count, len(feedback), 'Only the two feedback papers need feature extraction')
        self.assertEqual({call.args[0]['doi'] for call in extract.call_args_list}, {row['paper']['doi'] for row in feedback})
        self.assertTrue(all(cache[key] is value for key, value in cached_features.items()))
        self.assertEqual(len(reranked), len(big_pool))
        self.assertCountEqual([r['doi'] for r in reranked], [r['doi'] for r in big_pool])
        self.assertEqual([r['doi'] for r in reranked[:11]], [r['doi'] for r in big_pool[:11]])
        self.assertEqual([r['rank'] for r in reranked], list(range(1, len(big_pool) + 1)))
        self.assertGreater(moved, 0)

        for _ in range(3):
            rerank_pool_with_feedback(big_pool, feedback, below_index=10, feature_cache=cache)
        samples = []
        for _ in range(7):
            started = time.perf_counter()
            rerank_pool_with_feedback(big_pool, feedback, below_index=10, feature_cache=cache)
            samples.append((time.perf_counter() - started) * 1000.0)
        elapsed_ms = statistics.median(samples)
        # Shared CI runners vary by CPU and load. This catches gross regressions;
        # the explicit benchmark mode measures the stricter 10ms target separately.
        benchmark = os.environ.get('PULSE_FEEDBACK_BENCHMARK') == '1'
        budget_ms = 10.0 if benchmark else 100.0
        self.assertLess(elapsed_ms, budget_ms, f'Warmed 2,000-candidate median {elapsed_ms:.2f} ms exceeded {budget_ms:.0f} ms; samples={samples}')
        if benchmark:
            print(f'Python warmed 2,000-candidate feedback median: {elapsed_ms:.3f} ms; samples={samples}')

    def test_pipeline_ranking_records_pre_feedback_score(self):
        seed = {
            'title': 'Outer membrane vesicles in bacteria',
            'doi': '10.1000/seed',
            'authors': ['Jane Doe'],
            'abstract': 'Outer membrane vesicles mediate secretion and biofilm formation.',
            'paperKeywords': ['outer membrane vesicles', 'biofilm'],
        }
        candidates = {'citationGraph': [dict(self.pool[0], branch='citationGraph', subType='Backward Citation')]}
        ranked = merge_and_rank_pipeline_candidates(candidates, [seed], {'limit': 10})
        self.assertEqual(len(ranked), 1)
        self.assertIn('preFeedbackScore', ranked[0]['scoreBreakdown'])


if __name__ == '__main__':
    unittest.main()
