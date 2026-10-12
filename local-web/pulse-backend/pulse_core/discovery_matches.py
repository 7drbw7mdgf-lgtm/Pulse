"""Absolute match evidence with pool-rank and independent-channel safeguards."""
import math
from pulse_core.discovery_queries import terms, text_for_paper


def query_coverage(record, seeds, question=''):
    document = set(terms(text_for_paper(record)))
    def coverage(value):
        query = set(terms(value))
        return len(query & document)/len(query) if query else 0.0
    seed = max((coverage(str(p.get('title') or '')+' '+' '.join(p.get('paperKeywords') or [])) for p in seeds), default=0)
    return .8*coverage(question)+.2*seed if question else seed


def match_evidence(coverage, semantic=None, pairwise=None):
    # Evidence score is not a probability. It does not rescale to the best hit
    # in the current pool, so unrelated results cannot become "strong" by default.
    value = coverage
    if semantic is not None: value = max(value, .75*semantic+.25*coverage)
    if pairwise is not None: value = .8*pairwise+.2*coverage
    return round(max(0, min(1, value)), 4)


def independent_channel_count(record):
    channels = set()
    for item in record.get('retrievalEvidence') or []:
        channel = str(item.get('channel') or '').strip()
        if not channel: continue
        # Query variants and mirrored indexes are one concept-search channel.
        if channel.startswith('concepts:') or channel in {'concepts', 'lexicalConceptual', 'lexicalSearch', 'europePmc', 'core'}:
            channel = 'concepts'
        elif channel.startswith('fulltext:') or channel == 'fullText':
            channel = 'fulltext'
        elif channel == 'citationNetwork' and item.get('subType'):
            channel += ':' + str(item['subType']).casefold()
        channels.add(channel)
    return len(channels)


def match_label(evidence, calibration=None, grade=None, *, pool_rank=None, pool_size=None, channel_count=0):
    if grade is not None: return 'Relevant' if grade > 0 else 'Not relevant'
    thresholds = calibration or {}
    try:
        strong = float(thresholds.get('strong', .72))
        related = float(thresholds.get('related', .35))
        if not 0 <= related < strong <= 1: raise ValueError()
    except (ValueError, TypeError): strong, related = .72, .35
    top_decile = bool(pool_rank and pool_size and 1 <= pool_rank <= max(1, math.ceil(pool_size / 10)))
    if evidence >= strong and top_decile and channel_count >= 2: return 'Strong match'
    if pool_rank and pool_size:
        # Related is a relative review band, rather than an absolute evidence
        # threshold. Use the full deduplicated pool, not the visible page.
        top_forty_percent = 1 <= pool_rank <= math.ceil(.4 * pool_size)
        return 'Related' if top_forty_percent else 'Explore'
    # Preserve the evidence-based fallback for callers without pool context.
    return 'Related' if evidence >= related else 'Explore'


def fit_calibration(samples):
    """Fit only explicit positive/negative judgements and validate held-out rows.

    Samples share one scoring mode. Unknown papers are never negative labels.
    Small or inconsistent feedback retains conservative evidence thresholds.
    """
    positives = sorted((row for row in samples if row['grade'] > 0), key=lambda r:r['id'])
    negatives = sorted((row for row in samples if row['grade'] == 0), key=lambda r:r['id'])
    if len(samples) < 20 or min(len(positives), len(negatives)) < 6: return None
    validation = positives[::4] + negatives[::4]
    training = [row for index,row in enumerate(positives) if index%4] + [row for index,row in enumerate(negatives) if index%4]
    thresholds = sorted({round(row['evidence'],4) for row in training})
    def assess(rows, threshold):
        true = sum(row['grade']>0 and row['evidence']>=threshold for row in rows)
        selected = sum(row['evidence']>=threshold for row in rows)
        total = sum(row['grade']>0 for row in rows)
        return true/max(1,selected), true/max(1,total), selected
    def best(min_precision, beta):
        choices = []
        for threshold in thresholds:
            precision, recall, selected = assess(training, threshold)
            if precision < min_precision or not selected: continue
            f = (1+beta*beta)*precision*recall/max(.0001,beta*beta*precision+recall)
            choices.append((f, threshold))
        return max(choices)[1] if choices else None
    strong, related = best(.85,.5), best(.5,2)
    if strong is None or related is None or related > strong: return None
    if related == strong: related = max(0,strong-.01)
    sp, sr, accepted = assess(validation, strong)
    rp, rr, _ = assess(validation, related)
    if accepted < 2 or sp < .8 or rr < .7 or rp < .5: return None
    return {'version':'evidence-v1','strong':strong,'related':related,'sampleCount':len(samples),
            'validationCount':len(validation),'strongPrecision':round(sp,3),
            'relatedRecall':round(rr,3),'scope':'Current question and selected seeds'}
