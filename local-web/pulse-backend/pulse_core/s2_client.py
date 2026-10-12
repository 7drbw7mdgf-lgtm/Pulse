import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pulse_core.constants import ClientError
from pulse_core.metadata_utils import clean_author_name, clean_crossref_text, citation_metadata
from pulse_core.paper_identity import confident_candidate
from pulse_core.search_limits import discovery_limit, SearchResults
from pulse_performance import request_json, DiscoveryCancelled, DiscoveryBudgetExceeded

S2_CACHE = {}

def s2_cache_get(key, max_age_seconds=600):
    cached = S2_CACHE.get(key)
    if cached and (time.time() - cached["timestamp"] < max_age_seconds):
        return cached["data"]
    return None

def s2_cache_set(key, val):
    S2_CACHE[key] = {"timestamp": time.time(), "data": val}
    if len(S2_CACHE) > 200:
        oldest = sorted(S2_CACHE.keys(), key=lambda k: S2_CACHE[k]["timestamp"])[0]
        S2_CACHE.pop(oldest, None)

_INVALID_S2_KEYS = set()

def s2_request_headers(api_key=None):
    headers = {"User-Agent": "Pulse/1.3", "Accept": "application/json"}
    if api_key and api_key not in _INVALID_S2_KEYS:
        headers["x-api-key"] = api_key
    return headers

def fetch_s2_json(url, api_key=None, timeout=14, cache=True):
    cached = s2_cache_get(url) if cache else None
    if cached:
        return cached
    active_key = api_key if (api_key and api_key not in _INVALID_S2_KEYS) else None
    request = urllib.request.Request(url, headers=s2_request_headers(active_key), method="GET")
    try:
        return request_json(request, timeout=timeout, cache=cache)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 404:
            return None
        if error.code == 403 and active_key:
            _INVALID_S2_KEYS.add(active_key)
            try:
                unauth_req = urllib.request.Request(url, headers=s2_request_headers(None), method="GET")
                return request_json(unauth_req, timeout=timeout, cache=cache)
            except Exception:
                pass
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
    except Exception as error:
        raise ClientError(502, f"Semantic Scholar connection error: {error}")

