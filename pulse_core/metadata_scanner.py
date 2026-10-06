import pulse_core as _core
from pulse_core.metadata_utils import doi_title_match
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pulse_core.constants import ClientError
from pulse_core.doi_utils import (
    clean_doi_candidate,
    doi_matches,
    
    normalize_doi,
    scan_doi_from_bytes,
    valid_doi_candidate,
)
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_utils import (
    clean_crossref_text,
    crossref_to_metadata,
    merge_metadata,
    openalex_to_metadata,
    short_text,
    title_overlap_score,
)
from pulse_core.pdf_utils import extract_text_from_upload

def lookup_pmid_metadata(payload):
    pmid = str(payload.get("pmid") or "").strip()
    if not re.fullmatch(r"\d{1,10}", pmid):
        raise ClientError(400, "Enter a valid PubMed ID.")
    query = urllib.parse.urlencode({"db": "pubmed", "id": pmid, "retmode": "xml", "tool": "Pulse"})
    request = urllib.request.Request("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?" + query, headers={"User-Agent": "Pulse/1.3"})
    try:
        with _core.urllib.request.urlopen(request, timeout=15) as response:
            root = ET.fromstring(response.read(2_000_000))
    except (urllib.error.URLError, TimeoutError, ET.ParseError) as error:
        raise ClientError(502, f"PubMed lookup failed: {error}")
    article = root.find(".//PubmedArticle")
    if article is None:
        raise ClientError(404, "No PubMed article found for that ID.")
    def text(path):
        node = article.find(path)
        return "".join(node.itertext()).strip() if node is not None else ""
    authors = []
    for author in article.findall(".//Author"):
        name = " ".join(filter(None, [author.findtext("ForeName"), author.findtext("LastName")])) or author.findtext("CollectiveName") or ""
        if name:
            authors.append(name)
    doi = next((node.text for node in article.findall(".//ArticleId") if node.get("IdType") == "doi"), "")
    return {"metadata": {
        "pmid": pmid,
        "title": text(".//ArticleTitle"),
        "authors": authors,
        "year": text(".//JournalIssue/PubDate/Year") or text(".//JournalIssue/PubDate/MedlineDate")[:4],
        "journal": text(".//Journal/Title"),
        "doi": normalize_doi(doi or ""),
        "abstract": " ".join("".join(node.itertext()) for node in article.findall(".//AbstractText")),
        "paperKeywords": ["".join(node.itertext()) for node in article.findall(".//Keyword")],
        "metadataSource": "PubMed",
    }}

def lookup_doi_metadata(payload):
    doi = normalize_doi(payload.get("doi") or "")
    if not doi:
        raise ClientError(400, "No DOI was provided.")
    expected_title = clean_crossref_text(payload.get("expectedTitle") or payload.get("title") or "")
    errors = []
    sources = []
    metadata = {}
    try:
        crossref = fetch_json(f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}")
        metadata = merge_metadata(metadata, crossref_to_metadata(crossref.get("message") or {}))
        sources.append("Crossref")
    except ClientError as error:
        errors.append(str(error))
    try:
        openalex = fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
        metadata = merge_metadata(metadata, openalex_to_metadata(openalex))
        sources.append("OpenAlex")
    except ClientError as error:
        errors.append(str(error))
    if not metadata.get("title") and not metadata.get("authors"):
        raise ClientError(404, "No usable metadata was found for that DOI. " + " ".join(errors[:2]))
    title_match = doi_title_match(expected_title, metadata.get("title") or "")
    if expected_title and not title_match["ok"]:
        raise ClientError(
            409,
            f"DOI metadata title mismatch for {doi}. Expected '{short_text(expected_title, 90)}' but DOI returned '{short_text(metadata.get('title') or '', 90)}'.",
        )
    return {
        "ok": True,
        "doi": doi,
        "source": " + ".join(sources) or "DOI",
        "metadata": metadata,
        "titleMatch": title_match,
    }

def title_from_text_or_name(text, name):
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    for l in lines[:10]:
        if 15 <= len(l) <= 180 and not l.lower().startswith(("http", "doi", "vol", "issn", "page")):
            return l
    clean_name = re.sub(r"\.[a-zA-Z0-9]+$", "", name or "")
    return re.sub(r"[_\-]+", " ", clean_name).strip()

def lookup_metadata_by_title(text, name):
    title = title_from_text_or_name(text, name)
    if not title:
        return {}
    try:
        url = f"https://api.crossref.org/works?query.title={urllib.parse.quote(title)}&rows=1"
        data = fetch_json(url)
        items = (data.get("message") or {}).get("items") or []
        if items:
            return crossref_to_metadata(items[0])
    except Exception:
        pass
    return {}

def _scan_file_for_metadata_local(payload):
    raw = payload.get("content") or b""
    name = payload.get("filename") or ""
    text = extract_text_from_upload(raw, name)
    doi = scan_doi_from_bytes(raw)
    title = title_from_text_or_name(text, name)
    return {
        "ok": True,
        "doi": doi,
        "title": title,
        "text": text,
        "metadata": {"title": title, "doi": doi},
    }

def scan_file_for_metadata(payload):
    res = _scan_file_for_metadata_local(payload)
    doi = res.get("doi")
    if doi:
        try:
            lookup = lookup_doi_metadata({"doi": doi})
            res["metadata"] = merge_metadata(res.get("metadata"), lookup.get("metadata"))
        except Exception:
            pass
    return res
