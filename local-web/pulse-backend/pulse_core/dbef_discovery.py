"""One bounded shared-reference search replacing the legacy network searches."""
import datetime
import math
import re
import statistics
import time
import urllib.parse
import pulse_core as core
from pulse_core.dbef_content import (SeedPaper, CandidatePaper, TfidfEmbedder,
    compute_seed_reference_weights, score_and_rank_candidates)
from pulse_core.metadata_utils import openalex_to_metadata, citation_count
from pulse_core.search_limits import SearchResults, discovery_limit
from pulse_performance import REQUEST_CONTEXT, DiscoveryBudgetExceeded, DiscoveryCancelled, check_cancelled, publish_partial

COLLECTION_SECONDS = 12
MAX_REFERENCE_METADATA = 400
MAX_PIVOTS = 12


def work_id(value):
    match = re.search(r'\bW\d+\b',str(value or ''))
    return match.group(0) if match else ''


def references(work):
    return list(dict.fromkeys(ident for value in work.get('referenced_works') or [] if (ident := work_id(value))))


def recent_velocity(work, today=None):
    """Mean citations in completed years; absent annual data stays unknown."""
    today = today or datetime.date.today()
    rows = work.get('counts_by_year')
    if not isinstance(rows,list) or not rows: return None
    published = citation_count(work.get('publication_year'))
    years = [year for year in range(today.year-3,today.year) if not published or year >= published]
    if not years: return None
    counts = {row.get('year'): citation_count(row.get('cited_by_count')) for row in rows if isinstance(row,dict)}
    if any(counts.get(year) is None for year in years if year in counts): return None
    return sum(counts.get(year,0) for year in years)/len(years)


def _balanced_reference_ids(seeds, limit):
    result, seen = [], set()
    for position in range(max((len(seed.references) for seed in seeds),default=0)):
        for seed in seeds:
            if position < len(seed.references) and seed.references[position] not in seen:
                ident = seed.references[position]
                result.append(ident); seen.add(ident)
                if len(result) == limit: return result
    return result


def _select_pivots(seeds, weights):
    ranked = [sorted(seed.references,key=lambda ident:(-weights.get(ident,0),ident)) for seed in seeds]
    result, seen = [], set()
    for position in range(max(map(len,ranked),default=0)):
        for rows in ranked:
            if position < len(rows) and rows[position] not in seen:
                result.append(rows[position]); seen.add(rows[position])
                if len(result) == MAX_PIVOTS: return result
    return result


def _rank(raw, seeds, ref_texts, counts, corpus_size, limit, unknown_count):
    candidates, by_id = [], {}
    for work in raw:
        ident = work_id(work.get('id'))
        if not ident or ident in by_id: continue
        meta = openalex_to_metadata(work)
        refs = references(work)
        by_id[ident] = (work,meta)
        candidates.append(CandidatePaper(ident,meta.get('title') or '',meta.get('abstract') or '',refs,
            recent_velocity(work),citation_count(work.get('referenced_works_count'))))
    top, diagnostics = score_and_rank_candidates(candidates,seeds,counts,ref_texts,top_k=limit,
        stage1_k=max(1000,limit),n_corpus=corpus_size,unknown_count=unknown_count,check=check_cancelled)
    maximum = max((row.score for row in top),default=0) or 1
    records = SearchResults()
    for rank,row in enumerate(top,1):
        work, meta = by_id[row.paper.paper_id]
        seed_matches = [{'seedIndex':seed.original_index,'seedId':seed.paper_id,'shared':len(set(seed.references)&set(row.shared_refs))}
                        for seed in seeds if set(seed.references)&set(row.shared_refs)]
        detail = f'Shares {len(row.shared_refs)} references with your seeds, weighted by reference specificity and content relevance.'
        normalized = row.score/maximum
        meta.update(branch='citationNetwork',subType='Bibliographic coupling',rankingMethod='DBEF-content',
            recommendationSource='DBEF shared-reference discovery',discoveryBadges=['DBEF','Shared references'],
            sharedReferencesCount=len(row.shared_refs),networkSimilarity=normalized,reason=detail,
            retrievalEvidence=[{'channel':'dbef','provider':'OpenAlex','rank':rank,'subType':'Bibliographic coupling',
                                'detail':detail,'seedIndices':[match['seedIndex'] for match in seed_matches]}],
            dbef={'score':round(row.score,6),'normalizedScore':round(normalized,6),
                  'weightedOverlap':round(row.overlap,6),'saturation':round(row.saturation,6),
                  'velocityFactor':round(row.velocity_factor,6),'recentVelocity':row.paper.recent_velocity,
                  'contentSimilarity':round(row.content_sim,6) if math.isfinite(row.content_sim) else None,
                  'contentFactor':round(row.content_factor,6),'sharedReferenceIds':row.shared_refs,
                  'seedMatches':seed_matches,'referenceCount':max(len(row.paper.references),row.paper.reference_count or 0)})
        records.append(meta)
    return records, {'method':'DBEF-content','candidateCount':len(candidates),'rankedCount':len(top),
        'referenceCount':len(diagnostics['weights']),'unknownReferenceCounts':sum(r not in counts for r in diagnostics['weights']),
        'corpusSize':corpus_size,'unknownCountWeightFallback':unknown_count,
        'stage1Count':len(diagnostics['pool_ids']),'stage1BoundCertified':diagnostics['exact'],
        'contentCalibrationScope':'Stage-one shortlist'}


