# Faster First Results and Selection Pre-warm (Pulse 1.9)

## 1. Overview
In Pulse 1.8.x, discovery runs required waiting for all collection sources (both citation graphs and slower full-text/keyword queries across Europe PMC, Semantic Scholar, CORE, and arXiv) to complete before any ranked cards appeared. Even with neural pre-computation, first results took 7–12 seconds cold.

Section 3 of Pulse 1.9 introduces two key enhancements:
1. **Earlier Preliminary Results Emission**: Emits the preliminary text-and-citation ranking immediately when fast citation branches (`citationGraph`, `citationNetwork`, `citationCoCitation`) finish, while slower keyword queries continue in the background. The frontend smoothly displays the first 100 ranked cards (stage: `"refining"`) without DOM disruption.
2. **Fuller Selection Pre-warm with Request Cap**: When a user selects a paper in the library or discovery map (after a 1.5-second dwell time), Pulse pre-fetches the seed's citing works, references, DBEF pivots, co-citation lookups, and first-page keyword queries, and pre-computes neural embeddings and cross-encoder scores for the top shortlist. A strict request cap (`PREWARM_REQUEST_CAP = 12`) prevents credit exhaustion.

---

## 2. Benchmark Results

Evaluated across the 5 benchmark seeds from `mustfind.json`:

| Seed | Topic | Cold First Visible (s) | Cold Total (s) | Pre-warmed Total (s) | Pre-warmed Retrieval (s) | Deterministic Equivalence |
|---|---|:---:|:---:|:---:|:---:|:---:|
| Seed 0 | *C. jejuni* Outer Membrane Vesicles | 1.67 | 3.86 | 2.61 | 1.93 | Byte-identical |
| Seed 1 | Host Epithelial Cell Invasion | 2.02 | 4.06 | 3.05 | 2.04 | Byte-identical |
| Seed 2 | Host Immunity & Cellular Responses | 2.47 | 3.84 | 2.40 | 1.73 | Byte-identical |
| Seed 3 | Bacterial OMVs in GI Tract | 2.86 | 4.30 | 2.42 | 1.74 | Byte-identical |
| Seed 4 | OMV Biogenesis, Functions & Issues | 1.54 | 2.56 | 1.86 | 1.36 | Byte-identical |

### Summary Statistics
- **Cold First Results Visible**:
  - **Median**: **2.02 s** (Target: $\le 6.0$ s) — **Passed by 3.98 s**
  - **Max**: **2.86 s**
- **Pre-warmed Full Search**:
  - **Median**: **2.42 s** (Target: $\le 3.0$ s) — **Passed by 0.58 s**
  - **Max**: **3.05 s**
- **Deterministic Equivalence**: **100% byte-identical** candidates and ranking scores.

---

## 3. Implementation Details

### A. Preliminary Results Emission (`pulse_core/discovery.py`)
- Citation branches (`citationGraph`, `citationNetwork`, `citationCoCitation`) stream their candidates first.
- As soon as all enabled citation branches finish, `_run_discovery_pipeline` runs preliminary ranking (`merge_and_rank_pipeline_candidates(..., semantic_scores=None, crossencoder_scores=None)`) and emits an `on_progress` event with:
  - `stage: "refining"`
  - `rankingPhase: "refining"`
  - `recommendations: preliminary_ranked[:100]`
  - `branchesExecuted`: citation branches completed so far
- As slower keyword sources (e.g. Europe PMC, CORE) finish, preliminary recommendations update at throttled intervals ($\ge 1.0$ s between events).
- The final neural ranking is computed exactly once over the complete candidate pool, ensuring determinism.

### B. Frontend Streaming Display (`local-web/pulse-frontend/js/part_02.js`)
- `updateDiscoverySearching(job)` inspects incoming `job.recommendations`.
- If the user has not yet interacted with results (`!state.discoveryUserTouchedRelevance`), recommendations are immediately adopted and rendered using existing DOM reconciliation (anchoring scroll position and focus).
- If the user has marked papers as relevant/not relevant, subsequent intermediate refinements are held in `state.discoveryPendingRefinedOrder`.
- Cache buster bumped in `index.html`: `js/part_02.js?v=ui-1.9-faster-first`.

### C. Fuller Selection Pre-warm (`pulse_core/discovery.py`)
- `warm_paper_discovery(paper)` expands beyond references and DBEF pivots to also pre-fetch:
  1. Citing works (`cites:W...`, sorted by `cited_by_count:desc`)
  2. Top references (up to 50)
  3. DBEF pivots (`cites:ref_W...`)
  4. Co-citations (co-cited references from citing papers)
  5. First-page keyword queries with `expected_quota = max(20, min(2000, (candidate_limit(200) + max(1, len(plan)) - 1) // max(1, len(plan))))` to guarantee exact HTTP cache hit on search launch.
- Pre-computes neural embeddings for top 64 candidates and cross-encoder scores for top 32 candidates.
- Bounded by `PREWARM_REQUEST_CAP = 12` via `REQUEST_CONTEXT.request_counter`, absorbing `DiscoveryBudgetExceeded` gracefully.
- Respects `_ACTIVE_SEARCHES`, 1.5 s dwell, and `_WARM_CANCEL`.
