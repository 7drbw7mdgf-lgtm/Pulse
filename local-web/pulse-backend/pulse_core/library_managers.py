"""Shared Zotero/Mendeley operations for the UI and the stdio MCP bridge."""
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path
from pulse_core.constants import CONFIG_DIR, ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core.security import encrypt_secret, decrypt_secret

_LOCK = threading.RLock()
SECRETS = {'clientSecret', 'accessToken', 'refreshToken'}
ZOTERO = 'http://127.0.0.1:23119'
MENDELEY = 'https://api.mendeley.com'

@contextmanager
def config_lock():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        with (CONFIG_DIR / 'library-managers.lock').open('a') as lock:
            try:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX)
            except ImportError:
                pass
            yield

def read_config():
    path = CONFIG_DIR / 'library-managers.json'
    data = json.loads(path.read_text()) if path.exists() else {}
    for key in SECRETS:
        if data.get(key): data[key] = decrypt_secret(data[key])
    # Public application registration ships only an ID and redirect URL, never a secret.
    registration = Path(__file__).with_name('mendeley-client.json')
    if not data.get('clientId') and registration.exists():
        public = json.loads(registration.read_text())
        if public.get('clientId'):
            data.update(clientId=public['clientId'], redirectUri=validate_redirect(public['redirectUri']),
                        authFlow='pkce', pkceVerified=public.get('pkceVerified') is True, sharedRegistration=True)
    return data

def write_config(data):
    safe = dict(data)
    for key in SECRETS:
        if safe.get(key): safe[key] = encrypt_secret(safe[key])
    fd, name = tempfile.mkstemp(dir=CONFIG_DIR, prefix='.managers-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(safe, stream)
        os.replace(name, CONFIG_DIR / 'library-managers.json')
    finally:
        if os.path.exists(name): os.unlink(name)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request(url, method='GET', data=None, headers=None, timeout=10):
    # Credentials may only reach the fixed provider; redirects are not followed.
    if not (url.startswith(ZOTERO + '/') or url.startswith(MENDELEY + '/')):
        raise ClientError(400, 'Unsupported library service address.')
    h = {'Accept': 'application/json', **(headers or {})}
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data).encode()
        h.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            body = response.read(4 * 1024 * 1024)
            if not body: return {}
            if 'json' in response.headers.get('Content-Type', ''):
                return json.loads(body)
            try: return json.loads(body)
            except ValueError:
                if url.startswith(ZOTERO + '/connector/import?'):
                    return {'accepted': True}
                raise
    except urllib.error.HTTPError as error:
        raise ClientError(error.code, f'{"Zotero" if url.startswith(ZOTERO) else "Mendeley"} returned HTTP {error.code}.')
    except (OSError, ValueError) as error:
        raise ClientError(502, f'{"Zotero" if url.startswith(ZOTERO) else "Mendeley"} is unavailable. Check the connection and try again.') from error

def validate_redirect(value):
    parsed = urllib.parse.urlsplit(value)
    try: port = parsed.port
    except ValueError: port = None
    if (parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost'} or
        parsed.username or parsed.password or not port or not 1024 <= port <= 65535 or
        parsed.path != '/mendeley/callback' or parsed.query or parsed.fragment):
        raise ClientError(400, 'Use http://127.0.0.1:8765/mendeley/callback, or another local port, as the registered redirect URL.')
    return value

