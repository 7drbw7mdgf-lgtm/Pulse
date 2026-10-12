from pulse_source_health import cooldowns
import pulse_core as _core
import re
import copy
import math
import queue
import threading
import time
import urllib.parse
from pulse_core.constants import ClientError
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key, resolve_core_api_key
from pulse_core.discovery_queries import build_query_plan, search_query_plan
from pulse_core.discovery_semantics import semantic_scores, pre_embed_papers
from pulse_core.discovery_crossencoder import crossencoder_scores
from pulse_core.discovery_feedback import feedback_for_context
from pulse_core.discovery_bridges import bridge_queries, distinct_seeds
from pulse_core.research_models import triage
from pulse_core.passages import search_fulltext_library
from pulse_core.paper_identity import confident_candidate
from pulse_core.doi_utils import normalize_doi
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_utils import normalize_title_key, openalex_to_metadata
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates, normalized_reference_similarity, balanced_frontier, SEMANTIC_SHORTLIST_LIMIT
from pulse_core.discovery_queries import text_for_paper
from pulse_core.search_limits import discovery_limit, candidate_limit, SearchResults
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
from pulse_performance import parallel_branches, parallel_lookup, DiscoveryCancelled, REQUEST_CONTEXT, check_cancelled, publish_partial, DiscoveryBudgetExceeded


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
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
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
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception:
            pass
    return None


def fetch_openalex_work_by_id(work_id):
    normalized = openalex_work_id(work_id)
    if not normalized:
        raise ClientError(400, "No OpenAlex work ID was provided.")
    return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote(normalized, safe='')}")


def fetch_openalex_works_batch(work_ids):
    clean_ids = [openalex_work_id(w) for w in work_ids if openalex_work_id(w)]
    if not clean_ids:
        return []
    results = []
    chunk_size = 100
    for i in range(0, len(clean_ids), chunk_size):
        chunk = clean_ids[i:i + chunk_size]
        filter_arg = "openalex_id:" + "|".join(chunk)
        params = urllib.parse.urlencode({"filter": filter_arg, "per-page": len(chunk)})
        try:
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            results.extend(data.get("results") or [])
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception:
            continue
    return results


def openalex_reference_works(work_id, limit=20, referenced_works=None):
    normalized = openalex_work_id(work_id)
    if not normalized:
        return []
    limit = discovery_limit(limit)
    gathered = SearchResults()
    try:
        rows = openalex_discovery_works(f"cited_by:{normalized}", limit, sort="cited_by_count:desc")
        if rows:
            gathered.extend(rows)
            if getattr(rows, "warning", ""):
                gathered.warning = rows.warning
            return gathered
    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
    except Exception as error:
        gathered.warning = str(error)

    if referenced_works:
        clean_ids = [openalex_work_id(w) for w in referenced_works if openalex_work_id(w)][:limit]
        if clean_ids:
            try:
                batch_rows = fetch_openalex_works_batch(clean_ids)
                gathered.extend(batch_rows[:limit])
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception as error:
                gathered.warning = " · ".join(filter(None, [gathered.warning, str(error)]))
    return gathered


