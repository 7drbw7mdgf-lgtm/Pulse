__all__ = ["load_settings", "write_settings", "load_library", "save_library", "_save_library", "save_settings", "public_settings", "SAVE_REVISIONS"]
import pulse_backend as _pb
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from pulse_core.constants import (
    APP_VERSION,
    
    
    DIMENSIONS_API_ROOT,
    
    LOCAL_BACKEND_DEFAULTS,
    SEMANTIC_SCHOLAR_API_ROOT,
    ClientError,
    preview_key,
    time_iso,
)
from pulse_core.config_resolvers import (
    resolve_ai_provider,
    resolve_cloud_model,
    resolve_dimensions_api_key,
    resolve_embedding_model,
    resolve_gemini_api_key,
    resolve_gemma_model,
    resolve_ollama_chat_endpoint,
    resolve_ollama_embeddings_endpoint,
    resolve_ollama_tags_endpoint,
    resolve_semantic_scholar_api_key,
)
from pulse_core.security import SENSITIVE_SETTING_KEYS, decrypt_secret, encrypt_secret
from pulse_performance import LIBRARY_WRITE_LOCK

SAVE_REVISIONS = {}

def load_settings():
    if not _pb.CONFIG_PATH.exists():
        return {}
    try:
        raw = json.loads(_pb.CONFIG_PATH.read_text("utf-8"))
        for k in SENSITIVE_SETTING_KEYS:
            if k in raw and isinstance(raw[k], str) and raw[k].startswith("enc:v1:"):
                raw[k] = decrypt_secret(raw[k])
        return raw
    except json.JSONDecodeError:
        return {}

def write_settings(settings):
    _pb.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    to_save = dict(settings)
    for k in SENSITIVE_SETTING_KEYS:
        if k in to_save and isinstance(to_save[k], str) and to_save[k].strip() and not to_save[k].startswith("enc:v1:"):
            to_save[k] = encrypt_secret(to_save[k])
    _pb.CONFIG_PATH.write_text(json.dumps(to_save, indent=2), "utf-8")
    try:
        _pb.CONFIG_PATH.chmod(0o600)
    except OSError:
        pass
    return settings

def load_library():
    backup_dir = _pb.CONFIG_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    if _pb.LIBRARY_PATH.exists():
        try:
            raw = _pb.LIBRARY_PATH.read_text("utf-8").strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict) and "papers" in data:
                    data.setdefault("format", "pulse-map")
                    data.setdefault("version", APP_VERSION)
                    return data
        except Exception:
            pass
    if backup_dir.exists():
        backups = sorted(backup_dir.glob("library_*.json"), key=os.path.getmtime, reverse=True)
        for p in backups:
            try:
                raw = p.read_text("utf-8").strip()
                if not raw:
                    continue
                data = json.loads(raw)
                if isinstance(data, dict) and "papers" in data:
                    data.setdefault("format", "pulse-map")
                    data.setdefault("version", APP_VERSION)
                    return data
            except Exception:
                continue
    return {"format": "pulse-map", "version": APP_VERSION, "papers": []}

def save_library(payload):
    with LIBRARY_WRITE_LOCK:
        session = payload.get("_saveSession") if isinstance(payload, dict) else None
        revision = payload.get("_saveRevision") if isinstance(payload, dict) else None
        ordered = isinstance(session, str) and 0 < len(session) <= 100 and isinstance(revision, int)
        if ordered and revision <= SAVE_REVISIONS.get(session, -1):
            return {"ok": True, "superseded": True}
        result = _pb._save_library(payload)
        if ordered:
            SAVE_REVISIONS[session] = revision
            if len(SAVE_REVISIONS) > 64:
                SAVE_REVISIONS.pop(next(iter(SAVE_REVISIONS)))
        return result

