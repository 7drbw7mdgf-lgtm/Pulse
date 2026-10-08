import json
import os
import re
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from pulse_core.constants import (
    BUNDLED_OLLAMA,
    DEFAULT_GEMMA_MODEL,
    LOCAL_BACKEND_DEFAULTS,
    OLLAMA_BOOT_STATUS,
    OLLAMA_MODELS_DIR,
    OLLAMA_PROCESS,
    ClientError,
)

def bundled_ollama_available():
    return BUNDLED_OLLAMA.exists() and os.access(str(BUNDLED_OLLAMA), os.X_OK)

def bundled_ollama_status():
    return {
        "available": bundled_ollama_available(),
        "path": str(BUNDLED_OLLAMA) if bundled_ollama_available() else "",
        "modelsDir": str(OLLAMA_MODELS_DIR),
    }

def ollama_server_responds(timeout=0.45):
    try:
        with socket.create_connection(("127.0.0.1", 11434), timeout=timeout):
            return True
    except (OSError, TimeoutError):
        return False

def ensure_ollama_runtime():
    if os.environ.get("PULSE_DISABLE_BUNDLED_OLLAMA") == "1":
        return False
    global OLLAMA_PROCESS, OLLAMA_BOOT_STATUS
    if ollama_server_responds():
        OLLAMA_BOOT_STATUS = {"started": True, "reason": "already-running"}
        return True
    if not bundled_ollama_available():
        OLLAMA_BOOT_STATUS = {"started": False, "reason": "bundled-binary-missing"}
        return False
    try:
        OLLAMA_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
        env["OLLAMA_HOST"] = "127.0.0.1:11434"
        proc = subprocess.Popen(
            [str(BUNDLED_OLLAMA), "serve"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        OLLAMA_PROCESS = proc
        for _ in range(12):
            if ollama_server_responds():
                OLLAMA_BOOT_STATUS = {"started": True, "reason": "spawned-bundled"}
                return True
            import time
            time.sleep(0.3)
        OLLAMA_BOOT_STATUS = {"started": False, "reason": "spawn-timeout"}
        return False
    except Exception as err:
        OLLAMA_BOOT_STATUS = {"started": False, "reason": f"error: {err}"}
        return False

def start_ollama_runtime_background():
    import threading
    t = threading.Thread(target=ensure_ollama_runtime, daemon=True)
    t.start()

def normalize_gemma_model(value):
    val = str(value or DEFAULT_GEMMA_MODEL).strip()
    return val if val else DEFAULT_GEMMA_MODEL

def normalize_ollama_endpoint(value, api_name):
    clean = str(value or "").strip()
    return endpoint_with_api(clean, api_name)

def endpoint_with_api(endpoint, api_name):
    if not endpoint:
        endpoint = f"http://127.0.0.1:11434/api/{api_name}"
    parsed = urllib.parse.urlparse(endpoint)
    if not parsed.path or parsed.path == "/":
        return f"{endpoint.rstrip('/')}/api/{api_name}"
    return endpoint

def ollama_tags(settings, timeout=3):
    from pulse_core.config_resolvers import resolve_ollama_tags_endpoint
    endpoint = resolve_ollama_tags_endpoint(settings)
    req = urllib.request.Request(endpoint, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8")).get("models") or []
    except Exception:
        return []

def ollama_status(settings):
    from pulse_core.config_resolvers import resolve_embedding_model, resolve_gemma_model
    tags = ollama_tags(settings)
    online = bool(tags or ollama_server_responds())
    models = [m.get("name") for m in tags if isinstance(m, dict) and m.get("name")]
    chat_model = resolve_gemma_model(settings)
    emb_model = resolve_embedding_model(settings)
    chat_avail = any(chat_model in m for m in models) if models else False
    emb_avail = any(emb_model in m for m in models) if models else False
    return {
        "online": online,
        "models": models,
        "chatModelAvailable": chat_avail,
        "embeddingModelAvailable": emb_avail,
        "boot": OLLAMA_BOOT_STATUS,
    }

def require_ollama_model(settings, model, role):
    status = ollama_status(settings)
    if not status["online"]:
        raise ClientError(503, f"Local Ollama server is offline. Cannot run {role} with model {model}.")
    if not any(model in m for m in status["models"]):
        raise ClientError(404, f"Local model '{model}' is not pulled in Ollama.")

def require_ai_model(settings, role="chat"):
    from pulse_core.config_resolvers import resolve_ai_provider, resolve_gemini_api_key, resolve_gemma_model
    prov = resolve_ai_provider(settings)
    if prov == "cloud":
        if not resolve_gemini_api_key(settings):
            raise ClientError(400, "Gemini API key is not configured.")
    else:
        require_ollama_model(settings, resolve_gemma_model(settings), role)

def module_available(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None

def workflow_capabilities():
    return {
        "pdfExtraction": "Built-in pure-Python safe Flate stream extractor",
        "vectorDb": "In-memory Cosine + SQLite Vector Persistence",
        "vectorAvailable": True,
    }

def string_or_existing(value, fallback):
    val = str(value or "").strip()
    return val if val else fallback

def test_gemma_settings():
    from pulse_core.config_resolvers import resolve_ai_provider
    from pulse_core.storage import load_settings
    settings = load_settings()
    if resolve_ai_provider(settings) == "cloud":
        from pulse_core.ai_inference import call_gemini
        res = call_gemini(settings, "Reply with: OK", max_tokens=10)
        return {"ok": True, "provider": "cloud", "reply": res}
    else:
        from pulse_core.ai_inference import call_gemma
        res = call_gemma(settings, "Reply with: OK", max_tokens=10)
        return {"ok": True, "provider": "local", "reply": res}

def test_ai_settings():
    return test_gemma_settings()
