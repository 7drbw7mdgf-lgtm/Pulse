"""Bounded discovery jobs, provider requests, and persistent embedding reuse."""
import gzip
import hashlib
import copy
from email.utils import parsedate_to_datetime
import json
import os
import queue
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections import OrderedDict
import collections
import http.client
import io
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

from pulse_source_health import check_source, failed as source_failed, succeeded as source_succeeded, ProviderCooldown

REQUEST_CONTEXT = threading.local()
_CACHE_LOCK = threading.Lock()
_JSON_CACHE = OrderedDict()
_JSON_INFLIGHT = {}
_PROVIDER_GATES = {}
_EMBED_LOCKS = [threading.Lock() for _ in range(16)]
LIBRARY_WRITE_LOCK = threading.RLock()
_CONNECTION_POOLS = collections.defaultdict(list)
_CONNECTION_LOCK = threading.Lock()


class _ResponseWrapper:
    def __init__(self, data, headers, status):
        self._data = data
        self.headers = headers
        self.status = status
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


def _request_origin(url):
    try:
        target = urllib.parse.urlsplit(url)
        if target.username is not None or target.password is not None or not target.hostname:
            return None
        port = target.port
        if port is None: port = 443 if target.scheme.lower() == 'https' else 80
        return target.scheme.lower(), target.hostname.lower(), port
    except ValueError:
        return None


class _OriginRestrictedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = _request_origin(origin)

    def redirect_request(self, request, fp, code, message, headers, new_url):
        if self.origin is None or _request_origin(new_url) != self.origin:
            raise urllib.error.HTTPError(request.full_url, 502, 'API redirect blocked', headers,
                io.BytesIO(b'The API redirected to an unsupported service address.'))
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected is not None:
            redirected.pulse_redirect_origin = request.pulse_redirect_origin
        return redirected


def _urlopen_fallback(request, timeout=14):
    origin = getattr(request, 'pulse_redirect_origin', None)
    if origin:
        return urllib.request.build_opener(_OriginRestrictedRedirect(origin)).open(request, timeout=timeout)
    return urllib.request.urlopen(request, timeout=timeout)


def _urlopen_persistent(request, timeout=14):
    if hasattr(urllib.request.urlopen, 'mock_calls') or type(urllib.request.urlopen).__module__.startswith('unittest.mock'):
        return urllib.request.urlopen(request, timeout=timeout)
    url = request.full_url if hasattr(request, 'full_url') else str(request)
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    host = parsed.hostname
    if not host or scheme not in ('http', 'https'):
        return urllib.request.urlopen(request, timeout=timeout)
    port = parsed.port or (443 if scheme == 'https' else 80)
    path = parsed.path or '/'
    if parsed.query: path += '?' + parsed.query
    headers = dict(request.header_items()) if hasattr(request, 'header_items') else {}
    if not any(k.lower() == 'connection' for k in headers): headers['Connection'] = 'keep-alive'
    if not any(k.lower() == 'host' for k in headers): headers['Host'] = parsed.netloc
    if not any(k.lower() == 'accept-encoding' for k in headers): headers['Accept-Encoding'] = 'gzip'
    method = request.get_method() if hasattr(request, 'get_method') else ('POST' if getattr(request, 'data', None) else 'GET')
    data = getattr(request, 'data', None)
    now = time.monotonic()
    conn = None
    with _CONNECTION_LOCK:
        pool = _CONNECTION_POOLS[(scheme, host, port)]
        while pool:
            candidate, added_at = pool.pop()
            if now - added_at < 30:
                candidate.timeout = timeout
                conn = candidate
                break
            try: candidate.close()
            except Exception: pass
    if conn is None:
        if scheme == 'https':
            ctx = ssl.create_default_context()
            conn = http.client.HTTPSConnection(host, port=port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port=port, timeout=timeout)
    try:
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
    except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, http.client.CannotSendRequest, http.client.ResponseNotReady, OSError):
        try: conn.close()
        except Exception: pass
        if scheme == 'https':
            ctx = ssl.create_default_context()
            conn = http.client.HTTPSConnection(host, port=port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port=port, timeout=timeout)
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
    body = resp.read()
    if resp.getheader('content-encoding', '').lower() == 'gzip':
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    status = resp.status
    keep = 'close' not in resp.getheader('connection', '').lower()
    if keep:
        with _CONNECTION_LOCK:
            pool = _CONNECTION_POOLS[(scheme, host, port)]
            if len(pool) < 16:
                pool.append((conn, time.monotonic()))
                conn = None
    if conn is not None:
        try: conn.close()
        except Exception: pass
    if status >= 400:
        raise urllib.error.HTTPError(url, status, resp.reason, resp.headers, io.BytesIO(body))
    return _ResponseWrapper(body, resp.headers, status)


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


