"""Optional, bounded local neural reranking; never downloads or calls cloud AI."""
import collections
import json
import math
import threading
import time
import urllib.request
from pulse_core.platform_support import config_directory
from pulse_core.config_resolvers import resolve_embedding_model, resolve_ollama_tags_endpoint
from pulse_core.embeddings import cosine
from pulse_core.discovery_queries import text_for_paper
from pulse_core.doi_utils import normalize_doi
from pulse_performance import DiscoveryCancelled, request_json, cached_embedding

_cache = collections.OrderedDict()
_models = {}
_lock = threading.RLock()

def local_model(settings, fast_mode=False):
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
    model_order = (['all-minilm'] if fast_mode else []) + [configured, 'embeddinggemma', 'nomic-embed-text', 'all-minilm', 'mxbai-embed-large']
    for model in model_order:
        if not model: continue
        for name in names:
            if name == model or name == model+':latest': return endpoint.rsplit('/',1)[0]+'/embed', name
    return None, None

def pre_embed_papers(settings, records, cancel_event=None, fast_mode=False):
    """Embed arriving candidates in the background during collection."""
    if not records: return
    try:
        endpoint, model = local_model(settings, fast_mode=fast_mode)
        if not model: return
        identity = (endpoint, model)
        items_to_check = []
        for p in records:
            if cancel_event and cancel_event.is_set(): return
            text = text_for_paper(p)[:16000]
            doi = normalize_doi(p.get('doi') or '').lower()
            with _lock:
                in_mem = (identity, text) in _cache or (doi and (identity, 'doi:'+doi) in _cache)
            if not in_mem:
                items_to_check.append((doi, text))
        if not items_to_check: return
        missing = []
        for doi, text in items_to_check:
            if cancel_event and cancel_event.is_set(): return
            disk_key = f"doi:{doi}" if doi else text
            cached_vec = cached_embedding(config_directory(), identity, disk_key, lambda: None)
            if cached_vec:
                with _lock:
                    _cache[(identity, text)] = cached_vec
                    if doi: _cache[(identity, 'doi:'+doi)] = cached_vec
            else:
                missing.append((doi, text))
        if not missing: return
        for offset in range(0, min(len(missing), 72), 24):
            if cancel_event and cancel_event.is_set(): return
            chunk = missing[offset:offset+24]
            chunk_texts = [t for _, t in chunk]
            req = urllib.request.Request(endpoint, data=json.dumps({'model':model,'input':chunk_texts,'truncate':True,'keep_alive':'5m'}).encode(),
                headers={'Content-Type':'application/json'}, method='POST')
            data = request_json(req, timeout=12, cache=False)
            vectors = data.get('embeddings') or []
            if len(vectors) == len(chunk):
                with _lock:
                    for (doi, text), vec in zip(chunk, vectors):
                        _cache[(identity, text)] = vec
                        if doi: _cache[(identity, 'doi:'+doi)] = vec
                        disk_key = f"doi:{doi}" if doi else text
                        cached_embedding(config_directory(), identity, disk_key, lambda v=vec: v)
                        while len(_cache)>3000: _cache.popitem(last=False)
    except Exception:
        pass

def semantic_scores(settings, queries, records, cancel_event=None, focus_first=False, fast_mode=False):
    endpoint, model = local_model(settings, fast_mode=fast_mode)
    if not model: return None, 'Text and citation ranking · local semantic ranking unavailable'
    texts = [str(q)[:12000] for q in queries] + [text_for_paper(p)[:16000] for p in records]
    dois = [''] * len(queries) + [normalize_doi(p.get('doi') or '').lower() for p in records]
    identity=(endpoint,model)
    started = time.monotonic()
    resolved = {}
    try:
        for offset in range(0, len(texts), 24):
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            if time.monotonic()-started>35: raise TimeoutError('Local ranking time budget exceeded')
            batch_texts = texts[offset:offset+24]
            batch_dois = dois[offset:offset+24]
            missing = []
            for text, doi in zip(batch_texts, batch_dois):
                if text in resolved: continue
                with _lock:
                    key = (identity, text)
                    doi_key = (identity, 'doi:'+doi) if doi else None
                    if key in _cache:
                        resolved[text] = _cache[key]
                        _cache.move_to_end(key)
                        continue
                    if doi_key and doi_key in _cache:
                        resolved[text] = _cache[doi_key]
                        _cache.move_to_end(doi_key)
                        continue
                disk_key = f"doi:{doi}" if doi else text
                vec = cached_embedding(config_directory(), identity, disk_key, lambda: None)
                if vec:
                    resolved[text] = vec
                    with _lock:
                        _cache[(identity, text)] = vec
                        if doi: _cache[(identity, 'doi:'+doi)] = vec
                else:
                    missing.append((doi, text))
            if missing:
                unique_missing = []
                seen_txt = set()
                for d, t in missing:
                    if t not in seen_txt:
                        seen_txt.add(t)
                        unique_missing.append((d, t))
                input_texts = [t for _, t in unique_missing]
                req = urllib.request.Request(endpoint, data=json.dumps({'model':model,'input':input_texts,'truncate':True,'keep_alive':'5m'}).encode(),
                    headers={'Content-Type':'application/json'}, method='POST')
                data = request_json(req, timeout=15, cache=False)
                vectors = data.get('embeddings') or []
                if len(vectors)!=len(input_texts) or not vectors: raise ValueError('Incomplete embedding response')
                size = len(vectors[0])
                if size<8 or any(len(v)!=size or any(not isinstance(x,(int,float)) or not math.isfinite(x) for x in v) for v in vectors):
                    raise ValueError('Invalid embeddings')
                with _lock:
                    for (doi, text), vector in zip(unique_missing, vectors):
                        resolved[text] = vector
                        _cache[(identity,text)] = vector
                        if doi: _cache[(identity, 'doi:'+doi)] = vector
                        disk_key = f"doi:{doi}" if doi else text
                        cached_embedding(config_directory(), identity, disk_key, lambda v=vector: v)
                    while len(_cache)>3000: _cache.popitem(last=False)
        vectors = [resolved[text] for text in texts]
        query_vectors, candidate_vectors = vectors[:len(queries)], vectors[len(queries):]
        scores=[]
        for vector in candidate_vectors:
            similarities=[max(0,cosine(query,vector)) for query in query_vectors]
            scores.append(.75*similarities[0]+.25*max(similarities[1:],default=0) if focus_first else max(similarities,default=0))
        notice = f"Titles and abstracts ranked by meaning ({model}), text and citation evidence" if fast_mode else 'Titles and abstracts ranked by meaning, text and citation evidence'
        return scores, notice
    except DiscoveryCancelled: raise
    except Exception:
        return None, 'Text and citation ranking · local semantic ranking unavailable'

