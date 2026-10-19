"""Transparent hybrid retrieval, neural reranking and diversity selection."""
import collections
import bisect
import copy
import datetime
import math
import re
import time
from pulse_core.doi_utils import normalize_doi
from pulse_core.discovery_queries import terms, text_for_paper
from pulse_core.metadata_resolution import similarity
from pulse_core.search_merge import merge_search_records, title_key, known_count
from pulse_core.search_limits import discovery_limit, MAX_CANDIDATE_POOL, SearchResults
from pulse_core.discovery_feedback import paper_key, contrastive_profile, feedback_adjustment
from pulse_core.ranking_evidence import dbef_quality, apply_network_assessments, graph_evidence
from pulse_core.publication_records import fold_explicit_versions
from pulse_core.discovery_matches import query_coverage, match_evidence, match_label, fit_calibration, independent_channel_count

SEMANTIC_SHORTLIST_LIMIT = 96
PAIRWISE_SHORTLIST_LIMIT = 48


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


def foundational_support(record, relevance):
    """Bounded total-citation support for relevant, citation-linked older work.

    Velocity favours currently active work. Total citations complement it only
    for work supported by an actual seed/reference relationship and topic text.
    """
    count = known_count(record)
    if count is None or count < 50 or relevance < .2:
        return 0.0
    paths = record.get('retrievalEvidence') or []
    supported = any(str(ev.get('channel') or '').startswith('citations:') and
                    str(ev.get('channel') or '').endswith(':backward') or
                    'Co-citation' in str(ev.get('subType') or '') or
                    'Bibliographic coupling' in str(ev.get('subType') or '') for ev in paths)
    if not supported:
        return 0.0
    return min(1.0, math.log1p(count) / math.log1p(5000)) * relevance


def direct_citation_seeds(record):
    seeds = set()
    for ev in record.get('retrievalEvidence') or []:
        ch = str(ev.get('channel') or '')
        if ch.startswith('citations:'):
            parts = ch.split(':')
            if len(parts) >= 2 and parts[1].isdigit():
                seeds.add(int(parts[1]))
            else:
                seeds.add(0)
    return seeds


def build_citation_link_context(records, seed_papers, options):
    enabled = options.get('citationLinkBonus', True)
    if enabled is False:
        return {'enabled': False}
    weight = float(enabled) if isinstance(enabled, (int, float)) and not isinstance(enabled, bool) else float(options.get('citationLinkWeight', 0.2))
    gate = options.get('citationLinkGate', 0.3)
    gate = float(gate) if gate is not None and gate is not False else None
    mode = str(options.get('citationLinkMode') or 'velocity').lower()

    today = datetime.date.today().year
    def calc_velocity(r):
        c = known_count(r)
        if c is None: return None
        c = max(0, c)
        if mode == 'velocity':
            y = str(r.get('year') or '')[:4]
            age = max(1, today - int(y) + 1) if y.isdigit() and int(y) <= today else 1
            return math.log1p(c / age)
        return math.log1p(c)

    seed_cohorts = collections.defaultdict(list)
    for r in records:
        v = calc_velocity(r)
        if v is None: continue
        d_seeds = direct_citation_seeds(r)
        for s in d_seeds:
            seed_cohorts[s].append(v)

    for s in seed_cohorts:
        seed_cohorts[s].sort()

    return {
        'enabled': True,
        'weight': weight,
        'gate': gate,
        'mode': mode,
        'seed_cohorts': dict(seed_cohorts),
        'calc_velocity': calc_velocity,
    }


def citation_link_bonus(record, pool_context, topic=0.0):
    if not pool_context or not pool_context.get('enabled'):
        return 0.0
    c = known_count(record)
    if c is None:
        return 0.0
    d_seeds = direct_citation_seeds(record)
    if not d_seeds:
        return 0.0
    v = pool_context['calc_velocity'](record)
    if v is None:
        return 0.0
    seed_cohorts = pool_context.get('seed_cohorts') or {}
    pcts = []
    for s in d_seeds:
        cohort = seed_cohorts.get(s)
        if cohort:
            p = sum(x <= v for x in cohort) / len(cohort)
            pcts.append(p)
    if not pcts:
        return 0.0
    P = max(pcts)
    gate = pool_context.get('gate')
    if gate is None or gate <= 0:
        g = 1.0
    else:
        topic_val = max(0.0, float(topic or 0.0))
        g = 1.0 if topic_val >= gate else (topic_val / gate)
    return pool_context['weight'] * P * g



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


# DOI registrants that host copies of papers published elsewhere (repositories,
# preprint servers, data archives). A copy folds into the publisher's record.
def _surname(name):
    """Family name from "Abdi Elmi", "Elmi, Abdi", "A. Elmi" or "Elmi A"."""
    name = re.sub(r'\(.*?\)|\[.*?\]|\d+', ' ', str(name or ''))
    if ',' in name:
        words = title_key(name.split(',')[0]).split()
        return words[-1] if words else ''
    words = title_key(name).split()
    if len(words) > 1 and len(words[-1]) <= 2:
        return words[0]
    return words[-1] if words else ''


