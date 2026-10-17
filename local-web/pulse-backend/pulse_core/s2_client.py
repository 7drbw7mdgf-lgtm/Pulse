from pulse_source_health import ProviderCooldown
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

def reset_s2_access():
    """Let a newly saved key retry immediately after an earlier rejection."""
    _INVALID_S2_KEYS.clear()
    from pulse_source_health import clear_source
    clear_source('Semantic Scholar')

def s2_api_key(url, api_key):
    try:
        target = urllib.parse.urlsplit(url)
        valid = target.scheme == 'https' and target.hostname == 'api.semanticscholar.org' and target.username is None and target.password is None and target.port in {None,443}
    except ValueError:
        valid = False
    if not valid:
        raise ClientError(400, 'Unsupported Semantic Scholar address.')
    if api_key is None:
        from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
        from pulse_core.storage import load_settings
        api_key = resolve_semantic_scholar_api_key(load_settings())
    return str(api_key or '').strip()

def s2_request_headers(api_key=None):
    headers = {"User-Agent": "Pulse/1.3", "Accept": "application/json"}
    if api_key and api_key not in _INVALID_S2_KEYS:
        headers["x-api-key"] = api_key
    return headers

def s2_request(url, **kwargs):
    request = urllib.request.Request(url, **kwargs)
    # The shared transport may fall back to urllib, which otherwise forwards
    # custom API-key headers when following a redirect to a different host.
    request.pulse_redirect_origin = 'https://api.semanticscholar.org'
    return request

def fetch_s2_json(url, api_key=None, timeout=14, cache=True):
    api_key = s2_api_key(url, api_key)
    cached = s2_cache_get(url) if cache else None
    if cached:
        return cached
    active_key = api_key if (api_key and api_key not in _INVALID_S2_KEYS) else None
    request = s2_request(url, headers=s2_request_headers(active_key), method="GET")
    try:
        return request_json(request, timeout=timeout, cache=cache)
    except ProviderCooldown as error:
        raise ClientError(error.status,str(error)) from None
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 404:
            return None
        if error.code == 403 and active_key:
            _INVALID_S2_KEYS.add(active_key)
            try:
                unauth_req = s2_request(url, headers=s2_request_headers(None), method="GET")
                return request_json(unauth_req, timeout=timeout, cache=cache)
            except Exception:
                pass
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
    except Exception as error:
        raise ClientError(502, f"Semantic Scholar connection error: {error}")

def post_s2_json(url, payload, api_key=None, timeout=14):
    api_key = s2_api_key(url, api_key)
    cache_key = f"{url}:{json.dumps(payload, sort_keys=True)}"
    cached = s2_cache_get(cache_key)
    if cached:
        return cached
    active_key = api_key if (api_key and api_key not in _INVALID_S2_KEYS) else None
    headers = s2_request_headers(active_key)
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8")
    request = s2_request(url, data=data, headers=headers, method="POST")
    try:
        return request_json(request, timeout=timeout)
    except ProviderCooldown as error:
        raise ClientError(error.status,str(error)) from None
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 403 and active_key:
            _INVALID_S2_KEYS.add(active_key)
            try:
                unauth_headers = s2_request_headers(None)
                unauth_headers["Content-Type"] = "application/json"
                unauth_req = s2_request(url, data=data, headers=unauth_headers, method="POST")
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

import re

_INTENT_LABELS = {
    "methodology": "Methodology",
    "methods": "Methodology",
    "result": "Result",
    "results": "Result",
    "background": "Background",
}


def normalize_citation_contexts(contexts, max_sentences=3, max_chars=300):
    if not contexts or not isinstance(contexts, (list, tuple)):
        return []
    out = []
    seen = set()
    for raw in contexts:
        text = re.sub(r"\s+", " ", str(raw or "")).strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[: max_chars - 1].rstrip() + "…"
        key = text.lower()
        if key not in seen:
            seen.add(key)
            out.append(text)
            if len(out) >= max_sentences:
                break
    return out


def normalize_citation_intents(intents):
    if not intents or not isinstance(intents, (list, tuple)):
        return []
    out = []
    for raw in intents:
        val = str(raw or "").strip().lower()
        if not val:
            continue
        if val in _INTENT_LABELS:
            label = _INTENT_LABELS[val]
        elif val.startswith("method"):
            label = "Methodology"
        elif val.startswith("result"):
            label = "Result"
        elif val.startswith("background"):
            label = "Background"
        else:
            label = str(raw).strip().capitalize()
        if label and label not in out:
            out.append(label)
    return out


