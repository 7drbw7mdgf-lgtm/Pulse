from pulse_source_health import cooldowns
import collections
import pulse_core as _core
import re
import copy
import math
import queue
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import urllib.parse
import urllib.request
from pulse_core.constants import ClientError, APP_VERSION
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key, resolve_core_api_key
from pulse_core.discovery_queries import build_query_plan, search_query_plan
from pulse_core.concept_search import validate_discovery_request, prepare_concept_search, concept_query_plan
from pulse_core.discovery_semantics import semantic_scores, pre_embed_papers
from pulse_core.discovery_crossencoder import crossencoder_scores, pre_score_crossencoder
from pulse_core.discovery_feedback import feedback_for_context
from pulse_core.discovery_bridges import bridge_queries, distinct_seeds, prepare_bridge_concept
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
from pulse_performance import parallel_branches, parallel_lookup, DiscoveryCancelled, REQUEST_CONTEXT, check_cancelled, publish_partial, DiscoveryBudgetExceeded, submit_with_context


def openalex_work_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"\bW\d+\b", text)
    return match.group(0) if match else ""


def openalex_work_for_paper(paper):
    ident = openalex_work_id(paper.get('openAlexId') or paper.get('openalexId'))
    if ident:
        try:
            work = fetch_openalex_work_by_id(ident)
            if confident_candidate(paper, [openalex_to_metadata(work)]): return work
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception: pass
    doi = normalize_doi(paper.get("doi") or "")
    if doi:
        try:
            work = fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}?select={OPENALEX_WORK_SELECT}")
            if confident_candidate(paper,[openalex_to_metadata(work)]): return work
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception:
            pass
    title = (paper.get("title") or "").strip()
    if title:
        try:
            params = urllib.parse.urlencode({"search": title, "per-page": 5, "select": OPENALEX_WORK_SELECT})
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
    return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote(normalized, safe='')}?select={OPENALEX_WORK_SELECT}")


_WARM_LOCK = threading.Lock()
# A live search always wins: starting one cancels any selection pre-warm, and
# no pre-warm starts while a search is running.
_WARM_CANCEL = threading.Event()
_ACTIVE_SEARCHES = [0]
_ACTIVE_LOCK = threading.Lock()


PREWARM_MAX_PER_HOUR = 10
# Keep this much of the OpenAlex daily allowance for searches the user actually runs.
PREWARM_MIN_OPENALEX_ALLOWANCE = 300
_PREWARM_TIMES = collections.deque()


def warm_paper_discovery(paper, options=None):
    """Run a search's collection step in the background for a selected paper.

    Pre-warm uses exactly the requests the real search will make (same seeds,
    options and query plan), so a search started a few seconds later is served
    from the HTTP cache, and the embedding and cross-encoder caches are filled
    for the same shortlist. It never runs during a live search, is skipped
    while OpenAlex is rate-limited, and is capped per hour so browsing papers
    cannot exhaust the daily OpenAlex allowance.
    """
    if not paper or not isinstance(paper, dict): return False
    with _ACTIVE_LOCK:
        if _ACTIVE_SEARCHES[0]: return False
    if cooldowns().get('OpenAlex'): return False
    from pulse_performance import openalex_allowance_remaining
    allowance = openalex_allowance_remaining()
    if allowance is not None and allowance < PREWARM_MIN_OPENALEX_ALLOWANCE: return False
    now = time.monotonic()
    with _ACTIVE_LOCK:
        while _PREWARM_TIMES and now - _PREWARM_TIMES[0] > 3600: _PREWARM_TIMES.popleft()
        if len(_PREWARM_TIMES) >= PREWARM_MAX_PER_HOUR: return False
    if not _WARM_LOCK.acquire(blocking=False):
        return False
    _WARM_CANCEL.clear()
    try:
        with _ACTIVE_LOCK: _PREWARM_TIMES.append(now)
        payload = {key: value for key, value in (options or {}).items()
                   if key not in ('seedPapers', 'papers', 'searchMode', 'query', '_collectOnly')}
        # A single selected paper: bridge searches need two or more seeds.
        payload.update(seedPapers=[paper], bridgeMode=False, _collectOnly=True)
        _run_discovery_pipeline(payload, cancel_event=_WARM_CANCEL)
        return True
    except Exception:
        return False
    finally:
        _WARM_LOCK.release()



OPENALEX_WORK_SELECT = 'id,doi,title,authorships,primary_location,publication_year,abstract_inverted_index,cited_by_count,referenced_works,referenced_works_count,counts_by_year,primary_topic,is_retracted,biblio,publication_date,type,language'


def fetch_openalex_works_batch(work_ids, select=OPENALEX_WORK_SELECT):
    from pulse_core.openalex_cache import cached_batch
    clean_ids = list(dict.fromkeys(openalex_work_id(value) for value in work_ids if openalex_work_id(value)))
    if not clean_ids: return SearchResults()
    clean_set = set(clean_ids)
    found = cached_batch(clean_ids, select)
    missing = [ident for ident in clean_ids if ident not in found]
    groups = [missing[i:i+100] for i in range(0, len(missing), 100)]
    warnings = []
    def fetch_group(group):
        params = {'filter':'openalex_id:'+'|'.join(group), 'per-page':len(group)}
        if select: params['select'] = select
        return _core.fetch_json('https://api.openalex.org/works?'+urllib.parse.urlencode(params)).get('results') or []
    if groups:
        with ThreadPoolExecutor(max_workers=min(4, len(groups)), thread_name_prefix='pulse-reference-batch') as executor:
            futures = [submit_with_context(executor, fetch_group, group) for group in groups]
            for future in as_completed(futures):
                try:
                    for work in future.result():
                        ident = openalex_work_id(work.get('id'))
                        if ident in clean_set: found[ident] = work
                except DiscoveryCancelled: raise
                except Exception as error: warnings.append(str(error))
    result = SearchResults(found[ident] for ident in clean_ids if ident in found)
    if len(result) < len(clean_ids): warnings.append(f'Reference metadata available for {len(result)} of {len(clean_ids)} indexed works.')
    result.warning = ' · '.join(dict.fromkeys(warnings))
    return result


def citation_neighborhood_limit(limit, seed_count=1):
    # Graph and co-citation use identical streams, sharing cache and in-flight GETs.
    return max(80, min(400, math.ceil(discovery_limit(limit)/max(1, seed_count))))


def openalex_reference_works(work_id, limit=20, referenced_works=None):
    normalized = openalex_work_id(work_id)
    if not normalized: return SearchResults()
    if referenced_works:
        # The resolved work already carries the full outgoing ID list. Hydrate
        # every ID in parallel batches rather than run another capped filter.
        rows = fetch_openalex_works_batch(referenced_works)
        if rows: return rows
    return openalex_discovery_works(f'cited_by:{normalized}', 2000, sort='cited_by_count:desc')