def _plain_reason(text):
    text = re.sub(r'^(?:Co-citation triangulation|Bibliographic coupling):\s*', '', str(text or '')).strip()
    text = text.replace('with seed paper', 'with your seed paper').replace('as seed paper', 'as your seed paper')
    return text[:1].upper() + text[1:] if text else ''


def why_found(record, seed_papers, options, relevance=0.0):
    """Plain-language evidence for one result, strongest kinds first."""
    why = []
    evidence = record.get('retrievalEvidence') or []
    channels = [str(ev.get('channel') or '') for ev in evidence]
    seed_word = 'your seed paper' if len(seed_papers) <= 1 else 'one of your seed papers'
    seen_traj_roles = set()
    for ev in evidence:
        ch = str(ev.get('channel') or '')
        if not ch.startswith('author:'):
            continue
        role = ev.get('authorRole') or ('last' if ch.endswith(':last') else 'first' if ch.endswith(':first') else '')
        if role not in ('first', 'last') or role in seen_traj_roles:
            continue
        seen_traj_roles.add(role)
        author_name = str(ev.get('authorName') or record.get('authorTrajectoryName') or '').strip()
        if role == 'last':
            detail = f'Recent work by {seed_word}’s senior author ({author_name})' if author_name else f'Recent work by {seed_word}’s senior author'
            why.append({'kind': 'senior-author', 'label': 'Same senior author', 'detail': detail})
        else:
            detail = f'Recent work by {seed_word}’s first author ({author_name})' if author_name else f'Recent work by {seed_word}’s first author'
            why.append({'kind': 'first-author', 'label': 'Same first author', 'detail': detail})
    if not seen_traj_roles and record.get('authorRole') in ('first', 'last'):
        role = record['authorRole']
        author_name = str(record.get('authorTrajectoryName') or '').strip()
        if role == 'last':
            detail = f'Recent work by {seed_word}’s senior author ({author_name})' if author_name else f'Recent work by {seed_word}’s senior author'
            why.append({'kind': 'senior-author', 'label': 'Same senior author', 'detail': detail})
        else:
            detail = f'Recent work by {seed_word}’s first author ({author_name})' if author_name else f'Recent work by {seed_word}’s first author'
            why.append({'kind': 'first-author', 'label': 'Same first author', 'detail': detail})
    seed_names = {}
    for seed in seed_papers:
        for name in seed.get('authors') or []:
            key = _surname(name)
            if len(key) > 2:
                seed_names.setdefault(key, key.title())
    shared = []
    for name in record.get('authors') or []:
        label = seed_names.get(_surname(name))
        if label and label not in shared:
            shared.append(label)
    if shared:
        names = ', '.join(shared[:5]) + (f' +{len(shared) - 5}' if len(shared) > 5 else '')
        why.append({'kind': 'authors', 'label': f"Shares {len(shared)} author{'s' if len(shared) != 1 else ''}",
                    'detail': f'Shares authors with your seed: {names}'})
    if any(channel.startswith('citations:') and channel.endswith(':backward') for channel in channels):
        why.append({'kind': 'cited-by-seed', 'label': 'Cited by your seed', 'detail': f'{seed_word[0].upper()}{seed_word[1:]} cites this paper'})
    if any(channel.startswith('citations:') and channel.endswith(':forward') for channel in channels):
        why.append({'kind': 'cites-seed', 'label': 'Cites your seed', 'detail': f'This paper cites {seed_word}'})
    intents = [str(x).strip() for x in (record.get('citationIntents') or []) if str(x).strip()]
    contexts = [str(x).strip() for x in (record.get('citationContexts') or []) if str(x).strip()]
    is_inf = bool(record.get('isInfluentialCitation'))
    if is_inf or intents or contexts:
        badge_parts = (['Influential'] if is_inf else []) + [i for i in intents if i not in ('Influential',)]
        label = f"{badge_parts[0]} citation" if badge_parts else 'Citation context'
        detail = f"How it cites your seed ({', '.join(badge_parts)})" if badge_parts else 'Includes verbatim citation context'
        why.append({'kind': 'cites-seed', 'label': label, 'detail': detail})
    if (record.get('scoreBreakdown') or {}).get('citationLinkBonus', 0) > 0:
        why.append({'kind': 'citation-link-bonus', 'label': 'Widely cited direct link', 'detail': 'Directly linked to your seed and widely cited'})
    def evidence_of(kind):
        found = next((ev for ev in evidence if kind in str(ev.get('subType') or '')), None)
        return found or (record if kind in str(record.get('subType') or '') else None)
    chase = evidence_of('Chase')
    if chase:
        via = str(chase.get('via') or record.get('chaseViaTitle') or '')
        why.append({'kind': 'two-steps', 'label': 'Two citation steps away',
                    'detail': f'Linked to your seed through "{via[:90]}"' if via else 'Linked to your seed through an intermediate paper'})
    co = evidence_of('Co-citation')
    if co:
        why.append({'kind': 'co-cited', 'label': 'Often cited with your seed',
                    'detail': _plain_reason(co.get('detail') or record.get('reason')) or 'Cited together with your seed paper by other papers'})
    coupled = evidence_of('Bibliographic coupling')
    if coupled:
        why.append({'kind': 'shared-references', 'label': 'Shares references',
                    'detail': _plain_reason(coupled.get('detail') or record.get('reason')) or 'Shares references with your seed paper'})
    seed_terms, seen = [], set()
    for seed in seed_papers:
        for term in list(seed.get('paperKeywords') or []) + list(options.get('steerKeywords') or []):
            key = str(term).casefold().strip()
            if len(key) > 3 and key not in seen:
                seen.add(key)
                seed_terms.append(str(term).strip())
    text = text_for_paper(record)
    matched = [term for term in seed_terms if contains_phrase(text, term)][:3]
    if matched:
        why.append({'kind': 'topic', 'label': matched[0], 'detail': 'Matches your topic: ' + ', '.join(matched)})
    if options.get('researchQuestion') and relevance >= .35:
        why.append({'kind': 'question', 'label': 'Matches your question', 'detail': 'Title and abstract match your research question'})
    if not any(item['kind'] not in ('topic', 'question') for item in why):
        providers = [str(name) for name in record.get('sourceList') or [] if name] or ['the search indexes']
        semantic = 'semanticSearch' in (record.get('branches') or [])
        why.append({'kind': 'search', 'label': 'Similar text' if semantic else 'Topic search',
                    'detail': ('Similar wording found by semantic search' if semantic else 'Found by topic search') + ' in ' + ', '.join(dict.fromkeys(providers))})
    return why


