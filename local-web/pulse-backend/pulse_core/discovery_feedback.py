"""Explicit, question-scoped relevance feedback; no global model training."""
from pulse_core.doi_utils import normalize_doi
from pulse_core.search_merge import title_key
import collections
import math
import re


def paper_key(paper):
    return normalize_doi(paper.get('doi')).lower() or str(paper.get('s2PaperId') or '') or title_key(paper.get('title'))


def feedback_for_context(payload, seeds):
    context = payload.get('feedbackContext') or {}
    question = str(payload.get('researchQuestion') or '').strip()
    if str(context.get('researchQuestion') or '').strip() != question:
        return []
    expected = sorted(filter(None, (paper_key(p) for p in seeds)))
    supplied = sorted(filter(None, (paper_key(p) for p in context.get('seedPapers') or [] if isinstance(p, dict))))
    if expected != supplied:
        return []
    rows, seen = [], set()
    for row in reversed((payload.get('relevanceFeedback') or [])[-100:]):
        if not isinstance(row, dict) or row.get('grade') not in (0, 1, 2, 3) or isinstance(row.get('grade'), bool):
            continue
        paper = row.get('paper') or {}
        if not isinstance(paper, dict): continue
        key = paper_key(paper)
        if not key or key in seen: continue
        seen.add(key)
        rows.append({'grade': row['grade'], 'paper': {k: paper[k] for k in ('title', 'abstract', 'doi', 's2PaperId', 'paperKeywords', 'authors', 'year') if k in paper}})
    return list(reversed(rows))[:40]


def concept_features(paper):
    from pulse_core.discovery_queries import STOP
    keywords=paper.get('paperKeywords') or []
    if isinstance(keywords,str):keywords=[keywords]
    segments=[paper.get('title') or '',str(paper.get('abstract') or '')[:8000],*keywords[:20]]
    features=set()
    for segment in segments:
        words=[word for word in re.findall(r'[\w-]+',str(segment).casefold()) if len(word)>2 and word not in STOP]
        features.update(words)
        features.update(' '.join(words[i:i+2]) for i in range(len(words)-1))
    return features


def contrastive_profile(rows):
    """Learn distinguishing concepts; words shared by both classes cancel out."""
    positive=[concept_features(row['paper']) for row in rows if row['grade']>0]
    negative=[concept_features(row['paper']) for row in rows if row['grade']==0]
    if not positive:return {'weights':{},'prefer':[],'avoid':[],'paired':False}
    pos=collections.Counter(feature for document in positive for feature in document)
    neg=collections.Counter(feature for document in negative for feature in document)
    weights={}
    for feature in pos.keys()|neg.keys():
        a=(pos[feature]+1)/(len(positive)+2)
        b=(neg[feature]+1)/(len(negative)+2) if negative else 1/(len(positive)+2)
        if negative and pos[feature]/len(positive)==neg[feature]/len(negative):continue
        weight=math.log(a/b)*math.log1p((len(rows)+1)/(pos[feature]+neg[feature]+1))
        if abs(weight)>.05:weights[feature]=weight
    strongest=sorted(weights,key=lambda feature:(-abs(weights[feature]),-len(feature.split()),feature))[:80]
    weights={feature:weights[feature] for feature in strongest}
    return {'weights':weights,'prefer':[f for f in strongest if weights[f]>0][:12],
            'avoid':[f for f in strongest if weights[f]<0][:12],'paired':bool(negative)}


def feedback_adjustment(paper,profile,semantic=None):
    features=concept_features(paper)
    weights=profile['weights']
    matched=[feature for feature in weights if feature in features]
    pos=sum(weights[f] for f in matched if weights[f]>0)/max(1,sum(v for v in weights.values() if v>0))
    neg=-sum(weights[f] for f in matched if weights[f]<0)/max(1,-sum(v for v in weights.values() if v<0))
    lexical=(.12 if profile['paired'] else .04)*(pos-neg)
    dense=.15*semantic if semantic is not None and profile['paired'] else 0
    return max(-.16,min(.12,lexical+dense)), {'positiveConcepts':[f for f in matched if weights[f]>0][:3],
        'negativeConcepts':[f for f in matched if weights[f]<0][:3],'semanticContrast':round(semantic,4) if semantic is not None else None}
