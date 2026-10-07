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
    if not papers:
        raise ClientError(400, "No papers were provided for analysis.")

    prompt = (payload.get("prompt") or payload.get("question") or "").strip()
    links = payload.get("links") or []
    paper_lines = []
    for index, paper in enumerate(papers[:24], start=1):
        title = paper.get("title") or f"Paper {index}"
        authors = ", ".join(paper.get("authors") or [])
        date = paper.get("date") or paper.get("year") or ""
        journal = paper.get("journal") or ""
        doi = paper.get("doi") or ""
        keywords = ", ".join(paper.get("keywords") or paper.get("paperKeywords") or [])
        abstract = (paper.get("abstract") or "").strip()
        text = (paper.get("text") or "")[:9000]
        paper_lines.append(
            f"Paper {index} id={paper.get('id') or ''}: {title}\n"
            f"Authors: {authors or 'none'}\nDate: {date or 'none'}\n"
            f"Journal: {journal or 'none'}\nDOI: {doi or 'none'}\n"
            f"Keywords: {keywords or 'none'}\nAbstract: {abstract or 'none'}\n"
            f"Excerpt: {text}"
        )

    link_lines = [
        f"- {l.get('source')} <-> {l.get('target')} ({round(float(l.get('score', 0)) * 100)}%)"
        for l in links[:80]
    ]
    ctx = nearest_chunk_context(papers, prompt, limit=12)

    instruction = f"""
You are an advanced academic literature analyst examining the research paper set and graph.
Synthesize findings, extract methodologies, analyze thematic clusters, and highlight connections.
You may also control the map by returning an optional final JSON block between IRATXE_ACTIONS_START and IRATXE_ACTIONS_END (or PULSE_ACTIONS_START and PULSE_ACTIONS_END).
Supported actions:
- set_threshold: {{"type":"set_threshold","value":0.01-0.75}}
- set_mode: {{"type":"set_mode","mode":"network|clusters|radial|table"}}
- set_graph_style: {{"type":"set_graph_style","nodeSize":14-42,"edgeScale":0.4-1.8,"spacing":0.7-1.65,"labelMode":"short|full|keywords|none"}}
- center_paper: {{"type":"center_paper","paperId":"exact paper id"}}
- color_paper: {{"type":"color_paper","paperId":"exact paper id","color":"#RRGGBB"}}
- assign_area: {{"type":"assign_area","paperId":"exact paper id","areaName":"area name","color":"#RRGGBB"}}
- create_area: {{"type":"create_area","name":"area name","color":"#RRGGBB","x":80-900,"y":80-650,"width":120-520,"height":90-380}}

User request:
{prompt or "Summarize clusters, relatedness, gaps, and follow-up reading strategy."}

Similarity threshold: {payload.get("threshold")}

Detected paper links:
{chr(10).join(link_lines) if link_lines else "No links above threshold."}

Nearest paper chunks:
{ctx if ctx else "No chunks available."}

Papers:
{chr(10).join(paper_lines)}

Return a concise, structured analysis:
1. Main research clusters & thematic synthesis.
2. Key linkages and methodological rationale.
3. Noteworthy gaps or conflicting conclusions.
4. Recommended directions and search terms.
If graph adjustments would improve understanding, append:
IRATXE_ACTIONS_START
{{"actions":[...]}}
IRATXE_ACTIONS_END
"""
    res = call_ai(settings, instruction, temperature=0.35, max_tokens=1800)
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
