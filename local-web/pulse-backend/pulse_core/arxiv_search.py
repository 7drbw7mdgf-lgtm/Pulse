"""Keyless public arXiv search for discovery pipelines."""
import html
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

from pulse_core.constants import APP_VERSION, ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core.search_limits import discovery_limit, SearchResults
from pulse_performance import DiscoveryCancelled, DiscoveryBudgetExceeded, request_json

ATOM_NS = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"

__all__ = ["search_arxiv", "arxiv_to_metadata"]


def _clean_text(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()


def _arxiv_query_text(value):
    words = re.findall(r"[\w-]+", _clean_text(value), flags=re.UNICODE)
    return " ".join(words[:40])[:500]


def arxiv_to_metadata(entry):
    id_elem = entry.find(f"{ATOM_NS}id")
    raw_id = id_elem.text.strip() if id_elem is not None and id_elem.text else ""
    # Format: http://arxiv.org/abs/2104.12345v1 or 2104.12345
    arxiv_id = raw_id.rsplit("/abs/", 1)[-1] if "/abs/" in raw_id else raw_id.rsplit("/", 1)[-1]
    # Strip version suffix for stable identifiers
    clean_arxiv_id = re.sub(r"v\d+$", "", arxiv_id)

    title_elem = entry.find(f"{ATOM_NS}title")
    title = _clean_text(title_elem.text if title_elem is not None and title_elem.text else "")

    summary_elem = entry.find(f"{ATOM_NS}summary")
    abstract = _clean_text(summary_elem.text if summary_elem is not None and summary_elem.text else "")

    authors = []
    for author_elem in entry.findall(f"{ATOM_NS}author"):
        name_elem = author_elem.find(f"{ATOM_NS}name")
        if name_elem is not None and name_elem.text:
            name = _clean_text(name_elem.text)
            if name:
                authors.append(name)

    published_elem = entry.find(f"{ATOM_NS}published")
    pub_raw = published_elem.text.strip() if published_elem is not None and published_elem.text else ""
    year = pub_raw[:4] if pub_raw[:4].isdigit() else ""
    date = pub_raw[:10] if len(pub_raw) >= 10 and pub_raw[:4].isdigit() else year

    doi_elem = entry.find(f"{ARXIV_NS}doi")
    doi = normalize_doi(doi_elem.text.strip()) if doi_elem is not None and doi_elem.text else ""

    primary_cat = ""
    cat_elem = entry.find(f"{ARXIV_NS}primary_category")
    if cat_elem is not None:
        primary_cat = cat_elem.attrib.get("term", "")

    pdf_url = ""
    for link in entry.findall(f"{ATOM_NS}link"):
        if link.attrib.get("title") == "pdf" or link.attrib.get("type") == "application/pdf":
            pdf_url = link.attrib.get("href", "")
            break
    if not pdf_url and clean_arxiv_id:
        pdf_url = f"https://arxiv.org/pdf/{clean_arxiv_id}.pdf"

    abs_url = f"https://arxiv.org/abs/{clean_arxiv_id}" if clean_arxiv_id else (f"https://doi.org/{doi}" if doi else "")

    full_text_links = []
    if pdf_url:
        full_text_links.append({"url": pdf_url, "format": "PDF", "source": "arXiv"})

    meta = {
        "title": title,
        "authors": authors,
        "doi": doi,
        "year": year,
        "date": date,
        "abstract": abstract,
        "journal": f"arXiv:{primary_cat}" if primary_cat else "arXiv",
        "arxivId": clean_arxiv_id,
        "publicationType": "preprint",
        "url": abs_url,
        "fullTextUrl": pdf_url,
        "fullTextLinks": full_text_links,
        "isOpenAccess": True,
        "metadataSource": "arXiv",
        "source": "arXiv",
        "recommendationSource": "arXiv",
        "sourceList": ["arXiv"],
        "sourceIdentifiers": {"arXiv": clean_arxiv_id} if clean_arxiv_id else {},
        "citationCount": None,
        "citedByCount": None,
    }
    return meta


def search_arxiv(query, limit=30, structured=False, **kwargs):
    clean_query = query if structured else _arxiv_query_text(query)
    if not clean_query:
        return SearchResults()

    limit = discovery_limit(limit)
    gathered = SearchResults()

    # Search in all fields: ti, au, abs
    encoded_query = urllib.parse.quote(f"all:{clean_query}")
    url = f"https://export.arxiv.org/api/query?search_query={encoded_query}&start=0&max_results={min(limit, 50)}&sortBy=relevance&sortOrder=descending"

    headers = {
        "User-Agent": f"Pulse/{APP_VERSION}",
        "Accept": "application/atom+xml, application/xml, text/xml",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")

    try:
        data = request_json(req, timeout=12)
        # Note: request_json decodes JSON when Content-Type is json, but arXiv returns XML text.
        # However, request_json attempts json.loads which may raise ValueError on raw XML.
    except ValueError:
        # Expected for raw XML string if request_json didn't parse XML
        pass
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception as error:
        gathered.warning = f"arXiv search: {error}"
        return gathered

    # Fallback direct request for XML if request_json expects JSON
    try:
        req_xml = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req_xml, timeout=12) as resp:
            content = resp.read()
        root = ET.fromstring(content)
        for entry in root.findall(f"{ATOM_NS}entry"):
            meta = arxiv_to_metadata(entry)
            if meta.get("title"):
                gathered.append(meta)
                if len(gathered) >= limit:
                    break
    except (DiscoveryCancelled, DiscoveryBudgetExceeded):
        raise
    except Exception as error:
        gathered.warning = f"arXiv search: {error}"

    return gathered