def _attach_s2_edge_context(meta, item):
    contexts = normalize_citation_contexts(item.get("contexts"))
    intents = normalize_citation_intents(item.get("intents"))
    if contexts:
        meta["citationContexts"] = contexts
    if intents:
        meta["citationIntents"] = intents
    if item.get("isInfluential") is not None:
        meta["isInfluentialCitation"] = bool(item.get("isInfluential"))
    return meta


def extract_epmc_xml_citation_contexts(xml_text, target_paper=None, max_sentences=3, max_chars=300):
    """Extract up to 3 short verbatim citation sentences (<= 300 chars) from Europe PMC JATS XML."""
    if not xml_text or not isinstance(xml_text, str):
        return []
    ref_ids = set()
    if isinstance(target_paper, dict):
        target_doi = str(target_paper.get("doi") or "").strip().lower()
        target_pmid = str(target_paper.get("pmid") or "").strip()
        target_title = re.sub(r"\W+", " ", str(target_paper.get("title") or "").lower()).strip()
        for match in re.finditer(r'<ref\b[^>]*\bid=["\']([^"\']+)["\'][^>]*>(.*?)</ref>', xml_text, re.I | re.S):
            rid, block = match.group(1), match.group(2)
            block_low = block.lower()
            if (target_doi and target_doi in block_low) or (target_pmid and target_pmid in block_low):
                ref_ids.add(rid)
            elif target_title and len(target_title) >= 12:
                clean_block = re.sub(r"\W+", " ", re.sub(r"<[^>]+>", " ", block_low)).strip()
                if target_title[:40] in clean_block:
                    ref_ids.add(rid)
    sentences = []
    for p_match in re.finditer(r"<p\b[^>]*>(.*?)</p>", xml_text, re.I | re.S):
        p_html = p_match.group(1)
        if "<xref" not in p_html.lower():
            continue
        if ref_ids:
            if not any(re.search(rf'rid=["\'][^"\']*\b{re.escape(rid)}\b', p_html, re.I) for rid in ref_ids):
                continue
        parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(<])", p_html)
        for part in parts:
            if "<xref" not in part.lower():
                continue
            if ref_ids and not any(re.search(rf'rid=["\'][^"\']*\b{re.escape(rid)}\b', part, re.I) for rid in ref_ids):
                continue
            clean_sent = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", part)).strip()
            if len(clean_sent) >= 20:
                sentences.append(clean_sent)
                if len(sentences) >= max_sentences:
                    return normalize_citation_contexts(sentences, max_sentences=max_sentences, max_chars=max_chars)
    return normalize_citation_contexts(sentences, max_sentences=max_sentences, max_chars=max_chars)


def s2_fetch_references(identifier, api_key=None, limit=30):
    limit = min(500, discovery_limit(limit))
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/references?fields=contexts,intents,isInfluential,citedPaper.title,citedPaper.authors,citedPaper.year,citedPaper.venue,citedPaper.externalIds,citedPaper.citationCount,citedPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    has_key = bool(s2_api_key(url, api_key))
    context_cap = limit if has_key else 25
    for idx, item in enumerate((data or {}).get("data") or []):
        cited = item.get("citedPaper")
        if cited and cited.get("title"):
            meta = s2_to_metadata(cited)
            if idx < context_cap:
                _attach_s2_edge_context(meta, item)
            res.append(meta)
    return res

def s2_fetch_citations(identifier, api_key=None, limit=30):
    limit = min(500, discovery_limit(limit))
    url = f"https://api.semanticscholar.org/graph/v1/paper/{identifier}/citations?fields=contexts,intents,isInfluential,citingPaper.title,citingPaper.authors,citingPaper.year,citingPaper.venue,citingPaper.externalIds,citingPaper.citationCount,citingPaper.abstract&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    res = []
    has_key = bool(s2_api_key(url, api_key))
    context_cap = limit if has_key else 25
    for idx, item in enumerate((data or {}).get("data") or []):
        citing = item.get("citingPaper")
        if citing and citing.get("title"):
            meta = s2_to_metadata(citing)
            if idx < context_cap:
                _attach_s2_edge_context(meta, item)
            res.append(meta)
    return res


def s2_enrich_citation_contexts(identifier, direction="citations", api_key=None, limit=25):
    """Optional best-effort citation context enrichment; silently skips on 429 or network error."""
    try:
        has_key = bool(s2_api_key("https://api.semanticscholar.org/graph/v1/paper", api_key))
        eff_limit = min(100 if has_key else 25, max(1, int(limit or 25)))
        if direction == "references":
            return s2_fetch_references(identifier, api_key=api_key, limit=eff_limit)
        return s2_fetch_citations(identifier, api_key=api_key, limit=eff_limit)
    except Exception:
        return []

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
