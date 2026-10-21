import pulse_core as _core
__all__ = ["load_settings", "write_settings", "load_library", "save_library", "_save_library", "save_settings", "public_settings", "SAVE_REVISIONS", "change_library", "list_recovery", "restore_recovery"]
import json
import os
import shutil
import tempfile
import uuid
import re
import copy
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
    resolve_core_api_key,
    resolve_openalex_api_key,
    resolve_contact_email,
)
from pulse_core.security import SENSITIVE_SETTING_KEYS, decrypt_secret, encrypt_secret
from pulse_performance import LIBRARY_WRITE_LOCK

SAVE_REVISIONS = {}

def load_settings():
    if not _core.CONFIG_PATH.exists():
        return {}
    try:
        raw = json.loads(_core.CONFIG_PATH.read_text("utf-8"))
        for k in SENSITIVE_SETTING_KEYS:
            if k in raw and isinstance(raw[k], str) and raw[k].startswith("enc:v1:"):
                raw[k] = decrypt_secret(raw[k])
        return raw
    except json.JSONDecodeError:
        return {}

def write_settings(settings):
    _core.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    to_save = dict(settings)
    for k in SENSITIVE_SETTING_KEYS:
        if k in to_save and isinstance(to_save[k], str) and to_save[k].strip() and not to_save[k].startswith("enc:v1:"):
            to_save[k] = encrypt_secret(to_save[k])
    _core.CONFIG_PATH.write_text(json.dumps(to_save, indent=2), "utf-8")
    try:
        _core.CONFIG_PATH.chmod(0o600)
    except OSError:
        pass
    return settings

def _load_legacy_library():
    backup_dir = _core.CONFIG_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    if _core.LIBRARY_PATH.exists():
        try:
            raw = _core.LIBRARY_PATH.read_text("utf-8").strip()
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

def _library_checkpoint(data, reason):
    backup_dir = _core.CONFIG_DIR / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)
    path = backup_dir / ('library_' + reason + '_' + datetime.now().strftime('%Y%m%d_%H%M%S_%f') + '.json')
    _write_recovery(path, data)
    # Leave the first JSON snapshot available for older versions and explicit export.
    if not _core.LIBRARY_PATH.exists():
        _write_recovery(_core.LIBRARY_PATH, data)
    checkpoints = sorted(backup_dir.glob('library_checkpoint_*.json'), key=os.path.getmtime)
    for old in checkpoints[:-10]:
        old.unlink(missing_ok=True)

def library_store():
    from pulse_core.library_store import LibraryStore
    return LibraryStore(_core.LIBRARY_PATH, _load_legacy_library, _library_checkpoint)

def load_library():
    with LIBRARY_WRITE_LOCK:
        return library_store().read()

def save_library(payload):
    with LIBRARY_WRITE_LOCK:
        session = payload.get('_saveSession') if isinstance(payload, dict) else None
        revision = payload.get('_saveRevision') if isinstance(payload, dict) else None
        ordered = isinstance(session, str) and 0 < len(session) <= 100 and isinstance(revision, int)
        if ordered and revision <= SAVE_REVISIONS.get(session, -1):
            return {'ok': True, 'superseded': True}
        result = _core._save_library(payload)
        if ordered:
            SAVE_REVISIONS[session] = revision
            if len(SAVE_REVISIONS) > 64: SAVE_REVISIONS.pop(next(iter(SAVE_REVISIONS)))
        return result

def _save_library(payload, existing_data=None):
    return library_store().write(payload)

def _validate_workspace(data):
    if not isinstance(data, dict) or not isinstance(data.get('papers'), list) or not all(isinstance(p, dict) and isinstance(p.get('id'), str) for p in data['papers']):
        raise ClientError(400, 'A valid workspace is required.')
    if len({p['id'] for p in data['papers']}) != len(data['papers']):
        raise ClientError(400, 'Paper IDs must be unique.')
    return copy.deepcopy(data)

