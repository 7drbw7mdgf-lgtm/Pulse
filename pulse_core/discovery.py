import pulse_backend as _pb
import re
import urllib.parse
from pulse_core.constants import ClientError
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
from pulse_core.doi_utils import normalize_doi
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_utils import normalize_title_key, openalex_to_metadata
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_core.recommendations import (
    openalex_recommendation_item,
    recommendation_record,
    steering_terms,
)
from pulse_core.s2_client import (
    fetch_s2_json,
    s2_fetch_citations,
    s2_fetch_references,
    s2_paper_id_for_paper,
    s2_paper_identifier,
    s2_paper_search,
    s2_recommendations,
    s2_to_metadata,
)
from pulse_core.storage import load_settings
from pulse_performance import parallel_branches, parallel_lookup


def openalex_work_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"\bW\d+\b", text)
    return match.group(0) if match else ""


def openalex_work_for_paper(paper):
    doi = normalize_doi(paper.get("doi") or "")
    if doi:
        try:
            return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
        except Exception:
            pass
    title = (paper.get("title") or "").strip()
    if title:
        try:
            params = urllib.parse.urlencode({"search": title, "per-page": 1})
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            results = data.get("results") or []
            if results:
                return results[0]
        except Exception:
            pass
    return None


def fetch_openalex_work_by_id(work_id):
    normalized = openalex_work_id(work_id)
    if not normalized:
        raise ClientError(400, "No OpenAlex work ID was provided.")
    return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote(normalized, safe='')}")


def openalex_citing_works(work_id, limit=12):
    normalized = openalex_work_id(work_id)
    if not normalized:
        return []
    params = urllib.parse.urlencode({
        "filter": f"cites:{normalized}",
        "sort": "cited_by_count:desc",
        "per-page": max(1, min(limit, 100)),
    })
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    return data.get("results") or []


def fetch_citation_graph_branch(seed_papers, api_key=None, include_iterative_chase=True, limit=30, depth=None):
    gathered = []
    hop1_references = []
    hop1_citations = []
    for paper in seed_papers[:3]:
        s2_id = _pb.s2_paper_id_for_paper(paper, api_key=api_key)
        if s2_id:
            try:
                refs = _pb.s2_fetch_references(s2_id, api_key=api_key, limit=limit)
                gathered.extend(refs)
                hop1_references.extend(refs)
            except Exception:
                pass
            try:
                cites = _pb.s2_fetch_citations(s2_id, api_key=api_key, limit=limit)
                gathered.extend(cites)
                hop1_citations.extend(cites)
            except Exception:
                pass

        if not gathered:
            work = _pb.openalex_work_for_paper(paper)
            if work:
                work_id = openalex_work_id(work.get("id"))
                for ref_id, ref_work in parallel_lookup(fetch_openalex_work_by_id, (work.get("referenced_works") or [])[:limit]):
                    if not ref_work:
                        continue
                    try:
                        record = recommendation_record(*openalex_recommendation_item(ref_work), source="OpenAlex references")
                        record["branch"] = "citationGraph"
                        record["subType"] = "Backward"
                        record["reason"] = "Backward citation: foundational reference cited by seed paper."
                        gathered.append(record)
                        hop1_references.append(record)
                    except Exception:
                        continue
                citing_works = openalex_citing_works(work_id, limit=limit)
                for item in citing_works:
                    record = recommendation_record(*openalex_recommendation_item(item), source="OpenAlex citing papers")
                    record["branch"] = "citationGraph"
                    record["subType"] = "Forward"
                    record["reason"] = "Forward citation: downstream paper citing seed paper."
                    gathered.append(record)
                    hop1_citations.append(record)

    max_depth = 4 if str(depth) == "iterative" else max(1, min(int(depth or (2 if include_iterative_chase else 1)), 3))
    seen = {s2_paper_identifier(p) for p in seed_papers}
    frontier = [(p, "backward") for p in hop1_references] + [(p, "forward") for p in hop1_citations]
    for hop in range(2, max_depth + 1):
        next_frontier = []
        for direction in ("backward", "forward"):
            candidates = sorted((p for p, d in frontier if d == direction), key=lambda p: int(p.get("citedByCount") or 0), reverse=True)[:4]
            for parent in candidates:
                key = s2_paper_identifier(parent)
                if not key or key in seen:
                    continue
                seen.add(key)
                try:
                    parent_id = _pb.s2_paper_id_for_paper(parent, api_key=api_key)
                    if not parent_id:
                        continue
                    fetcher = _pb.s2_fetch_references if direction == "backward" else _pb.s2_fetch_citations
                    for item in fetcher(parent_id, api_key=api_key, limit=8):
                        item_key = s2_paper_identifier(item)
                        if item_key in seen:
                            continue
                        item.update(subType=f"Iterative Chase ({hop}-Hop)", hop=hop, chaseViaTitle=parent.get("title", ""), reason=f"Citation hop {hop} via {parent.get('title', '')[:80]}")
                        gathered.append(item)
                        next_frontier.append((item, direction))
                except Exception:
                    continue
        frontier = next_frontier
        if not frontier:
            break

    return gathered


