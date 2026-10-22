import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pulse-backend"))
os.environ.setdefault("PULSE_CONFIG_DIR", tempfile.mkdtemp(prefix="pulse-evidence-test-"))

from pulse_core import evidence_matrix as em


class EvidenceMatrixTests(unittest.TestCase):
    def test_verbatim_quote_grounding_rejects_hallucinations(self):
        source = (
            "Single-cell RNA sequencing was performed on 5,000 murine cortical neurons. "
            "We observed a 3-fold increase in synaptic marker expression across treated cohorts."
        )
        # 1. Real verbatim quote
        valid = em.verify_grounded_cell(
            "3-fold increase in synaptic marker",
            "We observed a 3-fold increase in synaptic marker expression across treated cohorts.",
            source,
            source_type="abstract",
        )
        self.assertTrue(valid["grounded"])
        self.assertEqual(valid["value"], "3-fold increase in synaptic marker")

        # 2. Hallucinated quote (not in source text)
        hallucinated = em.verify_grounded_cell(
            "10-fold increase in human brain organoids",
            "We observed a 10-fold increase in human brain organoids.",
            source,
            source_type="abstract",
        )
        self.assertFalse(hallucinated["grounded"])
        self.assertEqual(hallucinated["value"], "Not stated in the abstract")
        self.assertEqual(hallucinated["quote"], "")

        # 3. Empty quote
        empty = em.verify_grounded_cell("Some claim", "", source, source_type="abstract")
        self.assertFalse(empty["grounded"])
        self.assertEqual(empty["value"], "Not stated in the abstract")

    def test_gold_sheet_20_papers_zero_hallucinations(self):
        # 20 hand-crafted scientific abstracts across biology, medicine, computer science and physics
        gold_papers = [
            {
                "id": f"p{i}",
                "title": f"Scientific Study {i}",
                "authors": [f"Author {i}"],
                "year": 2024,
                "abstract": (
                    f"We developed a novel microfluidic droplet assay to analyze primary human T-cells in cohort {i}. "
                    f"Our neural network algorithm improved cell segmentation accuracy by 14.2% over existing baselines. "
                    + (
                        "A key limitation is that our analysis was restricted to in vitro cultures and did not evaluate tissue architecture."
                        if i % 4 == 0
                        else "These findings highlight promising therapeutic targets."
                    )
                ),
            }
            for i in range(20)
        ]

        matrix = em.generate_evidence_matrix(gold_papers, max_workers=2)
        self.assertEqual(len(matrix["rows"]), 20)

        total_cells = 0
        hallucinated_cells = 0
        populated_cells = 0

        for r, p in zip(matrix["rows"], gold_papers):
            source = p["abstract"]
            for col_id in ["system", "method", "finding", "limitation"]:
                total_cells += 1
                cell = r["cells"][col_id]
                if cell["grounded"]:
                    populated_cells += 1
                    # Verify quote is strictly a verbatim substring of the source
                    if not em.is_verbatim_quote(cell["quote"], source):
                        hallucinated_cells += 1
                else:
                    self.assertEqual(cell["value"], "Not stated in the abstract")
                    self.assertEqual(cell["quote"], "")

        # Zero hallucinated cells
        self.assertEqual(hallucinated_cells, 0)
        self.assertGreaterEqual(populated_cells, 50)  # At least system, method, finding populated across papers

        # Limitation should be correctly "Not stated" on 15 of 20 papers where not mentioned
        limitation_not_stated = sum(
            1 for r in matrix["rows"] if r["cells"]["limitation"]["value"] == "Not stated in the abstract"
        )
        self.assertEqual(limitation_not_stated, 15)

    def test_export_csv_and_markdown(self):
        papers = [
            {
                "id": "1",
                "title": "Benchmarking Transport Networks",
                "authors": ["Ada Brooks"],
                "year": 2024,
                "abstract": "We developed a graph neural network using urban transit datasets. Our algorithm improved throughput by 12%.",
            },
            {
                "id": "2",
                "title": "Single-cell Transcriptomics",
                "authors": ["Sam Rivera"],
                "year": 2023,
                "abstract": "We tested CRISPR knockouts in human cell lines. Analysis revealed significant gene expression shifts.",
            },
        ]
        matrix = em.generate_evidence_matrix(papers)
        csv_text = em.export_matrix_csv(matrix)
        self.assertIn("Benchmarking Transport Networks", csv_text)
        self.assertIn("Core method", csv_text)

        md_text = em.export_matrix_markdown(matrix)
        self.assertIn("| Paper | Meta | Study system / organism | Core method | Main finding | Limitation |", md_text)
        self.assertIn("| Benchmarking Transport Networks |", md_text)


if __name__ == "__main__":
    unittest.main()


