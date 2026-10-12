"""Explainable connectors across distinct selected seeds, without inferred fields."""
import itertools
import re
from pulse_core.discovery_queries import concept_groups
from pulse_core.discovery_matches import query_coverage
from pulse_core.discovery_feedback import paper_key


def distinct_seeds(seeds):
    return list({paper_key(p): p for p in seeds if paper_key(p)}.values())


def bridge_queries(seeds):
    seeds = distinct_seeds(seeds)[:8]
    queries = []
    for a, b in itertools.combinations(range(len(seeds)), 2):
        groups = []
        for seed in (seeds[a], seeds[b]):
            keys = seed.get('paperKeywords') or seed.get('keywords') or []
            if isinstance(keys, str): keys = re.split('[;,]', keys)
            concepts = concept_groups(seed.get('title') or '', keys)
            if concepts: groups.append(concepts[0])
        if len(groups) == 2 and groups[0] != groups[1]:
            queries.append({'id': f'bridge:{a}:{b}', 'text': ' '.join(g[0] for g in groups),
                            'groups': groups, 'kind': 'bridge', 'seedIndices': [a, b]})
        if len(queries) == 6: break
    return queries


def apply_bridges(records, seeds, options):
    seeds = distinct_seeds(seeds)
    if len(seeds) < 2: return
    for paper in records:
        connections = []
        for index, seed in enumerate(seeds):
            original_index = next(i for i, p in enumerate(options.get('_originalSeeds') or seeds) if paper_key(p) == paper_key(seed))
            coverage = query_coverage(paper, [seed])
            citation = [ev for ev in paper.get('retrievalEvidence', [])
                        if str(ev.get('channel', '')).startswith(f'citations:{original_index}:')]
            score = max(coverage, .7 if citation else 0)
            if score >= .35:
                connections.append({'seedKey': paper_key(seed), 'seedTitle': str(seed.get('title') or 'Seed paper'),
                                    'seedId': str(seed.get('id') or ''),
                                    'evidence': 'Citation link' if citation else 'Shared concepts in title or abstract',
                                    'coverage': round(coverage, 3), 'score': round(score, 3)})
        connections.sort(key=lambda row: -row['score'])
        paper['bridgeEvidence'] = connections
        paper['isBridge'] = len(connections) >= 2
        paper['bridgeScore'] = 0
        if paper['isBridge']:
            a, b = (row['score'] for row in connections[:2])
            paper['bridgeScore'] = round(2*a*b/(a+b), 3)
            titles = ' ↔ '.join(row['seedTitle'] for row in connections[:2])
            reason = {'kind': 'bridge', 'label': f'Connects {len(connections)} seeds', 'detail': titles}
            paper.setdefault('whyFound', []).insert(0, reason)
            paper.setdefault('matchReasons', []).insert(0, 'Connects selected seeds: ' + titles)
        if options.get('bridgeMode'):
            paper['score'] = round(.45*paper['score'] + 55*paper['bridgeScore'], 3)
            if paper.get('relevanceGrade') == 0: paper['score'] = 0
    options['_bridgeCount'] = sum(p.get('isBridge', False) for p in records)
