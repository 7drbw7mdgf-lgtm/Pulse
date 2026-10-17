# Independent Discovery Benchmark (v1.9.0 Baseline & Controlled Ablations)

## 1. Purpose & Motivation

Prior to `v1.9.0`, discovery quality was evaluated primarily against the 5-seed OMV Head-to-Head benchmark (`~/Pulse-release/headtohead/mustfind.json`). Because `mustfind.json` was constructed partly from citation-linked papers, evaluating citation-weighted ranking changes on it alone risks circularity.

This benchmark (`tools/benchmark_independent.py`) establishes an **offline, multi-dataset evaluation suite** across **141 independent cases** (plus the 5-seed Head-to-Head set as a secondary check) on **frozen candidate pools** so that every retrieval and ranking change in the Discovery A+ roadmap is tested as a controlled ablation on identical inputs with paired 95% bootstrap confidence intervals.

---

## 2. Datasets, Sampling & Licences

All datasets were sampled deterministically with fixed random seed **`20261017`**. To keep the git repository lean and respect third-party redistribution terms, raw datasets and frozen candidate pools are stored outside the repository under `/Users/lshpk18/Pulse-release/headtohead/`:

| Dataset | Domain | Cases | Ground Truth | Source & Licence | Storage Location |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **RELISH** (`relish`) | Biomedical (PubMed) | **100** | Author-judged paper-to-paper relevance (`grade = 2` relevant, `grade = 1` partial, `grade = 0` irrelevant); average **31.7** relevant papers per seed | Brown et al. (2019), *PLOS Biology*, Figshare `7722905` — **CC0 1.0 Public Domain** | `/Users/lshpk18/Pulse-release/headtohead/frozen_pools/relish_pools.json.gz` |
| **SYNERGY** (`synergy`) | Biomedical systematic reviews | **16** | Systematic review screening inclusions (`label_included = 1`, seeded with 3 randomly chosen included papers per review; remaining included papers are ground-truth positives, average **46.4** positives per review) | De Bruin et al. (2023), `asreview/synergy-dataset` — **CC0 1.0 Public Domain** | `/Users/lshpk18/Pulse-release/headtohead/frozen_pools/synergy_pools.json.gz` |
| **SciDocs Non-Biomedical** (`scidocs`) | Computer Science (16), Engineering (5), Psychology (2), Mathematics (1), Decision Sciences (1) | **25** | Co-citation & co-view ground-truth relevance (`grade = 1` positive, `grade = 0` negative; $\ge 10$ positive papers per seed) | Cohan et al. (2020), *ACL*, `allenai/scidocs` — **CC-BY-SA 4.0 / ODC-By 1.0** | `/Users/lshpk18/Pulse-release/headtohead/frozen_pools/scidocs_pools.json.gz` |
| **Head-to-Head** (`headtohead`) | Extracellular vesicles / OMV (secondary check) | **5** | 15 curated `mustFind` papers per seed (75 total) | Internal benchmark (`mustfind.json`) — **Secondary check only** | `/Users/lshpk18/Pulse-release/headtohead/frozen_pools/headtohead_pools.json.gz` |

### Sampling Protocol (`random_seed = 20261017`)
1. **RELISH**: Filtered `RELISH_v1.json` to seeds with $\ge 5$ judged-relevant (`grade = 2`) papers, sorted by PMID, and drew 100 seeds via `random.Random(20261017).sample(...)`.
2. **SYNERGY**: Selected all 16 systematic reviews in `asreview/synergy-dataset` having $\ge 12$ included PMIDs and $\ge 50$ excluded PMIDs (excluding `Moran_2021` in favour of `Moran_2021_corrected`). For each review, drew 3 seed PMIDs via `random.Random(20261017).sample(inc_pmids, 3)` and held out the remaining included PMIDs as positives.
3. **SciDocs Non-Biomedical**: Filtered `scidocs` `cocite` and `coview` splits to seeds with $\ge 10$ positive papers whose OpenAlex `primary_topic.field` is non-biomedical (`Computer Science`, `Engineering`, `Mathematics`, `Decision Sciences`, `Psychology`) and sampled 25 seeds with `random.Random(20261017)`.

---

## 3. Frozen Candidate Pools & OpenAlex Credit Budget