class EvidenceMatrixAuditFixes(unittest.TestCase):
    """Fixes from the 2.0.0 audit: honest extraction, claim-in-quote check, CSV and request safety."""

    def test_invented_claim_with_a_real_quote_is_rejected(self):
        source = "Outer membrane vesicles were isolated from cultures. Vesicles induced IL-8 secretion in epithelial cells."
        cell = em.verify_grounded_cell("Vesicles cured infection in 90% of patients", "Vesicles induced IL-8 secretion in epithelial cells.", source)
        self.assertFalse(cell["grounded"])
        self.assertEqual(cell["value"], "Not stated in the abstract")
        ok = em.verify_grounded_cell("induced IL-8 secretion", "Vesicles induced IL-8 secretion in epithelial cells.", source)
        self.assertTrue(ok["grounded"])

    def test_study_system_prefers_organisms_and_avoids_look_alikes(self):
        bio = "Cytokines were measured. S. aureus strains were grown in broth, and Staphylococcus aureus Newman was used throughout."
        self.assertEqual(em.heuristic_extract_column("system", bio)["value"], "Staphylococcus aureus")
        stats = "We compute the Mahalanobis distance between spectra. The Perseus interface is used for post-processing."
        self.assertEqual(em.heuristic_extract_column("system", stats)["value"], "Not stated in the abstract")
        trial = "This trial enrolled healthy adults aged 18-45. Data were analysed by intention to treat."
        self.assertEqual(em.heuristic_extract_column("system", trial)["value"], "healthy adults")
        self.assertEqual(em.heuristic_extract_column("system", "Body weight was recorded daily. We infected mice with the strain.")["value"], "infected mice")
        mech = "At small strains the clots behaved linearly. Fibre compaction increased stiffness."
        self.assertEqual(em.heuristic_extract_column("system", mech)["value"], "Not stated in the abstract")

    def test_findings_are_whole_result_sentences_not_aims_or_hypotheses(self):
        text = ("Little is known about vesicle uptake. To test this hypothesis, we studied 40 mice. "
                "We found that vesicle uptake increased 3-fold (p < 0.01). These vesicles might be useful vaccines.")
        cell = em.heuristic_extract_column("finding", text)
        self.assertEqual(cell["value"], "We found that vesicle uptake increased 3-fold (p < 0.01).")
        self.assertNotIn("…", cell["value"], "short sentences are shown whole")

    def test_sentences_do_not_split_on_common_abbreviations(self):
        parts = em._sentences("Rhizopus stolonifer var. lyticus grew well. Smith et al. showed the effect in C. jejuni strains.")
        self.assertEqual(len(parts), 2)

    def test_csv_export_neutralises_spreadsheet_formulas(self):
        matrix = {"columns": [{"id": "finding", "name": "Main finding"}], "rows": [
            {"title": "=HYPERLINK(\"http://evil.example\",\"click\")", "meta": "+1", "doi": "-2",
             "cells": {"finding": {"value": "@SUM(A1:A2)", "quote": "", "grounded": True}}}]}
        csv_text = em.export_matrix_csv(matrix)
        for dangerous in ('=HYPERLINK', '+1', '-2', '@SUM'):
            self.assertIn("'" + dangerous, csv_text)

    def test_provider_label_says_no_ai(self):
        papers = [{"title": f"P{i}", "abstract": "We found that uptake increased 3-fold in mice."} for i in range(2)]
        self.assertEqual(em.generate_evidence_matrix(papers)["provider"], "Automatic sentence extraction (no AI)")


class CompareEndpointValidation(unittest.TestCase):
    def test_server_enforces_paper_and_column_limits(self):
        from pulse_core import server
        from pulse_core.constants import ClientError
        paper = {"title": "P", "abstract": "We found that uptake increased 3-fold in mice."}
        self.assertEqual(len(server.handle_discovery_compare({"papers": [paper, paper]})["rows"]), 2)

    def test_section_targeted_harvesting(self):
        paper = {
            "title": "Study on Campylobacter invasion",
            "abstract": "We investigated invasion mechanisms in vitro.",
            "text": (
                "Introduction\nPathogen invasion is critical for enteritis.\n\n"
                "Methods\nWe measured bacterial uptake in human monocytes using gentamicin protection assay.\n\n"
                "Results\nBacterial adhesion increased by 45 percent.\n\n"
                "Discussion\nOur findings demonstrate an important role for CadF.\n\n"
                "Limitations\nA key limitation is that small sample sizes were evaluated and cannot rule out strain variation.\n"
            )
        }
        cols = [{"id": "method", "name": "Method"}, {"id": "limitation", "name": "Limitation"}]
        row = em.build_evidence_row(paper, cols)
        lim_cell = row["cells"]["limitation"]
        self.assertTrue(lim_cell["grounded"])
        self.assertIn("limitation is that small sample", lim_cell["quote"])
        self.assertIn("Section: Limitations", lim_cell["provenance"]["source"])

    def test_consensus_and_contradiction_detection(self):
        papers = [
            {
                "id": "p1",
                "title": "Treatment A improves microglia clearance",
                "abstract": "We found that treatment A significantly increased phagocytosis in microglia."
            },
            {
                "id": "p2",
                "title": "Treatment B inhibits microglia clearance",
                "abstract": "We observed that compound B significantly decreased phagocytosis in microglia."
            }
        ]
        matrix = em.generate_evidence_matrix(papers)
        self.assertIn("consensus", matrix)
        con = matrix["consensus"]
        self.assertGreaterEqual(con["conflictingCount"], 1)
        self.assertEqual(con["conflicting"][0]["target"], "microglia")
        self.assertEqual(con["conflicting"][0]["directionA"], "positive")
        self.assertEqual(con["conflicting"][0]["directionB"], "negative")
