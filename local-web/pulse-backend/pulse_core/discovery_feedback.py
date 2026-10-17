"""Explicit, question-scoped relevance feedback; no global model training."""
from pulse_core.doi_utils import normalize_doi
from pulse_core.search_merge import title_key
import collections
import functools
import math
import re

_cached_title_key = functools.lru_cache(maxsize=8192)(title_key)


FEEDBACK_STOP = set(
    'a an the and or of in on for to from with by is are was were this that these those we our their it as at be '
    'using study studies research results paper approach analysis method methods based new how why what which can '
    'could do does did have has effects effect role impact important review overview understanding'.split()
)

_FEEDBACK_PAPER_FIELDS = (
    'title', 'abstract', 'doi', 's2PaperId', 'paperKeywords', 'keywords', 'authors', 'year',
    'journal', 'venue', 'referenceIds', 'citedByIds', 'dbef', 'sharedConcepts',
    'matchedConcepts', 'retrievalEvidence', 'subType',
)


def paper_key(paper):
    k = paper.get('_fbKey')
    if k:
        return k
    raw_doi = paper.get('doi')
    if raw_doi:
        d = str(raw_doi).strip().lower()
        if not (d.startswith('http') or d.startswith('doi:') or d.endswith('.')):
            k = d
        else:
            k = normalize_doi(raw_doi).lower()
        if k:
            return k
    s2 = paper.get('s2PaperId')
    if s2:
        return str(s2)
    return _cached_title_key(paper.get('title'))


def _surname_token(name):
    cleaned = re.sub(r'\(.*?\)|\[.*?\]|\d+', ' ', str(name or ''))
    if ',' in cleaned:
        words = re.findall(r'[a-z0-9_-]+', cleaned.split(',')[0].lower())
        return words[-1] if words else ''
    words = re.findall(r'[a-z0-9_-]+', cleaned.lower())
    if len(words) > 1 and len(words[-1]) <= 2:
        return words[0]
    return words[-1] if words else ''


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
        if not isinstance(paper, dict):
            continue
        key = paper_key(paper)
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append({'grade': row['grade'], 'paper': {k: paper[k] for k in _FEEDBACK_PAPER_FIELDS if k in paper}})
    return list(reversed(rows))[:40]


