"""Bounded local pairwise reranking in an isolated optional runtime."""
import json
import collections
import hashlib
import math
import os
from pathlib import Path
import subprocess
import time
import re
import threading
import sqlite3
from pulse_core.platform_support import config_directory
from pulse_performance import DiscoveryCancelled

_score_cache=collections.OrderedDict()
_cache_lock=threading.RLock()
_inference_lock=threading.Lock()
# Passages scored per paper. Mac rankers shipped in 1.7.12-1.8.1 were frozen
# before the window cap existed and always scored up to four spread windows;
# 4 reproduces their scores exactly. One window is faster but changes
# rankings, so it needs validation on labelled benchmarks before use.
PAIRWISE_MAX_WINDOWS = 4


def _cached_crossencoder_disk(config_dir, keys, scores=None):
    """Read/write cross-encoder scores in one transaction; keyed by SHA256 hashes."""
    if not keys: return {}
    connection = None
    db_path = config_dir / 'crossencoder-cache.sqlite3'
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(db_path), timeout=2)
        os.chmod(db_path, 0o600)
        connection.execute('CREATE TABLE IF NOT EXISTS crossencoder_scores (key TEXT PRIMARY KEY, score REAL NOT NULL, used REAL NOT NULL)')
        now = time.time()
        if scores is not None:
            connection.executemany('INSERT OR REPLACE INTO crossencoder_scores VALUES (?, ?, ?)',
                                   [(k, float(s), now) for k, s in scores.items()])
            connection.execute('DELETE FROM crossencoder_scores WHERE key IN (SELECT key FROM crossencoder_scores ORDER BY used DESC LIMIT -1 OFFSET 4000)')
            connection.commit()
            return scores
        placeholders = ','.join('?' for _ in keys)
        rows = dict(connection.execute('SELECT key, score FROM crossencoder_scores WHERE key IN ('+placeholders+')', list(keys)))
        if rows:
            connection.execute('UPDATE crossencoder_scores SET used=? WHERE key IN ('+placeholders+')', [now, *rows.keys()])
            connection.commit()
        return rows
    except (OSError, sqlite3.Error, ValueError):
        return {}
    finally:
        if connection:
            try: connection.close()
            except Exception: pass



def ranking_excerpt(paper,queries):
    """One query-focused window; the stored paper and preview stay complete."""
    text=(str(paper.get('abstract') or '')+'\n'+' '.join(str(p.get('text') or '') for p in paper.get('matchedPassages') or []))[:16000]
    words=text.split()
    query_words=set(re.findall(r'\w+', ' '.join(map(str,queries)).casefold()))
    windows=[words[offset:offset+120] for offset in range(0,max(1,len(words)),80)]
    def evidence(window):
        tokens=set(re.findall(r'\w+',' '.join(window).casefold()))
        return len(tokens&query_words)
    best=max(windows,key=evidence)
    return {'title':str(paper.get('title') or '')[:1600],'abstract':' '.join(best)}


def clear_score_cache():
    with _cache_lock:_score_cache.clear()