def _write_recovery(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.recovery-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def _snapshot(workspace, reason, ids=None):
    identity = uuid.uuid4().hex
    _write_recovery(_core.CONFIG_DIR / 'recovery' / (identity + '.json'),
                    {'id': identity, 'reason': reason, 'createdAt': time_iso(), 'paperIds': ids,
                     'workspace': workspace})
    return identity

def list_recovery():
    items = []
    with LIBRARY_WRITE_LOCK:
        for path in (_core.CONFIG_DIR / 'recovery').glob('*.json'):
            try:
                data = json.loads(path.read_text('utf-8'))
                papers = data['workspace']['papers']
                count = len(data['paperIds']) if data.get('paperIds') is not None else len(papers)
                items.append({key: data.get(key) for key in ('id', 'reason', 'createdAt', 'restoredAt')} | {'count': count})
            except (OSError, ValueError, KeyError, TypeError): continue
    return {'items': sorted(items, key=lambda item: item['createdAt'] or '', reverse=True)}

def _write_barrier(payload):
    session,revision = payload.get('_saveSession'),payload.get('_saveRevision')
    if isinstance(session,str) and 0 < len(session) <= 100 and isinstance(revision,int):
        SAVE_REVISIONS[session] = max(revision,SAVE_REVISIONS.get(session,-1))

def change_library(payload):
    with LIBRARY_WRITE_LOCK:
        before = _validate_workspace(payload.get('workspace'))
        reason = payload.get('action')
        if reason not in {'remove', 'clear'}: raise ClientError(400, 'Choose remove or clear.')
        ids = payload.get('ids')
        if reason == 'remove':
            if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
                raise ClientError(400, 'Choose papers to remove.')
            available = {p['id'] for p in before['papers']}
            ids = list(dict.fromkeys(ids))
            if not set(ids) <= available: raise ClientError(409, 'Some chosen papers are no longer in the library.')
            after = copy.deepcopy(before)
            after['papers'] = [p for p in before['papers'] if p['id'] not in ids]
            after['links'] = [link for link in before.get('links', []) if link.get('source') not in ids and link.get('target') not in ids]
            for key in ('selectedId', 'centerId'):
                if after.get(key) in ids: after[key] = None
        else:
            ids = None
            after = {'papers': [], 'areas': [], 'reset': True, 'format': 'pulse-map', 'mendeleyIgnored':before.get('mendeleyIgnored',[]), 'mendeleySyncPaused':True}
        if reason == 'clear':
            for key in ('savedSearches', 'discoverySearchTags', 'discoveryQueryMatch', 'discoveryRankingMode', 'discoverySearchScope'):
                if key in before: after[key] = copy.deepcopy(before[key])
        # Recovery must be durable before the destructive write is attempted.
        identity = _snapshot(before, reason, ids)
        _core._save_library(dict(after, allowEmpty=True))
        _write_barrier(payload)
        return {'ok': True, 'recoveryId': identity, 'workspace': after}

def restore_recovery(payload):
    with LIBRARY_WRITE_LOCK:
        identity = payload.get('id', '')
        if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{32}', identity):
            raise ClientError(400, 'Choose a valid recovery point.')
        path = _core.CONFIG_DIR / 'recovery' / (identity + '.json')
        try: snapshot = json.loads(path.read_text('utf-8'))
        except (OSError, ValueError): raise ClientError(404, 'This recovery point is unavailable.')
        if snapshot.get('restoredAt'): raise ClientError(409, 'This recovery point has already been restored.')
        current = _validate_workspace(payload.get('workspace'))
        saved = _validate_workspace(snapshot['workspace'])
        if snapshot.get('paperIds') is not None:
            after = copy.deepcopy(current)
            existing = {p['id'] for p in current['papers']}
            restored = [p for p in saved['papers'] if p['id'] in snapshot['paperIds'] and p['id'] not in existing]
            after['papers'].extend(restored)
            restored_areas = {p.get('areaId') for p in restored}
            area_ids = {a['id'] for a in current.get('areas', [])}
            after['areas'] = current.get('areas', []) + [a for a in saved.get('areas', []) if a['id'] in restored_areas and a['id'] not in area_ids]
        else:
            after = saved
        # Restoring a whole workspace is also reversible, including newer papers.
        undo_id = _snapshot(current, 'restore')
        _core._save_library(dict(after, allowEmpty=True))
        _write_barrier(payload)
        snapshot['restoredAt'] = time_iso()
        try:
            _write_recovery(path, snapshot)
        except OSError:
            # The restored library and its undo point are already durable.
            # A failed status update must not make the UI autosave the old state.
            pass
        return {'ok': True, 'recoveryId': undo_id, 'workspace': after}

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
    for key in ('searchAdaptiveStructure','searchBiomedicalRouter'):
        if key in payload:
            if not isinstance(payload[key],bool):raise ClientError(400,'Ranking experiment switches must be true or false.')
            settings[key]=payload[key]
    if 'searchStructuralIntent' in payload:
        if payload['searchStructuralIntent'] not in ('auto','bibliography','focused'):raise ClientError(400,'Choose an adaptive citation intent.')
        settings['searchStructuralIntent']=payload['searchStructuralIntent']
    if 'searchBiomedicalModelPath' in payload:
        value=payload['searchBiomedicalModelPath']
        if not isinstance(value,str) or len(value)>4096:raise ClientError(400,'Choose a local biomedical model folder.')
        settings['searchBiomedicalModelPath']=value.strip()
    settings["aiProvider"] = ai_provider
    settings["cloudProvider"] = cloud_provider
    settings["cloudModel"] = cloud_model
    settings["model"] = cloud_model
    settings["gemmaModel"] = gemma_model
    settings["ollamaChatEndpoint"] = ollama_chat_endpoint
    settings["embeddingModel"] = embedding_model
    from pulse_core.research_models import role
    for name in ('triageModel', 'reportModel'):
        settings[name] = role({**current, **({name: payload[name]} if name in payload else {})}, name)
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
    if (isinstance(s2_key, str) and s2_key.strip()) or payload.get("clearSemanticScholarApiKey"):
        from pulse_core.s2_client import reset_s2_access
        reset_s2_access()
    core_key = payload.get("coreApiKey")
    if isinstance(core_key, str) and core_key.strip():
        settings["coreApiKey"] = core_key.strip()
    elif payload.get("clearCoreApiKey"):
        settings["coreApiKey"] = ""
    openalex_key = payload.get("openAlexApiKey")
    if isinstance(openalex_key, str) and openalex_key.strip():
        settings["openAlexApiKey"] = openalex_key.strip()
        try:
            from pulse_source_health import clear_source
            clear_source("api.openalex.org")
            clear_source("OpenAlex")
        except Exception:
            pass
    elif payload.get("clearOpenAlexApiKey"):
        settings["openAlexApiKey"] = ""
    contact_email = payload.get("contactEmail") or payload.get("pulse_contact_email")
    if isinstance(contact_email, str):
        settings["pulse_contact_email"] = contact_email.strip()
    elif payload.get("clearContactEmail"):
        settings["pulse_contact_email"] = ""
    return write_settings(settings)

def public_settings(settings):
    from pulse_core.ollama_mgr import bundled_ollama_status, ollama_status, workflow_capabilities
    dim_key = resolve_dimensions_api_key(settings)
    s2_key = resolve_semantic_scholar_api_key(settings)
    s2_saved = bool(str(settings.get("semanticScholarApiKey") or "").strip())
    s2_environment = bool(str(os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or "").strip())
    core_key = resolve_core_api_key(settings)
    openalex_key = resolve_openalex_api_key(settings)
    contact_email = resolve_contact_email(settings)
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
        "triageModel": settings.get('triageModel') or 'llama3.2:3b',
        "reportModel": settings.get('reportModel') or 'qwen2.5:7b',
        "autoGemmaExtraction": settings.get("autoGemmaExtraction", LOCAL_BACKEND_DEFAULTS["autoGemmaExtraction"]),
        "configPath": str(_core.CONFIG_PATH),
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
            "core": {"configured": bool(core_key), "publicSearch": True},
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
                "saved": s2_saved,
                "source": "environment" if s2_environment else "saved" if s2_saved else "",
                "endpoint": SEMANTIC_SCHOLAR_API_ROOT,
                "note": "Optional. A configured key is used for paper searches, citations and recommendations.",
            },
            "openAlex": {
                "configured": bool(openalex_key),
                "preview": preview_key(openalex_key),
                "contactEmail": contact_email,
                "endpoint": "https://api.openalex.org",
                "note": "Optional. Public searches work keyless (10 req/s); an API key enables 100 req/s.",
            },
            "openAlex": {
                "configured": bool(openalex_key),
                "preview": preview_key(openalex_key),
                "contactEmail": contact_email,
                "endpoint": "https://api.openalex.org",
                "note": "Optional. Public searches work keyless (10 req/s); an API key enables 100 req/s.",
            },
        },
    }