Each frozen case stores the exact inputs required by `merge_and_rank_pipeline_candidates` in `local-web/pulse-backend/pulse_core/pipeline_ranking.py`:
- `seed_papers`: resolved seed metadata (`pmid`, `doi`, `openAlexId`, `title`, `abstract`, `authors`, `year`, `journal`, `citationCount`, `referenceIds`, `paperKeywords`, `field`).
- `candidates_by_branch`:
  - `citationGraph`: 1-hop forward and backward citations with `retrievalEvidence` (`citations:<seed_idx>:forward`, `citations:<seed_idx>:backward`).
  - `citationCoCitation`: co-cited works across citing papers with `coCitationCount`, `coCitationSimilarity`, and `seedIndices`.
  - `citationNetwork`: DBEF content + specificity scored bibliographic coupling candidates (`dbef` payload, `sharedReferenceIds`, `velocityFactor`, `contentSimilarity`).
  - `authorTrajectory`: first and senior author trajectory works (excluded in `baseline`, included in Section 1 ablations).
- `network_assessments`: full DBEF assessment dictionary (`assessed_overlap`, `assessed_zero`, `unassessed`) attached to `SearchResults.network_assessments`.
- `citation_contexts`: extracted citing sentences ($\le 3$ sentences, each $\le 300$ chars), section-derived intents (`methodology`, `result`, `background`), and `isInfluential` flags.
- `qrels`: ground-truth relevance grades (`0`, `1`, `2`) and publication years.

### OpenAlex Credit Conservation Log
To respect the OpenAlex daily budget, pool construction combined **0-credit** OpenAlex singleton lookups (`/works/pmid:...`, `/works/https://doi.org/...`, `/works/W...`, `/authors/A...`), **0-credit** batched NIH iCite + Europe PMC lookups for biomedical PMIDs, DBLP/Crossref title resolution for non-biomedical seeds, and bounded **1-credit** OpenAlex filter queries:

- **Total OpenAlex filter credits consumed across all 146 pools**: **45 credits** (16 credits for RELISH + SYNERGY + Head-to-Head; 29 credits for the 25 SciDocs non-biomedical pools).
- **0-credit OpenAlex singleton calls**: **794 calls**.
- **Remaining OpenAlex daily credits after pool freeze**: **94 credits**.

---

## 4. Metrics & Decision Rule

For each seed and dataset, `tools/benchmark_independent.py` reports:
- **`nDCG@10`**, **`nDCG@20`**: standard normalized discounted cumulative gain (unjudged candidates treated as grade `0`).
- **`condensed_nDCG@10`**, **`condensed_nDCG@20`** (Sakai 2007): nDCG computed over judged candidates only, measuring ranking quality among known relevant vs. known irrelevant papers independent of pool completeness.
- **`Recall@20`**, **`Recall@50`**, **`Recall@200`**: fraction of all ground-truth relevant papers recovered in the top $K$.
- **`RecentRecall@50`**, **`RecentRecall@200`**: fraction of ground-truth relevant papers from the most recent 2 years of the case's publication window recovered in the top $K$.
- **`MRR`**: Mean Reciprocal Rank of the first relevant paper.
- **`rankingMs`**: wall-clock execution time of `merge_and_rank_pipeline_candidates` per case (milliseconds).

All dataset means and paired variant deltas (`variant - baseline`) are accompanied by **95% percentile bootstrap confidence intervals** over seeds (`2,000` resamples, `bootstrap_seed = 20261017`).

### Decision Rule (Sections 1–4)
A ranking change is eligible to become the default only if:
1. **No regression**: On each independent dataset (`relish`, `synergy`, `scidocs`), neither `nDCG@20` nor `Recall@50` falls by more than its 95% CI half-width; and
2. **Statistically significant improvement**: On at least one independent dataset, `nDCG@20` or `Recall@50` improves with a paired 95% bootstrap CI that excludes zero ($\text{CI}_{\text{low}} > 0$).

The 5-seed `headtohead` set is reported separately as a secondary check.

---

## 5. v1.9.0 Baseline Results (`origin/main` @ `148c214`)

Values are `mean ± 95% CI half-width` (`[ci_low, ci_high]`):