def _find_search_runtime(settings):
    py_env = os.environ.get('PULSE_RERANKER_PYTHON') or settings.get('searchRerankerPython')
    mod_env = os.environ.get('PULSE_RERANKER_MODEL') or settings.get('searchRerankerModel')
    if py_env and mod_env:
        py_path, mod_path = Path(py_env), Path(mod_env)
        if py_path.is_file() and mod_path.is_dir():
            return py_path, mod_path

    here = Path(__file__).resolve()
    candidate_roots = [here.parent.parent / '.search-runtime']
    for parent in here.parents:
        if (parent / 'desktop/src-tauri/tauri.conf.json').is_file():
            candidate_roots.append(parent / '.search-runtime')
            break
        if parent.name == 'Pulse.app':
            break
    config_dir = os.environ.get('PULSE_CONFIG_DIR')
    if config_dir:
        candidate_roots.append(Path(config_dir) / '.search-runtime')
    candidate_roots.extend([
        Path.home() / 'Library/Application Support/pulse/.search-runtime',
        Path.home() / 'AppData/Local/Pulse/.search-runtime',
        Path.home() / '.pulse/.search-runtime',
    ])

    model_type = str(settings.get('searchRerankerModelType') or os.environ.get('PULSE_RERANKER_MODEL_TYPE') or 'general').lower()

    # Bundled executables carry the interpreter and inference dependencies.
    # Relative manifest paths make installed and relocated apps equivalent.
    for root in candidate_roots:
        manifest_name = 'manifest-biomedical.json' if model_type == 'biomedical' and (root / 'manifest-biomedical.json').is_file() else 'manifest.json'
        manifest = root / manifest_name
        if not manifest.is_file(): continue
        try:
            data = json.loads(manifest.read_text())
            if data.get('format') != 'onnx-executable-v1': continue
            executable = (root / data['executable']).resolve()
            model = (root / data['modelDirectory']).resolve()
            executable.relative_to(root.resolve()); model.relative_to(root.resolve())
            if executable.is_file() and (model / 'model.onnx').is_file() and (model / 'tokenizer.json').is_file():
                return executable, model
        except (KeyError, ValueError, TypeError, OSError):
            continue

    # A developer install must contain its venv; an old absolute manifest path
    # to the builder's base Python is not a usable inference runtime.
    for root in candidate_roots:
        python = root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        model = root / 'model'
        if python.is_file() and (model / 'model.safetensors').is_file() and (root / 'pyvenv.cfg').is_file():
            return python, model
    return None, None


def crossencoder_scores(settings, queries, records, cancel_event=None, nonblocking=False):
    if cancel_event and cancel_event.is_set():raise DiscoveryCancelled()
    if not records:return [], 'No papers require pairwise ranking.'
    python, model = _find_search_runtime(settings)
    if not python or not model:
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    worker = Path(__file__).with_name('reranker_worker.py')
    prepared=[ranking_excerpt(paper,queries[:2]) for paper in records]
    files=[python,model/'model.onnx',model/'model.safetensors',model/'tokenizer.json',worker]
    try:fingerprint=tuple((str(path.resolve()),path.stat().st_mtime_ns,path.stat().st_size) for path in files if path.is_file())
    except OSError:return None,'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    keys=[hashlib.sha256(json.dumps([fingerprint,queries[:2],paper,f'windows-{PAIRWISE_MAX_WINDOWS}-v1'],ensure_ascii=False).encode()).hexdigest() for paper in prepared]
    started=time.monotonic()
    if nonblocking:
        # Background pre-scoring never waits behind foreground ranking.
        if not _inference_lock.acquire(blocking=False):return None,'Pairwise ranking busy.'
    else:
        while not _inference_lock.acquire(timeout=.05):
            if cancel_event and cancel_event.is_set():raise DiscoveryCancelled()
            if time.monotonic()-started>12:return None,'Pairwise ranking time budget reached; showing collected results.'
    try:
        cfg_dir = config_directory()
        with _cache_lock:
            missing=list(dict.fromkeys(key for key in keys if key not in _score_cache))
        if missing:
            disk_hits = _cached_crossencoder_disk(cfg_dir, missing)
            if disk_hits:
                with _cache_lock:
                    for k, s in disk_hits.items():
                        _score_cache[k] = s
                missing = [k for k in missing if k not in disk_hits]
        if not missing:
            with _cache_lock:return [_score_cache[key] for key in keys], 'Titles and abstracts assessed together with your research question.'
        positions={key:index for index,key in enumerate(keys)}
        payload_data = {'model': str(model.resolve()), 'queries': queries[:2],
            'records':[prepared[positions[key]] for key in missing], 'maxWindows':PAIRWISE_MAX_WINDOWS}
        scores,notice=_infer(python,worker,payload_data,len(missing),cancel_event,max(1,12-(time.monotonic()-started)))
        if scores is None:return None,notice
        with _cache_lock:
            for key,score in zip(missing,scores):
                _score_cache[key]=score;_score_cache.move_to_end(key)
            result=[_score_cache[key] for key in keys]
            while len(_score_cache)>4096:_score_cache.popitem(last=False)
        _cached_crossencoder_disk(cfg_dir, missing, dict(zip(missing, scores)))
        return result,notice
    finally:_inference_lock.release()