def concept_features(paper):
    """Extract lexical + structured Rocchio features (references, DBEF pivots, citations, concepts, authors, venue)."""
    if not isinstance(paper, dict):
        return set()
    keywords = paper.get('paperKeywords') or paper.get('keywords') or []
    if isinstance(keywords, str):
        keywords = [keywords]
    segments = [paper.get('title') or '', str(paper.get('abstract') or '')[:8000], *keywords[:20]]
    features = set()
    for segment in segments:
        words = [word for word in re.findall(r'[a-z0-9_-]+', str(segment).lower()) if len(word) > 2 and word not in FEEDBACK_STOP]
        features.update(words)
        features.update(words[i] + ' ' + words[i + 1] for i in range(len(words) - 1))

    # 1. Shared references and DBEF pivots
    dbef = paper.get('dbef') if isinstance(paper.get('dbef'), dict) else {}
    for rid in list(paper.get('referenceIds') or [])[:80] + list(dbef.get('sharedReferenceIds') or [])[:80]:
        token = str(rid or '').strip().lower()
        if token:
            features.add('ref:' + token)
    for match in (dbef.get('seedMatches') or [])[:12]:
        if isinstance(match, dict) and int(match.get('shared') or 0) > 0:
            pivot = str(match.get('seedId') or match.get('seedIndex') or '').strip().lower()
            if pivot:
                features.add('pivot:' + pivot)

    # 2. Co-citation and direct-citation evidence
    top_sub = str(paper.get('subType') or '').strip().lower()
    if 'backward' in top_sub:
        features.add('cite:backward')
    if 'forward' in top_sub:
        features.add('cite:forward')
    if 'co-citation' in top_sub:
        features.add('cite:cocited')
    if 'bibliographic coupling' in top_sub or dbef:
        features.add('cite:coupled')
    if 'chase' in top_sub:
        features.add('cite:chase')
    for ev in (paper.get('retrievalEvidence') or [])[:24]:
        if not isinstance(ev, dict):
            continue
        ch = str(ev.get('channel') or '').strip().lower()
        st = str(ev.get('subType') or '').strip().lower()
        if (ch.startswith('citations:') and ch.endswith(':backward')) or 'backward' in st:
            features.add('cite:backward')
            if ch:
                features.add('cite:' + ch)
        if (ch.startswith('citations:') and ch.endswith(':forward')) or 'forward' in st:
            features.add('cite:forward')
            if ch:
                features.add('cite:' + ch)
        if 'cocitation' in ch or 'co-citation' in st:
            features.add('cite:cocited')
        if ch == 'dbef' or ch.startswith('dbef:') or 'bibliographic coupling' in st:
            features.add('cite:coupled')
        if 'chase' in st:
            features.add('cite:chase')
        for si in (ev.get('seedIndices') or [])[:8]:
            features.add('cite:seed:' + str(si))
    for cid in (paper.get('citedByIds') or [])[:40]:
        token = str(cid or '').strip().lower()
        if token:
            features.add('cocite:' + token)

    # 3. Concepts and sharedConcepts
    for clist in (
        keywords,
        paper.get('matchedConcepts') or [],
        paper.get('sharedConcepts') or [],
        dbef.get('sharedConcepts') or [],
    ):
        if isinstance(clist, str):
            clist = [clist]
        for concept in list(clist)[:24]:
            cwords = [w for w in re.findall(r'[a-z0-9_-]+', str(concept).lower()) if len(w) > 2 and w not in FEEDBACK_STOP][:6]
            if cwords:
                features.add('concept:' + ' '.join(cwords))

    # 4. Authors and venue
    authors = paper.get('authors') or []
    if isinstance(authors, str):
        authors = [authors]
    for author in list(authors)[:12]:
        sn = _surname_token(author)
        if len(sn) > 2:
            features.add('author:' + sn)
    venue = str(paper.get('journal') or paper.get('venue') or '').strip()
    if venue:
        vwords = [w for w in re.findall(r'[a-z0-9_-]+', venue.lower()) if len(w) > 2 and w not in FEEDBACK_STOP][:8]
        if vwords:
            features.add('venue:' + ' '.join(vwords))

    return features


def contrastive_profile(rows):
    """Learn distinguishing concepts and structured features; shared noise cancels out."""
    positive = [concept_features(row['paper']) for row in (rows or []) if isinstance(row, dict) and row.get('grade', 0) > 0]
    negative = [concept_features(row['paper']) for row in (rows or []) if isinstance(row, dict) and row.get('grade') == 0]
    total = len(positive) + len(negative)
    if not positive and not negative:
        return {'weights': {}, 'prefer': [], 'avoid': [], 'paired': False, 'count': 0}
    pos = collections.Counter(feature for document in positive for feature in document)
    neg = collections.Counter(feature for document in negative for feature in document)
    weights = {}
    for feature in pos.keys() | neg.keys():
        if positive:
            a = (pos[feature] + 1) / (len(positive) + 2)
            b = (neg[feature] + 1) / (len(negative) + 2) if negative else 1 / (len(positive) + 2)
            if negative and pos[feature] * len(negative) == neg[feature] * len(positive):
                continue
        else:
            a = 1 / (len(negative) + 2)
            b = (neg[feature] + 1) / (len(negative) + 2)
        weight = math.log(a / b) * math.log1p((total + 1) / (pos[feature] + neg[feature] + 1))
        if ':' in feature:
            weight *= 1.25
        weight = round(weight, 8)
        if abs(weight) > 0.05:
            weights[feature] = weight
    strongest = sorted(
        weights,
        key=lambda feature: (-round(abs(weights[feature]), 6), -len(feature.split()), feature),
    )[:80]
    weights = {feature: weights[feature] for feature in strongest}
    paired = bool(positive and negative)
    return {
        'weights': weights,
        'prefer': [f for f in strongest if weights[f] > 0 and ':' not in f][:12],
        'avoid': [f for f in strongest if weights[f] < 0 and ':' not in f][:12],
        'paired': paired,
        'count': total,
    }


