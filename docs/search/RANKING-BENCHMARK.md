# DBEF ranking benchmark

[The curated set](../../benchmarks/dbef-known-papers.json) contains 24 declared papers covering neural/lexical retrieval, citation networks and open-access research, with assistant-curated, unreviewed relevance judgments and foundational anchors. [The frozen pool](../../benchmarks/dbef-frozen-pool.json) resolved 23 of those papers and captured 321 distinct public metadata records from Crossref/DataCite. Harnad's D-Lib record was unavailable through those indexes and remains an explicit missing-metadata case. OpenAlex's public quota was exhausted during collection; the benchmark records this rather than substituting synthetic papers or bypassing the rate limit.

The comparison uses identical frozen candidate pools and existing hybrid weights with DBEF scoring enabled/disabled. Supplied bibliography DOIs form reference overlaps; unknown reference counts use the observed seed-reference median, and missing annual citation data has neutral velocity. Corpus size is an explicit 10-million-work assumption. Abstracts are stored as unordered unigram features, preserving word frequencies without redistributing raw abstract narratives. This removes sentence/phrase-order information. Neural ranking is disabled to isolate DBEF. This tests ranking on the supplied pool, not the full application's neural retrieval quality.

| Mean across three cases | DBEF off | DBEF on |
|---|---:|---:|
| nDCG@10 | 0.1285 | 0.1182 |
| Known relevant hits in top 20 | 1.67 | 2.33 |
| Known relevant recall in top 50 | 52.38% | 52.38% |
| Foundational anchors in top 50 | 0.67 | 0.67 |

The result is mixed: DBEF places more known papers in the top 20, while the top-10 ordering score falls slightly. It does not establish a general ranking improvement. No ranking weights or relevance judgments were tuned to this snapshot. Per-paper ranks and missed anchors are retained in [the full report](../../benchmarks/dbef-ablation-report.json).

Collection took about 11.4 seconds in this sample. Ranking took roughly 0.09 seconds without DBEF and 0.11 seconds with it on the development machine; timings vary by run. These are separate measurements, not on/off measurements of complete live search latency. The pools deliberately include curated positives to isolate ranking, so they cannot measure provider retrieval recall. Judgments are incomplete: unknown papers are not labelled irrelevant, and nDCG uses only the supplied known-paper gains. Abstracts and indexed reference DOIs are often missing. A broader held-out, human-labelled set and repeated live runs are required before claiming better recall or latency.

Run the frozen comparison without networking or new models:

```sh
python3 tools/benchmark_dbef.py
```

To refresh metadata deliberately, use `--collect` or `--collect --provider crossref`; the frozen pool is overwritten only by that explicit command. Dataset SHA-256, provider problems, missing metadata and timings are saved with the report. Relevance/landmark metrics follow the same top-k evaluation family used by [BEIR](https://github.com/beir-cellar/beir); this curated dataset is not the official BEIR benchmark. The existing SciFact importer/evaluator remains available for independent annotated-paper evaluation.
