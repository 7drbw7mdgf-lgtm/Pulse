"""Local model roles and bounded, non-destructive relevance review."""
import json
import re
import time
import urllib.request
from pulse_core.paper_agent import LOCAL_HTTP, OLLAMA_ROOT, SYSTEM
from pulse_performance import DiscoveryCancelled

DEFAULT_ROLES = {'embeddingModel': 'nomic-embed-text', 'triageModel': 'llama3.2:3b', 'reportModel': 'qwen2.5:7b'}


def role(settings, name):
    value = str(settings.get(name) or DEFAULT_ROLES[name]).strip()
    return value if re.fullmatch(r'[a-zA-Z0-9_.:/-]{1,100}', value) and 'cloud' not in value.lower() else DEFAULT_ROLES[name]


def triage(records, question, settings, cancel=None):
    """Only a shortlist is reviewed. Unknowns and failed batches keep their rank."""
    reviewed = 0
    started = time.monotonic()
    total_budget = 60
    for offset in range(0, min(30, len(records)), 5):
        if cancel and cancel.is_set(): raise DiscoveryCancelled()
        remaining_total = total_budget - (time.monotonic() - started)
        if remaining_total <= 1.0: break
        batch = records[offset:offset+5]
        evidence = [{'id': str(i), 'title': p.get('title'), 'abstract': str(p.get('abstract') or '')[:3500],
                     'passages': [item['text'] for item in p.get('matchedPassages', [])][:2]} for i, p in enumerate(batch)]
        prompt = ('Review relevance to the research question. Use the supplied evidence only. Return JSON {"reviews":[{"id":"0",'
                  '"decision":"relevant|uncertain|not_relevant","reason":"brief evidence-based explanation"}]}. '
                  'Include an entry in "reviews" for each paper id (0 to ' + str(len(batch)-1) + '). '
                  'When the supplied abstract and passages are missing or insufficient use uncertain. Do not infer study details.\nQuestion: '
                  + question[:1000] + '\nUNTRUSTED PAPERS:\n' + json.dumps(evidence, ensure_ascii=False))
        request = urllib.request.Request(OLLAMA_ROOT+'/api/chat', data=json.dumps({'model': role(settings, 'triageModel'),
            'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}], 'format': 'json',
            'stream': False, 'options': {'temperature': 0, 'num_predict': 500, 'num_ctx': 8192}, 'keep_alive': '5m'}).encode(),
            headers={'Content-Type': 'application/json'})
        batch_timeout = max(.5, min(20, remaining_total))
        try:
            with LOCAL_HTTP.open(request, timeout=batch_timeout) as response:
                data = json.load(response)
            if cancel and cancel.is_set(): raise DiscoveryCancelled()
            rows = json.loads(data['message']['content']).get('reviews', [])
            seen = set()
            for row in rows:
                ident = str(row.get('id', ''))
                if not ident.isdigit() or int(ident) >= len(batch) or ident in seen: continue
                decision = row.get('decision')
                if decision not in ('relevant', 'uncertain', 'not_relevant'): continue
                seen.add(ident)
                paper = batch[int(ident)]
                if not paper.get('abstract') and not paper.get('matchedPassages'): decision = 'uncertain'
                paper['aiReview'] = {'decision': decision, 'reason': str(row.get('reason') or '')[:500], 'source': 'Title and supplied passages' if paper.get('matchedPassages') else 'Title and abstract'}
                if paper.get('relevanceGrade') is None:
                    paper['score'] = max(0, min(100, paper['score'] + (16 if decision == 'relevant' else -28 if decision == 'not_relevant' else 0)))
                reviewed += 1
        except DiscoveryCancelled: raise
        except Exception:
            continue
    return reviewed