def _compile_profile(profile):
    comp = profile.get('_compiled')
    if comp is not None:
        return comp
    weights = profile.get('weights') or {}
    pos_entries = [(f, w, ':' not in f) for f, w in weights.items() if w > 0]
    neg_entries = [(f, -w, ':' not in f) for f, w in weights.items() if w < 0]
    paired = bool(profile.get('paired'))
    pos_sum = sum(w for _, w, _ in pos_entries)
    neg_sum = sum(w for _, w, _ in neg_entries)
    pos_denom = max(1.0, min(8.0, pos_sum))
    neg_denom = max(1.0, neg_sum if paired else min(8.0, neg_sum))
    neg_scale = 0.25 if paired else 1.0
    count = int(profile.get('count') or 0)
    conf = min(2.8, 1.0 + 0.55 * math.log(count / 2.0)) if (paired and count > 2) else 1.0
    comp = (
        pos_entries,
        neg_entries,
        pos_denom,
        neg_denom,
        neg_scale,
        paired,
        (0.14 * conf) if paired else 0.06,
        0.14 * conf,
        0.16 * conf,
    )
    profile['_compiled'] = comp
    return comp


def feedback_adjustment(paper, profile, semantic=None, features=None):
    if not profile or not profile.get('weights'):
        return 0.0, None
    if features is None:
        features = concept_features(paper)
    pos_entries, neg_entries, pos_denom, neg_denom, neg_scale, paired, scale, cap_pos, cap_neg = _compile_profile(profile)
    pos_matched = 0.0
    pos_concepts = []
    for f, w, plain in pos_entries:
        if f in features:
            pos_matched += w
            if plain and len(pos_concepts) < 3:
                pos_concepts.append(f)
    neg_matched = 0.0
    neg_concepts = []
    for f, w, plain in neg_entries:
        if f in features:
            neg_matched += w
            if plain and len(neg_concepts) < 3:
                neg_concepts.append(f)
    pos = pos_matched / pos_denom
    neg = (neg_matched / neg_denom) * neg_scale
    lexical = scale * (pos - neg)
    dense = 0.15 * semantic if semantic is not None and paired else 0.0
    adj = round(max(-cap_neg, min(cap_pos, lexical + dense)), 6)
    return adj, {
        'positiveConcepts': pos_concepts,
        'negativeConcepts': neg_concepts,
        'semanticContrast': round(semantic, 4) if semantic is not None else None,
    }


def _candidate_pre_feedback_score(record, grade=None):
    sb = record.get('scoreBreakdown') or {}
    if sb.get('preFeedbackScore') is not None:
        base = float(sb['preFeedbackScore'])
        if grade == 0:
            # Server zeroes velocity, foundational, and citation-link bonuses on rejected items
            vel = float(sb.get('citationVelocityPrior') or 0.0)
            fnd = float(sb.get('foundationalPrior') or 0.0)
            cit = float(sb.get('citationLinkBonus') or 0.0)
            bonus = min(cit + fnd, max(cit, fnd) + 0.03) if (cit > 0 and fnd > 0) else (cit + fnd)
            base -= (vel + bonus)
        return base
    prev_fb = float(sb.get('feedback') or 0.0)
    return (float(record.get('score') or 0.0) / 100.0) - prev_fb


def _record_strength_tier(item):
    raw_label = item.get('_initialMatchLabel') if '_initialMatchLabel' in item else item.get('matchLabel')
    label = str(raw_label or '').lower()
    if label == 'not relevant':
        return 2
    if label == 'relevant' or label.startswith('strong'):
        return 0 if item.get('strongMatchEligible') is True else 1
    if label.startswith('related'):
        return 1
    if label.startswith('explore'):
        return 2
    score = float(item.get('_initialScore') if '_initialScore' in item else (item.get('score') or 0.0))
    return 1 if score >= 40.0 else 2


