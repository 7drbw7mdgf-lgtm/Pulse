import json
import re
import urllib.request
from pulse_core.constants import ClientError, clean_string_list
from pulse_core.config_resolvers import (
    resolve_ai_provider,
    resolve_cloud_model,
    resolve_gemini_api_key,
    resolve_gemma_model,
    resolve_ollama_chat_endpoint,
)
from pulse_core.metadata_utils import clean_crossref_text

def detect_sections(text):
    headings = []
    for line in (text or "").splitlines():
        clean = line.strip()
        if clean and len(clean) < 60 and re.match(r"^(?:[0-9IVX]+\.?\s+)?(introduction|methods|results|discussion|conclusion|abstract)", clean, re.I):
            headings.append(clean)
    return headings

def chunk_paragraphs(paper):
    text = paper.get("abstract") or paper.get("text") or ""
    paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 60]
    return paragraphs or [text[:2000]]

def nearest_chunk_context(papers, prompt, limit=10):
    chunks = []
    for p in papers or []:
        for c in chunk_paragraphs(p):
            chunks.append(f"[{p.get('title', 'Unknown')}]: {c}")
    return "\n\n".join(chunks[:limit])

def call_gemini(settings, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
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
        with urllib.request.urlopen(req, timeout=25) as response:
            res = json.loads(response.read().decode("utf-8"))
            candidates = res.get("candidates") or []
            if candidates:
                parts = (candidates[0].get("content") or {}).get("parts") or []
                if parts:
                    return parts[0].get("text", "")
            return ""
    except Exception as err:
        raise ClientError(502, f"Gemini generation error: {err}")

def call_gemma(settings, prompt, temperature=0.2, max_tokens=1200, json_mode=False):
    model = resolve_gemma_model(settings)
    endpoint = resolve_ollama_chat_endpoint(settings)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        }
    }
    if json_mode:
        payload["format"] = "json"
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
            return (data.get("message") or {}).get("content", "")
    except Exception as err:
        raise ClientError(502, f"Ollama generation error: {err}")

def call_ai(settings, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
    prov = resolve_ai_provider(settings)
    if prov == "cloud":
        return call_gemini(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)
    return call_gemma(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)

def analyze_with_gemma(payload):
    from pulse_core.storage import load_settings
    settings = load_settings()
    papers = payload.get("papers") or []
    question = payload.get("question") or "Synthesize the core themes and relationships across these papers."
    ctx = nearest_chunk_context(papers, question)
    prompt = f"Context from literature collection:\n{ctx}\n\nTask:\n{question}\n\nProvide a rigorous, structured synthesis citing specific papers."
    res = call_ai(settings, prompt)
    model = resolve_cloud_model(settings) if resolve_ai_provider(settings) == "cloud" else resolve_gemma_model(settings)
    return res, model

def parse_json_object(value):
    if not value:
        return {}
    clean = re.sub(r"```json\s*", "", value)
    clean = re.sub(r"```\s*$", "", clean).strip()
    match = re.search(r"\{[\s\S]*\}", clean)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    return {}

def gemma_extraction_to_metadata(data):
    if not isinstance(data, dict):
        return {}
    return {
        "title": clean_crossref_text(data.get("title") or ""),
        "authors": clean_string_list(data.get("authors") or []),
        "year": str(data.get("year") or "").strip()[:4],
        "journal": clean_crossref_text(data.get("journal") or data.get("venue") or ""),
        "doi": str(data.get("doi") or "").strip(),
        "abstract": clean_crossref_text(data.get("abstract") or ""),
        "paperKeywords": clean_string_list(data.get("keywords") or data.get("paperKeywords") or []),
        "metadataSource": "AI Extraction",
    }

def model_paper_excerpt(text, max_chars=32000):
    return (text or "").strip()[:max_chars]

def extract_metadata_with_gemma(payload):
    from pulse_core.storage import load_settings
    settings = load_settings()
    text = model_paper_excerpt(payload.get("text") or "")
    if not text:
        raise ClientError(400, "No document text provided for extraction.")
    prompt = f"Extract bibliographical metadata from the academic paper excerpt below into pure JSON with fields 'title', 'authors' (list of strings), 'year', 'journal', 'doi', 'abstract', 'keywords' (list of strings).\n\nExcerpt:\n{text}"
    raw = call_ai(settings, prompt, json_mode=True)
    parsed = parse_json_object(raw)
    return {"ok": True, "metadata": gemma_extraction_to_metadata(parsed)}
