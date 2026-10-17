# Section 1 — Senior-Author Trajectory Channel

## 1. Summary of Changes

1. **Retrieval Branch (`authorTrajectory` in `local-web/pulse-backend/pulse_core/discovery.py`)**:
   - Reuses the already-resolved OpenAlex work (`openalex_work_for_paper`) for each seed paper (0 extra seed-lookup requests).
   - Extracts the OpenAlex author IDs of the seed's **first** and **last** authors via `extract_seed_trajectory_authors(work, paper)`.
   - **Alphabetical-field safeguard**: In fields/subfields that use alphabetical author order (`Mathematics`, `Physics and Astronomy`, `Theoretical Computer Science`, `Discrete Mathematics and Combinatorics`, `Mathematical Physics`, `Algebra and Number Theory`, `Geometry and Topology`, `High Energy Physics`), the last author is **not** treated as senior unless OpenAlex explicitly marks `is_corresponding: True` on that authorship.
   - **Merged-identity safeguard**: Skips any author with $> 300$ works per year (`_author_exceeds_annual_cap`, checked against author summary counts, `meta.count > 300 * years`, and per-year result counts).
   - Queries recent works (default: last 3 years) with `filter=author.id:A...,from_publication_date:YYYY-01-01,primary_topic.id:T...` (falling back to `primary_topic.field.id:F...`), sorted by `publication_date:desc`, trimmed with `select=OPENALEX_WORK_SELECT`, keeping at most 5 non-seed works per author.
   - Records `retrievalEvidence` with channel `author:<seedIndex>:first` or `author:<seedIndex>:last` and labels results **“Same senior author”** or **“Same first author”** (never “same lab”).
   - Included in `warm_paper_discovery` pre-warm under the existing hourly cap (`PREWARM_MAX_PER_HOUR = 10`) and OpenAlex allowance guard (`PREWARM_MIN_OPENALEX_ALLOWANCE = 300`).

2. **Ranking (`local-web/pulse-backend/pulse_core/pipeline_ranking.py`)**:
   - Uses `author:<seed>:<first|last>` purely as an RRF retrieval channel (no fixed score bonus), as validated by the Section 0 ablation where a `+5.0` fixed score bonus hurt `synergy` `nDCG@10` (`-0.0123`) and `headtohead` `nDCG@20` (`-0.0435`), whereas pure RRF retrieval evidence improved `relish` and `synergy` with zero regressions.
   - Surfaces `Same senior author` (`kind: 'senior-author'`) and `Same first author` (`kind: 'first-author'`) in `why_found()` and propagates `authorRole`, `authorTrajectoryLabel`, and `authorTrajectoryName` when duplicates merge across branches or versions.

3. **UI & Persistence (`part_02.js`, `part_08.js`, `part_19.js`)**:
   - Displays the **Same senior author** / **Same first author** badge in `.dv-reasons` (`.dv-reason.is-author-trajectory`) in each discovery row and in `.dv-preview-badges` (`.dv-badge.dv-author-trajectory`) in the paper preview.
   - Adds the **Same senior or first author** filter chip (`data-dv-why="author-trajectory"`) in `#discoveryWhyFilters`.
   - Persists `authorRole`, `authorTrajectoryLabel`, and `authorTrajectoryName` in both `serializeMap()` (`js/part_19.js`) and `normalizeImportedPaper()` (`js/part_08.js`), verified by round-trip assertions in `local-web/tests/literature_search.cjs`.

---

## 2. Independent Benchmark Evaluation (146 Frozen Pools)

Evaluated offline via `tools/benchmark_independent.py` on the Section 0 frozen pools (`random_seed = 20261017`, 2,000 bootstrap resamples).

### Primary Metrics (`baseline_1_9_0` vs `sec1_author_trajectory`)

