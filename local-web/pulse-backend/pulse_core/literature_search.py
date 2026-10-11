"""Public literature search, with bounded transport and provider provenance."""
import html
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from pulse_core.constants import APP_VERSION, ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_performance import DiscoveryCancelled, request_json

__all__ = ["search_europe_pmc", "search_core", "europe_pmc_to_metadata", "core_to_metadata", "literature_query"]


def text(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()


def safe_url(value):
    value = str(value or "").strip()
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return ""
    return value if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username else ""


def number(value):
    try:
        return max(0, int(value)) if value is not None and not isinstance(value, bool) else None
    except (TypeError, ValueError, OverflowError):
        return None


def publication_date(value):
    # Preserve only the precision supplied by a publication field, not an index date.
    raw = text(value)
    for pattern, output in (("%Y-%m-%d", "%Y-%m-%d"), ("%Y-%m", "%Y-%m"), ("%Y", "%Y"),
                            ("%Y %b %d", "%Y-%m-%d"), ("%Y %b", "%Y-%m"),
                            ("%Y %B %d", "%Y-%m-%d"), ("%Y %B", "%Y-%m")):
        try:
            return datetime.strptime(raw.split("T")[0], pattern).strftime(output)
        except ValueError:
            pass
    return ""


def links(values):
    result, seen = [], set()
    for item in values:
        url = safe_url(item.get("url"))
        if url and url not in seen:
            seen.add(url)
            result.append({"url": url, "format": text(item.get("format")), "source": text(item.get("source"))})
    return result[:12]


def provider_metadata(meta, source, identifier, count):
    meta.update(metadataSource=source, source=source, recommendationSource=source,
                sourceList=[source], sourceIdentifiers={source: identifier})
    if count is not None:
        meta.update(citationCount=count, citedByCount=count, citationCountSource=source,
                    citationCountsBySource={source: count})
    full_text = meta.get("fullTextLinks") or []
    meta["fullTextUrl"] = next((item["url"] for item in full_text if item["format"] == "html"), full_text[0]["url"] if full_text else "")
    return meta


def europe_pmc_to_metadata(item):
    info = item.get("journalInfo") or {}
    journal = info.get("journal") or {}
    authors = [text(" ".join([a["firstName"], a["lastName"]]) if a.get("firstName") and a.get("lastName") else a.get("fullName") or " ".join(filter(None, [a.get("firstName"), a.get("lastName")])))
               for a in (item.get("authorList") or {}).get("author") or [] if isinstance(a, dict)]
    if not any(authors) and item.get("authorString"):
        authors = [text(a) for a in str(item["authorString"]).split(",")]
    source, identifier = text(item.get("source")), text(item.get("id"))
    pmcid = text(item.get("pmcid") or (identifier if source == "PMC" else ""))
    doi = normalize_doi(item.get("doi"))
    # Europe PMC's firstPublicationDate can supply inferred month/day values.
    # journalInfo.dateOfPublication describes the publication's actual precision.
    date = publication_date(info.get("dateOfPublication"))
    year = text(info.get("yearOfPublication") or item.get("pubYear") or str(item.get("firstPublicationDate") or "")[:4])
    if year == "0":
        year = ""
    full_text = links({"url": link.get("url"), "format": link.get("documentStyle"), "source": "Europe PMC"}
                      for link in (item.get("fullTextUrlList") or {}).get("fullTextUrl") or []
                      if isinstance(link, dict) and (link.get("availabilityCode") == "F" or str(link.get("availability")).lower() in {"free", "open access"}))
    meta = {"title": text(item.get("title")), "authors": [a for a in authors if a], "doi": doi,
            "year": year, "date": date or year, "journal": text(journal.get("title") or journal.get("medlineAbbreviation")),
            "volume": text(info.get("volume")), "issue": text(info.get("issue")), "pages": text(item.get("pageInfo")),
            "issn": text(journal.get("issn") or journal.get("essn")), "abstract": text(item.get("abstractText")),
            "paperKeywords": [text(k) for k in (item.get("keywordList") or {}).get("keyword") or [] if text(k)],
            "pmid": identifier if source == "MED" else "", "pmcid": pmcid, "europePmcId": source + "/" + identifier,
            "language": text(item.get("language")), "license": text(item.get("license")),
            "publicationType": "; ".join(text(value) for value in (item.get("pubTypeList") or {}).get("pubType") or []),
            "url": "https://europepmc.org/article/" + urllib.parse.quote(source, safe="") + "/" + urllib.parse.quote(identifier, safe="") if source and identifier else ("https://doi.org/" + doi if doi else ""),
            "fullTextLinks": full_text, "isOpenAccess": item.get("isOpenAccess") == "Y"}
    return provider_metadata(meta, "Europe PMC", source + "/" + identifier, number(item.get("citedByCount")))


def core_to_metadata(item):
    authors = [text(a.get("name")) if isinstance(a, dict) else text(a) for a in item.get("authors") or []]
    journals = [j for j in item.get("journals") or [] if isinstance(j, dict)]
    journal = journals[0] if journals else {}
    doi = normalize_doi(item.get("doi"))
    if not doi:
        doi = next((normalize_doi(i.get("identifier")) for i in item.get("identifiers") or []
                    if isinstance(i, dict) and str(i.get("type")).lower() == "doi"), "")
    date = publication_date(item.get("publishedDate"))
    identifier = text(item.get("id"))
    raw_links = [link for link in item.get("links") or [] if isinstance(link, dict)]
    download = safe_url(item.get("downloadUrl"))
    full_text = links([{"url": download, "format": "pdf", "source": "CORE"}] +
                      [{"url": url, "source": "CORE"} for url in item.get("sourceFulltextUrls") or []] +
                      [{"url": link.get("url"), "format": "pdf" if link.get("type") == "download" else "html", "source": "CORE"}
                       for link in raw_links if link.get("type") in {"download", "reader"}])
    display = next((safe_url(link.get("url")) for link in raw_links if link.get("type") == "display" and safe_url(link.get("url"))), "")
    meta = {"title": text(item.get("title")), "authors": [a for a in authors if a], "doi": doi,
            "year": text(item.get("yearPublished") or date[:4]), "date": date or text(item.get("yearPublished")),
            "journal": text(journal.get("title")), "issn": "; ".join(text(i) for i in journal.get("identifiers") or [] if isinstance(i, str)),
            "abstract": text(item.get("abstract")), "publisher": text(item.get("publisher")),
            "pmid": text(item.get("pubmedId")), "coreId": identifier,
            "url": display or ("https://core.ac.uk/works/" + urllib.parse.quote(identifier, safe="") if identifier else ("https://doi.org/" + doi if doi else "")),
            "fullTextLinks": full_text, "downloadUrl": download,
            "language": text((item.get("language") or {}).get("code")) if isinstance(item.get("language"), dict) else text(item.get("language")),
            "publicationType": text(item.get("documentType"))}
    # CORE fullText may be a permission message. Search keeps metadata and links;
    # it never mistakes that message (or an entire document) for an abstract.
    # CORE reports 0 when it has no citation data, so 0 means "unknown" here.
    return provider_metadata(meta, "CORE", identifier, number(item.get("citationCount")) or None)


def query_text(value):
    # Treat incoming metadata as literal search text, not Lucene field/operators.
    return " ".join(re.findall(r"[\w-]+", text(value), flags=re.UNICODE))[:700]


def literature_query(seeds, steer_keywords=None):
    if steer_keywords:
        return query_text(" ".join(steer_keywords))
    terms = []
    for seed in seeds[:2]:
        keywords = seed.get("paperKeywords") or seed.get("keywords") or []
        if isinstance(keywords, str):
            keywords = keywords.split(";")
        terms.extend(keywords[:4] or re.findall(r"\w+", seed.get("title") or "")[:8])
    return query_text(" ".join(dict.fromkeys(terms)))


def fetch_search(url, source, api_key=""):
    headers = {"User-Agent": "Pulse/" + APP_VERSION, "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    try:
        data = request_json(urllib.request.Request(url, headers=headers), timeout=14)
        if not isinstance(data, dict):
            raise ClientError(502, source + " returned an invalid search response.")
        return data
    except DiscoveryCancelled:
        raise
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        message = "Search limit reached; try again later." if status == 429 else "Search unavailable (HTTP " + str(status) + ")."
        if source == "CORE" and status in {401, 403}:
            message = "Access unavailable. Try again later or add a CORE API key in Search sources settings."
        # Do not echo upstream bodies/URLs, which can contain credentials.
        raise ClientError(502, source + ": " + message) from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise ClientError(502, source + " could not be reached. Try again later.") from None


def search_europe_pmc(query, limit=30, doi="", structured=False):
    query = 'DOI:"' + normalize_doi(doi) + '"' if doi else (str(query)[:1000] if structured else query_text(query))
    if not query:
        return []
    from pulse_core.search_limits import discovery_limit
    params = urllib.parse.urlencode({"query": query, "format": "json", "resultType": "core", "pageSize": discovery_limit(limit), "synonym":"YES"})
    data = fetch_search("https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + params, "Europe PMC")
    if not isinstance(data.get("resultList"), dict) or not isinstance(data["resultList"].get("result"), list):
        raise ClientError(502, "Europe PMC returned an invalid search response.")
    return [europe_pmc_to_metadata(item) for item in (data.get("resultList") or {}).get("result") or [] if isinstance(item, dict) and text(item.get("title"))]


def search_core(query, limit=30, api_key="", doi="", structured=False):
    query = 'doi:"' + normalize_doi(doi) + '"' if doi else (str(query)[:1000] if structured else query_text(query))
    if not query:
        return []
    from pulse_core.search_limits import discovery_limit, SearchResults
    limit = discovery_limit(limit)
    records = SearchResults()
    offset = 0
    while offset < limit:
        page_size = min(100, limit - offset)
        params = urllib.parse.urlencode({"q": query, "limit": page_size, "offset": offset})
        try:
            data = fetch_search("https://api.core.ac.uk/v3/search/works/?" + params, "CORE", api_key)
            if not isinstance(data.get("results"), list):
                raise ClientError(502, "CORE returned an invalid search response.")
        except ClientError as error:
            return records.keep_partial(error)
        rows = data["results"]
        records.extend(core_to_metadata(item) for item in rows[:page_size] if isinstance(item, dict) and text(item.get("title")))
        offset += len(rows)
        if len(rows) < page_size or (isinstance(data.get("totalHits"), int) and offset >= data["totalHits"]):
            break
    return records
