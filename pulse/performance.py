"""Bounded discovery jobs, provider requests, and persistent embedding reuse."""
import hashlib
from email.utils import parsedate_to_datetime
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

import logging
from .context import get_context, contextual, ClientError

logger = logging.getLogger(__name__)


class DiscoveryCancelled(Exception):
    pass


def check_cancelled():
    event = getattr(get_context().request_context, 'cancel_event', None)
    if event and event.is_set():
        raise DiscoveryCancelled()


def _wait(seconds):
    event = getattr(get_context().request_context, 'cancel_event', None)
    if event:
        if event.wait(seconds):
            raise DiscoveryCancelled()
    else:
        time.sleep(seconds)


def request_json(request, timeout=14, cache=True):
    """Cache successful responses, bound per-host concurrency, and honor Retry-After."""
    check_cancelled()
    url = request.full_url
    key = hashlib.sha256((url + repr(request.header_items())).encode() + (request.data or b'')).hexdigest()
    host = urllib.parse.urlparse(url).hostname or ''
    with get_context().cache_lock:
        entry = get_context().json_cache.get(key)
        if cache and entry and time.monotonic() - entry[0] < 600:
            get_context().json_cache.move_to_end(key)
            return json.loads(entry[1])
        gate = get_context().provider_gates.setdefault(host, threading.BoundedSemaphore(2))
    while not gate.acquire(timeout=.1):
        check_cancelled()
    try:
        for attempt in range(3):
            check_cancelled()
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    data = json.loads(response.read().decode('utf-8'))
                check_cancelled()
                encoded=json.dumps(data) if cache else ''
                if cache and len(encoded)<=1_000_000:
                    with get_context().cache_lock:
                        get_context().json_cache[key] = (time.monotonic(), encoded)
                        get_context().json_cache.move_to_end(key)
                        while len(get_context().json_cache) > 500 or sum(len(value[1]) for value in get_context().json_cache.values()) > 16_000_000:
                            get_context().json_cache.popitem(last=False)
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


def parallel_branches(tasks, on_progress=None, cancel_event=None):
    """At most three branches run; per-provider requests are separately bounded."""
    results, errors, completed = {}, {}, []
    def run(fn):
        get_context().request_context.cancel_event = cancel_event
        try:
            check_cancelled()
            return fn()
        finally:
            get_context().request_context.cancel_event = None
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix='pulse-discovery') as executor:
        futures = {executor.submit(contextual(run), fn): name for name, fn in tasks.items()}
        for future in as_completed(futures):
            name = futures[future]
            if cancel_event and cancel_event.is_set():
                for pending in futures:
                    pending.cancel()
                raise DiscoveryCancelled()
            try:
                results[name] = future.result()
                completed.append(name)
            except DiscoveryCancelled:
                raise
            except Exception as error:
                logger.exception("Discovery branch failed: %s", name)
                errors[name] = str(error) or type(error).__name__
            if on_progress:
                on_progress(dict(results), list(completed), dict(errors), len(tasks))
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
                logger.exception("Discovery job failed")
                with self.lock:
                    if not job['_event'].is_set():
                        job.update(status='failed', error=str(error))
            finally:
                with self.lock:
                    job['_finished'] = True
        threading.Thread(target=contextual(run), name='pulse-discovery-job', daemon=True).start()
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
    """Reuse vectors across questions and restarts; raw document text is never stored."""
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode() + b'\0' + text.encode()).hexdigest()
    lock = get_context().embedding_locks[int(key[:2], 16) % len(get_context().embedding_locks)]
    with lock:
        path = config_dir / 'embedding-cache.sqlite3'
        connection = None
        try:
            config_dir.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(str(path), timeout=5)
            os.chmod(path, 0o600)
            connection.execute('CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL, used REAL NOT NULL)')
            row = connection.execute('SELECT vector FROM embeddings WHERE key = ?', (key,)).fetchone()
            if row:
                connection.execute('UPDATE embeddings SET used = ? WHERE key = ?', (time.time(), key))
                connection.commit()
                return json.loads(row[0])
        except (OSError, sqlite3.Error, ValueError) as error:
            logger.warning("Embedding cache read failed (%s)", type(error).__name__)
            if connection:
                connection.close()
            connection = None
        try:
            vector = compute()
            if vector and connection:
                try:
                    connection.execute('INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)', (key, json.dumps(vector), time.time()))
                    connection.execute('DELETE FROM embeddings WHERE key IN (SELECT key FROM embeddings ORDER BY used DESC LIMIT -1 OFFSET 1000)')
                    connection.commit()
                except sqlite3.Error as error:
                    logger.warning("Embedding cache write failed (%s)", type(error).__name__)
            return vector
        finally:
            if connection:
                connection.close()


def parallel_lookup(fetcher, items):
    """Fetch small metadata batches in order, with shared provider gates and cancellation."""
    event = getattr(get_context().request_context, 'cancel_event', None)
    def fetch(item):
        get_context().request_context.cancel_event = event
        try:
            check_cancelled()
            return item, fetcher(item)
        except DiscoveryCancelled:
            raise
        except (ClientError, urllib.error.URLError, TimeoutError, ValueError) as error:
            logger.warning("Metadata batch item failed (%s)", type(error).__name__)
            return item, None
        finally:
            get_context().request_context.cancel_event = None
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='pulse-metadata') as executor:
        return list(executor.map(lambda task: task(), [contextual(lambda item=item: fetch(item)) for item in items]))
