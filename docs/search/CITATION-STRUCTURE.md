# Citation structure, coverage and cache update

## Method

Shared-reference support combines degree-normalized overlap with saturating overlap support. References appearing across many candidate bibliographies carry less weight. Observed co-citation is normalized by the seed and candidate citation degrees; absent degrees receive conservative support. The two observed signals combine within a bounded six-point addition after neural ranking. Text-supported backward references receive up to three further points. Missing graph data is not manufactured as observed shared references.

Author history alone starts at 0.35 of a retrieval vote and is gated by topic support. A corroborating citation route can retain a full topic-gated vote. First- and senior-author history for the same seed count as one route, with the best observed rank; both author labels remain available. Fusion is normalized with the same weights. Explicitly rejected papers receive neither new structural nor backward bonuses.

## Fixed-pool check

Baseline: local 2.1.0 commit `f8e9c89`. Candidate: 2.1.1. All 146 frozen cases use the same candidates and judgments. Neural models are disabled in this check. Labels are used only for evaluation, never to choose a paper’s score. Several policies were checked during development, so these pools are not an untouched held-out test. Confidence intervals are exploratory paired bootstrap intervals (2,000 resamples).

| Dataset | Cases | nDCG@20, before → after | Recall@50, before → after | Paired Recall@50 delta, 95% CI |
|---|---:|---:|---:|---:|
| relish | 100 | 0.3024 → 0.3031 | 0.2110 → 0.2072 | -0.0038 [-0.0059, -0.0017] |
| synergy | 16 | 0.2291 → 0.2332 | 0.1616 → 0.1724 | +0.0108 [+0.0001, +0.0249] |
| scidocs | 25 | 0.0748 → 0.0768 | 0.1267 → 0.1267 | +0.0000 [+0.0000, +0.0000] |
| headtohead | 5 | 0.4086 → 0.4022 | 0.6267 → 0.6133 | -0.0133 [-0.0400, +0.0000] |

The result is mixed. SYNERGY top-50 coverage improves, while RELISH top-50 coverage declines on these pools. The five-seed head-to-head retrieves 46 rather than 47 known papers in the top 50. This does not establish an overall relevance win or superiority to Inciteful. Unjudged papers are not necessarily irrelevant. The citation-derived head-to-head is a secondary check and is especially sensitive to citation-weighted policies. Its frozen pools differ from the earlier live 21/75 result; those totals must not be compared as if they used the same retrieval pools.

Reproduce with `tools/benchmark_citation_update.py --source /path/to/checkout --output /path/to/baseline.json`, then run against the candidate checkout with `--compare /path/to/baseline.json`. The fixed pools remain outside the repository at the location documented in [the independent benchmark](INDEPENDENT-BENCHMARK.md). Raw datasets, judgments and paper text have not been added to the release.

## Collection and speed

The full `referenced_works` list is already present in a resolved OpenAlex work. The update hydrates every indexed ID in parallel batches of 100, rather than cap it to the displayed recommendation count. Incoming and outgoing directions publish independently. Fallback reference queries are bounded to 2,000 indexed works and report truncation. Provider omissions and exhausted budgets retain available work and report partial metadata. The metadata conversion no longer truncates reference IDs at 160.

Graph and co-citation use identical recent/highly-cited incoming streams, so simultaneous requests coalesce. Co-citation expands from a 16-citer sample to the same 80–400-citer budget used by graph collection. Highly cited seeds still use a sample; the app does not claim exhaustive incoming coverage. Seed resolution runs concurrently with topic providers. Nested requests inherit cancellation, deadlines and the shared request counter.

Public raw OpenAlex work records are cached for seven days across DOI, singleton, search and batch responses. Field coverage is checked before reuse. Partial updates cannot extend the expiry of older reference fields. The entity cache is bounded to 5,000 records and is private to the local profile; it stores public provider metadata, not API keys, contact query parameters or personal library notes. URL-encoded citation filters now receive the intended seven-day HTTP cache lifetime.

One live public-seed check (`10.1128/iai.00161-12`) used an isolated cache and a 20-second/12-request budget:

| Condition | Collection time | Network requests | Indexed outgoing references loaded | Incoming results |
|---|---:|---:|---:|---:|
| cold | 1.334 s | 4 | 78/78 | 79 |
| warm | 0.065 s | 0 | 78/78 | 79 |

These timings cover the OpenAlex citation neighborhood, not an entire multi-source search. Provider latency, cold caches, index changes and larger seeds can change the result. The live check is not a before/after relevance trial. The 513-test backend suite, workspace JavaScript tests, four browser suites and packaged-runtime checks are recorded with the local build artifacts.

API behavior follows the official [OpenAlex API recipes](https://help.openalex.org/how-to/api-recipes/) and [paging documentation](https://help.openalex.org/api/paging/).
