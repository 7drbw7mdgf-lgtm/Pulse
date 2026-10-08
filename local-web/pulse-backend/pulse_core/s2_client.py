import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pulse_core.constants import ClientError
from pulse_core.metadata_utils import clean_author_name, clean_crossref_text
from pulse_performance import request_json

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

def s2_request_headers(api_key=None):
    headers = {"User-Agent": "Pulse/1.3", "Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    return headers

def fetch_s2_json(url, api_key=None, timeout=14, cache=True):
    cached = s2_cache_get(url) if cache else None
    if cached:
        return cached
    request = urllib.request.Request(url, headers=s2_request_headers(api_key), method="GET")
    try:
        return request_json(request, timeout=timeout, cache=cache)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 404:
            return None
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except Exception as error:
        raise ClientError(502, f"Semantic Scholar connection error: {error}")

def post_s2_json(url, payload, api_key=None, timeout=14):
    cache_key = f"{url}:{json.dumps(payload, sort_keys=True)}"
    cached = s2_cache_get(cache_key)
    if cached:
        return cached
    headers = s2_request_headers(api_key)
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        return request_json(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
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
        "abstract": (item.get("abstract") or "").strip(),
        "citationCount": item.get("citationCount"),
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
        data = fetch_s2_json(f"https://api.semanticscholar.org/graph/v1/paper/{ident}?fields=paperId", api_key=api_key)
        if data and data.get("paperId"):
            return data["paperId"]
    title = (paper.get("title") or "").strip()
    if title:
        search = s2_paper_search(title, api_key=api_key, limit=3)
        for cand in search:
            if cand.get("title") and cand.get("paperId"):
                return cand["paperId"]
    return None

def s2_fetch_references(identifier, api_key=None, limit=30):
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/references?fields=citedPaper.title,citedPaper.authors,citedPaper.year,citedPaper.venue,citedPaper.externalIds,citedPaper.citationCount,citedPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    for item in (data or {}).get("data") or []:
        cited = item.get("citedPaper")
        if cited and cited.get("title"):
            res.append(s2_to_metadata(cited))
    return res

def s2_fetch_citations(identifier, api_key=None, limit=30):
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/citations?fields=citingPaper.title,citingPaper.authors,citingPaper.year,citingPaper.venue,citingPaper.externalIds,citingPaper.citationCount,citingPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    for item in (data or {}).get("data") or []:
        citing = item.get("citingPaper")
        if citing and citing.get("title"):
            res.append(s2_to_metadata(citing))
    return res

def s2_recommendations(positive_ids, negative_ids=None, api_key=None, limit=30):
    url = f"https://api.semanticscholar.org/recommendations/v1/papers/?fields=title,authors,year,venue,externalIds,citationCount,abstract&limit={limit}"
    payload = {"positivePaperIds": positive_ids, "negativePaperIds": negative_ids or []}
    data = post_s2_json(url, payload, api_key=api_key)
    res = []
    for item in (data or {}).get("recommendedPapers") or []:
        if item.get("title"):
            res.append(s2_to_metadata(item))
    return res

def s2_paper_search(query, api_key=None, limit=30):
    enc = urllib.parse.quote(query)
    url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={enc}&fields=title,authors,year,venue,externalIds,citationCount,abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    for item in (data or {}).get("data") or []:
        if item.get("title"):
            res.append(s2_to_metadata(item))
    return res

def s2_recommendations_for_search(papers, search, limit, steer_terms=None):
    from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
    from pulse_core.storage import load_settings
    api_key = resolve_semantic_scholar_api_key(load_settings())
    q = search or " ".join(steer_terms or [])
    return s2_paper_search(q, api_key=api_key, limit=limit)
