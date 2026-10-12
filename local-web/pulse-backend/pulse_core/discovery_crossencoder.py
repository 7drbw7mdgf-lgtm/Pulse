"""Bounded local pairwise reranking in an isolated optional runtime."""
import json
import math
import os
from pathlib import Path
import subprocess
import time
from pulse_performance import DiscoveryCancelled


def _find_search_runtime(settings):
    py_env = os.environ.get('PULSE_RERANKER_PYTHON') or settings.get('searchRerankerPython')
    mod_env = os.environ.get('PULSE_RERANKER_MODEL') or settings.get('searchRerankerModel')
    if py_env and mod_env:
        py_path, mod_path = Path(py_env), Path(mod_env)
        if py_path.is_file() and mod_path.is_dir():
            return py_path, mod_path

    here = Path(__file__).resolve()
    candidate_roots = []
    for parent in here.parents:
        candidate_roots.append(parent / '.search-runtime')
        if parent.name in ('Pulse.app', 'repo', 'Pulse', 'pulse-backend', 'src-tauri'):
            if parent.parent: candidate_roots.append(parent.parent / '.search-runtime')
            break
    config_dir = os.environ.get('PULSE_CONFIG_DIR')
    if config_dir:
        candidate_roots.append(Path(config_dir) / '.search-runtime')
    candidate_roots.extend([
        Path.home() / 'Library/Application Support/pulse/.search-runtime',
        Path.home() / 'AppData/Local/Pulse/.search-runtime',
        Path.home() / '.pulse/.search-runtime',
    ])

    # First, look for an all-in-one root (python + model)
    for root in candidate_roots:
        python = root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        model = root / 'model'
        if python.is_file() and model.is_dir():
            return python, model

    # Second, look for model directory across candidate roots
    found_model = None
    for root in candidate_roots:
        model = root / 'model' if root.name == '.search-runtime' else root
        if (model / 'model.safetensors').is_file() and (model / 'config.json').is_file():
            found_model = model
            # Check if root has a manifest pointing to python
            manifest = (root if root.name == '.search-runtime' else root.parent) / 'manifest.json'
            if manifest.is_file():
                try:
                    data = json.loads(manifest.read_text())
                    py_candidate = Path(data.get('python', ''))
                    if py_candidate.is_file():
                        return py_candidate, found_model
                except Exception:
                    pass
            break

    if not found_model:
        return None, None

    # Check potential external pythons if model is found
    for root in candidate_roots:
        py = root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if py.is_file():
            return py, found_model

    return None, None


def crossencoder_scores(settings, queries, records, cancel_event=None):
    python, model = _find_search_runtime(settings)
    if not python or not model:
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    worker = Path(__file__).with_name('reranker_worker.py')
    payload = json.dumps({'model': str(model.resolve()), 'queries': queries[:2], 'records': records}, ensure_ascii=False)
    try:
        process = subprocess.Popen([str(python), str(worker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError:
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    started = time.monotonic()
    try:
        sent = False
        while True:
            if cancel_event and cancel_event.is_set(): raise DiscoveryCancelled()
            if time.monotonic()-started > 30: return None, 'Pairwise ranking time budget reached; showing collected results.'
            try:
                output, _ = process.communicate(payload if not sent else None, timeout=.15)
                break
            except subprocess.TimeoutExpired:
                sent = True
        if process.returncode: return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
        scores = json.loads(output)['scores']
        if len(scores) != len(records) or any(not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in scores): raise ValueError('Invalid pairwise scores')
        return scores, 'Titles and abstracts assessed together with your research question.'
    except DiscoveryCancelled: raise
    except (ValueError, KeyError, OSError):
        return None, 'Pairwise ranking unavailable; using text, meaning and citation evidence.'
    finally:
        if process.poll() is None: process.kill()
        process.communicate()
