"""One-use authorization-code sign-in, with S256 PKCE and no implicit fallback."""
import base64
import hashlib
import hmac
import html
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pulse_core.constants import ClientError
from pulse_core.library_managers import read_config, config_lock, token_exchange, validate_redirect

_LOCK = threading.Lock()
_PENDING = None
_STATUS = {'pending': False, 'authorizationMessage': '', 'authorizationStage': '', 'authorizationErrorCode': ''}

def oauth_status():
    from pulse_core.mendeley_broker import status
    shared=status()
    with _LOCK: local=dict(_STATUS)
    return shared if shared.get('pending') or shared.get('authorizationMessage') else local

def cancel_oauth():
    global _PENDING
    from pulse_core.mendeley_broker import cancel
    cancel()
    with _LOCK:
        previous = _PENDING
        if previous: previous['cancelled'] = True
        _PENDING = None
        _STATUS.update(pending=False, authorizationMessage='', authorizationStage='', authorizationErrorCode='')
    worker = previous.get('worker') if previous else None
    if worker and worker is not threading.current_thread(): worker.join(timeout=.75)

def pkce_challenge(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).rstrip(b'=').decode('ascii')

def callback_page(message, nonce):
    # The browser receives only a result, never the access token or verifier.
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mendeley connection</title><style>body{font:16px system-ui;max-width:480px;margin:18vh auto;padding:24px;line-height:1.6}</style><h1>Mendeley connection</h1><p role="status">' + html.escape(message) + '</p><script nonce="' + html.escape(nonce, quote=True) + '">history.replaceState(null,"",location.pathname);</script></html>'

def start_oauth(payload=None):
    global _PENDING
    cancel_oauth()
    with config_lock():
        config = read_config(for_sign_in=True)
        flow = config.get('authFlow', 'code')
        exchange = flow == 'exchange'
        public_pkce = flow == 'pkce' and config.get('pkceVerified') is True
        if flow == 'implicit':
            raise ClientError(400, 'This older Mendeley sign-in is disabled. Activate an authorization-code connection.')
        if exchange:
            if not config.get('exchangeUrl'): raise ClientError(400, 'Pulse’s Mendeley sign-in service is not configured.')
        elif flow != 'broker' and (not config.get('clientId') or not (public_pkce or (flow == 'code' and config.get('clientSecret')))):
            raise ClientError(400, 'Pulse’s Mendeley connection needs its one-time application activation and provider verification.')
        # A callback already exchanging a code must not save its grant after a restart.
        config['authGeneration'] = config.get('authGeneration', 0) + 1
        from pulse_core.library_managers import write_config
        write_config(config)
    if flow=='broker':
        from pulse_core.mendeley_broker import start
        return start(config)
    verifier = secrets.token_urlsafe(64)
    if exchange:
        # Pulse's sign-in service redirects back to this computer on a free port; the code is
        # useless to anything else without this app's verifier.
        redirect, listen_port, state = None, 0, None
    else:
        redirect = validate_redirect(config.get('redirectUri', ''))
        listen_port, state = urllib.parse.urlsplit(redirect).port, secrets.token_urlsafe(32)
    expected = {'path': '/mendeley/callback', 'host': ''}
    pending = {'state':state, 'expires':time.time() + 600, 'cancelled':False, 'used':False}
    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            target = urllib.parse.urlsplit(self.path)
            if target.path != expected['path'] or self.headers.get('Host') != expected['host']:
                self.reply(400, 'This connection request is invalid.'); return
            params = urllib.parse.parse_qs(target.query, keep_blank_values=True)
            supplied = params.get('state', [])
            with _LOCK:
                valid = (_PENDING is pending and not pending['cancelled'] and not pending['used'] and
                         pending['expires'] > time.time() and len(supplied) == 1 and
                         hmac.compare_digest(supplied[0].encode(), pending['state'].encode()))
                if valid: pending['used'] = True
            if not valid:
                self.reply(400, 'This connection request is invalid or expired. Start again in Pulse.'); return
            try:
                if params.get('error'): raise ClientError(400, 'Mendeley sign-in was declined. You can try again in Pulse.')
                codes = params.get('code', [])
                if len(codes) != 1 or not 1 <= len(codes[0]) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in codes[0]):
                    raise ClientError(400, 'Mendeley did not return a valid sign-in response.')
                fields = {'grant_type':'authorization_code', 'code':codes[0], 'code_verifier':verifier}
                fields.update({'state':pending['state']} if exchange else {'redirect_uri':redirect})
                token_exchange(config, fields)
                code, message = 200, 'Mendeley connected. Return to Pulse to send your chosen citations.'
                stage, error_code = '', ''
            except ClientError as error:
                code, message = 400, f'Could not finish Mendeley sign-in: {str(error).rstrip(".")}. Return to Pulse.'
                stage = getattr(error, 'mendeley_stage', 'authorization_response')
                error_code = getattr(error, 'mendeley_code', '')
            with _LOCK:
                if _PENDING is pending:
                    _STATUS.update(pending=False, authorizationMessage=message, authorizationStage=stage, authorizationErrorCode=error_code)
            self.reply(code, message)
        def do_POST(self):
            self.reply(405, 'Only authorization-code responses are accepted.')
        def reply(self, code, message):
            nonce = secrets.token_urlsafe(24)
            body = callback_page(message, nonce).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)
    class Listener(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            return connection, address
    try: server = Listener(('127.0.0.1', listen_port), Callback)
    except OSError as error: raise ClientError(409, 'The Mendeley connection port is busy. Close the previous sign-in and try again.') from error
    server.timeout = .5
    port = server.server_address[1] if exchange else listen_port
    expected['host'] = f'127.0.0.1:{port}' if exchange else urllib.parse.urlsplit(redirect).netloc
    if exchange:
        from pulse_core.mendeley_exchange import start as exchange_start
        try: authorization_url, pending['state'] = exchange_start(config, pkce_challenge(verifier), port)
        except BaseException:
            server.server_close(); raise
    else:
        authorization_url = 'https://api.mendeley.com/oauth/authorize?' + urllib.parse.urlencode(
            {'client_id':config['clientId'], 'redirect_uri':redirect, 'response_type':'code', 'scope':'all', 'state':state,
             'code_challenge':pkce_challenge(verifier), 'code_challenge_method':'S256'})
    with _LOCK:
        _PENDING = pending
        _STATUS.update(pending=True, authorizationMessage='Waiting for Mendeley sign-in…')
    def listen():
        try:
            while not pending['cancelled'] and not pending['used'] and pending['expires'] > time.time(): server.handle_request()
        finally:
            server.server_close()
            with _LOCK:
                if _PENDING is pending and not pending['used']:
                    _STATUS.update(pending=False, authorizationMessage='Sign-in expired. Connect again in Pulse.')
    worker = threading.Thread(target=listen, daemon=True)
    pending['worker'] = worker
    worker.start()
    return {'ok':True, 'authorizationUrl':authorization_url}