def post_s2_json(url, payload, api_key=None, timeout=14):
    cache_key = f"{url}:{json.dumps(payload, sort_keys=True)}"
    cached = s2_cache_get(cache_key)
    if cached:
        return cached
    active_key = api_key if (api_key and api_key not in _INVALID_S2_KEYS) else None
    headers = s2_request_headers(active_key)
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        return request_json(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 403 and active_key:
            _INVALID_S2_KEYS.add(active_key)
            try:
                unauth_headers = s2_request_headers(None)
                unauth_headers["Content-Type"] = "application/json"
                unauth_req = urllib.request.Request(url, data=data, headers=unauth_headers, method="POST")
                return request_json(unauth_req, timeout=timeout)
            except Exception:
                pass
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
    except Exception as error:
        raise ClientError(502, f"Semantic Scholar connection error: {error}")

def s2_to_metadata(item):
    if not item or not isinstance(item, dict):
        return {}
    title = clean_crossref_text(item.get("title") or "")
    authors = []
    for author in item.get("authors") or []:
        name = (author.get("name") or "").strip()
        if name:
            authors.append(clean_author_name(name))
    ext_ids = item.get("externalIds") or {}
    doi = (ext_ids.get("DOI") or "").strip()
    return {
        "title": title,
        "authors": authors,
        "year": str(item.get("year") or ""),
        "journal": (item.get("venue") or (item.get("journal") or {}).get("name") or "").strip(),
        "doi": doi,
        "s2PaperId": item.get("paperId"),
        "corpusId": item.get('corpusId') or '',
        "pmcid": str(ext_ids.get('PubMedCentral') or ''),
        "pmid": str(ext_ids.get("PubMed") or ""),
        "documentType": "preprint" if any(str(value).lower()=="preprint" for value in item.get("publicationTypes") or []) else "",
        "abstract": (item.get("abstract") or "").strip(),
        **citation_metadata(item.get("citationCount"), "Semantic Scholar"),
        "referenceCount": item.get("referenceCount"),
        "influentialCitationCount": item.get("influentialCitationCount"),
        "metadataSource": "Semantic Scholar",
    }

def s2_paper_identifier(paper):
    if not paper or not isinstance(paper, dict):
        return None
    if paper.get("s2PaperId"):
        return paper["s2PaperId"]
    if paper.get("doi"):
        return f"DOI:{paper['doi']}"
    if paper.get("pmid"):
        return f"PMID:{paper['pmid']}"
    return None

def s2_paper_id_for_paper(paper, api_key=None):
    ident = s2_paper_identifier(paper)
    if ident and not ident.startswith("DOI:") and not ident.startswith("PMID:"):
        return ident
    if ident:
        data = fetch_s2_json(f"https://api.semanticscholar.org/graph/v1/paper/{urllib.parse.quote(ident, safe=':')}?fields=paperId,title,authors,year,venue,externalIds", api_key=api_key)
        if data and confident_candidate(paper, [s2_to_metadata(data)]):
            return data.get("paperId")
    title = (paper.get("title") or "").strip()
    if title:
        match = confident_candidate(paper, s2_paper_search(title, api_key=api_key, limit=5))
        if match: return match.get('s2PaperId')
    return None

def s2_fetch_references(identifier, api_key=None, limit=30):
    limit = min(500, discovery_limit(limit))
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/references?fields=citedPaper.title,citedPaper.authors,citedPaper.year,citedPaper.venue,citedPaper.externalIds,citedPaper.citationCount,citedPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    for item in (data or {}).get("data") or []:
        cited = item.get("citedPaper")
        if cited and cited.get("title"):
            res.append(s2_to_metadata(cited))
    return res

def s2_fetch_citations(identifier, api_key=None, limit=30):
    limit = min(500, discovery_limit(limit))
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/citations?fields=citingPaper.title,citingPaper.authors,citingPaper.year,citingPaper.venue,citingPaper.externalIds,citingPaper.citationCount,citingPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    for item in (data or {}).get("data") or []:
        citing = item.get("citingPaper")
        if citing and citing.get("title"):
            res.append(s2_to_metadata(citing))
    return res

def s2_recommendations(positive_ids, negative_ids=None, api_key=None, limit=30):
    limit = min(500, discovery_limit(limit))
    url = f"https://api.semanticscholar.org/recommendations/v1/papers/?fields=title,authors,year,venue,externalIds,citationCount,abstract,publicationTypes&limit={limit}"
    payload = {"positivePaperIds": positive_ids, "negativePaperIds": negative_ids or []}
    data = post_s2_json(url, payload, api_key=api_key)
    res = []
    for item in (data or {}).get("recommendedPapers") or []:
        if item.get("title"):
            res.append(s2_to_metadata(item))
    return res

def s2_paper_search(query, api_key=None, limit=30):
    enc = urllib.parse.quote(query)
    limit = discovery_limit(limit)
    res = SearchResults()
    offset = 0
    while offset < limit:
        page_size = min(100, limit - offset)
        url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={enc}&fields=title,authors,year,venue,externalIds,citationCount,abstract,publicationTypes&limit={page_size}&offset={offset}"
        try:
            data = fetch_s2_json(url, api_key=api_key) or {}
        except (ClientError, DiscoveryBudgetExceeded) as error:
            return res.keep_partial(error)
        rows = data.get("data") or []
        for item in rows[:page_size]:
            if item.get("title"):
                res.append(s2_to_metadata(item))
        next_offset = data.get("next")
        if not isinstance(next_offset, int) or next_offset <= offset or len(rows) < page_size:
            break
        offset = next_offset
    return res

def s2_recommendations_for_search(papers, search, limit, steer_terms=None):
    from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
    from pulse_core.storage import load_settings
    api_key = resolve_semantic_scholar_api_key(load_settings())
    q = search or " ".join(steer_terms or [])
    return s2_paper_search(q, api_key=api_key, limit=limit)
