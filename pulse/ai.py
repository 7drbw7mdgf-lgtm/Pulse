"""AI transport, model settings, chunk retrieval and analysis."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
import hashlib
import importlib.util
import json
import math
import os
import re
import urllib.request
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import get_context, ClientError, DEFAULT_GEMMA_MODEL, LOCAL_BACKEND_DEFAULTS
from .performance import cached_embedding
from . import metadata as metadata_service
from . import ranking as ranking_service
from . import storage as storage_service


def preview_key(api_key):
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "set"
    return f"{api_key[:4]}...{api_key[-4:]}"


def resolve_gemini_api_key(settings: JSONDict):
    return str(settings.get("apiKey") or settings.get("geminiApiKey") or os.environ.get("GEMINI_API_KEY") or "").strip()


def resolve_cloud_model(settings: JSONDict):
    return str(settings.get("cloudModel") or settings.get("model") or "gemini-2.5-flash").strip()


def resolve_ai_provider(settings: JSONDict):
    provider = str(os.environ.get("PULSE_AI_PROVIDER") or os.environ.get("IRATXE_AI_PROVIDER") or settings.get("aiProvider") or LOCAL_BACKEND_DEFAULTS["aiProvider"]).strip().lower()
    return provider if provider in {"local", "cloud"} else LOCAL_BACKEND_DEFAULTS["aiProvider"]


def resolve_gemma_model(settings: JSONDict):
    return metadata_service.normalize_gemma_model(os.environ.get("GEMMA_MODEL") or settings.get("gemmaModel") or DEFAULT_GEMMA_MODEL)


def resolve_embedding_model(settings: JSONDict):
    return (os.environ.get("OLLAMA_EMBEDDING_MODEL") or settings.get("embeddingModel") or LOCAL_BACKEND_DEFAULTS["embeddingModel"]).strip()


def resolve_ollama_chat_endpoint(settings: JSONDict):
    return metadata_service.normalize_ollama_endpoint(os.environ.get("OLLAMA_CHAT_ENDPOINT") or settings.get("ollamaChatEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"], "chat")


def resolve_ollama_tags_endpoint(settings: JSONDict):
    return metadata_service.endpoint_with_api(resolve_ollama_chat_endpoint(settings), "tags")


def resolve_ollama_embeddings_endpoint(settings: JSONDict):
    return metadata_service.endpoint_with_api(resolve_ollama_chat_endpoint(settings), "embeddings")


def ollama_tags(settings: JSONDict, timeout=3):
    endpoint = resolve_ollama_tags_endpoint(settings)
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": "pulse"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            models = payload.get("models", [])
            return [item.get("name") for item in models if isinstance(item, dict) and item.get("name")]
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        logger.debug('ollama_tags: recovering from expected failure')
        return []


def ollama_status(settings: JSONDict):
    from . import runtime as runtime_service
    tags = ollama_tags(settings, timeout=1.5)
    model = resolve_gemma_model(settings)
    embedding_model = resolve_embedding_model(settings)
    online = bool(tags) or runtime_service.ollama_server_responds(timeout=0.35)
    return {
        "online": online,
        "models": tags,
        "chatModel": model,
        "chatModelAvailable": model in tags,
        "chatWarning": "" if (not online or model in tags) else f"Model {model} not found in Ollama. Run: ollama pull {model}",
        "embeddingModel": embedding_model,
        "embeddingModelAvailable": embedding_model in tags,
        "embeddingWarning": "" if (not online or embedding_model in tags) else f"Embedding model {embedding_model} not found in Ollama. Run: ollama pull {embedding_model}",
    }


def require_ollama_model(settings: JSONDict, model, role):
    models = ollama_tags(settings)
    if model not in models:
        label = "Model" if role == "chat" else "Embedding model"
        raise ClientError(400, f"{label} not found in Ollama. Run: ollama pull {model}")
    return True


def require_ai_model(settings: JSONDict, role="chat"):
    provider = resolve_ai_provider(settings)
    if provider == "cloud":
        key = resolve_gemini_api_key(settings)
        if not key:
            raise ClientError(400, "Cloud AI (Google Gemini) is selected, but no API key is set. Add your Google AI Studio API key in Settings.")
        return True
    model = resolve_gemma_model(settings) if role == "chat" else resolve_embedding_model(settings)
    return require_ollama_model(settings, model, role)


def module_available(name):
    return importlib.util.find_spec(name) is not None


def workflow_capabilities():
    has_pymupdf = module_available("fitz")
    has_pdfplumber = module_available("pdfplumber")
    has_faiss = module_available("faiss")
    has_sqlite_vec = module_available("sqlite_vec")
    vector_db = "FAISS" if has_faiss else ("sqlite-vec" if has_sqlite_vec else "sklearn cosine fallback")
    return {
        "pdfExtraction": "PyMuPDF" if has_pymupdf else ("pdfplumber" if has_pdfplumber else "byte scan fallback"),
        "embeddings": "Google Gemini text-embedding-004 / Ollama nomic-embed-text / Hybrid 1024",
        "vectorDb": vector_db,
        "embeddingsAvailable": True,
        "vectorAvailable": has_faiss or has_sqlite_vec,
        "sqliteVecAvailable": has_sqlite_vec,
    }


def string_or_existing(value, fallback):
    if isinstance(value, str):
        return value.strip()
    return fallback or ""


def test_ai_settings():
    settings = storage_service.load_settings()
    provider = resolve_ai_provider(settings)
    if provider == "cloud":
        api_key = resolve_gemini_api_key(settings)
        model = resolve_cloud_model(settings)
        if not api_key:
            return {
                "ok": False,
                "connected": False,
                "provider": "cloud",
                "model": model,
                "message": "Cloud provider selected, but Gemini API Key is missing.",
                "warning": "Add your Google AI Studio API key in Settings.",
            }
        try:
            _ = call_gemini(settings, "Ping test. Return only 'OK'", temperature=0.0, max_tokens=10)
            return {
                "ok": True,
                "connected": True,
                "provider": "cloud",
                "model": model,
                "message": f"Successfully connected to Google Gemini ({model})!",
                "warning": "",
            }
        except (ClientError, urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            logger.warning('test_ai_settings: recovering from expected failure (%s)', type(e).__name__)
            return {
                "ok": False,
                "connected": False,
                "provider": "cloud",
                "model": model,
                "message": f"Gemini connection failed: {e}",
                "warning": str(e),
            }
    else:
        model = resolve_gemma_model(settings)
        embedding_model = resolve_embedding_model(settings)
        models = ollama_tags(settings)
        return {
            "ok": True,
            "connected": True,
            "provider": "local",
            "models": models,
            "model": model,
            "embeddingModel": embedding_model,
            "modelAvailable": model in models,
            "embeddingModelAvailable": embedding_model in models,
            "message": "Ollama connection detected.",
            "warning": "" if model in models else f"Model not found in Ollama. Run: ollama pull {model}",
            "embeddingWarning": "" if embedding_model in models else f"Embedding model not found in Ollama. Run: ollama pull {embedding_model}",
        }


def test_gemma_settings():
    return test_ai_settings()


def detect_sections(text):
    sections = {}
    current = "Body"
    for line in str(text or "").splitlines():
        clean = metadata_service.clean_crossref_text(line)
        if not clean:
            continue
        heading = re.match(r"^(abstract|introduction|methods?|materials and methods|results?|discussion|conclusion|references)", clean, re.I)
        if heading:
            current = heading.group(1).title()
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(clean)
    return {k: " ".join(v).strip() for k, v in sections.items() if v}


def chunk_paragraphs(paper: Paper):
    sections = detect_sections(paper.get("text") or "")
    chunks = []
    paper_id = paper.get("id") or paper.get("doi") or paper.get("title")
    title = paper.get("title") or "Paper"
    doi = paper.get("doi") or ""
    if not sections:
        raw_text = metadata_service.clean_extracted_text(paper.get("text") or paper.get("abstract") or "")
        paragraphs = [p.strip() for p in raw_text.split("\n\n") if len(p.strip()) > 80]
        for idx, para in enumerate(paragraphs[:12]):
            chunks.append({"paperId": paper_id, "paperTitle": title, "doi": doi, "section": f"Section {idx+1}", "text": para[:1600]})
        return chunks

    for sec_name, sec_text in sections.items():
        if sec_name.lower() == "references":
            continue
        paras = [p.strip() for p in sec_text.split(". ") if len(p.strip()) > 70]
        for p in paras[:6]:
            chunks.append({"paperId": paper_id, "paperTitle": title, "doi": doi, "section": sec_name, "text": p[:1600]})
    return chunks[:80]


def hybrid_semantic_embedding(text, dimensions=1024):
    clean = metadata_service.clean_crossref_text(text).lower()
    words = re.findall(r"[a-z0-9][a-z0-9_-]{1,}", clean)
    stop = {
        "this", "that", "with", "from", "into", "using", "paper", "study", "result", "results",
        "method", "methods", "analysis", "research", "journal", "article", "review", "based",
        "between", "through", "within", "their", "there", "these", "those", "have", "been",
        "about", "after", "again", "also", "and", "any", "are", "because", "before", "being",
        "both", "but", "can", "did", "does", "doing", "down", "during", "each", "few", "for",
        "had", "has", "having", "her", "here", "him", "his", "how", "into", "its", "more",
        "most", "not", "only", "other", "our", "out", "over", "same", "she", "should", "some",
        "such", "than", "then", "they", "too", "under", "until", "very", "was", "were", "what",
        "when", "where", "which", "while", "who", "whom", "why", "will", "would", "you", "your"
    }
    features = {}
    for w in words:
        if w not in stop and len(w) > 2:
            features[f"w:{w}"] = features.get(f"w:{w}", 0) + 2.0
            if len(w) >= 4:
                for i in range(len(w) - 2):
                    features[f"c3:{w[i:i+3]}"] = features.get(f"c3:{w[i:i+3]}", 0) + 0.5
                if len(w) >= 5:
                    for i in range(len(w) - 3):
                        features[f"c4:{w[i:i+4]}"] = features.get(f"c4:{w[i:i+4]}", 0) + 0.8
    for i in range(len(words) - 1):
        w1, w2 = words[i], words[i+1]
        if w1 not in stop and w2 not in stop and len(w1) > 2 and len(w2) > 2:
            features[f"bi:{w1}_{w2}"] = features.get(f"bi:{w1}_{w2}", 0) + 2.5

    vector = [0.0] * dimensions
    if not features:
        return vector

    for feat, raw_count in features.items():
        tf_weight = 1.0 + math.log(raw_count)
        digest = hashlib.sha256(feat.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dimensions
        sign = -1.0 if (digest[4] & 1) else 1.0
        vector[idx] += sign * tf_weight

    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm > 1e-9 else vector


def hashed_embedding(text, dimensions=256):
    return hybrid_semantic_embedding(text, dimensions=dimensions)


def cosine(left, right):
    if len(left) != len(right):
        min_len = min(len(left), len(right))
        left = left[:min_len]
        right = right[:min_len]
    return sum(a * b for a, b in zip(left, right))


def gemini_embedding(settings: JSONDict, text):
    return cached_embedding(get_context().config_dir, ['cloud', settings.get('cloudProvider'), settings.get('apiKey'), 'text-embedding-004'], text, lambda: _gemini_embedding(settings, text))


def _gemini_embedding(settings: JSONDict, text):
    api_key = resolve_gemini_api_key(settings)
    if not api_key:
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"
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
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            values = data.get("embedding", {}).get("values")
            if isinstance(values, list) and values:
                return [float(v) for v in values]
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError):
        logger.warning('_gemini_embedding: recovering from expected failure')
        return None
    return None


def nearest_chunk_context(papers: List[Paper], prompt, limit=10):
    chunks = []
    for paper in papers[:40]:
        chunks.extend(chunk_paragraphs(paper))
    if not chunks:
        return []
    query_terms = " ".join([prompt, *ranking_service.recommendation_query_terms(papers)])
    settings = storage_service.load_settings()
    provider = resolve_ai_provider(settings)

    if provider == "cloud":
        q_emb = gemini_embedding(settings, query_terms)
        if q_emb:
            scored = []
            for chunk in chunks:
                c_emb = gemini_embedding(settings, chunk["text"][:1000]) or hybrid_semantic_embedding(chunk["text"], dimensions=len(q_emb))
                scored.append((cosine(q_emb, c_emb), chunk))
            return [chunk for _, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]]

    if provider == "local":
        try:
            require_ollama_model(settings, resolve_embedding_model(settings), "embedding")
            query_vector = ollama_embedding(settings, query_terms)
            scored = []
            for chunk in chunks:
                score = cosine(query_vector, ollama_embedding(settings, chunk["text"]))
                scored.append((score, chunk))
            return [chunk for _, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]]
        except ClientError:
            logger.warning('nearest_chunk_context: recovering from expected failure')
            pass

    query_vector = hybrid_semantic_embedding(query_terms, dimensions=1024)
    scored = []
    for chunk in chunks:
        score = cosine(query_vector, hybrid_semantic_embedding(chunk["text"], dimensions=1024))
        scored.append((score, chunk))
    return [chunk for _, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]]


def call_gemini(settings: JSONDict, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
    api_key = resolve_gemini_api_key(settings)
    if not api_key:
        raise ClientError(400, "Gemini API key is missing. Please enter your Google AI Studio API key in Settings.")
    model = resolve_cloud_model(settings)
    if model.startswith("models/"):
        model = model[len("models/"):]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        }
    }
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    data_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning('call_gemini: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Google Gemini API error ({error.code}): {details[:900]}")
    except urllib.error.URLError as error:
        logger.warning('call_gemini: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(503, f"Google Gemini API offline or unreachable: {error.reason}")

    try:
        candidates = data.get("candidates") or []
        if candidates and "content" in candidates[0]:
            parts = candidates[0]["content"].get("parts") or []
            if parts and "text" in parts[0]:
                return parts[0]["text"].strip()
    except (KeyError, TypeError, AttributeError) as e:
        logger.warning('call_gemini: recovering from expected failure (%s)', type(e).__name__)
        raise ClientError(502, f"Failed to parse Gemini response: {e}")
    return ""


def call_gemma(settings: JSONDict, prompt, temperature=0.2, max_tokens=1200, json_mode=False):
    model = resolve_gemma_model(settings)
    require_ollama_model(settings, model, "chat")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
            "num_ctx": 16384,
        },
    }
    if json_mode:
        payload["format"] = "json"
    request = urllib.request.Request(
        resolve_ollama_chat_endpoint(settings),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning('call_gemma: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Ollama /api/chat returned an error: {details[:900]}")
    except urllib.error.URLError as error:
        logger.warning('call_gemma: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(503, f"Ollama is offline or unreachable at {resolve_ollama_chat_endpoint(settings)}: {error.reason}")

    message = data.get("message") if isinstance(data, dict) else {}
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"].strip()
    if isinstance(data.get("response"), str):
        return data["response"].strip()
    return ""


def call_ai(settings: JSONDict, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
    provider = resolve_ai_provider(settings)
    if provider == "cloud":
        return call_gemini(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)
    return call_gemma(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)


def analyze_with_gemma(payload: JSONDict):
    settings = storage_service.load_settings()
    require_ai_model(settings, "chat")
    provider = resolve_ai_provider(settings)
    active_model = resolve_cloud_model(settings) if provider == "cloud" else resolve_gemma_model(settings)

    papers = payload.get("papers") or []
    if not papers:
        raise ClientError(400, "No papers were provided for analysis.")

    prompt = (payload.get("prompt") or "").strip()
    links = payload.get("links") or []
    paper_lines = []
    for index, paper in enumerate(papers[:24], start=1):
        title = paper.get("title") or f"Paper {index}"
        authors = ", ".join(paper.get("authors") or [])
        date = paper.get("date") or ""
        year = paper.get("year") or ""
        journal = paper.get("journal") or ""
        doi = paper.get("doi") or ""
        keywords = ", ".join(paper.get("keywords") or [])
        abstract = (paper.get("abstract") or "").strip()
        text = (paper.get("text") or "")[:9000]
        paper_lines.append(
            f"Paper {index} id={paper.get('id') or ''}: {title}\n" +
            f"Authors: {authors or 'none extracted'}\n" +
            f"Date/year: {date or year or 'none extracted'}\n" +
            f"Journal/source: {journal or 'none extracted'}\n" +
            f"DOI: {doi or 'none extracted'}\n" +
            f"Keywords: {keywords or 'none'}\n" +
            f"Extracted abstract: {abstract or 'none extracted'}\n" +
            f"Text excerpt:\n{text}"
        )

    link_lines = [
        f"- {link.get('source')} <-> {link.get('target')} ({round(float(link.get('score', 0)) * 100)}%)"
        for link in links[:80]
    ]
    nearest_chunks = nearest_chunk_context(papers, prompt, limit=12)
    chunk_lines = [
        f"[{index}] {chunk['paperTitle']} / {chunk['section']} / DOI {chunk['doi'] or 'none'}\n{chunk['text']}"
        for index, chunk in enumerate(nearest_chunks, start=1)
    ]

    instruction = f"""
