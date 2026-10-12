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
    # Vancouver/numbered references: "Huang C, Wang Y, et al. Title. Lancet 2020;395(10223):497-506."
    vancouver = re.match(
        r'^(?:\[?\d{1,3}[\].)]\s*)?(?P<authors>[^.]{2,400}?(?:,?\s*et al)?)\.\s+(?P<title>[^.]{12,350}?[?!]?)\.?\s+'
        r'(?P<journal>[A-Z][^.;\d]{1,100}?)\.?\s+(?P<year>(?:19|20)\d{2})[^;:]{0,20};\s*(?P<volume>\d+)'
        r'(?:\((?P<issue>[^)]+)\))?\s*:\s*(?P<pages>[A-Za-z]?\d+(?:\s*[-\u2013]\s*[A-Za-z]?\d+)?)',
        clean(text[:1500]))
    if vancouver and not result.get('title'):
        result.update(title=vancouver['title'].strip(), year=vancouver['year'], journal=vancouver['journal'].strip(' .'),
                      volume=vancouver['volume'], pages=re.sub(r'\s+', '', vancouver['pages']).replace('\u2013', '-'))
        if vancouver['issue']:
            result['issue'] = vancouver['issue']
        result['authors'] = [name.strip() for name in re.split(r',\s*', re.sub(r',?\s*et al$', '', vancouver['authors'])) if name.strip()]
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


# Registry records that repeat a paper's title but are not the paper itself.
NON_ARTICLE_TITLE_RE = re.compile(
    r'^\s*(?:faculty opinions recommendation of|f1000(?:prime)? recommendation of|'
    r'review (?:for|of)\s*[:"“]|decision letter|author response|reviewer report|peer review (?:of|for)|'
    r'correction(?: to)?\s*[:–-]|erratum|corrigendum|retraction(?: note)?(?: to| of)?\s*[:–-]|'
    r'expression of concern)', re.I)
NON_ARTICLE_TYPES = {'peer-review', 'component'}
PREPRINT_TYPES = {'posted-content', 'preprint'}


def normalized_title(value):
    # Dashes and other punctuation separate words ("protein–protein"); split on
    # them before accents are folded away.
    spaced = re.sub(r'[^\w]+', ' ', clean(value)).replace('_', ' ')
    folded = unicodedata.normalize('NFKD', spaced).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', folded)).strip()


def title_similarity(expected, candidate):
    """Order-sensitive title agreement; a missing or extra subtitle still counts."""
    a, b = normalized_title(expected), normalized_title(candidate)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Compare words in order, so "in mice" and "in rats" differ by a word rather
    # than a few characters. A long word one or two letters off counts as a typo.
    words_a, words_b = a.split(), b.split()
    vocabulary = set(words_b)
    def corrected(word):
        if word in vocabulary or len(word) < 5:
            return word
        close = [other for other in vocabulary if len(other) >= 5 and SequenceMatcher(None, word, other).ratio() >= .85]
        return close[0] if close else word
    ratio = SequenceMatcher(None, [corrected(word) for word in words_a], words_b, autojunk=False).ratio()
    shorter, longer, raw_longer = (a, b, clean(candidate)) if len(a) <= len(b) else (b, a, clean(expected))
    if len(shorter.split()) >= 5 and longer.startswith(shorter + ' '):
        # "Title" against "Title: subtitle" is the same work; "Title" against
        # "Title of familial clustering..." is not, so require a subtitle break.
        cut = normalized_title(raw_longer.split(':', 1)[0]) if ':' in raw_longer else ''
        if cut == shorter or re.search(r'[:–—]|\s-\s', raw_longer):
            ratio = max(ratio, .96)
    return ratio


def is_non_article(candidate, expected_title=''):
    title = candidate.get('title') or ''
    if NON_ARTICLE_TITLE_RE.search(title) and not NON_ARTICLE_TITLE_RE.search(expected_title or ''):
        return True
    if str(candidate.get('doi') or '').lower().startswith('10.3410/'):
        return True  # Faculty Opinions / F1000Prime recommendations
    return str(candidate.get('publicationType') or '').lower() in NON_ARTICLE_TYPES


def is_preprint(candidate):
    doi = str(candidate.get('doi') or '').lower()
    return (str(candidate.get('publicationType') or '').lower() in PREPRINT_TYPES
            or doi.startswith(('10.1101/', '10.48550/', '10.21203/', '10.20944/', '10.2139/ssrn')))


def citation_contains_title(citation, title):
    """True when a pasted reference contains the candidate's full title."""
    text, wanted = normalized_title(citation), normalized_title(title)
    if len(wanted.split()) < 4 or not text:
        return False
    if wanted in text:
        return True
    match = SequenceMatcher(None, text, wanted).find_longest_match(0, len(text), 0, len(wanted))
    return match.size >= .92 * len(wanted)


