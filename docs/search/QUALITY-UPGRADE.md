# Research quality and ranking speed — development source

These changes extend concept and related-paper searches in source. They are not yet part of the published 1.7.11 installers.

## Evidence-weighted DBEF

DBEF's shared-reference equations remain unchanged. Its influence on preliminary selection, reciprocal-rank fusion and shared-reference graph scores now depends on evidence quality. Three coverage estimates describe the candidate bibliography, seed bibliography and resolved reference metadata. Their geometric mean is combined with saturating shared-reference support and text relevance. Unknown coverage is recorded as unknown and conservatively weighted as 0.5; it is not assumed complete. Direct forward/backward citation paths retain their own evidence independently.

The active policy uses coverage power 1 and overlap scale 4. These are conservative engineering defaults, **not fitted parameters or a demonstrated held-out quality gain**. The benchmark runner can compare a small policy grid on frozen actual retrieval pools. It selects on training questions, requires validation improvement, and checks the reserved test questions once. At least three reviewed, DBEF-supported questions per split are required. It never inserts judged papers into the pool to manufacture success.

## Question-scoped feedback

Relevant and Not relevant labels now form a contrastive concept profile from paper titles, abstracts and keywords. Concepts equally represented in both classes cancel. Matching preferred concepts raises priority; matching rejected concepts lowers it. Where the embedding model is available, a bounded positive-versus-negative vector contrast helps match synonymous wording. Direct user labels remain authoritative, and missing AI does not remove collected papers.

The profile is scoped to the exact research question and seed identities, with no global model training. Search details show favored and lowered concepts, and result explanations describe feedback support. A single positive class has a smaller influence until users supply contrasting examples.

## Bibliography parsing and DOI checks

PDF extraction uses line coordinates to read detected columns vertically, preserving full-width headings. Scanned or unreadable pages can use local English OCR through PyMuPDF. English `tessdata_fast` 4.1.0 data and its Apache-2.0 license are included in `local-web/pulse-backend/ocr-data`; its pinned source and SHA-256 are in `provenance.json`. The desktop staging step copies this directory with the backend. No PDF is uploaded for OCR.

Extraction reads at most 80 pages, retaining the tail of long documents for references. At most eight pages receive OCR, with a 16-second scheduling budget and bounded render geometry. This is a scheduling limit, not a hard interrupt inside the OCR engine. Bibliography provenance records read pages, column ordering, OCR pages and incomplete extraction. The citation chooser shows OCR and incomplete-page notices. Complex layouts, damaged scans and other languages can still need manual reference input.

Supplied author initials and ORCIDs, journal abbreviations/ISSNs, volume, issue, page ranges and precise publication dates are checked alongside DOI, title, surname and year. Print and online publication dates are retained separately. A real conflict blocks automatic addition and keeps the candidate reviewable. Missing registry precision is reported as unknown rather than invented. Reference initials, bibliography entries and extraction provenance survive import, workspace save and recovery.

## Publication versions and notices

Crossref DOI relationships group linked preprints and published versions even when titles differ. Published representatives keep their own citation counts; discovery evidence from copies can be combined. Corrections, retractions and expressions of concern remain distinct records.

Selecting a verified library DOI checks Crossref for both its relationships and reverse update notices, under an eight-second request budget. The inspector links to original articles, published/preprint versions and recorded notices. Checks are coalesced, success is cached for an hour, and unavailable lookups retain previous warnings. The status check sends the selected DOI to Crossref, without uploading paper text or adding requests for every ranking candidate. A missing notice is not proof that an article has no publication issues.

## Faster ranking

The expensive neural stages assess balanced shortlists: at most **96 embedding candidates** and **48 cross-encoder candidates**. The cross-encoder receives one query-focused excerpt of up to 120 words per paper. Stored abstracts, imported full text and result previews stay complete. Full retrieved candidate pools remain eligible for ordinary ranking and the existing display limit.

