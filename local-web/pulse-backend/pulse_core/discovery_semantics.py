"""Optional local neural ranking with shared, bounded embedding work."""
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
from pulse_core.discovery_feedback import paper_key
from pulse_performance import DiscoveryCancelled, REQUEST_CONTEXT, request_json, cached_embeddings

_cache = collections.OrderedDict()
_models = {}
_lock = threading.RLock()
_inference_lock = threading.Lock()


def embedding_text(paper):
    keywords=paper.get('paperKeywords') or paper.get('keywords') or []
    if isinstance(keywords,str):keywords=[keywords]
    abstract=str(paper.get('abstract') or '')
    if len(abstract)>3000:abstract=abstract[:2100]+'\n'+abstract[-900:]
    passages=' '.join(str(p.get('text') or '')[:500] for p in (paper.get('matchedPassages') or [])[:2])
    return '\n'.join([str(paper.get('title') or '')[:1000],abstract,'; '.join(map(str,keywords[:16]))[:500],passages])


def query_text(value):
    value=str(value)
    return value if len(value)<=4000 else value[:3000]+'\n'+value[-1000:]


def local_model(settings, fast_mode=False):
    endpoint = resolve_ollama_tags_endpoint(settings)
    with _lock:
        cached = _models.get(endpoint)
    if cached and time.monotonic()-cached[0] < 60:
        names = cached[1]
    else:
        try:
            data = request_json(urllib.request.Request(endpoint), timeout=2, cache=False)
            names = [item.get('name') for item in data.get('models', []) if item.get('name')]
        except DiscoveryCancelled:
            raise
        except Exception:
            names = []
        with _lock:
            _models[endpoint] = (time.monotonic(), names)
    configured = resolve_embedding_model(settings)
    model_order = (['all-minilm'] if fast_mode else []) + [configured, 'embeddinggemma', 'nomic-embed-text', 'all-minilm', 'mxbai-embed-large']
    for model in model_order:
        if not model: continue
        for name in names:
            if name == model or name == model+':latest':
                return endpoint.rsplit('/', 1)[0]+'/embed', name
    return None, None


def _check(cancel_event, stop_event, deadline):
    if (cancel_event and cancel_event.is_set()) or (stop_event and stop_event.is_set()):
        raise DiscoveryCancelled()
    if time.monotonic() >= deadline:
        raise TimeoutError('Local ranking time budget exceeded')


def _valid(vector):
    return (isinstance(vector, list) and len(vector) >= 8 and
            all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in vector))


def _remember(identity, text, vector):
    with _lock:
        _cache[(identity, text)] = vector
        _cache.move_to_end((identity, text))
        while len(_cache) > 3000: _cache.popitem(last=False)


def _cached(identity, text):
    with _lock:
        vector = _cache.get((identity, text))
        if vector is not None: _cache.move_to_end((identity, text))
        return vector


def _disk_cached(identity, texts):
    # One SQLite transaction per batch. The fingerprint includes the full text,
    # so metadata enrichment cannot reuse a stale title-only DOI vector.
    keys = ['text-v2:'+text for text in texts]
    found = cached_embeddings(config_directory(), identity, keys)
    for text in texts:
        vector = found.get('text-v2:'+text)
        if _valid(vector): _remember(identity, text, vector)


