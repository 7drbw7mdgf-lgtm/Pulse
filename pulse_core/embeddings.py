import pulse_core as _core
__all__ = ["hashed_embedding", "hybrid_semantic_embedding", "cosine", "gemini_embedding", "_gemini_embedding", "ollama_embedding", "_ollama_embedding"]
import hashlib
import json
import math
import urllib.request
from pulse_core.constants import  ClientError
from pulse_core.config_resolvers import (
    resolve_embedding_model,
    resolve_gemini_api_key,
    resolve_ollama_embeddings_endpoint,
)
from pulse_performance import cached_embedding

def hashed_embedding(text, dimensions=256):
    words = (text or "").lower().split()
    vec = [0.0] * dimensions
    if not words:
        return vec
    for word in words:
        h = int(hashlib.md5(word.encode("utf-8")).hexdigest(), 16)
        idx = h % dimensions
        vec[idx] += 1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec

def hybrid_semantic_embedding(text, dimensions=1024):
    words = (text or "").lower().split()
    vec = [0.0] * dimensions
    if not words:
        return vec
    for i, word in enumerate(words):
        h = int(hashlib.sha256(word.encode("utf-8")).hexdigest(), 16)
        vec[h % dimensions] += 1.0
        if i < len(words) - 1:
            bg = f"{word}_{words[i+1]}"
            h2 = int(hashlib.md5(bg.encode("utf-8")).hexdigest(), 16)
            vec[h2 % dimensions] += 1.5
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec] if norm > 0 else vec

def cosine(left, right):
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    norm_a = math.sqrt(sum(a * a for a, b in zip(left, right)))
    norm_b = math.sqrt(sum(b * b for a, b in zip(left, right)))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return max(-1.0, min(1.0, dot / (norm_a * norm_b)))

def gemini_embedding(settings, text):
    return cached_embedding(_core.CONFIG_DIR, ["cloud", settings.get("cloudProvider"), settings.get("apiKey"), "text-embedding-004"], text, lambda: _core._gemini_embedding(settings, text))

def _gemini_embedding(settings, text):
    api_key = resolve_gemini_api_key(settings)
    if not api_key:
        return None
    url = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
    payload = {
        "model": "models/text-embedding-004",
        "content": {"parts": [{"text": str(text or "")[:2048]}]}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("embedding", {}).get("values")
    except Exception:
        return None

def ollama_embedding(settings, text):
    return cached_embedding(_core.CONFIG_DIR, ["local", resolve_ollama_embeddings_endpoint(settings), resolve_embedding_model(settings)], text, lambda: _core._ollama_embedding(settings, text))

def _ollama_embedding(settings, text):
    model = resolve_embedding_model(settings)
    payload = {
        "model": model,
        "prompt": str(text or "")[:4000],
    }
    endpoint = resolve_ollama_embeddings_endpoint(settings)
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("embedding")
    except Exception:
        return None
