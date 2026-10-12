# DBEF ranking benchmark

The DBEF ranking benchmark evaluates shared-reference scoring, missing-data imputation, and citation retrieval channels across frozen pools without live networking or non-deterministic API variation.

## Test Sets & Provenance

1. **Curated Benchmark (`benchmarks/dbef-frozen-pool.json`):**
   - 24 declared papers across three scientific topics (neural/lexical retrieval, citation networks, open access).
   - Resolves 23 papers with frozen Crossref/DataCite records and OpenAlex fallback bibliographies.
   - Ground truth tagged by temporal relationship: `ancestor` (pre-seed) vs. `contemporary` (co-seed or later).

2. **Head-to-Head Benchmark (`benchmarks/headtohead-frozen-pool.json`):**
   - 5 seed papers with 15 must-find papers per seed (75 target evaluations total).
   - Encodes direct citation paths (`citationGraph:forward`, `citationGraph:backward`), co-citation (`citationCoCitation`), and coupling (`dbef`).

## Summary of Results

Evaluation compares baseline batch-max scaling against seed-derived calibration and three-state network evidence:

| Dataset | Metric | Baseline Off | Baseline On | Calibrated Off | Calibrated On |
| :--- | :--- | :---:| :---:| :---:| :---:|
| **Curated (3 cases)** | nDCG@10 | 0.1724 | 0.1992 | 0.1724 | **0.2056** |
| | nDCG@20 | 0.1969 | 0.2225 | 0.1969 | **0.2310** |
| | condensedNDCG@10 | 0.7126 | 0.7126 | 0.7126 | **0.7126** |
| | KnownRelevantRecall@50 | 0.5714 | 0.6190 | 0.5714 | **0.6190** |
| | Contemporary Recall@50 | 0.3750 | 0.7500 | 0.3750 | **0.7500** |
| **Head-to-Head (5 cases)** | nDCG@10 | 0.0252 | 0.0350 | 0.0239 | **0.0232** |
| | nDCG@20 | 0.0360 | 0.0356 | 0.0345 | **0.0339** |
| | condensedNDCG@10 | 0.6870 | 0.6341 | 0.6870 | **0.6376** |
| | KnownRelevantRecall@50 | 0.2133 | 0.2267 | 0.2133 | **0.2000** |
| | Contemporary Recall@50 | 0.2400 | 0.2600 | 0.2400 | **0.2400** |

*Note on Statistical Significance:* 3 curated and 5 head-to-head cases cannot establish formal statistical significance. Results are reported per-case; calibrated scaling prevents batch-dependent inflation while preserving tri-channel retrieval coverage. See [the full PR report](DBEF-SCALING-PR.md) and [calibration documentation](DBEF-CALIBRATION.md) for details.

## Running the Benchmarks

Run the frozen comparison locally:

```sh
# Curated 3-case benchmark
python3 tools/benchmark_dbef.py --output benchmarks/dbef-ablation-report.json

# Head-to-head 5-case benchmark
python3 tools/benchmark_dbef.py --dataset benchmarks/headtohead-frozen-pool.json --output benchmarks/headtohead-dbef-report.json

# Evaluate missing-data imputation options
python3 tools/benchmark_dbef.py --impute-missing-graph renormalize
python3 tools/benchmark_dbef.py --impute-missing-graph zero
```
