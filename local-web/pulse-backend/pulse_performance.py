"""Bounded discovery jobs, provider requests, and persistent embedding reuse."""
import hashlib
import copy
from email.utils import parsedate_to_datetime
import json
import os
import queue
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

REQUEST_CONTEXT = threading.local()
_CACHE_LOCK = threading.Lock()
_JSON_CACHE = OrderedDict()
_JSON_INFLIGHT = {}
_PROVIDER_GATES = {}
_EMBED_LOCKS = [threading.Lock() for _ in range(16)]
LIBRARY_WRITE_LOCK = threading.RLock()


class DiscoveryCancelled(Exception):
    pass


class DiscoveryBudgetExceeded(TimeoutError):
    pass


def publish_partial(records):
    callback = getattr(REQUEST_CONTEXT, 'on_partial', None)
    if callback: callback(records)


def remaining_budget():
    deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
    return max(0, deadline - time.monotonic()) if deadline else None


def check_cancelled():
    event = getattr(REQUEST_CONTEXT, 'cancel_event', None)
    if event and event.is_set():
        raise DiscoveryCancelled()
    remaining = remaining_budget()
    if remaining is not None and remaining <= 0:
        raise DiscoveryBudgetExceeded('Search time budget reached; showing collected results.')


def _wait(seconds):
    check_cancelled()
    remaining = remaining_budget()
    if remaining is not None and seconds > remaining:
        raise DiscoveryBudgetExceeded('Search time budget reached; showing collected results.')
    event = getattr(REQUEST_CONTEXT, 'cancel_event', None)
    if event:
        if event.wait(seconds):
            raise DiscoveryCancelled()
    else:
        time.sleep(seconds)


def request_json(request, timeout=14, cache=True):
    """Share identical cached GETs while they are running, not just afterwards."""
    if not cache or request.get_method() != 'GET':
        return _request_json_once(request,timeout=timeout,cache=cache)
    key = hashlib.sha256((request.full_url+repr(request.header_items())).encode()+(request.data or b'')).hexdigest()
    while True:
        check_cancelled()
        with _CACHE_LOCK:
            pending = _JSON_INFLIGHT.get(key)
            owner = pending is None
            if owner:
                pending = {'event':threading.Event()}
                _JSON_INFLIGHT[key] = pending
        if owner:
            try:
                value = _request_json_once(request,timeout=timeout,cache=cache)
                pending['result'] = copy.deepcopy(value)
                return value
            except BaseException as error:
                pending['error'] = error
                raise
            finally:
                with _CACHE_LOCK:
                    _JSON_INFLIGHT.pop(key,None)
                    pending['event'].set()
        while not pending['event'].wait(.05): check_cancelled()
        check_cancelled()
        if 'result' in pending: return copy.deepcopy(pending['result'])
        error = pending.get('error')
        # Another job's cancellation/deadline must not cancel this caller.
        if isinstance(error,(DiscoveryCancelled,DiscoveryBudgetExceeded)): continue
        if error: raise error


