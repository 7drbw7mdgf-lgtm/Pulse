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
    scan_doi_candidates_from_bytes,
    DOI_REFERENCES_RE,
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
    # Only enforce title mismatch when expected_title is a substantive title (not a filename or generic fallback)
    is_placeholder_title = (
        not expected_title
        or expected_title.lower().endswith(".pdf")
        or expected_title.lower().startswith("untitled")
        or len(expected_title.split()) < 3
        or "/" in expected_title
        or "_" in expected_title
    )
    if expected_title and not is_placeholder_title and not title_match["ok"]:
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

def extract_pdf_details_from_text(text, filename=""):
    meta = {}
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    if not lines:
        return meta
    abs_match = re.search(r'(?i)\babstract\b[:\s\n]*(.*?)(?:\n\s*(?:1[\.\s]|introduction|keywords|index terms|background)|$)', text, re.DOTALL)
    if abs_match:
        abstract = " ".join(abs_match.group(1).split())[:2500]
        if len(abstract) > 30:
            meta["abstract"] = abstract
    for l in lines[:15]:
        lower = l.lower()
        if re.search(r'\b(tm|tj|cm|et|bt|do|rg)\b', lower) or re.search(r'^\d+(\.\d+)?\s+\d+(\.\d+)?', l):
            continue
        if 15 <= len(l) <= 220 and not lower.startswith(('http', 'doi', 'vol', 'issn', 'isbn', 'page', 'arxiv', 'copyright', 'journal', 'proceedings')):
            meta["title"] = l
            break
    if not meta.get("title"):
        clean_name = re.sub(r"\.[a-zA-Z0-9]+$", "", filename or "")
        meta["title"] = re.sub(r"[\_\-]+", " ", clean_name).strip()
    authors = []
    for l in lines[1:8]:
        lower = l.lower()
        if any(w in lower for w in ['department', 'university', 'institute', 'abstract', 'introduction', 'email', '@', 'http']):
            continue
        parts = [a.strip() for a in re.split(r'[,;]|\band\b', l) if a.strip() and 2 <= len(a.strip()) <= 40]
        if len(parts) >= 1 and all(p[0].isupper() for p in parts if p):
            authors.extend(parts)
            if len(authors) >= 1:
                break
    if authors:
        meta["authors"] = authors[:10]
    year_match = re.search(r'\b(19\d{2}|20[0-2]\d)\b', text[:2000])
    if year_match:
        meta["year"] = year_match.group(1)
        meta["date"] = year_match.group(1)
    return meta

def _scan_file_for_metadata_local(payload):
    import base64
    from .pdf_utils import extract_document
    from .metadata_resolution import extract_text_metadata, primary_doi_candidates
    raw = payload.get("content") or b""
    if not raw and payload.get("contentBase64"):
        try:
            raw = base64.b64decode(payload["contentBase64"], validate=True)
        except Exception:
            raise ClientError(400, "The uploaded file could not be decoded.")
    if len(raw) > 35_000_000:
        raise ClientError(413, "Import a file smaller than 35 MB.")
    name = payload.get("filename") or payload.get("name") or ""
    try:
        document = extract_document(raw, name)
    except Exception as error:
        raise ClientError(400, "Could not read this document: " + str(error))
    text = document["text"]
    parsed = merge_metadata(document.get("metadata"), extract_text_metadata(text, name))
    # Explicit document/XMP identifiers and readable front matter come first.
    candidates = primary_doi_candidates(document.get("doiText"))
    candidates += [doi for doi in primary_doi_candidates(text) if doi not in candidates]
    # Raw bytes are a last resort. Do not borrow DOIs from a reference list.
    if not candidates and not DOI_REFERENCES_RE.search(text):
        candidates = scan_doi_candidates_from_bytes(raw)[:3]
    return {"ok": True, "doi": candidates[0] if candidates else "", "candidates": candidates[:4],
            "title": parsed.get("title") or "", "text": text, "metadata": parsed,
            "extractionSource": document.get("extractionSource"),
            "textAvailable": bool(text), "pageCount": document.get("pageCount")}


def scan_file_for_metadata(payload):
    from .metadata_resolution import resolve_metadata
    res = _scan_file_for_metadata_local(payload)
    # Resolution handles DOI verification and all available metadata fallback.
    resolution = resolve_metadata({**res["metadata"], "text": res["text"],
                                   "name": payload.get("name") or payload.get("filename") or "",
                                   "doiCandidates": res["candidates"]})
    res["metadata"] = resolution["metadata"]
    res["doi"] = resolution["metadata"].get("doi") or ""
    res["title"] = resolution["metadata"].get("title") or res["title"]
    res["source"] = resolution.get("source") or "Extracted metadata"
    res["resolution"] = resolution
    res["gemmaProcessed"] = False
    return res
