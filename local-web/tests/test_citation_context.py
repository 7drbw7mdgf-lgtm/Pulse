import io
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pulse-backend"))
os.environ.setdefault("PULSE_CONFIG_DIR", tempfile.mkdtemp(prefix="pulse-cite-ctx-test-"))

from pulse_core import s2_client
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_core.search_merge import merge_search_records


class CitationContextTests(unittest.TestCase):
    def test_normalize_citation_contexts_bounds_count_and_length(self):
        long_sentence = "A" * 450
        raw = [
            "  We used the protocol described by Smith et al. (2022) to isolate single nuclei.  ",
            "We used the protocol described by Smith et al. (2022) to isolate single nuclei.",
            long_sentence,
            "Second distinct context sentence comparing downstream yield.",
            "Third context sentence that should be dropped because limit is 3.",
        ]
        cleaned = s2_client.normalize_citation_contexts(raw)
        self.assertEqual(len(cleaned), 3)
        self.assertEqual(
            cleaned[0],
            "We used the protocol described by Smith et al. (2022) to isolate single nuclei.",
        )
        self.assertLessEqual(len(cleaned[1]), 300)
        self.assertTrue(cleaned[1].endswith("…"))
        self.assertEqual(cleaned[2], "Second distinct context sentence comparing downstream yield.")

    def test_normalize_citation_intents_maps_canonical_labels(self):
        intents = s2_client.normalize_citation_intents(
            ["methodology", "results_comparison", "background", "methods"]
        )
        self.assertEqual(intents, ["Methodology", "Result", "Background"])

    def test_s2_fetch_citations_and_references_attach_context_and_respect_unauth_cap(self):
        fake_rows = [
            {
                "contexts": [f"Context sentence for paper {i} citing the seed method."],
                "intents": ["methodology"] if i % 2 == 0 else ["background"],
                "isInfluential": (i == 0),
                "citingPaper": {
                    "paperId": f"S2_{i}",
                    "title": f"Downstream study {i}",
                    "year": 2024,
                    "externalIds": {"DOI": f"10.1000/test.{i}"},
                },
            }
            for i in range(30)
        ]
        with patch.object(s2_client, "fetch_s2_json", return_value={"data": fake_rows}) as mocked:
            unauth = s2_client.s2_fetch_citations("S2_SEED", api_key="", limit=30)
            url_called = mocked.call_args[0][0]
            self.assertIn("contexts,intents,isInfluential", url_called)
            self.assertEqual(len(unauth), 30)
            self.assertEqual(
                unauth[0]["citationContexts"],
                ["Context sentence for paper 0 citing the seed method."],
            )
            self.assertEqual(unauth[0]["citationIntents"], ["Methodology"])
            self.assertTrue(unauth[0]["isInfluentialCitation"])
            # Unauthenticated calls cap context attachment at 25 edges
            self.assertIn("citationContexts", unauth[24])
            self.assertNotIn("citationContexts", unauth[25])

            auth = s2_client.s2_fetch_citations("S2_SEED", api_key="user-s2-key", limit=30)
            self.assertIn("citationContexts", auth[29])

    def test_s2_enrich_citation_contexts_falls_back_silently_on_rate_limit(self):
        err = urllib.error.HTTPError(
            "https://api.semanticscholar.org/graph/v1/paper/S2_SEED/citations",
            429,
            "Too Many Requests",
            {},
            io.BytesIO(b"rate limit"),
        )
        with patch.object(s2_client, "fetch_s2_json", side_effect=err):
            res = s2_client.s2_enrich_citation_contexts("S2_SEED", direction="citations", api_key="")
            self.assertEqual(res, [])

    def test_extract_epmc_xml_citation_contexts(self):
        xml = """
        <article>
          <body>
            <sec>
              <p>Prior work established the baseline assay [<xref ref-type="bibr" rid="B1">1</xref>]. Specifically, we adapted the droplet barcoding workflow of Smith et al. [<xref ref-type="bibr" rid="B2">2</xref>] to profile 10,000 cells.</p>
              <p>Our measurements agreed with the calibration curve reported in [<xref ref-type="bibr" rid="B2">2</xref>] across all replicates.</p>
            </sec>
          </body>
          <back>
            <ref-list>
              <ref id="B1"><mixed-citation>Other paper</mixed-citation></ref>
              <ref id="B2"><mixed-citation>Smith et al. Droplet barcoding workflow. <pub-id pub-id-type="doi">10.1038/s41586-022-00001-1</pub-id></mixed-citation></ref>
            </ref-list>
          </back>
        </article>
        """
        contexts = s2_client.extract_epmc_xml_citation_contexts(
            xml, target_paper={"doi": "10.1038/s41586-022-00001-1", "title": "Droplet barcoding workflow"}
        )
        self.assertEqual(len(contexts), 2)
        self.assertIn("adapted the droplet barcoding workflow", contexts[0])
        self.assertIn("calibration curve reported in", contexts[1])
        self.assertTrue(all(len(c) <= 300 for c in contexts))

    def test_merge_and_ranking_preserve_citation_contexts_and_weight_intents(self):
        rec_a = {
            "title": "Method extension paper",
            "doi": "10.1000/method.1",
            "year": "2024",
            "authors": ["Alice Nguyen"],
            "abstract": "Single-cell RNA sequencing droplet barcoding protocol for transcriptomics.",
            "citationContexts": ["We directly extended the droplet barcoding protocol of Smith (2022)."],
            "citationIntents": ["Methodology"],
            "isInfluentialCitation": True,
            "retrievalEvidence": [{"channel": "citations:0:forward", "rank": 1, "provider": "Semantic Scholar"}],
        }
        rec_b = {
            "title": "Method extension paper",
            "doi": "10.1000/method.1",
            "year": "2024",
            "authors": ["Alice Nguyen"],
            "citationContexts": ["Our yield matched the benchmark reported by Smith (2022)."],
            "citationIntents": ["Result"],
        }
        merged = merge_search_records([rec_a, rec_b])
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]["citationContexts"]), 2)
        self.assertEqual(merged[0]["citationIntents"], ["Methodology", "Result"])
        self.assertTrue(merged[0]["isInfluentialCitation"])

        seed = {
            "title": "Droplet barcoding protocol for single-cell RNA sequencing",
            "doi": "10.1000/seed.1",
            "year": "2022",
            "abstract": "We introduce a droplet barcoding protocol for single-cell RNA sequencing.",
        }
        bg_only = {
            "title": "Background mention paper",
            "doi": "10.1000/bg.1",
            "year": "2024",
            "authors": ["Bob Jones"],
            "abstract": "Single-cell RNA sequencing droplet barcoding protocol for transcriptomics.",
            "citationContexts": ["Single-cell barcoding has been reviewed previously (Smith, 2022)."],
            "citationIntents": ["Background"],
            "isInfluentialCitation": False,
            "retrievalEvidence": [{"channel": "citations:0:forward", "rank": 1, "provider": "Semantic Scholar"}],
        }
        ranked = merge_and_rank_pipeline_candidates(
            {"citationGraph": [merged[0], bg_only]},
            [seed],
            {"semanticRerank": False},
        )
        by_doi = {r["doi"]: r for r in ranked}
        self.assertGreater(
            by_doi["10.1000/method.1"]["scoreBreakdown"]["citationContextBonus"],
            by_doi["10.1000/bg.1"]["scoreBreakdown"]["citationContextBonus"],
        )
        why_details = " ".join(w.get("detail", "") for w in by_doi["10.1000/method.1"]["whyFound"])
        self.assertIn("Methodology", why_details)
        self.assertIn("influential", why_details.lower())


if __name__ == "__main__":
    unittest.main()
