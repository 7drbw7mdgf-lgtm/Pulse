"""Encrypted multi-Mac sync: local state plus a forwarder to the Pulse relay.

Encryption and merging happen in the app window (WebCrypto). This module stores the sync code
(encrypted at rest with this Mac's key), the last-synced snapshots, and forwards already
encrypted records to the relay so the window needs no cross-origin access.
"""
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from pulse_core.constants import APP_VERSION, CONFIG_DIR, ClientError
from pulse_core.security import encrypt_secret, decrypt_secret

_LOCK = threading.Lock()
_OPS = {'register', 'push', 'pull', 'erase'}
_CODE = re.compile(r'^[0-9A-HJKMNP-TV-Z]{52}$')  # 32 random bytes, Crockford base32


def relay_url():
    """The relay address shipped with Pulse (PULSE_RELAY_URL overrides it for tests)."""
    override = os.environ.get('PULSE_RELAY_URL', '').strip()
    if override: return override.rstrip('/')
    path = Path(__file__).with_name('relay-client.json')
    try: value = str(json.loads(path.read_text()).get('relayUrl') or '').strip()
    except Exception: value = ''
    if value and not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::\d+)?', value.rstrip('/')):
        raise ClientError(500, 'The relay address in relay-client.json is invalid.')
    return value.rstrip('/')


def _state_path():
    return CONFIG_DIR / 'sync-state.json'


def _read_state():
    path = _state_path()
    try: data = json.loads(path.read_text()) if path.exists() else {}
    except Exception: data = {}
    return data if isinstance(data, dict) else {}


def _write_state(data):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=CONFIG_DIR, prefix='.sync-')
    try:
        with os.fdopen(fd, 'w') as stream: json.dump(data, stream)
        os.replace(name, _state_path())
        try: _state_path().chmod(0o600)
        except OSError: pass
    finally:
        if os.path.exists(name): os.unlink(name)


def get_state(payload=None):
    with _LOCK: data = _read_state()
    code = decrypt_secret(data.get('code', '')) if data.get('code') else ''
    return {'ok': True, 'relayUrl': relay_url(), 'enabled': bool(code), 'code': code,
            'device': data.get('device', ''), 'lastSeq': int(data.get('lastSeq') or 0),
            'base': data.get('base') if isinstance(data.get('base'), dict) else {},
            'lastSyncedAt': data.get('lastSyncedAt', ''), 'lastError': data.get('lastError', '')}


def save_state(payload):
    """Store the sync code (encrypted) and the last-synced snapshot. Fields not sent are kept."""
    if not isinstance(payload, dict): raise ClientError(400, 'Invalid sync state.')
    with _LOCK:
        data = _read_state()
        if 'code' in payload:
            code = str(payload.get('code') or '').strip().upper().replace('-', '').replace(' ', '')
            if code and not _CODE.fullmatch(code): raise ClientError(400, 'That sync code is not valid. Copy it again from the other Mac.')
            data['code'] = encrypt_secret(code) if code else ''
        if 'device' in payload:
            if not re.fullmatch(r'[0-9a-f]{32}', str(payload['device'])): raise ClientError(400, 'Invalid device ID.')
            data['device'] = payload['device']
        if 'lastSeq' in payload:
            if not isinstance(payload['lastSeq'], int) or payload['lastSeq'] < 0: raise ClientError(400, 'Invalid sync position.')
            data['lastSeq'] = payload['lastSeq']
        if 'base' in payload:
            if not isinstance(payload['base'], dict): raise ClientError(400, 'Invalid sync snapshot.')
            data['base'] = payload['base']
        for key in ('lastSyncedAt', 'lastError'):
            if key in payload: data[key] = str(payload[key] or '')[:300]
        _write_state(data)
    return {'ok': True}


def forget(payload=None):
    """Turn sync off on this Mac (local papers are untouched)."""
    with _LOCK:
        try: _state_path().unlink()
        except FileNotFoundError: pass
    return {'ok': True}


def relay(payload):
    """Forward an already-encrypted sync request to the relay."""
    op = payload.get('op') if isinstance(payload, dict) else None
    body = payload.get('body') if isinstance(payload, dict) else None
    if op not in _OPS or not isinstance(body, dict): raise ClientError(400, 'Invalid sync request.')
    return post(f'/sync/v1/{op}', body)


def post(path, body, timeout=30):
    base = relay_url()
    if not base: raise ClientError(503, 'Sync is not available in this build.')
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': f'Pulse/{APP_VERSION}'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024: raise ValueError('too large')
            result = json.loads(raw)
            if not isinstance(result, dict): raise ValueError('not an object')
            return result
    except urllib.error.HTTPError as error:
        try: detail = json.loads(error.read(4096))
        except Exception: detail = {}
        message = str(detail.get('error') or f'The relay returned HTTP {error.code}.')[:300]
        failure = ClientError(error.code if error.code in {400, 403, 404, 409, 413, 429} else 502, message)
        failure.retry = bool(detail.get('retry'))
        raise failure from None
    except (OSError, ValueError):
        raise ClientError(502, 'The sync relay could not be reached. Changes stay on this Mac and sync later.') from None
