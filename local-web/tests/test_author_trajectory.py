"""Offline unit tests for Section 1: Senior-author trajectory channel."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pulse-backend"))
os.environ.setdefault("PULSE_CONFIG_DIR", tempfile.mkdtemp(prefix="pulse-author-traj-test-"))

import pulse_core as _core
from pulse_core import discovery
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates, why_found


class AuthorTrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.biomed_seed = {
            "title": "Campylobacter jejuni outer membrane vesicles and intestinal epithelial cells",
            "doi": "10.1000/seed.omv",
            "year": "2020",
            "authors": ["Abdi Elmi", "Brendan W. Wren", "Nick Dorrell"],
            "abstract": "Outer membrane vesicles deliver cytolethal distending toxin to epithelial cells.",
            "paperKeywords": ["outer membrane vesicles", "Campylobacter jejuni"],
        }
        self.biomed_work = {
            "id": "https://openalex.org/W1000",
            "doi": "https://doi.org/10.1000/seed.omv",
            "title": self.biomed_seed["title"],
            "publication_year": 2020,
            "primary_topic": {
                "id": "https://openalex.org/T10943",
                "display_name": "Bacterial Pathogenesis and Virulence",
                "subfield": {"id": "https://openalex.org/subfields/2404", "display_name": "Microbiology"},
                "field": {"id": "https://openalex.org/fields/24", "display_name": "Immunology and Microbiology"},
            },
            "authorships": [
                {
                    "author_position": "first",
                    "author": {"id": "https://openalex.org/A111", "display_name": "Abdi Elmi"},
                    "is_corresponding": False,
                },
                {
                    "author_position": "middle",
                    "author": {"id": "https://openalex.org/A222", "display_name": "Brendan W. Wren"},
                    "is_corresponding": False,
                },
                {
                    "author_position": "last",
                    "author": {"id": "https://openalex.org/A333", "display_name": "Nick Dorrell"},
                    "is_corresponding": False,
                },
            ],
        }

    def test_non_alphabetical_field_extracts_first_and_last_senior_author(self):
        specs = discovery.extract_seed_trajectory_authors(self.biomed_work, self.biomed_seed)
        self.assertEqual(len(specs), 2)
        self.assertEqual(specs[0]["role"], "first")
        self.assertEqual(specs[0]["label"], "Same first author")
        self.assertEqual(specs[0]["author_id"], "A111")
        self.assertEqual(specs[1]["role"], "last")
        self.assertEqual(specs[1]["label"], "Same senior author")
        self.assertEqual(specs[1]["author_id"], "A333")
        self.assertNotIn("lab", specs[0]["label"].lower())
        self.assertNotIn("lab", specs[1]["label"].lower())

    def test_alphabetical_fields_skip_last_author_unless_corresponding(self):
        for field_name, subfield_name in [
            ("Mathematics", "Algebra and Number Theory"),
            ("Physics and Astronomy", "High Energy Physics"),
            ("Computer Science", "Theoretical Computer Science"),
        ]:
            math_work = dict(
                self.biomed_work,
                primary_topic={
                    "id": "https://openalex.org/T99999",
                    "display_name": subfield_name,
                    "subfield": {"id": "https://openalex.org/subfields/1703", "display_name": subfield_name},
                    "field": {"id": "https://openalex.org/fields/26", "display_name": field_name},
                },
            )
            self.assertTrue(discovery.is_alphabetical_author_field(math_work))
            specs = discovery.extract_seed_trajectory_authors(math_work)
            self.assertEqual([s["role"] for s in specs], ["first"], f"Last author must be skipped in {field_name} / {subfield_name}")

            # When the last author is explicitly marked corresponding, include them as senior author
            corr_authorships = [dict(a) for a in math_work["authorships"]]
            corr_authorships[-1] = dict(corr_authorships[-1], is_corresponding=True)
            corr_work = dict(math_work, authorships=corr_authorships)
            corr_specs = discovery.extract_seed_trajectory_authors(corr_work)
            self.assertEqual([s["role"] for s in corr_specs], ["first", "last"])
            self.assertEqual(corr_specs[1]["label"], "Same senior author")

    def test_skips_authors_exceeding_300_works_per_year_and_caps_at_2_calls_per_seed(self):
        calls = []

        def fake_fetch_json(url, *args, **kwargs):
            calls.append(url)
            if "A111" in url:
                # Probable merged identity: >300 works/year (meta.count = 1200 in 3 years)
                return {
                    "meta": {"count": 1200},
                    "results": [
                        {
                            "id": "https://openalex.org/W2001",
                            "doi": "https://doi.org/10.1000/merged.1",
                            "title": "Merged identity noise paper",
                            "publication_year": 2025,
                            "authorships": [{"author": {"id": "https://openalex.org/A111", "display_name": "Abdi Elmi"}}],
                        }
                    ],
                }
            return {
                "meta": {"count": 4},
                "results": [
                    # Seed paper itself should be skipped
                    self.biomed_work,
                    {
                        "id": "https://openalex.org/W2002",
                        "doi": "https://doi.org/10.1000/followup.1",
                        "title": "Outer membrane vesicle cargo delivery in Campylobacter jejuni",
                        "publication_year": 2025,
                        "publication_date": "2025-03-15",
                        "cited_by_count": 3,
                        "authorships": [
                            {"author": {"id": "https://openalex.org/A444", "display_name": "Fatima Nasher"}},
                            {"author": {"id": "https://openalex.org/A333", "display_name": "Nick Dorrell"}},
                        ],
                    },
                ],
            }

        with patch.object(_core, "fetch_json", side_effect=fake_fetch_json), \
             patch("pulse_core.discovery.cooldowns", return_value={}):
            results = discovery.fetch_author_trajectory_branch([self.biomed_seed], seed_works=[self.biomed_work], years=3, max_per_author=5)

        self.assertEqual(len(calls), 2, "At most 2 OpenAlex calls per seed")
        self.assertTrue(all("primary_topic.id%3AT10943" in u or "primary_topic.id:T10943" in u for u in calls))
        self.assertEqual(len(results), 1, "Merged-identity author (>300 works/yr) and the seed itself must be excluded")
        rec = results[0]
        self.assertEqual(rec["doi"], "10.1000/followup.1")
        self.assertEqual(rec["authorRole"], "last")
        self.assertEqual(rec["authorTrajectoryLabel"], "Same senior author")
        self.assertEqual(rec["authorTrajectoryName"], "Nick Dorrell")
        self.assertEqual(rec["retrievalEvidence"][0]["channel"], "author:0:last")

    def test_dedupes_against_other_branches_and_surfaces_why_found_and_prewarm(self):
        traj_row = {
            "title": "Outer membrane vesicle cargo delivery in Campylobacter jejuni",
            "doi": "10.1000/followup.1",
            "year": "2025",
            "authors": ["Fatima Nasher", "Nick Dorrell"],
            "abstract": "Outer membrane vesicles deliver bacterial cargo to intestinal epithelial cells.",
            "branch": "authorTrajectory",
            "subType": "Same senior author",
            "authorRole": "last",
            "authorTrajectoryLabel": "Same senior author",
            "authorTrajectoryName": "Nick Dorrell",
            "retrievalEvidence": [{
                "channel": "author:0:last",
                "provider": "OpenAlex",
                "rank": 1,
                "subType": "Same senior author",
                "authorRole": "last",
                "authorName": "Nick Dorrell",
                "seedIndex": 0,
            }],
        }
        epmc_row = {
            "title": "Outer membrane vesicle cargo delivery in Campylobacter jejuni",
            "doi": "10.1000/followup.1",
            "year": "2025",
            "authors": ["Fatima Nasher", "Nick Dorrell"],
            "abstract": "Outer membrane vesicles deliver bacterial cargo to intestinal epithelial cells.",
            "source": "Europe PMC",
            "sourceList": ["Europe PMC"],
            "retrievalEvidence": [{"channel": "concepts:q1", "provider": "Europe PMC", "rank": 2}],
        }
        ranked = merge_and_rank_pipeline_candidates(
            {"europePmc": [epmc_row], "authorTrajectory": [traj_row]},
            [self.biomed_seed],
            {"semanticRerank": False, "pairwiseRerank": False},
        )
        self.assertEqual(len(ranked), 1, "Duplicate across branches must be merged into one record")
        merged = ranked[0]
        channels = [ev["channel"] for ev in merged["retrievalEvidence"]]
        self.assertIn("author:0:last", channels)
        self.assertIn("concepts:q1", channels)
        self.assertEqual(merged["authorRole"], "last")
        self.assertEqual(merged["authorTrajectoryLabel"], "Same senior author")
        self.assertEqual(merged["whyFound"][0]["kind"], "senior-author")
        self.assertEqual(merged["whyFound"][0]["label"], "Same senior author")
        self.assertIn("Nick Dorrell", merged["whyFound"][0]["detail"])

        # Also verify warm_paper_discovery schedules authorTrajectory when seed work has authorships
        captured_tasks = {}

        def fake_parallel_branches(tasks, on_progress, cancel_event):
            captured_tasks.update(tasks)
            return {k: [] for k in tasks}, list(tasks), {}

        discovery._PREWARM_TIMES.clear()
        with patch.object(_core, "openalex_work_for_paper", return_value=self.biomed_work), \
             patch("pulse_core.discovery.parallel_branches", side_effect=fake_parallel_branches), \
             patch("pulse_core.discovery.cooldowns", return_value={}), \
             patch("pulse_performance.openalex_allowance_remaining", return_value=5000):
            ok = discovery.warm_paper_discovery(self.biomed_seed, {"branches": {"citationGraph": True, "citationNetwork": True}})
        self.assertTrue(ok)
        self.assertIn("authorTrajectory", captured_tasks)
        discovery._PREWARM_TIMES.clear()


if __name__ == "__main__":
    unittest.main()
