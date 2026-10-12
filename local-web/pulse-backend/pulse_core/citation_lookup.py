"""Online author–year lookup. A short citation always requires user selection."""
import re
import unicodedata
import urllib.parse
from .constants import ClientError
from .doi_utils import normalize_doi
from .external_apis import fetch_json
from .metadata_utils import crossref_to_metadata, openalex_to_metadata
from .metadata_resolution import is_non_article, normalized_title
from .search_merge import merge_search_records
from pulse_performance import parallel_branches


def parse_in_text_citations(value):
    text = unicodedata.normalize('NFC', str(value or '')).strip()
    if not text or len(text) > 800 or '\n' in text:
        return []
    if text.startswith('(') and text.endswith(')'):
        text = text[1:-1].strip()
    groups = []
    for part in text.split(';'):
        match = re.fullmatch(r'(.+?)\s*(?:,\s*|\(\s*|\s+)((?:18|19|20)\d{2})([a-z]?)\s*\)?\.?', part.strip(), re.I)
        if not match:
            return []
        names = re.sub(r'\s+et\s+al\.?$', '', match[1].strip(), flags=re.I)
        if names.casefold() in {'pmid','doi','title','abstract'}:
            return []
        authors = re.split(r'\s*(?:&|\band\b)\s*', names, flags=re.I)
        if not 1 <= len(authors) <= 3 or any(not re.fullmatch(r"[^\W\d_][\w\s.'’\-‐‑–]*", name) or len(name.split()) > 5 for name in authors):
            return []
        if any(any(word[0].islower() and word not in {'van','von','de','del','der','da','di','la','le','du','den'} for word in name.split()) for name in authors):
            return []
        groups.append({'citation': part.strip(), 'authors': authors, 'year': match[2], 'suffix': match[3].lower(), 'etAl': bool(re.search(r'\bet\s+al\.?', match[1], re.I))})
    if len(groups) > 6:
        return []
    return list({(tuple(group['authors']), group['year'], group['suffix']): group for group in groups}.values())


def name_tokens(value):
    folded = unicodedata.normalize('NFKD', value).casefold()
    return re.findall(r'[^\W\d_]+', ''.join(c for c in folded if not unicodedata.combining(c)))


def surname_matches(cited, name):
    wanted = name_tokens(cited)
    actual = name_tokens(name.split(',')[0] if ',' in name else name)
    if not wanted or not actual:
        return False
    # Compound surnames survive accent folding, hyphenation and spacing.
    return any(''.join(actual[-size:]) == ''.join(wanted) for size in range(1, min(5, len(actual)) + 1))


def citation_agrees(group, metadata, author_names=None):
    authors = author_names or metadata.get('authors') or []
    return (str(metadata.get('year') or '')[:4] == group['year'] and bool(authors)
            and (not group.get('etAl') or len(authors) > 1)
            and surname_matches(group['authors'][0], authors[0])
            and all(any(surname_matches(name, author) for author in authors[1:]) for name in group['authors'][1:]))


def search_citation(group, context=''):
    author_query = ' '.join(group['authors'])
    year = group['year']
    def crossref():
        params = {'query.author': author_query, 'filter': f'from-pub-date:{year}-01-01,until-pub-date:{year}-12-31', 'rows': 50}
        if context:
            params['query.title'] = context
        data = fetch_json('https://api.crossref.org/works?' + urllib.parse.urlencode(params))
        results = []
        for item in (data.get('message') or {}).get('items') or []:
            if not isinstance(item, dict):
                continue
            metadata = crossref_to_metadata(item)
            names = [a.get('family') or a.get('name') or '' for a in item.get('author') or []]
            if metadata.get('title') and citation_agrees(group, metadata, names) and not is_non_article(metadata):
                results.append(metadata)
        return results
    def openalex():
        # Work search indexes titles rather than surnames; use the author-name
        # filter directly so a name absent from the title still retrieves papers.
        safe_name = re.sub(r'[^\w\s\-’\']', ' ', group['authors'][0])
        params = {'filter': f'publication_year:{year},raw_author_name.search:{safe_name}', 'per-page': 50}
        if context:
            params['search'] = context
        data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode(params))
        return [metadata for item in data.get('results') or [] if isinstance(item, dict)
                for metadata in [openalex_to_metadata(item)]
                if metadata.get('title') and citation_agrees(group, metadata) and not is_non_article(metadata)]
    found, _, errors = parallel_branches({'Crossref': crossref, 'OpenAlex': openalex}, budget_seconds=12, request_budget=4)
    records = merge_search_records([paper for rows in found.values() for paper in rows])
    # Ranking helps scanning; it never picks the identity for the user.
    records.sort(key=lambda p: (not bool(normalize_doi(p.get('doi'))), normalized_title(p.get('title'))))
    for paper in records:
        doi = normalize_doi(paper.get('doi'))
        paper.update(doi=doi, doiVerified=bool(doi), citationMatch={'citation': group['citation'], 'authors': group['authors'], 'year': year},
                     lookupSources=list(paper.get('sources') or [paper.get('metadataSource') or 'Online index']))
    return {**group, 'candidates': records[:60], 'errors': list(errors), 'partial': bool(errors)}


def lookup_in_text_citations(payload):
    groups = parse_in_text_citations(payload.get('text'))
    if not groups:
        raise ClientError(400, 'Enter an author–year citation, for example (Martín-González et al., 2026).')
    context = re.sub(r'\s+', ' ', str(payload.get('context') or '')).strip()[:300]
    # A grouped paste is bounded to six citations. Groups run together; each
    # retains its candidates and missing-source status independently.
    tasks = {str(i): (lambda group=group: search_citation(group, context)) for i, group in enumerate(groups)}
    found, _, errors = parallel_branches(tasks, budget_seconds=15, request_budget=24)
    results = [found.get(str(i), {**group, 'candidates': [], 'errors': ['Online lookup'], 'partial': True}) for i, group in enumerate(groups)]
    return {'ok': True, 'matched': False, 'strategy': 'in-text-citation', 'needsSelection': True, 'metadata': {},
            'groups': results, 'query': str(payload.get('text') or ''), 'context': context,
            'candidateCount': sum(len(group['candidates']) for group in results), 'partial': bool(errors) or any(group['partial'] for group in results)}