REPOSITORY_DOI_PREFIXES = ('10.5281/', '10.6084/', '10.17863/', '10.25418/', '10.22541/', '10.21203/',
    '10.1101/', '10.48550/', '10.20944/', '10.2139/', '10.31219/', '10.17605/', '10.31234/', '10.36227/',
    '10.32942/', '10.5167/', '10.26434/', '10.7287/', '10.35542/', '10.18452/', '10.15488/')


def _versions(records):
    records=fold_explicit_versions(records)
    groups = []
    def family(name):
        # "Surname, Given", "Given Surname" and "Surname AB" all yield the surname;
        # parenthesised IDs and ORCIDs from repositories are ignored.
        name = re.sub(r'\(.*?\)|\[.*?\]|\d+', ' ', str(name))
        words = title_key(name.split(',')[0]).split()
        if not words: return ''
        if ',' in name: return words[-1]
        return words[0] if len(words) > 1 and len(words[-1]) <= 2 else words[-1]
    def preprint(p): return bool(re.search(r'preprint|posted-content|working.?paper', str(p.get('documentType') or p.get('publicationType') or p.get('type') or ''), re.I))
    def copy_record(p):
        doi = str(p.get('doi') or '').lower()
        return preprint(p) or not doi or doi.startswith(REPOSITORY_DOI_PREFIXES)
    gram_index, descriptions = collections.defaultdict(set), []
    author_index,title_index=collections.defaultdict(set),collections.defaultdict(set)
    unknown_authors,copy_indices=set(),set()
    def describe(record):
        key = title_key(record.get('title'))
        grams = {key[i:i+3] for i in range(max(1,len(key)-2))}
        authors = {family(a) for a in record.get('authors') or [] if family(a)}
        return key, grams, authors, str(record.get('year') or '')[:4], copy_record(record)
    for record in records:
        group = None
        key, grams, authors_a, year_a, is_copy = describe(record)
        # Near-identical titles share character trigrams. Block expensive fuzzy
        # comparisons by overlap; adding unrelated papers no longer costs O(n²).
        eligible=set().union(*(author_index[author] for author in authors_a))|unknown_authors if authors_a else set(range(len(groups)))
        fuzzy=eligible if is_copy else eligible&copy_indices
        # Published/published matching requires an exact title. Fuzzy matching
        # needs compatible authors and a copy; common title trigrams never scan
        # the entire candidate pool when those identities already disagree.
        possible=set(title_index.get(key,()))
        if fuzzy:
            rare=sorted(grams,key=lambda gram:len(gram_index.get(gram,())))[:8]
            nominated=set().union(*(gram_index.get(gram,set())&fuzzy for gram in rare))
            counts={index:len(grams&descriptions[index][1]) for index in nominated}
            possible.update(index for index,count in counts.items() if count>=.65*min(len(grams),len(descriptions[index][1])))
        for index in sorted(possible):
            candidate = groups[index]
            if record.get('publicationRole')=='notice' or candidate.get('publicationRole')=='notice':continue
            key_b, _, authors_b, year_b, candidate_copy = descriptions[index]
            both_listed = bool(authors_a and authors_b)
            same_authors = both_listed and len(authors_a & authors_b)/min(len(authors_a),len(authors_b))>=.75
            shared_author = bool(authors_a & authors_b)
            words = len(key.split())
            gap = abs(int(year_a)-int(year_b)) if year_a.isdigit() and year_b.isdigit() else None
            if is_copy or candidate_copy:
                title = similarity(record.get('title'),candidate.get('title'))
                same = (title>=.96 and (gap is None or gap<=3)
                        and (same_authors or (words>=6 and (shared_author or not both_listed))))
            else:
                same = (key==key_b and words>=8 and gap is not None and gap<=1 and shared_author)
            if same:
                group = candidate; break
        if group is None:
            index = len(groups)
            groups.append(record); descriptions.append((key,grams,authors_a,year_a,is_copy))
            for gram in grams: gram_index[gram].add(index)
            for author in authors_a:author_index[author].add(index)
            title_index[key].add(index)
            if not authors_a:unknown_authors.add(index)
            if is_copy:copy_indices.add(index)
            continue
        rank = lambda p: (not copy_record(p), bool(p.get('doi')), int(p.get('citationCount') or p.get('citedByCount') or 0))
        published = record if rank(record) > rank(group) else group
        other = group if published is record else record
        published['relatedVersions'] = (published.get('relatedVersions') or []) + [
            {key:other.get(key) for key in ('title','doi','url','year','documentType','sourceList')}]
        if other['score']>published['score']:
            for feature in ('scoreBreakdown','matchLabel','matchEvidenceScore','queryCoverage','matchMode','matchStrengthVersion'):
                if feature in other: published[feature] = other[feature]
        published['score'] = max(published['score'],other['score'])
        published['retrievalEvidence'] = (published.get('retrievalEvidence') or [])+(other.get('retrievalEvidence') or [])
        for traj_key in ('authorRole', 'authorTrajectoryLabel', 'authorTrajectoryName'):
            if not published.get(traj_key) and other.get(traj_key):
                published[traj_key] = other[traj_key]
        published['sourceList'] = sorted(set((published.get('sourceList') or [])+(other.get('sourceList') or [])))
        published['branches'] = sorted(set(published['branches']+other['branches']))
        published['branchHits']={**(published.get('branchHits') or {}),**(other.get('branchHits') or {})}
        published['matchReasons']=list(dict.fromkeys((published.get('matchReasons') or [])+(other.get('matchReasons') or [])))
        index = groups.index(group)
        groups[index] = published
        descriptions[index] = describe(published)
        for gram in descriptions[index][1]: gram_index[gram].add(index)
        for author in descriptions[index][2]:author_index[author].add(index)
        title_index[descriptions[index][0]].add(index)
        if descriptions[index][4]:copy_indices.add(index)
        else:copy_indices.discard(index)
    return groups


