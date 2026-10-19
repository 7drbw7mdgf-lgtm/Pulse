import datetime
import math
import re
import statistics
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import pulse_core as core
from pulse_core.dbef_content import (SeedPaper, CandidatePaper, TfidfEmbedder,
    compute_seed_reference_weights, score_and_rank_candidates, saturate_score)
from pulse_core.doi_utils import normalize_doi
from pulse_core.ranking_evidence import network_keys
from pulse_core.metadata_utils import openalex_to_metadata, citation_count
from pulse_core.ranking_evidence import reference_coverage
from pulse_core.search_limits import SearchResults, discovery_limit
from pulse_performance import REQUEST_CONTEXT, DiscoveryBudgetExceeded, DiscoveryCancelled, check_cancelled, publish_partial

COLLECTION_SECONDS = 12
MAX_REFERENCE_METADATA = 400
MAX_PIVOTS = 12
OPENALEX_WORK_SELECT = 'id,doi,title,authorships,primary_location,publication_year,abstract_inverted_index,cited_by_count,referenced_works,referenced_works_count,counts_by_year,primary_topic,is_retracted,biblio,publication_date,type,language'
OPENALEX_REF_SELECT = 'id,title,abstract_inverted_index,cited_by_count'


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


def _rank(raw, seeds, ref_texts, counts, corpus_size, limit, unknown_count, seed_coverages=None):
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
        stage1_k=max(1000,limit),n_corpus=corpus_size,unknown_count=unknown_count,check=check_cancelled,
        stable_seed_calibration=True)
    records = SearchResults()
    assessments={}
    top_ids={row.paper.paper_id for row in top}
    for rank,row in enumerate(diagnostics['scored_rows'],1):
        work, meta = by_id[row.paper.paper_id]
        seed_matches = [{'seedIndex':seed.original_index,'seedId':seed.paper_id,'shared':len(set(seed.references)&set(row.shared_refs))}
                        for seed in seeds if set(seed.references)&set(row.shared_refs)]
        detail = f'Shares {len(row.shared_refs)} references with your seeds, weighted by reference specificity and content relevance.'
        normalized = saturate_score(row.score,diagnostics['scale'])
        coverages=[(seed_coverages or {}).get(match['seedIndex']) for match in seed_matches]
        seed_coverage=sum(value for value in coverages if value is not None)/sum(value is not None for value in coverages) if any(value is not None for value in coverages) else None
        metadata_coverage=sum(.5*bool((ref_texts.get(ident) or ('',''))[0])+.5*(ident in counts) for ident in row.shared_refs)/max(1,len(row.shared_refs))
        meta.update(branch='citationNetwork',subType='Bibliographic coupling',rankingMethod='DBEF-content',
            recommendationSource='DBEF shared-reference discovery',discoveryBadges=['DBEF','Shared references'],
            sharedReferencesCount=len(row.shared_refs),networkSimilarity=normalized,networkStatus='assessed_overlap',reason=detail,
            retrievalEvidence=[{'channel':'dbef','provider':'OpenAlex','rank':rank,'subType':'Bibliographic coupling',
                                'detail':detail,'seedIndices':[match['seedIndex'] for match in seed_matches]}],
            dbef={'score':round(row.score,6),'normalizedScore':round(normalized,6),
                  'weightedOverlap':round(row.overlap,6),'saturation':round(row.saturation,6),
                  'velocityFactor':round(row.velocity_factor,6),'recentVelocity':row.paper.recent_velocity,
                  'contentSimilarity':round(row.content_sim,6) if math.isfinite(row.content_sim) else None,
                  'contentFactor':round(row.content_factor,6),'sharedReferenceIds':row.shared_refs,
                  'seedMatches':seed_matches,'referenceCount':max(len(row.paper.references),row.paper.reference_count or 0),
                  'candidateReferenceCoverage':reference_coverage(len(row.paper.references),row.paper.reference_count),
                  'seedReferenceCoverage':seed_coverage,'referenceMetadataCoverage':round(metadata_coverage,4)})
        for key in network_keys(meta):assessments[key]={key:meta[key] for key in ('networkStatus','networkSimilarity','dbef')}
        if row.paper.paper_id in top_ids:records.append(meta)
    for status in ('assessed_zero','unassessed'):
        for ident in diagnostics['network_status_ids'][status]:
            for key in network_keys(by_id[ident][1]):assessments[key]={'networkStatus':status,'networkSimilarity':0. if status=='assessed_zero' else None}
    records.network_assessments=assessments
    return records, {'method':'DBEF-content','candidateCount':len(candidates),'rankedCount':len(top),
        'referenceCount':len(diagnostics['weights']),'unknownReferenceCounts':sum(r not in counts for r in diagnostics['weights']),
        'corpusSize':corpus_size,'unknownCountWeightFallback':unknown_count,
        'stage1Count':len(diagnostics['pool_ids']),'stage1BoundCertified':diagnostics['exact'],
        'contentCalibrationScope':'Seed references only','calibration':diagnostics['scale'],
        'S0':diagnostics['scale']['S0'],'s1':diagnostics['scale']['s1'],'scaleInputs':diagnostics['scale']['inputs'],
        'networkStatusCounts':{state:len(ids) for state,ids in diagnostics['network_status_ids'].items()}}


