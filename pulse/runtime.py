"""Server and local model process lifecycle."""
from __future__ import annotations
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import tempfile
import os
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import contextual, get_context, use_context, LOCAL_BACKEND_DEFAULTS
from . import ai as ai_service
from . import metadata as metadata_service
from . import storage as storage_service


def bundled_ollama_available():
    return get_context().bundled_ollama.exists() and os.access(get_context().bundled_ollama, os.X_OK)



def bundled_ollama_status():
    return {
        "available": bundled_ollama_available(),
        "binary": str(get_context().bundled_ollama),
        "boot": get_context().ollama_boot_status,
    }



def ollama_server_responds(timeout=0.45):
    endpoint = LOCAL_BACKEND_DEFAULTS["ollamaTagsEndpoint"]
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": "pulse"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        logger.debug('ollama_server_responds: recovering from expected failure')
        return False



def ensure_ollama_runtime():
    if ollama_server_responds():
        get_context().ollama_boot_status = {"started": True, "reason": "existing-daemon"}
        return
    if (os.environ.get("PULSE_DISABLE_BUNDLED_OLLAMA") or os.environ.get("IRATXE_DISABLE_BUNDLED_OLLAMA") or "").strip() == "1":
        get_context().ollama_boot_status = {"started": False, "reason": "disabled-by-env"}
        return
    if not bundled_ollama_available():
        get_context().ollama_boot_status = {"started": False, "reason": "bundled-binary-missing"}
        return
    if get_context().ollama_process and get_context().ollama_process.poll() is None:
        get_context().ollama_boot_status = {"started": True, "reason": "already-running", "pid": get_context().ollama_process.pid}
        return

    get_context().ollama_models_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.setdefault("OLLAMA_MODELS", str(get_context().ollama_models_dir))
    env.setdefault("OLLAMA_HOST", "127.0.0.1:11434")
    try:
        get_context().ollama_process = subprocess.Popen(
            [str(get_context().bundled_ollama), "serve"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        get_context().ollama_boot_status = {
            "started": True,
            "reason": "started-bundled-ollama",
            "pid": get_context().ollama_process.pid,
            "binary": str(get_context().bundled_ollama),
        }
    except OSError as error:
        logger.warning('ensure_ollama_runtime: recovering from expected failure (%s)', type(error).__name__)
        get_context().ollama_boot_status = {
            "started": False,
            "reason": f"failed-to-start: {error}",
            "binary": str(get_context().bundled_ollama),
        }
        return

    for _ in range(15):
        if ollama_server_responds(timeout=0.3):
            get_context().ollama_boot_status["healthy"] = True
            return
        metadata_service.time_sleep(0.35)



def start_ollama_runtime_background():
    thread = threading.Thread(target=contextual(ensure_ollama_runtime), name="pulse-ollama-runtime", daemon=True)
    thread.start()



def cleanup_resources():
    if get_context().ollama_process and get_context().ollama_process.poll() is None:
        try:
            get_context().ollama_process.terminate()
            get_context().ollama_process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            logger.warning('cleanup_resources: recovering from expected failure')
            try:
                get_context().ollama_process.kill()
            except OSError:
                logger.warning('cleanup_resources: recovering from expected failure')
                pass
        get_context().ollama_process = None



def signal_handler(sig, frame):
    cleanup_resources()
    sys.exit(0)



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
    t = threading.Thread(target=contextual(_watch), name="pulse-parent-watchdog", daemon=True)
    t.start()



def main(context=None):
    from . import http as http_service
    import atexit
    import signal
    if context is not None:
        with use_context(context):
            return main()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    install_redacted_logging()
    cleanup = contextual(cleanup_resources)
    atexit.register(cleanup)
    try:
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
    except (ValueError, AttributeError):
        logger.debug("Signal handlers unavailable outside the main thread")
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
            server = http_service.PulseServer(("127.0.0.1", p), get_context())
            break
        except OSError:
            logger.warning('main: recovering from expected failure')
            continue

    if not server:
        server = http_service.PulseServer(("127.0.0.1", 0), get_context())

    get_context().server = server
    get_context().bound_port = server.server_address[1]

    port_file = (os.environ.get("PULSE_PORT_FILE") or os.environ.get("IRATXE_PORT_FILE") or "").strip()
    if port_file:
        try:
            Path(port_file).write_text(str(get_context().bound_port), "utf-8")
        except OSError as e:
            logger.warning('main: recovering from expected failure (%s)', type(e).__name__)
            print(f"Warning: could not write port file: {e}", file=sys.stderr)

    launch_file = os.environ.get('PULSE_LAUNCH_FILE')
    if launch_file:
        descriptor = os.open(launch_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'port': get_context().bound_port, 'token': get_context().api_token}, output)
            output.flush()
            os.fsync(output.fileno())
    settings = storage_service.load_settings()
    if ai_service.resolve_ai_provider(settings) == "local":
        start_ollama_runtime_background()

    start_parent_watchdog()

    print(f"Serving {'Pulse Lite' if get_context().edition == 'lite' else 'Pulse'} on http://127.0.0.1:{get_context().bound_port}/index.html", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        cleanup_resources()
        atexit.unregister(cleanup)



def health():
    from . import ai as ai_service
    context = get_context()
    settings = storage_service.load_settings()
    result = {'ok': True, 'backend': 'pulse-lite' if context.edition == 'lite' else 'pulse',
              'version': context.version, 'configured': True, 'model': ai_service.resolve_gemma_model(settings),
              'ollamaChatEndpoint': ai_service.resolve_ollama_chat_endpoint(settings), 'root': str(context.root), 'pid': os.getpid()}
    if context.max_papers is not None:
        result['paperLimit'] = context.max_papers
    return result


class RedactedFormatter(logging.Formatter):
    """Prevent common credential-bearing URLs from leaking through exception logs."""
    def format(self, record):
        import re
        message = super().format(record)
        return re.sub(r'(?i)([?&](?:key|token|pulseToken|iratxeToken|api_key)=)[^\s&\"\']+', r'\1[redacted]', message)


def install_redacted_logging():
    for handler in logging.getLogger().handlers:
        handler.setFormatter(RedactedFormatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