def _save_library(payload):
    if not isinstance(payload, dict):
        raise ClientError(400, "Library payload must be a JSON object.")
    if not isinstance(payload.get("papers"), list) or not all(isinstance(paper, dict) for paper in payload["papers"]):
        raise ClientError(400, "Library papers must be an array of paper objects.")
    _pb.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    backup_dir = _pb.CONFIG_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    data = dict(payload)
    data["format"] = data.get("format") or "pulse-map"
    data["version"] = data.get("version") or APP_VERSION
    data["savedAt"] = time_iso()
    is_reset = bool(payload.get("reset")) or len(payload.get("papers", [])) == 0
    if is_reset:
        if backup_dir.exists():
            for old in backup_dir.glob("library_*.json"):
                try: old.unlink()
                except OSError: pass
    elif _pb.LIBRARY_PATH.exists() and _pb.LIBRARY_PATH.stat().st_size > 10:
        try:
            json.loads(_pb.LIBRARY_PATH.read_text("utf-8"))
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_file = backup_dir / f"library_{ts}.json"
            shutil.copy2(_pb.LIBRARY_PATH, backup_file)
            all_b = sorted(backup_dir.glob("library_*.json"), key=os.path.getmtime)
            for old in all_b[:-10]:
                try: old.unlink()
                except OSError: pass
        except Exception:
            pass
    temp_fd, temp_path = tempfile.mkstemp(dir=str(_pb.CONFIG_DIR), prefix=".lib_tmp_", suffix=".json")
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, str(_pb.LIBRARY_PATH))
        try:
            _pb.LIBRARY_PATH.chmod(0o600)
        except OSError:
            pass
    finally:
        if os.path.exists(temp_path):
            try: os.unlink(temp_path)
            except OSError: pass
    return {"ok": True, "path": str(_pb.LIBRARY_PATH), "savedAt": data["savedAt"]}

def save_settings(payload):
    from pulse_core.ollama_mgr import normalize_gemma_model, normalize_ollama_endpoint
    current = load_settings()
    ai_provider = str(payload.get("aiProvider") or current.get("aiProvider") or LOCAL_BACKEND_DEFAULTS["aiProvider"]).strip().lower()
    if ai_provider not in {"local", "cloud"}:
        ai_provider = LOCAL_BACKEND_DEFAULTS["aiProvider"]
    cloud_provider = str(payload.get("cloudProvider") or current.get("cloudProvider") or "google-ai-studio").strip()
    cloud_model = str(payload.get("cloudModel") or payload.get("model") or current.get("cloudModel") or current.get("model") or "gemini-2.5-flash").strip()
    gemma_model = normalize_gemma_model(payload.get("gemmaModel") or current.get("gemmaModel") or LOCAL_BACKEND_DEFAULTS["chatModel"])
    ollama_chat_endpoint = normalize_ollama_endpoint(
        payload.get("ollamaChatEndpoint") or current.get("ollamaChatEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"], "chat"
    )
    embedding_model = (payload.get("embeddingModel") or current.get("embeddingModel") or LOCAL_BACKEND_DEFAULTS["embeddingModel"]).strip()
    auto_gemma_extraction = payload.get("autoGemmaExtraction")
    if not isinstance(auto_gemma_extraction, bool):
        auto_gemma_extraction = current.get("autoGemmaExtraction", LOCAL_BACKEND_DEFAULTS["autoGemmaExtraction"])
    dimensions_key = payload.get("dimensionsApiKey")
    s2_key = payload.get("semanticScholarApiKey")
    api_key = payload.get("apiKey") or payload.get("geminiApiKey")
    settings = dict(current)
    settings["aiProvider"] = ai_provider
    settings["cloudProvider"] = cloud_provider
    settings["cloudModel"] = cloud_model
    settings["model"] = cloud_model
    settings["gemmaModel"] = gemma_model
    settings["ollamaChatEndpoint"] = ollama_chat_endpoint
    settings["embeddingModel"] = embedding_model
    settings["autoGemmaExtraction"] = bool(auto_gemma_extraction)
    if isinstance(api_key, str) and api_key.strip():
        settings["apiKey"] = api_key.strip()
    elif payload.get("clearApiKey"):
        settings["apiKey"] = ""
    if isinstance(dimensions_key, str) and dimensions_key.strip():
        settings["dimensionsApiKey"] = dimensions_key.strip()
    elif payload.get("clearDimensionsApiKey"):
        settings["dimensionsApiKey"] = ""
    if isinstance(s2_key, str) and s2_key.strip():
        settings["semanticScholarApiKey"] = s2_key.strip()
    elif payload.get("clearSemanticScholarApiKey"):
        settings["semanticScholarApiKey"] = ""
    return write_settings(settings)