def configure_mendeley(payload):
    client_id = str(payload.get('clientId') or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', client_id):
        raise ClientError(400, 'Enter the Mendeley application client ID.')
    redirect = validate_redirect(str(payload.get('redirectUri') or 'http://127.0.0.1:8765/mendeley/callback').strip())
    with config_lock():
        config = read_config()
        if config.get('clientId') != client_id or config.get('redirectUri') != redirect or payload.get('clientSecret'):
            for key in ('accessToken', 'refreshToken', 'expiresAt', 'profile', 'mendeleyReceipts'): config.pop(key, None)
        config.update(clientId=client_id, redirectUri=redirect, authFlow='code', sharedRegistration=False)
        config['authGeneration'] = config.get('authGeneration', 0) + 1
        if payload.get('clientSecret'): config['clientSecret'] = str(payload['clientSecret']).strip()
        if not config.get('clientSecret'):
            raise ClientError(400, 'Enter the client secret from your Mendeley application registration.')
        write_config(config)
    return {'ok': True, 'configured': True}

def public_config():
    with config_lock(): config = read_config()
    return {'clientId': config.get('clientId', ''), 'redirectUri': config.get('redirectUri', 'http://127.0.0.1:8765/mendeley/callback'),
            'hasClientSecret': bool(config.get('clientSecret')), 'configured': bool(config.get('clientId') and ((config.get('authFlow', 'code') == 'code' and config.get('clientSecret')) or (config.get('authFlow') == 'pkce' and config.get('pkceVerified') is True))),
            'sharedRegistration': bool(config.get('sharedRegistration')), 'authFlow': config.get('authFlow', 'code')}

def token_exchange(config, fields):
    import base64
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    fields = dict(fields)
    if config.get('clientSecret'):
        basic = base64.b64encode((config['clientId'] + ':' + config['clientSecret']).encode()).decode()
        headers['Authorization'] = 'Basic ' + basic
    elif config.get('authFlow') == 'pkce' and config.get('pkceVerified') is True:
        fields['client_id'] = config['clientId']
    else:
        raise ClientError(400, 'Mendeley application activation is incomplete.')
    result = request(MENDELEY + '/oauth/token', 'POST', urllib.parse.urlencode(fields).encode(), headers)
    token = result.get('access_token')
    if (not isinstance(token, str) or not 1 <= len(token) <= 8192 or
        any(ord(char) < 33 or ord(char) > 126 for char in token) or
        str(result.get('token_type', 'bearer')).lower() != 'bearer'):
        raise ClientError(502, 'Mendeley did not issue a valid access token.')
    try:
        lifetime = int(result.get('expires_in', 3600))
        if not 1 <= lifetime <= 86400: raise ValueError()
    except (ValueError, TypeError, OverflowError):
        raise ClientError(502, 'Mendeley returned an invalid token expiry.')
    profile = request(MENDELEY + '/profiles/v2/me', headers={'Authorization': 'Bearer ' + token})
    if not isinstance(profile, dict) or not profile.get('id'):
        raise ClientError(502, 'Mendeley did not confirm the account connection.')
    with config_lock():
        current = read_config()
        if (current.get('clientId') != config['clientId'] or current.get('clientSecret') != config.get('clientSecret') or
            current.get('authGeneration', 0) != config.get('authGeneration', 0) or current.get('redirectUri') != config.get('redirectUri') or current.get('authFlow', 'code') != config.get('authFlow', 'code')):
            raise ClientError(409, 'Mendeley configuration changed. Connect again.')
        current.update(accessToken=result['access_token'], refreshToken=result.get('refresh_token') or config.get('refreshToken', ''),
                       expiresAt=time.time() + lifetime)
        write_config(current)
    return result['access_token']

def access_token():
    with config_lock(): config = read_config()
    if config.get('authFlow') == 'implicit':
        raise ClientError(401, 'The older Mendeley sign-in is disabled. Configure an authorization-code connection.')
    if config.get('accessToken') and config.get('expiresAt', 0) > time.time() + 60:
        return config['accessToken']
    if config.get('refreshToken'):
        return token_exchange(config, {'grant_type': 'refresh_token', 'refresh_token': config['refreshToken'], 'redirect_uri': config['redirectUri']})
    raise ClientError(401, 'Connect your Mendeley account first.')

def mendeley_request(path, method='GET', data=None):
    return request(MENDELEY + path, method, data, {'Authorization': 'Bearer ' + access_token(),
                   'Accept': 'application/vnd.mendeley-document.1+json', 'Content-Type': 'application/vnd.mendeley-document.1+json'})

def manager_status():
    from pulse_core.mendeley_oauth import oauth_status
    zotero = {'connected': False, 'label': 'Not connected', 'destination': ''}
    try:
        request(ZOTERO + '/connector/ping', timeout=3)
        target = request(ZOTERO + '/connector/getSelectedCollection', 'POST', {}, timeout=3)
        if target.get('editable') is False: raise ClientError(403, 'Select an editable library in Zotero.')
        zotero.update(connected=True, label='Connected', destination=target.get('name') or 'Selected Zotero library / collection',
                      target=target.get('id') or target.get('libraryID'))
    except ClientError as error:
        zotero['message'] = str(error)
    config = public_config()
    mendeley = dict(config, connected=False, label='Connect' if config['configured'] else 'Not activated')
    with config_lock(): private = read_config()
    if private.get('accessToken') or private.get('refreshToken'):
        try:
            request(MENDELEY + '/profiles/v2/me', headers={'Authorization': 'Bearer ' + access_token(),
                    'Accept': 'application/json'}, timeout=5)
            mendeley.update(connected=True, label='Connected', destination='Your Mendeley library')
        except ClientError as error:
            mendeley['message'] = str(error)
    mendeley.update(oauth_status())
    return {'ok': True, 'zotero': zotero, 'mendeley': mendeley}

def disconnect_mendeley(payload=None):
    from pulse_core.mendeley_oauth import cancel_oauth
    cancel_oauth()
    with config_lock():
        config = read_config()
        config['authGeneration'] = config.get('authGeneration', 0) + 1
        for key in ('accessToken', 'refreshToken', 'expiresAt', 'profile', 'mendeleyReceipts'): config.pop(key, None)
        write_config(config)
    return {'ok': True}

def record_metadata(record):
    if not isinstance(record, dict) or not str(record.get('title') or '').strip():
        raise ClientError(400, 'Every record needs a paper title.')
    authors = record.get('authors') or []
    if isinstance(authors, str): authors = [authors]
    authors = [str(a.get('name') or '') if isinstance(a, dict) else str(a) for a in authors][:200]
    return {'title': str(record['title'])[:500], 'authors': authors, 'year': str(record.get('year') or '')[:4],
            'journal': str(record.get('journal') or '')[:255], 'doi': normalize_doi(record.get('doi')) or '',
            'abstract': str(record.get('abstract') or '')[:10000], 'pmid': str(record.get('pmid') or '')[:100]}

def fingerprint(record):
    return ('doi:' + record['doi'].lower()) if record['doi'] else ('title:' + record['title'].strip().casefold() + ':' + record['year'])

def ris(records):
    def clean(value): return str(value).replace('\r', ' ').replace('\n', ' ')
    out = []
    for p in records:
        lines = ['TY  - JOUR', 'TI  - ' + clean(p['title'])]
        lines += ['AU  - ' + clean(a) for a in p['authors']]
        for tag, key in [('PY','year'), ('JO','journal'), ('DO','doi'), ('AB','abstract')]:
            if p[key]: lines.append(tag + '  - ' + clean(p[key]))
        if p['doi']: lines.append('UR  - https://doi.org/' + clean(p['doi']))
        lines.append('ER  - ')
        out.append('\n'.join(lines))
    return '\n\n'.join(out) + '\n'

def save_manager_records(payload):
    provider = payload.get('provider')
    if provider not in {'zotero', 'mendeley'}: raise ClientError(400, 'Choose Zotero or Mendeley.')
    records = payload.get('papers')
    if not isinstance(records, list) or not 1 <= len(records) <= 50:
        raise ClientError(400, 'Choose between 1 and 50 papers to send.')
    records = list({fingerprint(p): p for p in map(record_metadata, records)}.values())
    saved, skipped, errors = [], [], []
    if provider == 'mendeley': access_token()
    # Serialize writes across UI and MCP processes, including receipt updates.
    with config_lock():
        config = read_config()
        if provider == 'zotero':
            target = request(ZOTERO + '/connector/getSelectedCollection', 'POST', {})
            if target.get('editable') is False: raise ClientError(403, 'Select an editable Zotero library.')
            destination = target.get('name') or 'Selected Zotero library / collection'
            scope = str(target.get('libraryID')) + ':' + str(target.get('id'))
            receipts = config.setdefault('zoteroReceipts', {}).setdefault(scope, {})
            pending = []
            for record in records:
                if fingerprint(record) in receipts: skipped.append(record['title'])
                else: pending.append(record)
            if pending:
                request(ZOTERO + '/connector/import?' + urllib.parse.urlencode({'session': 'pulse-' + uuid.uuid4().hex}),
                        'POST', ris(pending).encode(), {'Content-Type': 'text/plain'}, timeout=25)
                for record in pending:
                    receipts[fingerprint(record)] = True
                    saved.append(record['title'])
                write_config(config)
        else:
            destination = 'Your Mendeley library'
            token = config.get('accessToken')
            if not token or config.get('expiresAt', 0) <= time.time() + 60:
                raise ClientError(401, 'Refresh the Mendeley connection before sending papers.')
            receipts = config.setdefault('mendeleyReceipts', {})
            for record in records:
                key = fingerprint(record)
                if key in receipts:
                    skipped.append(record['title']); continue
                data = {'type':'journal', 'title':record['title'], 'source':record['journal'], 'abstract':record['abstract'],
                        'authors':[{'first_name':a.rsplit(' ',1)[0] if ' ' in a else '', 'last_name':a.rsplit(' ',1)[-1]} for a in record['authors']],
                        'identifiers':{k: record[k] for k in ('doi','pmid') if record[k]}}
                if record['year'].isdigit(): data['year'] = int(record['year'])
                try:
                    result = request(MENDELEY + '/documents', 'POST', data, {'Authorization':'Bearer ' + token,
                        'Accept':'application/vnd.mendeley-document.1+json', 'Content-Type':'application/vnd.mendeley-document.1+json'})
                    if not result.get('id'): raise ClientError(502, 'Mendeley did not confirm the saved document.')
                    receipts[key] = result['id']
                    saved.append(record['title'])
                    write_config(config)
                except ClientError as error:
                    errors.append({'title':record['title'], 'error':str(error)})
    return {'ok': not errors, 'destination':destination, 'saved':saved, 'skipped':skipped, 'errors':errors}

def search_manager(payload):
    query = str(payload.get('query') or '').strip()[:300]
    if not query: raise ClientError(400, 'Enter a library search term.')
    if payload.get('provider') == 'zotero':
        items = request(ZOTERO + '/api/users/0/items/top?' + urllib.parse.urlencode({'q':query, 'limit':50}),
                        headers={'Zotero-API-Version':'3'})
        records = []
        for item in items:
            data = item.get('data') or {}
            if not data.get('title'): continue
            authors = [c.get('name') or ' '.join(filter(None, (c.get('firstName'),c.get('lastName')))) for c in data.get('creators') or []]
            year = re.search(r'\b\d{4}\b', data.get('date') or '')
            records.append({'key':item.get('key'), **record_metadata(dict(data, authors=authors, doi=data.get('DOI'),
                            journal=data.get('publicationTitle'), year=year.group() if year else ''))})
        return {'items':records}
    if payload.get('provider') == 'mendeley':
        items = mendeley_request('/search/documents?' + urllib.parse.urlencode({'query':query, 'limit':50}))
        return {'items':items}
    raise ClientError(400, 'Choose Zotero or Mendeley.')
