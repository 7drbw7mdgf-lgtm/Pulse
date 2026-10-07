"""Paper normalization, DOI parsing and provider metadata conversion."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
from datetime import datetime
import html
import re
import time
import zlib
import urllib.request
import zlib
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
MAX_DECOMPRESSED_STREAM_BYTES = 2 * 1024 * 1024
MAX_TOTAL_DECOMPRESSED_BYTES = 8 * 1024 * 1024

from .context import get_context, DEFAULT_GEMMA_MODEL, LOCAL_BACKEND_DEFAULTS


def readable_text_score(text):
    sample = str(text or "")[:4000]
    if not sample.strip():
        return 0.0
    letters = len(re.findall(r"[A-Za-z]", sample))
    controls = len(re.findall(r"[\x00-\x08\x0E-\x1F]", sample))
    pdf_objects = len(re.findall(r"/(?:Length|Filter|FlateDecode|XObject|SMask|Width|Height|stream|endstream)\b", sample))
    return (letters / max(len(sample), 1)) - controls * 0.01 - pdf_objects * 0.05


def clean_extracted_text(value):
    lines = []
    for line in str(value or "").replace("\r", "\n").split("\n"):
        cleaned = clean_crossref_text(line)
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def title_overlap_score(query, candidate):
    query_terms = set(keyword_tokens(query, max_terms=24))
    candidate_terms = set(keyword_tokens(candidate, max_terms=24))
    if not query_terms or not candidate_terms:
        return 0.0
    return len(query_terms & candidate_terms) / max(len(query_terms), 1)


def title_match_tokens(value):
    stop = {
        "paper", "article", "review", "study", "analysis", "abstract", "title",
        "research", "using", "based", "towards", "toward", "between", "among",
    }
    return {
        token for token in keyword_tokens(value, max_terms=40)
        if len(token) >= 4 and token not in stop
    }


def normalized_title_text(value):
    return re.sub(r"[^a-z0-9]+", " ", clean_crossref_text(value).lower()).strip()


def doi_title_match(expected, returned):
    expected_clean = normalized_title_text(expected)
    returned_clean = normalized_title_text(returned)
    if not expected_clean or not returned_clean or len(expected_clean) < 16:
        return {"ok": True, "score": 0, "reason": "no reliable expected title"}
    if expected_clean in returned_clean or returned_clean in expected_clean:
        return {"ok": True, "score": 1, "reason": "title substring match"}
    expected_terms = title_match_tokens(expected_clean)
    returned_terms = title_match_tokens(returned_clean)
    if not expected_terms or not returned_terms:
        return {"ok": True, "score": 0, "reason": "not enough title tokens"}
    overlap = len(expected_terms & returned_terms)
    expected_score = overlap / max(len(expected_terms), 1)
    returned_score = overlap / max(len(returned_terms), 1)
    score = max(expected_score, returned_score)
    ok = score >= 0.52 or (overlap >= 4 and score >= 0.38)
    return {
        "ok": ok,
        "score": round(score, 3),
        "overlap": sorted(expected_terms & returned_terms)[:16],
        "reason": "title token match" if ok else "title token mismatch",
    }


def short_text(value, limit=90):
    text = clean_crossref_text(value)
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "..."


def openalex_work_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"\bW\d+\b", text)
    return match.group(0) if match else ""


def s2_to_metadata(item) -> Metadata:
    if not item:
        return {}
    authors = []
    for author in item.get("authors") or []:
        name = author.get("name") if isinstance(author, dict) else str(author)
        cleaned = clean_author_name(name)
        if cleaned:
            authors.append(cleaned)
    external_ids = item.get("externalIds") or {}
    doi = normalize_doi(external_ids.get("DOI") or item.get("doi") or "")
    venue = item.get("venue") or ""
    year = item.get("year")
    date_val = str(year) if year else ""
    fields_of_study = []
    for f in (item.get("s2FieldsOfStudy") or []):
        if isinstance(f, dict) and f.get("category"):
            fields_of_study.append(f["category"])
    for f in (item.get("fieldsOfStudy") or []):
        if isinstance(f, str):
            fields_of_study.append(f)
    abstract = clean_crossref_text(item.get("abstract") or "")
    title = clean_crossref_text(item.get("title") or "")
    paper_id = item.get("paperId") or ""
    return {
        "title": title,
        "authors": authors[:24],
        "date": date_val,
        "year": date_val,
        "journal": clean_crossref_text(venue),
        "doi": doi,
        "abstract": abstract,
        "paperKeywords": dedupe_strings(fields_of_study)[:24],
        "s2PaperId": paper_id,
        "citationCount": item.get("citationCount") or 0,
        "influentialCitationCount": item.get("influentialCitationCount") or 0,
        "url": item.get("url") or (f"https://www.semanticscholar.org/paper/{paper_id}" if paper_id else (f"https://doi.org/{doi}" if doi else "")),
        "openAccessPdf": (item.get("openAccessPdf") or {}).get("url") or "",
    }


def keyword_tokens(text, max_terms=10):
    words = re.findall(r"[A-Za-z][A-Za-z-]{3,}", clean_crossref_text(text).lower())
    stop = {
        "this", "that", "with", "from", "into", "using", "paper", "study", "result", "results",
        "method", "methods", "analysis", "research", "journal", "article", "review", "based",
        "between", "through", "within", "their", "there", "these", "those", "have", "been",
    }
    counts = {}
    for word in words:
        if word not in stop:
            counts[word] = counts.get(word, 0) + 1
    return [word for word, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:max_terms]]


def normalize_title_key(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def scan_doi_from_bytes(raw):
    candidates = scan_doi_candidates_from_bytes(raw)
    return candidates[0] if candidates else ""


def scan_doi_candidates_from_bytes(raw):
    chunks = []
    sample = raw[:8_000_000]
    for encoding in ("utf-8", "latin-1", "utf-16", "utf-16le", "utf-16be"):
        try:
            chunks.append(sample.decode(encoding, errors="ignore"))
        except LookupError:
            continue
    strings = re.findall(rb"[\x20-\x7E]{8,}", sample)
    chunks.extend(item.decode("latin-1", errors="ignore") for item in strings[:20000])
    chunks.extend(decode_pdf_streams(sample))
    return ranked_doi_candidates("\n\n".join(chunks))


DOI_PREFIX_PATTERN = r"10\.\d{4,9}(?:\.\d+)*"


DOI_CHARS = r"[-._;()/:A-Za-z0-9<>+]"


DOI_CORE_PATTERN = DOI_PREFIX_PATTERN + "/" + DOI_CHARS + "+"


DOI_MATCH_RE = re.compile(r"(?<![0-9.])" + DOI_CORE_PATTERN, re.I)


DOI_DASH_TABLE = dict.fromkeys(map(ord, "‐‑‒–—―−﹘﹣－"), "-")


DOI_NON_PAPER_PREFIXES = ("10.13039/",)


DOI_GLUED_TAIL_RE = re.compile(
    r"(?<=[0-9a-z)])(?:Received|Accepted|Published|Available|Copyright|Citation|Cite|Keywords|Abstract|"
    r"Downloaded|Supplementary|Correspondence|Article|ORCID|PMID|PMCID|ISSN|Email|E-mail|https?:|www\.)[\s\S]*$"
)


DOI_URL_SUFFIX_RE = re.compile(
    r"(?:/(?:full|abstract|pdf|epdf|pdfdirect|fulltext|summary|references|meta|html)"
    r"|\.(?:full|abstract|supplementary)(?:\.pdf(?:\+html)?|\.html)?|\.pdf)+$",
    re.I,
)


DOI_MARKER_RE = re.compile(
    r"(?:\bdoi\b|doi\.org/|prism:doi|dc:identifier|identifier)[\s:=>\"'(/]*(?:(?:abs|full|pdf|epdf|pdfdirect)/)?$",
    re.I,
)


DOI_REFERENCES_RE = re.compile(
    r"\n[ \t]*(?:\d+\.?[ \t]*)?(?:References(?: and Notes)?|REFERENCES|Bibliography|BIBLIOGRAPHY|"
    r"Literature Cited|LITERATURE CITED|Works Cited|Reference List)[ \t:]*\n"
)


DOI_NEW_ITEM_GUARD = r"(?![Dd][Oo][Ii]\b|[Hh][Tt][Tt][Pp][Ss]?:|[Ww][Ww][Ww]\.|\S*?10\.\d{4,9}/)"


def prepare_doi_text(value):
    """Normalise text so DOIs survive PDF extraction, HTML and URL encoding."""
    text = str(value or "").translate(DOI_DASH_TABLE)
    text = text.replace("\\/", "/")
    if "&" in text:
        text = html.unescape(text)
    text = re.sub(
        r"(?<!\S)[^\s%]*%(?:2F|3C|3E|28|29|3A|3B)\S*",
        lambda m: urllib.parse.unquote(m.group(0)),
        text,
        flags=re.I,
    )
    # Letter-spaced extraction ("1 0 . 1 0 3 8 / n a t u r e") from tracked fonts.
    def collapse_spaced(match):
        joined = match.group(0).replace(" ", "")
        return joined if re.search(r"10\.\d{4}", joined) else match.group(0)

    text = re.sub(r"(?<!\S)(?:\S{1,2} ){5,}\S{1,2}(?!\S)", collapse_spaced, text)
    text = re.sub(r"(10\.\d{4,9}(?:\.\d+)*)[ \t]*/[ \t]*", r"\1/", text)
    return text


def join_wrapped_dois(text):
    """Rejoin DOIs that a PDF line break split in two.

    A break after "/" or "-" is always mid-DOI. A break after "." or "_" is
    joined only when the next line continues in lowercase or digits and does
    not look like a numbered reference ("2. Smith"). Case-sensitive on purpose.
    """
    always = re.sub(
        r"(" + DOI_PREFIX_PATTERN + r"/(?:" + DOI_CHARS + r"*[-/])?)[ \t]*\r?\n[ \t]*" + DOI_NEW_ITEM_GUARD + r"(?=[A-Za-z0-9(])",
        r"\1",
        text,
    )
    return re.sub(
        r"(" + DOI_PREFIX_PATTERN + r"/" + DOI_CHARS + r"*[._])[ \t]*\r?\n[ \t]*(?!\d{1,3}[.)][ \t])" + DOI_NEW_ITEM_GUARD + r"(?=[a-z0-9])",
        r"\1",
        always,
    )


def doi_matches(value):
    """Return [(doi, position, text)] for every cleaned DOI in document order."""
    prepared = prepare_doi_text(value)
    joined = join_wrapped_dois(prepared)
    found = []
    seen = set()
    for source_index, text in enumerate((joined, prepared) if joined != prepared else (joined,)):
        for match in DOI_MATCH_RE.finditer(text):
            doi = clean_doi_candidate(match.group(0))
            key = doi.lower()
            if key in seen or not valid_doi_candidate(doi):
                continue
            # The unwrapped text only adds DOIs the line-joined text did not
            # already contain in longer form (drop "10.1093/nar/" stubs).
            if source_index and any(other.lower().startswith(key) for other, *_ in found):
                continue
            seen.add(key)
            found.append((doi, match.start(), text, source_index))
    return found


def ranked_doi_candidates(value):
    matches = doi_matches(value)
    if not matches:
        return []
    ranked = []
    refs_by_text = {}
    for doi, position, text, source_index in matches:
        if source_index not in refs_by_text:
            refs_by_text[source_index] = [m.start() for m in DOI_REFERENCES_RE.finditer(text)]
        refs = refs_by_text[source_index]
        score = 0
        if DOI_MARKER_RE.search(text[max(0, position - 40):position]):
            score += 4
        if refs and position > refs[-1]:
            score -= 5
        if position < 4000:
            score += 1
        if source_index:
            score -= 1
        ranked.append((-score, source_index, position, doi))
    ranked.sort()
    return [item[3] for item in ranked[:12]]


def balance_doi_brackets(doi):
    """Cut at the first unbalanced "<" or ">" so HTML never leaks into a DOI."""
    depth = 0
    open_at = -1
    for index, char in enumerate(doi):
        if char == "<":
            if depth == 0:
                open_at = index
            depth += 1
        elif char == ">":
            if depth == 0:
                return doi[:index]
            depth -= 1
    return doi[:open_at] if depth else doi


def clean_doi_candidate(value):
    clean = prepare_doi_text(value).strip()
    clean = re.sub(r"^\s*(?:https?://)?(?:www\.|dx\.)?doi\.org/", "", clean, flags=re.I)
    clean = re.sub(r"^\s*doi\s*[:=]?\s*", "", clean, flags=re.I)
    clean = re.sub(r"\s+", "", clean)
    clean = clean.strip("\"'{}[]")
    clean = re.split(r"<(?=[/!?A-Za-z])", clean)[0]
    clean = re.split(r"\)?(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)\b", clean)[0]
    # PDF link annotations: "/URI (https://doi.org/10.x/y)/S/URI".
    clean = re.split(r"\)/(?:S|URI|Type|Subtype|Rect|Border|BS|A|F|H|C|D|Dest|Next|NM|M|P|StructParent)\b", clean)[0]
    clean = re.split(r"(?=/+(?:Height|Filter|FlateDecode|Type|XObject|Width|SMask|Length|BitsPerComponent|ColorSpace|Subtype|stream|endstream)\b)", clean, flags=re.I)[0]
    clean = re.split(r"(?:>>|<<|endobj|\bobj\b|\bstream\b)", clean, flags=re.I)[0]
    clean = balance_doi_brackets(clean)
    clean = DOI_GLUED_TAIL_RE.sub("", clean)
    for _ in range(3):
        before = clean
        clean = clean.rstrip(".,;:'\"")
        while clean.endswith(")") and clean.count("(") < clean.count(")"):
            clean = clean[:-1].rstrip(".,;:")
        clean = DOI_URL_SUFFIX_RE.sub("", clean)
        clean = re.sub(r"^(10\.1101/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,})v\d+$", r"\1", clean)
        if clean == before:
            break
    return clean


def valid_doi_candidate(doi):
    if not doi or not re.match(r"^10\.\d{4,9}(?:\.\d+)*/", doi, re.I):
        return False
    if doi.lower().startswith(DOI_NON_PAPER_PREFIXES):
        return False
    suffix = doi.split("/", 1)[1] if "/" in doi else ""
    if len(suffix) < 2 or len(doi) > 200:
        return False
    if re.search(r"[^\x20-\x7E]", doi):
        return False
    if re.search(r"[\\{}\[\]|^`\s]", doi):
        return False
    if balance_doi_brackets(doi) != doi:
        return False
    if re.search(r"^10\.\d+/(?:obj|stream|length|filter|type|height|width|xobject|smask|bitspercomponent)\b", doi, re.I):
        return False
    if re.search(r"(?:/Length|/Filter|/FlateDecode|/Type|/XObject|/Width|/Height|>>|<<|stream)", doi, re.I):
        return False
    if re.search(r"\)(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)$", doi):
        return False
    return True


def same_doi(left, right):
    a = normalize_doi(left)
    return bool(a) and a.lower() == normalize_doi(right).lower()


def safe_decompress_flate(candidate, max_bytes=MAX_DECOMPRESSED_STREAM_BYTES):
    try:
        return zlib.decompress(candidate, max_length=max_bytes)
    except TypeError:
        try:
            d = zlib.decompressobj()
            return d.decompress(candidate, max_bytes)
        except (zlib.error, MemoryError):
            logger.warning("PDF stream decompression failed")
            return None
    except (zlib.error, MemoryError):
        return None

def decode_pdf_streams(raw):
    decoded = []
    total_decompressed = 0
    stream_count = 0
    for match in re.finditer(rb"<<(?P<dict>[\s\S]{0,2000}?/FlateDecode[\s\S]{0,2000}?)>>\s*stream\r?\n(?P<body>[\s\S]*?)\r?\nendstream", raw):
        stream_count += 1
        if stream_count > 120 or total_decompressed >= MAX_TOTAL_DECOMPRESSED_BYTES:
            break
        body = match.group("body").strip(b"\r\n")
        if len(body) > 5 * 1024 * 1024:
            continue
        for candidate in zlib_candidates(body):
            remaining = MAX_TOTAL_DECOMPRESSED_BYTES - total_decompressed
            allowed = min(MAX_DECOMPRESSED_STREAM_BYTES, max(0, remaining))
            if allowed <= 0:
                break
            inflated = safe_decompress_flate(candidate, max_bytes=allowed)
            if inflated:
                total_decompressed += len(inflated)
                decoded.extend(decode_pdf_text_bytes(inflated))
                break
    return decoded

def zlib_candidates(body):
    yield body
    if body.startswith(b"\r\n") or body.startswith(b"\n"):
        yield body.lstrip(b"\r\n")
    for index in range(min(len(body), 12)):
        yield body[index:]

def decode_pdf_text_bytes(data):
    if not data:
        return []
    if len(data) > MAX_DECOMPRESSED_STREAM_BYTES:
        data = data[:MAX_DECOMPRESSED_STREAM_BYTES]
    chunks = []
    for encoding in ("utf-8", "latin-1", "utf-16be", "utf-16le"):
        chunks.append(data.decode(encoding, errors="ignore")[:60000])
    strings = re.findall(rb"[\x20-\x7E]{4,}", data)
    chunks.extend(item.decode("latin-1", errors="ignore") for item in strings[:2000])
    return chunks


def merge_metadata(base, incoming) -> Metadata:
    merged = dict(base or {})
    for key, value in (incoming or {}).items():
        if key in {"authors", "paperKeywords", "referenceIds", "citedByIds", "keyFindings", "organisms", "techniques", "discoveryTerms", "doiCandidates"}:
            merged[key] = dedupe_strings([*(merged.get(key) or []), *(value or [])])
        elif value and (not merged.get(key) or key == "abstract" and len(str(value)) > len(str(merged.get(key) or ""))):
            merged[key] = value
    return merged


def merge_verified_doi_metadata(extracted, verified) -> Metadata:
    merged = merge_metadata(extracted, verified)
    for key in ("doi", "title", "authors", "date", "year", "journal", "openAlexId", "openAlexUrl"):
        if verified.get(key):
            merged[key] = verified[key]
    if verified.get("abstract") and len(str(verified.get("abstract"))) >= len(str(merged.get("abstract") or "")):
        merged["abstract"] = verified["abstract"]
    merged["paperKeywords"] = dedupe_strings([
        *(verified.get("paperKeywords") or []),
        *(merged.get("paperKeywords") or []),
    ])[:24]
    return merged


def metadata_completeness_score(metadata: Metadata):
    score = 0
    if metadata.get("doi"):
        score += 3
    if metadata.get("title"):
        score += 3
    if metadata.get("authors"):
        score += 2
    if metadata.get("date") or metadata.get("year"):
        score += 1
    if metadata.get("journal"):
        score += 1
    if len(metadata.get("abstract") or "") >= 120:
        score += 2
    if metadata.get("paperKeywords"):
        score += 1
    return score


def clamp_float(value, minimum, maximum, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def metadata_is_filled(metadata: Metadata):
    return (
        bool(metadata.get("doi"))
        and bool(metadata.get("title"))
        and bool(metadata.get("authors"))
        and bool(metadata.get("date") or metadata.get("year"))
        and bool(metadata.get("journal"))
        and (len(metadata.get("abstract") or "") >= 120 or bool(metadata.get("paperKeywords")))
    )


def normalize_doi(value):
    """First DOI in the value, cleaned. Case is preserved; compare with same_doi()."""
    matches = doi_matches(value)
    return matches[0][0] if matches else ""


def re_search_doi(value):
    return normalize_doi(value)


def crossref_to_metadata(item) -> Metadata:
    title = first_list_value(item.get("title"))
    journal = (
        first_list_value(item.get("container-title"))
        or first_list_value(item.get("short-container-title"))
        or first_list_value(item.get("institution"))
        or item.get("publisher", "")
    )
    date = crossref_date(item)
    abstract = clean_crossref_text(item.get("abstract") or "")
    authors = []
    for author in item.get("author") or []:
        name = " ".join(part for part in [author.get("given", ""), author.get("family", "")] if part).strip()
        if not name:
            name = author.get("name") or ""
        cleaned = clean_author_name(name)
        if cleaned:
            authors.append(cleaned)

    keywords = []
    for key in ("subject", "reference"):
        if key == "subject":
            keywords.extend(value for value in item.get(key) or [] if isinstance(value, str))

    return {
        "title": clean_crossref_text(title),
        "authors": authors[:24],
        "date": date,
        "year": date[:4] if date else "",
        "journal": clean_crossref_text(journal),
        "doi": normalize_doi(item.get("DOI") or ""),
        "abstract": abstract,
        "paperKeywords": dedupe_strings(keywords)[:24],
    }


def openalex_to_metadata(item) -> Metadata:
    primary = item.get("primary_location") or {}
    source = primary.get("source") or {}
    authors = []
    for authorship in item.get("authorships") or []:
        author = authorship.get("author") or {}
        cleaned = clean_author_name(author.get("display_name") or "")
        if cleaned:
            authors.append(cleaned)

    date = item.get("publication_date") or (str(item.get("publication_year")) if item.get("publication_year") else "")
    keywords = []
    for concept in item.get("concepts") or []:
        if concept.get("display_name") and float(concept.get("score") or 0) >= 0.15:
            keywords.append(concept["display_name"])
    for keyword in item.get("keywords") or []:
        if keyword.get("display_name"):
            keywords.append(keyword["display_name"])

    return {
        "title": clean_crossref_text(item.get("title") or item.get("display_name") or ""),
        "authors": authors[:24],
        "date": date,
        "year": str(item.get("publication_year") or "") or date[:4],
        "journal": clean_crossref_text(source.get("display_name") or ""),
        "doi": normalize_doi(item.get("doi") or item.get("DOI") or ""),
        "abstract": clean_crossref_text(reconstruct_openalex_abstract(item.get("abstract_inverted_index") or {})),
        "paperKeywords": dedupe_strings(keywords)[:24],
        "openAlexId": openalex_work_id(item.get("id") or ""),
        "openAlexUrl": item.get("id") or "",
        "referenceIds": [openalex_work_id(value) for value in item.get("referenced_works") or [] if openalex_work_id(value)][:120],
        "citedByCount": item.get("cited_by_count") or 0,
    }


def reconstruct_openalex_abstract(index):
    if not isinstance(index, dict) or not index:
        return ""
    positions = []
    for word, word_positions in index.items():
        for position in word_positions or []:
            try:
                positions.append((int(position), str(word)))
            except (TypeError, ValueError):
                continue
    return " ".join(word for _, word in sorted(positions))


def first_list_value(value):
    if isinstance(value, list) and value:
        return str(value[0] or "")
    if isinstance(value, str):
        return value
    return ""


def crossref_date(item):
    for key in ("published-print", "published-online", "published", "issued", "created"):
        parts = ((item.get(key) or {}).get("date-parts") or [[]])[0]
        if parts:
            return "-".join(str(part).zfill(2) if index else str(part) for index, part in enumerate(parts[:3]))
    return ""


def clean_crossref_text(value):
    text = str(value or "")
    if not text:
        return ""
    abstract_section = re.search(
        r"<jats:sec[^>]*>\s*<jats:title>\s*Abstract\s*</jats:title>([\s\S]*?)(?=<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*</jats:title>|</jats:sec>\s*$)",
        text,
        re.I,
    )
    if abstract_section:
        text = abstract_section.group(1)
    text = re.sub(r"<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*</jats:title>[\s\S]*?</jats:sec>", " ", text, flags=re.I)
    text = re.sub(r"</?(?:jats:)?title[^>]*>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clean_author_name(s):
    if not s:
        return ""
    s = re.sub(r"\s*\([^)]*\)", "", str(s))
    s = re.sub(r"\s*\[[^\]]*\]", "", s)
    s = re.sub(r"^[\s\d*†‡§#.,;:\x22'([\]{}<>/\\-]+", "", s).strip()
    s = re.sub(r"[\s*†‡§#,:;\x22'([\]{}<>/\\-]+$", "", s).strip()
    if re.search(r"[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]{2,}\.$", s):
        s = s[:-1].strip()
    return s


def dedupe_strings(values):
    seen = set()
    result = []
    for value in values:
        clean = str(value or "").strip()
        key = clean.lower()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def normalize_gemma_model(value):
    model = str(value or "").strip()
    if not model or model.lower() in {"default", "auto"}:
        return DEFAULT_GEMMA_MODEL
    return model


def normalize_ollama_endpoint(value, api_name):
    endpoint = str(value or "").strip() or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"]
    return endpoint_with_api(endpoint, api_name)


def endpoint_with_api(endpoint, api_name):
    parsed = urllib.parse.urlparse(endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/api/chat") or path.endswith("/api/generate") or path.endswith("/api/embeddings") or path.endswith("/api/tags"):
        base_path = re.sub(r"/api/(chat|generate|embeddings|tags)$", "", path)
        new_path = f"{base_path}/api/{api_name}" if base_path else f"/api/{api_name}"
    else:
        new_path = f"{path}/api/{api_name}" if path else f"/api/{api_name}"
    return urllib.parse.urlunparse(parsed._replace(path=new_path, params="", query="", fragment=""))


def time_seconds():
    import time
    return time.time()


def time_sleep(seconds):
    import time
    time.sleep(seconds)


def time_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def html_escape(value):
    return html.escape(str(value or ""))



def clean_field(value: str) -> str:
    """Trim an external identifier before constructing a provider request."""
    return value.strip()
