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
from pulse_performance import DiscoveryCancelled

_score_cache=collections.OrderedDict()
_cache_lock=threading.RLock()
_inference_lock=threading.Lock()


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

    # Bundled executables carry the interpreter and inference dependencies.
    # Relative manifest paths make installed and relocated apps equivalent.
    for root in candidate_roots:
        manifest = root / 'manifest.json'
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


def crossencoder_scores(settings, queries, records, cancel_event=None):
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
    keys=[hashlib.sha256(json.dumps([fingerprint,queries[:2],paper,'single-window-v1'],ensure_ascii=False).encode()).hexdigest() for paper in prepared]
    started=time.monotonic()
    while not _inference_lock.acquire(timeout=.05):
        if cancel_event and cancel_event.is_set():raise DiscoveryCancelled()
        if time.monotonic()-started>12:return None,'Pairwise ranking time budget reached; showing collected results.'
    try:
        with _cache_lock:
            missing=list(dict.fromkeys(key for key in keys if key not in _score_cache))
        if not missing:
            with _cache_lock:return [_score_cache[key] for key in keys], 'Titles and abstracts assessed together with your research question.'
        positions={key:index for index,key in enumerate(keys)}
        payload = json.dumps({'model': str(model.resolve()), 'queries': queries[:2],
            'records':[prepared[positions[key]] for key in missing], 'maxWindows':1}, ensure_ascii=False)
        scores,notice=_infer(python,worker,payload,len(missing),cancel_event,max(1,12-(time.monotonic()-started)))
        if scores is None:return None,notice
        with _cache_lock:
            for key,score in zip(missing,scores):
                _score_cache[key]=score;_score_cache.move_to_end(key)
            result=[_score_cache[key] for key in keys]
            while len(_score_cache)>4096:_score_cache.popitem(last=False)
        return result,notice
    finally:_inference_lock.release()


def _infer(python,worker,payload,count,cancel_event,timeout):
    try:
        command = [str(python)] if python.name in ('pulse-reranker', 'pulse-reranker.exe') else [str(python), str(worker)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError:
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    started = time.monotonic()
    try:
        sent = False
        while True:
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            if time.monotonic()-started > timeout: return None, 'Pairwise ranking time budget reached; showing collected results.'
            try:
                output, _ = process.communicate(payload if not sent else None, timeout=.15)
                break
            except subprocess.TimeoutExpired:
                sent = True
        if process.returncode: return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
        scores = json.loads(output)['scores']
        if len(scores) != count or any(isinstance(v,bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in scores): raise ValueError('Invalid pairwise scores')
        return scores, 'Titles and abstracts assessed together with your research question.'
    except DiscoveryCancelled: raise
    except (ValueError, KeyError, OSError):
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    finally:
        if process.poll() is None: process.kill()
        process.communicate()