PRE_SCORE_BATCH = 16


def pre_score_crossencoder(settings, queries, records, cancel_event=None, stop_event=None):
    """Fill the score cache for likely shortlist papers while collection continues.

    Batches stay small so foreground ranking waits at most one short batch, and
    the inference lock is taken only inside crossencoder_scores (it is not
    re-entrant). Results are cache entries only; ranking is unchanged.
    """
    if not records: return
    python, model = _find_search_runtime(settings)
    if not python or not model: return
    for offset in range(0, len(records), PRE_SCORE_BATCH):
        if (cancel_event and cancel_event.is_set()) or (stop_event and stop_event.is_set()): return
        try:
            scores, _ = crossencoder_scores(settings, queries, records[offset:offset + PRE_SCORE_BATCH],
                                            cancel_event=cancel_event, nonblocking=True)
        except Exception:
            return
        if scores is None: return


import atexit
import queue
import uuid

_WORKER_PROC = None
_WORKER_LOCK = threading.Lock()
_WORKER_KEY = None


def _stop_worker():
    global _WORKER_PROC, _WORKER_KEY
    with _WORKER_LOCK:
        if _WORKER_PROC is not None:
            try:
                if _WORKER_PROC.poll() is None:
                    _WORKER_PROC.kill()
                # The reader thread owns stdout, so wait rather than communicate().
                _WORKER_PROC.wait(timeout=0.5)
                if _WORKER_PROC.stdin: _WORKER_PROC.stdin.close()
            except Exception:
                pass
            _WORKER_PROC = None
            _WORKER_KEY = None

atexit.register(_stop_worker)


def _get_worker(python, worker):
    global _WORKER_PROC, _WORKER_KEY
    current_key = (str(python.resolve()), str(worker.resolve()))
    with _WORKER_LOCK:
        if _WORKER_PROC is not None:
            if _WORKER_PROC.poll() is None and _WORKER_KEY == current_key:
                return _WORKER_PROC
            try:
                if _WORKER_PROC.poll() is None:
                    _WORKER_PROC.kill()
            except Exception:
                pass
            _WORKER_PROC = None

        command = [str(python)] if python.name in ('pulse-reranker', 'pulse-reranker.exe') else [str(python), str(worker)]
        proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        )
        proc._pulse_lines = queue.Queue()
        threading.Thread(target=_pump_worker_output, args=(proc,), name='pulse-reranker-reader', daemon=True).start()
        _WORKER_PROC = proc
        _WORKER_KEY = current_key
        return _WORKER_PROC


def _pump_worker_output(process):
    """Move worker output lines into a queue so reads honour deadlines on every platform."""
    lines = process._pulse_lines
    try:
        for line in process.stdout:
            lines.put(line)
    except (OSError, ValueError):
        pass
    finally:
        lines.put('')  # End of stream: the worker exited or its pipe closed.


def _read_worker_line(process, cancel_event, deadline):
    """Next worker output line; None at the deadline, '' when the worker has exited."""
    lines = getattr(process, '_pulse_lines', None)
    if lines is None:
        return process.stdout.readline()
    while True:
        if cancel_event and cancel_event.is_set():
            raise DiscoveryCancelled()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            return lines.get(timeout=min(0.1, remaining))
        except queue.Empty:
            continue


PERSISTENT_PROTOCOL = 'jsonl-v1'
_protocol_cache = {}


