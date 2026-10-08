import base64
import html
import json
import os
import secrets
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("PULSE_WEB_ROOT") or Path(__file__).resolve().parents[2] / "pulse-frontend")

VENDORED_PYTHON = ROOT / "python"
if VENDORED_PYTHON.exists():
    sys.path.insert(0, str(VENDORED_PYTHON))

CONFIG_DIR = Path(os.environ.get("PULSE_CONFIG_DIR") or os.environ.get("IRATXE_CONFIG_DIR") or (Path.home() / "Library" / "Application Support" / "pulse"))
_legacy_config_dir = Path.home() / "Library" / "Application Support" / "iratxe"
if not (os.environ.get("PULSE_CONFIG_DIR") or os.environ.get("IRATXE_CONFIG_DIR")) and not CONFIG_DIR.exists() and _legacy_config_dir.exists():
    try:
        shutil.copytree(_legacy_config_dir, CONFIG_DIR, dirs_exist_ok=True)
    except Exception:
        pass

CONFIG_PATH = CONFIG_DIR / "settings.json"
LIBRARY_PATH = CONFIG_DIR / "library.json"

LOCAL_BACKEND_DEFAULTS = {
    "aiProvider": "local",
    "cloudProvider": "not-configured",
    "ollamaChatEndpoint": "http://127.0.0.1:11434/api/chat",
    "ollamaTagsEndpoint": "http://127.0.0.1:11434/api/tags",
    "ollamaEmbeddingsEndpoint": "http://127.0.0.1:11434/api/embeddings",
    "chatModel": "gemma3:4b",
    "embeddingModel": "nomic-embed-text",
    "emergencyEmbeddingFallback": "hashed-local-fallback",
    "autoGemmaExtraction": True,
}
DEFAULT_GEMMA_MODEL = LOCAL_BACKEND_DEFAULTS["chatModel"]
APP_VERSION = os.environ.get("PULSE_APP_VERSION") or os.environ.get("IRATXE_APP_VERSION") or "1.5.7"
CONTACT_EMAIL = (os.environ.get("PULSE_CONTACT_EMAIL") or os.environ.get("IRATXE_CONTACT_EMAIL") or "").strip()
API_TOKEN = (os.environ.get("PULSE_API_TOKEN") or os.environ.get("IRATXE_API_TOKEN") or "").strip() or secrets.token_urlsafe(32)
BOUND_PORT = int(os.environ.get("PULSE_PORT") or os.environ.get("IRATXE_PORT") or "8000")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
DIMENSIONS_API_ROOT = "https://app.dimensions.ai"
SEMANTIC_SCHOLAR_API_ROOT = "https://api.semanticscholar.org"
BUNDLED_OLLAMA = ROOT / "bin" / "ollama"
OLLAMA_MODELS_DIR = Path(os.environ.get("PULSE_OLLAMA_MODELS") or os.environ.get("IRATXE_OLLAMA_MODELS") or (CONFIG_DIR / "models"))
OLLAMA_PROCESS = None
OLLAMA_BOOT_STATUS = {"started": False, "reason": "not-started"}
BOOTSTRAP_CONSUMED = False
TOKEN_FILE = CONFIG_DIR / ".session_token"
SERVER_INSTANCE = None
MAX_DECOMPRESSED_STREAM_BYTES = 2 * 1024 * 1024
MAX_TOTAL_DECOMPRESSED_BYTES = 8 * 1024 * 1024


class ClientError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def time_seconds():
    import time
    return time.time()


def time_sleep(seconds):
    import time
    time.sleep(seconds)


def time_iso():
    return datetime.now(timezone.utc).isoformat()


def html_escape(value):
    return html.escape(str(value or ""))


def dedupe_strings(values):
    seen = set()
    result = []
    for item in values or []:
        clean = str(item or "").strip()
        if not clean:
            continue
        key = clean.lower()
        if key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def clean_string_list(values, limit=24):
    if not isinstance(values, list):
        return []
    cleaned = []
    seen = set()
    for item in values:
        if isinstance(item, str):
            clean = item.strip()
            if clean and clean.lower() not in seen:
                seen.add(clean.lower())
                cleaned.append(clean)
                if len(cleaned) >= limit:
                    break
    return cleaned


def preview_key(api_key):
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "set"
    return f"{api_key[:4]}...{api_key[-4:]}"
