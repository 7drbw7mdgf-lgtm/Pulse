# Direct-Citation Influence Bonus

## 1. Motivation and Problem
In Pulse discovery runs prior to this change (v1.7.12), retrieval successfully collected all must-find papers (candidate pools of 835–1,800 records contained all 75 must-find papers across 5 benchmark seeds). However, ranking placed only 4–5 in the top 20, 13–15 in the top 50, and 39–43 in the top 200; the remaining 32–36 sat deep down at ranks 200–857.

Every must-find paper had a direct citation edge to the seed (`retrievalEvidence.channel` = `citations:N:forward` or `citations:N:backward`). Because text and semantic matching dominated scoring without sufficient credit for direct structural citation influence, foundational or landmark papers whose wording was broader than the seed sank behind narrower lexical matches.

## 2. Formulation
For candidate records with a direct citation link to any seed paper:

$$\text{bonus} = w \times P(\text{influence}) \times \text{gate}(\text{topic})$$

Where:
- **Influence metric (`velocity`)**:
  $$\text{velocity} = \ln\left(1 + \frac{\text{citations}}{\max(1, \text{current\_year} - \text{year} + 1)}\right)$$
  Citation velocity measures annual citation impact, preventing ancient low-impact papers from outscoring modern landmark papers.
- **Percentile ($P$)**:
  The percentile of the record's velocity calculated strictly among that seed's direct citation neighbours. When multiple seeds are used, the maximum percentile across the linked seeds is taken.
- **Topic Gate**:
  $$\text{gate}(\text{topic}) = \begin{cases} 1 & \text{if } \text{topic} \ge g \\ \frac{\text{topic}}{g} & \text{if } \text{topic} < g \end{cases}$$
  where $\text{topic} = \max(\text{textScore}, \text{semanticScore})$. This ensures papers completely irrelevant to the seed topic have their citation bonus smoothly attenuated.

## 3. Defaults and Options
- `w = 0.2` (`citationLinkWeight`, configurable via pipeline options)
- `g = 0.3` (`citationLinkGate`, configurable via pipeline options)
- `mode = 'velocity'` (`citationLinkMode`, supports `'velocity'` or `'cites'`)
- Enabled by default: `citationLinkBonus = True` (can be disabled via `citationLinkBonus: False`)

## 4. Pipeline Placement and Interaction Rules
1. **Post-Neural Placement**: The bonus is added after the neural blends so that it is not diluted by pairwise `.45/.55` re-ranking blends.
2. **Preliminary Shortlist Inclusion**: The bonus is included in the preliminary ranking score used to select candidates for neural shortlists (`SEMANTIC_SHORTLIST_LIMIT = 96`, `PAIRWISE_SHORTLIST_LIMIT = 48`), ensuring boosted direct citation neighbours reach the cross-encoder for pairwise verification.
3. **Foundational Prior Interaction**: When both direct citation bonus and `foundationalPrior` apply to the same record, they do not stack additively. The combined bonus is capped at:
   $$\min(cb + fp, \max(cb, fp) + 0.03)$$
4. **Negative Feedback / User Exclusions**: Explicit "Not relevant" feedback zero-outs the citation link bonus.
5. **Missing Citation Counts**: Records with missing citation counts receive no bonus (they are neither assigned zero percentile nor median).
6. **Explainability**: Recorded under `scoreBreakdown.citationLinkBonus` and adds a plain-language reason to `whyFound`: *"Directly linked to your seed and widely cited"*.

## 5. Circularity Caveat and Independent Validation
- **Circularity Caveat**: In the head-to-head benchmark (`mustfind.json`), the must-find paper set is defined as each seed's most-cited direct neighbours (10 citing + 5 cited, OpenAlex). Because the citation bonus rewards highly cited direct neighbours, the head-to-head benchmark is partly circular with this ranking change.
- **Independent Validation**: To ensure this bonus does not degrade general retrieval and ranking quality, two independent non-circular benchmarks are maintained:
  1. **DBEF Frozen Benchmark (`tools/benchmark_dbef.py`)**: Evaluates condensed nDCG@10/@20 and known-paper recall on frozen multi-source pools.
  2. **Research Benchmark (`tools/benchmark_research.py`)**: Replays 40 diverse research queries (including 20 biomedical cases with SciFact human annotations) where no direct seed citation edges exist.
