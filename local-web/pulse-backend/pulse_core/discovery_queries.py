"""Bounded phrase-aware query planning. Document content is data."""
import copy
import re
import time
from pulse_core.search_limits import SearchResults
from pulse_core.search_merge import merge_search_records
from pulse_performance import DiscoveryCancelled, DiscoveryBudgetExceeded, check_cancelled, publish_partial

STOP = set('a an the and or of in on for to from with by is are was were this that these those we our their it as at be using study studies research results paper approach analysis method methods based new how why what which can could do does did have has effects effect role impact important review overview understanding'.split())
SYNONYMS = [('machine learning', 'ML'), ('artificial intelligence', 'AI'),
            ('information retrieval', 'document search'), ('public transport', 'public transit'),
            ('urban transport', 'urban mobility'), ('open access', 'OA')]


def terms(value):
    return [word for word in re.findall(r"[\w-]+", str(value or '').lower()) if len(word) > 2 and word not in STOP]


def phrase(value, maximum=24):
    return ' '.join(re.findall(r'[\w-]+', str(value or ''))[:maximum])[:300]


def text_for_paper(paper):
    keywords = paper.get('paperKeywords') or paper.get('keywords') or []
    if isinstance(keywords, str): keywords = [keywords]
    passages = ' '.join(str(p.get('text') or '') for p in paper.get('matchedPassages') or [])[:16000]
    return '\n'.join([str(paper.get('title') or ''), str(paper.get('abstract') or '')[:16000], '; '.join(map(str, keywords)), passages])


def concept_groups(value, keywords=None, definitions=''):
    """Keep explicit phrases; synonyms are alternatives within one concept."""
    keywords = [keywords] if isinstance(keywords, str) else keywords or []
    chunks = re.findall(r'["“]([^"”]{2,100})["”]', str(value))
    chunks += list(keywords[:4])
    if not chunks:
        # Split only at actual boundaries in source text. Dropping stop words
        # and then quoting the remaining words invents non-existent phrases.
        boundaries = r'\b(?:'+ '|'.join(sorted(map(re.escape, STOP),key=len,reverse=True))+r'|reduce[sd]?|improve[sd]?|affect[sd]?|influence[sd]?)\b|[:;,?]'
        chunks = [phrase(chunk,6) for chunk in re.split(boundaries,str(value),flags=re.I) if terms(chunk)]
        chunks = sorted(chunks,key=lambda chunk:-(len(terms(chunk)) + 2*any(re.search(r'\b'+re.escape(long)+r'\b',chunk,re.I) for long,_ in SYNONYMS)))
    groups, seen = [], set()
    for chunk in chunks:
        literal = phrase(chunk, 6)
        if not literal or not terms(literal) or literal.lower() in seen: continue
        seen.add(literal.lower())
        alternatives = [literal]
        for long, short in SYNONYMS:
            if re.search(r'\b'+re.escape(long)+r'\b', literal, re.I): alternatives.append(re.sub(re.escape(long), short, literal, flags=re.I))
            elif literal.casefold() == short.casefold(): alternatives.append(long)
        # Accept only acronyms explicitly defined in source metadata.
        for match in re.finditer(r'([A-Za-z][A-Za-z -]{3,70})\s*\(([A-Z][A-Z0-9-]{1,8})\)', definitions[:16000]):
            long, short = phrase(match[1], 10), match[2]
            if long.casefold().endswith(literal.casefold()) or literal.casefold().startswith(long.casefold()) or literal.casefold() == short.casefold(): alternatives.append(short if literal.casefold() != short.casefold() else long)
        groups.append(list(dict.fromkeys(alternatives))[:3])
    return groups[:3]


def build_query_plan(seeds, preferred=None, question='', feedback=None):
    queries, seen = [], set()
    def add(text, kind, index=None, keywords=None, definitions=''):
        clean = phrase(text)
        if len(terms(clean)) < 2 or clean.casefold() in seen: return
        seen.add(clean.casefold())
        queries.append({'id': f'q{len(queries)+1}', 'text': clean, 'kind': kind, 'seedIndex': index,
                        'groups': concept_groups(text, keywords, definitions)})
    if question: add(question, 'question')
    if preferred: add(' '.join(preferred), 'preferred', keywords=preferred)
    for i, seed in enumerate(seeds[:24]):
        add(seed.get('title') or text_for_paper(seed), 'seed', i, definitions=text_for_paper(seed))
    for i, seed in enumerate(seeds[:24]):
        keys = seed.get('paperKeywords') or seed.get('keywords') or []
        if isinstance(keys, str): keys = re.split(r'[;,]', keys)
        # Keywords preserve concepts; otherwise use title phrases rather than
        # frequent, disconnected words from the whole abstract.
        groups = concept_groups(seed.get('title') or '', keys, text_for_paper(seed))
        focus = [group[0] for group in groups]
        add(' '.join(focus), 'concepts', i, keywords=focus, definitions=text_for_paper(seed))
        expanded = [alternative for group in groups for alternative in group[1:]]
        if expanded: add(' '.join(focus[:2] + expanded[:2]), 'expanded', i, keywords=focus, definitions=text_for_paper(seed))
    for row in (feedback or [])[:8]:
        if row['grade'] > 0:
            p = row['paper']
            add(p.get('title'), 'feedback', keywords=p.get('paperKeywords'), definitions=text_for_paper(p))
    return queries[:60]