def candidate_score(expected, candidate):
    """Require identifying evidence; publication year alone cannot identify a paper."""
    parts, weights = {}, {}
    if meaningful_title(expected.get('title')):
        parts['title'] = title_similarity(expected['title'], candidate.get('title'))
        weights['title'] = .7
    citation = expected.get('_citation')
    if citation and citation_contains_title(citation, candidate.get('title')):
        parts['title'] = max(parts.get('title', 0), .97)
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
        # Independent evidence that this is the same work, beyond the title.
        support = sum((parts.get('authors', 0) >= .65, parts.get('year', 0) == 1.0,
                       parts.get('journal', 0) >= .75, bool(parts.get('pages'))))
        conflict = parts.get('authors', 1) < .5 and parts.get('year') == 0
        if title >= .95:
            # A near-exact title identifies the work unless authors and year both disagree.
            accepted = not conflict
        elif title >= .85:
            # Partial or garbled titles need two independent agreeing fields.
            accepted = support >= 2 and not conflict and score >= .8
        else:
            accepted = False
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
        data = fetch_json('https://api.crossref.org/works?' + urllib.parse.urlencode({'query.bibliographic': query, 'rows': 10}))
        candidates += [crossref_to_metadata(item) for item in (data.get('message') or {}).get('items') or []]
    except Exception as error:
        errors.append('Crossref: ' + str(error))
    def ranked(items):
        scored = [(candidate_score(expected, candidate), candidate) for candidate in items
                  if candidate.get('title') and not is_non_article(candidate, title)]
        return sorted(scored, key=lambda item: (item[0]['accepted'], item[0]['score']), reverse=True)
    results = ranked(candidates)
    # Crossref's first page can miss a paper entirely (for example when review
    # records repeat its title), so consult OpenAlex unless the title is exact.
    exact = bool(results and results[0][0]['accepted'] and results[0][0]['fields'].get('title', 0) >= .99)
    if not exact:
        try:
            term = title if meaningful_title(title) else clean(' '.join(filter(None, [expected.get('abstract'), expected.get('keywords')])) or query, 700)
            data = fetch_json('https://api.openalex.org/works?' + urllib.parse.urlencode({'search': term, 'per-page': 10}))
            candidates += [openalex_to_metadata(item) for item in data.get('results') or []]
        except Exception as error:
            errors.append('OpenAlex: ' + str(error))
        results = ranked(candidates)
    if not results or not results[0][0]['accepted']:
        from .literature_search import search_europe_pmc, search_core
        from .config_resolvers import resolve_core_api_key
        from .storage import load_settings
        from pulse_performance import parallel_branches
        term = title if meaningful_title(title) else query
        found, _, failures = parallel_branches({
            'Europe PMC': lambda: search_europe_pmc(term, limit=5),
            'CORE': lambda: search_core(term, limit=5, api_key=resolve_core_api_key(load_settings())),
        })
        for records in found.values():
            candidates.extend(records)
        errors.extend(message if message.startswith(source + ':') else source + ': ' + message for source, message in failures.items())
        results = ranked(candidates)
    from .search_merge import merge_search_records
    results = ranked(merge_search_records(candidates))
    # Deduplicate provider results so the same article is not an ambiguous match.
    unique = []
    seen = set()
    for evidence, candidate in results:
        key = normalize_doi(candidate.get('doi')) or (' '.join(sorted(token_set(candidate['title']))) + str(candidate.get('year')))
        if key.lower() not in seen:
            seen.add(key.lower())
            unique.append((evidence, candidate))
    best = unique[0] if unique else None
    contenders = [item for item in unique if item[0]['accepted'] and best and best[0]['score'] - item[0]['score'] < .05]
    if best and best[0]['fields'].get('title', 0) >= .99:
        # An exact title outranks works that only extend it with a subtitle.
        contenders = [item for item in contenders if item[0]['fields'].get('title', 0) >= .99]
    if len(contenders) > 1:
        # Same-title records: prefer the published version of a preprint, then a
        # decisively more-cited work. Otherwise report the ambiguity honestly.
        # A preprint yields to its published version only when they share
        # authors; an unrelated journal article with the same title must not win.
        def surnames(item):
            return {token_set(name.split(',')[0]).pop() if ',' in name else (sorted(token_set(name), key=len)[-1] if token_set(name) else '')
                    for name in item[1].get('authors') or []} - {''}
        published = [item for item in contenders if not is_preprint(item[1])]
        preprints = [item for item in contenders if is_preprint(item[1])]
        if published and preprints and all(any(surnames(pre) & surnames(pub) for pub in published) for pre in preprints):
            contenders = published
        if len(contenders) > 1:
            by_citations = sorted(contenders, key=lambda item: int(item[1].get('citationCount') or 0), reverse=True)
            top, runner = (int(item[1].get('citationCount') or 0) for item in by_citations[:2])
            if top >= 50 and top >= 10 * max(runner, 1):
                contenders = by_citations[:1]
        best = contenders[0]
    ambiguous = len(contenders) > 1
    matched = bool(best and best[0]['accepted'] and not ambiguous)
    return {'matched': matched, 'ambiguous': ambiguous, 'metadata': best[1] if matched else {},
            'match': best[0] if best else {}, 'query': query, 'errors': errors,
            'candidates': [{'title': item.get('title'), 'doi': item.get('doi'), 'year': item.get('year'),
                            'authors': item.get('authors'), 'score': evidence['score']} for evidence, item in unique[:5]]}


def resolve_metadata(payload):
    from .metadata_scanner import lookup_doi_metadata, lookup_pmid_metadata
    if payload.get('verifyIdentity') and normalize_doi(payload.get('doi')):
        from .citation_identity import verify_candidate
        verified = verify_candidate(payload)
        return {'ok':True,'matched':verified['verified'],'strategy':'doi','source':(verified.get('verification') or {}).get('sources'),'metadata':verified.get('metadata') or {},'errors':[] if verified['verified'] else [verified.get('reason')],'candidates':[]}
    text = str(payload.get('text') or '')[:120000]
    if payload.get('parseInput') and not payload.get('doi') and not payload.get('pmid'):
        from .citation_lookup import parse_in_text_citations, lookup_in_text_citations
        if parse_in_text_citations(text):
            return lookup_in_text_citations(payload)
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
    # A single pasted reference: let candidates prove their full title appears in it.
    single = clean(text, 2000)
    if payload.get('parseInput') and 30 <= len(single) <= 1500 and '\n' not in text.strip() and re.search(r'\b(?:19|20)\d{2}\b', single):
        expected['_citation'] = single
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
    expected.pop('_citation', None)
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