| Metric | RELISH ($n=100$) | SYNERGY ($n=16$) | SciDocs Non-Biomed ($n=25$) | Head-to-Head ($n=5$, secondary) |
| :--- | :---: | :---: | :---: | :---: |
| **`nDCG@10`** | `0.3287 ± 0.0391` (`[0.2897, 0.3679]`) | `0.2633 ± 0.1168` (`[0.1530, 0.3865]`) | `0.0656 ± 0.0396` (`[0.0276, 0.1068]`) | `0.4244 ± 0.1922` (`[0.2654, 0.6497]`) |
| **`nDCG@20`** | `0.2908 ± 0.0310` (`[0.2600, 0.3219]`) | `0.2287 ± 0.0910` (`[0.1400, 0.3220]`) | `0.0770 ± 0.0386` (`[0.0389, 0.1162]`) | `0.4413 ± 0.1292` (`[0.3279, 0.5863]`) |
| **`condensed_nDCG@10`** | `0.8853 ± 0.0336` (`[0.8500, 0.9172]`) | `0.5826 ± 0.1324` (`[0.4536, 0.7183]`) | `0.8000 ± 0.1400` (`[0.6400, 0.9200]`) | `1.0000 ± 0.0000` (`[1.0000, 1.0000]`) |
| **`condensed_nDCG@20`** | `0.9162 ± 0.0306` (`[0.8824, 0.9437]`) | `0.6256 ± 0.1136` (`[0.5145, 0.7417]`) | `0.8000 ± 0.1400` (`[0.6400, 0.9200]`) | `1.0000 ± 0.0000` (`[1.0000, 1.0000]`) |
| **`Recall@20`** | `0.1219 ± 0.0142` (`[0.1080, 0.1364]`) | `0.0966 ± 0.0529` (`[0.0482, 0.1539]`) | `0.0827 ± 0.0360` (`[0.0467, 0.1187]`) | `0.4533 ± 0.0867` (`[0.3733, 0.5467]`) |
| **`Recall@50`** | `0.2033 ± 0.0210` (`[0.1829, 0.2248]`) | `0.1564 ± 0.0854` (`[0.0785, 0.2493]`) | `0.1267 ± 0.0533` (`[0.0760, 0.1827]`) | `0.6267 ± 0.0533` (`[0.5733, 0.6800]`) |
| **`Recall@200`** | `0.2907 ± 0.0283` (`[0.2624, 0.3189]`) | `0.2983 ± 0.1304` (`[0.1773, 0.4381]`) | `0.1884 ± 0.0597` (`[0.1307, 0.2501]`) | `0.7333 ± 0.0533` (`[0.6800, 0.7867]`) |
| **`RecentRecall@50`** | `0.2335 ± 0.0404` (`[0.1932, 0.2739]`) | `0.0900 ± 0.1096` (`[0.0000, 0.2192]`) | `0.4750 ± 0.2250` (`[0.2500, 0.7000]`) | `0.9667 ± 0.0500` (`[0.9000, 1.0000]`) |
| **`RecentRecall@200`** | `0.3376 ± 0.0485` (`[0.2905, 0.3875]`) | `0.1527 ± 0.1287` (`[0.0417, 0.2994]`) | `1.0000 ± 0.0000` (`[1.0000, 1.0000]`) | `1.0000 ± 0.0000` (`[1.0000, 1.0000]`) |
| **`MRR`** | `0.6556 ± 0.0740` (`[0.5792, 0.7272]`) | `0.4718 ± 0.1900` (`[0.2874, 0.6673]`) | `0.1855 ± 0.1107` (`[0.0807, 0.3022]`) | `0.6500 ± 0.2500` (`[0.4000, 0.9000]`) |
| **`rankingMs`** | `212.5 ± 7.9 ms` | `299.4 ± 19.7 ms` | `163.0 ± 8.4 ms` | `174.1 ± 7.4 ms` |

---

## 6. Controlled Ablation Summary (Sections 1 & 3 Preview)

