"""Fixed-origin Mendeley transport. Never logs credentials or follows redirects."""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = 'https://api.mendeley.com'
class Failure(Exception):
    def __init__(self, status, message):
        super().__init__(message); self.status = status
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None

def validate_path(path, method='GET'):
    if not isinstance(path, str) or len(path) > 4096:
        raise Failure(400, 'Invalid library request.')
    target = urllib.parse.urlsplit(path)
    if target.scheme or target.netloc or target.fragment or not path.startswith('/') or '\\' in path:
        raise Failure(400, 'Invalid library request.')
    allowed = {'/documents', '/search/documents', '/profiles/v2/me'}
    if method not in {'GET','POST'} or target.path not in allowed or (method=='POST' and target.path!='/documents'):
        raise Failure(400, 'This library operation is not available.')
    fields = urllib.parse.parse_qs(target.query, keep_blank_values=True)
    if set(fields) - {'view','limit','marker','modified_since','order','sort','query'} or any(len(v)!=1 for v in fields.values()):
        raise Failure(400, 'Unsupported library filter.')
    if fields.get('view', ['all'])[0] not in {'all','client','bib'} or fields.get('view')==['bib']:
        raise Failure(400, 'Only JSON library records are supported.')
    if 'limit' in fields:
        try: valid=1<=int(fields['limit'][0])<=100
        except ValueError: valid=False
        if not valid: raise Failure(400, 'Use pages of at most 100 records.')
    return path

def call(path, method='GET', data=None, headers=None):
    req=urllib.request.Request(ORIGIN+path, method=method, data=data,
        headers={'Accept':'application/vnd.mendeley-document.1+json', **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as response:
            raw=response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024: raise Failure(502,'The library response was too large.')
            result=json.loads(raw) if raw else {}
            following=None
            for entry in response.headers.get('Link','').split(','):
                match=re.match(r'\s*<([^>]+)>\s*;\s*rel="?next"?', entry)
                if match:
                    absolute=urllib.parse.urlsplit(match[1])
                    if absolute.scheme!='https' or absolute.netloc!='api.mendeley.com':
                        raise Failure(502,'Invalid library page link.')
                    following=validate_path(absolute.path+('?' + absolute.query if absolute.query else ''))
            return result, following
    except urllib.error.HTTPError as error:
        raise Failure(error.code if error.code in {401,403,429} else 502,'Mendeley could not complete the request.') from None
    except (OSError, ValueError): raise Failure(502,'Mendeley is unavailable. Try again later.') from None

def token(client_id, secret, redirect, fields):
    body=dict(fields, redirect_uri=redirect)
    basic=base64.b64encode((client_id+':'+secret).encode()).decode()
    result,_=call('/oauth/token','POST',urllib.parse.urlencode(body).encode(),
        {'Content-Type':'application/x-www-form-urlencoded','Authorization':'Basic '+basic,'Accept':'application/json'})
    access=result.get('access_token')
    if not isinstance(access,str) or not 1<=len(access)<=8192 or any(ord(c)<33 or ord(c)>126 for c in access):
        raise Failure(502,'Mendeley did not issue a valid account token.')
    if str(result.get('token_type','bearer')).lower()!='bearer': raise Failure(502,'Invalid account token type.')
    try:
        lifetime=int(result.get('expires_in',3600))
        if not 1<=lifetime<=86400: raise ValueError()
    except (ValueError,TypeError): raise Failure(502,'Invalid account token expiry.')
    refresh=result.get('refresh_token') or fields.get('refresh_token')
    if not isinstance(refresh,str) or not 1<=len(refresh)<=8192 or any(ord(c)<33 or ord(c)>126 for c in refresh):
        raise Failure(502,'Mendeley did not issue a valid refresh token.')
    return dict(access=access,refresh=refresh,lifetime=lifetime)
