import atexit
import hmac
import json
import os
import signal
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from pulse_core.ai_inference import analyze_with_gemma, extract_metadata_with_gemma
from pulse_core.citation_services import (
    enrich_citations,
    find_missing_seminal_papers,
    recommend_papers,
    snowball_papers,
)
from pulse_core.config_resolvers import (
    resolve_ai_provider,
    resolve_gemma_model,
    resolve_ollama_chat_endpoint,
)
from pulse_core.constants import (
    API_TOKEN,
    APP_VERSION,
    BOUND_PORT,
    CONFIG_DIR,
    LOOPBACK_HOSTS,
    ROOT,
    TOKEN_FILE,
    ClientError,
)
from pulse_core.discovery import (
    citation_network_triangulation,
    iterative_citation_chase,
    run_discovery_pipeline,
)
from pulse_core.metadata_scanner import (
    lookup_doi_metadata,
    lookup_pmid_metadata,
    scan_file_for_metadata,
)
from pulse_core.ollama_mgr import (
    OLLAMA_PROCESS,
    start_ollama_runtime_background,
    test_gemma_settings,
)
from pulse_core.storage import (
    load_library,
    load_settings,
    public_settings,
    save_library,
    save_settings,
)
from pulse_performance import DiscoveryJobs
DISCOVERY_JOBS = DiscoveryJobs()

BOOTSTRAP_CONSUMED = False
SERVER_INSTANCE = None

class PulseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def parse_cookies(self):
        cookie_header = self.headers.get("Cookie") or ""
        cookies = {}
        if cookie_header:
            for item in cookie_header.split(";"):
                if "=" in item:
                    k, v = item.strip().split("=", 1)
                    cookies[k.strip()] = v.strip()
        return cookies

    def end_headers(self):
        csp = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "connect-src 'self' http://127.0.0.1:* http://localhost:* "
            "https://generativelanguage.googleapis.com https://api.crossref.org "
            "https://api.openalex.org https://api.semanticscholar.org https://app.dimensions.ai; "
            "font-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "object-src 'none';"
        )
        self.send_header("Content-Security-Policy", csp)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

    def do_OPTIONS(self):
        if not self.request_is_allowed(urllib.parse.urlparse(self.path), allow_api_token=False):
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self.request_is_allowed(parsed):
            return
        path = parsed.path
        if path.startswith("/api/discovery/jobs/"):
            try:
                self.write_json(200, DISCOVERY_JOBS.read(path.rsplit("/", 1)[-1]))
            except KeyError:
                self.write_json(404, {"error": "Discovery search expired or was not found."})
            return
        if path == "/api/session":
            self.write_json(200, {"ok": True, "token": API_TOKEN})
            return
        if path in {"/api/settings", "/api/providers"}:
            settings = load_settings()
            self.write_json(200, public_settings(settings))
            return
        if path == "/api/library":
            self.write_json(200, load_library())
            return
        if path == "/api/health":
            settings = load_settings()
            self.write_json(200, {
                "ok": True,
                "backend": "pulse",
                "version": APP_VERSION,
                "configured": True,
                "model": resolve_gemma_model(settings),
                "ollamaChatEndpoint": resolve_ollama_chat_endpoint(settings),
                "root": str(ROOT),
                "pid": os.getpid(),
            })
            return
        if path in {"/", "/index.html"}:
            self.write_index()
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self.request_is_allowed(parsed):
            return
        path = parsed.path
        valid_post_endpoints = {
            "/api/analyze",
            "/api/settings",
            "/api/library",
            "/api/test",
            "/api/metadata/doi",
            "/api/metadata/pmid",
            "/api/metadata/scan",
            "/api/metadata/gemma",
            "/api/recommendations",
            "/api/citations/enrich",
            "/api/citations/seminal",
            "/api/citations/snowball",
            "/api/discovery/pipeline",
            "/api/discovery/start",
            "/api/discovery/cancel",
            "/api/citations/chase",
            "/api/citations/network",
        }
        if path not in valid_post_endpoints:
            self.send_error(404, "Unknown endpoint")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            handlers = {
                "/api/settings": lambda p: public_settings(save_settings(p)),
                "/api/library": save_library,
                "/api/metadata/doi": lookup_doi_metadata,
                "/api/metadata/pmid": lookup_pmid_metadata,
                "/api/metadata/scan": scan_file_for_metadata,
                "/api/metadata/gemma": extract_metadata_with_gemma,
                "/api/recommendations": recommend_papers,
                "/api/citations/enrich": enrich_citations,
                "/api/citations/seminal": find_missing_seminal_papers,
                "/api/citations/snowball": snowball_papers,
                "/api/discovery/pipeline": run_discovery_pipeline,
                "/api/citations/chase": iterative_citation_chase,
                "/api/citations/network": citation_network_triangulation,
                "/api/test": lambda _: test_gemma_settings(),
            }
            if path == "/api/discovery/start":
                if not payload.get("seedPapers"):
                    raise ClientError(400, "Select a seed paper first.")
                try:
                    self.write_json(202, DISCOVERY_JOBS.start(payload, run_discovery_pipeline))
                except ValueError as error:
                    raise ClientError(429, str(error))
                return
            if path == "/api/discovery/cancel":
                try:
                    self.write_json(200, DISCOVERY_JOBS.cancel(payload.get("id", "")))
                except KeyError:
                    self.write_json(404, {"error": "Discovery search was not found."})
                return
            if path in handlers:
                self.write_json(200, handlers[path](payload))
                return
            analysis, model = analyze_with_gemma(payload)
            self.write_json(200, {"analysis": analysis, "model": model})
        except ClientError as error:
            self.write_json(error.status, {"error": str(error)})
        except Exception as error:
            self.write_json(500, {"error": f"Backend analysis failed: {error}"})

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
            if not supplied or not hmac.compare_digest(str(supplied), str(API_TOKEN)):
                self.write_json(403, {"error": "Missing or invalid pulse session token."})
                return False
        return True

    def host_is_loopback(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return False
        if host.startswith("[::1]"):
            return True
        if ":" in host and host.count(":") == 1:
            host = host.rsplit(":", 1)[0]
        return host in LOOPBACK_HOSTS

    def write_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_html(self, status, markup):
        body = markup.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_index(self):
        global BOOTSTRAP_CONSUMED
        cookies = self.parse_cookies()
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        supplied = (
            self.headers.get("X-Pulse-Token") or self.headers.get("X-Iratxe-Token")
            or cookies.get("pulse_session") or cookies.get("pulse_token")
            or (params.get("token") or params.get("pulseToken") or params.get("iratxeToken") or [""])[0]
        )
        is_authenticated = bool(supplied and hmac.compare_digest(str(supplied), str(API_TOKEN)))
        allow_token_injection = False
        if is_authenticated:
            allow_token_injection = True
        elif not BOOTSTRAP_CONSUMED:
            BOOTSTRAP_CONSUMED = True
            allow_token_injection = True
        markup = ROOT.joinpath("index.html").read_text("utf-8")
        if allow_token_injection:
            token_script = f"<script>window.__PULSE_API_TOKEN__ = {json.dumps(API_TOKEN)}; window.__IRATXE_API_TOKEN__ = {json.dumps(API_TOKEN)};</script>"
            if "</head>" in markup:
                markup = markup.replace("</head>", f"{token_script}\n</head>", 1)
            else:
                markup = f"{token_script}\n{markup}"
        body = markup.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if allow_token_injection:
            self.send_header("Set-Cookie", f"pulse_session={API_TOKEN}; SameSite=Strict; Path=/; HttpOnly")
        self.end_headers()
        self.wfile.write(body)

def cleanup_resources():
    import pulse_core.ollama_mgr as om
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
    except OSError:
        pass
    if om.OLLAMA_PROCESS and om.OLLAMA_PROCESS.poll() is None:
        try:
            om.OLLAMA_PROCESS.terminate()
            om.OLLAMA_PROCESS.wait(timeout=2)
        except Exception:
            try:
                om.OLLAMA_PROCESS.kill()
            except Exception:
                pass
        om.OLLAMA_PROCESS = None

def signal_handler(sig, frame):
    cleanup_resources()
    sys.exit(0)

try:
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
except (ValueError, AttributeError):
    pass

atexit.register(cleanup_resources)

def start_parent_watchdog():
    launcher_pid = os.getppid()
    if launcher_pid <= 1:
        return
    def _watch():
        import time
        while True:
            time.sleep(3)
            if os.getppid() != launcher_pid:
                cleanup_resources()
                os._exit(0)
    t = threading.Thread(target=_watch, name="pulse-parent-watchdog", daemon=True)
    t.start()

def main():
    global SERVER_INSTANCE
    port = int(os.environ.get("PULSE_PORT") or os.environ.get("IRATXE_PORT") or "8000")
    server = None
    ports_to_try = [port]
    if port != 0:
        ports_to_try.extend([port + 1, port + 2, 8000, 8080, 8888, 0])
    tried = set()
    for p in ports_to_try:
        if p in tried:
            continue
        tried.add(p)
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), PulseHandler)
            break
        except OSError:
            continue
    if not server:
        server = ThreadingHTTPServer(("127.0.0.1", 0), PulseHandler)
    SERVER_INSTANCE = server
    bound_port = server.server_address[1]
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(API_TOKEN, "utf-8")
        TOKEN_FILE.chmod(0o600)
    except Exception:
        pass
    port_file = (os.environ.get("PULSE_PORT_FILE") or os.environ.get("IRATXE_PORT_FILE") or "").strip()
    if port_file:
        try:
            Path(port_file).write_text(str(bound_port), "utf-8")
        except Exception as e:
            print(f"Warning: could not write port file: {e}", file=sys.stderr)
    settings = load_settings()
    if resolve_ai_provider(settings) == "local":
        start_ollama_runtime_background()
    start_parent_watchdog()
    print(f"Serving Pulse on http://127.0.0.1:{bound_port}/index.html", flush=True)
    try:
        server.serve_forever()
    finally:
        cleanup_resources()

IratxeHandler = PulseHandler