def _request_json_once(request, timeout=14, cache=True):
    """Cache successful responses, bound per-host concurrency, and honor Retry-After."""
    check_cancelled()
    url = request.full_url
    key = hashlib.sha256((url + repr(request.header_items())).encode() + (request.data or b'')).hexdigest()
    host = urllib.parse.urlparse(url).hostname or ''
    with _CACHE_LOCK:
        entry = _JSON_CACHE.get(key)
        if cache and entry and time.monotonic() - entry[0] < 600:
            _JSON_CACHE.move_to_end(key)
            return json.loads(entry[1])
        limit = 10 if 'openalex.org' in host else 2
        gate = _PROVIDER_GATES.setdefault(host, threading.BoundedSemaphore(limit))
    while not gate.acquire(timeout=.1):
        check_cancelled()
    try:
        for attempt in range(3):
            check_cancelled()
            try:
                remaining = remaining_budget()
                counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
                if counter:
                    with counter['lock']:
                        if counter['remaining'] <= 0: raise DiscoveryBudgetExceeded('Search request budget reached; showing collected results.')
                        counter['remaining'] -= 1
                request_timeout = min(timeout, max(.1, remaining)) if remaining is not None else timeout
                with urllib.request.urlopen(request, timeout=request_timeout) as response:
                    data = json.loads(response.read().decode('utf-8'))
                check_cancelled()
                encoded=json.dumps(data) if cache else ''
                if cache and len(encoded)<=1_000_000:
                    with _CACHE_LOCK:
                        _JSON_CACHE[key] = (time.monotonic(), encoded)
                        _JSON_CACHE.move_to_end(key)
                        while len(_JSON_CACHE) > 500 or sum(len(value[1]) for value in _JSON_CACHE.values()) > 16_000_000:
                            _JSON_CACHE.popitem(last=False)
                return data
            except urllib.error.HTTPError as error:
                if error.code not in (429, 503) or attempt == 2:
                    raise
                raw = error.headers.get('Retry-After', '') if error.headers else ''
                try:
                    delay = max(1., float(raw))
                except ValueError:
                    try:
                        delay=max(1.,parsedate_to_datetime(raw).timestamp()-time.time())
                    except (ValueError,TypeError,OverflowError):
                        delay = float(2 ** attempt)
                # A long provider cooldown should be reported rather than blocking a job.
                if delay > 15:
                    raise
                error.close()
                _wait(delay)
    finally:
        gate.release()


def parallel_branches(tasks, on_progress=None, cancel_event=None, budget_seconds=50, request_budget=48):
    """Start independent sources together; publish query-level partial results.

    Per-host gates still bound transport concurrency. Cooperative deadlines
    include waits and retries, and partial results survive a branch deadline.
    """
    results, errors, completed, events = {}, {}, [], queue.Queue()
    executor = ThreadPoolExecutor(max_workers=min(6, max(1, len(tasks))), thread_name_prefix='pulse-discovery')
    def run(name, fn):
        REQUEST_CONTEXT.cancel_event = cancel_event
        REQUEST_CONTEXT.deadline = time.monotonic() + budget_seconds
        REQUEST_CONTEXT.request_counter = {'remaining': request_budget, 'lock': threading.Lock()}
        REQUEST_CONTEXT.on_partial = lambda rows: events.put(('partial', name, rows))
        try:
            check_cancelled()
            value = fn()
            events.put(('complete', name, value))
        except Exception as error:
            events.put(('error', name, error))
        finally:
            for key in ('cancel_event', 'deadline', 'request_counter', 'on_partial'):
                setattr(REQUEST_CONTEXT, key, None)
    futures = [executor.submit(run, name, fn) for name, fn in tasks.items()]
    try:
        while len(completed) + len(errors) < len(tasks):
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            try: kind, name, value = events.get(timeout=.1)
            except queue.Empty: continue
            if kind in ('partial', 'complete'):
                results[name] = value
                if kind == 'complete': completed.append(name)
            elif isinstance(value, DiscoveryCancelled):
                raise value
            else:
                errors[name] = str(value) or type(value).__name__
            if on_progress: on_progress(dict(results), list(completed), dict(errors), len(tasks))
    finally:
        for future in futures: future.cancel()
        # All normal completions have reported. Cancelling returns immediately;
        # network calls remain bounded by their deadline and socket timeout.
        executor.shutdown(wait=False)
    return results, [name for name in tasks if name in completed], errors