def opencitations_citing_dois(doi, limit=30):
    doi_clean = normalize_doi(doi or "")
    if not doi_clean:
        return []
    url = f"https://api.opencitations.net/index/v2/citations/doi:{urllib.parse.quote(doi_clean, safe='')}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"},
        method="GET",
    )
    try:
        from pulse_performance import request_json
        data = request_json(request, timeout=8, cache=True)
        if not isinstance(data, list):
            return []
        dois = []
        for row in data:
            citing_str = str(row.get("citing") or "")
            match = re.search(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b", citing_str)
            if match:
                dois.append(match.group(0).lower().rstrip("."))
            if len(dois) >= limit:
                break
        return list(dict.fromkeys(dois))
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        return []


def opencitations_referenced_dois(doi, limit=30):
    doi_clean = normalize_doi(doi or "")
    if not doi_clean:
        return []
    url = f"https://api.opencitations.net/index/v2/references/doi:{urllib.parse.quote(doi_clean, safe='')}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"},
        method="GET",
    )
    try:
        from pulse_performance import request_json
        data = request_json(request, timeout=8, cache=True)
        if not isinstance(data, list):
            return []
        dois = []
        for row in data:
            cited_str = str(row.get("cited") or "")
            match = re.search(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b", cited_str)
            if match:
                dois.append(match.group(0).lower().rstrip("."))
            if len(dois) >= limit:
                break
        return list(dict.fromkeys(dois))
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        return []


def openalex_works_by_dois(dois):
    """Metadata for DOI lists (e.g. from OpenCitations) in batched, URL-encoded OpenAlex requests."""
    works = []
    clean = list(dict.fromkeys(d for d in (normalize_doi(value or '').lower() for value in dois) if d))
    for start in range(0, len(clean), 100):
        group = clean[start:start + 100]
        query = urllib.parse.urlencode({'filter': 'doi:' + '|'.join(group), 'per-page': len(group),
                                        'select': OPENALEX_WORK_SELECT})
        works.extend(_core.fetch_json('https://api.openalex.org/works?' + query).get('results') or [])
    return works


def openalex_citing_works(work_id, limit=12):
    normalized = openalex_work_id(work_id)
    if not normalized:
        return []
    limit = discovery_limit(limit)
    seen, gathered, warnings = set(), SearchResults(), []
    streams = [('publication_date:desc', max(1, (limit+1)//2)),
               ('cited_by_count:desc', max(1, limit//2))]
    event = getattr(REQUEST_CONTEXT, 'cancel_event', None)
    deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
    counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
    def fetch_stream(sort, size):
        REQUEST_CONTEXT.cancel_event = event
        REQUEST_CONTEXT.deadline = deadline
        REQUEST_CONTEXT.request_counter = counter
        try:
            return openalex_discovery_works(f"cites:{normalized}", size, sort=sort)
        finally:
            REQUEST_CONTEXT.cancel_event = None
            REQUEST_CONTEXT.deadline = None
            REQUEST_CONTEXT.request_counter = None
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [submit_with_context(executor, fetch_stream, sort, size) for sort, size in streams]
        for future in futures:
            try:
                rows = future.result()
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception as error:
                warnings.append(f'OpenAlex citation stream: {error}')
                continue
            if getattr(rows, 'warning', ''): warnings.append(rows.warning)
            for item in rows:
                identity = item.get('id') or item.get('doi') or item.get('title')
                if identity and identity in seen: continue
                seen.add(identity)
                if len(gathered) < limit: gathered.append(item)
    gathered.warning = ' · '.join(dict.fromkeys(warnings))
    return gathered


def openalex_discovery_works(work_filter, limit, sort='cited_by_count:desc', max_page_size=None, select=OPENALEX_WORK_SELECT):
    limit = discovery_limit(limit)
    gathered = SearchResults()
    cap = max_page_size or 200
    page_size = min(limit, cap)
    for page in range(1, (limit + page_size - 1) // page_size + 1):
        query_dict = {"filter": work_filter, "sort": sort,
                      "per-page": page_size, "per_page": page_size, "page": page}
        if select: query_dict["select"] = select
        params = urllib.parse.urlencode(query_dict)
        try:
            data = fetch_json(f"https://api.openalex.org/works?{params}")
            rows = data.get("results") or []
        except (ClientError, DiscoveryBudgetExceeded) as error:
            return gathered.keep_partial(error)
        gathered.extend(rows[:limit - len(gathered)])
        total = (data.get('meta') or {}).get('count')
        if isinstance(total, int) and total >= 0:
            gathered.total_count = total
            if len(gathered) >= total: break
            if len(gathered) >= limit and work_filter.startswith('cited_by:'):
                gathered.warning = f'Loaded {len(gathered)} of {total} indexed references; the remaining references exceeded this search budget.'
        if len(rows) < page_size:
            break
    return gathered


# Europe PMC's documented REST API (europepmc.org/RestPortal answers 403).
EUROPE_PMC_REST = 'https://www.ebi.ac.uk/europepmc/webservices/rest'


def europepmc_pmid_for_doi(doi):
    doi_clean = normalize_doi(doi or "")
    if not doi_clean:
        return None
    url = f"{EUROPE_PMC_REST}/search?" + urllib.parse.urlencode({"query": f'DOI:"{doi_clean}"', "format": "json", "pageSize": 5})
    req = urllib.request.Request(url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
    try:
        from pulse_performance import request_json
        data = request_json(req, timeout=8, cache=True)
        results = (data.get("resultList") or {}).get("result") or []
        for r in results:
            pmid = str(r.get("pmid") or "").strip()  # non-MEDLINE ids are not PMIDs
            if pmid:
                return pmid
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        pass
    return None


def europepmc_to_metadata(item):
    from pulse_core.metadata_utils import clean_crossref_text
    title = clean_crossref_text(item.get("title") or "")
    author_string = item.get("authorString") or ""
    authors = [a.strip() for a in author_string.split(",") if a.strip()] if author_string else []
    year = str(item.get("pubYear") or "")
    doi = normalize_doi(item.get("doi") or "")
    pmid = str(item.get("pmid") or item.get("id") or "")
    journal = item.get("journalTitle") or ""
    citation_count = None
    if item.get("citedByCount") is not None:
        try: citation_count = int(item.get("citedByCount"))
        except (ValueError, TypeError): pass
    return {
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
        "doi": doi,
        "pmid": pmid,
        "citationCount": citation_count,
        "metadataSource": "Europe PMC",
    }


def europepmc_citing_papers(pmid, limit=30):
    pmid_clean = str(pmid or "").strip()
    if not pmid_clean:
        return []
    limit = discovery_limit(limit)
    url = f"{EUROPE_PMC_REST}/MED/{urllib.parse.quote(pmid_clean, safe='')}/citations?format=json&pageSize={min(limit, 100)}"
    req = urllib.request.Request(url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
    try:
        from pulse_performance import request_json
        data = request_json(req, timeout=10, cache=True)
        items = (data.get("citationList") or {}).get("citation") or []
        return items[:limit]
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        return []


def europepmc_reference_papers(pmid, limit=30):
    pmid_clean = str(pmid or "").strip()
    if not pmid_clean:
        return []
    limit = discovery_limit(limit)
    url = f"{EUROPE_PMC_REST}/MED/{urllib.parse.quote(pmid_clean, safe='')}/references?format=json&pageSize={min(limit, 100)}"
    req = urllib.request.Request(url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
    try:
        from pulse_performance import request_json
        data = request_json(req, timeout=10, cache=True)
        items = (data.get("referenceList") or {}).get("reference") or []
        return items[:limit]
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        return []


def icite_to_metadata(item):
    from pulse_core.metadata_utils import clean_crossref_text
    title = clean_crossref_text(item.get("title") or "")
    authors_raw = item.get("authors") or ""
    if isinstance(authors_raw, list):
        authors = [str(a).strip() for a in authors_raw if str(a).strip()]
    elif isinstance(authors_raw, str):
        authors = [a.strip() for a in authors_raw.split(",") if a.strip()]
    else:
        authors = []
    year = str(item.get("year") or "")
    doi = normalize_doi(item.get("doi") or "")
    pmid = str(item.get("pmid") or "")
    journal = item.get("journal") or ""
    citation_count = None
    if item.get("citation_count") is not None:
        try: citation_count = int(item.get("citation_count"))
        except (ValueError, TypeError): pass
    return {
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
        "doi": doi,
        "pmid": pmid,
        "citationCount": citation_count,
        "metadataSource": "iCite",
    }


def icite_citing_papers(pmid, limit=30):
    pmid_clean = str(pmid or "").strip()
    if not pmid_clean:
        return []
    limit = discovery_limit(limit)
    url = f"https://icite.od.nih.gov/api/pubs?pmids={urllib.parse.quote(pmid_clean, safe='')}"
    req = urllib.request.Request(url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
    try:
        from pulse_performance import request_json
        data = request_json(req, timeout=10, cache=True)
        rows = data.get("data") or []
        if not rows:
            return []
        citations = rows[0].get("cited_by") or []  # iCite lists citing PMIDs under cited_by
        if not citations:
            return []
        batch_pmids = [str(c) for c in citations[:limit] if c]
        if not batch_pmids:
            return []
        batch_url = f"https://icite.od.nih.gov/api/pubs?pmids={','.join(batch_pmids)}"
        batch_req = urllib.request.Request(batch_url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
        batch_data = request_json(batch_req, timeout=12, cache=True)
        return (batch_data.get("data") or [])[:limit]
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception:
        return []


def resolve_works_by_dois(dois):
    """Resolve DOIs using OpenAlex if available, falling back to Europe PMC."""
    clean = list(dict.fromkeys(d for d in (normalize_doi(value or '').lower() for value in dois) if d))
    if not clean:
        return []
    recs = []
    if not cooldowns().get('OpenAlex'):
        try:
            works = openalex_works_by_dois(clean)
            if works:
                for item in works:
                    recs.append(recommendation_record(*openalex_recommendation_item(item), source="OpenAlex"))
                return recs
        except (DiscoveryCancelled, DiscoveryBudgetExceeded):
            raise
        except Exception:
            pass
    # Fallback to Europe PMC
    for doi in clean[:30]:
        check_cancelled()
        url = f"{EUROPE_PMC_REST}/search?" + urllib.parse.urlencode({"query": f'DOI:"{doi}"', "format": "json", "pageSize": 1})
        req = urllib.request.Request(url, headers={"User-Agent": f"Pulse/{APP_VERSION}", "Accept": "application/json"}, method="GET")
        try:
            from pulse_performance import request_json
            data = request_json(req, timeout=6, cache=True)
            results = (data.get("resultList") or {}).get("result") or []
            if results:
                meta = europepmc_to_metadata(results[0])
                rec = recommendation_record(meta, {"score": 1.0, "reason": "DOI resolution"}, source="Europe PMC")
                recs.append(rec)
        except (DiscoveryCancelled, DiscoveryBudgetExceeded):
            raise
        except Exception:
            pass
    return recs


def fetch_citation_graph_branch(seed_papers, api_key=None, include_iterative_chase=False, limit=30, depth=None, seed_works=None):
    gathered = SearchResults()
    hop1_references = []
    hop1_citations = []
    per_seed = citation_neighborhood_limit(limit, len(seed_papers))
    for seed_index, paper in enumerate(seed_papers[:24]):
        refs, cites = [], []
        # 1. OpenAlex first (if not in cooldown)
        work = None
        if not cooldowns().get('OpenAlex'):
            if seed_works is not None and seed_index < len(seed_works):
                work = seed_works[seed_index]
            else:
                try:
                    work = _core.openalex_work_for_paper(paper)
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception as error:
                    gathered.warning = str(error)
                    work = None

            if work:
                work_id_clean = openalex_work_id(work.get("id"))
                # Publish whichever direction finishes first; a slow incoming
                # list must not hold an already downloaded bibliography hostage.
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = {
                        submit_with_context(executor, openalex_citing_works, work_id_clean, limit=per_seed): 'forward',
                        submit_with_context(executor, openalex_reference_works, work_id_clean, limit=per_seed,
                                            referenced_works=work.get('referenced_works') or []): 'backward',
                    }
                    for future in as_completed(futures):
                        direction = futures[future]
                        try: rows = future.result()
                        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                        except Exception as error:
                            gathered.warning = ' · '.join(filter(None, [gathered.warning, 'OpenAlex '+direction+': '+str(error)])); continue
                        if getattr(rows, 'warning', ''):
                            gathered.warning = ' · '.join(filter(None, [gathered.warning, rows.warning]))
                        for rank, item in enumerate(rows, 1):
                            record = recommendation_record(*openalex_recommendation_item(item), source='OpenAlex '+('references' if direction=='backward' else 'citing papers'))
                            record.update(branch='citationGraph', subType='Backward' if direction=='backward' else 'Forward', hop=1, provider='OpenAlex',
                                          retrievalEvidence=[{'channel':f'citations:{seed_index}:{direction}', 'rank':rank, 'provider':'OpenAlex'}],
                                          reason='Cited by your seed paper.' if direction=='backward' else 'Cites your seed paper.')
                            (refs if direction=='backward' else cites).append(record)
                            (hop1_references if direction=='backward' else hop1_citations).append(record)
                            gathered.append(record)
                        publish_partial(copy.deepcopy(gathered))

        need_citations = not cites or bool(getattr(cites, 'warning', ''))
        need_references = not refs or bool(getattr(refs, 'warning', ''))

        # Resolve PMID for biomedical citation fallbacks (Europe PMC, NIH iCite)
        resolved_pmid = str(paper.get('pmid') or '').strip() or None
        seed_doi = normalize_doi(paper.get('doi') or '')
        if (need_citations or need_references) and not resolved_pmid and seed_doi and not cooldowns().get('Europe PMC'):
            try:
                resolved_pmid = europepmc_pmid_for_doi(seed_doi)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception: pass

        # 2. Europe PMC second
        if (need_citations or need_references) and resolved_pmid and not cooldowns().get('Europe PMC'):
            if need_citations:
                try:
                    epmc_cites = europepmc_citing_papers(resolved_pmid, limit=per_seed)
                    for rank, item in enumerate(epmc_cites, 1):
                        meta = europepmc_to_metadata(item)
                        record = recommendation_record(meta, {"score": 1.0, "reason": "Forward citation: downstream paper citing seed paper via Europe PMC."}, source="Europe PMC citing papers")
                        record.update(branch="citationGraph", subType="Forward", hop=1, provider="Europe PMC",
                                      retrievalEvidence=[{"channel": f"citations:{seed_index}:forward", "rank": rank, "provider": "Europe PMC"}],
                                      reason="Forward citation: downstream paper citing seed paper via Europe PMC.")
                        cites.append(record)
                        gathered.append(record)
                        hop1_citations.append(record)
                    if cites:
                        publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception: pass

            if need_references:
                try:
                    epmc_refs = europepmc_reference_papers(resolved_pmid, limit=per_seed)
                    for rank, item in enumerate(epmc_refs, 1):
                        meta = europepmc_to_metadata(item)
                        record = recommendation_record(meta, {"score": 1.0, "reason": "Backward citation: foundational reference cited by seed paper via Europe PMC."}, source="Europe PMC references")
                        record.update(branch="citationGraph", subType="Backward", hop=1, provider="Europe PMC",
                                      retrievalEvidence=[{"channel": f"citations:{seed_index}:backward", "rank": rank, "provider": "Europe PMC"}],
                                      reason="Backward citation: foundational reference cited by seed paper via Europe PMC.")
                        refs.append(record)
                        gathered.append(record)
                        hop1_references.append(record)
                    if refs:
                        publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception: pass

        need_citations = not cites or bool(getattr(cites, 'warning', ''))
        need_references = not refs or bool(getattr(refs, 'warning', ''))

        # 3. NIH iCite third (citing papers fallback)
        if need_citations and resolved_pmid and not cooldowns().get('iCite'):
            try:
                icite_cites = icite_citing_papers(resolved_pmid, limit=per_seed)
                for rank, item in enumerate(icite_cites, 1):
                    meta = icite_to_metadata(item)
                    record = recommendation_record(meta, {"score": 1.0, "reason": "Forward citation: downstream paper citing seed paper via NIH iCite."}, source="NIH iCite citing papers")
                    record.update(branch="citationGraph", subType="Forward", hop=1, provider="iCite",
                                  retrievalEvidence=[{"channel": f"citations:{seed_index}:forward", "rank": rank, "provider": "iCite"}],
                                  reason="Forward citation: downstream paper citing seed paper via NIH iCite.")
                    cites.append(record)
                    gathered.append(record)
                    hop1_citations.append(record)
                if cites:
                    publish_partial(copy.deepcopy(gathered))
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception: pass

        need_citations = not cites or bool(getattr(cites, 'warning', ''))
        need_references = not refs or bool(getattr(refs, 'warning', ''))

        # 4. OpenCitations fourth
        if (need_citations or need_references) and seed_doi:
            if need_citations:
                try:
                    oc_cites = opencitations_citing_dois(seed_doi, limit=per_seed)
                    if oc_cites:
                        oc_records = resolve_works_by_dois(oc_cites[:per_seed])
                        for rank, record in enumerate(oc_records, 1):
                            record.update(branch="citationGraph", subType="Forward", hop=1, provider="OpenCitations",
                                          retrievalEvidence=[{"channel":f"citations:{seed_index}:forward","rank":rank,"provider":"OpenCitations"}],
                                          reason="Forward citation: downstream paper citing seed paper via OpenCitations.")
                            cites.append(record)
                            gathered.append(record)
                            hop1_citations.append(record)
                        publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception: pass

            if need_references:
                try:
                    oc_refs = opencitations_referenced_dois(seed_doi, limit=per_seed)
                    if oc_refs:
                        oc_records = resolve_works_by_dois(oc_refs[:per_seed])
                        for rank, record in enumerate(oc_records, 1):
                            record.update(branch="citationGraph", subType="Backward", hop=1, provider="OpenCitations",
                                          retrievalEvidence=[{"channel":f"citations:{seed_index}:backward","rank":rank,"provider":"OpenCitations"}],
                                          reason="Backward citation: foundational reference cited by seed paper via OpenCitations.")
                            refs.append(record)
                            gathered.append(record)
                            hop1_references.append(record)
                        publish_partial(copy.deepcopy(gathered))
                except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                except Exception: pass

        need_citations = not cites or bool(getattr(cites, 'warning', ''))
        need_references = not refs or bool(getattr(refs, 'warning', ''))

        # 5. Semantic Scholar fifth (skipped if in cooldown)
        if (need_citations or need_references) and not cooldowns().get('Semantic Scholar'):
            s2_id = None
            try:
                s2_id = _core.s2_paper_id_for_paper(paper, api_key=api_key)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception: s2_id = None
            if s2_id:
                if need_citations:
                    try:
                        s2_cites = _core.s2_fetch_citations(s2_id, api_key=api_key, limit=per_seed)
                        s2_cites = copy.deepcopy(s2_cites)
                        for rank, item in enumerate(s2_cites, 1):
                            item.update(hop=1, branch='citationGraph', subType='Forward', provider='Semantic Scholar',
                                        retrievalEvidence=[{'channel':f'citations:{seed_index}:forward','rank':rank,'provider':'Semantic Scholar'}])
                        if s2_cites:
                            cites = s2_cites
                            gathered.extend(s2_cites)
                            hop1_citations.extend(s2_cites)
                            publish_partial(copy.deepcopy(gathered))
                    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                    except Exception: pass

                if need_references:
                    try:
                        s2_refs = _core.s2_fetch_references(s2_id, api_key=api_key, limit=per_seed)
                        s2_refs = copy.deepcopy(s2_refs)
                        for rank, item in enumerate(s2_refs, 1):
                            item.update(hop=1, branch='citationGraph', subType='Backward', provider='Semantic Scholar',
                                        retrievalEvidence=[{'channel':f'citations:{seed_index}:backward','rank':rank,'provider':'Semantic Scholar'}])
                        if s2_refs:
                            refs = s2_refs
                            gathered.extend(s2_refs)
                            hop1_references.extend(s2_refs)
                            publish_partial(copy.deepcopy(gathered))
                    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
                    except Exception: pass
        elif bool(api_key) and (cites or refs) and not cooldowns().get('Semantic Scholar'):
            try:
                s2_id = _core.s2_paper_id_for_paper(paper, api_key=api_key)
                if s2_id:
                    s2_edges = []
                    if cites:
                        s2_edges.extend( _core.s2_enrich_citation_contexts(s2_id, direction="citations", api_key=api_key, limit=per_seed) or [] )
                    if refs:
                        s2_edges.extend( _core.s2_enrich_citation_contexts(s2_id, direction="references", api_key=api_key, limit=per_seed) or [] )
                    by_doi = {normalize_doi(e.get("doi") or "").lower(): e for e in s2_edges if normalize_doi(e.get("doi") or "")}
                    by_pmid = {str(e.get("pmid") or "").strip(): e for e in s2_edges if str(e.get("pmid") or "").strip()}
                    for rec in list(cites) + list(refs):
                        d_key = normalize_doi(rec.get("doi") or "").lower()
                        p_key = str(rec.get("pmid") or "").strip()
                        edge = by_doi.get(d_key) or by_pmid.get(p_key)
                        if edge:
                            if edge.get("citationContexts") and not rec.get("citationContexts"):
                                rec["citationContexts"] = edge["citationContexts"]
                            if edge.get("citationIntents") and not rec.get("citationIntents"):
                                rec["citationIntents"] = edge["citationIntents"]
                            if edge.get("isInfluentialCitation") and not rec.get("isInfluentialCitation"):
                                rec["isInfluentialCitation"] = True
            except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
            except Exception: pass

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

ALPHABETICAL_AUTHOR_FIELDS = {
    "mathematics",
    "physics and astronomy",
    "physics",
}
ALPHABETICAL_AUTHOR_TOPICS = {
    "theoretical computer science",
    "discrete mathematics and combinatorics",
    "computational theory and mathematics",
    "mathematical physics",
    "algebra and number theory",
    "geometry and topology",
    "high energy physics",
    "nuclear and high energy physics",
}


def is_alphabetical_author_field(work, paper=None):
    """Return True when the seed's field or topic uses alphabetical author ordering (maths, physics, theoretical CS)."""
    pt = (work or {}).get("primary_topic") or {}
    field_name = str((pt.get("field") or {}).get("display_name") or (paper or {}).get("field") or "").strip().lower()
    subfield_name = str((pt.get("subfield") or {}).get("display_name") or "").strip().lower()
    topic_name = str(pt.get("display_name") or "").strip().lower()
    if field_name in ALPHABETICAL_AUTHOR_FIELDS or subfield_name in ALPHABETICAL_AUTHOR_TOPICS or topic_name in ALPHABETICAL_AUTHOR_TOPICS:
        return True
    combined = f"{field_name} {subfield_name} {topic_name}"
    return any(term in combined for term in ("mathematics", "physics", "theoretical computer science"))


def _author_exceeds_annual_cap(author_obj, meta_count=None, years=3, max_per_year=300):
    """Return True if an author has >300 works/year (probable merged OpenAlex identity)."""
    if isinstance(author_obj, dict):
        if int(author_obj.get("works_count_per_year") or 0) > max_per_year:
            return True
        for row in author_obj.get("counts_by_year") or []:
            if int(row.get("works_count") or 0) > max_per_year:
                return True
    if meta_count is not None and int(meta_count) > max_per_year * max(1, int(years or 3)):
        return True
    return False


def extract_seed_trajectory_authors(work, paper=None):
    """Extract first and (when non-alphabetical or corresponding) last author specs from a seed's OpenAlex work."""
    if not work or not isinstance(work, dict):
        return []
    authorships = work.get("authorships") or []
    if not authorships:
        return []
    is_alpha = is_alphabetical_author_field(work, paper)
    pt = work.get("primary_topic") or {}
    topic_id = str(pt.get("id") or "").split("/")[-1]
    field_id = str((pt.get("field") or {}).get("id") or "").split("/")[-1]

    specs = []
    first = authorships[0]
    first_author = first.get("author") or {}
    first_match = re.search(r"\bA\d+\b", str(first_author.get("id") or ""))
    if first_match and not _author_exceeds_annual_cap(first_author):
        specs.append({
            "role": "first",
            "label": "Same first author",
            "author_id": first_match.group(0),
            "name": str(first_author.get("display_name") or "").strip(),
            "topic_id": topic_id,
            "field_id": field_id,
        })
    if len(authorships) > 1:
        last = authorships[-1]
        last_author = last.get("author") or {}
        last_match = re.search(r"\bA\d+\b", str(last_author.get("id") or ""))
        is_corr = bool(last.get("is_corresponding"))
        if last_match and (not is_alpha or is_corr) and not _author_exceeds_annual_cap(last_author):
            if not specs or last_match.group(0) != specs[0]["author_id"]:
                specs.append({
                    "role": "last",
                    "label": "Same senior author",
                    "author_id": last_match.group(0),
                    "name": str(last_author.get("display_name") or "").strip(),
                    "topic_id": topic_id,
                    "field_id": field_id,
                })
    return specs


def fetch_author_trajectory_branch(seed_papers, seed_works=None, years=3, max_per_author=5):
    """Fetch recent works by each seed's first and senior authors (at most 2 OpenAlex calls per seed)."""
    import datetime
    if cooldowns().get("OpenAlex"):
        return SearchResults()
    gathered = SearchResults()
    years = max(1, min(int(years or 3), 10))
    from_year = datetime.date.today().year - years
    from_date = f"{from_year}-01-01"
    seed_dois = {normalize_doi(p.get("doi") or "").lower() for p in (seed_papers or []) if p.get("doi")}
    seed_titles = {normalize_title_key(p.get("title") or "") for p in (seed_papers or []) if p.get("title")}

    for seed_index, paper in enumerate((seed_papers or [])[:24]):
        check_cancelled()
        work = seed_works[seed_index] if seed_works is not None and seed_index < len(seed_works) else None
        if seed_works is None:
            try:
                work = _core.openalex_work_for_paper(paper)
            except (DiscoveryCancelled, DiscoveryBudgetExceeded):
                raise
            except Exception:
                work = None
        if not work:
            continue
        seed_wid = openalex_work_id(work.get("id"))
        specs = extract_seed_trajectory_authors(work, paper)
        for spec in specs[:2]:
            check_cancelled()
            filter_parts = [f"author.id:{spec['author_id']}", f"from_publication_date:{from_date}"]
            if spec.get("topic_id"):
                filter_parts.append(f"primary_topic.id:{spec['topic_id']}")
            elif spec.get("field_id"):
                filter_parts.append(f"primary_topic.field.id:{spec['field_id']}")
            query_params = {
                "filter": ",".join(filter_parts),
                "per-page": max_per_author + 2,
                "sort": "publication_date:desc",
                "select": OPENALEX_WORK_SELECT,
            }
            try:
                data = _core.fetch_json(f"https://api.openalex.org/works?{urllib.parse.urlencode(query_params)}")
            except (DiscoveryCancelled, DiscoveryBudgetExceeded):
                raise
            except Exception as error:
                gathered.warning = " · ".join(filter(None, [gathered.warning, str(error)]))
                continue
            meta_count = ((data or {}).get("meta") or {}).get("count")
            if _author_exceeds_annual_cap(None, meta_count=meta_count, years=years):
                continue
            rows = (data or {}).get("results") or []
            year_counts = collections.Counter(str(w.get("publication_year") or "") for w in rows if w.get("publication_year"))
            if any(cnt > 300 for cnt in year_counts.values()):
                continue
            kept = 0
            for w in rows:
                if any(_author_exceeds_annual_cap((a.get("author") or {})) for a in (w.get("authorships") or []) if re.search(r"\bA\d+\b", str((a.get("author") or {}).get("id") or "")) and re.search(r"\bA\d+\b", str((a.get("author") or {}).get("id") or "")).group(0) == spec["author_id"]):
                    kept = 0
                    break
                wid = openalex_work_id(w.get("id"))
                if seed_wid and wid == seed_wid:
                    continue
                rec = recommendation_record(*openalex_recommendation_item(w), source="OpenAlex author trajectory")
                rec_doi = normalize_doi(rec.get("doi") or "").lower()
                rec_tk = normalize_title_key(rec.get("title") or "")
                if (rec_doi and rec_doi in seed_dois) or (rec_tk and rec_tk in seed_titles):
                    continue
                kept += 1
                label = spec["label"]
                role = spec["role"]
                author_name = spec["name"]
                channel = f"author:{seed_index}:{role}"
                rec.update(
                    branch="authorTrajectory",
                    subType=label,
                    provider="OpenAlex",
                    authorRole=role,
                    authorTrajectoryLabel=label,
                    authorTrajectoryName=author_name,
                    reason=f"{label} ({author_name})" if author_name else label,
                    discoveryBadges=[label],
                    retrievalEvidence=[{
                        "channel": channel,
                        "provider": "OpenAlex",
                        "rank": kept,
                        "subType": label,
                        "authorRole": role,
                        "authorName": author_name,
                        "seedIndex": seed_index,
                    }],
                )
                gathered.append(rec)
                if kept >= max_per_author:
                    break
    return gathered


def fetch_citation_network_branch(seed_papers, api_key=None, limit=30, seed_works=None):
    # Keep the existing API/workspace key while replacing both legacy network
    # searches with the supplied content-aware DBEF shared-reference method.
    from pulse_core.dbef_discovery import fetch_dbef_branch
    return fetch_dbef_branch(seed_papers, api_key=api_key, limit=limit, seed_works=seed_works)


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


def run_discovery_pipeline(payload, on_progress=None, cancel_event=None, on_candidates=None):
    with _ACTIVE_LOCK:
        _ACTIVE_SEARCHES[0] += 1
    _WARM_CANCEL.set()
    try:
        return _run_discovery_pipeline(payload, on_progress, cancel_event, on_candidates)
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE_SEARCHES[0] -= 1


def _run_discovery_pipeline(payload, on_progress=None, cancel_event=None, on_candidates=None):
    from pulse_core.search_query import normalize_search_request, prepared_search
    payload, search_terms = normalize_search_request(payload)
    seed_papers, concept_query = validate_discovery_request(payload)
    seed_papers = [dict(paper) for paper in seed_papers]
    if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
    if concept_query:
        # Topic searches have no synthetic seed, citation links or seed exclusions.
        payload = dict(payload, researchQuestion=concept_query, bridgeMode=False)
        if not any((payload.get('searchSources') or {}).get(name, True) for name in ('semanticScholar','europePmc','core')) and not (payload.get('searchSources') or {}).get('arxiv', False) and not payload.get('fullTextSearch'):
            raise ClientError(400, 'Choose at least one source for concept search.')
    if payload.get('bridgeMode') and len(distinct_seeds(seed_papers)) < 2:
        raise ClientError(400, 'Select at least two different seed papers to find bridge papers.')
    if payload.get('bridgeMode') and len(distinct_seeds(seed_papers)) > 8:
        raise ClientError(400, 'Use up to eight different seed papers for one bridge search.')
    started = time.monotonic()
    settings = _core.load_settings()
    concept_search = None
    if concept_query:
        if on_progress: on_progress({'stage':'keywords', 'searchMode':'concept', 'searchQuery':concept_query})
        concept_search = (prepared_search(search_terms, concept_query) if search_terms['structured'] else
                          prepare_concept_search(concept_query, dict(settings, _fastConceptSearch=payload.get('rankingMode')=='fast'), cancel_event))
    bridge_concept = None
    if payload.get('bridgeMode') and not concept_query:
        # Bridging searches for what the selected papers share, as a concept.
        if on_progress: on_progress({'stage':'keywords', 'searchMode':'bridge'})
        bridge_concept = prepare_bridge_concept(seed_papers, settings, cancel_event)
        if bridge_concept and not str(payload.get('researchQuestion') or '').strip():
            payload = dict(payload, researchQuestion=bridge_concept['query'])
    api_key = resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {}
    if concept_query:
        branches = {'citationGraph':False, 'citationNetwork':False, 'citationCoCitation':False, 'authorTrajectory':False, 'semanticSearch':False, 'lexicalSearch':True}
    steer_keywords = steering_terms(payload.get("steerKeywords") or payload.get("keywords") or [])
    if concept_search:
        steer_keywords = steering_terms(concept_search['keywords'] + steer_keywords)
    if bridge_concept:
        steer_keywords = steering_terms(bridge_concept['keywords'] + steer_keywords)
    exclude_keywords = steering_terms(payload.get("excludeKeywords") or [])
    limit = discovery_limit(payload.get("limit"))
    include_iterative = bool(payload.get("includeIterativeChase", False))
    feedback = feedback_for_context(payload, seed_papers)
    retrieval_limit = candidate_limit(limit)
    query_plan = []
    tasks = {}
    resolved_seed_works = [None] * min(24, len(seed_papers))
    seed_resolution_lock, seed_resolution_ready = threading.Lock(), threading.Event()
    seed_resolution_started = [False]
    def resolve_seed_works():
        with seed_resolution_lock:
            owner = not seed_resolution_started[0]
            if owner: seed_resolution_started[0] = True
        if not owner:
            while not seed_resolution_ready.wait(.05): check_cancelled()
            return resolved_seed_works
        prior = getattr(REQUEST_CONTEXT, 'deadline', None)
        REQUEST_CONTEXT.deadline = min(prior, time.monotonic()+8) if prior else time.monotonic()+8
        try:
            if seed_papers:
                with ThreadPoolExecutor(max_workers=min(6, len(seed_papers)), thread_name_prefix='pulse-seed-resolve') as executor:
                    futures = {submit_with_context(executor, _core.openalex_work_for_paper, paper):index
                               for index,paper in enumerate(seed_papers[:24])}
                    for future in as_completed(futures):
                        index = futures[future]
                        try: work = future.result()
                        except DiscoveryCancelled: raise
                        except Exception: work = None
                        resolved_seed_works[index] = work
                        if isinstance(work, dict):
                            metadata = openalex_to_metadata(work)
                            seed_papers[index] = dict(seed_papers[index], **{key:metadata[key] for key in ('openAlexId','referenceIds','referenceCount')})
        finally:
            REQUEST_CONTEXT.deadline = prior
            seed_resolution_ready.set()
        return resolved_seed_works
    author_trajectory_enabled = branches.get(
        'authorTrajectory', branches.get('citationGraph', True) and branches.get('citationNetwork', True),
    ) if not concept_query else False
    if payload.get('fullTextSearch'):
        fulltext_query = str(payload.get('researchQuestion') or ' '.join(str(p.get('title') or '') for p in seed_papers[:8]))
        tasks['fullText'] = lambda: search_fulltext_library(fulltext_query, retrieval_limit)
    if branches.get("citationGraph", True):
        tasks["citationGraph"] = lambda: _core.fetch_citation_graph_branch(seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get("depth"), seed_works=resolve_seed_works())
    if branches.get("citationNetwork", True):
        tasks["citationNetwork"] = lambda: fetch_citation_network_branch(seed_papers, api_key=api_key, limit=limit, seed_works=resolve_seed_works())
    if branches.get('citationCoCitation',branches.get('citationNetwork',True)):
        from pulse_core.cocitation_discovery import fetch_cocitation_branch
        tasks['citationCoCitation']=lambda:fetch_cocitation_branch(seed_papers,api_key=api_key,limit=limit,seed_works=resolve_seed_works())
    if author_trajectory_enabled and (branches.get('authorTrajectory') is True or any(paper.get('authors') for paper in seed_papers)):
        tasks["authorTrajectory"] = lambda: _core.fetch_author_trajectory_branch(seed_papers, seed_works=resolve_seed_works(), years=int(payload.get("authorTrajectoryYears") or 3))
    if branches.get("semanticSearch", True):
        tasks["semanticSearch"] = lambda: fetch_semantic_search_branch(seed_papers, api_key=api_key, limit=limit, feedback=feedback)
    if branches.get("lexicalSearch", branches.get("lexicalConceptual", True)):
        sources = payload.get("searchSources") or {}
        query_plan = concept_query_plan(concept_search, payload.get('steerKeywords'), feedback) if concept_search else build_query_plan(seed_papers,steer_keywords,str(payload.get('researchQuestion') or '')[:1000],feedback)
        if payload.get('bridgeMode'):
            focused = bridge_queries(seed_papers)
            shared = concept_query_plan(bridge_concept, payload.get('steerKeywords'), feedback) if bridge_concept else []
            for query in shared: query['id'] = 'bridge-concept:' + query['id']
            combined, seen_text = [], set()
            for query in shared + focused + query_plan:
                key = str(query.get('text') or '').casefold()
                if key and key not in seen_text:
                    seen_text.add(key); combined.append(query)
            query_plan = combined[:14]
        if sources.get("semanticScholar", True):
            tasks["lexicalConceptual"] = lambda: search_query_plan(query_plan,'semanticScholar',s2_paper_search,retrieval_limit,api_key=api_key)
        def public_search(provider, searcher, **kwargs):
            previous_deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
            if provider in ('core', 'europePmc', 'arxiv'):
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
        if sources.get("arxiv", False):
            from pulse_core.arxiv_search import search_arxiv
            tasks["arxiv"] = lambda: public_search("arxiv", search_arxiv)
    options = {
        "queryKeywords": payload.get("queryKeywords") or [],
        "queryTags": payload.get("queryTags") or [],
        "queryMatch": payload.get("queryMatch", "all"),
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
        "citationLinkBonus": payload.get("citationLinkBonus", True),
        "citationLinkGate": payload.get("citationLinkGate", 0.3),
        "citationLinkMode": payload.get("citationLinkMode", "velocity"),
        "citationLinkWeight": payload.get("citationLinkWeight", 0.2),
        "impute_missing_graph":payload.get('impute_missing_graph','median'),
        "graph_imputation_shrink":payload.get('graph_imputation_shrink',.5),
        "limit": limit,
        "relevanceFeedback": feedback,
        "_matchCalibration": settings.get('searchMatchCalibration'),
        "bridgeMode": bool(payload.get('bridgeMode')),
        "_originalSeeds": seed_papers,
        "_feedbackSemantic": {},
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

    def queue_embeddings(records, pairwise_records=None):
        # Only the newest shortlist matters; drop an unprocessed older one.
        try:
            embed_queue.get_nowait()
        except queue.Empty:
            pass
        embed_queue.put_nowait((records, pairwise_records))

    pairwise_enabled = bool(payload.get('pairwiseRerank', True))
    pair_queries = [options['researchQuestion']] if options.get('researchQuestion') else [str(p.get('title') or '')+' '+' '.join(p.get('paperKeywords') or []) for p in seed_papers[:2]]

    def embed_collector_worker():
        while not embed_stop.is_set():
            if cancel_event and cancel_event.is_set():
                break
            try:
                batch, pairwise_batch = embed_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if semantic_enabled and (batch or embed_queries):
                try:
                    pre_embed_papers(settings, batch, cancel_event, fast_mode=fast_mode,
                                     queries=embed_queries, stop_event=embed_stop)
                except Exception:
                    pass
            pairwise_batch = pairwise_batch if pairwise_batch is not None else batch
            if pairwise_enabled and pairwise_batch and not embed_stop.is_set():
                try:
                    pre_score_crossencoder(settings, pair_queries, pairwise_batch,
                                           cancel_event=cancel_event, stop_event=embed_stop)
                except Exception:
                    pass

    embed_thread = None
    if semantic_enabled or pairwise_enabled:
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
    ranked_after_citations=set()
    last_top50_keys=[None]
    settled_updates=[0]
    last_preliminary_time=[0.0]
    def source_errors(results, errors):
        return {**errors, **{name: records.warning for name, records in results.items() if getattr(records, "warning", "")}}
    def source_notices(results):
        return {name: records.notices for name, records in results.items() if getattr(records, "notices", None)}
    def progress(results, completed, errors, total):
        if not on_progress and not (embed_thread and embed_thread.is_alive()):
            return
        ordered = {name: results.get(name, []) for name in tasks}
        now=time.monotonic()
        citation_branches = [name for name in tasks if name in ('citationGraph', 'citationNetwork', 'citationCoCitation')]
        citation_finished = bool(citation_branches) and all(name in completed or name in errors for name in citation_branches)
        finished_citations={name for name in ('citationGraph','citationNetwork','citationCoCitation') if name in completed or name in errors}
        # Citation results decide most of the neural shortlist, so refresh as
        # soon as one finishes (at most once a second), otherwise every 3 s.
        citation_arrived=bool(finished_citations-ranked_after_citations) and now-last_progress_rank[0]>=1.0
        # Preliminary results: emit as soon as all citation branches finish,
        # and keep refreshing as slower keyword sources arrive (throttled to at most once per second).
        preliminary_due = citation_finished and (last_preliminary_time[0] == 0.0 or (now - last_preliminary_time[0] >= 1.0 and len(completed) + len(errors) > last_progress_rank[1]))
        should_rank=last_progress_rank[0]==0 or now-last_progress_rank[0]>=3.0 or citation_arrived or preliminary_due
        shortlists=[]
        rank_options=dict(options,limit=min(limit,150))
        if embed_thread and embed_thread.is_alive():
            rank_options['_shortlistProbe']=lambda semantic_rows,pairwise_rows: shortlists.append((semantic_rows,pairwise_rows))
        ranked=merge_and_rank_pipeline_candidates(ordered,seed_papers,rank_options) if should_rank else None
        if should_rank:
            if preliminary_due:
                last_preliminary_time[0] = now
            ranked_after_citations.update(finished_citations)
            last_progress_rank[:]=[now,len(completed)+len(errors)]
            if citation_branches and citation_finished and ranked:
                top50_keys = tuple(str(p.get('doi') or p.get('openalexId') or p.get('paperId') or p.get('title') or '') for p in ranked[:50])
                if top50_keys == last_top50_keys[0]:
                    settled_updates[0] += 1
                else:
                    settled_updates[0] = 0
                    last_top50_keys[0] = top50_keys
        if ranked is not None and embed_thread and embed_thread.is_alive():
            if shortlists:
                queue_embeddings(*shortlists[-1])
            else:
                queue_embeddings(ranked[:SEMANTIC_SHORTLIST_LIMIT])
        if on_progress:
            update = {
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
            }
            if ranked is not None:
                update["recommendations"] = ranked[:min(limit, 100)]
            if citation_finished:
                # Citation-based results are ready while slower sources continue.
                # The stage stays "collecting" until every source has answered.
                update["rankingPhase"] = "preliminary"
            on_progress(update)
        # Stop waiting for long-tail sources once the citation-led top 50 has settled.
        if citation_branches and citation_finished and settled_updates[0] >= 2 and len(tasks) > len(completed) + len(errors):
            return True
    if on_progress:
        on_progress({"total": len(tasks), "stage":"collecting", "conceptSearch":concept_search, "bridgeConcept":bridge_concept})
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
    if on_candidates:on_candidates(ordered,seed_papers,options)
    if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
    if payload.get('_collectOnly'):
        # Pre-warm: responses are cached; also cache AI scores for the shortlist
        # the final ranking will choose from this same pool, then stop.
        shortlists = []
        merge_and_rank_pipeline_candidates(ordered, seed_papers, dict(options, limit=min(limit, 150),
            _shortlistProbe=lambda semantic_rows, pairwise_rows: shortlists.append((semantic_rows, pairwise_rows))))
        if shortlists:
            semantic_rows, pairwise_rows = shortlists[-1]
            if semantic_enabled and not (cancel_event and cancel_event.is_set()):
                pre_embed_papers(settings, semantic_rows, cancel_event, fast_mode=fast_mode, queries=embed_queries)
            if pairwise_enabled and not (cancel_event and cancel_event.is_set()):
                pre_score_crossencoder(settings, pair_queries, pairwise_rows, cancel_event=cancel_event)
        return {'ok': True, 'prewarmed': True, 'candidateCount': sum(len(rows) for rows in ordered.values()),
                'timings': {'retrievalSeconds': round(retrieval_seconds, 3)}}
    # Two-phase display: the text-and-citation order is shown while neural
    # ranking runs. It runs beside the final ranking (which mostly waits on
    # the embedding and cross-encoder processes) and only when a UI listens.
    final_ranked = threading.Event()
    preliminary_thread = None
    if on_progress:
        preliminary_options = dict(options, limit=min(limit, 100))
        def emit_preliminary():
            try:
                preliminary_ranked = merge_and_rank_pipeline_candidates(ordered, seed_papers, preliminary_options)
            except Exception:
                return
            if final_ranked.is_set() or (cancel_event and cancel_event.is_set()):
                return
            on_progress({
                'stage': 'refining',
                'rankingPhase': 'refining',
                'recommendations': preliminary_ranked[:100],
                'availableCount': sum(len(rows) for rows in ordered.values()),
                'branchesExecuted': executed,
                'errors': source_errors(results, errors),
                'notices': source_notices(results),
                'sourceCounts': {name: len(rows) for name, rows in results.items()},
                'sourceCooldowns': cooldowns(),
                'providerContributions': contributions(results),
                'completed': len(executed) + len(errors),
                'total': len(tasks),
            })
        preliminary_thread = threading.Thread(target=emit_preliminary, name='pulse-preliminary-ranking', daemon=True)
        preliminary_thread.start()
    REQUEST_CONTEXT.cancel_event = cancel_event
    try:
        if payload.get('semanticRerank', True):
            options['_semanticReranker'] = lambda queries,records: semantic_scores(
                settings, queries, records, cancel_event,
                focus_first=bool(options['researchQuestion']),
                fast_mode=fast_mode,feedback=feedback,feedback_scores=options['_feedbackSemantic']
            )
        if payload.get('pairwiseRerank', True):
            options['_pairwiseReranker'] = lambda queries,records: crossencoder_scores(settings,queries,records,cancel_event)
        if payload.get('aiTriage'):
            question = options['researchQuestion'] or 'Related research to: '+ '; '.join(str(p.get('title') or '') for p in seed_papers[:8])
            options['_aiTriage'] = lambda records: triage(records,question,settings,cancel_event)
        ranked = merge_and_rank_pipeline_candidates(ordered,seed_papers,options)
        check_cancelled()
    finally:
        final_ranked.set()
        REQUEST_CONTEXT.cancel_event = None
    return {
        "ok": True,
        "provider": "Pulse literature discovery",
        "searchMode": "concept" if concept_query else "related",
        "searchQuery": concept_query,
        "conceptSearch": concept_search,
        "bridgeConcept": bridge_concept,
        "stage":"complete",
        "rankingNotice": options.get('_rankingNotice'),
        "queryPlan": query_plan,
        "candidateCount": options.get('_candidateCount', len(ranked)),
        "retrievalLimitPerSource": retrieval_limit,
        "feedbackApplied": len(feedback),
        "feedbackConcepts":options.get('_feedbackConcepts'),
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
        "networkEvidence":options.get('_networkEvidence'),
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