def balanced_indices(records, scores, size):
    """Keep quality first while reserving retrieval coverage across channels."""
    ordered = sorted(range(len(records)), key=lambda i: (-scores[i], title_key(records[i].get('title'))))
    if len(ordered) <= size: return ordered
    selected = ordered[:max(1, int(size*.65))]
    seen = set(selected)
    buckets = collections.defaultdict(list)
    for i in ordered:
        for branch in records[i].get('branches') or ['unknown']: buckets['source:'+branch].append(i)
        for evidence in records[i].get('retrievalEvidence') or []:
            channel = evidence.get('channel')
            if channel: buckets['channel:'+channel].append(i)
    cursors = {key: 0 for key in buckets}
    while len(selected) < size:
        added = False
        for key in sorted(buckets):
            bucket = buckets[key]
            while cursors[key] < len(bucket) and bucket[cursors[key]] in seen: cursors[key] += 1
            if cursors[key] < len(bucket):
                i = bucket[cursors[key]]; selected.append(i); seen.add(i); added = True
                if len(selected) == size: break
        if not added: break
    return selected


def merge_and_rank_pipeline_candidates(candidates_by_branch, seed_papers, options):
    from pulse_core.search_query import matches_search
    ranking_started = time.monotonic()
    timings = options['_rankingTimings'] = {'embeddingSeconds': 0, 'pairwiseSeconds': 0}
    options['_semanticCount'] = options['_pairwiseCount'] = 0
    options.pop('_calibrationApplied', None)
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
            record = dict(item)  # merge_search_records owns the deep copy.
            record['branches'] = [branch]
            record['sourceList'] = record.get('sourceList') or [record.get('source') or record.get('metadataSource') or branch]
            record.setdefault('retrievalEvidence',[{'channel':branch, 'provider':record['sourceList'][0], 'rank':rank}])
            # Evidence lists survive merging; carry each path's citation relation with it.
            record['retrievalEvidence'] = [dict(ev) for ev in record['retrievalEvidence']]
            for ev in record['retrievalEvidence']:
                if record.get('subType'): ev.setdefault('subType', record['subType'])
                if record.get('reason') and branch in ('citationNetwork', 'citationGraph'): ev.setdefault('detail', record['reason'])
                if record.get('chaseViaTitle'): ev.setdefault('via', record['chaseViaTitle'])
                if record.get('authorRole'): ev.setdefault('authorRole', record['authorRole'])
                if record.get('authorTrajectoryName'): ev.setdefault('authorName', record['authorTrajectoryName'])
            candidates.append(record)
    records = merge_search_records(candidates)
    if options.get('queryKeywords') or options.get('queryTags'):
        records = [paper for paper in records if matches_search(paper, options.get('queryKeywords') or [], options.get('queryTags') or [], options.get('queryMatch','all'))]
    if not records: return []
    for record in records:
        for ev in record.get('retrievalEvidence') or []:
            ch = str(ev.get('channel') or '')
            if ch.startswith('author:'):
                role = ev.get('authorRole') or ('last' if ch.endswith(':last') else 'first' if ch.endswith(':first') else '')
                if role in ('first', 'last'):
                    record.setdefault('authorRole', role)
                    record.setdefault('authorTrajectoryLabel', 'Same senior author' if role == 'last' else 'Same first author')
                    if ev.get('authorName'):
                        record.setdefault('authorTrajectoryName', ev['authorName'])
                    badge = record['authorTrajectoryLabel']
                    badges = list(record.get('discoveryBadges') or [])
                    if badge not in badges:
                        badges.insert(0, badge)
                        record['discoveryBadges'] = badges
    apply_network_assessments(records,candidates_by_branch)
    ext_ctx = options.get('_citationContexts') or {}
    if isinstance(ext_ctx, dict) and ext_ctx:
        from pulse_core.s2_client import normalize_citation_contexts, normalize_citation_intents
        for rec in records:
            for k in (
                str(rec.get('doi') or '').strip().lower(),
                str(rec.get('pmid') or '').strip(),
                str(rec.get('s2PaperId') or '').strip(),
                str(rec.get('openAlexId') or '').replace('https://openalex.org/', '').strip(),
            ):
                if k and k in ext_ctx and isinstance(ext_ctx[k], dict):
                    entry = ext_ctx[k]
                    ctxs = normalize_citation_contexts(entry.get('contexts'))
                    ints = normalize_citation_intents(entry.get('intents'))
                    if ctxs and not rec.get('citationContexts'):
                        rec['citationContexts'] = ctxs
                    if ints and not rec.get('citationIntents'):
                        rec['citationIntents'] = ints
                    if entry.get('isInfluential') is True:
                        rec['isInfluentialCitation'] = True
                    break
    queries = ([options['researchQuestion']] if options.get('researchQuestion') else []) + [text_for_paper(p) for p in seed_papers]
    if options.get('steerKeywords'): queries.append(' '.join(options['steerKeywords']))
    relevance = bm25_scores(records,queries,focus_first=bool(options.get('researchQuestion')))
    # RRF votes belong to distinct retrieval channels, not to duplicated indexes.
    raw_rrf, base_rrf = [], []
    qualities=[dbef_quality(record,options.get('dbefPolicy')) for record in records]
    graphs,options['_networkEvidence']=graph_evidence(records,qualities,options)
    for record in records:
        channels = {}
        for evidence in record.get('retrievalEvidence') or []:
            rank = max(1,int(evidence.get('rank') or 1))
            channel = evidence.get('channel') or 'concepts'
            channels[channel] = min(rank,channels.get(channel,rank))
        base_rrf.append(sum(1/(60+rank) for rank in channels.values()))
        raw_rrf.append(sum((qualities[len(raw_rrf)] if channel=='dbef' or channel.startswith('dbef:') else 1)/(60+rank) for channel,rank in channels.items()))
    peak_rrf = max(base_rrf) or 1
    rejected = {paper_key(row['paper']) for row in options.get('relevanceFeedback') or [] if row['grade'] == 0}
    pool_context = build_citation_link_context(records, seed_papers, options)
    prelim = []
    for i in range(len(records)):
        rec = records[i]
        rel = relevance[i]
        is_rej = paper_key(rec) in rejected
        fp = (.06 * foundational_support(rec, rel)
              if options.get('foundationalPrior', True) and not is_rej else 0.0)
        cb = citation_link_bonus(rec, pool_context, topic=rel) if not is_rej else 0.0
        comb_prior = min(cb + fp, max(cb, fp) + 0.03) if cb > 0 and fp > 0 else (cb + fp)
        p_val = ((.7 * rel + .3 * raw_rrf[i] / peak_rrf) / (.88 if graphs[i]['renormalize'] else 1) +
                 (.12 * graphs[i]['prelim']) + comb_prior)
        prelim.append(p_val)
    indices = balanced_indices(records, prelim, MAX_CANDIDATE_POOL)
    records, relevance, raw_rrf, prelim, qualities = ([records[i] for i in indices], [relevance[i] for i in indices], [raw_rrf[i] for i in indices], [prelim[i] for i in indices], [qualities[i] for i in indices])
    graphs=[graphs[i] for i in indices]
    options['_candidateCount'] = len(records)
    if options.get('_shortlistProbe'):
        # Background pre-computation fills caches for exactly the papers the
        # foreground would assess. The pairwise set is a superset because the
        # foreground order also depends on semantic scores not yet known.
        probe_semantic = balanced_indices(records, prelim, SEMANTIC_SHORTLIST_LIMIT)
        probe_pairwise = balanced_indices(records, prelim, PAIRWISE_SHORTLIST_LIMIT + 16)
        options['_shortlistProbe']([records[i] for i in probe_semantic], [records[i] for i in probe_pairwise])
    semantic, pairwise = {}, {}
    options['_rankingNotice'] = 'Titles and abstracts ranked by text and citation evidence'
    if options.get('_semanticReranker'):
        indices = balanced_indices(records, prelim, SEMANTIC_SHORTLIST_LIMIT)
        started = time.monotonic()
        values, options['_rankingNotice'] = options['_semanticReranker'](queries, [records[i] for i in indices])
        timings['embeddingSeconds'] = round(time.monotonic()-started, 3)
        options['_semanticCount'] = len(indices) if values is not None else 0
        if values is not None: semantic = dict(zip(indices, values))
    if options.get('_pairwiseReranker'):
        indices = balanced_indices(records, [.7*prelim[i]+.3*semantic.get(i,0) for i in range(len(records))], PAIRWISE_SHORTLIST_LIMIT)
        pair_queries = [options['researchQuestion']] if options.get('researchQuestion') else [str(p.get('title') or '')+' '+' '.join(p.get('paperKeywords') or []) for p in seed_papers[:2]]
        started = time.monotonic()
        values, notice = options['_pairwiseReranker'](pair_queries, [records[i] for i in indices])
        timings['pairwiseSeconds'] = round(time.monotonic()-started, 3)
        options['_pairwiseCount'] = len(indices) if values is not None else 0
        options['_pairwiseNotice'] = notice
        if values is not None:
            pairwise = dict(zip(indices, values)); options['_rankingNotice'] = notice
        else: options['_rankingNotice'] = notice
    feedback = options.get('relevanceFeedback') or []
    grades = {paper_key(row['paper']): row['grade'] for row in feedback}
    feedback_profile=contrastive_profile(feedback)
    options['_feedbackConcepts']={key:feedback_profile[key] for key in ('prefer','avoid','paired')}

    today = datetime.date.today().year
    impacts = []
    for record in records:
        count = known_count(record)
        year = str(record.get('year') or '')[:4]
        age = max(1,today-int(year)+1) if year.isdigit() and int(year) <= today else None
        impacts.append(math.log1p(max(0,count)/age) if count is not None and age else None)
    all_impacts=sorted(value for value in impacts if value is not None)
    field_impacts=collections.defaultdict(list)
    for record,value in zip(records,impacts):
        if value is not None and record.get('field'):field_impacts[record['field']].append(value)
    for values in field_impacts.values():values.sort()
    for i,record in enumerate(records):
        text = text_for_paper(record)
        graph = graphs[i]['value']
        fusion = raw_rrf[i]/peak_rrf
        sem, pair = semantic.get(i), pairwise.get(i)
        # A bounded neural bonus is comparable with unscored candidates. The
        # candidate pool is retained even when a local model fails or times out.
        score = .62*relevance[i]+.26*fusion+.12*graph
        if graphs[i]['renormalize']:score/=.88
        if sem is not None: score = .8*score+.2*sem
        if pair is not None: score = .45*score+.55*pair
        grade = grades.get(paper_key(record))
        adjustment = .18 if grade is not None and grade > 0 else -.55 if grade == 0 else 0
        if grade is None:
            adjustment,evidence=feedback_adjustment(record,feedback_profile,(options.get('_feedbackSemantic') or {}).get(paper_key(record))) if feedback else (0,None)
            if evidence:record['feedbackEvidence']=evidence
        score += adjustment
        preferred = sum(contains_phrase(text,term) for term in options.get('steerKeywords') or [])
        avoided = sum(contains_phrase(text,term) for term in options.get('excludeKeywords') or [])
        score += min(.08,.03*preferred)-min(.30,.10*avoided)
        age = today-int(str(record['year'])[:4]) if str(record.get('year') or '')[:4].isdigit() else None
        recency = min(1,max(0,1-(age or 0)/12)) if age is not None else 0
        # Age-adjusted velocity is a within-pool percentile of citations/year. Only
        # compare the same field when enough records expose an actual field.
        field = record.get('field')
        cohort=field_impacts.get(field,all_impacts) if field else all_impacts
        if len(cohort)<3:cohort=all_impacts
        impact = bisect.bisect_left(cohort,impacts[i])/len(cohort) if impacts[i] is not None and len(cohort)>=3 else 0
        topic_support = max(relevance[i], sem or 0)
        velocity_prior = .09*impact*topic_support if options.get('citationVelocityPrior', True) and grade != 0 and not record.get('dbef') else 0
        score += velocity_prior
        foundation_prior = .06*foundational_support(record, topic_support) if options.get('foundationalPrior', True) and grade != 0 else 0
        cit_bonus = citation_link_bonus(record, pool_context, topic_support) if grade != 0 else 0.0
        if cit_bonus > 0 and foundation_prior > 0:
            score += min(cit_bonus + foundation_prior, max(cit_bonus, foundation_prior) + 0.03)
        else:
            score += cit_bonus + foundation_prior
        ctx_bonus = 0.0
        if options.get('citationContextSignal', True) and grade != 0:
            intents_low = {str(x).strip().lower() for x in (record.get('citationIntents') or [])}
            if record.get('isInfluentialCitation') is True:
                ctx_bonus += 0.025
            if 'methodology' in intents_low or 'result' in intents_low:
                ctx_bonus += 0.020
            elif 'background' in intents_low:
                ctx_bonus += 0.010
            if record.get('citationContexts'):
                ctx_bonus += 0.010
            ctx_bonus = min(0.045, ctx_bonus) * max(0.25, topic_support)
            score += ctx_bonus
        score += .06*min(2,float(options.get('impactTilt') or 0))*impact*topic_support
        score += .05*min(2,float(options.get('recencyTilt') or 0))*recency*max(relevance[i],sem or 0)
        unadjusted_score = score - adjustment
        if grade == 0:
            unadjusted_vel = .09*impact*topic_support if options.get('citationVelocityPrior', True) and not record.get('dbef') else 0
            unadjusted_fnd = .06*foundational_support(record, topic_support) if options.get('foundationalPrior', True) else 0
            unadjusted_cit = citation_link_bonus(record, pool_context, topic_support)
            unadjusted_comb = min(unadjusted_cit + unadjusted_fnd, max(unadjusted_cit, unadjusted_fnd) + 0.03) if (unadjusted_cit > 0 and unadjusted_fnd > 0) else (unadjusted_cit + unadjusted_fnd)
            unadjusted_score += unadjusted_vel + unadjusted_comb
        record['score'] = round(100*max(0,min(1,score)),3)
        record['scoreBreakdown'] = {'text':round(relevance[i],3),'fusion':round(fusion,3),'semantic':round(sem,3) if sem is not None else None,
            'dbef':record.get('dbef'),'dbefEvidenceQuality':qualities[i] if record.get('dbef') else None,'citationEvidence':round(graph,3),
            'networkStatus':record['networkStatus'],'graphImputed':graphs[i]['imputed'],'graphRenormalized':graphs[i]['renormalize'],
            'preliminaryScore':round(prelim[i],6),'preFeedbackScore':round(unadjusted_score,6),
            'optionalImpact':round(impact,3),'citationVelocityPrior':round(velocity_prior,4),'foundationalPrior':round(foundation_prior,4),
            'citationLinkBonus':round(cit_bonus,4),'citationContextBonus':round(ctx_bonus,4),'softAvoids':avoided,'pairwise':round(pair,3) if pair is not None else None,'feedback':round(adjustment,3)}
        record['branchHits'] = {b:True for b in record['branches']}
        if any(b in record['branches'] for b in ('core','europePmc','fullText')): record['branchHits']['lexicalConceptual']=True
        explanations = []
        if sem is not None and sem>=.4: explanations.append('Related meaning in title and abstract')
        if relevance[i]>=.35: explanations.append('Matches your research question or seed topics')
        if graph and not graphs[i]['imputed']: explanations.append('Connected through citations' if 'citationGraph' in record['branches'] else 'Normalised shared-reference evidence')
        record['whyFound'] = why_found(record, seed_papers, options, relevance[i])
        if grade is None and adjustment and record.get('feedbackEvidence'):
            direction='preferred' if adjustment>0 else 'rejected'
            concepts=record['feedbackEvidence']['positiveConcepts' if adjustment>0 else 'negativeConcepts']
            record['whyFound'].insert(0,{'kind':'feedback','label':'Your relevance feedback',
                'detail':f'Matches concepts from papers you {direction} for this question'+(': '+', '.join(concepts[:2]) if concepts else '')})
        if record.get('matchedPassages'):
            record['whyFound'].insert(0, {'kind':'fulltext','label':'Full-text passage','detail':'Matched '+record['matchedPassages'][0].get('section','article text')+' in '+str(record.get('source') or 'the local full-text library')})
        if record['whyFound']: explanations = [item['detail'] for item in record['whyFound']]
        if avoided: explanations.append('Lower priority: matches an avoided keyword')
        record['matchReasons'] = explanations
        coverage = query_coverage(record, seed_papers, options.get('researchQuestion') or '')
        evidence = match_evidence(coverage, sem, pair)
        record['matchEvidenceScore'] = evidence
        record['queryCoverage'] = round(coverage, 4)
        mode = 'pairwise' if pair is not None else 'semantic' if sem is not None else 'text'
        profile = options.get('_matchCalibration') or {}
        if profile.get('version') != 'evidence-v1' or profile.get('mode') != mode: profile = None
        record['matchMode'] = mode
        record['matchLabel'] = match_label(evidence, profile, grade)
        record['matchStrengthVersion'] = 'evidence-v6-citation-bonus'
        if grade is not None:
            record['relevanceGrade'] = grade
            record['matchReasons'].insert(0, 'Marked relevant for this question' if grade > 0 else 'Marked not relevant for this question')
        record['branches'] = sorted(record['branches'])
    # Empirical thresholds need both explicit classes and an independent held-
    # out check. Do not calibrate on unjudged papers or mix different model modes.
    for mode in ('text','semantic','pairwise'):
        samples = [{'id':paper_key(p),'grade':p['relevanceGrade'],'evidence':p['matchEvidenceScore']} for p in records if p.get('matchMode')==mode and p.get('relevanceGrade') is not None]
        profile = fit_calibration(samples)
        if profile:
            profile['mode'] = mode
            options.setdefault('_calibrationApplied',{})[mode] = profile
            for p in records:
                if p.get('matchMode') == mode: p['matchLabel'] = match_label(p['matchEvidenceScore'], profile, p.get('relevanceGrade'))
    records = _versions(records)
    if options.get('bridgeMode'):
        from pulse_core.discovery_bridges import apply_bridges
        apply_bridges(records,seed_papers,options)
    if options.get('_aiTriage'):
        options['_aiReviewedCount'] = options['_aiTriage'](sorted(records,key=lambda p:-p['score']))
        for record in records:
            if record.get('aiReview'):
                decision = record['aiReview'].get('decision')
                if decision in ('relevant', 'not_relevant'):
                    if 'scoreBreakdown' in record:
                        record['scoreBreakdown']['aiReview'] = 16 if decision == 'relevant' else -28
                    if decision == 'relevant' and 'AI review: confirmed relevant' not in record.get('matchReasons', []):
                        record.setdefault('matchReasons', []).insert(0, 'AI review: confirmed relevant to your question')
                    elif decision == 'not_relevant' and 'AI review: deemed not relevant' not in record.get('matchReasons', []):
                        record.setdefault('matchReasons', []).append('AI review: deemed not relevant to your question')
    for record in records:
        if record.get('relatedVersions'):
            # Folded copies may add evidence (another citation path, another index).
            record['whyFound'] = why_found(record, seed_papers, options, (record.get('scoreBreakdown') or {}).get('text') or 0)
            record['matchReasons'] = [item['detail'] for item in record['whyFound']] or record.get('matchReasons') or []
    records.sort(key=lambda p:(-p['score'],title_key(p.get('title')),p.get('doi') or ''))
    # Many unrelated works share generic titles ("Protein structure prediction").
    # Keep the best-ranked one in place and move repeats to the end, so they
    # cannot crowd out specific results but remain available.
    seen_generic, kept, repeats = set(), [], []
    for record in records:
        key = title_key(record.get('title'))
        if key and len(key.split()) <= 5:
            if key in seen_generic:
                repeats.append(record); continue
            seen_generic.add(key)
        kept.append(record)
    records = kept + repeats
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
    visible_size = min(len(records), discovery_limit(options.get('limit')))
    for rank,record in enumerate(records,1):
        record['rank'] = rank
        channels = independent_channel_count(record)
        record['independentChannelCount'] = channels
        record['matchPoolSize'] = len(records)
        record['matchDisplaySize'] = visible_size
        profile = (options.get('_calibrationApplied') or {}).get(record['matchMode']) or options.get('_matchCalibration') or {}
        if profile.get('version') != 'evidence-v1' or profile.get('mode') != record['matchMode']: profile = None
        context = dict(pool_rank=rank, pool_size=len(records), channel_count=channels, visible_size=visible_size)
        record['strongMatchEligible'] = (record.get('relevanceGrade') != 0 and
            match_label(record['matchEvidenceScore'], profile, **context) == 'Strong match')
        record['matchLabel'] = match_label(record['matchEvidenceScore'], profile, record.get('relevanceGrade'), **context)
    timings['rankingSeconds'] = round(time.monotonic()-ranking_started, 3)
    return records[:discovery_limit(options.get('limit'))]
