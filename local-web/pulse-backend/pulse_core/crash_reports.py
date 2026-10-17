"""Local crash and memory reports, sent only when the user chooses Send.

Reports are redacted before they are written: no paper titles, notes, search text, keys,
e-mail addresses or home-folder paths. They keep error types, code locations, app version,
macOS version and memory use, which is enough to find the fault.
"""
import json
import os
import platform
import re
import secrets
import sys
import threading
import time
import traceback
from pathlib import Path
from pulse_core.constants import APP_VERSION, CONFIG_DIR, ClientError

MAX_REPORTS = 50
MEMORY_LIMIT_MB = int(os.environ.get('PULSE_MEMORY_REPORT_MB') or 3072)
_LOCK = threading.Lock()
_STARTED = time.time()
_MEMORY_REPORTED = False
_ID = re.compile(r'^[A-Za-z0-9_-]{8,64}$')


def _folder():
    path = CONFIG_DIR / 'crash-reports'
    path.mkdir(parents=True, exist_ok=True)
    return path


def scrub(text, limit=600):
    """Remove anything that could carry library content or personal data from a message."""
    text = str(text or '')
    text = re.sub(r'[\w.+-]+@[\w-]+\.[\w.-]+', '<email>', text)
    text = re.sub(r'https?://([^/\s"\']+)[^\s"\']*', lambda m: f'https://{m.group(1)}/…', text)
    text = text.replace(str(Path.home()), '~')
    text = re.sub(r'/Users/[^/\s"\']+', '~', text)
    text = re.sub(r'("[^"]{0,2000}"|\'[^\']{0,2000}\'|`[^`]{0,2000}`)', '"…"', text)  # quoted values: titles, queries, keys
    text = re.sub(r'\b(sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{8,}', r'\1-…', text, flags=re.I)
    text = re.sub(r'\b[A-Za-z0-9_-]{32,}\b', '…', text)  # long opaque strings (tokens, codes)
    text = re.sub(r'\b10\.\d{4,9}/\S+', '<doi>', text)
    return text[:limit]


def _frames(stack):
    """Keep only file name, line and function for each frame."""
    frames = []
    for line in str(stack or '').splitlines():
        line = line.strip()
        python = re.match(r'File "([^"]+)", line (\d+), in (\S+)', line)
        browser = re.match(r'(?:at\s+)?([\w.$<>\[\] ]*?)\s*\(?((?:https?|file|tauri|asset)://[^\s)]+?|/[^\s)]+?):(\d+)(?::\d+)?\)?$', line)
        if python: frames.append(f'{Path(python.group(1)).name}:{python.group(2)} {python.group(3)}')
        elif browser: frames.append(f'{Path(browser.group(2).split("?")[0]).name}:{browser.group(3)} {(browser.group(1) or "").strip() or "<anonymous>"}'.strip())
    return frames[-40:]


def _memory_mb():
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(peak / (1024 * 1024 if sys.platform == 'darwin' else 1024))  # macOS reports bytes, Linux KiB
    except Exception:
        return None


def record(kind, error_type, message='', stack='', context=None):
    """Write one redacted report. Returns its ID (or None when the store is full of duplicates)."""
    report = {
        'id': secrets.token_urlsafe(12), 'kind': str(kind)[:32], 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'appVersion': APP_VERSION, 'os': f'{platform.system()} {platform.mac_ver()[0] or platform.release()}',
        'arch': platform.machine(), 'python': platform.python_version(),
        'uptimeSeconds': round(time.time() - _STARTED), 'peakMemoryMB': _memory_mb(),
        'errorType': scrub(error_type, 120), 'message': scrub(message), 'frames': _frames(stack),
        'context': {str(k)[:40]: scrub(v, 120) for k, v in (context or {}).items() if k in {'endpoint', 'view', 'phase', 'source'}},
        'sent': False,
    }
    with _LOCK:
        folder = _folder()
        signature = (report['kind'], report['errorType'], tuple(report['frames'][-3:]))
        existing = sorted(folder.glob('*.json'))
        for path in existing[-10:]:  # the same fault repeating does not flood the list
            try: item = json.loads(path.read_text())
            except Exception: continue
            if (item.get('kind'), item.get('errorType'), tuple(item.get('frames', [])[-3:])) == signature and not item.get('sent'):
                item['repeats'] = int(item.get('repeats') or 1) + 1
                path.write_text(json.dumps(item)); return item['id']
        (folder / f"{int(time.time() * 1000)}-{report['id']}.json").write_text(json.dumps(report))
        for path in sorted(folder.glob('*.json'))[:-MAX_REPORTS]: path.unlink(missing_ok=True)
    return report['id']