You are an advanced academic literature analyst examining the user's research paper set and citation graph.
Synthesize findings, extract methodologies, analyze thematic clusters, and highlight connections.
You may also control the map by returning an optional final JSON block between PULSE_ACTIONS_START and PULSE_ACTIONS_END.
Supported actions:
- set_threshold: {{"type":"set_threshold","value":0.01-0.75}}
- set_mode: {{"type":"set_mode","mode":"network|clusters|radial|table"}}
- set_graph_style: {{"type":"set_graph_style","nodeSize":14-42,"edgeScale":0.4-1.8,"spacing":0.7-1.65,"labelMode":"short|full|keywords|none","showGrid":true|false,"showAreas":true|false}}
- center_paper: {{"type":"center_paper","paperId":"exact paper id"}}
- color_paper: {{"type":"color_paper","paperId":"exact paper id","color":"#RRGGBB"}}
- assign_area: {{"type":"assign_area","paperId":"exact paper id","areaName":"area name","color":"#RRGGBB"}}
- create_area: {{"type":"create_area","name":"area name","color":"#RRGGBB","x":80-900,"y":80-650,"width":120-520,"height":90-380}}
- rename_area: {{"type":"rename_area","from":"old area name","to":"new area name"}}
- open_panel: {{"type":"open_panel","panel":"graph|areas|links|settings"}}

