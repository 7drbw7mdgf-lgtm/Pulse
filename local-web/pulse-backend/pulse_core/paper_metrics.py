"""Provider-specific counts and complete, pageable citation neighborhoods."""
import re
import threading
import time
import urllib.parse
from pulse_core.constants import ClientError, time_iso
from pulse_core.doi_utils import normalize_doi
from pulse_core.metadata_resolution import candidate_score
from pulse_core.metadata_utils import openalex_to_metadata
from pulse_core.s2_client import fetch_s2_json, s2_to_metadata
from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
from pulse_core.storage import load_settings
from pulse_core.metadata_scanner import fetch_json

_CACHE = {}
_LOCK = threading.Lock()
S2_FIELDS = 'title,authors,year,venue,externalIds,url,citationCount,referenceCount,influentialCitationCount'

def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

def paper_input(payload):
    paper = payload.get('paper')
    if not isinstance(paper, dict):
        raise ClientError(400, 'Choose a paper first.')
    if not (paper.get('title') or paper.get('doi') or paper.get('s2PaperId') or paper.get('openAlexId')):
        raise ClientError(400, 'A DOI, paper identifier or title is required.')
    return paper

def same_paper(paper, metadata):
    expected, actual = normalize_doi(paper.get('doi')), normalize_doi(metadata.get('doi'))
    if expected:
        return bool(actual and expected.lower() == actual.lower())
    if not paper.get('title'):
        return bool((paper.get('s2PaperId') and paper['s2PaperId'] == metadata.get('s2PaperId')) or
                    (paper.get('openAlexId') and str(paper['openAlexId']).rsplit('/',1)[-1] == str(metadata.get('openAlexId')).rsplit('/',1)[-1]))
    return candidate_score(paper, metadata)['accepted']

def choose_candidate(paper, candidates):
    ranked = sorted([(candidate_score(paper, item), item) for item in candidates], key=lambda x: x[0]['score'], reverse=True)
    if not ranked or not ranked[0][0]['accepted']:
        return None
    if len(ranked) > 1 and ranked[1][0]['accepted'] and ranked[0][0]['score'] - ranked[1][0]['score'] < .05:
        return None
    return ranked[0][1]

def snapshot(source, identifier, item, metadata):
    s2 = source == 'Semantic Scholar'
    refs = item.get('referenced_works') if not s2 else None
    return {'source': source, 'identifier': identifier, 'sourceUrl': metadata.get('url') or
            (f'https://www.semanticscholar.org/paper/{identifier}' if s2 else f'https://openalex.org/{identifier}'),
            'checkedAt': time_iso(), 'matchedTitle': metadata.get('title'), 'doi': metadata.get('doi'),
            'citationCount': count(item.get('citationCount' if s2 else 'cited_by_count')),
            'referenceCount': count(item.get('referenceCount' if s2 else 'referenced_works_count'))
                if s2 or 'referenced_works_count' in item else len(refs) if isinstance(refs, list) else None,
            'influentialCitationCount': count(item.get('influentialCitationCount')) if s2 else None,
            'referenceIds': refs if isinstance(refs, list) else []}

def _s2_snapshot(paper, api_key):
    doi = normalize_doi(paper.get('doi'))
    ident = 'DOI:' + doi if doi else paper.get('s2PaperId') or ('PMID:' + str(paper['pmid']) if paper.get('pmid') else '')
    def get(identifier):
        return fetch_s2_json('https://api.semanticscholar.org/graph/v1/paper/' + urllib.parse.quote(str(identifier), safe='') +
                             '?' + urllib.parse.urlencode({'fields': S2_FIELDS}), api_key=api_key, cache=False)
    if ident:
        item = get(ident)
        if item and same_paper(paper, s2_to_metadata(item)):
            return snapshot('Semantic Scholar', item['paperId'], item, s2_to_metadata(item))
        # A DOI must never silently fall through to a different title match.
        if doi:
            return None
    data = fetch_s2_json('https://api.semanticscholar.org/graph/v1/paper/search?' + urllib.parse.urlencode(
        {'query': paper.get('title', ''), 'fields': S2_FIELDS, 'limit': 5}), api_key=api_key, cache=False)
    items = (data or {}).get('data') or []
    chosen = choose_candidate(paper, [s2_to_metadata(item) for item in items])
    if chosen:
        item = next(item for item in items if item.get('paperId') == chosen.get('s2PaperId'))
        return snapshot('Semantic Scholar', item['paperId'], item, chosen)

def _openalex_snapshot(paper):
    doi = normalize_doi(paper.get('doi'))
    ident = 'https://doi.org/' + doi if doi else str(paper.get('openAlexId') or '').rsplit('/', 1)[-1]
    if ident:
        if not doi and not re.fullmatch(r'W\d+', ident):
            ident = ''
        if ident:
            item = fetch_json('https://api.openalex.org/works/' + urllib.parse.quote(ident, safe=''), cache=False)
            if item and same_paper(paper, openalex_to_metadata(item)):
                return snapshot('OpenAlex', item['id'].rsplit('/', 1)[-1], item, openalex_to_metadata(item))
            if doi:
                return None
    data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode({'search': paper.get('title', ''), 'per_page': 5}), cache=False)
    items = (data or {}).get('results') or []
    chosen = choose_candidate(paper, [openalex_to_metadata(item) for item in items])
    if chosen:
        item = next(item for item in items if item.get('title') == chosen.get('title') and
                    normalize_doi(item.get('doi')) == normalize_doi(chosen.get('doi')))
        return snapshot('OpenAlex', item['id'].rsplit('/', 1)[-1], item, chosen)

