"""Client for Pulse's Mendeley token-exchange service (auth-service/cloudflare).

The service holds only the Mendeley application secret. Tokens come back to this computer,
are stored encrypted with the other library-manager credentials, and library requests go
straight to Mendeley.
"""
import json
import re
import urllib.error
import urllib.request
from pulse_core.constants import APP_VERSION, ClientError
from pulse_core.mendeley_broker import origin, NoRedirect

PROTOCOL = 'exchange-1'
_PATHS = {'/start', '/token', '/refresh'}


def call(base, path, payload):
    base = origin(base)
    if path not in _PATHS: raise ClientError(400, 'Invalid Mendeley sign-in operation.')
    request = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': f'Pulse/{APP_VERSION}'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
            raw = response.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024: raise ValueError()
            result = json.loads(raw)
            if not isinstance(result, dict): raise ValueError()
            return result
    except urllib.error.HTTPError as error:
        reason, body = '', {}
        try:
            body = json.loads(error.read(4096))
            if not isinstance(body, dict): body = {}
            reason = str(body.get('error') or '')[:300]
        except Exception: pass
        status = error.code if error.code in {400, 401, 403, 429} else 502
        application_failure = (body.get('code') == 'mendeley_application_authentication_failed' or
                               error.code == 401 and path in {'/token', '/refresh'})
        if application_failure:
            failure = ClientError(status,
                'Mendeley application authentication failed (HTTP 401). The Pulse sign-in service owner must verify its registered application ID and secret. Connect again after the service is corrected.')
            failure.mendeley_stage = 'application_authentication'
            failure.mendeley_code = 'mendeley_application_authentication_failed'
        else:
            stage = 'token_exchange' if path in {'/token', '/refresh'} else 'connection_service'
            context = 'Mendeley token exchange failed' if stage == 'token_exchange' else 'The Mendeley sign-in service could not start the connection'
            failure = ClientError(status, context + (f': {reason}' if reason else '. Connect again or try later.'))
            failure.mendeley_stage = stage
            failure.mendeley_code = 'mendeley_token_exchange_failed' if stage == 'token_exchange' else 'mendeley_connection_service_failed'
        raise failure from None
    except (OSError, ValueError):
        failure = ClientError(502, 'The Mendeley sign-in service is unavailable. You can export citations instead.')
        failure.mendeley_stage = 'token_exchange' if path in {'/token', '/refresh'} else 'connection_service'
        failure.mendeley_code = 'mendeley_connection_service_unavailable'
        raise failure from None


def start(config, challenge, port):
    result = call(config['exchangeUrl'], '/start', {'challenge': challenge, 'port': port})
    url, state = result.get('authorizationUrl'), result.get('state')
    if (not isinstance(url, str) or not url.startswith('https://api.mendeley.com/oauth/authorize?') or
            not isinstance(state, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', state) or len(state) > 1024):
        raise ClientError(502, 'The Mendeley sign-in service returned an invalid request.')
    return url, state


def tokens(config, fields):
    """Same result shape as Mendeley's token endpoint."""
    if fields.get('grant_type') == 'authorization_code':
        return call(config['exchangeUrl'], '/token', {'code': fields.get('code'), 'state': fields.get('state'), 'verifier': fields.get('code_verifier')})
    if fields.get('grant_type') == 'refresh_token':
        return call(config['exchangeUrl'], '/refresh', {'refresh_token': fields.get('refresh_token')})
    raise ClientError(400, 'Unsupported Mendeley sign-in step.')