def submit_with_context(executor, function, *args, **kwargs):
    """Nested HTTP work shares its caller's cancellation and request budget."""
    keys = ('cancel_event', 'deadline', 'request_counter')
    context = {key:getattr(REQUEST_CONTEXT, key, None) for key in keys}
    def run():
        previous = {key:getattr(REQUEST_CONTEXT, key, None) for key in keys}
        try:
            for key,value in context.items(): setattr(REQUEST_CONTEXT, key, value)
            check_cancelled()
            return function(*args, **kwargs)
        finally:
            for key,value in previous.items(): setattr(REQUEST_CONTEXT, key, value)
    return executor.submit(run)


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


def _strip_cache_params(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        if not parsed.query:
            return url
        qs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        filtered = sorted([(k, v) for k, v in qs if k.lower() not in ('api_key', 'api-key', 'mailto')])
        new_query = urllib.parse.urlencode(filtered)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, new_query, parsed.fragment))
    except Exception:
        return url


def _disk_http_cache_key(request):
    url = request.full_url if hasattr(request, 'full_url') else str(request)
    clean_url = _strip_cache_params(url)
    headers = dict(request.header_items()) if hasattr(request, 'header_items') else {}
    relevant = {k.lower(): v for k, v in sorted(headers.items()) if k.lower() in ('accept', 'content-type')}
    data = getattr(request, 'data', None) or b''
    return hashlib.sha256(clean_url.encode('utf-8') + b'\0' + json.dumps(relevant).encode('utf-8') + b'\0' + data).hexdigest()


def _disk_http_cache_ttl(url):
    u = urllib.parse.unquote(url).lower()
    # Free-text searches have 15-minute TTL
    if 'search=' in u or 'query=' in u:
        # Identifier lookups (DOI or PMID queries) are stable; topic searches are not.
        if not ('ext_id:' in u or 'doi:' in u or 'doi%3a' in u or 'src:med' in u):
            return 900.0  # 15 minutes
    if ('cites:' in u or 'cited_by:' in u or
        'openalex_id:' in u or 'doi:' in u or
        re.search(r'/works/(?:w\d+|https%3a|https://|doi:)', u) or
        re.search(r'/paper/[a-zA-Z0-9]+', u) or
        re.search(r'/(?:citations|references)', u) or
        re.search(r'/fields/[a-zA-Z0-9]+', u) or
        re.search(r'/concepts/[a-zA-Z0-9]+', u) or
        'icite.od.nih.gov' in u or
        'europepmc.org' in u or 'ebi.ac.uk/europepmc' in u or
        'opencitations.net' in u):
        return 604800.0  # 7 days
    return 900.0  # 15 minutes


def _disk_http_cache_skippable(request):
    url = request.full_url if hasattr(request, 'full_url') else str(request)
    host = urllib.parse.urlsplit(url).hostname or ''
    # Public academic APIs with rate-limit API keys share the disk cache
    if 'openalex.org' in host or 'semanticscholar.org' in host:
        return False
    headers = dict(request.header_items()) if hasattr(request, 'header_items') else {}
    for k, v in headers.items():
        kl = k.lower()
        if kl in ('authorization', 'x-api-key') or 'bearer' in str(v).lower():
            return True
    return False