def _supports_persistent(python):
    """Source workers in this checkout speak JSON lines; a frozen runtime must declare it.

    Runtimes frozen before the persistent protocol read one JSON document until
    end of input, so they are driven in single-shot mode instead.
    """
    if python.name not in ('pulse-reranker', 'pulse-reranker.exe'):
        return True
    key = str(python)
    if key not in _protocol_cache:
        supported = False
        for parent in python.parents:
            manifest = parent / 'manifest.json'
            if manifest.is_file():
                try:
                    supported = json.loads(manifest.read_text()).get('protocol') == PERSISTENT_PROTOCOL
                except (OSError, ValueError):
                    supported = False
                break
        _protocol_cache[key] = supported
    return _protocol_cache[key]


def _validated_scores(scores, count):
    if not isinstance(scores, list) or len(scores) != count:
        return None
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in scores):
        return None
    return scores


def _infer_single_shot(python, worker, payload_dict, count, cancel_event, timeout):
    """One process per request: write the payload, close input, read one result."""
    unavailable = 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    try:
        command = [str(python)] if python.name in ('pulse-reranker', 'pulse-reranker.exe') else [str(python), str(worker)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError:
        return None, unavailable
    payload = json.dumps(payload_dict, ensure_ascii=False)
    started = time.monotonic()
    try:
        sent = False
        while True:
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            if time.monotonic() - started > timeout:
                return None, 'Pairwise ranking time budget reached; showing collected results.'
            try:
                output, _ = process.communicate(payload if not sent else None, timeout=.15)
                break
            except subprocess.TimeoutExpired:
                sent = True
        if process.returncode: return None, unavailable
        scores = _validated_scores(json.loads(output).get('scores'), count)
        if scores is None: return None, unavailable
        return scores, 'Titles and abstracts assessed together with your research question.'
    except DiscoveryCancelled:
        raise
    except (ValueError, KeyError, OSError, AttributeError):
        return None, unavailable
    finally:
        if process.poll() is None: process.kill()
        try: process.communicate(timeout=1)
        except Exception: pass


def _infer(python, worker, payload_dict, count, cancel_event, timeout):
    if not _supports_persistent(python):
        return _infer_single_shot(python, worker, payload_dict, count, cancel_event, timeout)
    deadline = time.monotonic() + timeout
    req_id = str(uuid.uuid4())
    req_payload = dict(payload_dict, id=req_id)
    raw_json = json.dumps(req_payload, ensure_ascii=False) + '\n'

    for attempt in range(2):
        if cancel_event and cancel_event.is_set():
            raise DiscoveryCancelled()
        if time.monotonic() >= deadline:
            return None, 'Pairwise ranking time budget reached; showing collected results.'
        try:
            process = _get_worker(python, worker)
        except OSError:
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'

        try:
            process.stdin.write(raw_json)
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            _stop_worker()
            if attempt == 0:
                continue
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'

        line = _read_worker_line(process, cancel_event, deadline)
        if line is None:
            _stop_worker()
            return None, 'Pairwise ranking time budget reached; showing collected results.'
        if not line:
            _stop_worker()
            if attempt == 0:
                continue
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'

        try:
            resp = json.loads(line)
        except Exception:
            _stop_worker()
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'

        if resp.get('id') != req_id:
            _stop_worker()
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'

        if 'error' in resp:
            return None, f"Pairwise ranking error: {resp['error']}"

        scores = resp.get('scores')
        if not isinstance(scores, list) or len(scores) != count:
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in scores):
            return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
        return scores, 'Titles and abstracts assessed together with your research question.'

    return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'


def warmup_crossencoder(settings):
    """Background warmup of persistent worker process and model."""
    python, model = _find_search_runtime(settings)
    if not python or not model or not _supports_persistent(python):
        return  # A single-shot runtime starts per request, so there is nothing to keep warm.
    worker = Path(__file__).with_name('reranker_worker.py')
    dummy_payload = {
        'model': str(model.resolve()),
        'queries': ['warmup query'],
        'records': [{'title': 'Warmup Title', 'abstract': 'Warmup abstract'}],
        'maxWindows': PAIRWISE_MAX_WINDOWS
    }
    if not _inference_lock.acquire(blocking=False):
        return
    try:
        _infer(python, worker, dummy_payload, 1, None, timeout=15)
    except Exception:
        pass
    finally:
        _inference_lock.release()

