#!/usr/bin/env python3
"""Offline independent benchmark harness for Pulse Discovery A+ (Sections 0–4).

Re-ranks frozen candidate pools offline under named variants so every change in
Sections 1–4 is evaluated as a controlled ablation on identical candidate pools.

Metrics reported per seed and per dataset (with 95% bootstrap CIs over seeds):
- nDCG@10, nDCG@20
- condensed_nDCG@10, condensed_nDCG@20 (unjudged candidates removed)
- Recall@20, Recall@50, Recall@200
- RecentRecall@50, RecentRecall@200 (relevant papers published in the last 2 years)
- MRR (Mean Reciprocal Rank)
- ranking_ms (wall-clock ranking latency per seed)

Decision rule (Sections 1–4):
A variant is eligible to become the default only if:
1. On each independent dataset (relish, synergy, scidocs), neither nDCG@20 nor
   Recall@50 falls by more than its 95% CI half-width; and
2. On at least one independent dataset, nDCG@20 or Recall@50 improves with a
   paired 95% bootstrap CI over seeds that excludes zero (delta_ci_low > 0).
The 5-seed citation-derived head-to-head set is reported separately as a secondary check.
"""
import argparse
import collections
import copy
import datetime
import difflib
import gzip
import json
import math
import random
import re
import statistics
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "local-web" / "pulse-backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from pulse_core.discovery_feedback import concept_features, contrastive_profile, feedback_adjustment, paper_key
from pulse_core.doi_utils import normalize_doi
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_core.search_limits import SearchResults
from pulse_core.search_merge import title_key

DEFAULT_POOLS_DIR = Path("/Users/lshpk18/Pulse-release/headtohead/frozen_pools")
BOOTSTRAP_SAMPLES = 2000
BOOTSTRAP_SEED = 20261017
RECENT_YEAR_CUTOFF = datetime.date.today().year - 2