def fetch_citation_network_branch(seed_papers, api_key=None, limit=30):
    gathered = []
    for paper in seed_papers[:3]:
        work = _pb.openalex_work_for_paper(paper)
        if not work:
            continue
        work_id = openalex_work_id(work.get("id"))
        citing_works = openalex_citing_works(work_id, limit=max(limit, 30))
        cocite_counts = {}
        for c_work in citing_works:
            for ref_id in (c_work.get("referenced_works") or []):
                ref_norm = openalex_work_id(ref_id)
                if not ref_norm or ref_norm == work_id:
                    continue
                cocite_counts[ref_norm] = cocite_counts.get(ref_norm, 0) + 1

        top_cocited_ids = [ref_norm for ref_norm, count in sorted(cocite_counts.items(), key=lambda x: -x[1]) if count >= 2][:20]
        for ref_norm, co_work in parallel_lookup(fetch_openalex_work_by_id, top_cocited_ids):
            if not co_work:
                continue
            try:
                record = recommendation_record(*openalex_recommendation_item(co_work), source="Citation Network (Co-citation)")
                record["branch"] = "citationNetwork"
                record["subType"] = "Co-citation"
                record["sharedCitationsCount"] = cocite_counts[ref_norm]
                record["reason"] = f"Co-citation triangulation: cited together with seed paper by {cocite_counts[ref_norm]} citing papers."
                gathered.append(record)
            except Exception:
                continue

        seed_ref_ids = [openalex_work_id(r) for r in (work.get("referenced_works") or []) if openalex_work_id(r)][:8]
        if len(seed_ref_ids) >= 2:
            try:
                params = urllib.parse.urlencode({
                    "filter": f"cites:{'|'.join(seed_ref_ids[:4])}",
                    "sort": "cited_by_count:desc",
                    "per-page": max(limit, 25),
                })
                data = fetch_json(f"https://api.openalex.org/works?{params}")
                for b_work in (data.get("results") or []):
                    b_id = openalex_work_id(b_work.get("id"))
                    if b_id == work_id:
                        continue
                    b_refs = {openalex_work_id(r) for r in (b_work.get("referenced_works") or [])}
                    shared = len(set(seed_ref_ids).intersection(b_refs))
                    if shared >= 1:
                        record = recommendation_record(*openalex_recommendation_item(b_work), source="Citation Network (Bibliographic)")
                        record["branch"] = "citationNetwork"
                        record["subType"] = "Bibliographic coupling"
                        record["sharedReferencesCount"] = shared
                        record["reason"] = f"Bibliographic coupling: shares {shared} foundational references with seed paper."
                        gathered.append(record)
            except Exception:
                pass
    return gathered