def openalex_citing_works(work_id, limit=12):
    normalized = openalex_work_id(work_id)
    if not normalized:
        return []
    limit = discovery_limit(limit)
    seen, gathered, warnings = set(), SearchResults(), []
    streams = [('publication_date:desc', max(1, (limit+1)//2)),
               ('cited_by_count:desc', max(1, limit//2))]
    for sort, size in streams:
        try:
            rows = openalex_discovery_works(f"cites:{normalized}", size, sort=sort)
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception as error:
            warnings.append(f'OpenAlex {sort}: {error}')
            continue
        if getattr(rows, 'warning', ''): warnings.append(rows.warning)
        for item in rows:
            identity = item.get('id') or item.get('doi') or item.get('title')
            if identity and identity in seen: continue
            seen.add(identity)
            if len(gathered) < limit: gathered.append(item)
    gathered.warning = ' · '.join(dict.fromkeys(warnings))
    return gathered


def openalex_discovery_works(work_filter, limit, sort='cited_by_count:desc', max_page_size=None):
    limit = discovery_limit(limit)
    gathered = SearchResults()
    cap = max_page_size or (200 if work_filter.startswith('cited_by:') else 100)
    page_size = min(limit, cap)
    for page in range(1, (limit + page_size - 1) // page_size + 1):
        params = urllib.parse.urlencode({"filter": work_filter, "sort": sort,
                                       "per-page": page_size, "per_page": page_size, "page": page})
        try:
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            rows = data.get("results") or []
        except (ClientError, DiscoveryBudgetExceeded) as error:
            return gathered.keep_partial(error)
        gathered.extend(rows[:limit - len(gathered)])
        if len(rows) < page_size:
            break
    return gathered


def fetch_citation_graph_branch(seed_papers, api_key=None, include_iterative_chase=False, limit=30, depth=None):
    gathered = SearchResults()
    hop1_references = []
    hop1_citations = []
    per_seed = max(10, math.ceil(limit/max(1,len(seed_papers))))
    for seed_index, paper in enumerate(seed_papers[:24]):
        refs, cites = [], []
        try: s2_id = _core.s2_paper_id_for_paper(paper, api_key=api_key)
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception: s2_id = None
        if s2_id:
            try:
                cites = _core.s2_fetch_citations(s2_id, api_key=api_key, limit=per_seed)
                cites = copy.deepcopy(cites)
                for rank,item in enumerate(cites,1): item.update(hop=1,branch='citationGraph',subType='Forward',retrievalEvidence=[{'channel':f'citations:{seed_index}:forward','rank':rank,'provider':'Semantic Scholar'}])
                gathered.extend(cites)
                publish_partial(copy.deepcopy(gathered))
                hop1_citations.extend(cites)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception:
                pass
            try:
                refs = _core.s2_fetch_references(s2_id, api_key=api_key, limit=per_seed)
                refs = copy.deepcopy(refs)
                for rank,item in enumerate(refs,1): item.update(hop=1,branch='citationGraph',subType='Backward',retrievalEvidence=[{'channel':f'citations:{seed_index}:backward','rank':rank,'provider':'Semantic Scholar'}])
                gathered.extend(refs)
                publish_partial(copy.deepcopy(gathered))
                hop1_references.extend(refs)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception:
                pass

        need_citations = not cites or bool(getattr(cites, 'warning', ''))
        need_references = not refs or bool(getattr(refs, 'warning', ''))
        if need_citations or need_references:
            try:
                work = _core.openalex_work_for_paper(paper)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception as error:
                gathered.warning = str(error)
                continue
            if not work:
                continue
            work_id = openalex_work_id(work.get("id"))
            # Fetch citing papers first: downstream papers citing the seed arrive early
            if need_citations:
                try:
                    citing_works = openalex_citing_works(work_id, limit=per_seed)
                    if getattr(citing_works, "warning", ""):
                        gathered.warning = ' · '.join(filter(None, [gathered.warning, citing_works.warning]))
                    for rank, item in enumerate(citing_works, 1):
                        record = recommendation_record(*openalex_recommendation_item(item), source="OpenAlex citing papers")
                        record.update(branch="citationGraph", subType="Forward", hop=1,
                                      retrievalEvidence=[{"channel":f"citations:{seed_index}:forward","rank":rank,"provider":"OpenAlex"}],
                                      reason="Forward citation: downstream paper citing seed paper.")
                        gathered.append(record)
                        hop1_citations.append(record)
                        if len(gathered) % 10 == 1: publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception as error:
                    gathered.warning = ' · '.join(filter(None, [gathered.warning, 'OpenAlex citing papers: ' + str(error)]))
            # References fallback uses cited_by:{seed} sorted by citations first, with batch fallback
            if need_references:
                try:
                    ref_works = openalex_reference_works(work_id, limit=per_seed, referenced_works=work.get("referenced_works") or [])
                    if getattr(ref_works, "warning", ""):
                        gathered.warning = ' · '.join(filter(None, [gathered.warning, ref_works.warning]))
                    for rank, ref_work in enumerate(ref_works, 1):
                        record = recommendation_record(*openalex_recommendation_item(ref_work), source="OpenAlex references")
                        record.update(branch="citationGraph", subType="Backward", hop=1,
                                      retrievalEvidence=[{"channel":f"citations:{seed_index}:backward","rank":rank,"provider":"OpenAlex"}],
                                      reason="Backward citation: foundational reference cited by seed paper.")
                        gathered.append(record)
                        hop1_references.append(record)
                        if len(gathered) % 10 == 1: publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception as error:
                    gathered.warning = ' · '.join(filter(None, [gathered.warning, 'OpenAlex references: ' + str(error)]))

    max_depth = 4 if str(depth) == "iterative" else max(1, min(int(depth or (2 if include_iterative_chase else 1)), 3))
    if max_depth == 1:
        return gathered
    # Extra hops share eight seconds, including provider waits and retries. The
    # transport clips socket timeouts to this deadline and preserves hop-one work.
    previous_deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
    extra_deadline = time.monotonic() + 8
    REQUEST_CONTEXT.deadline = min(previous_deadline, extra_deadline) if previous_deadline else extra_deadline
    try:
        _collect_extra_hops(seed_papers, hop1_references, hop1_citations, gathered, max_depth, api_key)
    except DiscoveryBudgetExceeded:
        gathered.notices.append({
            'code': 'extra-hop-limit',
            'message': 'Additional citation hops stopped at the time budget; direct citations and collected results are retained.',
        })
    finally:
        REQUEST_CONTEXT.deadline = previous_deadline
    return gathered


def _collect_extra_hops(seed_papers, hop1_references, hop1_citations, gathered, max_depth, api_key):
    seen = {s2_paper_identifier(p) for p in seed_papers}
    frontier = [(p, "backward") for p in hop1_references] + [(p, "forward") for p in hop1_citations]
    for hop in range(2, max_depth + 1):
        next_frontier = []
        for direction in ("backward", "forward"):
            candidates = balanced_frontier([p for p,d in frontier if d==direction],seed_papers,4)
            for parent in candidates:
                check_cancelled()
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
                    publish_partial(copy.deepcopy(gathered))
                    check_cancelled()
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception:
                    continue
        frontier = next_frontier
        if not frontier:
            break

def fetch_citation_network_branch(seed_papers, api_key=None, limit=30):
    # Keep the existing API/workspace key while replacing both legacy network
    # searches with the supplied content-aware DBEF shared-reference method.
    from pulse_core.dbef_discovery import fetch_dbef_branch
    return fetch_dbef_branch(seed_papers, api_key=api_key, limit=limit)


def fetch_semantic_search_branch(seed_papers, api_key=None, exclude_papers=None, limit=30, feedback=None):
    positive_ids = []
    for p in seed_papers:
        ident = _core.s2_paper_id_for_paper(p, api_key=api_key)
        if ident:
            positive_ids.append(ident)
    if not positive_ids:
        return []
    negative_ids = []
    for row in feedback or []:
        ident = s2_paper_identifier(row['paper'])
        if ident:
            if row['grade'] > 0: positive_ids.append(ident)
            else: negative_ids.append(ident)
    recs = s2_recommendations(list(dict.fromkeys(positive_ids))[:24], negative_ids=list(dict.fromkeys(negative_ids))[:24], api_key=api_key, limit=limit)
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
    if payload.get('bridgeMode') and len(distinct_seeds(seed_papers)) < 2:
        raise ClientError(400, 'Select at least two different seed papers to find bridge papers.')
    if payload.get('bridgeMode') and len(distinct_seeds(seed_papers)) > 8:
        raise ClientError(400, 'Use up to eight different seed papers for one bridge search.')
    started = time.monotonic()
    settings = _core.load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {}
    steer_keywords = steering_terms(payload.get("steerKeywords") or payload.get("keywords") or [])
    exclude_keywords = steering_terms(payload.get("excludeKeywords") or [])
    limit = discovery_limit(payload.get("limit"))
    include_iterative = bool(payload.get("includeIterativeChase", False))
    feedback = feedback_for_context(payload, seed_papers)
    retrieval_limit = candidate_limit(limit)
    query_plan = []
    tasks = {}
    if payload.get('fullTextSearch'):
        fulltext_query = str(payload.get('researchQuestion') or ' '.join(str(p.get('title') or '') for p in seed_papers[:8]))
        tasks['fullText'] = lambda: search_fulltext_library(fulltext_query, retrieval_limit)
    if branches.get("citationGraph", True):
        tasks["citationGraph"] = lambda: _core.fetch_citation_graph_branch(seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get("depth"))
    if branches.get("citationNetwork", True):
        tasks["citationNetwork"] = lambda: fetch_citation_network_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get("semanticSearch", True):
        tasks["semanticSearch"] = lambda: fetch_semantic_search_branch(seed_papers, api_key=api_key, limit=limit, feedback=feedback)
    if branches.get("lexicalSearch", branches.get("lexicalConceptual", True)):
        sources = payload.get("searchSources") or {}
        query_plan = build_query_plan(seed_papers,steer_keywords,str(payload.get('researchQuestion') or '')[:1000],feedback)
        if payload.get('bridgeMode'):
            focused = bridge_queries(seed_papers)
            query_plan = focused + query_plan
        if sources.get("semanticScholar", True):
            tasks["lexicalConceptual"] = lambda: search_query_plan(query_plan,'semanticScholar',s2_paper_search,retrieval_limit,api_key=api_key)
        def public_search(provider, searcher, **kwargs):
            previous_deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
            if provider in ('core', 'europePmc'):
                deadline = time.monotonic() + 8
                REQUEST_CONTEXT.deadline = min(previous_deadline, deadline) if previous_deadline else deadline
            try:
                records = search_query_plan(query_plan,provider,searcher,retrieval_limit,structured=True,**kwargs)
            finally:
                REQUEST_CONTEXT.deadline = previous_deadline
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
        "citationVelocityPrior": payload.get("citationVelocityPrior", True),
        "foundationalPrior": payload.get("foundationalPrior", True),
        "limit": limit,
        "relevanceFeedback": feedback,
        "_matchCalibration": settings.get('searchMatchCalibration'),
        "bridgeMode": bool(payload.get('bridgeMode')),
        "_originalSeeds": seed_papers,
    }
    fast_mode = bool(payload.get('fastEmbed'))
    semantic_enabled = bool(payload.get('semanticRerank', True))
    # Keep the latest shortlist, rather than a backlog of hundreds of papers
    # that will never reach the neural stage. Text-keyed cache claims are shared
    # with foreground ranking so an unfinished warmup cannot duplicate requests.
    embed_queue = queue.Queue(maxsize=1)
    embed_stop = threading.Event()
    embed_queries = ([options['researchQuestion']] if options['researchQuestion'] else []) + [text_for_paper(p) for p in seed_papers]
    if steer_keywords: embed_queries.append(' '.join(steer_keywords))

    def queue_embeddings(records):
        try:
            embed_queue.get_nowait()
        except queue.Empty:
            pass
        embed_queue.put_nowait(records)

    def embed_collector_worker():
        while not embed_stop.is_set():
            if cancel_event and cancel_event.is_set():
                break
            try:
                batch = embed_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if batch or embed_queries:
                try:
                    pre_embed_papers(settings, batch, cancel_event, fast_mode=fast_mode,
                                     queries=embed_queries, stop_event=embed_stop)
                except Exception:
                    pass

    embed_thread = None
    if semantic_enabled:
        embed_thread = threading.Thread(target=embed_collector_worker, name="pulse-embed-collector", daemon=True)
        embed_thread.start()
        queue_embeddings([])  # Warm the exact question and seed queries immediately.

    def contributions(results):
        providers={}
        for rows in results.values():
            for paper in rows:
                names=set(paper.get('sourceList') or [])
                names.update(e.get('provider') for e in paper.get('retrievalEvidence') or [] if e.get('provider'))
                if not names and paper.get('metadataSource'): names.add(paper['metadataSource'])
                for name in names:
                    providers.setdefault(name,set()).add(str(paper.get('doi') or paper.get('openalexId') or paper.get('title')))
        return {name:len(ids) for name,ids in providers.items()}
    last_progress_rank=[0,0]
    def source_errors(results, errors):
        return {**errors, **{name: records.warning for name, records in results.items() if getattr(records, "warning", "")}}
    def source_notices(results):
        return {name: records.notices for name, records in results.items() if getattr(records, "notices", None)}
    def progress(results, completed, errors, total):
        if not on_progress and not (embed_thread and embed_thread.is_alive()):
            return
        ordered = {name: results.get(name, []) for name in tasks}
        now=time.monotonic()
        should_rank=last_progress_rank[0]==0 or now-last_progress_rank[0]>=.6 or len(completed)+len(errors)!=last_progress_rank[1]
        ranked=merge_and_rank_pipeline_candidates(ordered,seed_papers,dict(options,limit=min(limit,150))) if should_rank else None
        if should_rank:last_progress_rank[:]=[now,len(completed)+len(errors)]
        if ranked is not None and embed_thread and embed_thread.is_alive():
            queue_embeddings(ranked[:SEMANTIC_SHORTLIST_LIMIT])
        if on_progress:
            on_progress({
                **({"recommendations":ranked[:min(limit,100)]} if ranked is not None else {}),
                "availableCount": sum(len(rows) for rows in ordered.values()),
                "branchesExecuted": [name for name in tasks if name in completed],
                "errors": source_errors(results, errors),
                "notices": source_notices(results),
                "sourceCounts": {name: len(rows) for name, rows in results.items()},
                "sourceCooldowns": cooldowns(),
                "providerContributions": contributions(results),
                "dbef": getattr(results.get('citationNetwork'), 'dbef_summary', {}),
                "completed": len(completed) + len(errors),
                "total": total,
            })
    if on_progress:
        on_progress({"total": len(tasks)})
    try:
        results, executed, errors = parallel_branches(tasks, progress, cancel_event)
    finally:
        if embed_thread:
            embed_stop.set()
            # Any current request is reused through the inference lock below;
            # no unconditional 1.5-second join is added to final ranking.
            embed_thread.join(timeout=.05)
    retrieval_seconds = time.monotonic()-started
    ordered = {name: results.get(name, []) for name in tasks}
    if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
    if on_progress: on_progress({'stage':'ranking','completed':len(executed)+len(errors),'total':len(tasks)})
    REQUEST_CONTEXT.cancel_event = cancel_event
    try:
        if payload.get('semanticRerank', True):
            options['_semanticReranker'] = lambda queries,records: semantic_scores(
                settings, queries, records, cancel_event,
                focus_first=bool(options['researchQuestion']),
                fast_mode=fast_mode
            )
        if payload.get('pairwiseRerank', True):
            options['_pairwiseReranker'] = lambda queries,records: crossencoder_scores(settings,queries,records,cancel_event)
        if payload.get('aiTriage'):
            question = options['researchQuestion'] or 'Related research to: '+ '; '.join(str(p.get('title') or '') for p in seed_papers[:8])
            options['_aiTriage'] = lambda records: triage(records,question,settings,cancel_event)
        ranked = merge_and_rank_pipeline_candidates(ordered,seed_papers,options)
        check_cancelled()
    finally:
        REQUEST_CONTEXT.cancel_event = None
    return {
        "ok": True,
        "provider": "Pulse literature discovery",
        "stage":"complete",
        "rankingNotice": options.get('_rankingNotice'),
        "queryPlan": query_plan,
        "candidateCount": options.get('_candidateCount', len(ranked)),
        "retrievalLimitPerSource": retrieval_limit,
        "feedbackApplied": len(feedback),
        "bridgeCount": sum(p.get('isBridge', False) for p in ranked),
        "bridgeMode": bool(payload.get('bridgeMode')),
        "aiReviewedCount": options.get('_aiReviewedCount', 0),
        "pairwiseRankingNotice": options.get('_pairwiseNotice'),
        "semanticRankedCount": options.get('_semanticCount', 0),
        "pairwiseRankedCount": options.get('_pairwiseCount', 0),
        "matchCalibration": options.get('_calibrationApplied') or 'evidence-based',
        "timings": {'retrievalSeconds': round(retrieval_seconds,3), 'totalSeconds': round(time.monotonic()-started,3),
                    **options.get('_rankingTimings', {})},
        "sourceCounts": {name:len(rows) for name,rows in results.items()},
        "sourceCooldowns": cooldowns(),
        "providerContributions": contributions(results),
        "queriesExecuted": {name:getattr(rows,"queries_executed",[]) for name,rows in results.items()},
        "dbef": getattr(results.get("citationNetwork"), "dbef_summary", {}),
        "seedCount": len(seed_papers),
        "branchesExecuted": executed,
        "recommendations": ranked,
        "errors": source_errors(results, errors),
        "notices": source_notices(results),
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
