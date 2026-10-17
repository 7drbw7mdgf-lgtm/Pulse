# Section 2 — Instant Relevance Re-ranking in the Review Queue

## Summary
Implemented `< 10 ms` client-side Rocchio / contrastive relevance re-ranking in [`discovery-review.js`](../../local-web/pulse-frontend/js/discovery-review.js) and [`part_02.js`](../../local-web/pulse-frontend/js/part_02.js), using the exact same structured + lexical feature definition as [`discovery_feedback.py`](../../local-web/pulse-backend/pulse_core/discovery_feedback.py).

When a reviewer marks a paper **Relevant** (`r`) or **Not relevant** (`n`):
1. **Prefix & visual invariance**: The judged row and every row above it (`0 .. belowIndex`, plus any higher match-strength tier) remain completely stationary. Session-judged rows stay in the active `To review` queue until the user switches queues or reopens the modal, preserving scroll offset, selected row, and keyboard focus.
2. **Subtle status note**: The existing header count (`#discoveryCountSummary`) and footer hint (`#discoveryFooterNote`) display `N moved up` in place without adding banners or shifting layout.
3. **Unified feature space (client & server parity)**: Both [`discovery-review.js`](../../local-web/pulse-frontend/js/discovery-review.js) and [`discovery_feedback.py`](../../local-web/pulse-backend/pulse_core/discovery_feedback.py) extract:
   - Unigrams and bigrams from title, abstract, and keywords
   - Shared references (`ref:<id>`) and DBEF seed pivots (`pivot:<seed>`)
   - Co-citation and citation-graph channels (`cite:backward`, `cite:forward`, `cite:cocited`, `cite:coupled`, `cite:chase`, `cocite:<id>`)
   - Normalized concepts (`concept:<phrase>`) from `paperKeywords`, `matchedConcepts`, and `sharedConcepts`
   - Author surnames (`author:<surname>`) and publication venue (`venue:<normalized_venue>`)
4. **Latency**: With pre-warmed feature sets on modal open (`warmDiscoveryFeedbackFeatures`), re-ranking 2,000 candidates completes in **~6.4 ms** in Node/V8 and **~4.2 ms** in Python (well under the 10 ms budget).

---

## SYNERGY Active-Screener Simulation (16 Systematic Reviews)

Starting from each review's seed paper(s) on the frozen Section 0 SYNERGY pools (`synergy_pools.json.gz`, $N = 16$ systematic reviews), the simulated screener labels the top-ranked unjudged candidate at step $t$ with its ground-truth SYNERGY inclusion label (`2` if included, `0` if excluded) and immediately re-ranks all candidates below index $t$:

| Mode | Recall@10 | Recall@20 | Recall@50 | WSS@95 |
| :--- | :---: | :---: | :---: | :---: |
| **Static baseline (no re-ranking)** | 0.1639 | 0.2437 | 0.3860 | 0.3047 |
| **After 5 feedback clicks (`clicks_5`)** | 0.1749 (+0.0110) | 0.2418 (-0.0019) | 0.3955 (+0.0095) | 0.3093 (+0.0046) |
| **After 10 feedback clicks (`clicks_10`)** | **0.1762 (+0.0123)** | 0.2569 (+0.0132) | 0.4370 (+0.0510) | 0.3106 (+0.0059) |
| **After 20 feedback clicks (`clicks_20`)** | **0.1762 (+0.0123)** | **0.2688 (+0.0251)** | 0.4389 (+0.0529) | 0.2917 (-0.0130) |
| **Continuous active screening (`continuous`)** | **0.1762 (+0.0123)** | **0.2688 (+0.0251)** | **0.4583 (+0.0723)** | **0.3391 (+0.0344)** |

### Key Takeaways
- **Recall@50 improves by +5.10 percentage points after 10 clicks** (`0.3860 -> 0.4370`) and **+7.23 percentage points under continuous active screening** (`0.3860 -> 0.4583`).
- **Recall@20 improves by +2.51 percentage points after 20 clicks** (`0.2437 -> 0.2688`).
- **Work Saved over Sampling at 95% recall (`WSS@95`) improves by +3.44 percentage points** (`0.3047 -> 0.3391`) under continuous active screening.
