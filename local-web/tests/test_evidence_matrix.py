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
