import re

def title_match_tokens(value):
    clean = re.sub(r"[^a-z0-9\s]", " ", (value or "").lower())
    stops = {"a", "an", "the", "and", "or", "of", "to", "in", "on", "with", "for", "by", "as", "at"}
    return [t for t in clean.split() if len(t) > 1 and t not in stops]

def normalized_title_text(value):
    return " ".join(title_match_tokens(value))

def title_overlap_score(query, candidate):
    q_tokens = set(title_match_tokens(query))
    c_tokens = set(title_match_tokens(candidate))
    if not q_tokens or not c_tokens:
        return 0.0
    common = q_tokens & c_tokens
    return round(len(common) / max(len(q_tokens), len(c_tokens)), 3)

def doi_title_match(expected, returned):
    if not expected or not returned:
        return {"ok": True, "score": 1.0}
    exp_tokens = set(title_match_tokens(expected))
    ret_tokens = set(title_match_tokens(returned))
    if not exp_tokens or not ret_tokens:
        return {"ok": True, "score": 1.0}
    overlap = exp_tokens & ret_tokens
    score = len(overlap) / max(1, min(len(exp_tokens), len(ret_tokens)))
    return {"ok": score >= 0.45 or len(overlap) >= 3, "score": round(score, 3)}

def short_text(value, limit=90):
    val = (value or "").strip()
    return val if len(val) <= limit else val[:limit] + "..."

def clean_crossref_text(value):
    if not value:
        return ""
    clean = re.sub(r"<[^>]+>", " ", str(value))
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean

def clean_author_name(s):
    if not s:
        return ""
    clean = re.sub(r"<[^>]+>", "", str(s))
    return re.sub(r"\s+", " ", clean).strip()

def first_list_value(value):
    if isinstance(value, list) and value:
        return value[0]
    return value if isinstance(value, str) else ""

def crossref_date(item):
    for field in ("published-print", "published-online", "issued", "created"):
        parts = (item.get(field) or {}).get("date-parts")
        if parts and isinstance(parts, list) and parts[0] and parts[0][0]:
            return str(parts[0][0])
    return ""

def crossref_to_metadata(item):
    if not isinstance(item, dict):
        return {}
    title = clean_crossref_text(first_list_value(item.get("title") or ""))
    authors = []
    for author in item.get("author") or []:
        name = " ".join(filter(None, [author.get("given"), author.get("family")])).strip()
        if not name and author.get("name"):
            name = author.get("name").strip()
        if name:
            authors.append(clean_author_name(name))
    journal = clean_crossref_text(first_list_value(item.get("container-title") or ""))
    year = crossref_date(item)
    doi = (item.get("DOI") or "").strip()
    abstract = clean_crossref_text(item.get("abstract") or "")
    return {
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
        "doi": doi,
        "abstract": abstract,
        "citationCount": item.get("is-referenced-by-count") or 0,
        "metadataSource": "Crossref",
        "volume": str(item.get("volume") or ""), "issue": str(item.get("issue") or ""),
        "pages": str(item.get("page") or ""), "issn": "; ".join(item.get("ISSN") or []),
        "keywords": "; ".join(item.get("subject") or []),
    }

def reconstruct_openalex_abstract(index):
    if not isinstance(index, dict):
        return ""
    tokens = []
    for word, positions in index.items():
        for p in positions:
            tokens.append((p, word))
    tokens.sort(key=lambda x: x[0])
    return " ".join(word for _, word in tokens)

def openalex_to_metadata(item):
    if not isinstance(item, dict):
        return {}
    title = clean_crossref_text(item.get("title") or "")
    authors = []
    for authorship in item.get("authorships") or []:
        author = authorship.get("author") or {}
        name = (author.get("display_name") or "").strip()
        if name:
            authors.append(clean_author_name(name))
    host_venue = (item.get("primary_location") or {}).get("source") or item.get("host_venue") or {}
    journal = (host_venue.get("display_name") or "").strip()
    year = str(item.get("publication_year") or "")
    doi = (item.get("doi") or "").replace("https://doi.org/", "").strip()
    abstract = reconstruct_openalex_abstract(item.get("abstract_inverted_index"))
    return {
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
        "doi": doi,
        "abstract": abstract,
        "citationCount": item.get("cited_by_count") or 0,
        "openAlexId": item.get("id"),
        "metadataSource": "OpenAlex",
        "volume": str((item.get("biblio") or {}).get("volume") or ""),
        "issue": str((item.get("biblio") or {}).get("issue") or ""),
        "pages": str((item.get("biblio") or {}).get("first_page") or ""),
        "keywords": "; ".join(entry.get("display_name") or "" for entry in item.get("keywords") or []),
    }

def merge_metadata(base, incoming):
    res = dict(base or {})
    for k, v in (incoming or {}).items():
        if v and not res.get(k):
            res[k] = v
        elif k == "authors" and v and len(v) > len(res.get("authors") or []):
            res["authors"] = v
        elif k == "citationCount" and isinstance(v, (int, float)) and v > (res.get("citationCount") or 0):
            res["citationCount"] = v
    return res

def merge_verified_doi_metadata(extracted, verified):
    merged = merge_metadata(extracted, verified)
    merged["doiVerified"] = True
    return merged

def metadata_completeness_score(metadata):
    if not metadata:
        return 0
    score = 0
    if metadata.get("title"): score += 35
    if metadata.get("authors"): score += 25
    if metadata.get("doi"): score += 15
    if metadata.get("year"): score += 10
    if metadata.get("journal"): score += 10
    if metadata.get("abstract"): score += 5
    return score

def clamp_float(value, minimum, maximum, fallback):
    try:
        val = float(value)
        return max(minimum, min(maximum, val))
    except (TypeError, ValueError):
        return fallback

def metadata_is_filled(metadata):
    return bool(metadata and metadata.get("title") and metadata.get("authors"))

def normalize_title_key(value):
    return " ".join(title_match_tokens(value))
