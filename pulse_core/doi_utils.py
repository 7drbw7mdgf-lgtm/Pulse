import html
import re
import urllib.parse
from .pdf_utils import decode_pdf_streams

DOI_PREFIX_PATTERN = r"10\.\d{4,9}(?:\.\d+)*"
DOI_CHARS = r"[-._;()/:A-Za-z0-9<>+]"
DOI_CORE_PATTERN = DOI_PREFIX_PATTERN + "/" + DOI_CHARS + "+"
DOI_MATCH_RE = re.compile(r"(?<![0-9.])" + DOI_CORE_PATTERN, re.I)
DOI_DASH_TABLE = dict.fromkeys(map(ord, "‐‑‒–—―−﹘﹣－"), "-")
DOI_DASH_TABLE.update(dict.fromkeys(map(ord, "­​‌‍⁠﻿"), None))
DOI_DASH_TABLE[ord("／")] = "/"
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
    def collapse_spaced(match):
        joined = match.group(0).replace(" ", "")
        return joined if re.search(r"10\.\d{4}", joined) else match.group(0)

    text = re.sub(r"(?<!\S)(?:\S{1,2} ){5,}\S{1,2}(?!\S)", collapse_spaced, text)
    text = re.sub(r"(10\.\d{4,9}(?:\.\d+)*)[ \t]*/[ \t]*", r"\1/", text)
    return text

def join_wrapped_dois(text):
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

def balance_doi_brackets(doi):
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

def doi_matches(value):
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

def normalize_doi(value):
    matches = doi_matches(value)
    return matches[0][0] if matches else ""

def re_search_doi(value):
    return normalize_doi(value)

def same_doi(left, right):
    a = normalize_doi(left)
    return bool(a) and a.lower() == normalize_doi(right).lower()

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

def scan_doi_from_bytes(raw):
    candidates = scan_doi_candidates_from_bytes(raw)
    return candidates[0] if candidates else ""