def _resolve(identity, texts, cancel_event, deadline, stop_event=None):
    endpoint, model = identity
    resolved = {}
    unique = list(dict.fromkeys(texts))
    for offset in range(0, len(unique), 24):
        _check(cancel_event, stop_event, deadline)
        batch = unique[offset:offset+24]
        missing = []
        for text in batch:
            vector = _cached(identity, text)
            if vector is not None: resolved[text] = vector
            else: missing.append(text)
        if not missing: continue
        _disk_cached(identity, missing)
        missing = [text for text in missing if _cached(identity, text) is None]
        for text in batch:
            vector = _cached(identity, text)
            if vector is not None: resolved[text] = vector
        if not missing: continue
        while not _inference_lock.acquire(timeout=.05):
            _check(cancel_event, stop_event, deadline)
        try:
            _check(cancel_event, stop_event, deadline)
            # A background batch may have completed while this caller waited.
            still_missing = []
            for text in missing:
                vector = _cached(identity, text)
                if vector is not None: resolved[text] = vector
                else: still_missing.append(text)
            if not still_missing: continue
            request = urllib.request.Request(endpoint,
                data=json.dumps({'model': model, 'input': still_missing, 'truncate': True, 'keep_alive': '30m'}).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            previous_deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
            previous_cancel = getattr(REQUEST_CONTEXT, 'cancel_event', None)
            REQUEST_CONTEXT.deadline = min(previous_deadline, deadline) if previous_deadline else deadline
            REQUEST_CONTEXT.cancel_event = cancel_event
            try:
                data = request_json(request, timeout=min(12, max(.1, deadline-time.monotonic())), cache=False)
            finally:
                REQUEST_CONTEXT.deadline = previous_deadline
                REQUEST_CONTEXT.cancel_event = previous_cancel
            vectors = data.get('embeddings') or []
            if len(vectors) != len(still_missing) or not vectors or any(not _valid(v) or len(v) != len(vectors[0]) for v in vectors):
                raise ValueError('Invalid or incomplete embeddings')
            # Cache completed work even if collection ended during the request.
            # Foreground ranking can then reuse it without a duplicate HTTP call.
            for text, vector in zip(still_missing, vectors):
                resolved[text] = vector
                _remember(identity, text, vector)
            stored = {'text-v2:'+text: vector for text, vector in zip(still_missing, vectors)}
            cached_embeddings(config_directory(), identity, list(stored), stored)
        finally:
            _inference_lock.release()
    return resolved


def pre_embed_papers(settings, records, cancel_event=None, fast_mode=False, queries=None, stop_event=None):
    """Warm the exact query and current ranked shortlist during collection."""
    if not records and not queries: return
    try:
        _check(cancel_event, stop_event, float('inf'))
        endpoint, model = local_model(settings, fast_mode=fast_mode)
        if not model: return
        texts = [query_text(q) for q in queries or []] + [embedding_text(p) for p in records]
        _resolve((endpoint, model), texts, cancel_event, time.monotonic()+4, stop_event)
    except Exception:
        # Warmup is optional. Completed batches remain in the shared cache.
        pass


def semantic_scores(settings, queries, records, cancel_event=None, focus_first=False, fast_mode=False, feedback=None, feedback_scores=None):
    _check(cancel_event, None, float('inf'))
    endpoint, model = local_model(settings, fast_mode=fast_mode)
    if not model: return None, 'Text and citation ranking · local semantic ranking unavailable'
    labels=feedback or []
    positive=[row for row in labels if row['grade']>0][-6:]
    negative=[row for row in labels if row['grade']==0][-6:]
    labels=positive+negative if positive and negative else []
    texts = [query_text(q) for q in queries] + [embedding_text(p) for p in records]
    label_texts=[embedding_text(row['paper']) for row in labels]
    try:
        resolved = _resolve((endpoint, model), texts+label_texts, cancel_event, time.monotonic()+10)
        query_vectors = [resolved[text] for text in texts[:len(queries)]]
        scores = []
        for text in texts[len(queries):]:
            similarities = [max(0, cosine(query, resolved[text])) for query in query_vectors]
            scores.append(.75*similarities[0]+.25*max(similarities[1:], default=0) if focus_first else max(similarities, default=0))
        if labels and feedback_scores is not None:
            positive_vectors=[resolved[text] for row,text in zip(labels,label_texts) if row['grade']>0]
            negative_vectors=[resolved[text] for row,text in zip(labels,label_texts) if row['grade']==0]
            for paper,text in zip(records,texts[len(queries):]):
                vector=resolved[text]
                feedback_scores[paper_key(paper)]=sum(cosine(vector,v) for v in positive_vectors)/len(positive_vectors)-sum(cosine(vector,v) for v in negative_vectors)/len(negative_vectors)
        return scores, 'Titles and abstracts ranked by meaning, text and citation evidence'
    except DiscoveryCancelled:
        raise
    except Exception:
        return None, 'Text and citation ranking · local semantic ranking unavailable'
