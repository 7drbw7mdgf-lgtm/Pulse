from pulse_core.constants import ClientError
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
from pulse_core.recommendations import merge_recommendations, recommendation_record
from pulse_core.s2_client import s2_fetch_citations, s2_fetch_references, s2_paper_id_for_paper
from pulse_core.storage import load_settings

def recommend_papers(payload):
    from pulse_core.discovery import run_discovery_pipeline
    return run_discovery_pipeline(payload)

def enrich_citations(payload):
    papers = payload.get("papers") or []
    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    enriched = []
    for p in papers:
        s2_id = s2_paper_id_for_paper(p, api_key=api_key)
        if s2_id:
            refs = s2_fetch_references(s2_id, api_key=api_key, limit=15)
            cites = s2_fetch_citations(s2_id, api_key=api_key, limit=15)
            enriched.append({
                "paper": p,
                "references": refs,
                "citations": cites,
            })
    return {"ok": True, "enriched": enriched}

def find_missing_seminal_papers(payload):
    papers = payload.get("papers") or []
    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    ref_counts = {}
    ref_records = {}
    for p in papers:
        s2_id = s2_paper_id_for_paper(p, api_key=api_key)
        if s2_id:
            refs = s2_fetch_references(s2_id, api_key=api_key, limit=30)
            for r in refs:
                key = (r.get("doi") or r.get("title") or "").lower()
                if key:
                    ref_counts[key] = ref_counts.get(key, 0) + 1
                    ref_records[key] = r
    top = sorted(ref_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    res = [ref_records[k] for k, count in top if count >= 2]
    return {"ok": True, "seminalPapers": res}

def snowball_papers(payload):
    seeds = payload.get("seedPapers") or payload.get("papers") or []
    from pulse_core.discovery import fetch_citation_graph_branch
    cands = fetch_citation_graph_branch(seeds, depth="2")
    return {"ok": True, "snowball": cands}