def fetch_semantic_search_branch(seed_papers, api_key=None, exclude_papers=None, limit=30):
    positive_ids = []
    for p in seed_papers:
        ident = _pb.s2_paper_id_for_paper(p, api_key=api_key)
        if ident:
            positive_ids.append(ident)
    if not positive_ids:
        return []
    recs = s2_recommendations(positive_ids[:5], api_key=api_key, limit=limit)
    return [recommendation_record(r, {"score": 1.0, "reason": "S2 recommendations"}, "S2 Recommendations") for r in recs]


def fetch_conceptual_search_branch(seed_papers, api_key=None, steer_keywords=None, limit=30):
    query = " ".join(steer_keywords or [])
    if not query:
        query = " ".join(p.get("title", "") for p in seed_papers[:2])
    cands = s2_paper_search(query, api_key=api_key, limit=limit)
    return [recommendation_record(c, {"score": 1.0, "reason": "Conceptual search"}, "S2 Conceptual") for c in cands]


def run_discovery_pipeline(payload, on_progress=None, cancel_event=None):
    seed_papers = payload.get("seedPapers") or payload.get("papers") or []
    if not seed_papers:
        raise ClientError(400, "Select at least one seed paper to run the literature discovery pipeline.")
    settings = _pb.load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {}
    steer_keywords = steering_terms(payload.get("steerKeywords") or payload.get("keywords") or [])
    exclude_keywords = steering_terms(payload.get("excludeKeywords") or [])
    limit = min(max(int(payload.get("limit") or 50), 1), 100)
    include_iterative = bool(payload.get("includeIterativeChase", True))
    tasks = {}
    if branches.get("citationGraph", True):
        tasks["citationGraph"] = lambda: _pb.fetch_citation_graph_branch(seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get("depth"))
    if branches.get("citationNetwork", True):
        tasks["citationNetwork"] = lambda: fetch_citation_network_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get("semanticSearch", True):
        tasks["semanticSearch"] = lambda: fetch_semantic_search_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get("lexicalSearch", branches.get("lexicalConceptual", True)):
        tasks["lexicalConceptual"] = lambda: _pb.fetch_conceptual_search_branch(seed_papers, api_key=api_key, steer_keywords=steer_keywords, limit=limit)
    options = {
        "steerKeywords": steer_keywords,
        "excludeKeywords": exclude_keywords,
        "excludeDois": payload.get("excludeDois") or [],
        "excludeTitles": payload.get("excludeTitles") or [],
        "recencyTilt": payload.get("recencyTilt") or 0,
        "impactTilt": payload.get("impactTilt") or 0,
        "limit": limit,
    }
    def progress(results, completed, errors, total):
        if on_progress:
            ordered = {name: results.get(name, []) for name in tasks}
            on_progress({
                "recommendations": merge_and_rank_pipeline_candidates(ordered, seed_papers, options),
                "branchesExecuted": [name for name in tasks if name in completed],
                "errors": errors,
                "completed": len(completed) + len(errors),
                "total": total,
            })
    if on_progress:
        on_progress({"total": len(tasks)})
    results, executed, errors = parallel_branches(tasks, progress, cancel_event)
    ordered = {name: results.get(name, []) for name in tasks}
    return {
        "ok": True,
        "provider": "Semantic Scholar Academic Graph (S2AG) + Hybrid Pipeline",
        "seedCount": len(seed_papers),
        "branchesExecuted": executed,
        "recommendations": merge_and_rank_pipeline_candidates(ordered, seed_papers, options),
        "errors": errors,
        "completed": len(executed) + len(errors),
        "total": len(tasks),
    }


def iterative_citation_chase(payload):
    seeds = payload.get("seedPapers") or []
    return {"ok": True, "results": _pb.fetch_citation_graph_branch(seeds, depth="iterative")}


def citation_network_triangulation(payload):
    seeds = payload.get("seedPapers") or []
    return {"ok": True, "results": fetch_citation_network_branch(seeds)}
