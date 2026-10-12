"""Bounded DBEF influence based on observed bibliography quality."""
import math
import statistics
import re


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
