"""Bounded local pairwise reranking in an isolated optional runtime."""
import json
import math
import os
from pathlib import Path
import subprocess
import time
from pulse_performance import DiscoveryCancelled


def crossencoder_scores(settings, queries, records, cancel_event=None):
    root = Path(__file__).resolve().parents[3] / '.search-runtime'
    python = Path(os.environ.get('PULSE_RERANKER_PYTHON') or settings.get('searchRerankerPython') or root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))
    model = Path(os.environ.get('PULSE_RERANKER_MODEL') or settings.get('searchRerankerModel') or root / 'model')
    if not python.is_file() or not model.is_dir():
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