def load_pool_file(path):
    p = Path(path)
    if p.suffix == ".gz" or p.name.endswith(".json.gz"):
        with gzip.open(p, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(p.read_text(encoding="utf-8"))


def match_candidate_to_qrels(candidate, qrels_index):
    """Return (qrel_key, grade) if candidate matches a judged qrel entry, else (None, None)."""
    pmid = re.sub(r"\D+", "", str(candidate.get("pmid") or ""))
    if pmid and f"pmid:{pmid}" in qrels_index["by_key"]:
        k = f"pmid:{pmid}"
        return k, qrels_index["by_key"][k]["grade"]

    doi = normalize_doi(candidate.get("doi") or "").lower()
    if doi and f"doi:{doi}" in qrels_index["by_key"]:
        k = f"doi:{doi}"
        return k, qrels_index["by_key"][k]["grade"]
    if doi and doi in qrels_index["by_doi"]:
        k = qrels_index["by_doi"][doi]
        return k, qrels_index["by_key"][k]["grade"]

    tk = title_key(candidate.get("title") or "")
    if tk:
        if f"title:{tk}" in qrels_index["by_key"]:
            k = f"title:{tk}"
            return k, qrels_index["by_key"][k]["grade"]
        if tk in qrels_index["by_title"]:
            k = qrels_index["by_title"][tk]
            return k, qrels_index["by_key"][k]["grade"]
        # High-threshold fuzzy title fallback (0.92, matching headtohead/tools/score.py)
        if qrels_index["fuzzy_titles"]:
            first_word = tk.split()[0] if tk.split() else ""
            for cand_tk, qkey in qrels_index["fuzzy_by_prefix"].get(first_word, ()):
                if abs(len(tk) - len(cand_tk)) <= 12 and difflib.SequenceMatcher(None, tk, cand_tk).ratio() >= 0.92:
                    return qkey, qrels_index["by_key"][qkey]["grade"]
    return None, None


def build_qrels_index(qrels_dict):
    by_key = {}
    by_doi = {}
    by_title = {}
    fuzzy_by_prefix = collections.defaultdict(list)
    for k, val in (qrels_dict or {}).items():
        if isinstance(val, dict):
            entry = dict(val)
            grade = int(entry.get("grade") or 0)
        else:
            entry = {"grade": int(val or 0)}
            grade = entry["grade"]
        by_key[k] = entry
        doi = normalize_doi(entry.get("doi") or "").lower()
        if doi:
            by_doi[doi] = k
        tk = title_key(entry.get("title") or "")
        if tk:
            by_title[tk] = k
            if grade > 0 and tk.split():
                fuzzy_by_prefix[tk.split()[0]].append((tk, k))
    return {
        "by_key": by_key,
        "by_doi": by_doi,
        "by_title": by_title,
        "fuzzy_titles": bool(fuzzy_by_prefix),
        "fuzzy_by_prefix": fuzzy_by_prefix,
    }


def dcg_at_k(grades, k):
    return sum((2 ** g - 1) / math.log2(idx + 2) for idx, g in enumerate(grades[:k]) if g > 0)


def compute_case_metrics(ranked_papers, qrels_dict, ranking_ms=0.0):
    """Compute full IR metrics for one ranked list against a seed's ground-truth qrels."""
    qindex = build_qrels_index(qrels_dict)
    by_key = qindex["by_key"]

    all_positive_grades = sorted([v["grade"] for v in by_key.values() if v["grade"] > 0], reverse=True)
    total_relevant = len(all_positive_grades)

    pos_years = [
        int(str(v.get("year") or "")[:4])
        for v in by_key.values()
        if v["grade"] > 0 and str(v.get("year") or "")[:4].isdigit()
    ]
    recent_cutoff = (
        RECENT_YEAR_CUTOFF
        if any(y >= RECENT_YEAR_CUTOFF for y in pos_years)
        else (max(pos_years) - 1 if pos_years else RECENT_YEAR_CUTOFF)
    )
    recent_positive_keys = {
        k
        for k, v in by_key.items()
        if v["grade"] > 0
        and str(v.get("year") or "")[:4].isdigit()
        and int(str(v.get("year") or "")[:4]) >= recent_cutoff
    }

    full_grades = []
    condensed_grades = []
    matched_pos_keys_at = {20: set(), 50: set(), 200: set()}
    matched_recent_at = {50: set(), 200: set()}
    seen_qkeys = set()
    first_rel_rank = None

    for rank_idx, paper in enumerate(ranked_papers, 1):
        qkey, grade = match_candidate_to_qrels(paper, qindex)
        if qkey is not None and qkey not in seen_qkeys:
            seen_qkeys.add(qkey)
            full_grades.append(grade)
            condensed_grades.append(grade)
            if grade > 0:
                if first_rel_rank is None:
                    first_rel_rank = rank_idx
                for K in (20, 50, 200):
                    if rank_idx <= K:
                        matched_pos_keys_at[K].add(qkey)
                if qkey in recent_positive_keys or (
                    not recent_positive_keys
                    and str(paper.get("year") or "")[:4].isdigit()
                    and int(str(paper.get("year"))[:4]) >= recent_cutoff
                ):
                    for K in (50, 200):
                        if rank_idx <= K:
                            matched_recent_at[K].add(qkey)
        else:
            full_grades.append(0)

    idcg_10 = dcg_at_k(all_positive_grades, 10)
    idcg_20 = dcg_at_k(all_positive_grades, 20)
    ndcg_10 = dcg_at_k(full_grades, 10) / idcg_10 if idcg_10 > 0 else 0.0
    ndcg_20 = dcg_at_k(full_grades, 20) / idcg_20 if idcg_20 > 0 else 0.0

    # Condensed nDCG (Sakai 2007): unjudged documents removed, normalized by ideal ordering of judged docs
    judged_ideal = sorted(condensed_grades, reverse=True)
    c_idcg_10 = dcg_at_k(judged_ideal, 10)
    c_idcg_20 = dcg_at_k(judged_ideal, 20)
    cond_ndcg_10 = dcg_at_k(condensed_grades, 10) / c_idcg_10 if c_idcg_10 > 0 else 0.0
    cond_ndcg_20 = dcg_at_k(condensed_grades, 20) / c_idcg_20 if c_idcg_20 > 0 else 0.0

    denom = max(1, total_relevant)
    rec_20 = len(matched_pos_keys_at[20]) / denom
    rec_50 = len(matched_pos_keys_at[50]) / denom
    rec_200 = len(matched_pos_keys_at[200]) / denom
    mrr = (1.0 / first_rel_rank) if first_rel_rank is not None else 0.0

    recent_denom = len(recent_positive_keys)
    recent_rec_50 = (len(matched_recent_at[50]) / recent_denom) if recent_denom > 0 else None
    recent_rec_200 = (len(matched_recent_at[200]) / recent_denom) if recent_denom > 0 else None

    return {
        "nDCG@10": round(ndcg_10, 6),
        "nDCG@20": round(ndcg_20, 6),
        "condensed_nDCG@10": round(cond_ndcg_10, 6),
        "condensed_nDCG@20": round(cond_ndcg_20, 6),
        "Recall@20": round(rec_20, 6),
        "Recall@50": round(rec_50, 6),
        "Recall@200": round(rec_200, 6),
        "RecentRecall@50": round(recent_rec_50, 6) if recent_rec_50 is not None else None,
        "RecentRecall@200": round(recent_rec_200, 6) if recent_rec_200 is not None else None,
        "MRR": round(mrr, 6),
        "judgedInPool": len(condensed_grades),
        "relevantInTop200": len(matched_pos_keys_at[200]),
        "totalRelevant": total_relevant,
        "rankingMs": round(ranking_ms, 3),
    }


def bootstrap_ci(values, n_boot=BOOTSTRAP_SAMPLES, seed=BOOTSTRAP_SEED):
    """Compute mean and 95% percentile bootstrap confidence interval over seed values."""
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return {"mean": None, "ci_low": None, "ci_high": None, "ci_half_width": None, "n": 0}
    n = len(clean)
    mean_val = statistics.mean(clean)
    if n == 1:
        return {"mean": round(mean_val, 4), "ci_low": round(mean_val, 4), "ci_high": round(mean_val, 4), "ci_half_width": 0.0, "n": 1}
    rng = random.Random(seed)
    boot_means = []
    for _ in range(n_boot):
        sample = [clean[rng.randrange(n)] for _ in range(n)]
        boot_means.append(sum(sample) / n)
    boot_means.sort()
    low = boot_means[int(0.025 * n_boot)]
    high = boot_means[int(0.975 * n_boot)]
    return {
        "mean": round(mean_val, 4),
        "ci_low": round(low, 4),
        "ci_high": round(high, 4),
        "ci_half_width": round((high - low) / 2.0, 4),
        "n": n,
    }


def rank_case_under_variant(case, variant="baseline", custom_rerankers=None, ranking_options=None):
    """Re-rank one frozen pool case offline under a named variant."""
    raw_branches = copy.deepcopy(case["candidates_by_branch"])
    seed_papers = copy.deepcopy(case["seed_papers"])

    # Restore SearchResults.network_assessments on citationNetwork
    if "citationNetwork" in raw_branches:
        net_rows = SearchResults(raw_branches["citationNetwork"])
        net_rows.network_assessments = copy.deepcopy(case.get("network_assessments") or {})
        raw_branches["citationNetwork"] = net_rows

    if variant == "baseline":
        # Baseline 1.9.0 does not have authorTrajectory
        raw_branches.pop("authorTrajectory", None)
    elif variant in ("sec1_author_trajectory", "sec1_author_trajectory_bonus"):
        # Keep authorTrajectory branch in candidates_by_branch
        pass
    else:
        # Other single-feature ablations keep baseline branches unless testing combined
        if not variant.startswith("combined"):
            raw_branches.pop("authorTrajectory", None)

    options = {
        "limit": 200,
        "diversify": True,
        "citationVelocityPrior": True,
        "foundationalPrior": True,
        "citationLinkBonus": True,
        "citationLinkGate": 0.3,
        "citationLinkMode": "velocity",
        "citationLinkWeight": 0.2,
        "impute_missing_graph": "median",
        "graph_imputation_shrink": 0.5,
    }
    if custom_rerankers:
        if custom_rerankers.get("semantic"):
            options["_semanticReranker"] = custom_rerankers["semantic"]
        if custom_rerankers.get("pairwise"):
            options["_pairwiseReranker"] = custom_rerankers["pairwise"]
    options.update(ranking_options or {})

    t0 = time.perf_counter()
    ranked = merge_and_rank_pipeline_candidates(raw_branches, seed_papers, options)

    if variant == "sec1_author_trajectory_bonus":
        # Test whether adding a fixed +5.0 score bonus to authorTrajectory candidates helps or hurts
        for r in ranked:
            if any(str(ev.get("channel") or "").startswith("author:") for ev in (r.get("retrievalEvidence") or [])):
                r["score"] = round(min(100.0, float(r.get("score") or 0.0) + 5.0), 3)
        ranked.sort(key=lambda r: (-float(r.get("score") or 0.0), title_key(r.get("title"))))

    elif variant == "sec3_citation_intent":
        # Test intent-weighted citation evidence: methodology/result (+2.5) > background (+0.0), influential (+1.5)
        contexts_map = case.get("citation_contexts") or {}
        for r in ranked:
            intents = set(str(x).lower() for x in (r.get("citationIntents") or []))
            is_inf = bool(r.get("isInfluentialCitation"))
            if not intents and contexts_map:
                ckey = normalize_doi(r.get("doi") or "").lower() or (f"pmid:{r.get('pmid')}" if r.get("pmid") else "")
                if ckey in contexts_map:
                    intents = set(str(x).lower() for x in (contexts_map[ckey].get("intents") or []))
                    is_inf = bool(contexts_map[ckey].get("isInfluential"))
            bonus = 0.0
            if "methodology" in intents or "methods" in intents or "result" in intents or "results" in intents:
                bonus += 2.5
            if is_inf:
                bonus += 1.5
            if bonus > 0:
                r["score"] = round(min(100.0, float(r.get("score") or 0.0) + bonus), 3)
        ranked.sort(key=lambda r: (-float(r.get("score") or 0.0), title_key(r.get("title"))))

    ranking_ms = (time.perf_counter() - t0) * 1000.0
    return ranked, ranking_ms


def evaluate_variant_on_dataset(dataset_doc, variant="baseline", custom_rerankers=None, ranking_options=None):
    per_seed = []
    metric_names = (
        "nDCG@10",
        "nDCG@20",
        "condensed_nDCG@10",
        "condensed_nDCG@20",
        "Recall@20",
        "Recall@50",
        "Recall@200",
        "RecentRecall@50",
        "RecentRecall@200",
        "MRR",
        "rankingMs",
    )
    for case in dataset_doc.get("cases") or []:
        ranked, ranking_ms = rank_case_under_variant(case, variant=variant, custom_rerankers=custom_rerankers,ranking_options=ranking_options)
        m = compute_case_metrics(ranked, case.get("qrels") or {}, ranking_ms=ranking_ms)
        m["case_id"] = case.get("case_id")
        per_seed.append(m)

    summary = {}
    for m_name in metric_names:
        vals = [row[m_name] for row in per_seed if row.get(m_name) is not None]
        summary[m_name] = bootstrap_ci(vals)
    return {"variant": variant, "dataset": dataset_doc.get("dataset"), "summary": summary, "per_seed": per_seed}


def compare_variant_against_baseline(baseline_res, variant_res):
    """Compute paired bootstrap CIs for (variant - baseline) and check Section 0 decision rule."""
    metric_names = (
        "nDCG@10",
        "nDCG@20",
        "condensed_nDCG@10",
        "condensed_nDCG@20",
        "Recall@20",
        "Recall@50",
        "Recall@200",
        "RecentRecall@50",
        "RecentRecall@200",
        "MRR",
    )
    b_seeds = {r["case_id"]: r for r in baseline_res["per_seed"]}
    v_seeds = {r["case_id"]: r for r in variant_res["per_seed"]}
    common_ids = [cid for cid in b_seeds if cid in v_seeds]
    deltas = {}
    for m_name in metric_names:
        diffs = [
            v_seeds[cid][m_name] - b_seeds[cid][m_name]
            for cid in common_ids
            if b_seeds[cid].get(m_name) is not None and v_seeds[cid].get(m_name) is not None
        ]
        deltas[m_name] = bootstrap_ci(diffs)
    return deltas


def check_decision_rule(comparisons_by_dataset):
    """Apply Section 0 Decision Rule across independent datasets (relish, synergy, scidocs)."""
    independent = [ds for ds in ("relish", "synergy", "scidocs") if ds in comparisons_by_dataset]
    no_regression = True
    significant_improvement = False
    reasons = []

    for ds in independent:
        comp = comparisons_by_dataset[ds]
        base_summary = comp["baseline_summary"]
        deltas = comp["deltas"]
        for metric in ("nDCG@20", "Recall@50"):
            d_mean = deltas[metric]["mean"] or 0.0
            b_ci = base_summary[metric]["ci_half_width"] or 0.0
            if d_mean < -b_ci:
                no_regression = False
                reasons.append(f"{ds} {metric} fell by {d_mean:.4f} (exceeds CI {b_ci:.4f})")
            if (deltas[metric]["ci_low"] or 0.0) > 0.0:
                significant_improvement = True
                reasons.append(f"{ds} {metric} improved by +{d_mean:.4f} (95% CI [{deltas[metric]['ci_low']:.4f}, {deltas[metric]['ci_high']:.4f}] excludes 0)")

    return {
        "passes_decision_rule": bool(no_regression and significant_improvement),
        "no_regression": no_regression,
        "significant_improvement": significant_improvement,
        "notes": reasons,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pools-dir", type=Path, default=DEFAULT_POOLS_DIR)
    parser.add_argument("--variants", default="baseline,sec1_author_trajectory,sec1_author_trajectory_bonus,sec3_citation_intent")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    datasets = {}
    for name in ("relish", "synergy", "scidocs", "headtohead"):
        p = args.pools_dir / f"{name}_pools.json.gz"
        if p.exists():
            datasets[name] = load_pool_file(p)

    variants = [v.strip() for v in args.variants.split(",") if v.strip()]
    results = {v: {} for v in variants}
    for v in variants:
        for ds_name, doc in datasets.items():
            results[v][ds_name] = evaluate_variant_on_dataset(doc, variant=v)

    comparisons = {}
    if "baseline" in results:
        for v in variants:
            if v == "baseline":
                continue
            comparisons[v] = {}
            for ds_name in datasets:
                comparisons[v][ds_name] = {
                    "baseline_summary": results["baseline"][ds_name]["summary"],
                    "variant_summary": results[v][ds_name]["summary"],
                    "deltas": compare_variant_against_baseline(results["baseline"][ds_name], results[v][ds_name]),
                }
            comparisons[v]["decision_rule"] = check_decision_rule(comparisons[v])

    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "bootstrap_samples": BOOTSTRAP_SAMPLES,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "results": {
            v: {ds: {"summary": results[v][ds]["summary"], "cases": len(results[v][ds]["per_seed"])} for ds in results[v]}
            for v in results
        },
        "comparisons": comparisons,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
