# Section 5 — Compare Selected Papers (Evidence Matrix)

## 1. What Changed
1. **Entry Point & UI**:
   - Added **Compare selected** button to the Discovery bulk bar (`#discoveryBulkBar`), enabled whenever 2–15 papers are selected.
   - Introduced `#discoveryCompareDialog` evidence matrix modal presenting side-by-side comparison across 4 structured columns (plus Paper):
     - `Paper`: Title and citation metadata.
     - `Study system / organism`: Model organism, cohort, dataset, or experimental subject.
     - `Core method`: Primary technique, assay, or computational pipeline.
     - `Main finding`: Core empirical finding, quantitative delta, or main claim.
     - `Limitation`: Explicit caveats, bounds, or unaddressed conditions.
   - Cells display the extracted claim with supporting verbatim sentences visible on hover or embedded quote callouts.
   - Added one-click **Export CSV** and **Export Markdown** buttons.

2. **Quote checks**:
   - Implemented in `pulse_core/evidence_matrix.py`: every cell must be grounded in text Pulse possesses (abstract or local library full text).
   - A cell is kept only if its quote is a verbatim substring of the source text **and** the cell value appears inside that quote; otherwise it reads `"Not stated in the abstract"` or `"Not stated in the paper"`. (The second check was added in the audit: before it, an invented claim paired with a real quote passed.)
   - This prevents invented text, but not a wrong sentence being chosen; the interface therefore labels cells as automatic extraction (no AI) and shows each quote.
   - Because abstracts rarely enumerate limitations, the Limitation column correctly defaults to `"Not stated in the abstract"`, preventing false claims.

3. **Backend Service & Concurrency**:
   - `/api/discovery/compare` endpoint in `pulse_core/server.py`.
   - Bounded concurrency with a maximum of 2 concurrent workers and per-paper caching by `(paper_id, text_hash, column_set)`.
   - Uses local deterministic sentence heuristic extraction (`heuristic_extract_column`), verifying every sentence against the source text without external or local LLM dependencies.

---

## 2. Evaluation (audit, 17 October)

The earlier version of this section reported 80 synthetic test cells with “0% hallucinated” cells as an accuracy result. Those are unit-test fixtures, not an accuracy measurement, so the claim was withdrawn. An audit on real RELISH abstracts found that the first rules gave the wrong study system in most filled cells (for example “The Gram” for *S. aureus*, “Light Scattering” for fibrin clots), all marked as grounded.

After the fixes:
- Every cell value must appear inside its quote, and the quote must appear in the paper.
- The study system is taken only from organism names (abbreviated or full Latin names with supporting evidence), model systems and populations, and named datasets. Method, finding and limitation are shown as whole sentences. Findings skip aims, hypotheses and background sentences.
- On 36 hand-checked RELISH abstracts (24 used while fixing the rules, 12 unseen), the study system was correct in about 16 of 18 filled cells. Method was filled for 20 of 36 papers and finding for 19 of 36. Limitation was filled for 0 of 36; abstracts rarely state limitations.
- The CSV export neutralises spreadsheet formulas. The server enforces 2–15 papers and at most 8 short columns.
- Tests: `local-web/tests/test_evidence_matrix.py`.
- Latency is about 1–2 ms per paper (rules only).
