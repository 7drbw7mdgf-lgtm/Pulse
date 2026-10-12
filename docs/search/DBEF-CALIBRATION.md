# DBEF calibration, missing evidence and citation channels

This development-source change retains the hybrid weights (`.62` text, `.26` fusion, `.12` graph), neural blend weights, `.09` general velocity prior and `.06` foundational prior. It changes DBEF scaling, missing graph handling and the available citation channels. Published installer version numbers are unchanged.

## Seed-derived scale

Live discovery and benchmark scoring use `S_norm(s) = s / (s + S0)` instead of dividing by the strongest candidate. The seed-side anchor is:

```
w_med = median adjusted seed-reference weight
L_typ = median known seed bibliography length (fallback 40)
s1 = w_med / sqrt(L_typ + 15) × 1 × (0.3 + 0.7 × 0.5)
S0 = s1 × (1 / 0.15 - 1)
```

`dbef_summary` stores `S0`, `s1`, the inputs, and assessment counts. Candidate batches do not set the scale. The calibrated path also fits its vocabulary and similarity anchors on seed/reference texts only; otherwise adding a candidate would still change TF-IDF weights and content percentiles before saturation. Common seed-topic terms are retained in that seed-only vocabulary. Legacy scorer defaults remain available for the frozen before comparison. Topic content, bibliography-length saturation and the existing DBEF velocity factor still affect raw scores.

A single median-specificity reference with typical length and mid content support maps to 0.15. Actual scores vary with specificity, length, content and velocity; the anchor is not a universal upper bound on every one-reference paper. Tests check an actual weak reference below 0.20, eight high-specificity on-topic references above 0.60, and candidate-batch independence.

## Three states

| State | Meaning | Stored similarity |
|---|---|---|
| `assessed_overlap` | Known references overlap the seed references and a coupling score is available | Calibrated value |
| `assessed_zero` | A bibliography is known (nonempty references or a positive declared count), with no shared reference | `0.0` |
| `unassessed` | Reference evidence is unavailable; an unavailable seed graph also prevents assessment | `None` |

The core scorer reports zero/unassessed IDs separately and never adds them to ranked coupling top-k results. Assessment mappings carry known zero across other retrieval branches by DOI/OpenAlex identity. Candidates outside the bounded content-scoring shortlist are not given fabricated coupling scores.

The default missing-graph policy is `median`: the median assessed similarity in the merged pool multiplied by shrink 0.5. Known zeros participate in that median; absent evidence is not converted into an assessed zero. Imputation is used in preliminary and hybrid graph scoring. Score diagnostics identify imputation, and it never becomes a claimed citation path or an independent retrieval channel.

`impute_missing_graph` accepts `median`, `zero` or evaluation-only `renormalize`; `graph_imputation_shrink` accepts a finite value from 0 to 1. The discovery API validates these options before launching a job. `renormalize` divides the missing-graph preliminary/hybrid base by 0.88. It is not the default. Real `1/hop` direct-citation evidence and actual co-citation evidence are never imputed or renormalized away.

## Independent citation channels

Direct citations (`citationGraph`), DBEF coupling (`citationNetwork`) and co-citation (`citationCoCitation`) execute in parallel. The toolbar has a separate co-citation choice. Co-citation follows papers citing a seed, then resolves works they cite alongside it in OpenAlex batches of at most 100. Each distinct citing work contributes one vote even when several seeds find it. Similarity is `votes / (votes + 4)`. The branch has its own eight-second deadline and publishes early resolved results before moving to another seed. It emits `subType: 'Co-citation'` evidence, reactivating the existing foundational-support path.

DBEF keeps `subType: 'Bibliographic coupling'` and its raw velocity factor `1 + 0.5 ln(1 + v)`. The separate general velocity prior remains disabled for DBEF-scored records, so velocity is not counted twice. The foundational prior remains independent of that choice.

Only seeds with empty OpenAlex references try a Semantic Scholar reference fallback: one references call per seed, then batched DOI mapping into OpenAlex. It uses the existing authentication/rate-limit transport and skips a matching credential cooldown. These calls share the DBEF branch budget. The live app does not issue per-candidate fallback calls. The benchmark may batch-resolve missing candidate bibliographies to make incomplete metadata visible and usable.

The ranking cache prefix is `dbef-seed-scale-v2` and result `matchStrengthVersion` is `evidence-v5-dbef-seed-scale`, preventing old ranking reuse.

## Evaluation

See [the eight-case report and commands](RANKING-BENCHMARK.md) and [the prepared PR description](DBEF-SCALING-PR.md). Both datasets are incomplete, small checks. They cannot establish statistical significance or a general relevance improvement. Conventional nDCG uses zero gain at unjudged positions; condensed nDCG drops unjudged documents. bpref uses only judged positives/negatives and is unavailable when a class is absent. No labels are invented to make that metric available.

References: [OpenAlex batch/citation recipes](https://help.openalex.org/how-to/api-recipes/), [Semantic Scholar API](https://api.semanticscholar.org/api-docs/), and [NIST bpref implementation and attribution](https://github.com/usnistgov/trec_eval/blob/main/m_bpref.c).
