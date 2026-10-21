# Research workflow integration (unreleased)

## Evidence and citation context

Compare selected now reads saved library text and page-level PDF/OCR passages. Methods, Results and Discussion sections are preferred for the corresponding cells; reference lists are excluded. With **Retrieve open-access full text** checked, missing text is resolved through Europe PMC with exact DOI/PMID/PMCID checks. Retrieval uses two workers and bounded timeouts. Abstracts remain the fallback. Full text stays on the local comparison route and is excluded from library sync and provider query payloads.

Each populated cell offers **View source**, showing the quotation, surrounding text and available page/section/article link. CSV and Markdown exports include quotations and provenance. Extraction remains deterministic and can select an inappropriate sentence or contain OCR errors; the quotation needs human review.

**Verify citation passage** checks a selected seed's exact DOI or PMID against JATS bibliography identifiers and sentence-level citation links. For local PDFs/imported text, verification requires a uniquely numbered bibliography entry containing the exact DOI and a matching explicit bracketed number in the body. Author/year guesses, missing superscripts and ambiguous numbers remain unverified. Multiple seeds prompt a target choice. Verification establishes citation identity, not agreement, contradiction or evidentiary strength. Local page provenance is retained.

## Screening projects

Use **Screening project** in discovery to enable formal decisions. Relevance feedback retains its normal behavior when screening is paused. Projects are stored separately from the library in a private local `screening.sqlite3` database; they are not synchronized between computers.

- **R / N** include/exclude the focused paper at the selected title/abstract or full-text stage. A full-text exclusion requires a reason. Cancelling reason entry restores the previous relevance grade.
- **M / T** edit memos or tags for selected papers, or the focused paper when none are selected.
- Bulk screening decisions save once per batch (up to 500 papers), with one full-text exclusion reason and one undo action for the batch.
- **Cmd/Ctrl+Z** reverses the latest project action while the discovery workspace has focus. Undo persists across restarts and restores only affected relevance labels. Text editors keep their normal undo behavior.
- **Export review** provides decisions CSV, tagged RIS, a project/audit-history JSON file, or PRISMA working-data JSON. RIS contains stage/decision keywords and exclusion reasons; no Covidence/Rayyan-specific round-trip compatibility is claimed.

Captured candidates are deduplicated by DOI, then provider identifier, then normalized title/year. Search runs retain available provider counts, failures and truncation indicators. Unknown identification totals, upstream duplicate counts and included **study** counts remain null. The export is working data, not a complete PRISMA flow diagram. Reports have not been grouped into studies, and independent stage decisions require consistency review.

## Retrieval completeness and cache

Provider health chips and a coverage explanation distinguish failed/limited sources from completed searches. **Retry unavailable sources** reruns only enabled failed branches using the original search options. Previous rows, order, focus and feedback are retained; newly found papers are appended without a combined rank score. Run a full search to rank the merged pool together. Failed or cancelled retries preserve the current workspace.

Background HTTP-cache maintenance runs only while search is idle. Expired entries are removed, then recent identifier/citation metadata is preferred over text-query responses when enforcing the 10,000-entry / 256 MiB compressed-response bounds. Metadata still expires after seven days; ordinary queries expire after 15 minutes. The limit applies to response payloads, not SQLite's allocated file size. Search settings also offer manual cleanup. Existing limited cache prewarming is retained; maintenance never changes library papers.

## Ranking experiments

Both switches in **Settings → Search → Ranking experiments** default to off. Existing fixed structural weighting and MiniLM behavior are preserved by default.

Adaptive structural weighting uses query intent, indexed seed-reference coverage and observed candidate structural support. Bibliography exploration can receive up to ten structural points; focused topical searches receive at most 3.5. Both are reduced for missing graph coverage and gated by topical agreement. Rejected papers receive no structural/backward bonus. Automatic intent chooses focused mode when explicit query terms or a research question are present; a manual emphasis override is available.

The optional biomedical router requires biomedical query terms, high-confidence Life/Health Sciences OpenAlex primary topics for every seed and each routed candidate, a verified local MedCPT component, and the portable ONNX ranker. Mixed/uncertain topics stay with MiniLM. At most 24 candidates receive an additional six-second scoring budget and a 25% MedCPT / 75% MiniLM blend. Missing models, timeouts and invalid output retain MiniLM. Searches never install or download this component.

Prepare a component in a separate build environment:

```sh
python -m pip install -r scripts/requirements-biomedical-build.txt
python tools/prepare_biomedical_model.py --output /path/to/new/medcpt-folder
```

The tool pins the official [NCBI MedCPT model](https://huggingface.co/ncbi/MedCPT-Cross-Encoder) at revision `71caf65d4927987813984f54c284405a13fcca49`, uses weights-only loading, exports ONNX, includes the upstream license/model card and writes SHA-256 checksums. Select the output folder in Search settings. `--precision int8` strictly rejects failed quantization; automatic mode retains the verified float32 export when quantization fails. On this Mac, full and hybrid int8 conversions exceeded the 0.05 score-error tolerance, so float32 is retained. Three synthetic conversion probes are not a relevance evaluation. No biomedical model has been added to the normal installer or published to GitHub by this integration.

An offline smoke check through the portable Mac ranker passed for one routed biomedical candidate and one generic candidate. The combined route took 6.283 seconds cold and 0.002 seconds with cached scores. This is a two-paper component check, not a full-search latency or relevance benchmark. Reproduce with `tools/smoke_biomedical_router.py --runtime /path/to/.search-runtime --model /path/to/medcpt-folder`. Native Windows model inference has not been rerun for this unreleased integration.

## Exploratory fixed-pool check

The same previously examined 146 cases were rerun without neural models or provider calls. These are development pools, **not untouched held-out data**. No scoring parameters were chosen using individual judgments. Compared with the unchanged fixed policy:

| Dataset | Cases | Fixed Recall@50 | Adaptive Recall@50 | Paired delta, exploratory 95% bootstrap CI |
|---|---:|---:|---:|---:|
| RELISH | 100 | 0.2072 | 0.2088 | +0.0016 [0.0005, 0.0030] |
| SYNERGY | 16 | 0.1724 | 0.1675 | −0.0049 [−0.0147, 0.0000] |
| SciDocs | 25 | 0.1267 | 0.1307 | +0.0040 [0.0000, 0.0120] |
| Head-to-head | 5 | 0.6133 | 0.6133 | 0.0000 [0.0000, 0.0000] |

The mixed result does not establish a general relevance gain. MedCPT routing was not part of this comparison. Before changing defaults, freeze the policy, obtain new held-out seeds and independently judged relevance across biomedical and general domains, then compare fixed/adaptive and MiniLM/router separately on identical pools. Report nDCG@20, Recall@50, failures and cold/warm latency; keep the head-to-head secondary. Require no material domain regression and a supported independent gain before promotion.

Reproduce with `tools/benchmark_citation_update.py --policy fixed --output baseline.json`, then `--policy adaptive --intent auto --compare baseline.json --output adaptive.json`. Frozen pool locations are documented in [INDEPENDENT-BENCHMARK.md](INDEPENDENT-BENCHMARK.md). Raw text and judgments remain outside this repository.

Regression coverage: `local-web/tests/test_research_tools.py` and `tests/research_tools_ui.cjs`, included in the regular backend and browser suites. Browser tests use synthetic papers, isolated profiles and an actual backend restart.