def public_settings(settings):
    from pulse_core.ollama_mgr import bundled_ollama_status, ollama_status, workflow_capabilities
    dim_key = resolve_dimensions_api_key(settings)
    s2_key = resolve_semantic_scholar_api_key(settings)
    gemini_key = resolve_gemini_api_key(settings)
    caps = workflow_capabilities()
    ollama = ollama_status(settings)
    ollama["bundled"] = bundled_ollama_status()
    ai_prov = resolve_ai_provider(settings)
    local_ready = bool(ollama.get("online")) and bool(ollama.get("chatModelAvailable"))
    cloud_ready = bool(gemini_key)
    is_ready = cloud_ready if ai_prov == "cloud" else local_ready
    cloud_provider = settings.get("cloudProvider") or "google-ai-studio"
    cloud_model = resolve_cloud_model(settings)
    runtime_warning = ""
    if ai_prov == "cloud" and not cloud_ready:
        runtime_warning = "Gemini API key is not configured. Add your Google AI Studio API key in Settings."
    elif ai_prov == "local" and not local_ready:
        runtime_warning = "Local AI runtime not detected. Start Ollama or choose Cloud provider in Settings."
    return {
        "configured": is_ready,
        "aiProvider": ai_prov,
        "cloudProvider": cloud_provider,
        "cloudModel": cloud_model,
        "hasApiKey": bool(gemini_key),
        "apiKeyPreview": preview_key(gemini_key),
        "localInferenceEnabled": local_ready,
        "cloudInferenceEnabled": cloud_ready,
        "runtimeWarning": runtime_warning,
        "gemmaModel": resolve_gemma_model(settings),
        "ollamaChatEndpoint": resolve_ollama_chat_endpoint(settings),
        "ollamaTagsEndpoint": resolve_ollama_tags_endpoint(settings),
        "ollamaEmbeddingsEndpoint": resolve_ollama_embeddings_endpoint(settings),
        "embeddingModel": resolve_embedding_model(settings),
        "autoGemmaExtraction": settings.get("autoGemmaExtraction", LOCAL_BACKEND_DEFAULTS["autoGemmaExtraction"]),
        "configPath": str(_pb.CONFIG_PATH),
        "defaults": LOCAL_BACKEND_DEFAULTS,
        "workflow": {
            "pdfExtraction": caps["pdfExtraction"],
            "sectionDetection": "heading heuristics",
            "metadataExtraction": f"{ai_prov.title()} AI parser + verified DOI",
            "chunking": "paragraphs",
            "embeddings": f"{'Gemini text-embedding-004' if ai_prov == 'cloud' else 'Ollama / Hybrid 1024'}",
            "vectorDb": caps["vectorDb"],
        },
        "providers": {
            "cloud": {
                "provider": cloud_provider,
                "model": cloud_model,
                "configured": cloud_ready,
                "preview": preview_key(gemini_key),
                "endpoint": "https://generativelanguage.googleapis.com",
            },
            "gemma": {
                "configured": local_ready,
                "endpoint": resolve_ollama_chat_endpoint(settings),
                "model": resolve_gemma_model(settings),
                "missing": bool(ollama.get("online")) and not bool(ollama.get("chatModelAvailable")),
                "warning": "" if local_ready else (ollama.get("chatWarning", "") or "Local AI runtime not detected. Start Ollama or choose a cloud provider."),
                "note": "Uses local Ollama /api/chat. Pull the selected model before running inference.",
            },
            "embeddings": {
                "available": bool(ollama.get("embeddingModelAvailable")) or cloud_ready,
                "active": "text-embedding-004" if ai_prov == "cloud" else resolve_embedding_model(settings),
                "endpoint": "Google AI Studio" if ai_prov == "cloud" else resolve_ollama_embeddings_endpoint(settings),
                "fallback": "hybrid-semantic-1024",
                "missing": False,
                "warning": "",
            },
            "vectorDb": {"available": caps["vectorAvailable"], "active": caps["vectorDb"]},
            "ollama": ollama,
            "dimensions": {
                "configured": bool(dim_key),
                "preview": preview_key(dim_key),
                "endpoint": DIMENSIONS_API_ROOT,
                "note": "Optional. When configured, Recommend more papers bundles Dimensions results with OpenAlex and Crossref.",
            },
            "semanticScholar": {
                "configured": bool(s2_key),
                "preview": preview_key(s2_key),
                "endpoint": SEMANTIC_SCHOLAR_API_ROOT,
                "note": "Optional. S2AG works free out-of-the-box; an API key enables higher throughput.",
            },
        },
    }
