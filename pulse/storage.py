"""Settings and atomic library persistence, with per-application save ordering."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
from datetime import datetime
import base64
import hashlib
import hmac
import secrets
import json
import os
import shutil
import tempfile
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import get_context, ClientError, DEFAULT_GEMMA_MODEL, DIMENSIONS_API_ROOT, LOCAL_BACKEND_DEFAULTS, SEMANTIC_SCHOLAR_API_ROOT
from . import metadata as metadata_service


def load_settings():
    if not get_context().config_path.exists():
        return {}
    try:
        raw = json.loads(get_context().config_path.read_text("utf-8"))
        if not isinstance(raw, dict):
            raise ValueError('Settings must be an object')
        for key in SENSITIVE_SETTING_KEYS:
            if isinstance(raw.get(key), str) and raw[key].startswith('enc:v1:'):
                raw[key] = decrypt_secret(raw[key])
        return raw
    except (OSError, UnicodeError, ValueError):
        logger.warning('load_settings: recovering from expected failure')
        return {}


def load_library() -> Library:
    backup_dir = get_context().config_dir / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)
    if get_context().library_path.exists():
        try:
            raw = get_context().library_path.read_text('utf-8').strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict) and isinstance(data.get('papers'), list):
                    validate_library_limit(data)
                    data.setdefault('format', 'pulse-map')
                    data.setdefault('version', get_context().version)
                    return data
        except (OSError, UnicodeError, json.JSONDecodeError):
            logger.warning('load_library: recovering from expected failure')
            pass

    if backup_dir.exists():
        backups = sorted(backup_dir.glob('library_*.json'), key=os.path.getmtime, reverse=True)
        for p in backups:
            try:
                raw = p.read_text('utf-8').strip()
                if not raw:
                    continue
                data = json.loads(raw)
                if isinstance(data, dict) and isinstance(data.get('papers'), list):
                    validate_library_limit(data)
                    data.setdefault('format', 'pulse-map')
                    data.setdefault('version', get_context().version)
                    return data
            except (OSError, UnicodeError, json.JSONDecodeError):
                logger.warning('load_library: recovering from expected failure')
                continue
    return {'format': 'pulse-map', 'version': get_context().version, 'papers': []}


def save_library(payload: JSONDict):
    # Ordered revision checks also cover final unload beacons arriving before earlier HTTP saves.
    with get_context().library_write_lock:
        session = payload.get('_saveSession') if isinstance(payload, dict) else None
        revision = payload.get('_saveRevision') if isinstance(payload, dict) else None
        ordered = isinstance(session, str) and 0 < len(session) <= 100 and isinstance(revision, int)
        if ordered and revision <= get_context().save_revisions.get(session, -1):
            return {'ok': True, 'superseded': True}
        result = _save_library(payload)
        if ordered:
            get_context().save_revisions[session] = revision
            if len(get_context().save_revisions) > 64:
                get_context().save_revisions.pop(next(iter(get_context().save_revisions)))
        return result


def _save_library(payload: JSONDict):
    if not isinstance(payload, dict):
        raise ClientError(400, 'Library payload must be a JSON object.')
    if not isinstance(payload.get('papers'), list) or not all(isinstance(paper, dict) for paper in payload['papers']):
        raise ClientError(400, 'Library papers must be an array of paper objects.')
    validate_library_limit(payload, saving=True)
    get_context().config_dir.mkdir(parents=True, exist_ok=True)
    backup_dir = get_context().config_dir / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)

    data = dict(payload)
    data['format'] = data.get('format') or 'pulse-map'
    data['version'] = data.get('version') or get_context().version
    if get_context().max_papers is not None:
        data['edition'] = 'lite'
        data['paperLimit'] = get_context().max_papers
    data['savedAt'] = metadata_service.time_iso()

    is_reset = bool(payload.get('reset')) or len(payload.get('papers', [])) == 0
    if is_reset:
        # Clear old backup snapshots so deleted papers do not resurrect
        if backup_dir.exists():
            for old in backup_dir.glob('library_*.json'):
                try: old.unlink()
                except OSError:
                    logger.warning('_save_library: recovering from expected failure')
    elif get_context().library_path.exists() and get_context().library_path.stat().st_size > 10:
        # Backup existing valid file before replacing
        try:
            json.loads(get_context().library_path.read_text('utf-8'))
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_file = backup_dir / f'library_{ts}.json'
            shutil.copy2(get_context().library_path, backup_file)
            # Retain last 10 snapshots
            all_b = sorted(backup_dir.glob('library_*.json'), key=os.path.getmtime)
            for old in all_b[:-10]:
                try: old.unlink()
                except OSError:
                    logger.warning('_save_library: recovering from expected failure')
        except (OSError, UnicodeError, json.JSONDecodeError):
            logger.warning('_save_library: recovering from expected failure')
            pass

    # Atomic write via temporary file + fsync + os.replace
    temp_fd, temp_path = tempfile.mkstemp(dir=str(get_context().config_dir), prefix='.lib_tmp_', suffix='.json')
    try:
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, str(get_context().library_path))
        try:
            get_context().library_path.chmod(0o600)
        except OSError:
            logger.warning('_save_library: recovering from expected failure')
            pass
    finally:
        if os.path.exists(temp_path):
            try: os.unlink(temp_path)
            except OSError:
                logger.warning('_save_library: recovering from expected failure')

    return {'ok': True, 'path': str(get_context().library_path), 'savedAt': data['savedAt']}


def save_settings(payload: JSONDict):
    current = load_settings()
    ai_provider = str(payload.get('aiProvider') or current.get('aiProvider') or LOCAL_BACKEND_DEFAULTS['aiProvider']).strip().lower()
    if ai_provider not in {'local', 'cloud'}:
        ai_provider = LOCAL_BACKEND_DEFAULTS['aiProvider']
    cloud_provider = str(payload.get('cloudProvider') or current.get('cloudProvider') or 'google-ai-studio').strip()
    cloud_model = str(payload.get('cloudModel') or payload.get('model') or current.get('cloudModel') or current.get('model') or 'gemini-2.5-flash').strip()
    gemma_model = metadata_service.normalize_gemma_model(payload.get('gemmaModel') or current.get('gemmaModel') or DEFAULT_GEMMA_MODEL)
    ollama_chat_endpoint = metadata_service.normalize_ollama_endpoint(
        payload.get('ollamaChatEndpoint') or current.get('ollamaChatEndpoint') or LOCAL_BACKEND_DEFAULTS['ollamaChatEndpoint'],
        'chat',
    )
    embedding_model = (payload.get('embeddingModel') or current.get('embeddingModel') or LOCAL_BACKEND_DEFAULTS['embeddingModel']).strip()
    auto_gemma_extraction = payload.get('autoGemmaExtraction')
    if not isinstance(auto_gemma_extraction, bool):
        auto_gemma_extraction = current.get('autoGemmaExtraction', LOCAL_BACKEND_DEFAULTS['autoGemmaExtraction'])
    dimensions_key = payload.get('dimensionsApiKey')
    s2_key = payload.get('semanticScholarApiKey')
    api_key = payload.get('apiKey') or payload.get('geminiApiKey')

    settings = dict(current)
    settings['aiProvider'] = ai_provider
    settings['cloudProvider'] = cloud_provider
    settings['cloudModel'] = cloud_model
    settings['model'] = cloud_model
    settings['gemmaModel'] = gemma_model
    settings['ollamaChatEndpoint'] = ollama_chat_endpoint
    settings['embeddingModel'] = embedding_model
    settings['autoGemmaExtraction'] = bool(auto_gemma_extraction)

    if isinstance(api_key, str) and api_key.strip():
        settings['apiKey'] = api_key.strip()
    elif payload.get('clearApiKey'):
        settings['apiKey'] = ''

    if isinstance(dimensions_key, str) and dimensions_key.strip():
        settings['dimensionsApiKey'] = dimensions_key.strip()
    elif payload.get('clearDimensionsApiKey'):
        settings['dimensionsApiKey'] = ''

    if isinstance(s2_key, str) and s2_key.strip():
        settings['semanticScholarApiKey'] = s2_key.strip()
    elif payload.get('clearSemanticScholarApiKey'):
        settings['semanticScholarApiKey'] = ''

    return write_settings(settings)


def write_settings(settings: JSONDict):
    get_context().config_dir.mkdir(parents=True, exist_ok=True)
    to_save = dict(settings)
    for key in SENSITIVE_SETTING_KEYS:
        if isinstance(to_save.get(key), str) and to_save[key].strip():
            to_save[key] = encrypt_secret(to_save[key])
    get_context().config_path.write_text(json.dumps(to_save, indent=2), "utf-8")
    try:
        get_context().config_path.chmod(0o600)
    except OSError:
        logger.warning('write_settings: recovering from expected failure')
        pass
    return settings


def public_settings(settings: JSONDict):
    from . import ai as ai_service
    from . import providers as providers_service
    from . import runtime as runtime_service
    dimensions_key = providers_service.resolve_dimensions_api_key(settings)
    s2_key = providers_service.resolve_semantic_scholar_api_key(settings)
    gemini_key = ai_service.resolve_gemini_api_key(settings)
    caps = ai_service.workflow_capabilities()
    ollama = ai_service.ollama_status(settings)
    ollama["bundled"] = runtime_service.bundled_ollama_status()
    ai_provider = ai_service.resolve_ai_provider(settings)
    local_ready = bool(ollama.get("online")) and bool(ollama.get("chatModelAvailable"))
    cloud_ready = bool(gemini_key)
    is_ready = cloud_ready if ai_provider == "cloud" else local_ready

    cloud_provider = settings.get("cloudProvider") or "google-ai-studio"
    cloud_model = ai_service.resolve_cloud_model(settings)

    runtime_warning = ""
    if ai_provider == "cloud" and not cloud_ready:
        runtime_warning = "Gemini API key is not configured. Add your Google AI Studio API key in Settings."
    elif ai_provider == "local" and not local_ready:
        runtime_warning = "Local AI runtime not detected. Start Ollama or choose Cloud provider in Settings."

    return {
        "configured": is_ready,
        "aiProvider": ai_provider,
        "cloudProvider": cloud_provider,
        "cloudModel": cloud_model,
        "hasApiKey": bool(gemini_key),
        "apiKeyPreview": ai_service.preview_key(gemini_key),
        "localInferenceEnabled": local_ready,
        "cloudInferenceEnabled": cloud_ready,
        "runtimeWarning": runtime_warning,
        "gemmaModel": ai_service.resolve_gemma_model(settings),
        "ollamaChatEndpoint": ai_service.resolve_ollama_chat_endpoint(settings),
        "ollamaTagsEndpoint": ai_service.resolve_ollama_tags_endpoint(settings),
        "ollamaEmbeddingsEndpoint": ai_service.resolve_ollama_embeddings_endpoint(settings),
        "embeddingModel": ai_service.resolve_embedding_model(settings),
        "autoGemmaExtraction": settings.get("autoGemmaExtraction", LOCAL_BACKEND_DEFAULTS["autoGemmaExtraction"]),
        "configPath": str(get_context().config_path),
        "defaults": LOCAL_BACKEND_DEFAULTS,
        "workflow": {
            "pdfExtraction": caps["pdfExtraction"],
            "sectionDetection": "heading heuristics",
            "metadataExtraction": f"{ai_provider.title()} AI parser + verified DOI",
            "chunking": "paragraphs",
            "embeddings": f"{'Gemini text-embedding-004' if ai_provider == 'cloud' else 'Ollama / Hybrid 1024'}",
            "vectorDb": caps["vectorDb"],
        },
        "providers": {
            "cloud": {
                "provider": cloud_provider,
                "model": cloud_model,
                "configured": cloud_ready,
                "preview": ai_service.preview_key(gemini_key),
                "endpoint": "https://generativelanguage.googleapis.com",
            },
            "gemma": {
                "configured": local_ready,
                "endpoint": ai_service.resolve_ollama_chat_endpoint(settings),
                "model": ai_service.resolve_gemma_model(settings),
                "missing": bool(ollama.get("online")) and not bool(ollama.get("chatModelAvailable")),
                "warning": "" if local_ready else (ollama.get("chatWarning", "") or "Local AI runtime not detected. Start Ollama or choose a cloud provider."),
                "note": "Uses local Ollama /api/chat. Pull the selected model before running inference.",
            },
            "embeddings": {
                "available": bool(ollama.get("embeddingModelAvailable")) or cloud_ready,
                "active": "text-embedding-004" if ai_provider == "cloud" else ai_service.resolve_embedding_model(settings),
                "endpoint": "Google AI Studio" if ai_provider == "cloud" else ai_service.resolve_ollama_embeddings_endpoint(settings),
                "fallback": "hybrid-semantic-1024",
                "missing": False,
                "warning": "",
            },
            "vectorDb": {
                "available": caps["vectorAvailable"],
                "active": caps["vectorDb"],
            },
            "ollama": ollama,
            "dimensions": {
                "configured": bool(dimensions_key),
                "preview": ai_service.preview_key(dimensions_key),
                "endpoint": DIMENSIONS_API_ROOT,
                "note": "Optional. When configured, Recommend more papers bundles Dimensions results with OpenAlex and Crossref.",
            },
            "semanticScholar": {
                "configured": bool(s2_key),
                "preview": ai_service.preview_key(s2_key),
                "endpoint": SEMANTIC_SCHOLAR_API_ROOT,
                "note": "Optional. S2AG works free out-of-the-box; an API key enables higher throughput.",
            },
        },
    }


def settings_view():
    return public_settings(load_settings())


def update_settings_view(payload: JSONDict):
    return public_settings(save_settings(payload))


def validate_library_limit(data, saving=False):
    context = get_context()
    if context.max_papers is not None:
        if len(data['papers']) > context.max_papers:
            message = ('Pulse Lite is limited to 15 papers. Remove papers before saving.' if saving else
                       'Pulse Lite saved library exceeds the 15-paper limit. The file has not been changed; reset Lite in Settings or restore a smaller library.')
            raise ClientError(413, message)
        if not saving:
            data['edition'] = 'lite'
            data['paperLimit'] = context.max_papers


SENSITIVE_SETTING_KEYS = frozenset({"apiKey", "dimensionsApiKey", "semanticScholarApiKey", "geminiApiKey"})

def _get_encryption_key():
    get_context().config_dir.mkdir(parents=True, exist_ok=True)
    key_path = get_context().config_dir / ".secrets.key"
    if key_path.exists():
        try:
            k = key_path.read_bytes()
            if len(k) == 32:
                return k
        except (ImportError, OSError, ValueError, UnicodeError):
            logger.warning("Credential operation could not use its preferred format")
            pass
    k = secrets.token_bytes(32)
    key_path.write_bytes(k)
    try:
        key_path.chmod(0o600)
    except OSError:
        pass
    return k

def encrypt_secret(plaintext):
    if not plaintext or not isinstance(plaintext, str):
        return ""
    if plaintext.startswith("enc:v1:"):
        return plaintext
    key = get_encryption_key()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        nonce = secrets.token_bytes(12)
        ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return "enc:v1:" + base64.b64encode(nonce + ct).decode("utf-8")
    except ImportError:
        logger.debug("AES-GCM unavailable; using the existing authenticated fallback format")
        nonce = secrets.token_bytes(16)
        raw = plaintext.encode("utf-8")
        stream_key = hashlib.sha256(key + nonce).digest()
        blocks = (hashlib.sha256(stream_key + i.to_bytes(4, "big")).digest() for i in range((len(raw) // 32) + 1))
        keystream = b"".join(blocks)[:len(raw)]
        encrypted = bytes(a ^ b for a, b in zip(raw, keystream))
        tag = hmac.new(key, nonce + encrypted, hashlib.sha256).digest()[:16]
        return "enc:v1:" + base64.b64encode(nonce + tag + encrypted).decode("utf-8")

def decrypt_secret(ciphertext):
    if not ciphertext or not isinstance(ciphertext, str):
        return ""
    if not ciphertext.startswith("enc:v1:"):
        return ciphertext
    payload_b64 = ciphertext[len("enc:v1:"):]
    try:
        raw = base64.b64decode(payload_b64)
    except (ImportError, OSError, ValueError, UnicodeError):
        logger.warning("Credential operation could not use its preferred format")
        return ""
    key = get_encryption_key()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = raw[:12]
        ct = raw[12:]
        from cryptography.exceptions import InvalidTag
        aesgcm = AESGCM(key)
        try:
            return aesgcm.decrypt(nonce, ct, None).decode("utf-8")
        except InvalidTag:
            raise ValueError("Alternative encrypted credential format") from None
    except (ImportError, OSError, ValueError, UnicodeError):
        logger.warning("Credential operation could not use its preferred format")
        try:
            nonce = raw[:16]
            tag = raw[16:32]
            encrypted = raw[32:]
            expected_tag = hmac.new(key, nonce + encrypted, hashlib.sha256).digest()[:16]
            if not hmac.compare_digest(tag, expected_tag):
                return ""
            stream_key = hashlib.sha256(key + nonce).digest()
            blocks = (hashlib.sha256(stream_key + i.to_bytes(4, "big")).digest() for i in range((len(encrypted) // 32) + 1))
            keystream = b"".join(blocks)[:len(encrypted)]
            decrypted = bytes(a ^ b for a, b in zip(encrypted, keystream))
            return decrypted.decode("utf-8")
        except (ImportError, OSError, ValueError, UnicodeError):
            logger.warning("Credential operation could not use its preferred format")
            return ""


def get_encryption_key():
    with get_context().credential_lock:
        return _get_encryption_key()
