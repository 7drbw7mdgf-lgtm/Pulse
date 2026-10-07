"""Discovery orchestration and existing citation traversal algorithms."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
import re
import urllib.request
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import get_context, ClientError
from .performance import parallel_branches, parallel_lookup
from . import metadata as metadata_service
from . import providers as providers_service
from . import ranking as ranking_service
from . import storage as storage_service


def recommend_papers(payload: JSONDict):
    papers = payload.get("papers") or []
    if not papers:
        raise ClientError(400, "Select at least one paper before asking for recommendations.")

    limit = min(max(int(payload.get("limit") or 8), 1), 12)
    excluded_dois = {metadata_service.normalize_doi(value).lower() for value in payload.get("excludeDois") or [] if metadata_service.normalize_doi(value)}
    excluded_titles = {metadata_service.normalize_title_key(value) for value in payload.get("excludeTitles") or [] if metadata_service.normalize_title_key(value)}
    steer_terms = ranking_service.steering_terms(payload.get("steerKeywords") or [])
    exclude_terms = ranking_service.steering_terms(payload.get("excludeKeywords") or [])[:16]
    steer_authors = ranking_service.steering_terms(payload.get("steerAuthors") or [])[:10]
    steer_journals = ranking_service.steering_terms(payload.get("steerJournals") or [])[:10]
    recency_tilt = metadata_service.clamp_float(payload.get("recencyTilt"), -2, 2, 0)
    impact_tilt = metadata_service.clamp_float(payload.get("impactTilt"), -2, 2, 0)
    query_terms = metadata_service.dedupe_strings([*steer_terms, *ranking_service.recommendation_query_terms(papers)])
    if not query_terms:
        raise ClientError(400, "The selected paper does not have enough title, abstract, or keyword text to search from.")

    search = " ".join(metadata_service.dedupe_strings([*query_terms[:18], *steer_authors[:4], *steer_journals[:4]]))
    openalex_terms = ranking_service.openalex_and_terms(papers, query_terms, steer_terms)
    seed_terms = {term.lower() for term in query_terms}
    gathered = []
    source_status = []
    source_calls = [
        ("Semantic Scholar (S2AG)", lambda: providers_service.s2_recommendations_for_search(papers, search, limit, steer_terms)),
        ("OpenAlex", lambda: providers_service.openalex_recommendations(search, limit, openalex_terms)),
        ("Crossref", lambda: providers_service.crossref_recommendations(search, limit)),
        ("Dimensions", lambda: providers_service.dimensions_recommendations(search, limit)),
    ]
    for source_name, source_call in source_calls:
        try:
            items = source_call()
            gathered.extend(items)
            source_status.append({"source": source_name, "ok": True, "count": len(items)})
        except ClientError as error:
            logger.warning('recommend_papers: recovering from expected failure (%s)', type(error).__name__)
            source_status.append({"source": source_name, "ok": False, "error": str(error)})

    recommendations = ranking_service.merge_recommendations(
        gathered,
        query_terms,
        seed_terms,
        excluded_dois,
        excluded_titles,
        {
            "excludeTerms": exclude_terms,
            "authors": steer_authors,
            "journals": steer_journals,
            "recencyTilt": recency_tilt,
            "impactTilt": impact_tilt,
        },
        limit,
    )

    return {
        "ok": True,
        "query": search,
        "steerKeywords": steer_terms,
        "excludeKeywords": exclude_terms,
        "steerAuthors": steer_authors,
        "steerJournals": steer_journals,
        "recencyTilt": recency_tilt,
        "impactTilt": impact_tilt,
        "openAlexQuery": " AND ".join(openalex_terms) if len(openalex_terms) >= 3 else search,
        "source": " + ".join(item["source"] for item in source_status if item.get("ok")) or "Recommendations",
        "sources": source_status,
        "recommendations": recommendations,
    }


def enrich_citations(payload: JSONDict):
    papers = payload.get("papers") or []
    if not papers:
        raise ClientError(400, "No papers were provided for citation enrichment.")
    enriched = []
    errors = []
    for paper in papers[:80]:
        try:
            work = providers_service.openalex_work_for_paper(paper)
            if not work:
                continue
            metadata = metadata_service.openalex_to_metadata(work)
            metadata["citedByIds"] = providers_service.openalex_citing_ids(metadata.get("openAlexId") or work.get("id"), limit=80)
            enriched.append({
                "id": paper.get("id") or "",
                "doi": metadata.get("doi") or metadata_service.normalize_doi(paper.get("doi") or ""),
                "metadata": metadata,
            })
        except ClientError as error:
            logger.warning('enrich_citations: recovering from expected failure (%s)', type(error).__name__)
            errors.append(str(error))
    return {"ok": True, "papers": enriched, "errors": errors[:8]}


def find_missing_seminal_papers(payload: JSONDict):
    papers = payload.get("papers") or []
    threshold = max(2, min(20, int(payload.get("threshold") or 2)))
    reference_counts = {}
    loaded = {metadata_service.openalex_work_id(paper.get("openAlexId") or "") for paper in papers}
    for paper in papers:
        for ref in paper.get("referenceIds") or []:
            work_id = metadata_service.openalex_work_id(ref)
            if not work_id or work_id in loaded:
                continue
            reference_counts.setdefault(work_id, set()).add(paper.get("id") or paper.get("doi") or paper.get("title") or "")

    ranked_ids = [
        work_id for work_id, sources in sorted(reference_counts.items(), key=lambda item: (-len(item[1]), item[0]))
        if len(sources) >= threshold
    ][:12]
    records = []
    for work_id in ranked_ids:
        try:
            work = providers_service.fetch_openalex_work_by_id(work_id)
            record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(work), source="OpenAlex missing seminal")
            record["citedByLoadedCount"] = len(reference_counts.get(work_id) or [])
            record["reason"] = f"Cited by {record['citedByLoadedCount']} papers already on this map."
            records.append(record)
        except ClientError:
            logger.warning('find_missing_seminal_papers: recovering from expected failure')
            continue
    return {"ok": True, "threshold": threshold, "recommendations": records}


def snowball_papers(payload: JSONDict):
    paper = payload.get("paper") or {}
    direction = (payload.get("direction") or "forward").lower()
    limit = min(max(int(payload.get("limit") or 25), 1), 50)
    work = providers_service.openalex_work_for_paper(paper)
    if not work:
        raise ClientError(404, "OpenAlex could not identify this paper for citation chasing.")
    work_id = metadata_service.openalex_work_id(work.get("id"))
    if direction == "backward":
        reference_ids = [metadata_service.openalex_work_id(value) for value in work.get("referenced_works") or []]
        works = []
        for ref_id in [value for value in reference_ids if value][:limit]:
            try:
                works.append(providers_service.fetch_openalex_work_by_id(ref_id))
            except ClientError:
                logger.warning('snowball_papers: recovering from expected failure')
                continue
        source = "OpenAlex references"
    else:
        works = providers_service.openalex_citing_works(work_id, limit=limit)
        source = "OpenAlex citing papers"

    records = []
    for item in works:
        record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(item), source=source)
        record["reason"] = "Backward citation chase: this paper is referenced by the selected paper." if direction == "backward" else "Forward citation chase: this paper cites the selected paper."
        records.append(record)
    return {"ok": True, "direction": direction, "sourceOpenAlexId": work_id, "recommendations": records}


def fetch_citation_graph_branch(seed_papers: List[Paper], api_key=None, include_iterative_chase=True, limit=30, depth=None):
    gathered = []
    hop1_references = []
    hop1_citations = []
    for paper in seed_papers[:3]:
        s2_id = providers_service.s2_paper_id_for_paper(paper, api_key=api_key)
        if s2_id:
            try:
                refs = providers_service.s2_fetch_references(s2_id, api_key=api_key, limit=limit)
                gathered.extend(refs)
                hop1_references.extend(refs)
            except (ClientError, ValueError, KeyError, TypeError):
                logger.warning('fetch_citation_graph_branch: recovering from expected failure')
                pass
            try:
                cites = providers_service.s2_fetch_citations(s2_id, api_key=api_key, limit=limit)
                gathered.extend(cites)
                hop1_citations.extend(cites)
            except (ClientError, ValueError, KeyError, TypeError):
                logger.warning('fetch_citation_graph_branch: recovering from expected failure')
                pass

        if not gathered:
            # Fallback to OpenAlex references & citing works
            work = providers_service.openalex_work_for_paper(paper)
            if work:
                work_id = metadata_service.openalex_work_id(work.get("id"))
                for ref_id, ref_work in parallel_lookup(providers_service.fetch_openalex_work_by_id, (work.get("referenced_works") or [])[:limit]):
                    if not ref_work:
                        continue
                    try:
                        record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(ref_work), source="OpenAlex references")
                        record["branch"] = "citationGraph"
                        record["subType"] = "Backward"
                        record["reason"] = "Backward citation: foundational reference cited by seed paper."
                        gathered.append(record)
                        hop1_references.append(record)
                    except (ClientError, ValueError, KeyError, TypeError):
                        logger.warning('fetch_citation_graph_branch: recovering from expected failure')
                        continue
                citing_works = providers_service.openalex_citing_works(work_id, limit=limit)
                for item in citing_works:
                    record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(item), source="OpenAlex citing papers")
                    record["branch"] = "citationGraph"
                    record["subType"] = "Forward"
                    record["reason"] = "Forward citation: downstream paper citing seed paper."
                    gathered.append(record)
                    hop1_citations.append(record)

    # Bounded breadth-first expansion; iterative stops early when no new records remain.
    max_depth = 4 if str(depth) == 'iterative' else max(1, min(int(depth or (2 if include_iterative_chase else 1)), 3))
    seen = {providers_service.s2_paper_identifier(p) for p in seed_papers}
    frontier = [(p, 'backward') for p in hop1_references] + [(p, 'forward') for p in hop1_citations]
    for hop in range(2, max_depth + 1):
        next_frontier = []
        for direction in ('backward', 'forward'):
            candidates = sorted((p for p, d in frontier if d == direction), key=lambda p: int(p.get('citedByCount') or 0), reverse=True)[:4]
            for parent in candidates:
                key = providers_service.s2_paper_identifier(parent)
                if not key or key in seen:
                    continue
                seen.add(key)
                try:
                    parent_id = providers_service.s2_paper_id_for_paper(parent, api_key=api_key)
                    if not parent_id:
                        continue
                    fetcher = providers_service.s2_fetch_references if direction == 'backward' else providers_service.s2_fetch_citations
                    for item in fetcher(parent_id, api_key=api_key, limit=8):
                        item_key = providers_service.s2_paper_identifier(item)
                        if item_key in seen:
                            continue
                        item.update(subType=f'Iterative Chase ({hop}-Hop)', hop=hop, chaseViaTitle=parent.get('title', ''), reason=f"Citation hop {hop} via {parent.get('title', '')[:80]}")
                        gathered.append(item)
                        next_frontier.append((item, direction))
                except (ClientError, ValueError, KeyError, TypeError):
                    logger.warning('fetch_citation_graph_branch: recovering from expected failure')
                    continue
        frontier = next_frontier
        if not frontier:
            break

    return gathered


def fetch_citation_network_branch(seed_papers: List[Paper], api_key=None, limit=30):
    gathered = []
    seed_dois = {metadata_service.normalize_doi(p.get("doi") or "").lower() for p in seed_papers if metadata_service.normalize_doi(p.get("doi") or "")}
    seed_titles = {metadata_service.normalize_title_key(p.get("title") or "") for p in seed_papers if p.get("title")}

    for paper in seed_papers[:3]:
        # Co-citation analysis via OpenAlex / S2:
        work = providers_service.openalex_work_for_paper(paper)
        if not work:
            continue
        work_id = metadata_service.openalex_work_id(work.get("id"))
        citing_works = providers_service.openalex_citing_works(work_id, limit=max(limit, 30))

        # Count references among papers citing this seed
        cocite_counts = {}
        for c_work in citing_works:
            for ref_id in (c_work.get("referenced_works") or []):
                ref_norm = metadata_service.openalex_work_id(ref_id)
                if not ref_norm or ref_norm == work_id:
                    continue
                cocite_counts[ref_norm] = cocite_counts.get(ref_norm, 0) + 1

        # Papers co-cited by >= 2 citing works
        top_cocited_ids = [ref_norm for ref_norm, count in sorted(cocite_counts.items(), key=lambda x: -x[1]) if count >= 2][:20]
        for ref_norm, co_work in parallel_lookup(providers_service.fetch_openalex_work_by_id, top_cocited_ids):
            if not co_work:
                continue
            try:
                record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(co_work), source="Citation Network (Co-citation)")
                record["branch"] = "citationNetwork"
                record["subType"] = "Co-citation"
                record["sharedCitationsCount"] = cocite_counts[ref_norm]
                record["reason"] = f"Co-citation triangulation: cited together with seed paper by {cocite_counts[ref_norm]} citing papers."
                gathered.append(record)
            except (ClientError, ValueError, KeyError, TypeError):
                logger.warning('fetch_citation_network_branch: recovering from expected failure')
                continue

        # Bibliographic coupling analysis:
        # Find external works that cite multiple references of this seed
        seed_ref_ids = [metadata_service.openalex_work_id(r) for r in (work.get("referenced_works") or []) if metadata_service.openalex_work_id(r)][:8]
        if len(seed_ref_ids) >= 2:
            try:
                params = urllib.parse.urlencode({
                    "filter": f"cites:{'|'.join(seed_ref_ids[:4])}",
                    "sort": "cited_by_count:desc",
                    "per-page": max(limit, 25),
                })
                data = providers_service.fetch_json(f"https://api.openalex.org/works?{params}")
                for b_work in (data.get("results") or []):
                    b_id = metadata_service.openalex_work_id(b_work.get("id"))
                    if b_id == work_id:
                        continue
                    b_refs = {metadata_service.openalex_work_id(r) for r in (b_work.get("referenced_works") or [])}
                    shared = len(set(seed_ref_ids).intersection(b_refs))
                    if shared >= 1:
                        record = ranking_service.recommendation_record(*ranking_service.openalex_recommendation_item(b_work), source="Citation Network (Bibliographic)")
                        record["branch"] = "citationNetwork"
                        record["subType"] = "Bibliographic coupling"
                        record["sharedReferencesCount"] = shared
                        record["reason"] = f"Bibliographic coupling: shares {shared} foundational references with seed paper."
                        gathered.append(record)
            except (ClientError, ValueError, KeyError, TypeError):
                logger.warning('fetch_citation_network_branch: recovering from expected failure')
                pass

    return gathered


def fetch_semantic_search_branch(seed_papers: List[Paper], api_key=None, exclude_papers=None, limit=30):
    pos_ids = []
    for paper in seed_papers[:5]:
        pid = providers_service.s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            pos_ids.append(pid)
    neg_ids = []
    for paper in (exclude_papers or [])[:4]:
        pid = providers_service.s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            neg_ids.append(pid)
    if not pos_ids:
        return []
    return providers_service.s2_recommendations(pos_ids, negative_ids=neg_ids, api_key=api_key, limit=limit)


def fetch_conceptual_search_branch(seed_papers: List[Paper], api_key=None, steer_keywords=None, limit=30):
    gathered = []
    concepts = []
    methods = []
    organisms = []
    for p in seed_papers[:3]:
        methods.extend(p.get("techniques") or [])
        organisms.extend(p.get("organisms") or [])
        concepts.extend(p.get("paperKeywords") or p.get("keywords") or [])
        for f in (p.get("keyFindings") or []):
            concepts.extend(metadata_service.keyword_tokens(f, max_terms=3))
    all_terms = metadata_service.dedupe_strings([*(steer_keywords or []), *methods, *organisms, *concepts])
    if not all_terms:
        return []

    # Query S2AG search with high-value domain concepts
    search_query = " ".join(all_terms[:8])
    try:
        s2_results = providers_service.s2_paper_search(search_query, api_key=api_key, limit=limit)
        for r in s2_results:
            r["matchedConcepts"] = [t for t in all_terms if t.lower() in f"{r.get('title', '')} {r.get('abstract', '')}".lower()][:4]
            r["reason"] = f"Conceptual match for domain terms: {', '.join(r['matchedConcepts'][:3]) or search_query[:30]}."
            gathered.append(r)
    except (ClientError, ValueError, KeyError, TypeError):
        logger.warning('fetch_conceptual_search_branch: recovering from expected failure')
        pass

    # OpenAlex search with concepts
    try:
        openalex_items = providers_service.openalex_recommendations(search_query, limit=limit)
        for r in openalex_items:
            r["branch"] = "lexicalConceptual"
            r["subType"] = "OpenAlex Concept Search"
            r["matchedConcepts"] = [t for t in all_terms if t.lower() in f"{r.get('title', '')} {r.get('abstract', '')}".lower()][:4]
            r["reason"] = f"Lexical / conceptual match: {', '.join(r['matchedConcepts'][:3]) or search_query[:30]}."
            gathered.append(r)
    except (ClientError, ValueError, KeyError, TypeError):
        logger.warning('fetch_conceptual_search_branch: recovering from expected failure')
        pass

    return gathered


def merge_and_rank_pipeline_candidates(candidates_by_branch, seed_papers: List[Paper], options):
    excluded_dois = {metadata_service.normalize_doi(p.get("doi") or "").lower() for p in seed_papers if metadata_service.normalize_doi(p.get("doi") or "")}
    excluded_titles = {metadata_service.normalize_title_key(p.get("title") or "") for p in seed_papers if p.get("title")}
    for ex_doi in options.get("excludeDois") or []:
        if metadata_service.normalize_doi(ex_doi):
            excluded_dois.add(metadata_service.normalize_doi(ex_doi).lower())
    for ex_title in options.get("excludeTitles") or []:
        if metadata_service.normalize_title_key(ex_title):
            excluded_titles.add(metadata_service.normalize_title_key(ex_title))

    steer_keywords = [t.lower() for t in (options.get("steerKeywords") or []) if t]
    exclude_keywords = [t.lower() for t in (options.get("excludeKeywords") or []) if t]
    recency_tilt = float(options.get("recencyTilt") or 0)
    impact_tilt = float(options.get("impactTilt") or 0)

    # Seed features for relevance matching
    seed_techniques = {t.lower() for p in seed_papers for t in (p.get("techniques") or [])}
    seed_organisms = {o.lower() for p in seed_papers for o in (p.get("organisms") or [])}
    seed_keywords = {k.lower() for p in seed_papers for k in (p.get("paperKeywords") or p.get("keywords") or [])}

    merged = {}
    for branch_name, items in candidates_by_branch.items():
        for item in items:
            doi = metadata_service.normalize_doi(item.get("doi") or "").lower()
            title_key = metadata_service.normalize_title_key(item.get("title") or "")
            if not title_key or doi in excluded_dois or title_key in excluded_titles:
                continue
            key = doi or title_key
            existing = merged.get(key)
            if not existing:
                record = dict(item)
                record["branchHits"] = {branch_name: True}
                record["sourceList"] = metadata_service.dedupe_strings(item.get("sourceList") or [item.get("source") or branch_name])
                record["discoveryBadges"] = []
                # Badges based on provenance
                if item.get("subType") == "SPECTER2":
                    record["discoveryBadges"].append("SPECTER2")
                elif item.get("subType") == "Co-citation":
                    count = item.get("sharedCitationsCount", 2)
                    record["discoveryBadges"].append(f"Co-citation ({count}x)")
                elif item.get("subType") == "Bibliographic coupling":
                    count = item.get("sharedReferencesCount", 2)
                    record["discoveryBadges"].append(f"Bib Coupling ({count}x)")
                elif item.get("subType") == "Iterative Chase (2-Hop)":
                    record["discoveryBadges"].append("2-Hop Chase")
                elif item.get("subType") == "Backward":
                    record["discoveryBadges"].append("Backward Ref")
                elif item.get("subType") == "Forward":
                    record["discoveryBadges"].append("Forward Cite")
                if item.get("isInfluential"):
                    record["discoveryBadges"].append("Influential Cite")

                merged[key] = record
            else:
                existing["branchHits"][branch_name] = True
                existing["sourceList"] = metadata_service.dedupe_strings([*existing.get("sourceList", []), *(item.get("sourceList") or [item.get("source") or branch_name])])
                if item.get("isInfluential"):
                    existing["isInfluential"] = True
                    if "Influential Cite" not in existing["discoveryBadges"]:
                        existing["discoveryBadges"].append("Influential Cite")
                if item.get("subType") == "SPECTER2" and "SPECTER2" not in existing["discoveryBadges"]:
                    existing["discoveryBadges"].append("SPECTER2")
                    existing["specterRank"] = item.get("specterRank", 1)
                elif item.get("subType") == "Co-citation" and not any("Co-citation" in b for b in existing["discoveryBadges"]):
                    existing["discoveryBadges"].append(f"Co-citation ({item.get('sharedCitationsCount', 2)}x)")
                elif item.get("subType") == "Bibliographic coupling" and not any("Bib Coupling" in b for b in existing["discoveryBadges"]):
                    existing["discoveryBadges"].append(f"Bib Coupling ({item.get('sharedReferencesCount', 2)}x)")
                elif item.get("subType") == "Iterative Chase (2-Hop)" and "2-Hop Chase" not in existing["discoveryBadges"]:
                    existing["discoveryBadges"].append("2-Hop Chase")

                for f in ("abstract", "url", "journal", "date", "year", "doi", "s2PaperId", "openAccessPdf"):
                    if not existing.get(f) and item.get(f):
                        existing[f] = item[f]
                existing["citedByCount"] = max(int(existing.get("citedByCount") or 0), int(item.get("citedByCount") or 0))

    ranked = []
    for item in merged.values():
        haystack = f"{item.get('title', '')} {item.get('abstract', '')} {' '.join(item.get('paperKeywords') or [])}".lower()

        # 1. Relevance Score
        penalty = sum(40 for term in exclude_keywords if term in haystack)
        if penalty >= 80:
            continue
        rel_methods = sum(15 for term in seed_techniques if term in haystack)
        rel_orgs = sum(15 for term in seed_organisms if term in haystack)
        rel_steer = sum(14 for term in steer_keywords if term in haystack)
        rel_keys = sum(5 for term in seed_keywords if term in haystack)
        relevance_score = max(0, rel_methods + rel_orgs + rel_steer + rel_keys - penalty)

        # 2. Citation Proximity Score
        prox_score = 0
        if item.get("branchHits", {}).get("citationGraph"):
            prox_score += 40
        if item.get("isInfluential"):
            prox_score += 24
        if item.get("subType") == "Co-citation" or any("Co-citation" in b for b in item.get("discoveryBadges", [])):
            prox_score += 28
        if item.get("subType") == "Bibliographic coupling" or any("Bib Coupling" in b for b in item.get("discoveryBadges", [])):
            prox_score += 24
        if "2-Hop Chase" in item.get("discoveryBadges", []):
            prox_score += 18

        # 3. Semantic Similarity Score
        sem_score = 0
        if item.get("branchHits", {}).get("semanticSearch"):
            rank = item.get("specterRank", 5)
            sem_score = max(18, 52 - rank * 2)

        # 4. Recency Score
        year_match = re.search(r"\b(19|20)\d{2}\b", str(item.get("year") or item.get("date") or ""))
        year = int(year_match.group(0)) if year_match else 2020
        recency_score = (year - 2018) * (2.0 + recency_tilt)

        # 5. Novelty / Diversity Score
        cites = min(int(item.get("citedByCount") or 0), 1000)
        novelty_score = (cites * 0.08) * (1.0 + impact_tilt * 0.5) if impact_tilt >= 0 else (max(0, 25 - cites) * (-impact_tilt * 1.5))

        # 6. Multi-Branch Convergence Bonus
        branch_count = len(item.get("branchHits", {}))
        convergence_bonus = 0
        if branch_count == 2:
            convergence_bonus = 35
        elif branch_count == 3:
            convergence_bonus = 70
        elif branch_count >= 4:
            convergence_bonus = 110

        total_score = round(relevance_score + prox_score + sem_score + recency_score + novelty_score + convergence_bonus, 1)

        item["score"] = total_score
        item["scoreBreakdown"] = {
            "relevance": round(relevance_score, 1),
            "citationProximity": round(prox_score, 1),
            "semanticSimilarity": round(sem_score, 1),
            "recency": round(recency_score, 1),
            "novelty": round(novelty_score, 1),
            "convergenceBonus": convergence_bonus,
            "totalScore": total_score,
        }

        # Provenance summary explanation
        reasons = []
        if "SPECTER2" in item.get("discoveryBadges", []):
            reasons.append("SPECTER2 semantic embeddings")
        if any("Co-citation" in b for b in item.get("discoveryBadges", [])):
            reasons.append("co-citation triangulation")
        if any("Bib Coupling" in b for b in item.get("discoveryBadges", [])):
            reasons.append("bibliographic coupling")
        if "Backward Ref" in item.get("discoveryBadges", []):
            reasons.append("foundational bibliography reference")
        if "Forward Cite" in item.get("discoveryBadges", []):
            reasons.append("forward citation")
        if "2-Hop Chase" in item.get("discoveryBadges", []):
            reasons.append("iterative 2-hop citation chase")
        if item.get("isInfluential"):
            reasons.append("highly influential citation")

        if reasons:
            item["reason"] = f"Surfaced via {', '.join(reasons)}."
        ranked.append(item)

    ranked.sort(key=lambda x: x.get("score", 0), reverse=True)
    limit = max(1, min(int(options.get("limit") or 50), 100))
    return ranked[:limit]


def run_discovery_pipeline(payload: JSONDict, on_progress=None, cancel_event=None):
    seed_papers = payload.get("seedPapers") or payload.get("papers") or []
    if not seed_papers:
        raise ClientError(400, "Select at least one seed paper to run the literature discovery pipeline.")

    settings = storage_service.load_settings()
    api_key = providers_service.resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {
        "citationGraph": True,
        "citationNetwork": True,
        "semanticSearch": True,
        "lexicalSearch": True,
    }
    include_iterative = bool(payload.get("iterativeChase", True))
    steer_keywords = ranking_service.steering_terms(payload.get("steerKeywords") or [])
    exclude_keywords = ranking_service.steering_terms(payload.get("excludeKeywords") or [])
    limit = min(max(int(payload.get("limit") or 50), 1), 100)

    tasks = {}
    if branches.get('citationGraph', True):
        tasks['citationGraph'] = lambda: fetch_citation_graph_branch(seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get('depth'))
    if branches.get('citationNetwork', True):
        tasks['citationNetwork'] = lambda: fetch_citation_network_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get('semanticSearch', True):
        tasks['semanticSearch'] = lambda: fetch_semantic_search_branch(seed_papers, api_key=api_key, limit=limit)
    if branches.get('lexicalSearch', branches.get('lexicalConceptual', True)):
        tasks['lexicalConceptual'] = lambda: fetch_conceptual_search_branch(seed_papers, api_key=api_key, steer_keywords=steer_keywords, limit=limit)
    options = {
        'steerKeywords': steer_keywords, 'excludeKeywords': exclude_keywords,
        'excludeDois': payload.get('excludeDois') or [], 'excludeTitles': payload.get('excludeTitles') or [],
        'recencyTilt': payload.get('recencyTilt') or 0, 'impactTilt': payload.get('impactTilt') or 0, 'limit': limit,
    }
    def progress(results, completed, errors, total):
        if on_progress:
            ordered = {name: results.get(name, []) for name in tasks}
            on_progress({'recommendations': merge_and_rank_pipeline_candidates(ordered, seed_papers, options),
                         'branchesExecuted': [name for name in tasks if name in completed],
                         'errors': errors, 'completed': len(completed) + len(errors), 'total': total})
    if on_progress:
        on_progress({'total': len(tasks)})
    results, executed, errors = parallel_branches(tasks, progress, cancel_event)
    ordered = {name: results.get(name, []) for name in tasks}
    return {'ok': True, 'provider': 'Semantic Scholar Academic Graph (S2AG) + Hybrid Pipeline',
            'seedCount': len(seed_papers), 'branchesExecuted': executed,
            'recommendations': merge_and_rank_pipeline_candidates(ordered, seed_papers, options),
            'errors': errors, 'completed': len(executed) + len(errors), 'total': len(tasks)}


def iterative_citation_chase(payload: JSONDict):
    paper = payload.get("paper") or {}
    if not paper:
        raise ClientError(400, "Select a seed paper to run iterative citation chase.")
    settings = storage_service.load_settings()
    api_key = providers_service.resolve_semantic_scholar_api_key(settings)
    limit = min(max(int(payload.get("limit") or 25), 1), 60)
    results = fetch_citation_graph_branch([paper], api_key=api_key, include_iterative_chase=True, limit=limit)
    return {"ok": True, "recommendations": results}


def citation_network_triangulation(payload: JSONDict):
    paper = payload.get("paper") or {}
    if not paper:
        raise ClientError(400, "Select a seed paper to run citation network triangulation.")
    settings = storage_service.load_settings()
    api_key = providers_service.resolve_semantic_scholar_api_key(settings)
    limit = min(max(int(payload.get("limit") or 25), 1), 60)
    results = fetch_citation_network_branch([paper], api_key=api_key, limit=limit)
    return {"ok": True, "recommendations": results}


def start_discovery(payload: JSONDict):
    if not payload.get('seedPapers'):
        raise ClientError(400, 'Select a seed paper first.')
    try:
        return get_context().discovery_jobs.start(payload, run_discovery_pipeline)
    except ValueError as error:
        logger.warning('start_discovery: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(429, str(error)) from error


def cancel_discovery(payload: JSONDict):
    try:
        return get_context().discovery_jobs.cancel(payload.get('id', ''))
    except KeyError as error:
        logger.warning('cancel_discovery: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(404, 'Discovery search was not found.') from error


def read_discovery(job_id):
    try:
        return get_context().discovery_jobs.read(job_id)
    except KeyError as error:
        logger.warning('read_discovery: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(404, 'Discovery search expired or was not found.') from error
