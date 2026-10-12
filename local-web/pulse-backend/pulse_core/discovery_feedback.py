"""Explicit, question-scoped relevance feedback; no global model training."""
from pulse_core.doi_utils import normalize_doi
from pulse_core.search_merge import title_key


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
