# Faster First Results and Selection Pre-warm (Pulse 1.9)

## 1. Overview
In Pulse 1.8.x, discovery runs required waiting for all collection sources (both citation graphs and slower full-text/keyword queries across Europe PMC, Semantic Scholar, CORE, and arXiv) to complete before any ranked cards appeared. Even with neural pre-computation, first results took 7–12 seconds cold.

Section 3 of Pulse 1.9 introduces two key enhancements:
1. **Earlier Preliminary Results Emission**: Emits the preliminary text-and-citation ranking immediately when fast citation branches (`citationGraph`, `citationNetwork`, `citationCoCitation`) finish, while slower keyword queries continue in the background. The frontend displays the first 100 ranked cards while sources are still collecting, without DOM disruption.
2. **Pre-warm on selection**: after a paper stays selected for 1.5 s, Pulse runs the search's own collection step in the background with the current discovery options (`_collectOnly`), then fills the embedding and cross-encoder caches for the exact shortlist the final ranking will use. A search started afterwards is served from cache. Guards: never during a live search, at most 10 per hour, skipped while OpenAlex is rate-limited or reports fewer than 300 credits left.

---

## 2. Benchmark Results

Measured on the 5 benchmark seeds from `mustfind.json` (200 results, Apple Silicon Mac, empty profile, persistent offline ranker, one run each, 14 October 2026). An earlier version of this table reported cold totals of 2.6–4.3 s; those runs were served from the 7-day HTTP cache and were not cold.

| | First results visible | First citation-based ordering | Full search |
|---|---|---|---|
| Cold (nothing cached) | 2.1–4.3 s (median 2.5) | 3.9–9.1 s (median 4.8) | 7.8–13.5 s (median 9.8) |
| After pre-warm completed | 0.0–2.0 s | 1.2–2.0 s | **2.2–3.8 s (median 2.9)** |

- Must-find papers in the top 20 / 50 / 200 were 14 / 21 / 54 in every run (unchanged from 1.8.x).
- Pre-warm itself runs the search's collection step and takes about 8–12 s in the background.
- OpenAlex cost: a cold search used about 17 credits; pre-warm followed by the search about 33. Pre-warm is therefore capped (10 per hour) and skipped when OpenAlex reports fewer than 300 credits left, or while it is rate-limited.
- Not yet measured: the handoff's 20-seed timing run (blocked by the OpenAlex daily allowance).

## 3. Implementation Details

### A. Preliminary Results Emission (`pulse_core/discovery.py`)
- Citation branches (`citationGraph`, `citationNetwork`, `citationCoCitation`) stream their candidates first.
- As soon as all enabled citation branches finish, `_run_discovery_pipeline` runs preliminary ranking (`merge_and_rank_pipeline_candidates(..., semantic_scores=None, crossencoder_scores=None)`) and emits an `on_progress` event with:
  - `stage` unchanged (`"collecting"` while sources are still answering)
  - `rankingPhase: "preliminary"`
  - `recommendations: preliminary_ranked[:100]`
  - `branchesExecuted`: citation branches completed so far
- As slower keyword sources (e.g. Europe PMC, CORE) finish, preliminary recommendations update at throttled intervals ($\ge 1.0$ s between events).
- The final neural ranking is computed exactly once over the complete candidate pool, ensuring determinism.

### B. Frontend Streaming Display (`local-web/pulse-frontend/js/part_02.js`)
- `updateDiscoverySearching(job)` inspects incoming `job.recommendations`.
- If the user has not yet interacted with results (`!state.discoveryUserTouchedRelevance`), recommendations are immediately adopted and rendered using existing DOM reconciliation (anchoring scroll position and focus).
- If the user has marked papers as relevant/not relevant, subsequent intermediate refinements are held in `state.discoveryPendingRefinedOrder`.
- Cache buster bumped in `index.html`: `js/part_02.js?v=ui-1.9-optimisation2`.

### C. Pre-warm via the real collection path (`pulse_core/discovery.py`)
- The frontend sends the paper plus the same options and relevance feedback that "Discover related" would use; it only pre-warms when that paper would be the search's single seed.
- `warm_paper_discovery(paper, options)` calls `_run_discovery_pipeline(..., _collectOnly=True)` with bridge mode off, so every request matches the later search and lands in the HTTP cache.
- Collect-only mode runs the shortlist probe on the collected pool and pre-computes embeddings and cross-encoder scores for exactly those papers, then returns without final ranking.
- Cancelled by any search start; at most one at a time; 10 per hour; skipped when OpenAlex is paused or its reported allowance (`X-RateLimit-Remaining`) is below 300.

### D. Review fixes (14 October)
- Early settling (stop waiting for long-tail sources once the citation-led top 50 is stable) had been removed; it is restored and now covered by a test.
- Preliminary updates are marked `rankingPhase: "preliminary"`; the stage stays "collecting" until every source has answered, so the UI no longer shows "Refining…" while sources are still searching.
- Streaming updates show the newest ranked order but keep papers already on screen.
