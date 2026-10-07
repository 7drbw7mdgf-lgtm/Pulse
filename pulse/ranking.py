"""Existing candidate merge and ranking algorithms."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
import re
import urllib.error
import urllib.parse
import logging
from .context import get_context
from . import metadata as metadata_service


def recommendation_record(metadata: Metadata, extra, source) -> Paper:
    return {
        **metadata,
        "source": source,
        "sourceList": [source],
        "openAlexId": extra.get("openAlexId") or "",
        "url": extra.get("url") or "",
        "citedByCount": extra.get("citedByCount") or 0,
    }


def openalex_recommendation_item(item):
    return metadata_service.openalex_to_metadata(item), {
        "openAlexId": item.get("id") or "",
        "url": item.get("doi") or item.get("id") or "",
        "citedByCount": item.get("cited_by_count") or 0,
    }


def crossref_recommendation_item(item):
    return metadata_service.crossref_to_metadata(item), {
        "url": f"https://doi.org/{metadata_service.normalize_doi(item.get('DOI') or '')}" if item.get("DOI") else (item.get("URL") or ""),
        "citedByCount": item.get("is-referenced-by-count") or 0,
    }


def dimensions_recommendation_item(item):
    journal = item.get("journal") or {}
    authors = []
    for author in item.get("authors") or []:
        if isinstance(author, dict):
            name = " ".join(part for part in [author.get("first_name", ""), author.get("last_name", "")] if part).strip()
            if not name:
                name = author.get("name") or ""
        elif isinstance(author, str):
            name = author
        else:
            name = ""
        cleaned = metadata_service.clean_author_name(name)
        if cleaned:
            authors.append(cleaned)
    concepts = []
    for concept in item.get("concepts") or []:
        if isinstance(concept, str):
            concepts.append(concept)
        elif isinstance(concept, dict) and concept.get("name"):
            concepts.append(concept["name"])
    metadata = {
        "title": metadata_service.clean_crossref_text(item.get("title") or ""),
        "authors": authors[:24],
        "date": str(item.get("year") or ""),
        "year": str(item.get("year") or ""),
        "journal": metadata_service.clean_crossref_text(journal.get("title") if isinstance(journal, dict) else journal),
        "doi": metadata_service.normalize_doi(item.get("doi") or ""),
        "abstract": metadata_service.clean_crossref_text(item.get("abstract") or ""),
        "paperKeywords": metadata_service.dedupe_strings(concepts)[:24],
    }
    return metadata, {
        "url": item.get("dimensions_url") or (f"https://doi.org/{metadata['doi']}" if metadata.get("doi") else ""),
        "citedByCount": item.get("times_cited") or 0,
    }


def merge_recommendations(items, query_terms, seed_terms, excluded_dois, excluded_titles, steering, limit):
    merged = {}
    for item in items:
        doi = metadata_service.normalize_doi(item.get("doi") or "")
        title_key = metadata_service.normalize_title_key(item.get("title") or "")
        if not item.get("title") or doi.lower() in excluded_dois or title_key in excluded_titles:
            continue
        key = doi.lower() or title_key
        if not key:
            continue
        existing = merged.get(key)
        if not existing:
            merged[key] = item
        else:
            existing["sourceList"] = metadata_service.dedupe_strings([*(existing.get("sourceList") or []), *(item.get("sourceList") or [])])
            existing["source"] = " + ".join(existing["sourceList"])
            existing["citedByCount"] = max(int(existing.get("citedByCount") or 0), int(item.get("citedByCount") or 0))
            existing["paperKeywords"] = metadata_service.dedupe_strings([*(existing.get("paperKeywords") or []), *(item.get("paperKeywords") or [])])[:24]
            for field in ("abstract", "url", "journal", "date", "year", "doi"):
                if not existing.get(field) and item.get(field):
                    existing[field] = item[field]

    ranked = []
    for item in merged.values():
        penalty = steering_penalty(item, steering.get("excludeTerms") or [])
        if penalty >= 2:
            continue
        concepts = item.get("paperKeywords") or []
        overlap = [term for term in concepts if term.lower() in seed_terms]
        if not overlap:
            item_terms = set(re.findall(r"[a-z][a-z-]{3,}", f"{item.get('title') or ''} {item.get('abstract') or ''}".lower()))
            overlap = [term for term in query_terms if term.lower() in item_terms][:5]
        author_boost = steering_match_score(item.get("authors") or [], steering.get("authors") or [])
        journal_boost = steering_match_score([item.get("journal") or ""], steering.get("journals") or [])
        item["reason"] = recommendation_reason(overlap, item.get("citedByCount") or 0, item.get("sourceList") or [item.get("source") or "source"], author_boost, journal_boost, penalty)
        item["_rank"] = recommendation_rank(item, overlap, author_boost, journal_boost, penalty, steering.get("recencyTilt") or 0, steering.get("impactTilt") or 0)
        ranked.append(item)

    ranked.sort(key=lambda item: item.get("_rank", 0), reverse=True)
    for item in ranked:
        item.pop("_rank", None)
    return ranked[:limit]


def recommendation_rank(item, overlap, author_boost=0, journal_boost=0, penalty=0, recency_tilt=0, impact_tilt=0):
    year_match = re.search(r"\b(19|20)\d{2}\b", str(item.get("year") or item.get("date") or ""))
    year = int(year_match.group(0)) if year_match else 0
    recency_weight = max(0, 2 + float(recency_tilt))
    citation_weight = max(0, 0.10 + float(impact_tilt) * 0.05)
    recency = max(0, year - 2017) * recency_weight
    citations = min(int(item.get("citedByCount") or 0), 500) * citation_weight
    sources = len(item.get("sourceList") or [])
    novelty = (2 - float(impact_tilt)) * 2 if int(item.get("citedByCount") or 0) < 25 else 0
    seminal = max(0, -float(recency_tilt)) * 6 if year and year < 2018 else 0
    return len(overlap) * 40 + recency + citations + novelty + seminal + sources * 12 + author_boost * 34 + journal_boost * 24 - penalty * 70


def steering_penalty(item, exclude_terms):
    haystack = " ".join([
        item.get("title") or "",
        item.get("abstract") or "",
        item.get("journal") or "",
        " ".join(item.get("paperKeywords") or []),
    ]).lower()
    return sum(1 for term in exclude_terms if term and term.lower() in haystack)


def steering_match_score(values, terms):
    haystack = " ; ".join(str(value or "") for value in values).lower()
    return sum(1 for term in terms if term and term.lower() in haystack)


def recommendation_query_terms(papers: List[Paper]):
    weighted = []
    for paper in papers[:4]:
        for field in ("title", "journal"):
            weighted.extend(metadata_service.keyword_tokens(paper.get(field) or "", max_terms=8))
        for keyword in [
            *(paper.get("keywords") or []),
            *(paper.get("paperKeywords") or []),
            *(paper.get("gemmaKeywords") or []),
            *(paper.get("organisms") or []),
            *(paper.get("techniques") or []),
            *(paper.get("discoveryTerms") or []),
        ]:
            weighted.append(str(keyword).strip())
        for finding in paper.get("keyFindings") or []:
            weighted.extend(metadata_service.keyword_tokens(finding, max_terms=4))
        weighted.extend(metadata_service.keyword_tokens(paper.get("abstract") or "", max_terms=12))
    return metadata_service.dedupe_strings(weighted)[:28]


def steering_terms(values):
    terms = []
    for value in values:
        term = clean_openalex_search_term(value)
        if term and term not in terms:
            terms.append(term)
    return terms[:12]


def openalex_and_terms(papers: List[Paper], query_terms, steer_terms=None):
    explicit = list(steer_terms or [])
    for paper in papers[:4]:
        for keyword in [
            *(paper.get("discoveryTerms") or []),
            *(paper.get("keywords") or []),
            *(paper.get("paperKeywords") or []),
            *(paper.get("gemmaKeywords") or []),
            *(paper.get("organisms") or []),
            *(paper.get("techniques") or []),
        ]:
            explicit.append(keyword)
    candidates = metadata_service.dedupe_strings([*explicit, *query_terms])
    terms = []
    for candidate in candidates:
        term = clean_openalex_search_term(candidate)
        if term and term not in terms:
            terms.append(term)
        if len(terms) == 3:
            return terms
    return terms


def clean_openalex_search_term(value):
    text = metadata_service.clean_crossref_text(value)
    text = re.sub(r"[^A-Za-z0-9 -]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    if len(text) < 4:
        return ""
    return text[:80]


def recommendation_reason(overlap, cited_by_count, sources=None, author_boost=0, journal_boost=0, penalty=0):
    source_text = f" Found via {' + '.join(sources or [])}." if sources else ""
    steering = []
    if author_boost:
        steering.append("author steering")
    if journal_boost:
        steering.append("venue steering")
    if penalty:
        steering.append("lightly penalized by exclude terms")
    steering_text = f" Boosted by {', '.join(steering)}." if steering else ""
    if overlap:
        return f"Matches selected-paper themes: {', '.join(overlap[:5])}.{steering_text}{source_text}"
    if cited_by_count:
        return f"Highly cited result from the same search space ({cited_by_count} citations).{steering_text}{source_text}"
    return f"Ranked as a close title/abstract match for the selected paper.{steering_text}{source_text}"
