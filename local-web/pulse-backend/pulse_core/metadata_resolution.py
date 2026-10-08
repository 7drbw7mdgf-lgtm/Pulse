"""DOI-first resolution with conservative, multi-field bibliographic matching."""
import html
import re
import unicodedata
import urllib.parse
from difflib import SequenceMatcher
from .doi_utils import ranked_doi_candidates, normalize_doi, DOI_REFERENCES_RE
from .external_apis import fetch_json
from .metadata_utils import crossref_to_metadata, openalex_to_metadata, merge_metadata


def clean(value, limit=2000):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', str(value or '')))).strip()[:limit]


def meaningful_title(value):
    title = clean(value)
    return bool(12 <= len(title) <= 350 and len(title.split()) >= 3 and not re.search(
        r'^(?:untitled|paper\s*\(|doi\b|pmid\b|references\b|abstract\b)|\.(?:pdf|bib|ris|json)$', title, re.I))


def primary_doi_candidates(value):
    text = str(value or '')
    refs = DOI_REFERENCES_RE.search(text)
    # A reference list identifies other papers, not this upload.
    if refs:
        text = text[:refs.start()]
    return ranked_doi_candidates(text)[:4]


def extract_text_metadata(text, filename=''):
    text = str(text or '')[:120000]
    result = {}
    labels = {
        'title': ('title', 'article title', 'TI', 'T1'),
        'authors': ('authors?', 'AU', 'A1', 'FAU'),
        'journal': ('journal', 'journaltitle', 'publication', 'published in', 'JF', 'JO', 'T2'),
        'year': ('year', 'date', 'published', 'publication date', 'PY', 'Y1'),
        'volume': ('volume', 'VL'), 'issue': ('issue', 'number', 'IS'),
        'pages': ('pages?', 'SP'), 'issn': ('issn', 'SN'), 'pmid': ('pmid',),
        'abstract': ('abstract', 'AB', 'N2'), 'keywords': ('keywords?', 'KW'),
    }
    for field, names in labels.items():
        pattern = r'^\s*(?:' + '|'.join(names) + r')\s*(?::|=|\s-\s)\s*[{"\']?([^\n]+)'
        values = re.findall(pattern, text, re.I | re.M)
        if values:
            result[field] = clean('; '.join(values) if field == 'authors' else values[0]).strip('{}"\', ')
    if result.get('authors'):
        result['authors'] = [clean(x) for x in re.split(r';|\s+and\s+', result['authors']) if clean(x)]
    year = re.search(r'\b(?:19|20)\d{2}\b', str(result.get('year') or text[:2500]))
    if year:
        result['year'] = year.group()
    lines = [clean(line) for line in text.splitlines() if clean(line)]
    # Common author-date citations; keep initials and surname commas intact.
    citation = re.match(r'^(.{3,250}?)\s*\((\d{4})[a-z]?\)\s*[.,]?\s*(.{12,400}?)\.\s+(.+)$', clean(text[:1500]))
    if citation and not result.get('title'):
        result.update(title=citation[3], authors=[x.strip() for x in re.split(r';|\s+and\s+|\s*&\s*', citation[1])], year=citation[2])
        venue = re.split(r',\s*\d|\b\d+\s*\(', citation[4])[0].strip(' .,')
        if venue:
            result['journal'] = venue
        pagination = re.search(r',\s*(\d+)\s*(?:\(([^)]+)\))?\s*[,;:]\s*(\d+(?:\s*[-–—]\s*\d+)?)', citation[4])
        if pagination:
            result['volume'] = pagination[1]
            if pagination[2]: result['issue'] = pagination[2]
            result['pages'] = re.sub(r'\s+', '', pagination[3]).replace('–','-').replace('—','-')
    if not result.get('title'):
        for line in lines[:14]:
            if meaningful_title(line) and not re.match(r'^(?:[{@]|https?://|doi\b|journal\b|copyright\b|volume\b|issn\b|authors?\b|university\b|department\b|received\b|accepted\b|published\b)', line, re.I):
                result['title'] = line
                break
    if not result.get('authors') and result.get('title') in lines:
        after_title = lines.index(result['title']) + 1
        for line in lines[after_title:after_title + 4]:
            if re.search(r'\b(?:abstract|journal|review|department|university|institute|introduction|keywords|doi|copyright|published|volume|study|research|article|title)\b|@|https?://', line, re.I):
                continue
            names = [name.strip() for name in re.split(r';|,|\s+and\s+|\s*&\s*', line)]
            def plausible_name(name):
                words = re.findall(r"[\wÀ-ÿ.'-]+", name)
                return 2 <= len(words) <= 5 and all(word[0].isupper() or word.lower() in {'van','von','de','del','der','da'} for word in words)
            if names and all(plausible_name(name) for name in names):
                result['authors'] = names
                break
    if not result.get('journal'):
        journal = re.search(r'^(.{5,100}?)\s+(?:Vol\.?|Volume)\s*\d', text[:3000], re.I | re.M)
        if journal:
            result['journal'] = clean(journal[1])
    if not result.get('title'):
        name = re.sub(r'\.(?:pdf|txt|md)$', '', filename, flags=re.I)
        name = re.sub(r'[_-]+', ' ', name).strip()
        if meaningful_title(name):
            result['title'] = name
    if not result.get('abstract'):
        abstract = re.search(r'\bAbstract\s*[:\n]\s*(.*?)(?=\n\s*(?:Keywords|Introduction|Background|References)\b|$)', text, re.I | re.S)
        if abstract:
            result['abstract'] = clean(abstract[1], 5000)
    return result