def record_exception(kind, error, context=None):
    stack = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
    return record(kind, type(error).__name__, str(error), stack, context)


def _find(report_id):
    if not isinstance(report_id, str) or not _ID.fullmatch(report_id): raise ClientError(400, 'Invalid report.')
    for path in _folder().glob(f'*-{report_id}.json'): return path
    raise ClientError(404, 'That report was not found.')


def list_reports(payload=None):
    with _LOCK:
        items = []
        for path in sorted(_folder().glob('*.json'), reverse=True):
            try: item = json.loads(path.read_text())
            except Exception: continue
            items.append({k: item.get(k) for k in ('id', 'kind', 'createdAt', 'appVersion', 'errorType', 'sent', 'repeats', 'dismissed')})
    return {'ok': True, 'reports': items, 'unsent': sum(1 for i in items if not i['sent'] and not i.get('dismissed'))}


def get_report(payload):
    """The exact JSON that Send would upload."""
    with _LOCK: item = json.loads(_find(payload.get('id')).read_text())
    item.pop('dismissed', None)
    return {'ok': True, 'report': item}


def send_report(payload):
    from pulse_core.sync_relay import post
    with _LOCK:
        path = _find(payload.get('id'))
        item = json.loads(path.read_text())
    upload = {k: v for k, v in item.items() if k not in {'sent', 'dismissed'}}
    post('/reports/v1', {'report': upload}, timeout=20)
    with _LOCK:
        item['sent'] = True
        path.write_text(json.dumps(item))
    return {'ok': True}


def dismiss_reports(payload):
    """Hide the 'problem recorded' notice; reports stay listed in Settings."""
    with _LOCK:
        for path in _folder().glob('*.json'):
            try: item = json.loads(path.read_text())
            except Exception: continue
            if not item.get('dismissed'):
                item['dismissed'] = True; path.write_text(json.dumps(item))
    return {'ok': True}


def delete_reports(payload):
    with _LOCK:
        if payload.get('all') is True:
            for path in _folder().glob('*.json'): path.unlink(missing_ok=True)
        else:
            _find(payload.get('id')).unlink(missing_ok=True)
    return {'ok': True}


def record_frontend(payload):
    """Errors from the app window (window.onerror / unhandled promise rejections)."""
    if not isinstance(payload, dict): raise ClientError(400, 'Invalid report.')
    report_id = record('frontend', payload.get('errorType') or 'Error', payload.get('message', ''), payload.get('stack', ''),
                       {'view': payload.get('view', ''), 'source': payload.get('source', '')})
    return {'ok': True, 'id': report_id}


def install_hooks():
    """Record uncaught backend exceptions and watch peak memory."""
    previous = sys.excepthook
    def excepthook(kind, error, tb):
        try: record('backend-crash', kind.__name__, str(error), ''.join(traceback.format_exception(kind, error, tb)))
        except Exception: pass
        previous(kind, error, tb)
    sys.excepthook = excepthook
    previous_thread = threading.excepthook
    def thread_hook(args):
        try:
            if args.exc_type is not SystemExit:
                record('backend-thread', args.exc_type.__name__, str(args.exc_value),
                       ''.join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)), {'source': getattr(args.thread, 'name', '')})
        except Exception: pass
        previous_thread(args)
    threading.excepthook = thread_hook
    def watch_memory():
        global _MEMORY_REPORTED
        while not _MEMORY_REPORTED:
            time.sleep(60)
            peak = _memory_mb()
            if peak and peak >= MEMORY_LIMIT_MB:
                _MEMORY_REPORTED = True
                record('memory', 'HighMemory', f'Peak memory {peak} MB (limit {MEMORY_LIMIT_MB} MB)')
    threading.Thread(target=watch_memory, name='pulse-memory-watch', daemon=True).start()
