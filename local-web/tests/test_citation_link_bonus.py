import datetime
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank, citation_link_bonus, build_citation_link_context

SEED = {'title': 'Seed paper on artificial intelligence', 'doi': '10.1000/seed'}

def paper(name, **kwargs):
    d = {'title': f'Paper {name} on deep learning', 'doi': f'10.1000/{name}'}
    d.update(kwargs)
    return d

class CitationLinkBonusTests(unittest.TestCase):
    def test_direct_citation_receives_velocity_bonus(self):
        year = datetime.date.today().year
        records = [
            paper('top', year=str(year - 1), citationCount=500,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}]),
            paper('mid', year=str(year - 1), citationCount=50,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 2}]),
            paper('low', year=str(year - 1), citationCount=5,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 3}]),
            paper('unlinked', year=str(year - 1), citationCount=500,
                  retrievalEvidence=[{'channel': 'concepts:q1', 'rank': 1}])
        ]
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[0.5] * 4):
            results = rank({'citationGraph': records[:3], 'concepts': [records[3]]}, [SEED], {'diversify': False})
        
        by_doi = {p['doi']: p for p in results}
        top = by_doi['10.1000/top']
        mid = by_doi['10.1000/mid']
        low = by_doi['10.1000/low']
        unlinked = by_doi['10.1000/unlinked']

        # Top has percentile 1.0; w=0.2, topic=0.5 >= gate=0.3 -> gate=1.0 -> bonus=0.2
        self.assertAlmostEqual(top['scoreBreakdown']['citationLinkBonus'], 0.2, places=3)
        self.assertGreater(top['scoreBreakdown']['citationLinkBonus'], mid['scoreBreakdown']['citationLinkBonus'])
        self.assertGreater(mid['scoreBreakdown']['citationLinkBonus'], low['scoreBreakdown']['citationLinkBonus'])
        self.assertEqual(unlinked['scoreBreakdown']['citationLinkBonus'], 0.0)

        # Why found includes reason
        self.assertTrue(any(reason['kind'] == 'citation-link-bonus' and reason['detail'] == 'Directly linked to your seed and widely cited'
                            for reason in top['whyFound']))
        self.assertIn('Directly linked to your seed and widely cited', top['matchReasons'])

    def test_disabled_when_citation_link_bonus_is_false(self):
        year = datetime.date.today().year
        records = [
            paper('linked', year=str(year - 1), citationCount=500,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}])
        ]
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[0.5]):
            results = rank({'citationGraph': records}, [SEED], {'citationLinkBonus': False})
        self.assertEqual(results[0]['scoreBreakdown']['citationLinkBonus'], 0.0)

    def test_missing_citation_counts_and_not_relevant_receive_no_bonus(self):
        year = datetime.date.today().year
        records = [
            paper('missing', year=str(year - 1), citationCount=None,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}]),
            paper('rejected', year=str(year - 1), citationCount=500,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 2}])
        ]
        options = {
            'relevanceFeedback': [{'paper': {'doi': '10.1000/rejected'}, 'grade': 0}]
        }
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[0.5] * 2):
            results = rank({'citationGraph': records}, [SEED], options)
        
        by_doi = {p['doi']: p for p in results}
        self.assertEqual(by_doi['10.1000/missing']['scoreBreakdown']['citationLinkBonus'], 0.0)
        self.assertEqual(by_doi['10.1000/rejected']['scoreBreakdown']['citationLinkBonus'], 0.0)

    def test_interaction_with_foundational_prior_capped(self):
        year = datetime.date.today().year
        records = [
            paper('landmark', year=str(year - 30), citationCount=5000,
                  retrievalEvidence=[{'channel': 'citations:0:backward', 'rank': 1}])
        ]
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[0.8]):
            results = rank({'citationGraph': records}, [SEED], {'foundationalPrior': True, 'citationLinkBonus': 0.2})
        
        landmark = results[0]
        cb = landmark['scoreBreakdown']['citationLinkBonus']
        fp = landmark['scoreBreakdown']['foundationalPrior']
        self.assertGreater(cb, 0)
        self.assertGreater(fp, 0)
        # Verify capped combined effect
        expected_combined = min(cb + fp, max(cb, fp) + 0.03)
        self.assertAlmostEqual(expected_combined, max(cb, fp) + 0.03, places=3)

    def test_multi_seed_takes_max_percentile_across_seeds(self):
        year = datetime.date.today().year
        seed1 = {'title': 'Seed 1', 'doi': '10.1000/seed1'}
        seed2 = {'title': 'Seed 2', 'doi': '10.1000/seed2'}
        records = [
            paper('high_s1', year=str(year - 1), citationCount=1000,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}]),
            paper('low_s1', year=str(year - 1), citationCount=10,
                  retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 2}]),
            paper('bridged', year=str(year - 1), citationCount=50,
                  retrievalEvidence=[
                      {'channel': 'citations:0:forward', 'rank': 3},
                      {'channel': 'citations:1:forward', 'rank': 1}
                  ]),
            paper('low_s2', year=str(year - 1), citationCount=20,
                  retrievalEvidence=[{'channel': 'citations:1:forward', 'rank': 2}])
        ]
        # In seed 0: high_s1 (1000) > bridged (50) > low_s1 (10) -> bridged pct ~ 2/3 = 0.67
        # In seed 1: bridged (50) > low_s2 (20) -> bridged pct 1.0
        # Multi-seed max should take 1.0 for bridged
        ctx = build_citation_link_context(records, [seed1, seed2], {'citationLinkBonus': True})
        bonus = citation_link_bonus(records[2], ctx, topic=0.5)
        # weight=0.2 * 1.0 * 1.0 = 0.2
        self.assertAlmostEqual(bonus, 0.2, places=3)

if __name__ == '__main__':
    unittest.main()
