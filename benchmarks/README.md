# Discovery relevance benchmark

Run `python3 tools/evaluate_discovery.py --output benchmarks/latest-results.json` from the source root. The tool reports Recall@50 and graded nDCG@10 against a frozen title-overlap baseline. It does not contact search providers or use AI.

The included 20 cases are **synthetic regression fixtures**, with 100 candidates each and explicit grades 0–3. They check whether relevant abstracts, ranks and research questions beat superficially matching titles. They do not establish real-world search quality or validate biomedical relevance.

For a representative evaluation, label 20–50 real questions using several relevant seed papers, include candidates from all enabled sources and separately identify known relevant publications that were missed. Save `cases` containing `question`, `seeds`, `candidates` (branch name → paper list), and `qrels` (DOI or exact title → grade 0–3). Keep the cases fixed while comparing revisions. Recall needs a sufficiently complete relevance set; incomplete labels can only evaluate the judged subset.

Pulse's discovery results offer Relevant / Not relevant labels stored in the local workspace. **Export labels** produces a compatible dataset with `judgedOnly: true`. Its measurements describe reviewed records only. No labels are uploaded or used to silently train a model.

Ranking combines title/abstract BM25, reciprocal rank fusion by distinct query/channel, normalised citation evidence and optional local neural embeddings. Multiple providers reporting the same result for the same query share one fusion vote. Citation preference is off by default; when enabled it uses a citations/year percentile within the candidate pool, using an actual field if enough field metadata exists. It is not a global field-normalised impact metric.

A small installed Ollama embedding model enables automatic semantic reranking. Missing or failed local AI falls back to text/citation ranking and is identified in the results. No model download or cloud AI request occurs as part of a search. Preprint/published versions are grouped only with explicit publication type, near-identical title, consistent authors and dates; other differing DOIs stay separate.
