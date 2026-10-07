import os

def resolve_semantic_scholar_api_key(settings):
    return os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or settings.get("semanticScholarApiKey") or ""

def resolve_dimensions_api_key(settings):
    return os.environ.get("DIMENSIONS_API_KEY") or settings.get("dimensionsApiKey") or ""

def resolve_gemini_api_key(settings):
    return str(settings.get("apiKey") or settings.get("geminiApiKey") or os.environ.get("GEMINI_API_KEY") or "").strip()

def resolve_cloud_model(settings):
    return str(settings.get("cloudModel") or settings.get("model") or "gemini-2.5-flash").strip()

def resolve_ai_provider(settings):
    provider = str(settings.get("aiProvider") or "local").strip().lower()
    return provider if provider in {"local", "cloud"} else "local"

def resolve_gemma_model(settings):
    from pulse_core.constants import DEFAULT_GEMMA_MODEL
    from pulse_core.ollama_mgr import normalize_gemma_model
    return normalize_gemma_model(settings.get("gemmaModel") or DEFAULT_GEMMA_MODEL)

def resolve_embedding_model(settings):
    from pulse_core.constants import LOCAL_BACKEND_DEFAULTS
    return str(settings.get("embeddingModel") or LOCAL_BACKEND_DEFAULTS["embeddingModel"]).strip()

def resolve_ollama_chat_endpoint(settings):
    from pulse_core.constants import LOCAL_BACKEND_DEFAULTS
    from pulse_core.ollama_mgr import normalize_ollama_endpoint
    return normalize_ollama_endpoint(settings.get("ollamaChatEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"], "chat")

def resolve_ollama_tags_endpoint(settings):
    from pulse_core.constants import LOCAL_BACKEND_DEFAULTS
    from pulse_core.ollama_mgr import normalize_ollama_endpoint
    return normalize_ollama_endpoint(settings.get("ollamaTagsEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaTagsEndpoint"], "tags")

def resolve_ollama_embeddings_endpoint(settings):
    from pulse_core.constants import LOCAL_BACKEND_DEFAULTS
    from pulse_core.ollama_mgr import normalize_ollama_endpoint
    return normalize_ollama_endpoint(settings.get("ollamaEmbeddingsEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaEmbeddingsEndpoint"], "embeddings")