def fetch_dbef_branch(seed_papers, api_key=None, limit=200):
    limit = discovery_limit(limit)
    seeds, seed_works, ref_texts, counts, raw, seen, warnings = [], [], {}, {}, [], set(), []
    field_sizes = {}
    corpus_size = 1e7
    corpus_source = 'Assumed field size'
    unknown_count = 1.0
    collection_limited = False
    previous_deadline = getattr(REQUEST_CONTEXT,'deadline',None)
    REQUEST_CONTEXT.deadline = min(previous_deadline,time.monotonic()+COLLECTION_SECONDS) if previous_deadline else time.monotonic()+COLLECTION_SECONDS
    try:
        for seed_index,paper in enumerate(seed_papers[:24]):
            check_cancelled()
            try: work = core.openalex_work_for_paper(paper)
            except (DiscoveryCancelled,DiscoveryBudgetExceeded): raise
            except Exception as error: warnings.append(str(error)); continue
            if not work: continue
            meta = openalex_to_metadata(work)
            seeds.append(SeedPaper(work_id(work.get('id')),meta.get('title') or paper.get('title') or '',
                                   meta.get('abstract') or paper.get('abstract') or '',references(work),seed_index))
            seed_works.append(work)
        ids = _balanced_reference_ids(seeds,MAX_REFERENCE_METADATA)
        # Batches carry texts and real citation counts for weighting; never one
        # HTTP lookup per reference, and no arbitrary first-four reference pivot.
        for start in range(0,len(ids),100):
            check_cancelled()
            try:
                group = ids[start:start+100]
                query = urllib.parse.urlencode({'filter':'openalex_id:'+'|'.join(group),'per-page':len(group)})
                works = core.fetch_json('https://api.openalex.org/works?'+query).get('results') or []
                for work in works:
                    ident, meta = work_id(work.get('id')),openalex_to_metadata(work)
                    if not ident: continue
                    ref_texts[ident] = (meta.get('title') or '',meta.get('abstract') or '')
                    count = citation_count(work.get('cited_by_count'))
                    if count is not None: counts[ident] = count
            except (DiscoveryCancelled,DiscoveryBudgetExceeded): raise
            except Exception as error: warnings.append(str(error))
        unknown_count = statistics.median(counts.values()) if counts else 1.0
        fields = list(dict.fromkeys(str(((work.get('primary_topic') or {}).get('field') or {}).get('id') or '') for work in seed_works))
        for field in fields[:3]:
            match = re.search(r'(?:^|/)(\d+)$',field)
            if not match: continue
            check_cancelled()
            try:
                data = core.fetch_json('https://api.openalex.org/fields/'+match.group(1))
                size = citation_count(data.get('works_count'))
                if size: field_sizes[field] = size
            except (DiscoveryCancelled,DiscoveryBudgetExceeded): raise
            except Exception: pass  # Corpus size is a documented assumption when unavailable.
        if fields and all(field in field_sizes for field in fields):
            corpus_size = sum(field_sizes.values())
            corpus_source = 'OpenAlex field totals'
        if seeds and ids:
            embedder = TfidfEmbedder(check=check_cancelled)
            embedder.fit([(seed.title,seed.abstract) for seed in seeds]+list(ref_texts.values()))
            weights, _ = compute_seed_reference_weights(seeds,ref_texts,counts,embedder,
                n_corpus=corpus_size,unknown_count=unknown_count)
            pivots = _select_pivots(seeds,weights)
            groups = [pivots[i:i+4] for i in range(0,len(pivots),4)]
            quota = max(25,min(200,math.ceil(limit*3/max(1,len(groups)*2))))
            seed_ids = {seed.paper_id for seed in seeds}
            for group in groups:
                query = 'cites:'+'|'.join(group)
                for sort in ('publication_date:desc','cited_by_count:desc'):
                    check_cancelled()
                    try:
                        rows = core.openalex_discovery_works(query,quota,sort=sort)
                        if getattr(rows,'warning',''):
                            if 'budget' in rows.warning.lower(): collection_limited = True
                            else: warnings.append(rows.warning)
                        for work in rows:
                            ident = work_id(work.get('id'))
                            if not ident or ident in seen or ident in seed_ids: continue
                            seen.add(ident); raw.append(work)
                        # Publish a useful partial pool without repeating content
                        # ranking or querying the direct seed-citation neighborhood.
                        partial = SearchResults(openalex_to_metadata(work) for work in raw)
                        for rank,record in enumerate(partial,1):
                            record.update(branch='citationNetwork',subType='Bibliographic coupling',
                                retrievalEvidence=[{'channel':'dbef','provider':'OpenAlex','rank':rank}])
                        publish_partial(partial)
                    except (DiscoveryCancelled,DiscoveryBudgetExceeded): raise
                    except Exception as error: warnings.append(str(error))
    except DiscoveryBudgetExceeded:
        collection_limited = True
    finally:
        REQUEST_CONTEXT.deadline = previous_deadline
    check_cancelled()
    records, summary = _rank(raw,seeds,ref_texts,counts,corpus_size,limit,unknown_count)
    records.warning = ' · '.join(dict.fromkeys(warnings))
    summary['corpusSizeSource'] = corpus_source
    summary['resolvedSeedCount'] = len(seeds)
    summary['requestedSeedCount'] = min(len(seed_papers),24)
    records.dbef_summary = summary
    if collection_limited: records.notices.append({'code':'dbef-limit','message':'DBEF collection reached its time limit; collected candidates were retained.'})
    if not seeds or not any(seed.references for seed in seeds):
        records.notices.append({'code':'dbef-no-references','message':'No indexed seed references available for shared-reference discovery.'})
    return records
