"""Transparent hybrid retrieval, neural reranking and diversity selection."""
import collections
import copy
import datetime
import math
import re
from pulse_core.doi_utils import normalize_doi
from pulse_core.discovery_queries import terms, text_for_paper
from pulse_core.metadata_resolution import similarity
from pulse_core.search_merge import merge_search_records, title_key
from pulse_core.search_limits import discovery_limit


def contains_phrase(text, phrase):
    words = re.findall(r'\w+', str(phrase).casefold())
    return bool(words) and bool(re.search(r'(?<!\w)'+r'[\s\W]+'.join(map(re.escape, words))+r'(?!\w)', text.casefold()))


def bm25_scores(records, queries, focus_first=False):
    docs = [collections.Counter(terms(p.get('title'))*2 + terms(p.get('abstract')) + terms(' '.join(p.get('paperKeywords') or []))) for p in records]
    df = collections.Counter(word for doc in docs for word in doc)
    average = sum(sum(doc.values()) for doc in docs)/max(1,len(docs)) or 1
    query_terms = [collections.Counter(terms(query)) for query in queries]
    scores = []
    for doc in docs:
        length = sum(doc.values())
        query_scores = [sum(math.log(1+(len(docs)-df[w]+.5)/(df[w]+.5))*doc[w]*2.2/
            (doc[w]+1.2*(.25+.75*length/average))*min(2,count)
            for w,count in q.items() if doc[w]) for q in query_terms]
        scores.append(.75*query_scores[0]+.25*max(query_scores[1:],default=0) if focus_first and query_scores else max(query_scores,default=0))
    peak = max(scores, default=0) or 1
    return [score/peak for score in scores]


def normalized_reference_similarity(shared, seed_total, candidate_total):
    return min(1, max(0, shared)/math.sqrt(max(1, seed_total)*max(1,candidate_total)))