def seed_reference_fallback(paper,api_key=None):
    """One S2 references call, then batch-map DOIs into the OpenAlex graph."""
    from pulse_core.s2_client import s2_request_headers,s2_paper_identifier
    from pulse_source_health import check_source,ProviderCooldown
    import urllib.request
    ident=s2_paper_identifier(paper)
    if not ident:return []
    url='https://api.semanticscholar.org/graph/v1/paper/'+urllib.parse.quote(ident,safe=':')+'/references'
    try:check_source(urllib.request.Request(url,headers=s2_request_headers(api_key)))
    except ProviderCooldown:return []
    rows=core.s2_fetch_references(urllib.parse.quote(ident,safe=':'),api_key=api_key,limit=100)
    dois=sorted({normalize_doi(row.get('doi')).lower() for row in rows if normalize_doi(row.get('doi'))})
    found=[]
    for start in range(0,len(dois),100):
        check_cancelled()
        query=urllib.parse.urlencode({'filter':'doi:'+'|'.join(dois[start:start+100]),'per-page':100,'select':'id,doi'})
        for work in core.fetch_json('https://api.openalex.org/works?'+query).get('results') or []:
            if normalize_doi(work.get('doi')).lower() in dois and work_id(work.get('id')):found.append(work_id(work['id']))
    return list(dict.fromkeys(found))


