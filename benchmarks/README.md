# Discovery relevance benchmark

Run `python3 tools/evaluate_discovery.py --output benchmarks/latest-results.json` from the source root. The tool reports Recall@50, graded nDCG@10 and MRR@10 against title-overlap and BM25 baselines. The default evaluation does not contact search providers or use AI; `--pairwise` explicitly enables the installed local ranker.

The included 20 cases are **synthetic regression fixtures**, with 100 candidates each and explicit grades 0–3. They check whether relevant abstracts, ranks and research questions beat superficially matching titles. They do not establish real-world search quality or validate biomedical relevance.

For a representative evaluation, label 20–50 real questions using several relevant seed papers, include candidates from all enabled sources and separately identify known relevant publications that were missed. Save `cases` containing `question`, `seeds`, `candidates` (branch name → paper list), and `qrels` (DOI or exact title → grade 0–3). Keep the cases fixed while comparing revisions. Recall needs a sufficiently complete relevance set; incomplete labels can only evaluate the judged subset.

Pulse's discovery results offer Relevant / Not relevant labels stored in the local workspace. **Export labels** produces a compatible dataset with `judgedOnly: true`. Its measurements describe reviewed records only. Labels are saved locally; relevant and rejected paper identifiers are used in recommendations when you rerun the same question. No global model is trained.

Ranking combines title/abstract BM25, reciprocal rank fusion by distinct query/channel, normalised citation evidence and optional local neural embeddings. Multiple providers reporting the same result for the same query share one fusion vote. Citation preference is off by default; when enabled it uses a citations/year percentile within the candidate pool, using an actual field if enough field metadata exists. It is not a global field-normalised impact metric.

A small installed Ollama embedding model enables automatic semantic reranking. Missing or failed local AI falls back to text/citation ranking and is identified in the results. No model download or cloud AI request occurs as part of a search. Preprint/published versions are grouped only with explicit publication type, near-identical title, consistent authors and dates; other differing DOIs stay separate.

## Search quality changes

Discovery now constructs phrase-aware concept groups (`OR` for alternatives, `AND` across concepts) and relaxes one requirement when retrieval is sparse. It retrieves up to 1,500 unique candidates per keyword source and keeps a balanced pool of up to 3,000 before selecting the requested 50–500 results. Distinct retrieval channels retain evidence; provider mirrors still share one fusion vote.

All independent sources start together with at most two simultaneous requests per host. Each branch has a 50-second cooperative budget and 24 network attempts, including retries and nested metadata lookups. Query results stream before a whole branch finishes. A budget or provider failure preserves collected results. DNS and operating-system socket behaviour can exceed cooperative deadlines; the UI's Stop and review remains available.

Local embeddings receive longer abstracts. The optional cross-encoder reads the question and title/abstract passages together for a balanced shortlist of 150 candidates; long abstracts include passages from the start, middle and end. Its isolated subprocess has a 30-second limit and is killed on cancellation or expiry. It only loads local safetensors with remote code disabled. Missing dependencies/weights preserve the complete text/citation candidate pool.

Explicit judgements now affect the next search with the same question and seed identities. Relevant examples add focused queries and a bounded ranking preference; negative examples reduce priority. Semantic Scholar recommendations receive positive/negative **paper identifiers** when discovery runs. Workspace labels are saved locally and are not used for global model training. Other questions remain independent. The results' Refine with feedback button reruns the selected context.

Match categories use pool-independent query coverage and available neural evidence, not the best result's relative text score. They are evidence categories, not probabilities. Empirical thresholds are fitted only with at least 20 explicit judgements and six examples of each class in the same scoring mode, then checked on a stratified held-out subset. Unknown papers are never treated as negative training labels. Insufficient or inconsistent judgements retain conservative defaults. `tools/calibrate_discovery.py` reports whether a labelled evaluation supports fitting thresholds; per-question fitting happens automatically in discovery.

## Published real-paper benchmark

The reproducible importer uses [SciFact](https://github.com/allenai/scifact), by David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen, Arman Cohan and Hannaneh Hajishirzi. Claims/evidence annotations are CC BY 4.0; abstracts from Semantic Scholar/S2ORC are ODC-By 1.0. See [the dataset licence](https://github.com/allenai/scifact/blob/master/LICENSE.md). Downloaded data are excluded from Git; the importer verifies a frozen SHA-256 and does not execute archive contents.

```sh
curl -L --fail -o /tmp/scifact-data.tar.gz https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz
python3 tools/import_scifact_benchmark.py /tmp/scifact-data.tar.gz
python3 tools/evaluate_discovery.py benchmarks/data/discovery-scifact.json --output benchmarks/scifact-text-results.json
python3 tools/evaluate_discovery.py benchmarks/data/discovery-scifact.json --pairwise --output benchmarks/scifact-pairwise-results.json
```

The first 30 distinct annotated development claims, ordered by original claim ID, are evaluated against 300 candidates retrieved by title/abstract BM25 from 5,183 real abstracts. Gold evidence papers are **not injected** into the candidate pool. This evaluates research-question retrieval, not citation exploration or live provider coverage. Claim evidence includes papers that support or refute a claim; the score measures finding evidence, not whether a claim is true. Remaining papers are unjudged, so these data cannot establish false-positive rates or calibrate probability estimates.

Reports include a title-overlap baseline, a stronger BM25 baseline, Pulse ranking, known-relevant recall, nDCG@10, MRR@10, judged coverage, missing known papers, ranking latency and whether pairwise inference actually ran. User exports include the full current retrieved pool where available; reviewed-only exports remain explicitly marked. Keep representative user questions with both relevant and irrelevant judgements for deployment decisions. A public benchmark alone does not establish performance for every research topic.

Recorded results for these 30 fixed questions:

| Ranking | Known-evidence Recall@50 | nDCG@10 | MRR@10 |
| --- | ---: | ---: | ---: |
| Title overlap | 0.8917 | 0.6469 | 0.6154 |
| Title/abstract BM25 | 0.9750 | 0.9174 | 0.9278 |
| Pulse text and retrieval evidence | 0.9833 | 0.9174 | 0.9278 |
| Pulse with local pairwise ranking | 1.0000 | 0.9341 | 0.9306 |

Pairwise inference ran in all 30 cases, with median ranking time 10.7 seconds and p95 13.7 seconds on the test machine. Text ranking took a median 0.27 seconds. These measurements exclude live provider retrieval and do not imply complete real-world search recall. The 34 known evidence judgements contain no explicit negatives, so the calibration check correctly declines to fit empirical thresholds. See the [text report](scifact-text-results.json), [pairwise report](scifact-pairwise-results.json) and [calibration check](scifact-calibration-check.json).

For an optional local cross-encoder runtime, developers can run `python3 tools/install_search_ranker.py` using a supported Python, or point `PULSE_RERANKER_PYTHON` and `PULSE_RERANKER_MODEL` at an existing isolated runtime and model directory. Setup is separate from normal searches; searches never download weights. The installer pins downloaded files to a model revision, uses safetensors and records a manifest. The model is [cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2), Apache 2.0; it is a general retrieval model whose scientific-domain performance must be evaluated.