def paper_metrics(payload):
    paper = paper_input(payload)
    source = payload.get('source')
    if source and source not in {'Semantic Scholar', 'OpenAlex'}:
        raise ClientError(400, 'Choose Semantic Scholar or OpenAlex.')
    key = repr((normalize_doi(paper.get('doi')), paper.get('s2PaperId'), paper.get('openAlexId'),
                paper.get('title'), paper.get('year'), paper.get('authors'), source))
    with _LOCK:
        cached = _CACHE.get(key)
    if cached and not payload.get('refresh') and time.time() - cached[0] < 300:
        return {'ok': True, 'metrics': cached[1]}
    errors = []
    fetchers = [('Semantic Scholar', lambda: _s2_snapshot(paper, resolve_semantic_scholar_api_key(load_settings()))),
                ('OpenAlex', lambda: _openalex_snapshot(paper))]
    for provider, fetcher in fetchers:
        if source and source != provider: continue
        try:
            result = fetcher()
            if result:
                with _LOCK:
                    _CACHE[key] = (time.time(), result)
                    if len(_CACHE) > 300:
                        _CACHE.pop(next(iter(_CACHE)))
                return {'ok': True, 'metrics': result}
        except Exception as error:
            errors.append(str(error))
    raise ClientError(502 if errors else 404, 'No confirmed citation record found. ' + ' '.join(errors)[:400])

def paper_relations(payload):
    paper = paper_input(payload)
    kind = payload.get('kind')
    if kind not in {'citations', 'references'}:
        raise ClientError(400, 'Choose citations or references.')
    metrics = paper_metrics({'paper': paper, 'source':payload.get('source')})['metrics']
    if payload.get('source') and payload['source'] != metrics['source']:
        raise ClientError(409, 'The citation provider changed. Refresh this list to keep its counts consistent.')
    try:
        offset = int(payload.get('offset', 0))
        if offset < 0: raise ValueError()
    except (ValueError, TypeError):
        raise ClientError(400, 'Invalid list offset.')
    if metrics['source'] == 'Semantic Scholar':
        field = 'citingPaper' if kind == 'citations' else 'citedPaper'
        fields = 'title,authors,year,venue,externalIds,url,isInfluential'
        url = f'https://api.semanticscholar.org/graph/v1/paper/{urllib.parse.quote(metrics["identifier"], safe="")}/{kind}?'
        data = fetch_s2_json(url + urllib.parse.urlencode({'fields': fields, 'limit': 100, 'offset': offset}),
                             api_key=resolve_semantic_scholar_api_key(load_settings()))
        if data is None:
            raise ClientError(404, 'Citation record is no longer available.')
        if data.get('data') is None:
            raise ClientError(403, 'Semantic Scholar does not expose this list for this paper. The publisher may withhold it. You can select OpenAlex to check its independently indexed bibliographic records.')
        rows = data.get('data') or []
        items = []
        for row in rows:
            record = row.get(field)
            if record and record.get('title'):
                meta = s2_to_metadata(record)
                meta.update(url=record.get('url'), isInfluential=row.get('isInfluential'))
                items.append(meta)
        next_page = data.get('next')
        if next_page is not None and (not isinstance(next_page, int) or next_page <= offset):
            raise ClientError(502, 'Citation provider returned an invalid continuation.')
        unresolved = len(rows) - len(items)
        total = metrics['citationCount' if kind == 'citations' else 'referenceCount']
    elif kind == 'references':
        ids = metrics['referenceIds'][offset:offset + 100]
        data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode({
            'filter': 'openalex:' + '|'.join(x.rsplit('/', 1)[-1] for x in ids), 'per_page': 100})) if ids else {}
        records = {x['id']: x for x in data.get('results') or []}
        items = [dict(openalex_to_metadata(records[x]), url=x) for x in ids if x in records]
        unresolved = len(ids) - len(items)
        total = metrics['referenceCount']
        next_page = offset + 100 if offset + 100 < len(metrics['referenceIds']) else None
    else:
        cursor = str(payload.get('cursor') or '*')
        if len(cursor) > 4096: raise ClientError(400, 'Invalid citation cursor.')
        data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode({
            'filter': 'cites:' + metrics['identifier'], 'per_page': 100, 'cursor': cursor}))
        items = [dict(openalex_to_metadata(item), url=item.get('id')) for item in data.get('results') or []]
        unresolved = 0
        total = data.get('meta', {}).get('count', metrics['citationCount'])
        next_page = data.get('meta', {}).get('next_cursor') if items else None
        if next_page == cursor: raise ClientError(502, 'Citation provider returned a repeated cursor.')
    return {'ok': True, 'source': metrics['source'], 'checkedAt': metrics['checkedAt'], 'kind': kind,
            'items': items, 'total': total, 'reportedTotal': metrics['citationCount' if kind == 'citations' else 'referenceCount'],
            'unresolved': unresolved, 'next': next_page,
            'cursorPaging': metrics['source'] == 'OpenAlex' and kind == 'citations', 'complete': next_page is None}
