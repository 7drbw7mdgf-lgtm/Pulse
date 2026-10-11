import pulse_core as _core
import re
import copy
import math
import urllib.parse
from pulse_core.constants import ClientError
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key, resolve_core_api_key
from pulse_core.discovery_queries import build_query_plan, search_query_plan
from pulse_core.discovery_semantics import semantic_scores
from pulse_core.paper_identity import confident_candidate
from pulse_core.doi_utils import normalize_doi
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_utils import normalize_title_key, openalex_to_metadata
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates, normalized_reference_similarity, balanced_frontier
from pulse_core.search_limits import discovery_limit, SearchResults
from pulse_core.search_merge import merge_search_records
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
from pulse_performance import parallel_branches, parallel_lookup, DiscoveryCancelled, REQUEST_CONTEXT, check_cancelled


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
            work = fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
            if confident_candidate(paper,[openalex_to_metadata(work)]): return work
        except DiscoveryCancelled: raise
        except Exception:
            pass
    title = (paper.get("title") or "").strip()
    if title:
        try:
            params = urllib.parse.urlencode({"search": title, "per-page": 5})
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            results = data.get("results") or []
            metadata = [dict(openalex_to_metadata(work), _work=work) for work in results]
            match = confident_candidate(paper,metadata)
            if match: return match['_work']
        except DiscoveryCancelled: raise
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
    limit = discovery_limit(limit)
    recent = openalex_discovery_works(f"cites:{normalized}", max(1,(limit+1)//2), sort='publication_date:desc')
    established = openalex_discovery_works(f"cites:{normalized}", max(1,limit//2))
    # Retain raw works until their provider adapter runs; identity is OpenAlex ID.
    seen, gathered = set(), SearchResults()
    for rows in (recent, established):
        for item in rows:
            identity = item.get('id') or item.get('doi') or item.get('title')
            if identity and identity in seen: continue
            seen.add(identity);gathered.append(item)
    gathered.warning = ' · '.join(dict.fromkeys(getattr(rows,'warning','') for rows in (recent,established) if getattr(rows,'warning','')))
    return SearchResults(gathered[:limit]) if not gathered.warning else gathered


def openalex_discovery_works(work_filter, limit, sort='cited_by_count:desc'):
    limit = discovery_limit(limit)
    gathered = SearchResults()
    page_size = min(limit, 100)
    for page in range(1, (limit + page_size - 1) // page_size + 1):
        params = urllib.parse.urlencode({"filter": work_filter, "sort": sort,
                                       "per_page": page_size, "page": page})
        try:
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            rows = data.get("results") or []
        except ClientError as error:
            return gathered.keep_partial(error)
        gathered.extend(rows[:limit - len(gathered)])
        if len(rows) < page_size:
            break
    return gathered


def fetch_citation_graph_branch(seed_papers, api_key=None, include_iterative_chase=True, limit=30, depth=None):
    gathered = SearchResults()
    hop1_references = []
    hop1_citations = []
    per_seed = max(10, math.ceil(limit/max(1,len(seed_papers))))
    for seed_index, paper in enumerate(seed_papers[:24]):
        before = len(gathered)
        try: s2_id = _core.s2_paper_id_for_paper(paper, api_key=api_key)
        except DiscoveryCancelled: raise
        except Exception: s2_id = None
        if s2_id:
            try:
                refs = _core.s2_fetch_references(s2_id, api_key=api_key, limit=per_seed)
                refs = copy.deepcopy(refs)
                for rank,item in enumerate(refs,1): item.update(hop=1,branch='citationGraph',subType='Backward',retrievalEvidence=[{'channel':f'citations:{seed_index}:backward','rank':rank,'provider':'Semantic Scholar'}])
                gathered.extend(refs)
                hop1_references.extend(refs)
            except DiscoveryCancelled: raise
            except Exception:
                pass
            try:
                cites = _core.s2_fetch_citations(s2_id, api_key=api_key, limit=per_seed)
                cites = copy.deepcopy(cites)
                for rank,item in enumerate(cites,1): item.update(hop=1,branch='citationGraph',subType='Forward',retrievalEvidence=[{'channel':f'citations:{seed_index}:forward','rank':rank,'provider':'Semantic Scholar'}])
                gathered.extend(cites)
                hop1_citations.extend(cites)
            except DiscoveryCancelled: raise
            except Exception:
                pass

        if len(gathered) == before:
            work = _core.openalex_work_for_paper(paper)
            if work:
                work_id = openalex_work_id(work.get("id"))
                for ref_id, ref_work in parallel_lookup(fetch_openalex_work_by_id, (work.get("referenced_works") or [])[:per_seed]):
                    if not ref_work:
                        continue
                    try:
                        record = recommendation_record(*openalex_recommendation_item(ref_work), source="OpenAlex references")
                        record["branch"] = "citationGraph"
                        record["subType"] = "Backward"
                        record["retrievalEvidence"] = [{"channel":f"citations:{seed_index}:backward","rank":len(hop1_references)+1,"provider":"OpenAlex"}]
                        record["reason"] = "Backward citation: foundational reference cited by seed paper."
                        gathered.append(record)
                        hop1_references.append(record)
                    except DiscoveryCancelled: raise
                    except Exception:
                        continue
                citing_works = openalex_citing_works(work_id, limit=per_seed)
                if getattr(citing_works, "warning", ""):
                    gathered.warning = citing_works.warning
                for item in citing_works:
                    record = recommendation_record(*openalex_recommendation_item(item), source="OpenAlex citing papers")
                    record["branch"] = "citationGraph"
                    record["subType"] = "Forward"
                    record["retrievalEvidence"] = [{"channel":f"citations:{seed_index}:forward","rank":len(hop1_citations)+1,"provider":"OpenAlex"}]
                    record["reason"] = "Forward citation: downstream paper citing seed paper."
                    gathered.append(record)
                    hop1_citations.append(record)

    max_depth = 4 if str(depth) == "iterative" else max(1, min(int(depth or (2 if include_iterative_chase else 1)), 3))
    seen = {s2_paper_identifier(p) for p in seed_papers}
    frontier = [(p, "backward") for p in hop1_references] + [(p, "forward") for p in hop1_citations]
    for hop in range(2, max_depth + 1):
        next_frontier = []
        for direction in ("backward", "forward"):
            candidates = balanced_frontier([p for p,d in frontier if d==direction],seed_papers,4)
            for parent in candidates:
                key = s2_paper_identifier(parent)
                if not key or key in seen:
                    continue
                seen.add(key)
                try:
                    parent_id = _core.s2_paper_id_for_paper(parent, api_key=api_key)
                    if not parent_id:
                        continue
                    fetcher = _core.s2_fetch_references if direction == "backward" else _core.s2_fetch_citations
                    for item in fetcher(parent_id, api_key=api_key, limit=8):
                        item_key = s2_paper_identifier(item)
                        if item_key in seen:
                            continue
                        item.update(subType=f"Iterative Chase ({hop}-Hop)", hop=hop, chaseViaTitle=parent.get("title", ""), reason=f"Citation hop {hop} via {parent.get('title', '')[:80]}")
                        gathered.append(item)
                        next_frontier.append((item, direction))
                except DiscoveryCancelled: raise
                except Exception:
                    continue
        frontier = next_frontier
        if not frontier:
            break

    return gathered


def fetch_citation_network_branch(seed_papers, api_key=None, limit=30):
    gathered = SearchResults()
    per_seed = max(10, math.ceil(limit/max(1,len(seed_papers))))
    for seed_index, paper in enumerate(seed_papers[:24]):
        work = _core.openalex_work_for_paper(paper)
        if not work:
            continue
        work_id = openalex_work_id(work.get("id"))
        citing_works = openalex_citing_works(work_id, limit=max(per_seed, 20))
        if getattr(citing_works, "warning", ""):
            gathered.warning = citing_works.warning
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
                record["networkSimilarity"] = min(1, cocite_counts[ref_norm]/max(1,len(citing_works)))
                record["reason"] = f"Co-citation triangulation: cited together with seed paper by {cocite_counts[ref_norm]} citing papers."
                gathered.append(record)
            except DiscoveryCancelled: raise
            except Exception:
                continue

        seed_ref_ids = [openalex_work_id(r) for r in (work.get("referenced_works") or []) if openalex_work_id(r)]
        if len(seed_ref_ids) >= 2:
            try:
                coupled_works = openalex_discovery_works(f"cites:{'|'.join(seed_ref_ids[:4])}", max(per_seed, 20))
                if getattr(coupled_works, "warning", ""):
                    gathered.warning = coupled_works.warning
                for b_work in coupled_works:
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
                        record["networkSimilarity"] = normalized_reference_similarity(shared,len(seed_ref_ids),len(b_refs))
                        record["reason"] = f"Bibliographic coupling: shares {shared} foundational references with seed paper."
                        gathered.append(record)
            except DiscoveryCancelled: raise
            except Exception:
                pass
    return gathered


def fetch_semantic_search_branch(seed_papers, api_key=None, exclude_papers=None, limit=30):
    positive_ids = []
    for p in seed_papers:
        ident = _core.s2_paper_id_for_paper(p, api_key=api_key)
        if ident:
            positive_ids.append(ident)
    if not positive_ids:
        return []
    recs = s2_recommendations(positive_ids[:24], api_key=api_key, limit=limit)
    return [recommendation_record(r, {"score": 1.0, "reason": "S2 recommendations"}, "S2 Recommendations") for r in recs]


def fetch_conceptual_search_branch(seed_papers, api_key=None, steer_keywords=None, limit=30):
    query = " ".join(steer_keywords or [])
    if not query:
        query = " ".join(p.get("title", "") for p in seed_papers[:2])
    cands = s2_paper_search(query, api_key=api_key, limit=limit)
    records = SearchResults(recommendation_record(c, {"score": 1.0, "reason": "Conceptual search"}, "S2 Conceptual") for c in cands)
    records.warning = getattr(cands, "warning", "")
    return records


def run_discovery_pipeline(payload, on_progress=None, cancel_event=None):
    seed_papers = payload.get("seedPapers") or payload.get("papers") or []
    if not seed_papers:
        raise ClientError(400, "Select at least one seed paper to run the literature discovery pipeline.")
    settings = _core.load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {}
    steer_keywords = steering_terms(payload.get("steerKeywords") or payload.get("keywords") or [])
    exclude_keywords = steering_terms(payload.get("excludeKeywords") or [])
    limit = discovery_limit(payload.get("limit"))
    include_iterative = bool(payload.get("includeIterativeChase", True))
    tasks = {}
    if branches.get("citationGraph", True):
        tasks["citationGraph"] = lambda: _core.fetch_citation_graph_branch(seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get("depth"))
    if branches.get("citationNetwork", True):
        tasks["citationNetwork"] = lambda: fetch_citation_network_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get("semanticSearch", True):
        tasks["semanticSearch"] = lambda: fetch_semantic_search_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get("lexicalSearch", branches.get("lexicalConceptual", True)):
        sources = payload.get("searchSources") or {}
        query_plan = build_query_plan(seed_papers,steer_keywords,str(payload.get('researchQuestion') or '')[:1000])
        if sources.get("semanticScholar", True):
            tasks["lexicalConceptual"] = lambda: search_query_plan(query_plan,'semanticScholar',s2_paper_search,limit,api_key=api_key)
        def public_search(provider, searcher, **kwargs):
            records = search_query_plan(query_plan,provider,searcher,limit,structured=True,**kwargs)
            for record in records:
                record.update(branch="lexicalConceptual", subType="Conceptual search", isSeed=False,
                              reason="Keyword search via " + record["source"], discoveryBadges=[record["source"], "Concept search"])
            return records
        if sources.get("europePmc", True):
            tasks["europePmc"] = lambda: public_search("europePmc",_core.search_europe_pmc)
        if sources.get("core", True):
            tasks["core"] = lambda: public_search("core",_core.search_core, api_key=resolve_core_api_key(settings))
    options = {
        "steerKeywords": steer_keywords,
        "excludeKeywords": exclude_keywords,
        "strictExcludeKeywords": steering_terms(payload.get('strictExcludeKeywords') or []),
        "researchQuestion": str(payload.get('researchQuestion') or '')[:1000],
        "diversify": payload.get('diversify',True),
        "excludeDois": list(payload.get("excludeDois") or []) + [p.get("doi") for p in seed_papers if p.get("doi")],
        "excludeTitles": list(payload.get("excludeTitles") or []) + [p.get("title") for p in seed_papers if p.get("title")],
        "recencyTilt": payload.get("recencyTilt") or 0,
        "impactTilt": payload.get("impactTilt") or 0,
        "limit": limit,
    }
    def source_errors(results, errors):
        return {**errors, **{name: records.warning for name, records in results.items() if getattr(records, "warning", "")}}
    def progress(results, completed, errors, total):
        if on_progress:
            ordered = {name: results.get(name, []) for name in tasks}
            on_progress({
                "recommendations": merge_and_rank_pipeline_candidates(ordered, seed_papers, options),
                "branchesExecuted": [name for name in tasks if name in completed],
                "errors": source_errors(results, errors),
                "completed": len(completed) + len(errors),
                "total": total,
            })
    if on_progress:
        on_progress({"total": len(tasks)})
    results, executed, errors = parallel_branches(tasks, progress, cancel_event)
    ordered = {name: results.get(name, []) for name in tasks}
    if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
    if on_progress: on_progress({'stage':'ranking','completed':len(executed)+len(errors),'total':len(tasks)})
    REQUEST_CONTEXT.cancel_event = cancel_event
    try:
        if payload.get('semanticRerank', True):
            options['_semanticReranker'] = lambda queries,records: semantic_scores(settings,queries,records,cancel_event,focus_first=bool(options['researchQuestion']))
        ranked = merge_and_rank_pipeline_candidates(ordered,seed_papers,options)
        check_cancelled()
    finally:
        REQUEST_CONTEXT.cancel_event = None
    return {
        "ok": True,
        "provider": "Pulse literature discovery",
        "stage":"complete",
        "rankingNotice": options.get('_rankingNotice'),
        "queryPlan": build_query_plan(seed_papers,steer_keywords,options['researchQuestion']),
        "sourceCounts": {name:len(rows) for name,rows in results.items()},
        "queriesExecuted": {name:getattr(rows,"queries_executed",[]) for name,rows in results.items()},
        "seedCount": len(seed_papers),
        "branchesExecuted": executed,
        "recommendations": ranked,
        "errors": source_errors(results, errors),
        "limit": limit,
        "completed": len(executed) + len(errors),
        "total": len(tasks),
    }


def iterative_citation_chase(payload):
    seeds = payload.get("seedPapers") or []
    return {"ok": True, "results": _core.fetch_citation_graph_branch(seeds, depth="iterative")}


def citation_network_triangulation(payload):
    seeds = payload.get("seedPapers") or []
    return {"ok": True, "results": fetch_citation_network_branch(seeds)}