def token_set(value):
    folded = unicodedata.normalize('NFKD', clean(value)).encode('ascii', 'ignore').decode().lower()
    return set(re.findall(r'[a-z0-9]+', folded)) - {'the', 'a', 'an', 'and', 'of', 'in', 'for', 'to', 'on', 'with'}


def similarity(left, right):
    a, b = token_set(left), token_set(right)
    if not a or not b:
        return 0.0
    overlap = len(a & b) / max(len(a), len(b))
    sequence = SequenceMatcher(None, clean(left).lower(), clean(right).lower()).ratio()
    return max(overlap, sequence)


def candidate_score(expected, candidate):
    """Require identifying evidence; publication year alone cannot identify a paper."""
    parts, weights = {}, {}
    if meaningful_title(expected.get('title')):
        parts['title'] = similarity(expected['title'], candidate.get('title'))
        weights['title'] = .7
    authors = expected.get('authors') or []
    if authors:
        author_text = ' '.join(candidate.get('authors') or [])
        scores = [similarity(author, other) for author in authors for other in (candidate.get('authors') or [])]
        parts['authors'] = max(scores, default=0)
        # Initials and surname-only citations still provide supporting evidence.
        if any(token_set(author) & token_set(author_text) for author in authors):
            parts['authors'] = max(parts['authors'], .65)
        weights['authors'] = .12
    if expected.get('year'):
        a, b = str(expected['year'])[:4], str(candidate.get('year') or '')[:4]
        parts['year'] = 1.0 if a == b else .5 if a.isdigit() and b.isdigit() and abs(int(a)-int(b)) == 1 else 0.0
        weights['year'] = .07
    if expected.get('journal'):
        parts['journal'] = similarity(expected['journal'], candidate.get('journal'))
        weights['journal'] = .07
    for field in ('volume', 'issue', 'pages', 'issn'):
        if expected.get(field):
            parts[field] = float(bool(token_set(expected[field]) & token_set(candidate.get(field))))
            weights[field] = .01
    # Abstract and keywords help distinguish candidates, without blocking records
    # whose registry entry has no abstract or subject information.
    for field in ('abstract', 'keywords'):
        if expected.get(field) and candidate.get(field):
            parts[field] = similarity(expected[field], candidate[field])
            weights[field] = .03
    total = sum(weights.values())
    score = sum(parts[key]*weights[key] for key in weights) / total if total else 0
    title = parts.get('title')
    if title is not None:
        accepted = title >= .72 and score >= .74
        # Near-exact titles suffice, but reject obvious author/year conflicts.
        if title >= .94:
            accepted = not (parts.get('authors', 1) < .5 and parts.get('year') == 0)
    else:
        accepted = (parts.get('authors', 0) >= .65 and parts.get('journal', 0) >= .75
                    and parts.get('year', 0) >= .5 and score >= .75)
    return {'score': round(score, 4), 'fields': parts, 'accepted': accepted}