Repeated pairwise scores reuse a bounded cache keyed by model/runtime fingerprints, query and prepared text. Changed metadata or questions invalidate the relevant cache. Embedding inputs are bounded, and feedback reuses the same vector cache. Citation percentiles use sorted cohorts; version matching uses indexed identity groups rather than all-pairs comparisons. Optional AI triage reviews at most ten papers under an eight-second overall budget. Timeouts keep collected results and explain the fallback.

On the test Mac, an identical synthetic 180-paper workload took **20.85 s before** and **13.36 s after**, with a cached repeat at **0.13 s**. A 2,000-paper CPU-only workload dropped from **2.97 s to 0.62 s**. The baseline embedding stage timed out; the updated stage completed 96 embeddings. These measurements exclude live collection and do not establish ranking quality or latency on other devices. See [the recorded summary](../../benchmarks/research-upgrade-summary.json). Smaller neural shortlists can change which papers receive model scores; assess relevance on reviewed questions before increasing confidence in the defaults.

## Forty-question benchmark

Open **Settings → Search sources → Review research benchmark**. The local review page contains 20 biomedical questions from distinct SciFact evidence groups and 20 general research questions. Biomedical relevance labels come from SciFact's human annotations: supporting and refuting papers both count as relevant evidence. General-topic positives/landmarks and proposed irrelevant distractors are provisional assistant curation. They are excluded from default evaluation until reviewed. Reviewer identity and explicit changed judgments are recorded on export; unchanged provisional labels are never silently promoted.

The question groups have disjoint training (24), validation (8) and test (8) splits. The optional seed DOI must be a related paper distinct from all judged targets. The supplied definitions are concept searches without seeds, so the completed 40-question run had **zero DBEF-supported cases**. No fitted DBEF policy was adopted. To evaluate DBEF, add distinct suitable seeds, review relevant/irrelevant and landmark judgments, rerun collection, then inspect held-out results.

Run the full pipeline explicitly; no network calls occur merely by opening the review page:

```sh
python3 tools/benchmark_research.py --live --workers 2 --output /tmp/pulse-research.json

# Use exported judgments, including optional distinct seed DOIs.
python3 tools/benchmark_research.py --definitions /path/to/reviewed.json \
  --live --output /tmp/pulse-reviewed.json

# Repeat ranking on the same collected pool, without provider collection.
python3 tools/benchmark_research.py --definitions /path/to/reviewed.json \
  --snapshot /tmp/pulse-reviewed.snapshot.json --output /tmp/pulse-replay.json

# Synthetic latency only; --neural uses installed local models.
python3 tools/profile_ranking.py --neural --output /tmp/pulse-latency.json
```

The live runner captures the complete actual provider pools and records source failures, collection/ranking times and time to first useful results. It reports nDCG@10, known-paper precision/recall, top-50 landmark misses and Hole@10 (unjudged results). Precision and recall are incomplete-label checks, not general accuracy claims. Do not interpret unjudged papers as confirmed irrelevant. `--include-provisional` permits exploratory reporting but cannot authorize adopting a fitted policy.

The completed run returned results for 39/40 questions, with median first results at **4.41 s** and total time **17.73 s**. Semantic Scholar lexical search and CORE failed on all 40 runs. The sparse human judgments leave most returned papers unjudged, and landmark judgments are not yet reviewed. This is a useful integration check and review starting point, not a validated full-source relevance comparison.

Provenance and evaluation references:

- [SciFact data and human annotations](https://github.com/allenai/scifact): claims CC BY 4.0; abstract dataset ODC-By 1.0. The builder records the official archive's checksum and claim/document IDs.
- [BEIR evaluation metrics](https://github.com/beir-cellar/beir/wiki/Metrics-available): ranking and incomplete-judgment metrics.
- [Crossref publication updates](https://www.crossref.org/documentation/crossmark/version-control-corrections-and-retractions/): DOI-linked publication notices.
- [PyMuPDF local OCR](https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html): local Tesseract-backed text extraction.

Backend, browser and PDF regression tests cover evidence gating, feedback isolation, score-cache invalidation, column/OCR extraction, citation conflicts, notice direction, stale selection, metadata recovery and review provenance.
