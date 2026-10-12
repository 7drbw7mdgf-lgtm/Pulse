# DBEF shared-reference discovery

Pulse’s DBEF method replaces the legacy first-four-reference bibliographic search. The development source restores co-citation as a separate bounded channel alongside DBEF. Direct citations, Semantic Scholar recommendations, concept searches across selected indexes and optional local full-text retrieval remain complementary ways to find papers without a shared indexed bibliography.

## How it works

The implementation adapts the supplied `dbef_content.py`. The equations, tokenizer, content floors, saturation and two-stage bound are retained. A sparse standard-library TF-IDF implementation replaces NumPy/scikit-learn so the packaged backend needs no additional Python packages or model download. Pulse’s existing optional neural ranking remains part of the final cross-source ranking.

For each seed, Pulse resolves its indexed bibliography, batch-fetches reference titles/abstracts and citation counts, and selects reference pivots by content-adjusted specificity. It searches for papers citing those pivots, using recent and highly cited streams. It then scores candidates with:

`reference weight = ln(1 + N / (reference citations + 1)) × (0.2 + 0.8 × calibrated reference–seed similarity)`

`DBEF score = sum(shared reference weights) / sqrt(bibliography length + 15) × (0.3 + 0.7 × calibrated candidate–seed similarity) × (1 + 0.5 × ln(1 + recent citation velocity))`

Content similarity uses titles and abstracts with the supplied compound-preserving tokenizer and maximum similarity across selected seeds. Missing text is neutral; explicit zero citations remain distinguishable from unknown counts. Unknown reference counts use the median known reference count for internal weighting, without inventing a reported citation metric. Recent velocity uses up to three completed calendar years; missing annual data contributes no velocity multiplier. The existing generic citation-velocity bonus is suppressed for DBEF-scored candidates to avoid counting it twice.

The corpus size is the sum of available primary-field totals when all selected fields resolve; otherwise the supplied default assumption of ten million is recorded explicitly. OpenAlex supports [field work totals](https://help.openalex.org/data/fields/), [batch ID lookups and citation traversal](https://help.openalex.org/how-to/api-recipes/), and [OR filters](https://help.openalex.org/api/filtering/).

## Limits and interpretation

Collection shares a 12-second deadline, preserves shorter parent deadlines and keeps collected results when the cap is reached. Reference metadata is batched and bounded to 400 references; up to 12 weighted pivots are balanced across seeds. Candidate retrieval and scoring remain a bounded sample of the index, not an exhaustive literature review. The development source uses seed/reference-only content calibration and a fixed seed-derived saturation scale; see [calibration and missing-evidence handling](DBEF-CALIBRATION.md). The bound diagnostic describes that scoring stage; it is not a guarantee of globally best papers or complete indexed coverage.

DBEF contributes one retrieval channel even when several pivots or seeds find the same paper. Its rank and graph score feed Pulse’s hybrid ranking and neural shortlists. Strong-match labels still require the existing relevance, top-decile and independent-channel checks. DBEF reference matches also provide explicit evidence for multi-seed bridges. The previous source/workspace key `citationNetwork` remains compatible and is labelled **DBEF** in the interface.

Identical provider query strings are executed once per search plan, including broadening variants. Concurrent identical cached GET requests share transport work; uncached requests and POST actions keep their existing behavior. Waiting callers retain their own cancellation and time budgets.

## Verification

The [parity record](../../benchmarks/dbef-parity.json) compares the adapted scorer with the supplied NumPy scorer using identical TF-IDF vectors. Six synthetic cases returned identical top-20 lists; the maximum score difference was about `3.6e-15`. This validates the scoring math, rather than real-world retrieval quality.

A [live OpenAlex check](../../benchmarks/dbef-live-check.json) on the public paper `10.7717/peerj.4375` collected 131 candidates and returned 20 ranked papers in one sample of about 8.2 seconds. It confirms the provider integration, not a general latency or recall guarantee. Regression tests cover formula terms, missing data, bibliography-length saturation, source deduplication, cancellation, bounded collection, original seed identities, hybrid integration and library persistence.
