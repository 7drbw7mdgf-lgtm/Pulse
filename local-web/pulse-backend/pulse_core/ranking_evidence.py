"""Bounded DBEF influence based on observed bibliography quality."""
import math
import statistics
import re


def citation_structure(records, seeds):
    """Degree-normalized edges; common methods references carry less weight."""
    import collections
    from .search_merge import known_count
    def ids(values):
        return {match.group(0) for value in values or []
                if (match := re.search(r'\bW\d+\b', str(value)))}
    def count(value):
        try: return max(0, int(value)) if not isinstance(value, bool) else 0
        except (ValueError, TypeError, OverflowError): return 0
    seed_refs = [ids(seed.get('referenceIds')) for seed in seeds]
    candidate_refs = [ids(record.get('referenceIds')) for record in records]
    frequencies = collections.Counter(ref for references in candidate_refs for ref in references)
    weights = {ref:math.log1p((len(records)+1)/(1+frequency)) for ref,frequency in frequencies.items()}
    unknown = math.log1p(len(records)+1)
    results = []
    for record, refs in zip(records, candidate_refs):
        dbef = record.get('dbef') or {}
        shared, similarity = 0, 0.0
        for references in seed_refs:
            overlap = (refs if refs else ids(dbef.get('sharedReferenceIds'))) & references
            if not overlap: continue
            seed_weight = sum(weights.get(ref, unknown) for ref in references)
            candidate_total = max(len(refs), count(dbef.get('referenceCount') or record.get('referenceCount')), len(overlap))
            candidate_weight = sum(weights.get(ref, unknown) for ref in refs) + max(0, candidate_total-len(refs))*unknown
            shared_weight = sum(weights.get(ref, unknown) for ref in overlap)
            normalized = shared_weight / math.sqrt(max(1e-9, seed_weight*candidate_weight))
            effective_shared = shared_weight / max(weights.get(ref, unknown) for ref in references)
            similarity = max(similarity, .5*min(1, normalized) + .5*effective_shared/(effective_shared+4))
            shared = max(shared, len(overlap))
        co_count = count(record.get('coCitationCount'))
        seed_degree = sum(count(known_count(seed)) for seed in seeds)
        candidate_degree = known_count(record)
        if co_count and seed_degree and candidate_degree is not None:
            cosine = co_count / math.sqrt(max(co_count, seed_degree)*max(co_count, count(candidate_degree)))
            cocitation = math.sqrt(min(1, cosine)) * co_count/(co_count+4)
        else:
            # Unknown degrees retain observed evidence at a conservative weight.
            cocitation = .25*co_count/(co_count+4) if co_count else 0.0
        results.append({'sharedReferences':shared, 'sharedReferenceSimilarity':round(similarity, 6),
                        'coCitationCount':co_count, 'coCitationSimilarity':round(cocitation, 6),
                        'strength':1-(1-similarity)*(1-cocitation)})
    return results


def _unit(value, unknown=.5):
    try:
        value=float(value)
        return min(1.,max(0.,value)) if math.isfinite(value) else unknown
    except (ValueError,TypeError):return unknown


def reference_coverage(observed, declared):
    try:declared=int(declared)
    except (ValueError,TypeError):return None
    if declared<=0:return None if not observed else .5
    return min(1.,max(0.,observed/declared))


def dbef_quality(record, policy=None):
    data=record.get('dbef')
    if not isinstance(data,dict):return 1.
    policy=policy or {}
    # Unknown coverage remains explicitly unknown in provenance. It receives a
    # conservative neutral value rather than pretending to be a complete list.
    coverage=(_unit(data.get('candidateReferenceCoverage'))*
              _unit(data.get('seedReferenceCoverage'))*
              _unit(data.get('referenceMetadataCoverage'))) ** (1/3)
    shared=len(data.get('sharedReferenceIds') or []) or int(record.get('sharedReferencesCount') or 0)
    overlap=1-math.exp(-max(0,shared)/max(1.,float(policy.get('overlapScale',4))))
    content=.4+.6*_unit(data.get('contentFactor'))
    return round(min(1.,coverage**max(.25,min(2.,float(policy.get('coveragePower',1))))*overlap*content),6)


def network_keys(record):
    from .doi_utils import normalize_doi
    doi=normalize_doi(record.get('doi')).lower()
    ident=re.search(r'\bW\d+\b',str(record.get('openAlexId') or record.get('openalexId') or ''))
    return [value for value in (doi,ident.group(0) if ident else '') if value]


def apply_network_assessments(records, branches):
    assessed={}
    for rows in branches.values():assessed.update(getattr(rows,'network_assessments',{}))
    for record in records:
        match=next((assessed[key] for key in network_keys(record) if key in assessed),None)
        if match:record.update(match)
        value=record.get('networkSimilarity')
        known=isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
        record['networkStatus']=('assessed_overlap' if value>0 else 'assessed_zero') if known else 'unassessed'
        record['networkSimilarity']=min(1,max(0,value)) if known else None


def graph_evidence(records, qualities, options):
    mode=options.get('impute_missing_graph','median')
    if not isinstance(mode,str) or mode not in {'median','zero','renormalize'}:raise ValueError('Invalid impute_missing_graph policy')
    shrink=float(options.get('graph_imputation_shrink',.5))
    if not math.isfinite(shrink) or not 0<=shrink<=1:raise ValueError('Invalid graph imputation shrink')
    assessed=[r['networkSimilarity'] for r in records if r.get('networkStatus')!='unassessed']
    imputed=statistics.median(assessed)*shrink if assessed and mode=='median' else 0.
    result=[]
    for record,quality in zip(records,qualities):
        missing=record['networkStatus']=='unassessed'
        coupling=imputed if missing else record['networkSimilarity']*quality
        direct=1/max(1,int(record.get('hop') or 1)) if 'citationGraph' in record['branches'] else 0.
        cocitation=float(record.get('coCitationSimilarity') or 0)
        real=max(direct,cocitation)
        result.append({'value':min(1,max(coupling,real)), 'prelim':coupling,
                       'imputed':bool(missing and imputed and real<imputed),
                       'renormalize':mode=='renormalize' and missing and not real})
    return result,{'policy':mode,'shrink':shrink,'median':statistics.median(assessed) if assessed else None,
                   'imputedValue':imputed,'counts':{state:sum(r['networkStatus']==state for r in records)
                     for state in ('assessed_overlap','assessed_zero','unassessed')}}
