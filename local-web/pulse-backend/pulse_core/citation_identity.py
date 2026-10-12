"""Complete and verify a chosen record before importing it."""
import datetime
from .constants import ClientError
from .doi_utils import normalize_doi
from .metadata_resolution import resolve_metadata, title_similarity
from .metadata_scanner import lookup_doi_metadata
from .metadata_utils import merge_metadata
from pulse_performance import parallel_branches


def publication_years(metadata):
    dates=metadata.get('publicationDates') if isinstance(metadata.get('publicationDates'),dict) else {}
    values = [metadata.get('year'), metadata.get('date'), *dates.values()]
    return {str(value)[:4] for value in values if str(value or '')[:4].isdigit()}


def verify_candidate(paper):
    from .citation_lookup import surname_matches, name_tokens
    candidate = dict(paper)
    doi = normalize_doi(candidate.get('doi'))
    if not doi:
        found = resolve_metadata({**candidate, 'text':candidate.get('referenceText') or '', 'parseInput':False})
        if not found.get('matched') or not normalize_doi((found.get('metadata') or {}).get('doi')):
            return {'verified':False, 'reason':'The full reference did not resolve to a confident DOI. Add its DOI or more reference details.'}
        doi = normalize_doi(found['metadata']['doi'])
    try:
        found = lookup_doi_metadata({'doi':doi})
    except Exception as error:
        if getattr(error,'status',None)==409:return {'verified':False,'reason':'The DOI record title does not match the selected reference. Check the DOI and bibliography.'}
        return {'verified':False, 'reason':'The DOI record could not be verified. Retry when the source is available.', 'status':getattr(error,'status',502)}
    metadata = found.get('metadata') or {}
    if normalize_doi(metadata.get('doi')).lower() != doi.lower():
        return {'verified':False, 'reason':'The registry returned a different DOI. Original selection retained.'}
    title_score = max(title_similarity(candidate.get('title'),metadata.get('title')),title_similarity(candidate.get('title'),metadata.get('primaryTitle')))
    citation = candidate.get('citationMatch') if isinstance(candidate.get('citationMatch'),dict) else {}
    named = citation.get('authors') or candidate.get('authors') or []
    actual = metadata.get('authors') or []
    if isinstance(named,str):named=[named]
    if isinstance(actual,str):actual=[actual]
    def family(name):
        if ',' in name: return name.split(',')[0]
        tokens = name_tokens(name)
        # A full supplied name can vary in given-name initials across indexes.
        return tokens[-1] if tokens else ''
    author_ok = not named or bool(actual) and surname_matches(named[0] if citation else family(named[0]), actual[0])
    if citation.get('etAl') and len(actual)<2:author_ok=False
    if citation and len(named)>1:
        author_ok = author_ok and all(any(surname_matches(name, author) for author in actual[1:]) for name in named[1:])
    expected_year = str(citation.get('year') or candidate.get('year') or '')[:4]
    year_ok = not expected_year or expected_year in publication_years(metadata)
    if title_score < .85 or not author_ok or not year_ok:
        return {'verified':False, 'reason':'The DOI record disagrees with the selected title, authors or publication year. Check the full reference.',
                'checks':{'titleAgreement':round(title_score,3),'authors':author_ok,'publicationYear':year_ok}}
    # Registry fields lead. Keep only missing fields from the actual selected
    # reference; do not overwrite complete records with search placeholders.
    metadata = merge_metadata(metadata, {key:value for key,value in candidate.items() if key not in {'doiVerified','metadataSource','metadataMatch','metadataCheckedAt'}})
    metadata.update(doi=doi, doiVerified=True, metadataSource=found.get('source') or metadata.get('metadataSource'))
    verification = {'verified':True, 'doi':doi, 'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'sources':found.get('source') or 'DOI registry', 'checks':{'titleAgreement':round(title_score,3),'authors':author_ok,'publicationYear':year_ok},
                    'missingFields':[key for key in ('authors','year','journal','volume','issue','pages') if not metadata.get(key)]}
    metadata['metadataVerification'] = verification
    return {'verified':True, 'metadata':metadata, 'verification':verification}


def verify_citation_selection(payload):
    papers = payload.get('papers') or []
    if not isinstance(papers,list) or not 1<=len(papers)<=6 or any(not isinstance(paper,dict) for paper in papers):
        raise ClientError(400,'Choose between one and six citation records to verify.')
    found, _, errors = parallel_branches({str(i):(lambda paper=paper:verify_candidate(paper)) for i,paper in enumerate(papers)},budget_seconds=25,request_budget=12)
    results = [dict(found.get(str(i), {'verified':False,'reason':'DOI verification timed out. Retry shortly.'}), index=i) for i in range(len(papers))]
    return {'ok':True,'results':results,'verifiedCount':sum(result['verified'] for result in results)}