| Variant | Dataset | $\Delta\text{nDCG@20}$ (95% CI) | $\Delta\text{Recall@50}$ (95% CI) | $\Delta\text{RecentRecall@50}$ (95% CI) | Decision Rule |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **`sec1_author_trajectory`** (RRF channel only, no fixed bonus) | `relish` ($n=100$) | **`+0.0120`** (`[+0.0046, +0.0209]`) | **`+0.0079`** (`[+0.0033, +0.0133]`) | **`+0.0238`** (`[+0.0095, +0.0385]`) | **PASS** (`relish` $\text{nDCG@20}$ and $\text{Recall@50}$ CIs exclude 0; no dataset regresses beyond CI) |
| | `synergy` ($n=16$) | `+0.0004` (`[-0.0033, +0.0044]`) | `+0.0052` (`[+0.0000, +0.0156]`) | `+0.0069` (`[+0.0000, +0.0208]`) | |
| | `scidocs` ($n=25$) | `-0.0023` (`[-0.0084, +0.0031]`) | `+0.0000` (`[+0.0000, +0.0000]`) | `+0.0000` (`[+0.0000, +0.0000]`) | |
| | `headtohead` ($n=5$) | `-0.0327` (`[-0.0572, -0.0076]`) | `+0.0000` (`[+0.0000, +0.0000]`) | `+0.0000` (`[+0.0000, +0.0000]`) | |
| **`sec1_author_trajectory_bonus`** (+5.0 fixed score bonus) | `relish` ($n=100$) | `+0.0207` (`[+0.0110, +0.0315]`) | `+0.0116` (`[+0.0061, +0.0176]`) | `+0.0355` (`[+0.0173, +0.0548]`) | **Not adopted over pure RRF** (causes `-0.0123` `nDCG@10` / `-0.0308` `MRR` drop on `synergy` and `-0.0435` `nDCG@20` on `headtohead`) |
| | `synergy` ($n=16$) | `-0.0038` (`[-0.0106, +0.0022]`) | `+0.0059` (`[+0.0000, +0.0170]`) | `+0.0114` (`[+0.0000, +0.0298]`) | |
| | `scidocs` ($n=25$) | `-0.0027` (`[-0.0091, +0.0032]`) | `-0.0013` (`[-0.0120, +0.0080]`) | `+0.0500` (`[+0.0000, +0.1500]`) | |
| | `headtohead` ($n=5$) | `-0.0435` (`[-0.0809, -0.0104]`) | `+0.0000` (`[+0.0000, +0.0000]`) | `+0.0000` (`[+0.0000, +0.0000]`) | |
| **`sec3_citation_intent`** (Methods/Results +2.5, Influential +1.5) | `relish` ($n=100$) | `+0.0038` (`[+0.0012, +0.0063]`) | `+0.0007` (`[-0.0007, +0.0020]`) | `+0.0010` (`[-0.0042, +0.0069]`) | **PASS (small effect due to sparse OA XML coverage: 96/146 pools)** |
| | `synergy` ($n=16$) | `+0.0032` (`[-0.0023, +0.0093]`) | `+0.0000` (`[+0.0000, +0.0000]`) | `+0.0000` (`[+0.0000, +0.0000]`) | |
| | `scidocs` ($n=25$) | `-0.0001` (`[-0.0009, +0.0006]`) | `-0.0013` (`[-0.0120, +0.0080]`) | `+0.0500` (`[+0.0000, +0.1500]`) | |
| | `headtohead` ($n=5$) | `-0.0062` (`[-0.0225, +0.0044]`) | `+0.0000` (`[+0.0000, +0.0000]`) | `+0.0000` (`[+0.0000, +0.0000]`) | |

---

## 7. How to Rerun

### 1. Run Offline Benchmark Harness (0 Network Calls)
```bash
/opt/homebrew/bin/python3 tools/benchmark_independent.py \
  --pools-dir /Users/lshpk18/Pulse-release/headtohead/frozen_pools \
  --output /Users/lshpk18/Pulse-release/headtohead/independent_benchmark_1.9.0.json
```

### 2. Run Offline Unit Tests (0 Network Calls)
```bash
/opt/homebrew/bin/python3 -m unittest local-web/tests/test_benchmark_independent.py -v
```

### 3. Rebuild Frozen Pools (Resumable, Rate-Limited)
If `/Users/lshpk18/Pulse-release/headtohead/frozen_pools/*.json.gz` are removed and need to be rebuilt from `/Users/lshpk18/Pulse-release/headtohead/datasets/`:
```bash
/opt/homebrew/bin/python3 /Users/lshpk18/Pulse-release/headtohead/tools/build_independent_pools.py
```
