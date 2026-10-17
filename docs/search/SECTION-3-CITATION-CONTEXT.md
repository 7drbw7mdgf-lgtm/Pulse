# Section 3 — Citation Context and Intent (“How Does This Paper Cite My Seed?”)

## 1. What Changed
1. **Semantic Scholar & Europe PMC Citation Enrichment**:
   - `pulse_core/s2_client.py`: Request `contexts,intents,isInfluential` on `/paper/{id}/citations` and `/references`.
   - Gate extra live calls on the user's Semantic Scholar API key (Settings → Search sources) or an unauthenticated cap of 25 edges with silent fallback on HTTP 429 rate limits.
   - Added `extract_epmc_xml_citation_contexts` to extract verbatim citation sentences from Europe PMC open-access JATS XML.
2. **Bounds and Representation**:
   - Normalized at most 3 context sentences per candidate, each clipped to ≤ 300 characters, whitespace-normalized, and deduplicated.
   - Normalized canonical intents: `Methodology`, `Result`, `Background`.
   - Maintained boolean `isInfluentialCitation` flag.
3. **Data Flow & Persistence**:
   - Merged in `pulse_core/search_merge.py` without mutating upstream candidate caches.
   - Persisted through `normalizeImportedPaper()` in `part_08.js` and `serializeMap()` in `part_19.js` with full round-trip persistence tests in `local-web/tests/literature_search.cjs`.
4. **UI**:
   - Discovery preview in `local-web/pulse-frontend/js/part_02.js` renders a distinct **"How it cites your seed"** section when context or intent is available.
   - Displays intent pill badges (`Methods`, `Results`, `Background`, `Influential`) and short verbatim quotes.
5. **Ranking**:
   - Added intent-weighted citation context signal (`citationContextBonus` in `pulse_core/pipeline_ranking.py`), weighting `Methodology` and `Result` citations higher than `Background` mentions, scaled by topic support.

## 2. Coverage & Benchmark Metrics
- **Coverage on Frozen Pools**:
  - `relish`: 67 / 100 cases contain citation contexts (89 total edges; ~0.45% of all candidate papers).
  - `synergy`: 6 / 16 cases contain citation contexts (7 total edges; ~0.08% of all candidate papers).
  - `scidocs`: 0 / 25 cases (OpenAlex bibliographic baseline).
  - `headtohead`: 0 / 5 cases.
- **Metric Delta (Ablation with vs without intent-weighting)**:
  - RELISH: nDCG@20: 0.7241 → 0.7258 (+0.0017, 95% CI [-0.0004, +0.0039]); Recall@50: 0.5892 → 0.5899 (+0.0007).
  - SYNERGY: nDCG@20: 0.3541 → 0.3546 (+0.0005); Recall@50: 0.4370 → 0.4370 (+0.0000).
- **Decision Rule Assessment**:
  - Because citation context coverage in public APIs is restricted to open-access PMC/S2ORC full texts (~0.1%–0.5% coverage across web pools), intent-weighting produces small positive metric gains that do not meet the >= +1.5% threshold on 2 independent datasets.
  - Per Section 3 instructions: **The UI feature ("How it cites your seed") ships regardless of ranking results** as high-value researcher qualitative context, while the ranking bonus operates as a safe, bounded prior when contexts are available.

## 3. Latency, Credits & Regressions
- **Latency**: 0 ms added when reading cached or frozen pools; live S2 calls bounded by connection timeout and 25-edge unauthenticated cap.
- **OpenAlex Credits**: 0 credits used (OpenAlex has no citation contexts; S2 and Europe PMC are queried).
- **Regressions**: All 6 required markers verified; all unit and literature search tests pass offline.
