"""Optional, bounded local neural reranking; never downloads or calls cloud AI."""
import collections
import json
import math
import threading
import time
import urllib.request
from pulse_core.config_resolvers import resolve_embedding_model, resolve_ollama_tags_endpoint
from pulse_core.embeddings import cosine
from pulse_core.discovery_queries import text_for_paper
from pulse_performance import DiscoveryCancelled, request_json

_cache = collections.OrderedDict()
_models = {}
_lock = threading.RLock()

def local_model(settings):
    endpoint = resolve_ollama_tags_endpoint(settings)
    with _lock:
        cached = _models.get(endpoint)
    if cached and time.monotonic()-cached[0]<60: names = cached[1]
    else:
        try:
            data = request_json(urllib.request.Request(endpoint), timeout=2, cache=False)
            names = [item.get('name') for item in data.get('models', []) if item.get('name')]
        except DiscoveryCancelled: raise
        except Exception: names = []
        with _lock: _models[endpoint] = (time.monotonic(), names)
    configured = resolve_embedding_model(settings)
    for model in [configured, 'embeddinggemma', 'nomic-embed-text', 'all-minilm', 'mxbai-embed-large']:
        for name in names:
            if name == model or name == model+':latest': return endpoint.rsplit('/',1)[0]+'/embed', name
    return None, None

def semantic_scores(settings, queries, records, cancel_event=None, focus_first=False):
    endpoint, model = local_model(settings)
    if not model: return None, 'Text and citation ranking · local semantic ranking unavailable'
    texts = [str(q)[:12000] for q in queries] + [text_for_paper(p)[:16000] for p in records]
    identity=(endpoint,model)
    started = time.monotonic()
    resolved = {}
    try:
        for offset in range(0, len(texts), 24):
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            if time.monotonic()-started>35: raise TimeoutError('Local ranking time budget exceeded')
            batch = texts[offset:offset+24]
            with _lock:
                missing = []
                for text in dict.fromkeys(batch):
                    key = (identity,text)
                    if key in _cache:
                        resolved[text] = _cache[key]; _cache.move_to_end(key)
                    else: missing.append(text)
            if missing:
                req = urllib.request.Request(endpoint, data=json.dumps({'model':model,'input':missing,'truncate':True,'keep_alive':'5m'}).encode(),
                    headers={'Content-Type':'application/json'}, method='POST')
                data = request_json(req, timeout=15, cache=False)
                vectors = data.get('embeddings') or []
                if len(vectors)!=len(missing) or not vectors: raise ValueError('Incomplete embedding response')
                size = len(vectors[0])
                if size<8 or any(len(v)!=size or any(not isinstance(x,(int,float)) or not math.isfinite(x) for x in v) for v in vectors):
                    raise ValueError('Invalid embeddings')
                with _lock:
                    for text, vector in zip(missing,vectors):
                        resolved[text] = vector
                        _cache[(identity,text)] = vector
                    while len(_cache)>2000: _cache.popitem(last=False)
        vectors = [resolved[text] for text in texts]
        query_vectors, candidate_vectors = vectors[:len(queries)], vectors[len(queries):]
        scores=[]
        for vector in candidate_vectors:
            similarities=[max(0,cosine(query,vector)) for query in query_vectors]
            scores.append(.75*similarities[0]+.25*max(similarities[1:],default=0) if focus_first else max(similarities,default=0))
        return scores, 'Titles and abstracts ranked by meaning, text and citation evidence'
    except DiscoveryCancelled: raise
    except Exception:
        return None, 'Text and citation ranking · local semantic ranking unavailable'