def rerank_pool_with_feedback(records, feedback, below_index=None, feature_cache=None):
    """Re-score and re-order candidates using Rocchio feedback.

    If `below_index` is given, `records[:below_index + 1]` keeps its current order
    and only `records[below_index + 1:]` is reordered.
    Returns `(reranked_records, moved_up_count)`.
    """
    if not records:
        return [], 0
    grades = {paper_key(row['paper']): row['grade'] for row in (feedback or []) if isinstance(row, dict) and isinstance(row.get('paper'), dict)}
    profile = contrastive_profile(feedback or [])
    scored = []
    for idx, record in enumerate(records):
        rec = dict(record)
        if '_initialMatchLabel' not in rec and rec.get('matchLabel') is not None:
            rec['_initialMatchLabel'] = rec.get('matchLabel')
        if '_initialScore' not in rec and rec.get('score') is not None:
            rec['_initialScore'] = rec.get('score')
        if '_initialRank' not in rec:
            rec['_initialRank'] = int(rec.get('rank') or (idx + 1))
        key = paper_key(rec)
        rec['_fbKey'] = key
        grade = grades.get(key)
        base = _candidate_pre_feedback_score(rec, grade=grade)
        if grade is not None:
            adj = 0.18 if grade > 0 else -0.55 if grade == 0 else 0.0
            rec['relevanceGrade'] = grade
            rec['matchLabel'] = 'Relevant' if grade > 0 else 'Not relevant'
        else:
            feats = feature_cache.get(key) if feature_cache is not None else None
            if feats is None:
                feats = concept_features(rec)
                if feature_cache is not None and key:
                    feature_cache[key] = feats
            adj, evidence = feedback_adjustment(rec, profile, features=feats) if feedback else (0.0, None)
            if evidence:
                rec['feedbackEvidence'] = evidence
        raw = base + adj
        rec['score'] = round(100.0 * max(0.0, min(1.0, raw)), 3)
        sb = dict(rec.get('scoreBreakdown') or {})
        sb.setdefault('preFeedbackScore', round(_candidate_pre_feedback_score(record, grade=None), 6))
        sb['feedback'] = round(adj, 3)
        rec['scoreBreakdown'] = sb
        scored.append(rec)

    if below_index is not None and 0 <= below_index < len(scored):
        prefix = scored[:below_index + 1]
        raw_suffix = scored[below_index + 1:]
        judged_tier = _record_strength_tier(scored[below_index])
        movable = [r for r in raw_suffix if _record_strength_tier(r) >= judged_tier]
        movable_positions = [i for i, r in enumerate(raw_suffix) if _record_strength_tier(r) >= judged_tier]
        baseline_order = sorted(movable, key=lambda r: int(r.get('_initialRank') or 0))
        old_pos = {r['_fbKey']: idx for idx, r in enumerate(baseline_order)}
        movable.sort(key=lambda p: (-p['score'], _cached_title_key(p.get('title')), str(p.get('doi') or '')))
        moved_up = sum(1 for new_idx, r in enumerate(movable) if old_pos.get(r['_fbKey'], new_idx) > new_idx)
        suffix = list(raw_suffix)
        for pos, item in zip(movable_positions, movable):
            suffix[pos] = item
        combined = prefix + suffix
    else:
        baseline_order = sorted(scored, key=lambda r: int(r.get('_initialRank') or 0))
        old_pos = {r['_fbKey']: idx for idx, r in enumerate(baseline_order)}
        combined = sorted(scored, key=lambda p: (-p['score'], _cached_title_key(p.get('title')), str(p.get('doi') or '')))
        moved_up = sum(1 for new_idx, r in enumerate(combined) if old_pos.get(r['_fbKey'], new_idx) > new_idx)

    for idx, rec in enumerate(combined, 1):
        rec['rank'] = idx
        rec.pop('_fbKey', None)
    return combined, moved_up