def search_metadata(expected):
    title = expected.get('title') or ''
    parts = [title] if meaningful_title(title) else []
    parts += list(expected.get('authors') or [])
    parts += [str(expected.get(key) or '') for key in ('journal', 'year', 'volume', 'issue', 'pages', 'issn')]
    if not meaningful_title(title):
        parts += [clean(expected.get('abstract'), 400), clean(expected.get('keywords'), 200)]
    query = clean(' '.join(filter(None, parts)), 1800)
    if not query or not (meaningful_title(title) or expected.get('authors') or expected.get('abstract')):
        return {'matched': False, 'candidates': [], 'query': query, 'errors': []}
    candidates, errors = [], []
    try:
        data = fetch_json('https://api.crossref.org/works?' + urllib.parse.urlencode({'query.bibliographic': query, 'rows': 5}))
        candidates += [crossref_to_metadata(item) for item in (data.get('message') or {}).get('items') or []]
    except Exception as error:
        errors.append('Crossref: ' + str(error))
    def ranked(items):
        scored = [(candidate_score(expected, candidate), candidate) for candidate in items if candidate.get('title')]
        return sorted(scored, key=lambda item: (item[0]['accepted'], item[0]['score']), reverse=True)
    results = ranked(candidates)
    if not results or not results[0][0]['accepted']:
        try:
            term = title if meaningful_title(title) else clean(' '.join(filter(None, [expected.get('abstract'), expected.get('keywords')])) or query, 700)
            data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode({'search': term, 'per-page': 5}))
            candidates += [openalex_to_metadata(item) for item in data.get('results') or []]
        except Exception as error:
            errors.append('OpenAlex: ' + str(error))
        results = ranked(candidates)
    # Deduplicate provider results so the same article is not an ambiguous match.
    unique = []
    seen = set()
    for evidence, candidate in results:
        key = normalize_doi(candidate.get('doi')) or (' '.join(sorted(token_set(candidate['title']))) + str(candidate.get('year')))
        if key.lower() not in seen:
            seen.add(key.lower())
            unique.append((evidence, candidate))
    best = unique[0] if unique else None
    ambiguous = bool(best and len(unique) > 1 and best[0]['score'] - unique[1][0]['score'] < .05 and unique[1][0]['accepted'])
    matched = bool(best and best[0]['accepted'] and not ambiguous)
    return {'matched': matched, 'ambiguous': ambiguous, 'metadata': best[1] if matched else {},
            'match': best[0] if best else {}, 'query': query, 'errors': errors,
            'candidates': [{'title': item.get('title'), 'doi': item.get('doi'), 'year': item.get('year'),
                            'authors': item.get('authors'), 'score': evidence['score']} for evidence, item in unique[:5]]}


def resolve_metadata(payload):
    from .metadata_scanner import lookup_doi_metadata, lookup_pmid_metadata
    text = str(payload.get('text') or '')[:120000]
    extracted = extract_text_metadata(text, payload.get('name') or '')
    expected = {key: payload[key] for key in ('title', 'authors', 'year', 'date', 'journal', 'volume', 'issue', 'pages', 'issn', 'abstract', 'keywords', 'pmid') if payload.get(key)}
    # Labelled/citation parsing is more useful than using the entire pasted input
    # as a title. Explicit structured metadata from imported records wins.
    if payload.get('parseInput'):
        expected.update(extracted)
    else:
        expected = merge_metadata(expected, extracted)
    if isinstance(expected.get('authors'), str):
        expected['authors'] = [x.strip() for x in re.split(r';|\s+and\s+', expected['authors']) if x.strip()]
    if not meaningful_title(expected.get('title')):
        expected.pop('title', None)
    explicit = normalize_doi(payload.get('doi') or '')
    candidates = [explicit] if explicit else primary_doi_candidates(text)
    for item in payload.get('doiCandidates') or []:
        doi = normalize_doi(item)
        if doi and doi not in candidates:
            candidates.append(doi)
    errors = []
    for doi in candidates[:3]:
        try:
            result = lookup_doi_metadata({'doi': doi, 'expectedTitle': expected.get('title') or ''})
            returned = result.get('metadata') or {}
            # DOI response must identify the requested DOI and agree with a
            # substantive title, rather than taking a cited reference's DOI.
            if normalize_doi(returned.get('doi')).lower() != doi.lower():
                continue
            if expected.get('title') and similarity(expected['title'], returned.get('title')) < .65:
                continue
            metadata = merge_metadata(returned, {k:v for k,v in expected.items() if k != "authors" or not returned.get("authors")})
            metadata.update(doi=doi, doiVerified=True)
            return {'ok': True, 'matched': True, 'strategy': 'doi', 'source': result.get('source'), 'metadata': metadata,
                    'query': doi, 'candidates': [], 'extracted': expected}
        except Exception as error:
            errors.append('DOI: ' + str(error))
    if expected.get('pmid'):
        try:
            result = lookup_pmid_metadata({'pmid': expected['pmid']})
            metadata = merge_metadata(result.get('metadata'), expected)
            return {'ok': True, 'matched': True, 'strategy': 'pmid', 'source': 'PubMed', 'metadata': metadata,
                    'query': str(expected['pmid']), 'candidates': [], 'extracted': expected}
        except Exception as error:
            errors.append('PubMed: ' + str(error))
    found = search_metadata(expected)
    matched = found['matched']
    metadata = merge_metadata(found.get('metadata'), expected) if matched else expected
    if explicit and not metadata.get('doi'):
        metadata['doi'] = explicit
    if matched and metadata.get('doi'):
        metadata['doiVerified'] = True
    return {'ok': True, 'matched': matched, 'strategy': 'metadata', 'source': metadata.get('metadataSource') or 'Extracted metadata',
            'metadata': metadata, 'query': found.get('query'), 'match': found.get('match'),
            'candidates': found.get('candidates'), 'ambiguous': found.get('ambiguous', False),
            'errors': errors + found.get('errors', []), 'extracted': expected}