class DiscoveryJobs:
    def __init__(self):
        self.lock = threading.RLock()
        self.jobs = {}

    def start(self, payload, runner):
        import secrets
        with self.lock:
            now = time.monotonic()
            self.jobs = {key: job for key, job in self.jobs.items()
                         if job['status'] == 'running' or now - job['_started'] < 600}
            if sum(job['status'] == 'running' or not job['_finished'] for job in self.jobs.values()) >= 4:
                raise ValueError('Four discovery searches are already active. Cancel one or wait for it to finish.')
            if len(self.jobs) >= 24:
                oldest = next(key for key, job in self.jobs.items() if job['_finished'])
                self.jobs.pop(oldest)
            key = secrets.token_urlsafe(18)
            job = {'id': key, 'status': 'running', 'recommendations': [], 'branchesExecuted': [],
                   'errors': {}, 'completed': 0, 'total': 0, '_event': threading.Event(), '_started': now, '_finished': False}
            self.jobs[key] = job
        def progress(data):
            with self.lock:
                if job['status'] == 'running':
                    job.update(data)
        def run():
            try:
                result = runner(payload, on_progress=progress, cancel_event=job['_event'])
                with self.lock:
                    if not job['_event'].is_set():
                        job.update(result, status='complete')
            except DiscoveryCancelled:
                with self.lock:
                    job['status'] = 'cancelled'
            except Exception as error:
                with self.lock:
                    if not job['_event'].is_set():
                        job.update(status='failed', error=str(error))
            finally:
                with self.lock:
                    job['_finished'] = True
        threading.Thread(target=run, name='pulse-discovery-job', daemon=True).start()
        return self.read(key)

    def read(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if not job:
                raise KeyError(key)
            # Snapshot through JSON so polling cannot observe mutable candidate records.
            return json.loads(json.dumps({key: value for key, value in job.items() if not key.startswith('_')}))

    def cancel(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if not job:
                raise KeyError(key)
            if job['status'] == 'running':
                job['_event'].set()
                job['status'] = 'cancelled'
        return self.read(key)


def cached_embedding(config_dir, identity, text, compute):
    """Reuse vectors across questions and restarts; store only hashed text keys."""
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode() + b'\0' + text.encode()).hexdigest()
    with _EMBED_LOCKS[int(key[:2], 16) % len(_EMBED_LOCKS)]:
        found = cached_embeddings(config_dir, identity, [text])
        if text in found: return found[text]
        vector = compute()
        if vector: cached_embeddings(config_dir, identity, [text], {text: vector})
        return vector


def cached_embeddings(config_dir, identity, texts, vectors=None):
    """Read/write a vector batch in one transaction; only text hashes are stored."""
    if not texts: return {}
    keys = {text: hashlib.sha256(json.dumps(identity, sort_keys=True).encode() + b'\0' + text.encode()).hexdigest() for text in texts}
    connection = None
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(config_dir / 'embedding-cache.sqlite3'), timeout=2)
        os.chmod(config_dir / 'embedding-cache.sqlite3', 0o600)
        connection.execute('CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL, used REAL NOT NULL)')
        now = time.time()
        if vectors is not None:
            connection.executemany('INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)',
                                   [(keys[text], json.dumps(vector), now) for text, vector in vectors.items()])
            connection.execute('DELETE FROM embeddings WHERE key IN (SELECT key FROM embeddings ORDER BY used DESC LIMIT -1 OFFSET 1000)')
            connection.commit()
            return vectors
        placeholders = ','.join('?' for _ in keys)
        rows = dict(connection.execute('SELECT key, vector FROM embeddings WHERE key IN ('+placeholders+')', list(keys.values())))
        if rows:
            connection.execute('UPDATE embeddings SET used=? WHERE key IN ('+placeholders+')', [now, *keys.values()])
            connection.commit()
        return {text: json.loads(rows[key]) for text, key in keys.items() if key in rows}
    except (OSError, sqlite3.Error, ValueError):
        return {}
    finally:
        if connection: connection.close()


def parallel_lookup(fetcher, items):
    """Fetch small metadata batches in order, with shared provider gates and cancellation."""
    event = getattr(REQUEST_CONTEXT, 'cancel_event', None)
    deadline = getattr(REQUEST_CONTEXT, 'deadline', None)
    counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
    def fetch(item):
        REQUEST_CONTEXT.cancel_event = event
        REQUEST_CONTEXT.deadline = deadline
        REQUEST_CONTEXT.request_counter = counter
        try:
            check_cancelled()
            return item, fetcher(item)
        except (DiscoveryCancelled, DiscoveryBudgetExceeded):
            raise
        except Exception:
            return item, None
        finally:
            REQUEST_CONTEXT.cancel_event = None
            REQUEST_CONTEXT.deadline = None
            REQUEST_CONTEXT.request_counter = None
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='pulse-metadata') as executor:
        return list(executor.map(fetch, items))
