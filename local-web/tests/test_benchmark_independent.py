"""Offline unit tests for the Section 0 independent benchmark harness."""
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "local-web" / "pulse-backend"
TOOLS_DIR = REPO_ROOT / "tools"
for p in (BACKEND_DIR, TOOLS_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import benchmark_independent as bi


class BenchmarkIndependentTests(unittest.TestCase):
    def test_metrics_computation_full_and_condensed_ndcg_and_recall(self):
        qrels = {
            "pmid:1001": {"pmid": "1001", "doi": "10.1000/a", "title": "Relevant Paper A", "year": "2025", "grade": 2},
            "pmid:1002": {"pmid": "1002", "doi": "10.1000/b", "title": "Partial Paper B", "year": "2020", "grade": 1},
            "pmid:1003": {"pmid": "1003", "doi": "10.1000/c", "title": "Irrelevant Paper C", "year": "2021", "grade": 0},
        }
        ranked = [
            {"pmid": "9999", "title": "Unjudged Paper X", "year": "2024"},
            {"pmid": "1003", "title": "Irrelevant Paper C", "year": "2021"},
            {"pmid": "1001", "title": "Relevant Paper A", "year": "2025"},
            {"pmid": "1002", "title": "Partial Paper B", "year": "2020"},
        ]
        m = bi.compute_case_metrics(ranked, qrels, ranking_ms=4.2)
        self.assertEqual(m["totalRelevant"], 2)
        self.assertEqual(m["Recall@20"], 1.0)
        self.assertEqual(m["RecentRecall@50"], 1.0)
        self.assertAlmostEqual(m["MRR"], 1.0 / 3.0, places=5)
        self.assertGreater(m["condensed_nDCG@10"], m["nDCG@10"])
        self.assertLess(m["condensed_nDCG@10"], 1.0)

    def test_bootstrap_ci_is_deterministic_and_bounded(self):
        vals = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
        ci1 = bi.bootstrap_ci(vals, n_boot=500, seed=42)
        ci2 = bi.bootstrap_ci(vals, n_boot=500, seed=42)
        self.assertEqual(ci1, ci2)
        self.assertAlmostEqual(ci1["mean"], 0.4, places=4)
        self.assertLess(ci1["ci_low"], ci1["mean"])
        self.assertGreater(ci1["ci_high"], ci1["mean"])

    def test_decision_rule_rejects_regression_and_accepts_significant_gain(self):
        # Case 1: Significant gain on relish, no regression on synergy/scidocs -> passes
        passing = {
            "relish": {
                "baseline_summary": {"nDCG@20": {"ci_half_width": 0.02}, "Recall@50": {"ci_half_width": 0.03}},
                "deltas": {
                    "nDCG@20": {"mean": 0.025, "ci_low": 0.008, "ci_high": 0.042},
                    "Recall@50": {"mean": 0.015, "ci_low": -0.002, "ci_high": 0.032},
                },
            },
            "synergy": {
                "baseline_summary": {"nDCG@20": {"ci_half_width": 0.03}, "Recall@50": {"ci_half_width": 0.04}},
                "deltas": {
                    "nDCG@20": {"mean": -0.005, "ci_low": -0.02, "ci_high": 0.01},
                    "Recall@50": {"mean": 0.0, "ci_low": -0.01, "ci_high": 0.01},
                },
            },
            "scidocs": {
                "baseline_summary": {"nDCG@20": {"ci_half_width": 0.03}, "Recall@50": {"ci_half_width": 0.03}},
                "deltas": {
                    "nDCG@20": {"mean": 0.002, "ci_low": -0.01, "ci_high": 0.014},
                    "Recall@50": {"mean": 0.004, "ci_low": -0.01, "ci_high": 0.018},
                },
            },
        }
        res_pass = bi.check_decision_rule(passing)
        self.assertTrue(res_pass["passes_decision_rule"])

        # Case 2: Regression on scidocs exceeding baseline CI -> fails even with relish gain
        failing = {
            **passing,
            "scidocs": {
                "baseline_summary": {"nDCG@20": {"ci_half_width": 0.02}, "Recall@50": {"ci_half_width": 0.02}},
                "deltas": {
                    "nDCG@20": {"mean": -0.035, "ci_low": -0.05, "ci_high": -0.02},
                    "Recall@50": {"mean": 0.0, "ci_low": -0.01, "ci_high": 0.01},
                },
            },
        }
        res_fail = bi.check_decision_rule(failing)
        self.assertFalse(res_fail["passes_decision_rule"])
        self.assertFalse(res_fail["no_regression"])

    def test_offline_variant_reranking_excludes_author_trajectory_in_baseline(self):
        case = {
            "case_id": "synthetic-1",
            "dataset": "relish",
            "seed_papers": [{
                "title": "Vesicle secretion in Gram-negative bacteria",
                "abstract": "Outer membrane vesicles mediate secretion and virulence.",
                "doi": "10.1000/seed",
                "year": "2022",
                "authors": ["Jane Doe", "John Smith"],
                "paperKeywords": ["outer membrane vesicles", "virulence"],
            }],
            "qrels": {
                "doi:10.1000/c1": {"doi": "10.1000/c1", "title": "Outer membrane vesicles and bacterial virulence", "year": "2023", "grade": 2},
                "doi:10.1000/a1": {"doi": "10.1000/a1", "title": "Recent outer membrane vesicle proteomics follow-up", "year": "2025", "grade": 2},
            },
            "candidates_by_branch": {
                "citationGraph": [{
                    "title": "Outer membrane vesicles and bacterial virulence",
                    "abstract": "Direct citation studying outer membrane vesicles.",
                    "doi": "10.1000/c1",
                    "year": "2023",
                    "citationCount": 25,
                    "authors": ["Alice Brown"],
                    "retrievalEvidence": [{"channel": "citations:0:forward", "rank": 1, "provider": "OpenAlex"}],
                }],
                "authorTrajectory": [{
                    "title": "Recent outer membrane vesicle proteomics follow-up",
                    "abstract": "Follow-up work on outer membrane vesicles and secretion.",
                    "doi": "10.1000/a1",
                    "year": "2025",
                    "citationCount": 2,
                    "authors": ["Jane Doe", "John Smith"],
                    "retrievalEvidence": [{"channel": "author:0:last", "rank": 1, "provider": "OpenAlex", "subType": "Same senior author"}],
                }],
            },
            "network_assessments": {},
            "citation_contexts": {},
        }
        ranked_base, _ = bi.rank_case_under_variant(case, variant="baseline")
        ranked_sec1, _ = bi.rank_case_under_variant(case, variant="sec1_author_trajectory")
        self.assertEqual([r["doi"] for r in ranked_base], ["10.1000/c1"])
        self.assertEqual(set(r["doi"] for r in ranked_sec1), {"10.1000/c1", "10.1000/a1"})


if __name__ == "__main__":
    unittest.main()
