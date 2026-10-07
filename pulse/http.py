"""Loopback HTTP transport: authentication, JSON validation and service routing."""
from __future__ import annotations
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hmac
from http.cookies import SimpleCookie
import json
import logging
import urllib.parse
from . import ai as ai_service
from . import discovery as discovery_service
from . import runtime as runtime_service
from . import storage as storage_service
from . import uploads as uploads_service
from . import providers as providers_service
from .context import AppContext, ClientError, LOOPBACK_HOSTS, use_context
logger = logging.getLogger(__name__)
GET_ROUTES = {
    '/api/settings': storage_service.settings_view,
    '/api/providers': storage_service.settings_view,
    '/api/library': storage_service.load_library,
    '/api/health': runtime_service.health,
}
POST_ROUTES = {
    '/api/settings': storage_service.update_settings_view,
    '/api/library': storage_service.save_library,
    '/api/metadata/doi': providers_service.lookup_doi_metadata,
    '/api/metadata/pmid': providers_service.lookup_pmid_metadata,
    '/api/metadata/scan': uploads_service.scan_file_for_metadata,
    '/api/metadata/gemma': uploads_service.extract_metadata_with_gemma,
    '/api/recommendations': discovery_service.recommend_papers,
    '/api/citations/enrich': discovery_service.enrich_citations,
    '/api/citations/seminal': discovery_service.find_missing_seminal_papers,
    '/api/citations/snowball': discovery_service.snowball_papers,
    '/api/discovery/pipeline': discovery_service.run_discovery_pipeline,
    '/api/discovery/start': discovery_service.start_discovery,
    '/api/discovery/cancel': discovery_service.cancel_discovery,
    '/api/citations/chase': discovery_service.iterative_citation_chase,
    '/api/citations/network': discovery_service.citation_network_triangulation,
    '/api/test': ai_service.test_settings_response,
    '/api/analyze': ai_service.analysis_response,
}


class PulseServer(ThreadingHTTPServer):
    def __init__(self, address, context: AppContext):
        self.context = context
        super().__init__(address, PulseHandler)


class PulseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(args[2].context.root), **kwargs)

    def parse_cookies(self):
        cookies = SimpleCookie()
        cookies.load(self.headers.get("Cookie") or "")
        return {key: morsel.value for key, morsel in cookies.items()}

    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://generativelanguage.googleapis.com https://api.crossref.org https://api.openalex.org https://api.semanticscholar.org https://app.dimensions.ai; frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        super().end_headers()

    def do_OPTIONS(self):
        if self.request_is_allowed(urllib.parse.urlparse(self.path), allow_api_token=False):
            self.send_response(204)
            self.end_headers()

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def dispatch(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        if not self.request_is_allowed(parsed):
            return
        with use_context(self.server.context):
            try:
                if method == 'GET':
                    if parsed.path in GET_ROUTES:
                        return self.write_json(200, GET_ROUTES[parsed.path]())
                    if parsed.path.startswith('/api/discovery/jobs/'):
                        return self.write_json(200, discovery_service.read_discovery(parsed.path.rsplit('/', 1)[-1]))
                    if parsed.path in {'/', '/index.html'}:
                        return self.write_index()
                    return super().do_GET()
                service = POST_ROUTES.get(parsed.path)
                if service is None:
                    return self.send_error(404, 'Unknown endpoint')
                payload = self.read_payload()
                result = service(payload)
                return self.write_json(202 if parsed.path == '/api/discovery/start' else 200, result)
            except ClientError as error:
                logger.warning('Request failed: %s %s (status=%s)', method, parsed.path, error.status)
                body = {'error': str(error)}
                if parsed.path == '/api/library' and self.server.context.max_papers is not None:
                    body['paperLimit'] = self.server.context.max_papers
                self.write_json(error.status, body)
            except (BrokenPipeError, ConnectionResetError):
                logger.debug('Client disconnected during %s %s', method, parsed.path)
            except Exception:
                # Last-resort transport boundary: programming errors are logged, never treated as empty results.
                logger.exception('Unhandled service failure during %s %s', method, parsed.path)
                self.write_json(500, {'error': 'An unexpected backend error occurred. Check the backend log.'})

    def read_payload(self) -> dict:
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0:
                raise ValueError('negative length')
            payload = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, UnicodeDecodeError) as error:
            raise ClientError(400, 'Request body must contain valid JSON.') from error
        if not isinstance(payload, dict):
            raise ClientError(400, 'Request body must be a JSON object.')
        return payload

    def request_is_allowed(self, parsed, allow_api_token=True):
        if not self.host_is_loopback():
            self.write_json(403, {"error": "Blocked non-loopback Host header."})
            return False
        origin = (self.headers.get("Origin") or "").strip().lower()
        if origin:
            parsed_origin = urllib.parse.urlparse(origin)
            if parsed_origin.hostname not in LOOPBACK_HOSTS or parsed_origin.scheme not in {"http", "https"}:
                self.write_json(403, {"error": "Blocked untrusted cross-origin request."})
                return False
        referer = (self.headers.get("Referer") or "").strip()
        if referer:
            parsed_ref = urllib.parse.urlparse(referer)
            if parsed_ref.hostname and parsed_ref.hostname.lower() not in LOOPBACK_HOSTS:
                self.write_json(403, {"error": "Blocked untrusted Referer."})
                return False
        sec_fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if sec_fetch_site == "cross-site":
            self.write_json(403, {"error": "Blocked cross-site request."})
            return False
        if allow_api_token and parsed.path.startswith("/api/"):
            cookies = self.parse_cookies()
            params = urllib.parse.parse_qs(parsed.query)
            supplied = (
                self.headers.get("X-Pulse-Token") or self.headers.get("X-Iratxe-Token")
                or cookies.get("pulse_session") or cookies.get("pulse_token")
                or (params.get("token") or params.get("pulseToken") or params.get("iratxeToken") or [""])[0]
            )
            if not supplied or not hmac.compare_digest(str(supplied), str(self.server.context.api_token)):
                self.write_json(403, {"error": "Missing or invalid pulse session token."})
                return False
        return True

    def host_is_loopback(self):
        host = (self.headers.get('Host') or '').strip().lower()
        if not host:
            return False
        if host.startswith('[::1]'):
            return True
        if ':' in host and host.count(':') == 1:
            host = host.rsplit(':', 1)[0]
        return host in LOOPBACK_HOSTS

    def write_json(self, status, payload):
        self.write_body(status, json.dumps(payload).encode('utf-8'), 'application/json')

    def write_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_index(self):
        context = self.server.context
        cookies = self.parse_cookies()
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        supplied = self.headers.get('X-Pulse-Token') or cookies.get('pulse_session') or (params.get('token') or [''])[0]
        authenticated = bool(supplied and hmac.compare_digest(supplied, context.api_token))
        with context.bootstrap_lock:
            inject = authenticated or not context.bootstrap_consumed
            if inject:
                context.bootstrap_consumed = True
        markup = (context.root / 'index.html').read_text('utf-8')
        if inject:
            token = json.dumps(context.api_token)
            script = f'<script>window.__PULSE_API_TOKEN__ = {token}; window.__IRATXE_API_TOKEN__ = {token};</script>'
            markup = markup.replace('</head>', script + '\n</head>', 1) if '</head>' in markup else script + '\n' + markup
        body = markup.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if inject:
            self.send_header('Set-Cookie', f'pulse_session={context.api_token}; SameSite=Strict; Path=/; HttpOnly')
        self.end_headers()
        self.wfile.write(body)

    def log_request(self, code='-', size='-'):
        # Query strings contain session tokens. Never include them in logs.
        logger.info('%s %s -> %s', self.command, urllib.parse.urlsplit(self.path).path, code)

    def log_message(self, format, *args):
        logger.debug('HTTP server event')


IratxeHandler = PulseHandler