def provider_query(query, provider):
    value = phrase(query['text'])
    if provider not in ('europePmc', 'core'): return value
    groups = query.get('groups') or concept_groups(value)
    relaxed = query.get('kind') in ('broader','broadest')
    if relaxed:
        # Broaden by dropping one concept, never by matching any individual word.
        groups = groups[:1] if query.get('kind') == 'broadest' else groups[:max(1, len(groups)-1)]
    parts = []
    for group in groups:
        alternatives = []
        for value in group:
            literal = phrase(value,6)
            if not literal: continue
            if query.get('kind') == 'broadest' and len(terms(literal)) > 1:
                alternatives.append('('+' AND '.join('"'+word+'"' for word in terms(literal))+')')
            else: alternatives.append('"'+literal+'"')
        parts.append('('+' OR '.join(alternatives)+')')
    if not parts: return value
    expression = ' AND '.join(parts)
    return 'TITLE_ABS:('+expression+')' if provider == 'europePmc' else '(title:('+expression+') OR abstract:('+expression+'))'


def search_query_plan(plan, provider, searcher, limit, on_progress=None, **kwargs):
    records, warnings, executed = SearchResults(), [], []
    required = [q for q in plan if q['kind'] in {'question', 'preferred', 'seed', 'bridge'}]
    extra = [q for q in plan if q not in required]
    chosen = (required + extra)[:26]
    quota = max(20, min(500, (limit + max(1, len(chosen))-1)//max(1, len(chosen))))
    started, stale = time.monotonic(), 0
    required_ids, covered = {q['id'] for q in required}, set()
    def collect(query, rows):
        nonlocal stale
        before = len(merge_search_records(records))
        for rank, item in enumerate(rows[:quota], 1):
            item = copy.deepcopy(item)
            item['retrievalEvidence'] = [{'channel': 'concepts:'+query['id'], 'queryId': query['id'],
                'query': query['text'], 'provider': provider, 'rank': rank, 'seedIndex': query.get('seedIndex'), 'seedIndices': query.get('seedIndices', [])}]
            records.append(item)
        merged = SearchResults(merge_search_records(records))
        stale = stale + 1 if len(merged) == before else 0
        if getattr(rows, 'warning', ''): warnings.append(rows.warning)
        merged.warning = ' · '.join(dict.fromkeys(warnings))
        merged.queries_executed = list(executed)
        publish_partial(merged)
        if on_progress: on_progress(merged)
        return len(merged)
    for query in chosen:
        if len(executed) >= 26: break
        if time.monotonic()-started >= 45:
            warnings.append('Search time budget reached; showing collected results.'); break
        if required_ids <= covered and stale >= 2: break
        covered.add(query['id'])
        try:
            check_cancelled()
            rows = searcher(provider_query(query, provider), limit=quota, **kwargs)
            executed.append(query['id'])
            count = collect(query, rows)
            if getattr(rows, 'warning', ''):
                warn_text = str(rows.warning).lower()
                if any(k in warn_text for k in ('http 500', 'http 502', 'http 503', 'http 504', '500', '502', '503', '401', '403', '429', 'unavailable', 'limit reached', 'access unavailable')):
                    break
            check_cancelled()
            # A focused query can be too strict. Loosen one concept immediately.
            if len(rows) < 5 and query.get('groups') and len(executed) < 26:
                broader = dict(query, id=query['id']+'b', kind='broader')
                broad_text = provider_query(broader, provider)
                if broad_text != provider_query(query, provider):
                    check_cancelled()
                    rows = searcher(broad_text, limit=quota, **kwargs)
                    executed.append(broader['id']); count = collect(broader, rows)
                    if getattr(rows, 'warning', ''):
                        warn_text = str(rows.warning).lower()
                        if any(k in warn_text for k in ('http 500', 'http 502', 'http 503', 'http 504', '500', '502', '503', '401', '403', '429', 'unavailable', 'limit reached', 'access unavailable')):
                            break
                    if len(rows) < 5 and len(executed) < 26:
                        loosest = dict(broader,id=query['id']+'c',kind='broadest')
                        loose_text = provider_query(loosest,provider)
                        if loose_text != broad_text:
                            check_cancelled()
                            rows = searcher(loose_text,limit=quota,**kwargs)
                            executed.append(loosest['id']); count = collect(loosest,rows)
                            if getattr(rows, 'warning', ''):
                                warn_text = str(rows.warning).lower()
                                if any(k in warn_text for k in ('http 500', 'http 502', 'http 503', 'http 504', '500', '502', '503', '401', '403', '429', 'unavailable', 'limit reached', 'access unavailable')):
                                    break
            if count >= limit: break
        except DiscoveryCancelled: raise
        except DiscoveryBudgetExceeded:
            warnings.append('Search time budget reached; showing collected results.'); break
        except Exception as error:
            warnings.append(str(error))
            status = getattr(error, 'status', getattr(error, 'code', 0))
            err_str = str(error).lower()
            if status in {401, 403, 429, 500, 502, 503, 504} or any(k in err_str for k in ('limit reached', 'unavailable', '500', '502', '503', 'access unavailable')): break
    if not records and warnings: raise RuntimeError(warnings[0])
    merged = SearchResults(merge_search_records(records)[:limit])
    merged.warning = ' · '.join(dict.fromkeys(warnings))
    merged.queries_executed = executed
    return merged