def balanced_frontier(papers, seeds, count=4):
    # Half recent, half related; a citation total alone never chooses the frontier.
    queries = [text_for_paper(seed) for seed in seeds]
    relevance = bm25_scores(papers, queries)
    by_relevance = sorted(range(len(papers)), key=lambda i:relevance[i], reverse=True)
    by_recent = sorted(range(len(papers)), key=lambda i:str(papers[i].get('year') or ''), reverse=True)
    indices = []
    for i in by_relevance[:(count+1)//2]+by_recent:
        if i not in indices: indices.append(i)
        if len(indices)==count: break
    return [papers[i] for i in indices]


def _versions(records):
    groups = []
    def family(name):
        value=title_key(str(name).split(',')[0]);return value.split()[-1] if value else ''
    def preprint(p): return bool(re.search(r'preprint|posted-content|working.?paper', str(p.get('documentType') or p.get('publicationType') or p.get('type') or ''), re.I))
    for record in records:
        group = None
        for candidate in groups:
            # A matching generic title is insufficient to collapse different DOIs.
            if preprint(record)==preprint(candidate): continue
            authors_a = {family(a) for a in record.get('authors') or [] if family(a)}
            authors_b = {family(a) for a in candidate.get('authors') or [] if family(a)}
            years = [str(p.get('year') or '')[:4] for p in (record,candidate)]
            if (authors_a and authors_b and len(authors_a & authors_b)/min(len(authors_a),len(authors_b))>=.75
                and similarity(record.get('title'),candidate.get('title'))>=.96
                and all(y.isdigit() for y in years) and abs(int(years[0])-int(years[1]))<=3):
                group = candidate; break
        if group is None: groups.append(record); continue
        published = record if not preprint(record) else group
        other = group if published is record else record
        published['relatedVersions'] = (published.get('relatedVersions') or []) + [
            {key:other.get(key) for key in ('title','doi','url','year','documentType','sourceList')}]
        if other['score']>published['score']:
            published['scoreBreakdown']=other['scoreBreakdown'];published['matchLabel']=other['matchLabel']
        published['score'] = max(published['score'],other['score'])
        published['retrievalEvidence'] = (published.get('retrievalEvidence') or [])+(other.get('retrievalEvidence') or [])
        published['sourceList'] = sorted(set((published.get('sourceList') or [])+(other.get('sourceList') or [])))
        published['branches'] = sorted(set(published['branches']+other['branches']))
        published['branchHits']={**(published.get('branchHits') or {}),**(other.get('branchHits') or {})}
        published['matchReasons']=list(dict.fromkeys((published.get('matchReasons') or [])+(other.get('matchReasons') or [])))
        groups[groups.index(group)] = published
    return groups


def merge_and_rank_pipeline_candidates(candidates_by_branch, seed_papers, options):
    excluded_dois = {normalize_doi(d).lower() for d in (options.get('excludeDois') or []) if d}
    excluded_titles = {title_key(t) for t in (options.get('excludeTitles') or [])}
    excluded_dois |= {normalize_doi(p.get('doi')).lower() for p in seed_papers if p.get('doi')}
    excluded_titles |= {title_key(p.get('title')) for p in seed_papers if p.get('title')}
    candidates = []
    for branch, rows in candidates_by_branch.items():
        for rank, item in enumerate(rows,1):
            doi, title = normalize_doi(item.get('doi')).lower(), title_key(item.get('title'))
            if not (doi or title) or doi in excluded_dois or title in excluded_titles: continue
            if any(contains_phrase(text_for_paper(item),term) for term in options.get('strictExcludeKeywords') or []): continue
            record = copy.deepcopy(item)
            record['branches'] = [branch]
            record['sourceList'] = record.get('sourceList') or [record.get('source') or record.get('metadataSource') or branch]
            record.setdefault('retrievalEvidence',[{'channel':branch, 'provider':record['sourceList'][0], 'rank':rank}])
            candidates.append(record)
    records = merge_search_records(candidates)
    if not records: return []
    queries = ([options['researchQuestion']] if options.get('researchQuestion') else []) + [text_for_paper(p) for p in seed_papers]
    if options.get('steerKeywords'): queries.append(' '.join(options['steerKeywords']))
    relevance = bm25_scores(records,queries,focus_first=bool(options.get('researchQuestion')))
    # RRF votes belong to distinct retrieval channels, not to duplicated indexes.
    raw_rrf = []
    for record in records:
        channels = {}
        for evidence in record.get('retrievalEvidence') or []:
            rank = max(1,int(evidence.get('rank') or 1))
            channel = evidence.get('channel') or 'concepts'
            channels[channel] = min(rank,channels.get(channel,rank))
        raw_rrf.append(sum(1/(60+rank) for rank in channels.values()))
    peak_rrf = max(raw_rrf) or 1
    semantic = None
    if options.get('_semanticReranker'):
        indices = sorted(range(len(records)),key=lambda i:.7*relevance[i]+.3*raw_rrf[i]/peak_rrf,reverse=True)[:500]
        records, relevance, raw_rrf = ([records[i] for i in indices],[relevance[i] for i in indices],[raw_rrf[i] for i in indices])
        semantic, options['_rankingNotice'] = options['_semanticReranker'](queries, records)
    else:
        options['_rankingNotice'] = 'Titles and abstracts ranked by text and citation evidence'
    today = datetime.date.today().year
    impacts = []
    for record in records:
        count = record.get('citationCount',record.get('citedByCount'))
        year = str(record.get('year') or '')[:4]
        age = max(1,today-int(year)+1) if year.isdigit() else None
        impacts.append(math.log1p(max(0,count)/age) if isinstance(count,(int,float)) and age else None)
    for i,record in enumerate(records):
        text = text_for_paper(record)
        graph = max(float(record.get('networkSimilarity') or 0), 1/max(1,int(record.get('hop') or 1)) if 'citationGraph' in record['branches'] else 0)
        graph = min(1,graph)
        fusion = raw_rrf[i]/peak_rrf
        sem = semantic[i] if semantic is not None else None
        score = (.45*sem+.30*relevance[i]+.15*fusion+.10*graph) if sem is not None else (.62*relevance[i]+.26*fusion+.12*graph)
        preferred = sum(contains_phrase(text,term) for term in options.get('steerKeywords') or [])
        avoided = sum(contains_phrase(text,term) for term in options.get('excludeKeywords') or [])
        score += min(.08,.03*preferred)-min(.30,.10*avoided)
        age = today-int(str(record['year'])[:4]) if str(record.get('year') or '')[:4].isdigit() else None
        recency = min(1,max(0,1-(age or 0)/12)) if age is not None else 0
        # Impact is an optional within-pool percentile of citations/year. Only
        # compare the same field when enough records expose an actual field.
        field = record.get('field')
        cohort = [value for p,value in zip(records,impacts) if value is not None and (not field or p.get('field')==field)]
        if len(cohort)<3: cohort = [value for value in impacts if value is not None]
        impact = sum(value<impacts[i] for value in cohort)/len(cohort) if impacts[i] is not None and len(cohort)>=3 else 0
        score += .06*min(2,float(options.get('impactTilt') or 0))*impact*max(relevance[i],sem or 0)
        score += .05*min(2,float(options.get('recencyTilt') or 0))*recency*max(relevance[i],sem or 0)
        record['score'] = round(100*max(0,min(1,score)),3)
        record['scoreBreakdown'] = {'text':round(relevance[i],3),'fusion':round(fusion,3),'semantic':round(sem,3) if sem is not None else None,
            'citationEvidence':round(graph,3),'optionalImpact':round(impact,3),'softAvoids':avoided}
        record['branchHits'] = {b:True for b in record['branches']}
        if any(b in record['branches'] for b in ('core','europePmc')): record['branchHits']['lexicalConceptual']=True
        explanations = []
        if sem is not None and sem>=.4: explanations.append('Related meaning in title and abstract')
        if relevance[i]>=.35: explanations.append('Matches your research question or seed topics')
        if graph: explanations.append('Connected through citations' if 'citationGraph' in record['branches'] else 'Normalised shared-reference evidence')
        if raw_rrf[i]: explanations.append('Provider ranks combined across distinct searches')
        if avoided: explanations.append('Lower priority: matches an avoided keyword')
        record['matchReasons'] = explanations
        record['matchLabel'] = 'Strong match' if record['score']>=65 else 'Related' if record['score']>=40 else 'Explore'
        record['branches'] = sorted(record['branches'])
    records = _versions(records)
    records.sort(key=lambda p:(-p['score'],title_key(p.get('title')),p.get('doi') or ''))
    if options.get('diversify',True):
        # MMR within a bounded leading window keeps relevance primary while
        # preventing one vocabulary cluster from monopolising the first screen.
        remaining, selected = records[:80], []
        tokens = {id(p):set(terms(p.get('title'))+terms(p.get('abstract'))[:80]) for p in remaining}
        while remaining:
            def mmr(p):
                a=tokens[id(p)]
                duplicate=max((len(a&tokens[id(other)])/max(1,len(a|tokens[id(other)])) for other in selected[-20:]),default=0)
                return .90*p['score']/100-.10*duplicate
            best=max(remaining,key=mmr)
            selected.append(best);remaining.remove(best)
        records=selected+records[80:]
    for rank,record in enumerate(records,1): record['rank']=rank
    return records[:discovery_limit(options.get('limit'))]