def _disk_http_cache_get(key, request):
    if _disk_http_cache_skippable(request):
        return None
    check_cancelled()
    conn = None
    try:
        from pulse_core.platform_support import config_directory
        cfg = config_directory()
        db_path = cfg / 'http-cache.sqlite3'
        if not db_path.is_file():
            return None
        conn = sqlite3.connect(str(db_path), timeout=2)
        check_cancelled()
        row = conn.execute('SELECT body, expires_at FROM http_cache WHERE key = ?', (key,)).fetchone()
        if row:
            body, expires_at = row
            now = time.time()
            if expires_at > now:
                conn.execute('UPDATE http_cache SET used = ? WHERE key = ?', (now, key))
                conn.commit()
                if isinstance(body, bytes):
                    try:
                        return json.loads(zlib.decompress(body).decode('utf-8'))
                    except Exception:
                        return json.loads(body.decode('utf-8'))
                return json.loads(body)
            else:
                conn.execute('DELETE FROM http_cache WHERE key = ?', (key,))
                conn.commit()
    except Exception:
        pass
    finally:
        if conn:
            try: conn.close()
            except Exception: pass
    return None


_NCBI_LOCK = threading.Lock()
_NCBI_LAST_TIME = [0.0]


def _disk_http_cache_set(key, url, headers, data, status=200):
    if status >= 400:
        return
    conn = None
    try:
        raw_json = json.dumps(data)
        compressed = zlib.compress(raw_json.encode('utf-8'), level=6)
        size = len(compressed)
        if size > 25_000_000:
            return
        ttl = _disk_http_cache_ttl(url)
        now = time.time()
        expires_at = now + ttl
        from pulse_core.platform_support import config_directory
        cfg = config_directory()
        cfg.mkdir(parents=True, exist_ok=True)
        db_path = cfg / 'http-cache.sqlite3'
        conn = sqlite3.connect(str(db_path), timeout=2)
        os.chmod(db_path, 0o600)
        conn.execute('''CREATE TABLE IF NOT EXISTS http_cache (
            key TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            headers TEXT NOT NULL,
            body BLOB NOT NULL,
            status INTEGER NOT NULL,
            expires_at REAL NOT NULL,
            used REAL NOT NULL,
            size INTEGER NOT NULL
        )''')
        clean_url = _strip_cache_params(url)
        clean_headers = {k: v for k, v in headers.items() if k.lower() not in ('api_key', 'api-key', 'authorization', 'x-api-key')}
        conn.execute('''INSERT OR REPLACE INTO http_cache
            (key, url, headers, body, status, expires_at, used, size)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (key, clean_url, json.dumps(clean_headers), compressed, status, expires_at, now, size))
        count,total = conn.execute('SELECT COUNT(*),COALESCE(SUM(size),0) FROM http_cache').fetchone()
        if total > 256 * 1024 * 1024 or count>10000:
            conn.execute('DELETE FROM http_cache WHERE expires_at < ?', (now,))
            rows=conn.execute('SELECT key,size FROM http_cache ORDER BY (expires_at-used>86400) DESC,used DESC').fetchall()
            kept=0;used=0;remove=[]
            for cache_key,cache_size in rows:
                if kept>=10000 or used+cache_size>240*1024*1024:remove.append((cache_key,))
                else:kept+=1;used+=cache_size
            conn.executemany('DELETE FROM http_cache WHERE key=?',remove)
        conn.commit()
    except Exception:
        pass
    finally:
        if conn:
            try: conn.close()
            except Exception: pass


_OPENALEX_ALLOWANCE = {'remaining': None, 'at': 0.0}


def _note_openalex_allowance(headers):
    """Remember OpenAlex's reported remaining daily allowance (X-RateLimit-Remaining)."""
    try:
        value = headers.get('x-ratelimit-remaining') if headers is not None else None
        if value is not None:
            _OPENALEX_ALLOWANCE.update(remaining=int(value), at=time.monotonic())
    except (TypeError, ValueError, AttributeError):
        pass


def openalex_allowance_remaining(max_age=3600):
    """Last reported OpenAlex allowance, or None when unknown or older than max_age seconds."""
    if _OPENALEX_ALLOWANCE['remaining'] is None or time.monotonic() - _OPENALEX_ALLOWANCE['at'] > max_age:
        return None
    return _OPENALEX_ALLOWANCE['remaining']


def _request_json_once(request, timeout=14, cache=True):
    """Cache successful responses, bound per-host concurrency, and honor Retry-After."""
    check_cancelled()
    url = request.full_url
    key = hashlib.sha256((url + repr(request.header_items())).encode() + (request.data or b'')).hexdigest()
    disk_key = _disk_http_cache_key(request)
    host = urllib.parse.urlparse(url).hostname or ''
    with _CACHE_LOCK:
        entry = _JSON_CACHE.get(key)
        if cache and entry and time.monotonic() - entry[0] < 600:
            _JSON_CACHE.move_to_end(key)
            return json.loads(entry[1])
    if cache:
        disk_val = _disk_http_cache_get(disk_key, request)
        if disk_val is not None:
            with _CACHE_LOCK:
                _JSON_CACHE[key] = (time.monotonic(), json.dumps(disk_val))
                _JSON_CACHE.move_to_end(key)
            return disk_val
    if hasattr(request, 'add_unredirected_header') and not any(k.lower() == 'accept-encoding' for k, _ in request.header_items()):
        request.add_unredirected_header('Accept-Encoding', 'gzip')
    limit = 10 if 'openalex.org' in host else 2  # OpenAlex allows 10 requests/second, with or without a key
    with _CACHE_LOCK:
        gate = _PROVIDER_GATES.setdefault(host, threading.BoundedSemaphore(limit))
    check_source(request)
    while not gate.acquire(timeout=.1):
        check_cancelled()
    if 'nih.gov' in host:
        with _NCBI_LOCK:
            elapsed = time.monotonic() - _NCBI_LAST_TIME[0]
            if elapsed < 0.34:
                time.sleep(0.34 - elapsed)
            _NCBI_LAST_TIME[0] = time.monotonic()
    try:
        for attempt in range(3):
            check_cancelled()
            check_source(request)
            try:
                remaining = remaining_budget()
                counter = getattr(REQUEST_CONTEXT, 'request_counter', None)
                if counter:
                    with counter['lock']:
                        if counter['remaining'] <= 0: raise DiscoveryBudgetExceeded('Search request budget reached; showing collected results.')
                        counter['remaining'] -= 1
                request_timeout = min(timeout, max(.1, remaining)) if remaining is not None else timeout
                try:
                    with _urlopen_persistent(request, timeout=request_timeout) as response:
                        if 'openalex.org' in host: _note_openalex_allowance(getattr(response, 'headers', None))
                        raw = response.read()
                        if (isinstance(raw, bytes) and raw.startswith(b'\x1f\x8b')) or (getattr(response, 'headers', None) and getattr(response.headers, 'get', lambda k, d='': d)('content-encoding', '').lower() == 'gzip'):
                            try:
                                raw = gzip.decompress(raw)
                            except Exception:
                                pass
                        data = json.loads(raw.decode('utf-8') if isinstance(raw, bytes) else raw)
                except (urllib.error.HTTPError, DiscoveryCancelled, DiscoveryBudgetExceeded, ProviderCooldown):
                    raise
                except Exception:
                    with _urlopen_fallback(request, timeout=request_timeout) as response:
                        raw = response.read()
                        if (isinstance(raw, bytes) and raw.startswith(b'\x1f\x8b')) or (getattr(response, 'headers', None) and getattr(response.headers, 'get', lambda k, d='': d)('content-encoding', '').lower() == 'gzip'):
                            try:
                                raw = gzip.decompress(raw)
                            except Exception:
                                pass
                        data = json.loads(raw.decode('utf-8') if isinstance(raw, bytes) else raw)
                check_cancelled()
                source_succeeded(request)
                encoded=json.dumps(data) if cache else ''
                if cache and len(encoded)<=1_000_000:
                    with _CACHE_LOCK:
                        _JSON_CACHE[key] = (time.monotonic(), encoded)
                        _JSON_CACHE.move_to_end(key)
                        while len(_JSON_CACHE) > 500 or sum(len(value[1]) for value in _JSON_CACHE.values()) > 16_000_000:
                            _JSON_CACHE.popitem(last=False)
                if cache and not _disk_http_cache_skippable(request):
                    req_hdrs = dict(request.header_items()) if hasattr(request, 'header_items') else {}
                    _disk_http_cache_set(disk_key, url, req_hdrs, data, status=200)
                return data
            except urllib.error.HTTPError as error:
                source_failed(request,error)
                try: check_source(request)
                except ProviderCooldown:
                    error.close()
                    raise
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
            except (DiscoveryCancelled,DiscoveryBudgetExceeded):
                raise
            except (urllib.error.URLError,TimeoutError,OSError,ValueError) as error:
                source_failed(request,error)
                raise
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
            if on_progress and on_progress(dict(results), list(completed), dict(errors), len(tasks)):
                break
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
