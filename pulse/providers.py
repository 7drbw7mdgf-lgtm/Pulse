"""Scholarly provider transport and metadata lookups."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
import xml.etree.ElementTree as ET
import json
import os
import re
import socket
import time
import urllib.request
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import get_context, ClientError, DIMENSIONS_API_ROOT, SEMANTIC_SCHOLAR_API_ROOT
from .performance import request_json
from . import metadata as metadata_service
from . import ranking as ranking_service
from . import storage as storage_service


def lookup_pmid_metadata(payload: JSONDict) -> MetadataResult:
    pmid = str(payload.get('pmid') or '').strip()
    if not re.fullmatch(r'\d{1,10}', pmid):
        raise ClientError(400, 'Enter a valid PubMed ID.')
    query = urllib.parse.urlencode({'db':'pubmed', 'id':pmid, 'retmode':'xml', 'tool':'Pulse'})
    request = urllib.request.Request('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' + query, headers={'User-Agent':'Pulse/1.1'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            root = ET.fromstring(response.read(2_000_000))
    except (urllib.error.URLError, TimeoutError, ET.ParseError) as error:
        logger.warning('lookup_pmid_metadata: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(502, f'PubMed lookup failed: {error}')
    article = root.find('.//PubmedArticle')
    if article is None:
        raise ClientError(404, 'No PubMed article found for that ID.')
    def text(path):
        node = article.find(path)
        return ''.join(node.itertext()).strip() if node is not None else ''
    authors = []
    for author in article.findall('.//Author'):
        name = ' '.join(filter(None, [author.findtext('ForeName'), author.findtext('LastName')])) or author.findtext('CollectiveName') or ''
        if name:
            authors.append(name)
    doi = next((node.text for node in article.findall('.//ArticleId') if node.get('IdType') == 'doi'), '')
    return {'metadata': {
        'pmid':pmid, 'title':text('.//ArticleTitle'), 'authors':authors,
        'year':text('.//JournalIssue/PubDate/Year') or text('.//JournalIssue/PubDate/MedlineDate')[:4],
        'journal':text('.//Journal/Title'), 'doi':metadata_service.normalize_doi(doi or ''),
        'abstract':' '.join(''.join(node.itertext()) for node in article.findall('.//AbstractText')),
        'paperKeywords':[''.join(node.itertext()) for node in article.findall('.//Keyword')],
        'metadataSource':'PubMed',
    }}


def lookup_doi_metadata(payload: JSONDict) -> MetadataResult:
    doi = metadata_service.normalize_doi(payload.get("doi") or "")
    if not doi:
        raise ClientError(400, "No DOI was provided.")
    expected_title = metadata_service.clean_crossref_text(payload.get("expectedTitle") or payload.get("title") or "")

    errors = []
    sources = []
    metadata = {}

    try:
        crossref = fetch_json(f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}")
        metadata = metadata_service.merge_metadata(metadata, metadata_service.crossref_to_metadata(crossref.get("message") or {}))
        sources.append("Crossref")
    except ClientError as error:
        logger.warning('lookup_doi_metadata: recovering from expected failure (%s)', type(error).__name__)
        errors.append(str(error))

    try:
        openalex = fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
        metadata = metadata_service.merge_metadata(metadata, metadata_service.openalex_to_metadata(openalex))
        sources.append("OpenAlex")
    except ClientError as error:
        logger.warning('lookup_doi_metadata: recovering from expected failure (%s)', type(error).__name__)
        errors.append(str(error))

    if not metadata.get("title") and not metadata.get("authors"):
        raise ClientError(404, "No usable metadata was found for that DOI. " + " ".join(errors[:2]))
    title_match = metadata_service.doi_title_match(expected_title, metadata.get("title") or "")
    if expected_title and not title_match["ok"]:
        raise ClientError(
            409,
            f"DOI metadata title mismatch for {doi}. Expected '{metadata_service.short_text(expected_title, 90)}' but DOI returned '{metadata_service.short_text(metadata.get('title') or '', 90)}'.",
        )
    return {
        "ok": True,
        "doi": doi,
        "source": " + ".join(sources) or "DOI",
        "metadata": metadata,
        "titleMatch": title_match,
    }


def openalex_work_for_paper(paper: Paper):
    work_id = metadata_service.openalex_work_id(paper.get("openAlexId") or paper.get("openAlexUrl") or "")
    if work_id:
        return fetch_openalex_work_by_id(work_id)
    doi = metadata_service.normalize_doi(paper.get("doi") or "")
    if doi:
        return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
    title = ranking_service.clean_openalex_search_term(paper.get("title") or "")
    if not title:
        return None
    params = urllib.parse.urlencode({"search": title, "per-page": 1})
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    results = data.get("results") or []
    return results[0] if results else None


def fetch_openalex_work_by_id(work_id):
    normalized = metadata_service.openalex_work_id(work_id)
    if not normalized:
        raise ClientError(400, "No OpenAlex work ID was provided.")
    return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote(normalized, safe='')}")


def openalex_citing_ids(work_id, limit=80):
    return [metadata_service.openalex_work_id(item.get("id")) for item in openalex_citing_works(work_id, limit=limit) if metadata_service.openalex_work_id(item.get("id"))]


def openalex_citing_works(work_id, limit=12):
    normalized = metadata_service.openalex_work_id(work_id)
    if not normalized:
        return []
    params = urllib.parse.urlencode({
        "filter": f"cites:{normalized}",
        "sort": "cited_by_count:desc",
        "per-page": max(1, min(limit, 100)),
    })
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    return data.get("results") or []


def openalex_recommendations(search, limit, and_terms=None):
    and_terms = [term for term in (and_terms or []) if term][:3]
    params = {
        "per-page": max(25, limit * 4),
        "sort": "cited_by_count:desc",
    }
    if len(and_terms) >= 3:
        params["filter"] = ",".join(f"default.search:{term}" for term in and_terms)
    else:
        params["search"] = search
    params = urllib.parse.urlencode(params)
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    return [ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(item), source="OpenAlex") for item in data.get("results") or []]


def crossref_recommendations(search, limit):
    params = urllib.parse.urlencode({
        "query.bibliographic": search,
        "rows": max(25, limit * 4),
        "filter": "from-pub-date:2018-01-01",
    })
    data = fetch_json(f"https://api.crossref.org/works?{params}")
    return [ranking_service.recommendation_record(*ranking_service.crossref_recommendation_item(item), source="Crossref") for item in (data.get("message") or {}).get("items") or []]


def dimensions_recommendations(search, limit):
    settings = storage_service.load_settings()
    api_key = resolve_dimensions_api_key(settings)
    if not api_key:
        raise ClientError(400, "Dimensions API key is not configured.")

    token = dimensions_auth_token(api_key)
    safe_search = dsl_string(search)
    query = (
        f'search publications for "{safe_search}" where year >= 2018 '
        f'return publications[title+doi+year+journal+authors+abstract+concepts+times_cited+dimensions_url] '
        f'limit {max(25, limit * 4)}'
    )
    data = post_text_json(
        f"{DIMENSIONS_API_ROOT}/api/dsl/v2",
        query,
        headers={"Authorization": f"JWT {token}"},
        timeout=18,
        error_label="Dimensions API",
    )
    return [ranking_service.recommendation_record(*ranking_service.dimensions_recommendation_item(item), source="Dimensions") for item in data.get("publications") or []]


def s2_cache_get(key, max_age_seconds=600):
    entry = get_context().s2_cache.get(key)
    if not entry:
        return None
    val, timestamp = entry
    if time.time() - timestamp > max_age_seconds:
        get_context().s2_cache.pop(key, None)
        return None
    return val


def s2_cache_set(key, val):
    if len(get_context().s2_cache) > 500:
        get_context().s2_cache.clear()
    get_context().s2_cache[key] = (val, time.time())


def s2_request_headers(api_key=None):
    contact = f"mailto:{get_context().contact_email}" if get_context().contact_email else "academic-research@pulse.local"
    headers = {
        "Accept": "application/json",
        "User-Agent": f"pulse/{get_context().version} ({contact})",
    }
    if api_key:
        headers["x-api-key"] = api_key
    return headers


def fetch_s2_json(url, api_key=None, timeout=14):
    cached = s2_cache_get(url)
    if cached is not None:
        return cached
    request = urllib.request.Request(url, headers=s2_request_headers(api_key), method="GET")
    try:
        return request_json(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        logger.warning('fetch_s2_json: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 404:
            return None
        if error.code == 429:
            raise ClientError(429, "Semantic Scholar rate limit reached. Add an S2 API key in Settings for high limits.")
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
        logger.warning('fetch_s2_json: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(504, f"Semantic Scholar connection timed out: {error}")


def post_s2_json(url, payload: JSONDict, api_key=None, timeout=14):
    cache_key = f"POST:{url}:{json.dumps(payload, sort_keys=True)}"
    cached = s2_cache_get(cache_key)
    if cached is not None:
        return cached
    headers = s2_request_headers(api_key)
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        return request_json(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        logger.warning('post_s2_json: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 429:
            raise ClientError(429, "Semantic Scholar rate limit reached. Add an S2 API key in Settings for high limits.")
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
        logger.warning('post_s2_json: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(504, f"Semantic Scholar connection timed out: {error}")


def s2_paper_id_for_paper(paper: Paper, api_key=None):
    if paper.get("s2PaperId"):
        return paper["s2PaperId"]
    doi = metadata_service.normalize_doi(paper.get("doi") or "")
    if doi:
        return f"DOI:{doi}"
    pmid = metadata_service.clean_field(str(paper.get("pmid") or ""))
    if pmid:
        return f"PMID:{pmid}"
    arxiv = metadata_service.clean_field(str(paper.get("arxiv") or ""))
    if arxiv:
        return f"ARXIV:{arxiv}"
    title = ranking_service.clean_openalex_search_term(paper.get("title") or "")
    if len(title) >= 8:
        try:
            url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/search/match?query={urllib.parse.quote(title)}&fields=paperId,title,year"
            data = fetch_s2_json(url, api_key=api_key)
            results = (data or {}).get("data") or []
            if results and results[0].get("paperId"):
                return results[0]["paperId"]
        except (ClientError, ValueError, KeyError, TypeError):
            logger.warning('s2_paper_id_for_paper: recovering from expected failure')
            pass
    return None


def s2_fetch_references(identifier, api_key=None, limit=30):
    fields = "paperId,title,year,authors,abstract,venue,citationCount,influentialCitationCount,externalIds,isInfluential"
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/{urllib.parse.quote(identifier, safe='')}/references?fields={fields}&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        cited = item.get("citedPaper") or {}
        if not cited or not cited.get("title"):
            continue
        meta = metadata_service.s2_to_metadata(cited)
        record = ranking_service.recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (S2AG)")
        record["isInfluential"] = bool(item.get("isInfluential"))
        record["branch"] = "citationGraph"
        record["subType"] = "Backward"
        record["reason"] = f"Backward citation: foundational reference cited by seed paper{' (Influential citation)' if record['isInfluential'] else ''}."
        results.append(record)
    return results


def s2_fetch_citations(identifier, api_key=None, limit=30):
    fields = "paperId,title,year,authors,abstract,venue,citationCount,influentialCitationCount,externalIds,isInfluential"
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/{urllib.parse.quote(identifier, safe='')}/citations?fields={fields}&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        citing = item.get("citingPaper") or {}
        if not citing or not citing.get("title"):
            continue
        meta = metadata_service.s2_to_metadata(citing)
        record = ranking_service.recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (S2AG)")
        record["isInfluential"] = bool(item.get("isInfluential"))
        record["branch"] = "citationGraph"
        record["subType"] = "Forward"
        record["reason"] = f"Forward citation: downstream paper citing seed paper{' (Influential citation)' if record['isInfluential'] else ''}."
        results.append(record)
    return results


def s2_recommendations(positive_ids, negative_ids=None, api_key=None, limit=30):
    fields = "paperId,title,authors,year,abstract,venue,citationCount,influentialCitationCount,externalIds,url,fieldsOfStudy"
    clean_pos = [pid for pid in (positive_ids or []) if pid][:8]
    if not clean_pos:
        return []
    clean_neg = [nid for nid in (negative_ids or []) if nid][:5]
    payload = {"positivePaperIds": clean_pos}
    if clean_neg:
        payload["negativePaperIds"] = clean_neg
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/recommendations/v1/papers/?fields={fields}&limit={limit}"
    items = []
    try:
        data = post_s2_json(url, payload, api_key=api_key)
        items = (data or {}).get("recommendedPapers") or []
    except ClientError:
        logger.warning('s2_recommendations: recovering from expected failure')
        url_get = f"{SEMANTIC_SCHOLAR_API_ROOT}/recommendations/v1/papers/forpaper/{urllib.parse.quote(clean_pos[0], safe='')}?fields={fields}&limit={limit}"
        data = fetch_s2_json(url_get, api_key=api_key)
        items = (data or {}).get("recommendedPapers") or []
    results = []
    for rank_idx, item in enumerate(items):
        if not item or not item.get("title"):
            continue
        meta = metadata_service.s2_to_metadata(item)
        record = ranking_service.recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (SPECTER2)")
        record["branch"] = "semanticSearch"
        record["subType"] = "SPECTER2"
        record["specterRank"] = rank_idx + 1
        record["reason"] = f"SPECTER2 scientific embedding match (Rank #{rank_idx + 1})."
        results.append(record)
    return results


def s2_paper_search(query, api_key=None, limit=30):
    fields = "paperId,title,authors,year,abstract,venue,citationCount,influentialCitationCount,externalIds,url,fieldsOfStudy,s2FieldsOfStudy"
    params = urllib.parse.urlencode({"query": query, "fields": fields, "limit": limit})
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/search?{params}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        if not item or not item.get("title"):
            continue
        meta = metadata_service.s2_to_metadata(item)
        record = ranking_service.recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar Search")
        record["branch"] = "lexicalConceptual"
        record["subType"] = "S2AG Search"
        record["reason"] = f"Lexical / conceptual search match for '{query[:40]}'."
        results.append(record)
    return results


def s2_recommendations_for_search(papers: List[Paper], search, limit, steer_terms=None):
    settings = storage_service.load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    pos_ids = []
    for paper in papers[:4]:
        pid = s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            pos_ids.append(pid)
    if pos_ids:
        try:
            return s2_recommendations(pos_ids, api_key=api_key, limit=limit)
        except ClientError:
            logger.warning('s2_recommendations_for_search: recovering from expected failure')
            pass
    try:
        return s2_paper_search(search, api_key=api_key, limit=limit)
    except ClientError:
        logger.warning('s2_recommendations_for_search: recovering from expected failure')
        return []


def s2_paper_identifier(paper: Paper):
    return str(paper.get('s2PaperId') or paper.get('paperId') or paper.get('doi') or paper.get('openAlexId') or paper.get('title') or '').lower()


def fetch_json(url):
    contact = f"mailto:{get_context().contact_email}" if get_context().contact_email else "contact-not-configured"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": f"pulse/{get_context().version} ({contact})",
        },
        method="GET",
    )
    try:
        return request_json(request, timeout=12)
    except urllib.error.HTTPError as error:
        logger.warning('fetch_json: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"DOI lookup failed: {details[:500]}")
    except urllib.error.URLError as error:
        logger.warning('fetch_json: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(502, f"Could not reach DOI metadata service: {error.reason}")
    except (TimeoutError, socket.timeout):
        logger.warning('fetch_json: recovering from expected failure')
        raise ClientError(504, "Metadata service timed out.")


def post_text_json(url, text, headers=None, timeout=18, error_label="API"):
    request = urllib.request.Request(
        url,
        data=text.encode("utf-8"),
        headers=headers or {},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning('post_text_json: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"{error_label} error: {details[:500]}")
    except urllib.error.URLError as error:
        logger.warning('post_text_json: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(502, f"Could not reach {error_label}: {error.reason}")
    except (TimeoutError, socket.timeout):
        logger.warning('post_text_json: recovering from expected failure')
        raise ClientError(504, f"{error_label} timed out.")


def dimensions_auth_token(api_key):
    request = urllib.request.Request(
        f"{DIMENSIONS_API_ROOT}/api/auth.json",
        data=json.dumps({"key": api_key}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning('dimensions_auth_token: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Dimensions auth failed: {details[:500]}")
    except urllib.error.URLError as error:
        logger.warning('dimensions_auth_token: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(502, f"Could not reach Dimensions auth: {error.reason}")
    except (TimeoutError, socket.timeout):
        logger.warning('dimensions_auth_token: recovering from expected failure')
        raise ClientError(504, "Dimensions auth timed out.")
    token = data.get("token") or ""
    if not token:
        raise ClientError(502, "Dimensions did not return an API token.")
    return token


def dsl_string(value):
    return re.sub(r"\s+", " ", str(value or "")).replace("\\", "\\\\").replace('"', '\\"').strip()


def resolve_semantic_scholar_api_key(settings: JSONDict):
    return os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or settings.get("semanticScholarApiKey") or ""


def resolve_dimensions_api_key(settings: JSONDict):
    return os.environ.get("DIMENSIONS_API_KEY") or settings.get("dimensionsApiKey") or ""
