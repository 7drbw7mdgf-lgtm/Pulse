"""Bounded query planning. Document content is data, never an instruction."""
import collections
import copy
import re
from pulse_core.search_limits import SearchResults
from pulse_core.search_merge import merge_search_records
from pulse_performance import DiscoveryCancelled, check_cancelled

STOP = set('a an the and or of in on for to from with by is are was were this that these those we our their it as at be using study studies research results paper approach analysis method methods based new'.split())
# Small, explicit expansions; no speculative entities or generated facts.
SYNONYMS = [('machine learning', 'ML'), ('artificial intelligence', 'AI'),
            ('information retrieval', 'document search'), ('public transport', 'public transit'),
            ('urban transport', 'urban mobility'), ('open access', 'OA')]

def terms(value):
    return [word for word in re.findall(r"[\w-]+", str(value or '').lower()) if len(word) > 2 and word not in STOP]

def phrase(value, maximum=16):
    return ' '.join(re.findall(r'[\w-]+', str(value or ''))[:maximum])[:240]

def text_for_paper(paper):
    keywords = paper.get('paperKeywords') or paper.get('keywords') or []
    if isinstance(keywords, str): keywords = [keywords]
    return '\n'.join([str(paper.get('title') or ''), str(paper.get('abstract') or '')[:6000], '; '.join(map(str, keywords))])

def build_query_plan(seeds, preferred=None, question=''):
    queries, seen = [], set()
    def add(text, kind, index=None):
        text = phrase(text)
        if len(terms(text)) < 2 or text.casefold() in seen: return
        seen.add(text.casefold())
        queries.append({'id': f'q{len(queries)+1}', 'text': text, 'kind': kind, 'seedIndex': index})
    if question: add(question, 'question')
    if preferred: add(' '.join(preferred), 'preferred')
    # Each seed gets a focused query before any seed gets an expanded query.
    for i, seed in enumerate(seeds[:24]):
        add(seed.get('title') or text_for_paper(seed), 'seed', i)
    for i, seed in enumerate(seeds[:24]):
        keys = seed.get('paperKeywords') or seed.get('keywords') or []
        if isinstance(keys, str): keys = re.split(r'[;,]', keys)
        abstract_terms = collections.Counter(terms(seed.get('abstract')))
        focus = [phrase(key, 5) for key in keys[:3]] or [w for w, _ in abstract_terms.most_common(6)]
        add(' '.join(focus), 'concepts', i)
        text = text_for_paper(seed)
        expansions = []
        for long, short in SYNONYMS:
            if re.search(r'\b'+re.escape(long)+r'\b', text, re.I): expansions.append(short)
            elif re.search(r'\b'+re.escape(short)+r'\b', text): expansions.append(long)
        # Only expand acronyms actually defined in the source.
        for match in re.finditer(r'([A-Za-z][A-Za-z -]{5,70})\s*\(([A-Z][A-Z0-9-]{1,8})\)', text[:6000]):
            expansions.append(match[2] if match[2] not in (seed.get('title') or '') else match[1].split('.')[-1])
        if expansions: add(' '.join(focus[:2]+expansions[:2]), 'expanded', i)
    return queries[:50]

def provider_query(query, provider):
    # Queries are constructed here from stripped words; upstream operators cannot
    # enter through an abstract, user question or uploaded document.
    value = phrase(query['text'])
    if provider == 'europePmc':
        if query['kind'] == 'seed': return 'TITLE:"'+value+'"'
        return 'TITLE_ABS:('+' OR '.join(terms(value)[:12])+')'
    if provider == 'core':
        if query['kind'] == 'seed': return 'title:"'+value+'"'
        words = ' OR '.join(terms(value)[:12])
        return f'(title:({words}) OR abstract:({words}))'
    return value

def search_query_plan(plan, provider, searcher, limit, **kwargs):
    """Separate result lists retain ranks; repeated provider mirrors are fused later."""
    records, warnings, executed = SearchResults(), [], []
    # Bounded requests with fair coverage of seed queries, then concept/expansion
    # queries. Extra seeds are represented by balanced batches, never concatenated
    # into one title. Keep the usual one-seed case inexpensive.
    seed_queries = [q for q in plan if q['kind'] in {'question', 'preferred', 'seed'}]
    extra = [q for q in plan if q not in seed_queries]
    chosen = (seed_queries + [q for q in extra if q['kind']=='concepts'] + [q for q in extra if q['kind']=='expanded'])[:26]
    quota = max(10, (limit + max(1, len(chosen))-1)//max(1, len(chosen)))
    for query in chosen:
        check_cancelled()
        try:
            rows = searcher(provider_query(query, provider), limit=quota, **kwargs)
            check_cancelled()
            executed.append(query['id'])
            if getattr(rows, 'warning', ''): warnings.append(rows.warning)
            for rank, item in enumerate(rows, 1):
                item = copy.deepcopy(item)
                item['retrievalEvidence'] = [{'channel': 'concepts:'+query['id'], 'queryId': query['id'],
                    'query': query['text'], 'provider': provider, 'rank': rank}]
                records.append(item)
        except DiscoveryCancelled: raise
        except Exception as error:
            warnings.append(str(error))
            # Rate-limit/auth failures should not be multiplied across queries.
            if 'limit reached' in str(error).lower() or getattr(error, 'status', 0) in {401,403,429}: break
    # Adaptive broadening only when retrieval is sparse, within a small budget.
    if len(merge_search_records(records)) < min(20, limit) and chosen:
        broader = {'id': 'broad', 'text': ' '.join(terms(chosen[0]['text'])[:4]), 'kind': 'broader'}
        if broader['text'] and broader['text'] != chosen[0]['text']:
            try:
                rows = searcher(provider_query(broader, provider), limit=limit, **kwargs)
                executed.append('broad')
                if getattr(rows, 'warning', ''): warnings.append(rows.warning)
                for rank, item in enumerate(rows, 1):
                    item = copy.deepcopy(item)
                    item['retrievalEvidence'] = [{'channel':'concepts:broad', 'queryId':'broad',
                        'query':broader['text'], 'provider':provider, 'rank':rank}]
                    records.append(item)
            except DiscoveryCancelled: raise
            except Exception as error: warnings.append(str(error))
    if not records and warnings: raise RuntimeError(warnings[0])
    merged = SearchResults(merge_search_records(records))
    merged.warning = ' · '.join(dict.fromkeys(warnings))
    merged.queries_executed = executed
    return merged
