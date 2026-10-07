import re
from pulse_core.constants import clean_string_list
from pulse_core.doi_utils import same_doi
from pulse_core.metadata_utils import (
    clean_crossref_text,
    crossref_to_metadata,
    first_list_value,
    openalex_to_metadata,
    short_text,
    title_overlap_score,
)

def recommendation_record(metadata, extra, source):
    rec = dict(metadata or {})
    rec["score"] = extra.get("score", 0.0)
    rec["reason"] = extra.get("reason", "")
    rec["recommendationSource"] = source
    rec["isSeed"] = False
    return rec

def openalex_recommendation_item(item):
    meta = openalex_to_metadata(item)
    score = float(item.get("relevance_score") or 0.0)
    cited = item.get("cited_by_count") or 0
    return meta, {"score": round(score, 3), "reason": f"OpenAlex relevance {score:.2f} (cited by {cited})"}

def crossref_recommendation_item(item):
    meta = crossref_to_metadata(item)
    score = float(item.get("score") or 0.0)
    cited = item.get("is-referenced-by-count") or 0
    return meta, {"score": round(score, 3), "reason": f"Crossref score {score:.1f} (cited by {cited})"}

def dimensions_recommendation_item(item):
    title = clean_crossref_text(item.get("title") or "")
    authors = [f"{a.get('first_name', '')} {a.get('last_name', '')}".strip() for a in item.get("authors") or []]
    meta = {
        "title": title,
        "authors": [a for a in authors if a],
        "year": str(item.get("year") or ""),
        "journal": (item.get("journal") or {}).get("title") or "",
        "doi": item.get("doi") or "",
        "abstract": item.get("abstract") or "",
        "citationCount": item.get("times_cited") or 0,
        "metadataSource": "Dimensions",
    }
    score = float(item.get("score") or 0.0)
    return meta, {"score": round(score, 3), "reason": f"Dimensions score {score:.1f} (cited {meta['citationCount']})"}

def steering_terms(values):
    return clean_string_list(values or [], limit=20)

def steering_penalty(item, exclude_terms):
    if not exclude_terms:
        return 0
    text = f"{item.get('title', '')} {item.get('abstract', '')}".lower()
    matches = sum(1 for term in exclude_terms if term.lower() in text)
    return matches * 0.4

def steering_match_score(values, terms):
    if not values or not terms:
        return 0
    text = " ".join(str(v) for v in values).lower()
    return sum(1 for term in terms if term.lower() in text)

def recommendation_query_terms(papers):
    terms = []
    for p in papers or []:
        for t in (p.get("title") or "").split():
            if len(t) > 3:
                terms.append(t.lower())
    return terms[:30]

def openalex_and_terms(papers, query_terms, steer_terms=None):
    base = list(steer_terms or [])
    if not base:
        base = query_terms[:3]
    return [clean_openalex_search_term(t) for t in base if clean_openalex_search_term(t)]

def clean_openalex_search_term(value):
    return re.sub(r"[^a-zA-Z0-9\s]", "", str(value or "")).strip()

def keyword_tokens(text, max_terms=10):
    words = re.findall(r"[a-zA-Z]{4,}", (text or "").lower())
    stops = {"with", "that", "from", "this", "were", "have", "been", "their", "which"}
    terms = [w for w in words if w not in stops]
    return terms[:max_terms]

def recommendation_reason(overlap, cited_by_count, sources=None, author_boost=0, journal_boost=0, penalty=0):
    parts = []
    if overlap:
        parts.append(f"title similarity {overlap:.2f}")
    if cited_by_count:
        parts.append(f"cited by {cited_by_count}")
    if author_boost:
        parts.append("author match")
    if journal_boost:
        parts.append("journal match")
    if sources:
        parts.append(f"via {', '.join(sources)}")
    return ", ".join(parts) or "candidate match"

def recommendation_rank(item, overlap, author_boost=0, journal_boost=0, penalty=0, recency_tilt=0, impact_tilt=0):
    score = overlap * 2.0 + author_boost * 0.3 + journal_boost * 0.2 - penalty
    if impact_tilt and item.get("citationCount"):
        score += min(2.0, (item["citationCount"] / 50.0) * impact_tilt)
    if recency_tilt and item.get("year"):
        try:
            age = max(0, 2026 - int(str(item["year"])[:4]))
            score += max(0, (10 - age) * 0.1 * recency_tilt)
        except ValueError:
            pass
    return round(score, 3)

def merge_recommendations(items, query_terms, seed_terms, excluded_dois, excluded_titles, steering, limit):
    seen_dois = set(str(d).lower() for d in excluded_dois or [])
    seen_titles = set(str(t).lower() for t in excluded_titles or [])
    steer_kw = steering.get("steerKeywords") or []
    exclude_kw = steering.get("excludeKeywords") or []
    ranked = []
    for item in items:
        doi = (item.get("doi") or "").lower()
        title = (item.get("title") or "").lower()
        if doi and doi in seen_dois:
            continue
        if title and title in seen_titles:
            continue
        overlap = title_overlap_score(" ".join(seed_terms), item.get("title") or "")
        pen = steering_penalty(item, exclude_kw)
        rank = recommendation_rank(item, overlap, penalty=pen)
        ranked.append((rank, item))
    ranked.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in ranked[:limit]]