User request:
{prompt or "Summarize clusters, relatedness, gaps, and follow-up reading strategy."}

Similarity threshold: {payload.get("threshold")}

Detected paper links:
{chr(10).join(link_lines) if link_lines else "No links above the current threshold."}

Nearest paragraph chunks from vector search:
{chr(10).join(chunk_lines) if chunk_lines else "No paragraph chunks were available."}

Papers:
{chr(10).join(paper_lines)}

Return a concise, structured analysis with:
1. Main research clusters & thematic synthesis.
2. Key linkages and methodological rationale.
3. Noteworthy gaps or conflicting conclusions.
4. Recommended directions and search terms.
If graph adjustments would improve understanding, append:
PULSE_ACTIONS_START
{{"actions":[...]}}
PULSE_ACTIONS_END
"""

    text = call_ai(settings, instruction, temperature=0.35, max_tokens=1800)
    if not text:
        raise ClientError(502, f"{active_model} returned no text analysis.")
    return text, active_model


def parse_json_object(value):
    raw = str(value or "").strip()
    if not raw:
        return {}
    match = re.search(r"\{[\s\S]*\}", raw)
    candidate = match.group(0) if match else raw
    try:
        data = json.loads(candidate)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        logger.warning('parse_json_object: recovering from expected failure')
        return {}


def clean_string_list(values, limit=24):
    if not isinstance(values, list):
        return []
    cleaned = []
    seen = set()
    for item in values:
        if isinstance(item, str):
            clean = metadata_service.clean_crossref_text(item)
            if clean and clean.lower() not in seen:
                seen.add(clean.lower())
                cleaned.append(clean)
                if len(cleaned) >= limit:
                    break
    return cleaned


def gemma_extraction_to_metadata(data) -> Metadata:
    if not isinstance(data, dict):
        return {}
    metadata = {}
    doi = metadata_service.normalize_doi(data.get("doi"))
    if doi:
        metadata["doi"] = doi
    title = metadata_service.clean_crossref_text(data.get("title"))
    if title:
        metadata["title"] = title
    authors = [metadata_service.clean_author_name(a) for a in clean_string_list(data.get("authors"), limit=16) if metadata_service.clean_author_name(a)]
    if authors:
        metadata["authors"] = authors
    journal = metadata_service.clean_crossref_text(data.get("journal"))
    if journal:
        metadata["journal"] = journal
    abstract = metadata_service.clean_extracted_text(data.get("abstract"))
    if abstract:
        metadata["abstract"] = abstract
    keywords = clean_string_list(data.get("keywords"), limit=16)
    if keywords:
        metadata["paperKeywords"] = keywords
    date = str(data.get("date") or "").strip()
    if date:
        metadata["date"] = date
        year = re.search(r"(19|20)\d{2}", date)
        if year:
            metadata["year"] = year.group(0)
    return metadata


def ollama_embedding(settings: JSONDict, text):
    return cached_embedding(get_context().config_dir, ['local', resolve_ollama_embeddings_endpoint(settings), resolve_embedding_model(settings)], text, lambda: _ollama_embedding(settings, text))


def _ollama_embedding(settings: JSONDict, text):
    model = resolve_embedding_model(settings)
    payload = {
        "model": model,
        "prompt": str(text or "")[:12000],
    }
    request = urllib.request.Request(
        resolve_ollama_embeddings_endpoint(settings),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        logger.warning('_ollama_embedding: recovering from expected failure (%s)', type(error).__name__)
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Ollama /api/embeddings returned an error: {details[:900]}")
    except urllib.error.URLError as error:
        logger.warning('_ollama_embedding: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(503, f"Ollama embeddings are offline at {resolve_ollama_embeddings_endpoint(settings)}: {error.reason}")

    embedding = data.get("embedding") if isinstance(data, dict) else None
    if not isinstance(embedding, list) or not embedding:
        raise ClientError(502, "Ollama /api/embeddings returned no embedding vector.")
    return [float(value) for value in embedding]


def analysis_response(payload: JSONDict):
    analysis, model = analyze_with_gemma(payload)
    return {'analysis': analysis, 'model': model}


def test_settings_response(payload: JSONDict):
    return test_gemma_settings()
