from pulse_core.recommendations import (
    recommendation_rank,
    steering_match_score,
    steering_penalty,
)
from pulse_core.metadata_utils import title_overlap_score

def merge_and_rank_pipeline_candidates(candidates_by_branch, seed_papers, options):
    steer_kw = options.get("steerKeywords") or []
    exclude_kw = options.get("excludeKeywords") or []
    exclude_dois = set(str(d).lower() for d in (options.get("excludeDois") or []))
    exclude_titles = set(str(t).lower() for t in (options.get("excludeTitles") or []))
    limit = int(options.get("limit") or 50)
    seed_titles = " ".join(p.get("title", "") for p in seed_papers)
    seed_authors = set()
    seed_journals = set()
    for p in seed_papers:
        for a in p.get("authors") or []:
            seed_authors.add(a.lower())
        if p.get("journal"):
            seed_journals.add(p["journal"].lower())
    seen = {}
    for branch, cands in candidates_by_branch.items():
        for cand in cands:
            doi = (cand.get("doi") or "").lower()
            title = (cand.get("title") or "").lower()
            key = doi if doi else title
            if not key or (doi and doi in exclude_dois) or (title and title in exclude_titles):
                continue
            if key not in seen:
                cand["branches"] = [branch]
                seen[key] = cand
            else:
                if branch not in seen[key]["branches"]:
                    seen[key]["branches"].append(branch)
    ranked = []
    for cand in seen.values():
        overlap = title_overlap_score(seed_titles, cand.get("title") or "")
        author_boost = sum(1 for a in cand.get("authors") or [] if a.lower() in seed_authors)
        journal_boost = 1 if (cand.get("journal") or "").lower() in seed_journals else 0
        pen = steering_penalty(cand, exclude_kw)
        steer_boost = steering_match_score([cand.get("title", ""), cand.get("abstract", "")], steer_kw) * 0.5
        multi_branch_boost = (len(cand.get("branches", [])) - 1) * 0.4
        score = recommendation_rank(
            cand,
            overlap,
            author_boost=author_boost,
            journal_boost=journal_boost,
            penalty=pen,
            recency_tilt=options.get("recencyTilt", 0),
            impact_tilt=options.get("impactTilt", 0),
        ) + steer_boost + multi_branch_boost
        cand["score"] = round(score, 3)
        cand["branches"] = sorted(cand.get("branches", []))
        ranked.append((score, cand))
    ranked.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in ranked[:limit]]
