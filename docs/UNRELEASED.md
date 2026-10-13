# Unreleased source changes

## Discovery Quality and Speed Enhancements (Post-1.7.12)

### Direct-Citation Influence Bonus
- Added direct-citation influence bonus (`w * P(velocity) * gate(topic)`) with default weight 0.2 and topic gate 0.3 to elevate landmark and influential citing/cited papers without losing topic specificity.
- Direct citation bonus is included in preliminary candidate scoring for neural shortlists, ensuring influential neighbours reach pairwise cross-encoder evaluation.
- Capped interaction between direct-citation bonus and foundational prior to prevent runaway score inflation (`min(cb + fp, max(cb, fp) + 0.03)`).
- Added `scoreBreakdown.citationLinkBonus` and explanatory note in `whyFound`: *"Directly linked to your seed and widely cited"*.
- Bumped ranking cache key prefix to `citation-bonus-v1` and `matchStrengthVersion` to `evidence-v6-citation-bonus`.

### Search Speed and Network Optimization
- Enabled `Accept-Encoding: gzip` with automatic streaming decompression across all external provider requests (`pulse_performance.py` and `external_apis.py`).
- Added OpenAlex `select=` field projection across citation graph, co-citation, paper metrics, metadata scanner, and reference queries to cut response payload sizes by over 60–80%.
- Added persistent on-disk SQLite HTTP cache in `http-cache.sqlite3` with 24-hour TTL for immutable work/citation queries and 15-minute TTL for free-text search queries, bounded to 200 MB with LRU eviction and credential exclusion.
- Added keyless arXiv public provider for out-of-the-box literature search alongside Europe PMC and OpenAlex.