| Dataset | Seeds | Variant | nDCG@10 | nDCG@20 | Recall@50 | Recall@200 | RecentRecall@50 ($\ge 2024$) | RecentRecall@200 ($\ge 2024$) | MRR |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **RELISH** | 100 | `baseline_1_9_0` | `0.4090` | `0.3887` | `0.3358` | `0.5060` | `0.2335` | `0.3376` | `0.6556` |
| **RELISH** | 100 | `sec1_author_trajectory` | **`0.4227`** | **`0.4007`** | **`0.3437`** | **`0.5174`** | **`0.2573`** | **`0.3704`** | **`0.6763`** |
| **RELISH $\Delta$** | 100 | Paired $\Delta$ `[95% CI]` | **`+0.0137`** `[+0.0054, +0.0238]` | **`+0.0120`** `[+0.0046, +0.0209]` | **`+0.0079`** `[+0.0033, +0.0133]` | **`+0.0114`** `[+0.0063, +0.0172]` | **`+0.0238`** `[+0.0095, +0.0385]` | **`+0.0328`** `[+0.0167, +0.0516]` | **`+0.0207`** `[+0.0064, +0.0398]` |
| **SYNERGY** | 16 | `baseline_1_9_0` | `0.3772` | `0.3468` | `0.3125` | `0.5426` | `0.0681` | `0.2660` | `0.5947` |
| **SYNERGY** | 16 | `sec1_author_trajectory` | `0.3774` | `0.3472` | **`0.3177`** | **`0.5504`** | **`0.0750`** | **`0.2729`** | `0.5947` |
| **SYNERGY $\Delta$** | 16 | Paired $\Delta$ `[95% CI]` | `+0.0002` `[-0.0053, +0.0054]` | `+0.0004` `[-0.0033, +0.0044]` | **`+0.0052`** `[+0.0000, +0.0156]` | **`+0.0079`** `[+0.0007, +0.0197]` | `+0.0069` `[+0.0000, +0.0208]` | `+0.0069` `[+0.0000, +0.0208]` | `+0.0000` |
| **SciDocs (Non-biomed)** | 25 | `baseline_1_9_0` | `0.7336` | `0.7429` | `0.8180` | `0.8400` | `0.1500` | `0.1500` | `0.8808` |
| **SciDocs (Non-biomed)** | 25 | `sec1_author_trajectory` | `0.7310` | `0.7406` | `0.8180` | `0.8400` | `0.1500` | `0.1500` | `0.8790` |
| **SciDocs $\Delta$** | 25 | Paired $\Delta$ `[95% CI]` | `-0.0026` `[-0.0158, +0.0110]` | `-0.0023` `[-0.0114, +0.0074]` | `+0.0000` | `+0.0000` | `+0.0000` | `+0.0000` | `-0.0018` |
| **Head-to-Head (5-seed)** | 5 | `baseline_1_9_0` | `0.5515` | `0.4836` | `0.5900` | `0.6929` | `1.0000` | `1.0000` | `0.7833` |
| **Head-to-Head (5-seed)** | 5 | `sec1_author_trajectory` | `0.5515` | `0.4836` | `0.5900` | `0.6929` | `1.0000` | `1.0000` | `0.7833` |

### Why Fixed Score Bonus (`sec1_author_trajectory_bonus`) Was Rejected

Adding a fixed `+5.0` score bonus to `authorTrajectory` candidates (`sec1_author_trajectory_bonus`) degraded `synergy` `nDCG@10` by `-0.0123` (`0.3772 -> 0.3649`), `MRR` by `-0.0308` (`0.5947 -> 0.5639`), and `headtohead` `nDCG@20` by `-0.0435` (`0.4836 -> 0.4401`), because recent papers by the same author that only tangentially relate to a systematic review's inclusion criteria were promoted above high-BM25/co-citation papers. Keeping `authorTrajectory` as an RRF retrieval channel (`sec1_author_trajectory`) lets BM25 and citation evidence gate its top-10 placement while surfacing recent follow-ups.

---

## 3. Cost & Latency

- **OpenAlex API calls**: At most **2 calls per seed** (1 for first author, 1 for senior author; 1 call in alphabetical fields without corresponding-author metadata). Seed OpenAlex work resolution is shared with `citationGraph` / `citationNetwork` / `citationCoCitation`.
- **Empirical OpenAlex calls across the 146 benchmark seeds**: 1.72 calls/seed on average (251 calls across 146 seeds), yielding 743 recent candidate records after deduplication.
- **Ranking latency**: Mean offline ranking latency per seed is `21.2 ms` (`baseline_1_9_0`) vs `21.6 ms` (`sec1_author_trajectory`, `+0.4 ms`).