def fetch_dbef_branch(seed_papers, api_key=None, limit=200, seed_works=None):
    limit = discovery_limit(limit)
    provided_works = seed_works
    seeds, seed_works, ref_texts, counts, raw, seen, warnings = [], [], {}, {}, [], set(), []
    field_sizes = {}
    seed_coverages = {}
    corpus_size = 1e7
    corpus_source = 'Assumed field size'
    unknown_count = 1.0
    collection_limited = False
    previous_deadline = getattr(REQUEST_CONTEXT,'deadline',None)
    REQUEST_CONTEXT.deadline = min(previous_deadline,time.monotonic()+COLLECTION_SECONDS) if previous_deadline else time.monotonic()+COLLECTION_SECONDS
    try:
        for seed_index,paper in enumerate(seed_papers[:24]):
            check_cancelled()
            try: work = provided_works[seed_index] if provided_works is not None and seed_index < len(provided_works) else core.openalex_work_for_paper(paper)
            except (DiscoveryCancelled,DiscoveryBudgetExceeded): raise
            except Exception as error: warnings.append(str(error)); continue
            if not work: continue
            refs=references(work)
            if not refs:
                try:refs=seed_reference_fallback(paper,api_key)
                except (DiscoveryCancelled,DiscoveryBudgetExceeded):raise
                except Exception as error:warnings.append(str(error))
            meta = openalex_to_metadata(work)
            seeds.append(SeedPaper(work_id(work.get('id')),meta.get('title') or paper.get('title') or '',
                                   meta.get('abstract') or paper.get('abstract') or '',refs,seed_index,
                                   citation_count(work.get('referenced_works_count'))))
            seed_works.append(work)
            seed_coverages[seed_index]=reference_coverage(len(refs),work.get('referenced_works_count'))
        ids = _balanced_reference_ids(seeds,MAX_REFERENCE_METADATA)
        # Batches carry texts and real citation counts for weighting; never one
        # HTTP lookup per reference, and no arbitrary first-four reference pivot.
        ref_batches = [ids[i:i+100] for i in range(0,len(ids),100)]
        event = getattr(REQUEST_CONTEXT, 'cancel_event', None)
        deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
        counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
        def fetch_ref_group(group):
            REQUEST_CONTEXT.cancel_event = event
            REQUEST_CONTEXT.deadline = deadline
            REQUEST_CONTEXT.request_counter = counter
            try:
                check_cancelled()
                query = urllib.parse.urlencode({'filter':'openalex_id:'+'|'.join(group),'per-page':len(group),'select':OPENALEX_REF_SELECT})
                return core.fetch_json('https://api.openalex.org/works?'+query).get('results') or []
            finally:
                REQUEST_CONTEXT.cancel_event = None
                REQUEST_CONTEXT.deadline = None
                REQUEST_CONTEXT.request_counter = None
        if ref_batches:
            with ThreadPoolExecutor(max_workers=min(4, len(ref_batches))) as executor:
                futures = [executor.submit(fetch_ref_group, batch) for batch in ref_batches]
                for fut in futures:
                    try:
                        works = fut.result()
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
            embedder = TfidfEmbedder(max_df=1,check=check_cancelled)
            embedder.fit([(seed.title,seed.abstract) for seed in seeds]+list(ref_texts.values()))
            weights, _ = compute_seed_reference_weights(seeds,ref_texts,counts,embedder,
                n_corpus=corpus_size,unknown_count=unknown_count)
            pivots = _select_pivots(seeds,weights)
            groups = [pivots[i:i+4] for i in range(0,len(pivots),4)]
            quota = max(25,min(200,math.ceil(limit*3/max(1,len(groups)*2))))
            seed_ids = {seed.paper_id for seed in seeds}
            pivot_tasks = [(group, sort) for group in groups for sort in ('publication_date:desc','cited_by_count:desc')]
            def fetch_pivot_stream(task):
                REQUEST_CONTEXT.cancel_event = event
                REQUEST_CONTEXT.deadline = deadline
                REQUEST_CONTEXT.request_counter = counter
                try:
                    group, sort = task
                    check_cancelled()
                    query = 'cites:'+'|'.join(group)
                    return core.openalex_discovery_works(query, quota, sort=sort)
                finally:
                    REQUEST_CONTEXT.cancel_event = None
                    REQUEST_CONTEXT.deadline = None
                    REQUEST_CONTEXT.request_counter = None
            if pivot_tasks:
                with ThreadPoolExecutor(max_workers=min(10, len(pivot_tasks))) as executor:
                    futures = {executor.submit(fetch_pivot_stream, task): task for task in pivot_tasks}
                    for fut in as_completed(futures):
                        try:
                            rows = fut.result()
                            if getattr(rows,'warning',''):
                                if 'budget' in rows.warning.lower(): collection_limited = True
                                else: warnings.append(rows.warning)
                            new_found = False
                            for work in rows:
                                ident = work_id(work.get('id'))
                                if not ident or ident in seen or ident in seed_ids: continue
                                seen.add(ident); raw.append(work); new_found = True
                            if new_found:
                                # Publish a useful partial pool without repeating content
                                # ranking or querying the direct seed-citation neighborhood.
                                partial = SearchResults(openalex_to_metadata(work) for work in raw)
                                for rank,record in enumerate(partial,1):
                                    record.update(branch='citationNetwork',subType='Bibliographic coupling',
                                        retrievalEvidence=[{'channel':'dbef','provider':'OpenAlex','rank':rank}])
                                publish_partial(partial)
                        except DiscoveryBudgetExceeded: collection_limited = True
                        except DiscoveryCancelled: raise
                        except Exception as error: warnings.append(str(error))
    except DiscoveryBudgetExceeded:
        collection_limited = True
    finally:
        REQUEST_CONTEXT.deadline = previous_deadline
    check_cancelled()
    records, summary = _rank(raw,seeds,ref_texts,counts,corpus_size,limit,unknown_count,seed_coverages)
    records.warning = ' · '.join(dict.fromkeys(warnings))
    summary['corpusSizeSource'] = corpus_source
    summary['resolvedSeedCount'] = len(seeds)
    summary['requestedSeedCount'] = min(len(seed_papers),24)
    records.dbef_summary = summary
    if collection_limited: records.notices.append({'code':'dbef-limit','message':'DBEF collection reached its time limit; collected candidates were retained.'})
    if not seeds or not any(seed.references for seed in seeds):
        records.notices.append({'code':'dbef-no-references','message':'No indexed seed references available for shared-reference discovery.'})
    return records
