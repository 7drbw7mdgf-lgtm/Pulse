# Unreleased source changes

## Discovery ranking

- The default age-adjusted citation-velocity prior now contributes at most **9 score points out of 100**, scaled by topic relevance and the available citation-rate percentile. Papers with no topic support receive no bonus. Unknown or invalid citation counts/dates remain neutral, and the per-request opt-out still works.
- Automatic **Related** results occupy the top **40%** of the final deduplicated candidate pool, after sorting and diversity selection and before the display limit is applied. **Explore** covers the remaining candidates. The cutoff rounds up for small pools.
- **Strong match** retains its absolute evidence threshold, top-10% rank and support from at least two independent retrieval channels. Strong matches are part of the top-40% review band. Explicit Relevant / Not relevant judgements remain separate and take precedence.

These source changes follow the published 1.7.3 release. Match-strength metadata uses `evidence-v3` to distinguish the relative Related/Explore rule from previous classifications.
