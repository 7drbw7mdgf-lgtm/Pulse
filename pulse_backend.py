#!/usr/bin/env python3
import base64
import hashlib
import html
import importlib.util
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import zlib
import shutil
import tempfile
import signal
import atexit
import math
import xml.etree.ElementTree as ET
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path("/private/tmp/pulse-native-root/Pulse.app/Contents/Resources")
if Path(__file__).resolve().parent.joinpath("index.html").exists():
    ROOT = Path(__file__).resolve().parent

VENDORED_PYTHON = ROOT / "python"
if VENDORED_PYTHON.exists():
    sys.path.insert(0, str(VENDORED_PYTHON))

CONFIG_DIR = Path(os.environ.get("PULSE_CONFIG_DIR") or os.environ.get("IRATXE_CONFIG_DIR") or (Path.home() / "Library" / "Application Support" / "pulse"))
_legacy_config_dir = Path.home() / "Library" / "Application Support" / "iratxe"
if not (os.environ.get('PULSE_CONFIG_DIR') or os.environ.get('IRATXE_CONFIG_DIR')) and not CONFIG_DIR.exists() and _legacy_config_dir.exists():
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
APP_VERSION = os.environ.get("PULSE_APP_VERSION") or os.environ.get("IRATXE_APP_VERSION") or "1.2.1"
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


class PulseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

    def do_OPTIONS(self):
        if not self.request_is_allowed(urllib.parse.urlparse(self.path), allow_api_token=False):
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self.request_is_allowed(parsed):
            return
        path = parsed.path
        if path in {"/api/settings", "/api/providers"}:
            settings = load_settings()
            self.write_json(200, public_settings(settings))
            return

        if path == "/api/library":
            self.write_json(200, load_library())
            return

        if path == "/api/health":
            settings = load_settings()
            self.write_json(200, {
                "ok": True,
                "backend": "pulse",
                "version": APP_VERSION,
                "configured": True,
                "model": resolve_gemma_model(settings),
                "ollamaChatEndpoint": resolve_ollama_chat_endpoint(settings),
                "root": str(ROOT),
                "pid": os.getpid(),
            })
            return

        if path in {"/", "/index.html"}:
            self.write_index()
            return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self.request_is_allowed(parsed):
            return
        path = parsed.path
        if path not in {
            "/api/analyze",
            "/api/settings",
            "/api/library",
            "/api/test",
            "/api/metadata/doi",
            "/api/metadata/pmid",
            "/api/metadata/scan",
            "/api/metadata/gemma",
            "/api/recommendations",
            "/api/citations/enrich",
            "/api/citations/seminal",
            "/api/citations/snowball",
            "/api/discovery/pipeline",
            "/api/citations/chase",
            "/api/citations/network",
        }:
            self.send_error(404, "Unknown endpoint")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if path == "/api/settings":
                settings = save_settings(payload)
                self.write_json(200, public_settings(settings))
                return

            if path == "/api/library":
                saved = save_library(payload)
                self.write_json(200, saved)
                return

            if path == "/api/metadata/doi":
                result = lookup_doi_metadata(payload)
                self.write_json(200, result)
                return

            if path == "/api/metadata/pmid":
                self.write_json(200, lookup_pmid_metadata(payload))
                return

            if path == "/api/metadata/scan":
                result = scan_file_for_metadata(payload)
                self.write_json(200, result)
                return

            if path == "/api/metadata/gemma":
                result = extract_metadata_with_gemma(payload)
                self.write_json(200, result)
                return

            if path == "/api/recommendations":
                result = recommend_papers(payload)
                self.write_json(200, result)
                return

            if path == "/api/citations/enrich":
                result = enrich_citations(payload)
                self.write_json(200, result)
                return

            if path == "/api/citations/seminal":
                result = find_missing_seminal_papers(payload)
                self.write_json(200, result)
                return

            if path == "/api/citations/snowball":
                result = snowball_papers(payload)
                self.write_json(200, result)
                return

            if path == "/api/discovery/pipeline":
                result = run_discovery_pipeline(payload)
                self.write_json(200, result)
                return

            if path == "/api/citations/chase":
                result = iterative_citation_chase(payload)
                self.write_json(200, result)
                return

            if path == "/api/citations/network":
                result = citation_network_triangulation(payload)
                self.write_json(200, result)
                return

            if path == "/api/test":
                result = test_gemma_settings()
                self.write_json(200, result)
                return

            analysis, model = analyze_with_gemma(payload)
            self.write_json(200, {"analysis": analysis, "model": model})
        except ClientError as error:
            self.write_json(error.status, {"error": str(error)})
        except Exception as error:
            self.write_json(500, {"error": f"Backend analysis failed: {error}"})

    def request_is_allowed(self, parsed, allow_api_token=True):
        if not self.host_is_loopback():
            self.write_json(403, {"error": "Blocked non-loopback Host header."})
            return False
        if allow_api_token and parsed.path.startswith("/api/") and API_TOKEN:
            params = urllib.parse.parse_qs(parsed.query)
            supplied = (
                self.headers.get("X-Pulse-Token") or self.headers.get("X-Iratxe-Token")
                or (params.get("token") or params.get("pulseToken") or params.get("iratxeToken") or [""])[0]
            )
            if supplied != API_TOKEN:
                self.write_json(403, {"error": "Missing or invalid pulse session token."})
                return False
        return True

    def host_is_loopback(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return False
        if host.startswith("[::1]"):
            return True
        if ":" in host and host.count(":") == 1:
            host = host.rsplit(":", 1)[0]
        return host in LOOPBACK_HOSTS

    def write_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_html(self, status, markup):
        body = markup.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_index(self):
        markup = ROOT.joinpath("index.html").read_text("utf-8")
        token_script = f"<script>window.__PULSE_API_TOKEN__ = {json.dumps(API_TOKEN)}; window.__IRATXE_API_TOKEN__ = {json.dumps(API_TOKEN)};</script>"
        if "</head>" in markup:
            markup = markup.replace("</head>", f"{token_script}\n</head>", 1)
        else:
            markup = f"{token_script}\n{markup}"
        self.write_html(200, markup)

class ClientError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def load_settings():
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except json.JSONDecodeError:
        return {}



def load_library():
    backup_dir = CONFIG_DIR / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)
    if LIBRARY_PATH.exists():
        try:
            raw = LIBRARY_PATH.read_text('utf-8').strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict) and 'papers' in data:
                    data.setdefault('format', 'pulse-map')
                    data.setdefault('version', APP_VERSION)
                    return data
        except Exception:
            pass

    if backup_dir.exists():
        backups = sorted(backup_dir.glob('library_*.json'), key=os.path.getmtime, reverse=True)
        for p in backups:
            try:
                raw = p.read_text('utf-8').strip()
                if not raw:
                    continue
                data = json.loads(raw)
                if isinstance(data, dict) and 'papers' in data:
                    data.setdefault('format', 'pulse-map')
                    data.setdefault('version', APP_VERSION)
                    return data
            except Exception:
                continue
    return {'format': 'pulse-map', 'version': APP_VERSION, 'papers': []}


def save_library(payload):
    if not isinstance(payload, dict):
        raise ClientError(400, 'Library payload must be a JSON object.')
    if not isinstance(payload.get('papers'), list) or not all(isinstance(paper, dict) for paper in payload['papers']):
        raise ClientError(400, 'Library papers must be an array of paper objects.')
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    backup_dir = CONFIG_DIR / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)

    data = dict(payload)
    data['format'] = data.get('format') or 'pulse-map'
    data['version'] = data.get('version') or APP_VERSION
    data['savedAt'] = time_iso()

    is_reset = bool(payload.get('reset')) or len(payload.get('papers', [])) == 0
    if is_reset:
        # Clear old backup snapshots so deleted papers do not resurrect
        if backup_dir.exists():
            for old in backup_dir.glob('library_*.json'):
                try: old.unlink()
                except OSError: pass
    elif LIBRARY_PATH.exists() and LIBRARY_PATH.stat().st_size > 10:
        # Backup existing valid file before replacing
        try:
            json.loads(LIBRARY_PATH.read_text('utf-8'))
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_file = backup_dir / f'library_{ts}.json'
            shutil.copy2(LIBRARY_PATH, backup_file)
            # Retain last 10 snapshots
            all_b = sorted(backup_dir.glob('library_*.json'), key=os.path.getmtime)
            for old in all_b[:-10]:
                try: old.unlink()
                except OSError: pass
        except Exception:
            pass

    # Atomic write via temporary file + fsync + os.replace
    temp_fd, temp_path = tempfile.mkstemp(dir=str(CONFIG_DIR), prefix='.lib_tmp_', suffix='.json')
    try:
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, str(LIBRARY_PATH))
        try:
            LIBRARY_PATH.chmod(0o600)
        except OSError:
            pass
    finally:
        if os.path.exists(temp_path):
            try: os.unlink(temp_path)
            except OSError: pass

    return {'ok': True, 'path': str(LIBRARY_PATH), 'savedAt': data['savedAt']}


def save_settings(payload):
    current = load_settings()
    ai_provider = str(payload.get('aiProvider') or current.get('aiProvider') or LOCAL_BACKEND_DEFAULTS['aiProvider']).strip().lower()
    if ai_provider not in {'local', 'cloud'}:
        ai_provider = LOCAL_BACKEND_DEFAULTS['aiProvider']
    cloud_provider = str(payload.get('cloudProvider') or current.get('cloudProvider') or 'google-ai-studio').strip()
    cloud_model = str(payload.get('cloudModel') or payload.get('model') or current.get('cloudModel') or current.get('model') or 'gemini-2.5-flash').strip()
    gemma_model = normalize_gemma_model(payload.get('gemmaModel') or current.get('gemmaModel') or DEFAULT_GEMMA_MODEL)
    ollama_chat_endpoint = normalize_ollama_endpoint(
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


def lookup_pmid_metadata(payload):
    pmid = str(payload.get('pmid') or '').strip()
    if not re.fullmatch(r'\d{1,10}', pmid):
        raise ClientError(400, 'Enter a valid PubMed ID.')
    query = urllib.parse.urlencode({'db':'pubmed', 'id':pmid, 'retmode':'xml', 'tool':'Pulse'})
    request = urllib.request.Request('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' + query, headers={'User-Agent':'Pulse/1.1'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            root = ET.fromstring(response.read(2_000_000))
    except (urllib.error.URLError, TimeoutError, ET.ParseError) as error:
        raise ClientError(502, f'PubMed lookup failed: {error}')
    article = root.find('.//PubmedArticle')
    if article is None:
        raise ClientError(404, 'No PubMed article found for that ID.')
    def text(path):
        node = article.find(path)
        return ''.join(node.itertext()).strip() if node is not None else ''
    authors = []
    for author in article.findall('.//Author'):
        name = ' '.join(filter(None, [author.findtext('ForeName'), author.findtext('LastName')])) or author.findtext('CollectiveName') or ''
        if name:
            authors.append(name)
    doi = next((node.text for node in article.findall('.//ArticleId') if node.get('IdType') == 'doi'), '')
    return {'metadata': {
        'pmid':pmid, 'title':text('.//ArticleTitle'), 'authors':authors,
        'year':text('.//JournalIssue/PubDate/Year') or text('.//JournalIssue/PubDate/MedlineDate')[:4],
        'journal':text('.//Journal/Title'), 'doi':normalize_doi(doi or ''),
        'abstract':' '.join(''.join(node.itertext()) for node in article.findall('.//AbstractText')),
        'paperKeywords':[''.join(node.itertext()) for node in article.findall('.//Keyword')],
        'metadataSource':'PubMed',
    }}


def lookup_doi_metadata(payload):
    doi = normalize_doi(payload.get("doi") or "")
    if not doi:
        raise ClientError(400, "No DOI was provided.")
    expected_title = clean_crossref_text(payload.get("expectedTitle") or payload.get("title") or "")

    errors = []
    sources = []
    metadata = {}

    try:
        crossref = fetch_json(f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}")
        metadata = merge_metadata(metadata, crossref_to_metadata(crossref.get("message") or {}))
        sources.append("Crossref")
    except ClientError as error:
        errors.append(str(error))

    try:
        openalex = fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
        metadata = merge_metadata(metadata, openalex_to_metadata(openalex))
        sources.append("OpenAlex")
    except ClientError as error:
        errors.append(str(error))

    if not metadata.get("title") and not metadata.get("authors"):
        raise ClientError(404, "No usable metadata was found for that DOI. " + " ".join(errors[:2]))
    title_match = doi_title_match(expected_title, metadata.get("title") or "")
    if expected_title and not title_match["ok"]:
        raise ClientError(
            409,
            f"DOI metadata title mismatch for {doi}. Expected '{short_text(expected_title, 90)}' but DOI returned '{short_text(metadata.get('title') or '', 90)}'.",
        )
    return {
        "ok": True,
        "doi": doi,
        "source": " + ".join(sources) or "DOI",
        "metadata": metadata,
        "titleMatch": title_match,
    }


def readable_text_score(text):
    sample = str(text or "")[:4000]
    if not sample.strip():
        return 0.0
    letters = len(re.findall(r"[A-Za-z]", sample))
    controls = len(re.findall(r"[\x00-\x08\x0E-\x1F]", sample))
    pdf_objects = len(re.findall(r"/(?:Length|Filter|FlateDecode|XObject|SMask|Width|Height|stream|endstream)\b", sample))
    return (letters / max(len(sample), 1)) - controls * 0.01 - pdf_objects * 0.05


def clean_extracted_text(value):
    lines = []
    for line in str(value or "").replace("\r", "\n").split("\n"):
        cleaned = clean_crossref_text(line)
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def extract_text_from_upload(raw, name):
    lower_name = str(name or "").lower()
    is_pdf = lower_name.endswith(".pdf") or raw.startswith(b"%PDF")
    if is_pdf:
        try:
            import fitz  # PyMuPDF, optional bundled dependency.
            with fitz.open(stream=raw, filetype="pdf") as document:
                text = "\n\n".join(page.get_text("text") for page in document)
            text = clean_extracted_text(text)
            if readable_text_score(text) > 0.20:
                return text[:240000], "PyMuPDF"
        except Exception:
            pass

        try:
            import io
            import pdfplumber  # optional bundled dependency.
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                text = "\n\n".join((page.extract_text() or "") for page in pdf.pages)
            text = clean_extracted_text(text)
            if readable_text_score(text) > 0.20:
                return text[:240000], "pdfplumber"
        except Exception:
            pass

        stream_text = clean_extracted_text("\n".join(decode_pdf_streams(raw[:8_000_000])))
        if readable_text_score(stream_text) > 0.22:
            return stream_text[:160000], "PDF stream fallback"
        return "", "PDF extraction unavailable"

    for encoding in ("utf-8", "latin-1", "utf-16"):
        try:
            text = clean_extracted_text(raw.decode(encoding, errors="ignore"))
            if readable_text_score(text) > 0.20:
                return text[:240000], encoding
        except LookupError:
            continue
    return "", "text extraction unavailable"


def title_from_text_or_name(text, name):
    raw_text = str(text or "")
    lines = [clean_crossref_text(line) for line in raw_text.splitlines()]
    if len([line for line in lines if line]) <= 1:
        flattened = clean_crossref_text(raw_text)
        lines = re.split(r"(?<=[.!?])\s+| {2,}", flattened)
        if flattened and not lines:
            lines = [flattened]
        if flattened:
            lines.insert(0, flattened[:220])
    filename_title = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", str(name or "paper")).replace("_", " ").replace("-", " ").strip()
    noise = re.compile(
        r"\b(?:abstract|keywords?|references|introduction|doi|author affiliations?|department|university|"
        r"correspondence|received|accepted|published|research article|open data|abbreviations?)\b|@",
        re.I,
    )
    candidates = []
    for index, line in enumerate(lines[:60]):
        for width in (1, 2, 3):
            parts = [part for part in lines[index:index + width] if part]
            if len(parts) != width:
                continue
            if any(re.fullmatch(r"(?:open|data|\d+)", part, re.I) for part in parts):
                continue
            candidate = " ".join(parts)
            words = candidate.split()
            if not (4 <= len(words) <= 32 and 18 <= len(candidate) <= 240):
                continue
            if noise.search(candidate):
                continue
            alpha_ratio = len(re.findall(r"[A-Za-z]", candidate)) / max(len(candidate), 1)
            if alpha_ratio < 0.62:
                continue
            filename_overlap = title_overlap_score(filename_title, candidate)
            position_bonus = max(0.0, 3.4 - index * 0.09)
            length_bonus = min(len(words), 18) * 0.15
            punctuation_penalty = 1.5 if candidate.count(";") >= 2 else 0
            author_line_penalty = 12 if candidate.count(",") >= 2 and re.search(r"\b(?:and|et al\.?|\*)\b", candidate, re.I) else 0
            candidates.append((filename_overlap * 9 + position_bonus + length_bonus - punctuation_penalty - author_line_penalty, candidate))
    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return filename_title


def title_overlap_score(query, candidate):
    query_terms = set(keyword_tokens(query, max_terms=24))
    candidate_terms = set(keyword_tokens(candidate, max_terms=24))
    if not query_terms or not candidate_terms:
        return 0.0
    return len(query_terms & candidate_terms) / max(len(query_terms), 1)


def title_match_tokens(value):
    stop = {
        "paper", "article", "review", "study", "analysis", "abstract", "title",
        "research", "using", "based", "towards", "toward", "between", "among",
    }
    return {
        token for token in keyword_tokens(value, max_terms=40)
        if len(token) >= 4 and token not in stop
    }


def normalized_title_text(value):
    return re.sub(r"[^a-z0-9]+", " ", clean_crossref_text(value).lower()).strip()


def doi_title_match(expected, returned):
    expected_clean = normalized_title_text(expected)
    returned_clean = normalized_title_text(returned)
    if not expected_clean or not returned_clean or len(expected_clean) < 16:
        return {"ok": True, "score": 0, "reason": "no reliable expected title"}
    if expected_clean in returned_clean or returned_clean in expected_clean:
        return {"ok": True, "score": 1, "reason": "title substring match"}
    expected_terms = title_match_tokens(expected_clean)
    returned_terms = title_match_tokens(returned_clean)
    if not expected_terms or not returned_terms:
        return {"ok": True, "score": 0, "reason": "not enough title tokens"}
    overlap = len(expected_terms & returned_terms)
    expected_score = overlap / max(len(expected_terms), 1)
    returned_score = overlap / max(len(returned_terms), 1)
    score = max(expected_score, returned_score)
    ok = score >= 0.52 or (overlap >= 4 and score >= 0.38)
    return {
        "ok": ok,
        "score": round(score, 3),
        "overlap": sorted(expected_terms & returned_terms)[:16],
        "reason": "title token match" if ok else "title token mismatch",
    }


def short_text(value, limit=90):
    text = clean_crossref_text(value)
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "..."


def lookup_metadata_by_title(text, name):
    title = title_from_text_or_name(text, name)
    if len(title) < 18:
        raise ClientError(404, "No reliable title text was available for metadata lookup.")

    errors = []
    candidates = []
    query = urllib.parse.urlencode({"query.title": title, "rows": 5})
    try:
        data = fetch_json(f"https://api.crossref.org/works?{query}")
        for item in (data.get("message") or {}).get("items") or []:
            metadata = crossref_to_metadata(item)
            if metadata.get("doi"):
                candidates.append(("Crossref title search", metadata))
    except ClientError as error:
        errors.append(str(error))

    params = urllib.parse.urlencode({"search": title, "per-page": 5})
    try:
        data = fetch_json(f"https://api.openalex.org/works?{params}")
        for item in data.get("results") or []:
            metadata = openalex_to_metadata(item)
            if metadata.get("doi"):
                candidates.append(("OpenAlex title search", metadata))
    except ClientError as error:
        errors.append(str(error))

    ranked = []
    for source, metadata in candidates:
        overlap = title_overlap_score(title, metadata.get("title") or "")
        score = metadata_completeness_score(metadata) + overlap * 10
        candidate_title = metadata.get("title") or ""
        if overlap >= 0.55 or title.lower() in candidate_title.lower() or candidate_title.lower() in title.lower():
            ranked.append((score, source, metadata))

    if not ranked:
        raise ClientError(404, "No DOI-bearing title match found. " + " ".join(errors[:2]))

    _, source, metadata = sorted(ranked, key=lambda item: item[0], reverse=True)[0]
    return {"ok": True, "doi": metadata.get("doi") or "", "source": source, "metadata": metadata}


def _scan_file_for_metadata_local(payload):
    name = str(payload.get("name") or "paper")
    content = payload.get("contentBase64") or ""
    if not content:
        raise ClientError(400, "No file content was provided for DOI scanning.")
    try:
        raw = base64.b64decode(content, validate=False)
    except Exception as error:
        raise ClientError(400, f"Could not decode file content: {error}")

    extracted_text, extraction_source = extract_text_from_upload(raw, name)
    expected_title = title_from_text_or_name(extracted_text, name)
    candidates = dedupe_strings([
        *ranked_doi_candidates(extracted_text),
        *scan_doi_candidates_from_bytes(raw),
    ])
    if not candidates:
        try:
            fallback = lookup_metadata_by_title(extracted_text, name)
            fallback["found"] = True
            fallback["name"] = name
            fallback["text"] = extracted_text
            fallback["extractionSource"] = extraction_source
            fallback["scanSource"] = "title-metadata-lookup"
            fallback["candidates"] = [fallback.get("doi")] if fallback.get("doi") else []
            return fallback
        except ClientError as error:
            title_error = str(error)
        return {
            "ok": True,
            "found": False,
            "name": name,
            "text": extracted_text,
            "extractionSource": extraction_source,
            "metadata": {},
            "message": "No DOI found by local extraction scan or title metadata lookup.",
            "error": title_error,
        }

    errors = []
    best = None
    best_score = -1
    for doi in candidates:
        try:
            result = lookup_doi_metadata({"doi": doi, "expectedTitle": expected_title})
            score = metadata_completeness_score(result.get("metadata") or {})
            if score > best_score:
                best = result
                best_score = score
            if metadata_is_filled(result.get("metadata") or {}):
                break
        except ClientError as error:
            errors.append(f"{doi}: {error}")

    if best:
        best["found"] = True
        best["name"] = name
        best["text"] = extracted_text
        best["extractionSource"] = extraction_source
        best["scanSource"] = "local-extraction-doi-loop"
        best["candidates"] = candidates[:12]
        best["metadataScore"] = best_score
        best["expectedTitle"] = expected_title
        return best

    try:
        fallback = lookup_metadata_by_title(extracted_text, name)
        fallback["found"] = True
        fallback["name"] = name
        fallback["text"] = extracted_text
        fallback["extractionSource"] = extraction_source
        fallback["scanSource"] = "doi-candidates-failed-title-metadata-lookup"
        fallback["candidates"] = dedupe_strings([fallback.get("doi") or "", *candidates[:12]])
        return fallback
    except ClientError as error:
        errors.append(f"title lookup: {error}")

    return {
        "ok": True,
        "found": False,
        "name": name,
        "text": extracted_text,
        "extractionSource": extraction_source,
        "metadata": {},
        "candidates": candidates[:8],
        "message": "DOI-like strings were found, but none returned metadata.",
        "error": "; ".join(errors[:3]),
        "expectedTitle": expected_title,
    }


def scan_file_for_metadata(payload):
    result = _scan_file_for_metadata_local(payload)
    settings = load_settings()
    use_gemma = payload.get("useGemma")
    if not isinstance(use_gemma, bool):
        use_gemma = settings.get("autoGemmaExtraction", LOCAL_BACKEND_DEFAULTS["autoGemmaExtraction"])

    extracted_text = result.get("text") or ""
    if not use_gemma or not extracted_text:
        result["gemmaProcessed"] = False
        return result

    existing = result.get("metadata") or {}
    try:
        gemma = extract_metadata_with_gemma({
            "name": result.get("name") or payload.get("name") or "paper",
            "title": existing.get("title") or result.get("expectedTitle") or "",
            "abstract": existing.get("abstract") or "",
            "keywords": existing.get("paperKeywords") or [],
            "doiCandidates": result.get("candidates") or [],
            "text": extracted_text,
        })
    except ClientError as error:
        result["gemmaProcessed"] = False
        result["gemmaError"] = str(error)
        return result

    gemma_metadata = dict(gemma.get("metadata") or {})
    for key in ("keyFindings", "organisms", "techniques", "discoveryTerms"):
        if gemma.get(key):
            gemma_metadata[key] = gemma.get(key)
    merged = merge_verified_doi_metadata(gemma_metadata, existing) if result.get("doi") else merge_metadata(gemma_metadata, existing)
    result["metadata"] = merged
    result["doi"] = merged.get("doi") or result.get("doi") or gemma.get("doi") or ""
    result["candidates"] = dedupe_strings([
        result.get("doi") or "",
        *(gemma.get("candidates") or []),
        *(result.get("candidates") or []),
    ])[:12]
    result["found"] = bool(result.get("doi") or merged.get("title") or merged.get("paperKeywords"))
    source_parts = []
    for value in (result.get("source") or "", gemma.get("source") or "Local Gemma extraction"):
        source_parts.extend(part.strip() for part in value.split(" + ") if part.strip())
    result["source"] = " + ".join(dedupe_strings(source_parts))
    result["scanSource"] = "pdf-text-local-parser-gemma-doi-validation"
    result["gemmaProcessed"] = True
    result["gemma"] = gemma
    return result


def model_paper_excerpt(text, max_chars=32000):
    full_text = clean_extracted_text(text)
    if not full_text:
        return ""

    sections = detect_sections(full_text)
    pieces = [("Opening pages", full_text[:9000])]
    wanted = (
        ("Abstract", 5000),
        ("Introduction", 3500),
        ("Methods", 4500),
        ("Method", 4500),
        ("Materials And Methods", 4500),
        ("Results", 4500),
        ("Result", 4500),
        ("Discussion", 3500),
        ("Conclusion", 2500),
    )
    for name, limit in wanted:
        if sections.get(name):
            pieces.append((name, sections[name][:limit]))
    if len(full_text) > 12000:
        pieces.append(("Closing pages", full_text[-3000:]))

    excerpt = []
    seen = set()
    used = 0
    for label, value in pieces:
        clean = clean_extracted_text(value)
        fingerprint = clean[:400].lower()
        if not clean or fingerprint in seen:
            continue
        seen.add(fingerprint)
        block = f"\n\n--- {label} ---\n{clean}"
        remaining = max_chars - used
        if remaining <= 0:
            break
        excerpt.append(block[:remaining])
        used += len(excerpt[-1])
    return "".join(excerpt).strip()


def extract_metadata_with_gemma(payload):
    settings = load_settings()
    require_ai_model(settings, "chat")
    model = resolve_cloud_model(settings) if resolve_ai_provider(settings) == "cloud" else resolve_gemma_model(settings)

    name = clean_crossref_text(payload.get("name") or "paper")
    title = clean_crossref_text(payload.get("title") or "")
    abstract = clean_crossref_text(payload.get("abstract") or "")
    keywords = dedupe_strings(payload.get("keywords") or [])[:24]
    doi_candidates = dedupe_strings([normalize_doi(value) for value in payload.get("doiCandidates") or [] if normalize_doi(value)])[:12]
    text = clean_extracted_text(payload.get("text") or "")
    excerpt = model_paper_excerpt(text)
    if not excerpt and not abstract and not title and not doi_candidates:
        raise ClientError(400, "No readable text or DOI candidates were provided for Gemma extraction.")

    instruction = f"""
You are a local Ollama chat model acting as a strict metadata extraction layer for a local literature mapping app.
Extract only metadata supported by the provided paper text. Prefer exact DOI strings. Do not invent a DOI.

Return valid JSON only with this shape:
{{
  "doi": "10.xxxx/xxxxx or empty string",
  "doiCandidates": ["ordered DOI candidates"],
  "title": "paper title or empty string",
  "authors": ["Author One", "Author Two"],
  "date": "YYYY-MM-DD, YYYY-MM, YYYY, or empty string",
  "journal": "journal or venue",
  "abstract": "clear abstract text if present, cleaned of XML tags",
  "keywords": ["3 to 12 concise search keywords"],
  "organisms": ["organisms, populations, or study systems"],
  "techniques": ["methods, assays, computational methods, instruments, or data types"],
  "discoveryTerms": ["6 to 12 terms to search literature databases"],
  "keyFindings": ["up to 5 short findings"],
  "confidence": 0.0
}}

Filename: {name}
Existing title: {title}
Existing DOI candidates: {", ".join(doi_candidates) if doi_candidates else "none"}
Existing abstract: {abstract[:2500] if abstract else "none"}
Existing keywords: {", ".join(keywords) if keywords else "none"}

Representative paper text sampled across detected sections:
{excerpt}
"""

    text_response = call_ai(settings, instruction, temperature=0.0, max_tokens=2200, json_mode=True)
    extracted = parse_json_object(text_response)
    metadata = gemma_extraction_to_metadata(extracted)
    all_dois = dedupe_strings([
        metadata.get("doi") or "",
        *metadata.get("doiCandidates", []),
        *doi_candidates,
    ])
    doi_metadata = {}
    doi_source = ""
    doi = ""
    for candidate in all_dois[:12]:
        try:
            result = lookup_doi_metadata({"doi": candidate, "expectedTitle": metadata.get("title") or title})
            doi = result.get("doi") or candidate
            doi_metadata = result.get("metadata") or {}
            doi_source = result.get("source") or "DOI"
            break
        except ClientError:
            continue
    if doi_metadata:
        metadata = merge_verified_doi_metadata(metadata, doi_metadata)
        metadata["doi"] = doi
    else:
        # Nothing verified (offline or no match): keep a DOI only if it is
        # printed in the paper itself, never one the model produced on its own.
        in_text = {value.lower() for value in [*ranked_doi_candidates(payload.get("text") or ""), *doi_candidates]}
        all_dois = [value for value in all_dois if value.lower() in in_text]
        metadata["doi"] = all_dois[0] if all_dois else ""
        metadata["doiCandidates"] = all_dois[:12]

    return {
        "ok": True,
        "found": bool(metadata.get("doi") or metadata.get("title") or metadata.get("paperKeywords")),
        "name": name,
        "model": model,
        "source": f"Local chat abstraction{(' + ' + doi_source) if doi_source else ''}",
        "doi": metadata.get("doi") or (all_dois[0] if all_dois else ""),
        "candidates": all_dois[:12],
        "metadata": metadata,
        "keyFindings": extracted.get("keyFindings") if isinstance(extracted.get("keyFindings"), list) else [],
        "organisms": clean_string_list(extracted.get("organisms") or [], limit=16),
        "techniques": clean_string_list(extracted.get("techniques") or [], limit=16),
        "discoveryTerms": clean_string_list(extracted.get("discoveryTerms") or [], limit=24),
        "confidence": extracted.get("confidence", ""),
    }


def recommend_papers(payload):
    papers = payload.get("papers") or []
    if not papers:
        raise ClientError(400, "Select at least one paper before asking for recommendations.")

    limit = min(max(int(payload.get("limit") or 8), 1), 12)
    excluded_dois = {normalize_doi(value).lower() for value in payload.get("excludeDois") or [] if normalize_doi(value)}
    excluded_titles = {normalize_title_key(value) for value in payload.get("excludeTitles") or [] if normalize_title_key(value)}
    steer_terms = steering_terms(payload.get("steerKeywords") or [])
    exclude_terms = steering_terms(payload.get("excludeKeywords") or [])[:16]
    steer_authors = steering_terms(payload.get("steerAuthors") or [])[:10]
    steer_journals = steering_terms(payload.get("steerJournals") or [])[:10]
    recency_tilt = clamp_float(payload.get("recencyTilt"), -2, 2, 0)
    impact_tilt = clamp_float(payload.get("impactTilt"), -2, 2, 0)
    query_terms = dedupe_strings([*steer_terms, *recommendation_query_terms(papers)])
    if not query_terms:
        raise ClientError(400, "The selected paper does not have enough title, abstract, or keyword text to search from.")

    search = " ".join(dedupe_strings([*query_terms[:18], *steer_authors[:4], *steer_journals[:4]]))
    openalex_terms = openalex_and_terms(papers, query_terms, steer_terms)
    seed_terms = {term.lower() for term in query_terms}
    gathered = []
    source_status = []
    source_calls = [
        ("Semantic Scholar (S2AG)", lambda: s2_recommendations_for_search(papers, search, limit, steer_terms)),
        ("OpenAlex", lambda: openalex_recommendations(search, limit, openalex_terms)),
        ("Crossref", lambda: crossref_recommendations(search, limit)),
        ("Dimensions", lambda: dimensions_recommendations(search, limit)),
    ]
    for source_name, source_call in source_calls:
        try:
            items = source_call()
            gathered.extend(items)
            source_status.append({"source": source_name, "ok": True, "count": len(items)})
        except ClientError as error:
            source_status.append({"source": source_name, "ok": False, "error": str(error)})

    recommendations = merge_recommendations(
        gathered,
        query_terms,
        seed_terms,
        excluded_dois,
        excluded_titles,
        {
            "excludeTerms": exclude_terms,
            "authors": steer_authors,
            "journals": steer_journals,
            "recencyTilt": recency_tilt,
            "impactTilt": impact_tilt,
        },
        limit,
    )

    return {
        "ok": True,
        "query": search,
        "steerKeywords": steer_terms,
        "excludeKeywords": exclude_terms,
        "steerAuthors": steer_authors,
        "steerJournals": steer_journals,
        "recencyTilt": recency_tilt,
        "impactTilt": impact_tilt,
        "openAlexQuery": " AND ".join(openalex_terms) if len(openalex_terms) >= 3 else search,
        "source": " + ".join(item["source"] for item in source_status if item.get("ok")) or "Recommendations",
        "sources": source_status,
        "recommendations": recommendations,
    }


def enrich_citations(payload):
    papers = payload.get("papers") or []
    if not papers:
        raise ClientError(400, "No papers were provided for citation enrichment.")
    enriched = []
    errors = []
    for paper in papers[:80]:
        try:
            work = openalex_work_for_paper(paper)
            if not work:
                continue
            metadata = openalex_to_metadata(work)
            metadata["citedByIds"] = openalex_citing_ids(metadata.get("openAlexId") or work.get("id"), limit=80)
            enriched.append({
                "id": paper.get("id") or "",
                "doi": metadata.get("doi") or normalize_doi(paper.get("doi") or ""),
                "metadata": metadata,
            })
        except ClientError as error:
            errors.append(str(error))
    return {"ok": True, "papers": enriched, "errors": errors[:8]}


def find_missing_seminal_papers(payload):
    papers = payload.get("papers") or []
    threshold = max(2, min(20, int(payload.get("threshold") or 2)))
    reference_counts = {}
    loaded = {openalex_work_id(paper.get("openAlexId") or "") for paper in papers}
    for paper in papers:
        for ref in paper.get("referenceIds") or []:
            work_id = openalex_work_id(ref)
            if not work_id or work_id in loaded:
                continue
            reference_counts.setdefault(work_id, set()).add(paper.get("id") or paper.get("doi") or paper.get("title") or "")

    ranked_ids = [
        work_id for work_id, sources in sorted(reference_counts.items(), key=lambda item: (-len(item[1]), item[0]))
        if len(sources) >= threshold
    ][:12]
    records = []
    for work_id in ranked_ids:
        try:
            work = fetch_openalex_work_by_id(work_id)
            record = recommendation_record(*openalex_recommendation_item(work), source="OpenAlex missing seminal")
            record["citedByLoadedCount"] = len(reference_counts.get(work_id) or [])
            record["reason"] = f"Cited by {record['citedByLoadedCount']} papers already on this map."
            records.append(record)
        except ClientError:
            continue
    return {"ok": True, "threshold": threshold, "recommendations": records}


def snowball_papers(payload):
    paper = payload.get("paper") or {}
    direction = (payload.get("direction") or "forward").lower()
    limit = min(max(int(payload.get("limit") or 25), 1), 50)
    work = openalex_work_for_paper(paper)
    if not work:
        raise ClientError(404, "OpenAlex could not identify this paper for citation chasing.")
    work_id = openalex_work_id(work.get("id"))
    if direction == "backward":
        reference_ids = [openalex_work_id(value) for value in work.get("referenced_works") or []]
        works = []
        for ref_id in [value for value in reference_ids if value][:limit]:
            try:
                works.append(fetch_openalex_work_by_id(ref_id))
            except ClientError:
                continue
        source = "OpenAlex references"
    else:
        works = openalex_citing_works(work_id, limit=limit)
        source = "OpenAlex citing papers"

    records = []
    for item in works:
        record = recommendation_record(*openalex_recommendation_item(item), source=source)
        record["reason"] = "Backward citation chase: this paper is referenced by the selected paper." if direction == "backward" else "Forward citation chase: this paper cites the selected paper."
        records.append(record)
    return {"ok": True, "direction": direction, "sourceOpenAlexId": work_id, "recommendations": records}


def openalex_work_for_paper(paper):
    work_id = openalex_work_id(paper.get("openAlexId") or paper.get("openAlexUrl") or "")
    if work_id:
        return fetch_openalex_work_by_id(work_id)
    doi = normalize_doi(paper.get("doi") or "")
    if doi:
        return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote('https://doi.org/' + doi, safe='')}")
    title = clean_openalex_search_term(paper.get("title") or "")
    if not title:
        return None
    params = urllib.parse.urlencode({"search": title, "per-page": 1})
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    results = data.get("results") or []
    return results[0] if results else None


def fetch_openalex_work_by_id(work_id):
    normalized = openalex_work_id(work_id)
    if not normalized:
        raise ClientError(400, "No OpenAlex work ID was provided.")
    return fetch_json(f"https://api.openalex.org/works/{urllib.parse.quote(normalized, safe='')}")


def openalex_citing_ids(work_id, limit=80):
    return [openalex_work_id(item.get("id")) for item in openalex_citing_works(work_id, limit=limit) if openalex_work_id(item.get("id"))]


def openalex_citing_works(work_id, limit=12):
    normalized = openalex_work_id(work_id)
    if not normalized:
        return []
    params = urllib.parse.urlencode({
        "filter": f"cites:{normalized}",
        "sort": "cited_by_count:desc",
        "per-page": max(1, min(limit, 100)),
    })
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    return data.get("results") or []


def openalex_work_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"\bW\d+\b", text)
    return match.group(0) if match else ""


def openalex_recommendations(search, limit, and_terms=None):
    and_terms = [term for term in (and_terms or []) if term][:3]
    params = {
        "per-page": max(25, limit * 4),
        "sort": "cited_by_count:desc",
    }
    if len(and_terms) >= 3:
        params["filter"] = ",".join(f"default.search:{term}" for term in and_terms)
    else:
        params["search"] = search
    params = urllib.parse.urlencode(params)
    data = fetch_json(f"https://api.openalex.org/works?{params}")
    return [recommendation_record(*openalex_recommendation_item(item), source="OpenAlex") for item in data.get("results") or []]


def crossref_recommendations(search, limit):
    params = urllib.parse.urlencode({
        "query.bibliographic": search,
        "rows": max(25, limit * 4),
        "filter": "from-pub-date:2018-01-01",
    })
    data = fetch_json(f"https://api.crossref.org/works?{params}")
    return [recommendation_record(*crossref_recommendation_item(item), source="Crossref") for item in (data.get("message") or {}).get("items") or []]


def dimensions_recommendations(search, limit):
    settings = load_settings()
    api_key = resolve_dimensions_api_key(settings)
    if not api_key:
        raise ClientError(400, "Dimensions API key is not configured.")

    token = dimensions_auth_token(api_key)
    safe_search = dsl_string(search)
    query = (
        f'search publications for "{safe_search}" where year >= 2018 '
        f'return publications[title+doi+year+journal+authors+abstract+concepts+times_cited+dimensions_url] '
        f'limit {max(25, limit * 4)}'
    )
    data = post_text_json(
        f"{DIMENSIONS_API_ROOT}/api/dsl/v2",
        query,
        headers={"Authorization": f"JWT {token}"},
        timeout=18,
        error_label="Dimensions API",
    )
    return [recommendation_record(*dimensions_recommendation_item(item), source="Dimensions") for item in data.get("publications") or []]


# ==============================================================================
# Semantic Scholar Academic Graph (S2AG) & Literature Discovery Pipeline
# ==============================================================================

S2_CACHE = {}


def s2_cache_get(key, max_age_seconds=600):
    entry = S2_CACHE.get(key)
    if not entry:
        return None
    val, timestamp = entry
    if time.time() - timestamp > max_age_seconds:
        S2_CACHE.pop(key, None)
        return None
    return val


def s2_cache_set(key, val):
    if len(S2_CACHE) > 500:
        S2_CACHE.clear()
    S2_CACHE[key] = (val, time.time())


def s2_request_headers(api_key=None):
    contact = f"mailto:{CONTACT_EMAIL}" if CONTACT_EMAIL else "academic-research@pulse.local"
    headers = {
        "Accept": "application/json",
        "User-Agent": f"pulse/{APP_VERSION} ({contact})",
    }
    if api_key:
        headers["x-api-key"] = api_key
    return headers


def fetch_s2_json(url, api_key=None, timeout=14):
    cached = s2_cache_get(url)
    if cached is not None:
        return cached
    request = urllib.request.Request(url, headers=s2_request_headers(api_key), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
            s2_cache_set(url, data)
            return data
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 404:
            return None
        if error.code == 429:
            raise ClientError(429, "Semantic Scholar rate limit reached. Add an S2 API key in Settings for high limits.")
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
        raise ClientError(504, f"Semantic Scholar connection timed out: {error}")


def post_s2_json(url, payload, api_key=None, timeout=14):
    cache_key = f"POST:{url}:{json.dumps(payload, sort_keys=True)}"
    cached = s2_cache_get(cache_key)
    if cached is not None:
        return cached
    headers = s2_request_headers(api_key)
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
            s2_cache_set(cache_key, result)
            return result
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if error.code == 429:
            raise ClientError(429, "Semantic Scholar rate limit reached. Add an S2 API key in Settings for high limits.")
        raise ClientError(error.code, f"Semantic Scholar error: {details[:400]}")
    except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
        raise ClientError(504, f"Semantic Scholar connection timed out: {error}")


def s2_to_metadata(item):
    if not item:
        return {}
    authors = []
    for author in item.get("authors") or []:
        name = author.get("name") if isinstance(author, dict) else str(author)
        cleaned = clean_author_name(name)
        if cleaned:
            authors.append(cleaned)
    external_ids = item.get("externalIds") or {}
    doi = normalize_doi(external_ids.get("DOI") or item.get("doi") or "")
    venue = item.get("venue") or ""
    year = item.get("year")
    date_val = str(year) if year else ""
    fields_of_study = []
    for f in (item.get("s2FieldsOfStudy") or []):
        if isinstance(f, dict) and f.get("category"):
            fields_of_study.append(f["category"])
    for f in (item.get("fieldsOfStudy") or []):
        if isinstance(f, str):
            fields_of_study.append(f)
    abstract = clean_crossref_text(item.get("abstract") or "")
    title = clean_crossref_text(item.get("title") or "")
    paper_id = item.get("paperId") or ""
    return {
        "title": title,
        "authors": authors[:24],
        "date": date_val,
        "year": date_val,
        "journal": clean_crossref_text(venue),
        "doi": doi,
        "abstract": abstract,
        "paperKeywords": dedupe_strings(fields_of_study)[:24],
        "s2PaperId": paper_id,
        "citationCount": item.get("citationCount") or 0,
        "influentialCitationCount": item.get("influentialCitationCount") or 0,
        "url": item.get("url") or (f"https://www.semanticscholar.org/paper/{paper_id}" if paper_id else (f"https://doi.org/{doi}" if doi else "")),
        "openAccessPdf": (item.get("openAccessPdf") or {}).get("url") or "",
    }


def s2_paper_id_for_paper(paper, api_key=None):
    if paper.get("s2PaperId"):
        return paper["s2PaperId"]
    doi = normalize_doi(paper.get("doi") or "")
    if doi:
        return f"DOI:{doi}"
    pmid = clean_field(str(paper.get("pmid") or ""))
    if pmid:
        return f"PMID:{pmid}"
    arxiv = clean_field(str(paper.get("arxiv") or ""))
    if arxiv:
        return f"ARXIV:{arxiv}"
    title = clean_openalex_search_term(paper.get("title") or "")
    if len(title) >= 8:
        try:
            url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/search/match?query={urllib.parse.quote(title)}&fields=paperId,title,year"
            data = fetch_s2_json(url, api_key=api_key)
            results = (data or {}).get("data") or []
            if results and results[0].get("paperId"):
                return results[0]["paperId"]
        except Exception:
            pass
    return None


def s2_fetch_references(identifier, api_key=None, limit=30):
    fields = "paperId,title,year,authors,abstract,venue,citationCount,influentialCitationCount,externalIds,isInfluential"
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/{urllib.parse.quote(identifier, safe='')}/references?fields={fields}&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        cited = item.get("citedPaper") or {}
        if not cited or not cited.get("title"):
            continue
        meta = s2_to_metadata(cited)
        record = recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (S2AG)")
        record["isInfluential"] = bool(item.get("isInfluential"))
        record["branch"] = "citationGraph"
        record["subType"] = "Backward"
        record["reason"] = f"Backward citation: foundational reference cited by seed paper{' (Influential citation)' if record['isInfluential'] else ''}."
        results.append(record)
    return results


def s2_fetch_citations(identifier, api_key=None, limit=30):
    fields = "paperId,title,year,authors,abstract,venue,citationCount,influentialCitationCount,externalIds,isInfluential"
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/{urllib.parse.quote(identifier, safe='')}/citations?fields={fields}&limit={limit}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        citing = item.get("citingPaper") or {}
        if not citing or not citing.get("title"):
            continue
        meta = s2_to_metadata(citing)
        record = recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (S2AG)")
        record["isInfluential"] = bool(item.get("isInfluential"))
        record["branch"] = "citationGraph"
        record["subType"] = "Forward"
        record["reason"] = f"Forward citation: downstream paper citing seed paper{' (Influential citation)' if record['isInfluential'] else ''}."
        results.append(record)
    return results


def s2_recommendations(positive_ids, negative_ids=None, api_key=None, limit=30):
    fields = "paperId,title,authors,year,abstract,venue,citationCount,influentialCitationCount,externalIds,url,fieldsOfStudy"
    clean_pos = [pid for pid in (positive_ids or []) if pid][:8]
    if not clean_pos:
        return []
    clean_neg = [nid for nid in (negative_ids or []) if nid][:5]
    payload = {"positivePaperIds": clean_pos}
    if clean_neg:
        payload["negativePaperIds"] = clean_neg
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/recommendations/v1/papers/?fields={fields}&limit={limit}"
    items = []
    try:
        data = post_s2_json(url, payload, api_key=api_key)
        items = (data or {}).get("recommendedPapers") or []
    except Exception:
        url_get = f"{SEMANTIC_SCHOLAR_API_ROOT}/recommendations/v1/papers/forpaper/{urllib.parse.quote(clean_pos[0], safe='')}?fields={fields}&limit={limit}"
        data = fetch_s2_json(url_get, api_key=api_key)
        items = (data or {}).get("recommendedPapers") or []
    results = []
    for rank_idx, item in enumerate(items):
        if not item or not item.get("title"):
            continue
        meta = s2_to_metadata(item)
        record = recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar (SPECTER2)")
        record["branch"] = "semanticSearch"
        record["subType"] = "SPECTER2"
        record["specterRank"] = rank_idx + 1
        record["reason"] = f"SPECTER2 scientific embedding match (Rank #{rank_idx + 1})."
        results.append(record)
    return results


def s2_paper_search(query, api_key=None, limit=30):
    fields = "paperId,title,authors,year,abstract,venue,citationCount,influentialCitationCount,externalIds,url,fieldsOfStudy,s2FieldsOfStudy"
    params = urllib.parse.urlencode({"query": query, "fields": fields, "limit": limit})
    url = f"{SEMANTIC_SCHOLAR_API_ROOT}/graph/v1/paper/search?{params}"
    data = fetch_s2_json(url, api_key=api_key)
    results = []
    for item in (data or {}).get("data") or []:
        if not item or not item.get("title"):
            continue
        meta = s2_to_metadata(item)
        record = recommendation_record(meta, {"openAlexId": "", "url": meta.get("url") or "", "citedByCount": meta.get("citationCount") or 0}, source="Semantic Scholar Search")
        record["branch"] = "lexicalConceptual"
        record["subType"] = "S2AG Search"
        record["reason"] = f"Lexical / conceptual search match for '{query[:40]}'."
        results.append(record)
    return results


def s2_recommendations_for_search(papers, search, limit, steer_terms=None):
    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    pos_ids = []
    for paper in papers[:4]:
        pid = s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            pos_ids.append(pid)
    if pos_ids:
        try:
            return s2_recommendations(pos_ids, api_key=api_key, limit=limit)
        except Exception:
            pass
    try:
        return s2_paper_search(search, api_key=api_key, limit=limit)
    except Exception:
        return []


def s2_paper_identifier(paper):
    return str(paper.get('s2PaperId') or paper.get('paperId') or paper.get('doi') or paper.get('openAlexId') or paper.get('title') or '').lower()


def fetch_citation_graph_branch(seed_papers, api_key=None, include_iterative_chase=True, limit=30, depth=None):
    gathered = []
    hop1_references = []
    hop1_citations = []
    for paper in seed_papers[:3]:
        s2_id = s2_paper_id_for_paper(paper, api_key=api_key)
        if s2_id:
            try:
                refs = s2_fetch_references(s2_id, api_key=api_key, limit=limit)
                gathered.extend(refs)
                hop1_references.extend(refs)
            except Exception:
                pass
            try:
                cites = s2_fetch_citations(s2_id, api_key=api_key, limit=limit)
                gathered.extend(cites)
                hop1_citations.extend(cites)
            except Exception:
                pass

        if not gathered:
            # Fallback to OpenAlex references & citing works
            work = openalex_work_for_paper(paper)
            if work:
                work_id = openalex_work_id(work.get("id"))
                for ref_id in (work.get("referenced_works") or [])[:limit]:
                    try:
                        ref_work = fetch_openalex_work_by_id(ref_id)
                        record = recommendation_record(*openalex_recommendation_item(ref_work), source="OpenAlex references")
                        record["branch"] = "citationGraph"
                        record["subType"] = "Backward"
                        record["reason"] = "Backward citation: foundational reference cited by seed paper."
                        gathered.append(record)
                        hop1_references.append(record)
                    except Exception:
                        continue
                citing_works = openalex_citing_works(work_id, limit=limit)
                for item in citing_works:
                    record = recommendation_record(*openalex_recommendation_item(item), source="OpenAlex citing papers")
                    record["branch"] = "citationGraph"
                    record["subType"] = "Forward"
                    record["reason"] = "Forward citation: downstream paper citing seed paper."
                    gathered.append(record)
                    hop1_citations.append(record)

    # Bounded breadth-first expansion; iterative stops early when no new records remain.
    max_depth = 4 if str(depth) == 'iterative' else max(1, min(int(depth or (2 if include_iterative_chase else 1)), 3))
    seen = {s2_paper_identifier(p) for p in seed_papers}
    frontier = [(p, 'backward') for p in hop1_references] + [(p, 'forward') for p in hop1_citations]
    for hop in range(2, max_depth + 1):
        next_frontier = []
        for direction in ('backward', 'forward'):
            candidates = sorted((p for p, d in frontier if d == direction), key=lambda p: int(p.get('citedByCount') or 0), reverse=True)[:4]
            for parent in candidates:
                key = s2_paper_identifier(parent)
                if not key or key in seen:
                    continue
                seen.add(key)
                try:
                    parent_id = s2_paper_id_for_paper(parent, api_key=api_key)
                    if not parent_id:
                        continue
                    fetcher = s2_fetch_references if direction == 'backward' else s2_fetch_citations
                    for item in fetcher(parent_id, api_key=api_key, limit=8):
                        item_key = s2_paper_identifier(item)
                        if item_key in seen:
                            continue
                        item.update(subType=f'Iterative Chase ({hop}-Hop)', hop=hop, chaseViaTitle=parent.get('title', ''), reason=f"Citation hop {hop} via {parent.get('title', '')[:80]}")
                        gathered.append(item)
                        next_frontier.append((item, direction))
                except Exception:
                    continue
        frontier = next_frontier
        if not frontier:
            break

    return gathered


def fetch_citation_network_branch(seed_papers, api_key=None, limit=30):
    gathered = []
    seed_dois = {normalize_doi(p.get("doi") or "").lower() for p in seed_papers if normalize_doi(p.get("doi") or "")}
    seed_titles = {normalize_title_key(p.get("title") or "") for p in seed_papers if p.get("title")}

    for paper in seed_papers[:3]:
        # Co-citation analysis via OpenAlex / S2:
        work = openalex_work_for_paper(paper)
        if not work:
            continue
        work_id = openalex_work_id(work.get("id"))
        citing_works = openalex_citing_works(work_id, limit=max(limit, 30))

        # Count references among papers citing this seed
        cocite_counts = {}
        for c_work in citing_works:
            for ref_id in (c_work.get("referenced_works") or []):
                ref_norm = openalex_work_id(ref_id)
                if not ref_norm or ref_norm == work_id:
                    continue
                cocite_counts[ref_norm] = cocite_counts.get(ref_norm, 0) + 1

        # Papers co-cited by >= 2 citing works
        top_cocited_ids = [ref_norm for ref_norm, count in sorted(cocite_counts.items(), key=lambda x: -x[1]) if count >= 2][:20]
        for ref_norm in top_cocited_ids:
            try:
                co_work = fetch_openalex_work_by_id(ref_norm)
                record = recommendation_record(*openalex_recommendation_item(co_work), source="Citation Network (Co-citation)")
                record["branch"] = "citationNetwork"
                record["subType"] = "Co-citation"
                record["sharedCitationsCount"] = cocite_counts[ref_norm]
                record["reason"] = f"Co-citation triangulation: cited together with seed paper by {cocite_counts[ref_norm]} citing papers."
                gathered.append(record)
            except Exception:
                continue

        # Bibliographic coupling analysis:
        # Find external works that cite multiple references of this seed
        seed_ref_ids = [openalex_work_id(r) for r in (work.get("referenced_works") or []) if openalex_work_id(r)][:8]
        if len(seed_ref_ids) >= 2:
            try:
                params = urllib.parse.urlencode({
                    "filter": f"cites:{'|'.join(seed_ref_ids[:4])}",
                    "sort": "cited_by_count:desc",
                    "per-page": max(limit, 25),
                })
                data = fetch_json(f"https://api.openalex.org/works?{params}")
                for b_work in (data.get("results") or []):
                    b_id = openalex_work_id(b_work.get("id"))
                    if b_id == work_id:
                        continue
                    b_refs = {openalex_work_id(r) for r in (b_work.get("referenced_works") or [])}
                    shared = len(set(seed_ref_ids).intersection(b_refs))
                    if shared >= 1:
                        record = recommendation_record(*openalex_recommendation_item(b_work), source="Citation Network (Bibliographic)")
                        record["branch"] = "citationNetwork"
                        record["subType"] = "Bibliographic coupling"
                        record["sharedReferencesCount"] = shared
                        record["reason"] = f"Bibliographic coupling: shares {shared} foundational references with seed paper."
                        gathered.append(record)
            except Exception:
                pass

    return gathered


def fetch_semantic_search_branch(seed_papers, api_key=None, exclude_papers=None, limit=30):
    pos_ids = []
    for paper in seed_papers[:5]:
        pid = s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            pos_ids.append(pid)
    neg_ids = []
    for paper in (exclude_papers or [])[:4]:
        pid = s2_paper_id_for_paper(paper, api_key=api_key)
        if pid:
            neg_ids.append(pid)
    if not pos_ids:
        return []
    return s2_recommendations(pos_ids, negative_ids=neg_ids, api_key=api_key, limit=limit)


def fetch_conceptual_search_branch(seed_papers, api_key=None, steer_keywords=None, limit=30):
    gathered = []
    concepts = []
    methods = []
    organisms = []
    for p in seed_papers[:3]:
        methods.extend(p.get("techniques") or [])
        organisms.extend(p.get("organisms") or [])
        concepts.extend(p.get("paperKeywords") or p.get("keywords") or [])
        for f in (p.get("keyFindings") or []):
            concepts.extend(keyword_tokens(f, max_terms=3))
    all_terms = dedupe_strings([*(steer_keywords or []), *methods, *organisms, *concepts])
    if not all_terms:
        return []

    # Query S2AG search with high-value domain concepts
    search_query = " ".join(all_terms[:8])
    try:
        s2_results = s2_paper_search(search_query, api_key=api_key, limit=limit)
        for r in s2_results:
            r["matchedConcepts"] = [t for t in all_terms if t.lower() in f"{r.get('title', '')} {r.get('abstract', '')}".lower()][:4]
            r["reason"] = f"Conceptual match for domain terms: {', '.join(r['matchedConcepts'][:3]) or search_query[:30]}."
            gathered.append(r)
    except Exception:
        pass

    # OpenAlex search with concepts
    try:
        openalex_items = openalex_recommendations(search_query, limit=limit)
        for r in openalex_items:
            r["branch"] = "lexicalConceptual"
            r["subType"] = "OpenAlex Concept Search"
            r["matchedConcepts"] = [t for t in all_terms if t.lower() in f"{r.get('title', '')} {r.get('abstract', '')}".lower()][:4]
            r["reason"] = f"Lexical / conceptual match: {', '.join(r['matchedConcepts'][:3]) or search_query[:30]}."
            gathered.append(r)
    except Exception:
        pass

    return gathered


def merge_and_rank_pipeline_candidates(candidates_by_branch, seed_papers, options):
    excluded_dois = {normalize_doi(p.get("doi") or "").lower() for p in seed_papers if normalize_doi(p.get("doi") or "")}
    excluded_titles = {normalize_title_key(p.get("title") or "") for p in seed_papers if p.get("title")}
    for ex_doi in options.get("excludeDois") or []:
        if normalize_doi(ex_doi):
            excluded_dois.add(normalize_doi(ex_doi).lower())
    for ex_title in options.get("excludeTitles") or []:
        if normalize_title_key(ex_title):
            excluded_titles.add(normalize_title_key(ex_title))

    steer_keywords = [t.lower() for t in (options.get("steerKeywords") or []) if t]
    exclude_keywords = [t.lower() for t in (options.get("excludeKeywords") or []) if t]
    recency_tilt = float(options.get("recencyTilt") or 0)
    impact_tilt = float(options.get("impactTilt") or 0)

    # Seed features for relevance matching
    seed_techniques = {t.lower() for p in seed_papers for t in (p.get("techniques") or [])}
    seed_organisms = {o.lower() for p in seed_papers for o in (p.get("organisms") or [])}
    seed_keywords = {k.lower() for p in seed_papers for k in (p.get("paperKeywords") or p.get("keywords") or [])}

    merged = {}
    for branch_name, items in candidates_by_branch.items():
        for item in items:
            doi = normalize_doi(item.get("doi") or "").lower()
            title_key = normalize_title_key(item.get("title") or "")
            if not title_key or doi in excluded_dois or title_key in excluded_titles:
                continue
            key = doi or title_key
            existing = merged.get(key)
            if not existing:
                record = dict(item)
                record["branchHits"] = {branch_name: True}
                record["sourceList"] = dedupe_strings(item.get("sourceList") or [item.get("source") or branch_name])
                record["discoveryBadges"] = []
                # Badges based on provenance
                if item.get("subType") == "SPECTER2":
                    record["discoveryBadges"].append("SPECTER2")
                elif item.get("subType") == "Co-citation":
                    count = item.get("sharedCitationsCount", 2)
                    record["discoveryBadges"].append(f"Co-citation ({count}x)")
                elif item.get("subType") == "Bibliographic coupling":
                    count = item.get("sharedReferencesCount", 2)
                    record["discoveryBadges"].append(f"Bib Coupling ({count}x)")
                elif item.get("subType") == "Iterative Chase (2-Hop)":
                    record["discoveryBadges"].append("2-Hop Chase")
                elif item.get("subType") == "Backward":
                    record["discoveryBadges"].append("Backward Ref")
                elif item.get("subType") == "Forward":
                    record["discoveryBadges"].append("Forward Cite")
                if item.get("isInfluential"):
                    record["discoveryBadges"].append("Influential Cite")

                merged[key] = record
            else:
                existing["branchHits"][branch_name] = True
                existing["sourceList"] = dedupe_strings([*existing.get("sourceList", []), *(item.get("sourceList") or [item.get("source") or branch_name])])
                if item.get("isInfluential"):
                    existing["isInfluential"] = True
                    if "Influential Cite" not in existing["discoveryBadges"]:
                        existing["discoveryBadges"].append("Influential Cite")
                if item.get("subType") == "SPECTER2" and "SPECTER2" not in existing["discoveryBadges"]:
                    existing["discoveryBadges"].append("SPECTER2")
                    existing["specterRank"] = item.get("specterRank", 1)
                elif item.get("subType") == "Co-citation" and not any("Co-citation" in b for b in existing["discoveryBadges"]):
                    existing["discoveryBadges"].append(f"Co-citation ({item.get('sharedCitationsCount', 2)}x)")
                elif item.get("subType") == "Bibliographic coupling" and not any("Bib Coupling" in b for b in existing["discoveryBadges"]):
                    existing["discoveryBadges"].append(f"Bib Coupling ({item.get('sharedReferencesCount', 2)}x)")
                elif item.get("subType") == "Iterative Chase (2-Hop)" and "2-Hop Chase" not in existing["discoveryBadges"]:
                    existing["discoveryBadges"].append("2-Hop Chase")

                for f in ("abstract", "url", "journal", "date", "year", "doi", "s2PaperId", "openAccessPdf"):
                    if not existing.get(f) and item.get(f):
                        existing[f] = item[f]
                existing["citedByCount"] = max(int(existing.get("citedByCount") or 0), int(item.get("citedByCount") or 0))

    ranked = []
    for item in merged.values():
        haystack = f"{item.get('title', '')} {item.get('abstract', '')} {' '.join(item.get('paperKeywords') or [])}".lower()

        # 1. Relevance Score
        penalty = sum(40 for term in exclude_keywords if term in haystack)
        if penalty >= 80:
            continue
        rel_methods = sum(15 for term in seed_techniques if term in haystack)
        rel_orgs = sum(15 for term in seed_organisms if term in haystack)
        rel_steer = sum(14 for term in steer_keywords if term in haystack)
        rel_keys = sum(5 for term in seed_keywords if term in haystack)
        relevance_score = max(0, rel_methods + rel_orgs + rel_steer + rel_keys - penalty)

        # 2. Citation Proximity Score
        prox_score = 0
        if item.get("branchHits", {}).get("citationGraph"):
            prox_score += 40
        if item.get("isInfluential"):
            prox_score += 24
        if item.get("subType") == "Co-citation" or any("Co-citation" in b for b in item.get("discoveryBadges", [])):
            prox_score += 28
        if item.get("subType") == "Bibliographic coupling" or any("Bib Coupling" in b for b in item.get("discoveryBadges", [])):
            prox_score += 24
        if "2-Hop Chase" in item.get("discoveryBadges", []):
            prox_score += 18

        # 3. Semantic Similarity Score
        sem_score = 0
        if item.get("branchHits", {}).get("semanticSearch"):
            rank = item.get("specterRank", 5)
            sem_score = max(18, 52 - rank * 2)

        # 4. Recency Score
        year_match = re.search(r"\b(19|20)\d{2}\b", str(item.get("year") or item.get("date") or ""))
        year = int(year_match.group(0)) if year_match else 2020
        recency_score = (year - 2018) * (2.0 + recency_tilt)

        # 5. Novelty / Diversity Score
        cites = min(int(item.get("citedByCount") or 0), 1000)
        novelty_score = (cites * 0.08) * (1.0 + impact_tilt * 0.5) if impact_tilt >= 0 else (max(0, 25 - cites) * (-impact_tilt * 1.5))

        # 6. Multi-Branch Convergence Bonus
        branch_count = len(item.get("branchHits", {}))
        convergence_bonus = 0
        if branch_count == 2:
            convergence_bonus = 35
        elif branch_count == 3:
            convergence_bonus = 70
        elif branch_count >= 4:
            convergence_bonus = 110

        total_score = round(relevance_score + prox_score + sem_score + recency_score + novelty_score + convergence_bonus, 1)

        item["score"] = total_score
        item["scoreBreakdown"] = {
            "relevance": round(relevance_score, 1),
            "citationProximity": round(prox_score, 1),
            "semanticSimilarity": round(sem_score, 1),
            "recency": round(recency_score, 1),
            "novelty": round(novelty_score, 1),
            "convergenceBonus": convergence_bonus,
            "totalScore": total_score,
        }

        # Provenance summary explanation
        reasons = []
        if "SPECTER2" in item.get("discoveryBadges", []):
            reasons.append("SPECTER2 semantic embeddings")
        if any("Co-citation" in b for b in item.get("discoveryBadges", [])):
            reasons.append("co-citation triangulation")
        if any("Bib Coupling" in b for b in item.get("discoveryBadges", [])):
            reasons.append("bibliographic coupling")
        if "Backward Ref" in item.get("discoveryBadges", []):
            reasons.append("foundational bibliography reference")
        if "Forward Cite" in item.get("discoveryBadges", []):
            reasons.append("forward citation")
        if "2-Hop Chase" in item.get("discoveryBadges", []):
            reasons.append("iterative 2-hop citation chase")
        if item.get("isInfluential"):
            reasons.append("highly influential citation")

        if reasons:
            item["reason"] = f"Surfaced via {', '.join(reasons)}."
        ranked.append(item)

    ranked.sort(key=lambda x: x.get("score", 0), reverse=True)
    limit = max(1, min(int(options.get("limit") or 50), 100))
    return ranked[:limit]


def run_discovery_pipeline(payload):
    seed_papers = payload.get("seedPapers") or payload.get("papers") or []
    if not seed_papers:
        raise ClientError(400, "Select at least one seed paper to run the literature discovery pipeline.")

    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    branches = payload.get("branches") or {
        "citationGraph": True,
        "citationNetwork": True,
        "semanticSearch": True,
        "lexicalSearch": True,
    }
    include_iterative = bool(payload.get("iterativeChase", True))
    steer_keywords = steering_terms(payload.get("steerKeywords") or [])
    exclude_keywords = steering_terms(payload.get("excludeKeywords") or [])
    limit = min(max(int(payload.get("limit") or 50), 1), 100)

    candidates_by_branch = {
        "citationGraph": [],
        "citationNetwork": [],
        "semanticSearch": [],
        "lexicalConceptual": [],
    }
    executed_branches = []

    if branches.get("citationGraph", True):
        try:
            candidates_by_branch["citationGraph"] = fetch_citation_graph_branch(
                seed_papers, api_key=api_key, include_iterative_chase=include_iterative, limit=limit, depth=payload.get('depth')
            )
            executed_branches.append("citationGraph")
        except Exception:
            pass

    if branches.get("citationNetwork", True):
        try:
            candidates_by_branch["citationNetwork"] = fetch_citation_network_branch(
                seed_papers, api_key=api_key, limit=limit
            )
            executed_branches.append("citationNetwork")
        except Exception:
            pass

    if branches.get("semanticSearch", True):
        try:
            candidates_by_branch["semanticSearch"] = fetch_semantic_search_branch(
                seed_papers, api_key=api_key, limit=limit
            )
            executed_branches.append("semanticSearch")
        except Exception:
            pass

    if branches.get("lexicalSearch", branches.get("lexicalConceptual", True)):
        try:
            candidates_by_branch["lexicalConceptual"] = fetch_conceptual_search_branch(
                seed_papers, api_key=api_key, steer_keywords=steer_keywords, limit=limit
            )
            executed_branches.append("lexicalConceptual")
        except Exception:
            pass

    ranked = merge_and_rank_pipeline_candidates(
        candidates_by_branch,
        seed_papers,
        {
            "steerKeywords": steer_keywords,
            "excludeKeywords": exclude_keywords,
            "excludeDois": payload.get("excludeDois") or [],
            "excludeTitles": payload.get("excludeTitles") or [],
            "recencyTilt": payload.get("recencyTilt") or 0,
            "impactTilt": payload.get("impactTilt") or 0,
            "limit": limit,
        },
    )

    return {
        "ok": True,
        "provider": "Semantic Scholar Academic Graph (S2AG) + Hybrid Pipeline",
        "seedCount": len(seed_papers),
        "branchesExecuted": executed_branches,
        "recommendations": ranked,
    }


def iterative_citation_chase(payload):
    paper = payload.get("paper") or {}
    if not paper:
        raise ClientError(400, "Select a seed paper to run iterative citation chase.")
    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    limit = min(max(int(payload.get("limit") or 25), 1), 60)
    results = fetch_citation_graph_branch([paper], api_key=api_key, include_iterative_chase=True, limit=limit)
    return {"ok": True, "recommendations": results}


def citation_network_triangulation(payload):
    paper = payload.get("paper") or {}
    if not paper:
        raise ClientError(400, "Select a seed paper to run citation network triangulation.")
    settings = load_settings()
    api_key = resolve_semantic_scholar_api_key(settings)
    limit = min(max(int(payload.get("limit") or 25), 1), 60)
    results = fetch_citation_network_branch([paper], api_key=api_key, limit=limit)
    return {"ok": True, "recommendations": results}


def recommendation_record(metadata, extra, source):
    return {
        **metadata,
        "source": source,
        "sourceList": [source],
        "openAlexId": extra.get("openAlexId") or "",
        "url": extra.get("url") or "",
        "citedByCount": extra.get("citedByCount") or 0,
    }


def openalex_recommendation_item(item):
    return openalex_to_metadata(item), {
        "openAlexId": item.get("id") or "",
        "url": item.get("doi") or item.get("id") or "",
        "citedByCount": item.get("cited_by_count") or 0,
    }


def crossref_recommendation_item(item):
    return crossref_to_metadata(item), {
        "url": f"https://doi.org/{normalize_doi(item.get('DOI') or '')}" if item.get("DOI") else (item.get("URL") or ""),
        "citedByCount": item.get("is-referenced-by-count") or 0,
    }


def dimensions_recommendation_item(item):
    journal = item.get("journal") or {}
    authors = []
    for author in item.get("authors") or []:
        if isinstance(author, dict):
            name = " ".join(part for part in [author.get("first_name", ""), author.get("last_name", "")] if part).strip()
            if not name:
                name = author.get("name") or ""
        elif isinstance(author, str):
            name = author
        else:
            name = ""
        cleaned = clean_author_name(name)
        if cleaned:
            authors.append(cleaned)
    concepts = []
    for concept in item.get("concepts") or []:
        if isinstance(concept, str):
            concepts.append(concept)
        elif isinstance(concept, dict) and concept.get("name"):
            concepts.append(concept["name"])
    metadata = {
        "title": clean_crossref_text(item.get("title") or ""),
        "authors": authors[:24],
        "date": str(item.get("year") or ""),
        "year": str(item.get("year") or ""),
        "journal": clean_crossref_text(journal.get("title") if isinstance(journal, dict) else journal),
        "doi": normalize_doi(item.get("doi") or ""),
        "abstract": clean_crossref_text(item.get("abstract") or ""),
        "paperKeywords": dedupe_strings(concepts)[:24],
    }
    return metadata, {
        "url": item.get("dimensions_url") or (f"https://doi.org/{metadata['doi']}" if metadata.get("doi") else ""),
        "citedByCount": item.get("times_cited") or 0,
    }


def merge_recommendations(items, query_terms, seed_terms, excluded_dois, excluded_titles, steering, limit):
    merged = {}
    for item in items:
        doi = normalize_doi(item.get("doi") or "")
        title_key = normalize_title_key(item.get("title") or "")
        if not item.get("title") or doi.lower() in excluded_dois or title_key in excluded_titles:
            continue
        key = doi.lower() or title_key
        if not key:
            continue
        existing = merged.get(key)
        if not existing:
            merged[key] = item
        else:
            existing["sourceList"] = dedupe_strings([*(existing.get("sourceList") or []), *(item.get("sourceList") or [])])
            existing["source"] = " + ".join(existing["sourceList"])
            existing["citedByCount"] = max(int(existing.get("citedByCount") or 0), int(item.get("citedByCount") or 0))
            existing["paperKeywords"] = dedupe_strings([*(existing.get("paperKeywords") or []), *(item.get("paperKeywords") or [])])[:24]
            for field in ("abstract", "url", "journal", "date", "year", "doi"):
                if not existing.get(field) and item.get(field):
                    existing[field] = item[field]

    ranked = []
    for item in merged.values():
        penalty = steering_penalty(item, steering.get("excludeTerms") or [])
        if penalty >= 2:
            continue
        concepts = item.get("paperKeywords") or []
        overlap = [term for term in concepts if term.lower() in seed_terms]
        if not overlap:
            item_terms = set(re.findall(r"[a-z][a-z-]{3,}", f"{item.get('title') or ''} {item.get('abstract') or ''}".lower()))
            overlap = [term for term in query_terms if term.lower() in item_terms][:5]
        author_boost = steering_match_score(item.get("authors") or [], steering.get("authors") or [])
        journal_boost = steering_match_score([item.get("journal") or ""], steering.get("journals") or [])
        item["reason"] = recommendation_reason(overlap, item.get("citedByCount") or 0, item.get("sourceList") or [item.get("source") or "source"], author_boost, journal_boost, penalty)
        item["_rank"] = recommendation_rank(item, overlap, author_boost, journal_boost, penalty, steering.get("recencyTilt") or 0, steering.get("impactTilt") or 0)
        ranked.append(item)

    ranked.sort(key=lambda item: item.get("_rank", 0), reverse=True)
    for item in ranked:
        item.pop("_rank", None)
    return ranked[:limit]


def recommendation_rank(item, overlap, author_boost=0, journal_boost=0, penalty=0, recency_tilt=0, impact_tilt=0):
    year_match = re.search(r"\b(19|20)\d{2}\b", str(item.get("year") or item.get("date") or ""))
    year = int(year_match.group(0)) if year_match else 0
    recency_weight = max(0, 2 + float(recency_tilt))
    citation_weight = max(0, 0.10 + float(impact_tilt) * 0.05)
    recency = max(0, year - 2017) * recency_weight
    citations = min(int(item.get("citedByCount") or 0), 500) * citation_weight
    sources = len(item.get("sourceList") or [])
    novelty = (2 - float(impact_tilt)) * 2 if int(item.get("citedByCount") or 0) < 25 else 0
    seminal = max(0, -float(recency_tilt)) * 6 if year and year < 2018 else 0
    return len(overlap) * 40 + recency + citations + novelty + seminal + sources * 12 + author_boost * 34 + journal_boost * 24 - penalty * 70


def steering_penalty(item, exclude_terms):
    haystack = " ".join([
        item.get("title") or "",
        item.get("abstract") or "",
        item.get("journal") or "",
        " ".join(item.get("paperKeywords") or []),
    ]).lower()
    return sum(1 for term in exclude_terms if term and term.lower() in haystack)


def steering_match_score(values, terms):
    haystack = " ; ".join(str(value or "") for value in values).lower()
    return sum(1 for term in terms if term and term.lower() in haystack)


def recommendation_query_terms(papers):
    weighted = []
    for paper in papers[:4]:
        for field in ("title", "journal"):
            weighted.extend(keyword_tokens(paper.get(field) or "", max_terms=8))
        for keyword in [
            *(paper.get("keywords") or []),
            *(paper.get("paperKeywords") or []),
            *(paper.get("gemmaKeywords") or []),
            *(paper.get("organisms") or []),
            *(paper.get("techniques") or []),
            *(paper.get("discoveryTerms") or []),
        ]:
            weighted.append(str(keyword).strip())
        for finding in paper.get("keyFindings") or []:
            weighted.extend(keyword_tokens(finding, max_terms=4))
        weighted.extend(keyword_tokens(paper.get("abstract") or "", max_terms=12))
    return dedupe_strings(weighted)[:28]


def steering_terms(values):
    terms = []
    for value in values:
        term = clean_openalex_search_term(value)
        if term and term not in terms:
            terms.append(term)
    return terms[:12]


def openalex_and_terms(papers, query_terms, steer_terms=None):
    explicit = list(steer_terms or [])
    for paper in papers[:4]:
        for keyword in [
            *(paper.get("discoveryTerms") or []),
            *(paper.get("keywords") or []),
            *(paper.get("paperKeywords") or []),
            *(paper.get("gemmaKeywords") or []),
            *(paper.get("organisms") or []),
            *(paper.get("techniques") or []),
        ]:
            explicit.append(keyword)
    candidates = dedupe_strings([*explicit, *query_terms])
    terms = []
    for candidate in candidates:
        term = clean_openalex_search_term(candidate)
        if term and term not in terms:
            terms.append(term)
        if len(terms) == 3:
            return terms
    return terms


def clean_openalex_search_term(value):
    text = clean_crossref_text(value)
    text = re.sub(r"[^A-Za-z0-9 -]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    if len(text) < 4:
        return ""
    return text[:80]


def keyword_tokens(text, max_terms=10):
    words = re.findall(r"[A-Za-z][A-Za-z-]{3,}", clean_crossref_text(text).lower())
    stop = {
        "this", "that", "with", "from", "into", "using", "paper", "study", "result", "results",
        "method", "methods", "analysis", "research", "journal", "article", "review", "based",
        "between", "through", "within", "their", "there", "these", "those", "have", "been",
    }
    counts = {}
    for word in words:
        if word not in stop:
            counts[word] = counts.get(word, 0) + 1
    return [word for word, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:max_terms]]


def recommendation_reason(overlap, cited_by_count, sources=None, author_boost=0, journal_boost=0, penalty=0):
    source_text = f" Found via {' + '.join(sources or [])}." if sources else ""
    steering = []
    if author_boost:
        steering.append("author steering")
    if journal_boost:
        steering.append("venue steering")
    if penalty:
        steering.append("lightly penalized by exclude terms")
    steering_text = f" Boosted by {', '.join(steering)}." if steering else ""
    if overlap:
        return f"Matches selected-paper themes: {', '.join(overlap[:5])}.{steering_text}{source_text}"
    if cited_by_count:
        return f"Highly cited result from the same search space ({cited_by_count} citations).{steering_text}{source_text}"
    return f"Ranked as a close title/abstract match for the selected paper.{steering_text}{source_text}"


def normalize_title_key(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def scan_doi_from_bytes(raw):
    candidates = scan_doi_candidates_from_bytes(raw)
    return candidates[0] if candidates else ""


def scan_doi_candidates_from_bytes(raw):
    chunks = []
    sample = raw[:8_000_000]
    for encoding in ("utf-8", "latin-1", "utf-16", "utf-16le", "utf-16be"):
        try:
            chunks.append(sample.decode(encoding, errors="ignore"))
        except LookupError:
            continue
    strings = re.findall(rb"[\x20-\x7E]{8,}", sample)
    chunks.extend(item.decode("latin-1", errors="ignore") for item in strings[:20000])
    chunks.extend(decode_pdf_streams(sample))
    return ranked_doi_candidates("\n\n".join(chunks))


# Characters Crossref recommends for DOI matching, plus "<>" (balanced SICI
# segments) and "+". The prefix may carry registrant subdivisions (10.1000.10/).
DOI_PREFIX_PATTERN = r"10\.\d{4,9}(?:\.\d+)*"
DOI_CHARS = r"[-._;()/:A-Za-z0-9<>+]"
DOI_CORE_PATTERN = DOI_PREFIX_PATTERN + "/" + DOI_CHARS + "+"
DOI_MATCH_RE = re.compile(r"(?<![0-9.])" + DOI_CORE_PATTERN, re.I)
DOI_DASH_TABLE = dict.fromkeys(map(ord, "‐‑‒–—―−﹘﹣－"), "-")
DOI_DASH_TABLE.update(dict.fromkeys(map(ord, "­​‌‍⁠﻿"), None))
DOI_DASH_TABLE[ord("／")] = "/"
# Prefixes that are DOIs but never identify a paper (Crossref Funder Registry).
DOI_NON_PAPER_PREFIXES = ("10.13039/",)
DOI_GLUED_TAIL_RE = re.compile(
    r"(?<=[0-9a-z)])(?:Received|Accepted|Published|Available|Copyright|Citation|Cite|Keywords|Abstract|"
    r"Downloaded|Supplementary|Correspondence|Article|ORCID|PMID|PMCID|ISSN|Email|E-mail|https?:|www\.)[\s\S]*$"
)
DOI_URL_SUFFIX_RE = re.compile(
    r"(?:/(?:full|abstract|pdf|epdf|pdfdirect|fulltext|summary|references|meta|html)"
    r"|\.(?:full|abstract|supplementary)(?:\.pdf(?:\+html)?|\.html)?|\.pdf)+$",
    re.I,
)
DOI_MARKER_RE = re.compile(
    r"(?:\bdoi\b|doi\.org/|prism:doi|dc:identifier|identifier)[\s:=>\"'(/]*(?:(?:abs|full|pdf|epdf|pdfdirect)/)?$",
    re.I,
)
DOI_REFERENCES_RE = re.compile(
    r"\n[ \t]*(?:\d+\.?[ \t]*)?(?:References(?: and Notes)?|REFERENCES|Bibliography|BIBLIOGRAPHY|"
    r"Literature Cited|LITERATURE CITED|Works Cited|Reference List)[ \t:]*\n"
)


# Never join a wrapped line onto text that starts its own identifier.
DOI_NEW_ITEM_GUARD = r"(?![Dd][Oo][Ii]\b|[Hh][Tt][Tt][Pp][Ss]?:|[Ww][Ww][Ww]\.|\S*?10\.\d{4,9}/)"


def prepare_doi_text(value):
    """Normalise text so DOIs survive PDF extraction, HTML and URL encoding."""
    text = str(value or "").translate(DOI_DASH_TABLE)
    text = text.replace("\\/", "/")
    if "&" in text:
        text = html.unescape(text)
    text = re.sub(
        r"(?<!\S)[^\s%]*%(?:2F|3C|3E|28|29|3A|3B)\S*",
        lambda m: urllib.parse.unquote(m.group(0)),
        text,
        flags=re.I,
    )
    # Letter-spaced extraction ("1 0 . 1 0 3 8 / n a t u r e") from tracked fonts.
    def collapse_spaced(match):
        joined = match.group(0).replace(" ", "")
        return joined if re.search(r"10\.\d{4}", joined) else match.group(0)

    text = re.sub(r"(?<!\S)(?:\S{1,2} ){5,}\S{1,2}(?!\S)", collapse_spaced, text)
    text = re.sub(r"(10\.\d{4,9}(?:\.\d+)*)[ \t]*/[ \t]*", r"\1/", text)
    return text


def join_wrapped_dois(text):
    """Rejoin DOIs that a PDF line break split in two.

    A break after "/" or "-" is always mid-DOI. A break after "." or "_" is
    joined only when the next line continues in lowercase or digits and does
    not look like a numbered reference ("2. Smith"). Case-sensitive on purpose.
    """
    always = re.sub(
        r"(" + DOI_PREFIX_PATTERN + r"/(?:" + DOI_CHARS + r"*[-/])?)[ \t]*\r?\n[ \t]*" + DOI_NEW_ITEM_GUARD + r"(?=[A-Za-z0-9(])",
        r"\1",
        text,
    )
    return re.sub(
        r"(" + DOI_PREFIX_PATTERN + r"/" + DOI_CHARS + r"*[._])[ \t]*\r?\n[ \t]*(?!\d{1,3}[.)][ \t])" + DOI_NEW_ITEM_GUARD + r"(?=[a-z0-9])",
        r"\1",
        always,
    )


def doi_matches(value):
    """Return [(doi, position, text)] for every cleaned DOI in document order."""
    prepared = prepare_doi_text(value)
    joined = join_wrapped_dois(prepared)
    found = []
    seen = set()
    for source_index, text in enumerate((joined, prepared) if joined != prepared else (joined,)):
        for match in DOI_MATCH_RE.finditer(text):
            doi = clean_doi_candidate(match.group(0))
            key = doi.lower()
            if key in seen or not valid_doi_candidate(doi):
                continue
            # The unwrapped text only adds DOIs the line-joined text did not
            # already contain in longer form (drop "10.1093/nar/" stubs).
            if source_index and any(other.lower().startswith(key) for other, *_ in found):
                continue
            seen.add(key)
            found.append((doi, match.start(), text, source_index))
    return found


def ranked_doi_candidates(value):
    matches = doi_matches(value)
    if not matches:
        return []
    ranked = []
    refs_by_text = {}
    for doi, position, text, source_index in matches:
        if source_index not in refs_by_text:
            refs_by_text[source_index] = [m.start() for m in DOI_REFERENCES_RE.finditer(text)]
        refs = refs_by_text[source_index]
        score = 0
        if DOI_MARKER_RE.search(text[max(0, position - 40):position]):
            score += 4
        if refs and position > refs[-1]:
            score -= 5
        if position < 4000:
            score += 1
        if source_index:
            score -= 1
        ranked.append((-score, source_index, position, doi))
    ranked.sort()
    return [item[3] for item in ranked[:12]]


def balance_doi_brackets(doi):
    """Cut at the first unbalanced "<" or ">" so HTML never leaks into a DOI."""
    depth = 0
    open_at = -1
    for index, char in enumerate(doi):
        if char == "<":
            if depth == 0:
                open_at = index
            depth += 1
        elif char == ">":
            if depth == 0:
                return doi[:index]
            depth -= 1
    return doi[:open_at] if depth else doi


def clean_doi_candidate(value):
    clean = prepare_doi_text(value).strip()
    clean = re.sub(r"^\s*(?:https?://)?(?:www\.|dx\.)?doi\.org/", "", clean, flags=re.I)
    clean = re.sub(r"^\s*doi\s*[:=]?\s*", "", clean, flags=re.I)
    clean = re.sub(r"\s+", "", clean)
    clean = clean.strip("\"'{}[]")
    clean = re.split(r"<(?=[/!?A-Za-z])", clean)[0]
    clean = re.split(r"\)?(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)\b", clean)[0]
    # PDF link annotations: "/URI (https://doi.org/10.x/y)/S/URI".
    clean = re.split(r"\)/(?:S|URI|Type|Subtype|Rect|Border|BS|A|F|H|C|D|Dest|Next|NM|M|P|StructParent)\b", clean)[0]
    clean = re.split(r"(?=/+(?:Height|Filter|FlateDecode|Type|XObject|Width|SMask|Length|BitsPerComponent|ColorSpace|Subtype|stream|endstream)\b)", clean, flags=re.I)[0]
    clean = re.split(r"(?:>>|<<|endobj|\bobj\b|\bstream\b)", clean, flags=re.I)[0]
    clean = balance_doi_brackets(clean)
    clean = DOI_GLUED_TAIL_RE.sub("", clean)
    for _ in range(3):
        before = clean
        clean = clean.rstrip(".,;:'\"")
        while clean.endswith(")") and clean.count("(") < clean.count(")"):
            clean = clean[:-1].rstrip(".,;:")
        clean = DOI_URL_SUFFIX_RE.sub("", clean)
        clean = re.sub(r"^(10\.1101/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,})v\d+$", r"\1", clean)
        if clean == before:
            break
    return clean


def valid_doi_candidate(doi):
    if not doi or not re.match(r"^10\.\d{4,9}(?:\.\d+)*/", doi, re.I):
        return False
    if doi.lower().startswith(DOI_NON_PAPER_PREFIXES):
        return False
    suffix = doi.split("/", 1)[1] if "/" in doi else ""
    if len(suffix) < 2 or len(doi) > 200:
        return False
    if re.search(r"[^\x20-\x7E]", doi):
        return False
    if re.search(r"[\\{}\[\]|^`\s]", doi):
        return False
    if balance_doi_brackets(doi) != doi:
        return False
    if re.search(r"^10\.\d+/(?:obj|stream|length|filter|type|height|width|xobject|smask|bitspercomponent)\b", doi, re.I):
        return False
    if re.search(r"(?:/Length|/Filter|/FlateDecode|/Type|/XObject|/Width|/Height|>>|<<|stream)", doi, re.I):
        return False
    if re.search(r"\)(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)$", doi):
        return False
    return True


def same_doi(left, right):
    a = normalize_doi(left)
    return bool(a) and a.lower() == normalize_doi(right).lower()


def decode_pdf_streams(raw):
    decoded = []
    for match in re.finditer(rb"<<(?P<dict>[\s\S]{0,2000}?/FlateDecode[\s\S]{0,2000}?)>>\s*stream\r?\n(?P<body>[\s\S]*?)\r?\nendstream", raw):
        body = match.group("body").strip(b"\r\n")
        for candidate in zlib_candidates(body):
            try:
                inflated = zlib.decompress(candidate)
            except zlib.error:
                continue
            decoded.extend(decode_pdf_text_bytes(inflated))
    return decoded


def zlib_candidates(body):
    yield body
    if body.startswith(b"\r\n") or body.startswith(b"\n"):
        yield body.lstrip(b"\r\n")
    for index in range(min(len(body), 12)):
        yield body[index:]


def decode_pdf_text_bytes(data):
    chunks = []
    for encoding in ("utf-8", "latin-1", "utf-16be", "utf-16le"):
        chunks.append(data.decode(encoding, errors="ignore"))
    strings = re.findall(rb"[\x20-\x7E]{4,}", data)
    chunks.extend(item.decode("latin-1", errors="ignore") for item in strings[:5000])
    return chunks


def fetch_json(url):
    contact = f"mailto:{CONTACT_EMAIL}" if CONTACT_EMAIL else "contact-not-configured"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": f"pulse/{APP_VERSION} ({contact})",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"DOI lookup failed: {details[:500]}")
    except urllib.error.URLError as error:
        raise ClientError(502, f"Could not reach DOI metadata service: {error.reason}")
    except (TimeoutError, socket.timeout):
        raise ClientError(504, "Metadata service timed out.")


def post_text_json(url, text, headers=None, timeout=18, error_label="API"):
    request = urllib.request.Request(
        url,
        data=text.encode("utf-8"),
        headers=headers or {},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"{error_label} error: {details[:500]}")
    except urllib.error.URLError as error:
        raise ClientError(502, f"Could not reach {error_label}: {error.reason}")
    except (TimeoutError, socket.timeout):
        raise ClientError(504, f"{error_label} timed out.")


def dimensions_auth_token(api_key):
    request = urllib.request.Request(
        f"{DIMENSIONS_API_ROOT}/api/auth.json",
        data=json.dumps({"key": api_key}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Dimensions auth failed: {details[:500]}")
    except urllib.error.URLError as error:
        raise ClientError(502, f"Could not reach Dimensions auth: {error.reason}")
    except (TimeoutError, socket.timeout):
        raise ClientError(504, "Dimensions auth timed out.")
    token = data.get("token") or ""
    if not token:
        raise ClientError(502, "Dimensions did not return an API token.")
    return token


def dsl_string(value):
    return re.sub(r"\s+", " ", str(value or "")).replace("\\", "\\\\").replace('"', '\\"').strip()


def merge_metadata(base, incoming):
    merged = dict(base or {})
    for key, value in (incoming or {}).items():
        if key in {"authors", "paperKeywords", "referenceIds", "citedByIds", "keyFindings", "organisms", "techniques", "discoveryTerms", "doiCandidates"}:
            merged[key] = dedupe_strings([*(merged.get(key) or []), *(value or [])])
        elif value and (not merged.get(key) or key == "abstract" and len(str(value)) > len(str(merged.get(key) or ""))):
            merged[key] = value
    return merged


def merge_verified_doi_metadata(extracted, verified):
    merged = merge_metadata(extracted, verified)
    for key in ("doi", "title", "authors", "date", "year", "journal", "openAlexId", "openAlexUrl"):
        if verified.get(key):
            merged[key] = verified[key]
    if verified.get("abstract") and len(str(verified.get("abstract"))) >= len(str(merged.get("abstract") or "")):
        merged["abstract"] = verified["abstract"]
    merged["paperKeywords"] = dedupe_strings([
        *(verified.get("paperKeywords") or []),
        *(merged.get("paperKeywords") or []),
    ])[:24]
    return merged


def metadata_completeness_score(metadata):
    score = 0
    if metadata.get("doi"):
        score += 3
    if metadata.get("title"):
        score += 3
    if metadata.get("authors"):
        score += 2
    if metadata.get("date") or metadata.get("year"):
        score += 1
    if metadata.get("journal"):
        score += 1
    if len(metadata.get("abstract") or "") >= 120:
        score += 2
    if metadata.get("paperKeywords"):
        score += 1
    return score


def clamp_float(value, minimum, maximum, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def metadata_is_filled(metadata):
    return (
        bool(metadata.get("doi"))
        and bool(metadata.get("title"))
        and bool(metadata.get("authors"))
        and bool(metadata.get("date") or metadata.get("year"))
        and bool(metadata.get("journal"))
        and (len(metadata.get("abstract") or "") >= 120 or bool(metadata.get("paperKeywords")))
    )


def normalize_doi(value):
    """First DOI in the value, cleaned. Case is preserved; compare with same_doi()."""
    matches = doi_matches(value)
    return matches[0][0] if matches else ""


def re_search_doi(value):
    return normalize_doi(value)


def crossref_to_metadata(item):
    title = first_list_value(item.get("title"))
    journal = (
        first_list_value(item.get("container-title"))
        or first_list_value(item.get("short-container-title"))
        or first_list_value(item.get("institution"))
        or item.get("publisher", "")
    )
    date = crossref_date(item)
    abstract = clean_crossref_text(item.get("abstract") or "")
    authors = []
    for author in item.get("author") or []:
        name = " ".join(part for part in [author.get("given", ""), author.get("family", "")] if part).strip()
        if not name:
            name = author.get("name") or ""
        cleaned = clean_author_name(name)
        if cleaned:
            authors.append(cleaned)

    keywords = []
    for key in ("subject", "reference"):
        if key == "subject":
            keywords.extend(value for value in item.get(key) or [] if isinstance(value, str))

    return {
        "title": clean_crossref_text(title),
        "authors": authors[:24],
        "date": date,
        "year": date[:4] if date else "",
        "journal": clean_crossref_text(journal),
        "doi": normalize_doi(item.get("DOI") or ""),
        "abstract": abstract,
        "paperKeywords": dedupe_strings(keywords)[:24],
    }


def openalex_to_metadata(item):
    primary = item.get("primary_location") or {}
    source = primary.get("source") or {}
    authors = []
    for authorship in item.get("authorships") or []:
        author = authorship.get("author") or {}
        cleaned = clean_author_name(author.get("display_name") or "")
        if cleaned:
            authors.append(cleaned)

    date = item.get("publication_date") or (str(item.get("publication_year")) if item.get("publication_year") else "")
    keywords = []
    for concept in item.get("concepts") or []:
        if concept.get("display_name") and float(concept.get("score") or 0) >= 0.15:
            keywords.append(concept["display_name"])
    for keyword in item.get("keywords") or []:
        if keyword.get("display_name"):
            keywords.append(keyword["display_name"])

    return {
        "title": clean_crossref_text(item.get("title") or item.get("display_name") or ""),
        "authors": authors[:24],
        "date": date,
        "year": str(item.get("publication_year") or "") or date[:4],
        "journal": clean_crossref_text(source.get("display_name") or ""),
        "doi": normalize_doi(item.get("doi") or item.get("DOI") or ""),
        "abstract": clean_crossref_text(reconstruct_openalex_abstract(item.get("abstract_inverted_index") or {})),
        "paperKeywords": dedupe_strings(keywords)[:24],
        "openAlexId": openalex_work_id(item.get("id") or ""),
        "openAlexUrl": item.get("id") or "",
        "referenceIds": [openalex_work_id(value) for value in item.get("referenced_works") or [] if openalex_work_id(value)][:120],
        "citedByCount": item.get("cited_by_count") or 0,
    }


def reconstruct_openalex_abstract(index):
    if not isinstance(index, dict) or not index:
        return ""
    positions = []
    for word, word_positions in index.items():
        for position in word_positions or []:
            try:
                positions.append((int(position), str(word)))
            except (TypeError, ValueError):
                continue
    return " ".join(word for _, word in sorted(positions))


def first_list_value(value):
    if isinstance(value, list) and value:
        return str(value[0] or "")
    if isinstance(value, str):
        return value
    return ""


def crossref_date(item):
    for key in ("published-print", "published-online", "published", "issued", "created"):
        parts = ((item.get(key) or {}).get("date-parts") or [[]])[0]
        if parts:
            return "-".join(str(part).zfill(2) if index else str(part) for index, part in enumerate(parts[:3]))
    return ""


def clean_crossref_text(value):
    text = str(value or "")
    if not text:
        return ""
    abstract_section = re.search(
        r"<jats:sec[^>]*>\s*<jats:title>\s*Abstract\s*</jats:title>([\s\S]*?)(?=<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*</jats:title>|</jats:sec>\s*$)",
        text,
        re.I,
    )
    if abstract_section:
        text = abstract_section.group(1)
    text = re.sub(r"<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*</jats:title>[\s\S]*?</jats:sec>", " ", text, flags=re.I)
    text = re.sub(r"</?(?:jats:)?title[^>]*>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clean_author_name(s):
    if not s:
        return ""
    s = re.sub(r"\s*\([^)]*\)", "", str(s))
    s = re.sub(r"\s*\[[^\]]*\]", "", s)
    s = re.sub(r"^[\s\d*†‡§#.,;:\x22'([\]{}<>/\\-]+", "", s).strip()
    s = re.sub(r"[\s*†‡§#,:;\x22'([\]{}<>/\\-]+$", "", s).strip()
    if re.search(r"[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]{2,}\.$", s):
        s = s[:-1].strip()
    return s


def dedupe_strings(values):
    seen = set()
    result = []
    for value in values:
        clean = str(value or "").strip()
        key = clean.lower()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def write_settings(settings):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(settings, indent=2), "utf-8")
    try:
        CONFIG_PATH.chmod(0o600)
    except OSError:
        pass
    return settings


def public_settings(settings):
    dimensions_key = resolve_dimensions_api_key(settings)
    s2_key = resolve_semantic_scholar_api_key(settings)
    gemini_key = resolve_gemini_api_key(settings)
    caps = workflow_capabilities()
    ollama = ollama_status(settings)
    ollama["bundled"] = bundled_ollama_status()
    ai_provider = resolve_ai_provider(settings)
    local_ready = bool(ollama.get("online")) and bool(ollama.get("chatModelAvailable"))
    cloud_ready = bool(gemini_key)
    is_ready = cloud_ready if ai_provider == "cloud" else local_ready

    cloud_provider = settings.get("cloudProvider") or "google-ai-studio"
    cloud_model = resolve_cloud_model(settings)

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
        "configPath": str(CONFIG_PATH),
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
                "active": "text-embedding-004" if ai_provider == "cloud" else resolve_embedding_model(settings),
                "endpoint": "Google AI Studio" if ai_provider == "cloud" else resolve_ollama_embeddings_endpoint(settings),
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
                "preview": preview_key(dimensions_key),
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


def preview_key(api_key):
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "set"
    return f"{api_key[:4]}...{api_key[-4:]}"


def resolve_semantic_scholar_api_key(settings):
    return os.environ.get("SEMANTIC_SCHOLAR_API_KEY") or settings.get("semanticScholarApiKey") or ""


def resolve_dimensions_api_key(settings):
    return os.environ.get("DIMENSIONS_API_KEY") or settings.get("dimensionsApiKey") or ""


def resolve_gemini_api_key(settings):
    return str(settings.get("apiKey") or settings.get("geminiApiKey") or os.environ.get("GEMINI_API_KEY") or "").strip()


def resolve_cloud_model(settings):
    return str(settings.get("cloudModel") or settings.get("model") or "gemini-2.5-flash").strip()


def resolve_ai_provider(settings):
    provider = str(os.environ.get("PULSE_AI_PROVIDER") or os.environ.get("IRATXE_AI_PROVIDER") or settings.get("aiProvider") or LOCAL_BACKEND_DEFAULTS["aiProvider"]).strip().lower()
    return provider if provider in {"local", "cloud"} else LOCAL_BACKEND_DEFAULTS["aiProvider"]


def resolve_gemma_model(settings):
    return normalize_gemma_model(os.environ.get("GEMMA_MODEL") or settings.get("gemmaModel") or DEFAULT_GEMMA_MODEL)


def resolve_embedding_model(settings):
    return (os.environ.get("OLLAMA_EMBEDDING_MODEL") or settings.get("embeddingModel") or LOCAL_BACKEND_DEFAULTS["embeddingModel"]).strip()


def resolve_ollama_chat_endpoint(settings):
    return normalize_ollama_endpoint(os.environ.get("OLLAMA_CHAT_ENDPOINT") or settings.get("ollamaChatEndpoint") or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"], "chat")


def resolve_ollama_tags_endpoint(settings):
    return endpoint_with_api(resolve_ollama_chat_endpoint(settings), "tags")


def resolve_ollama_embeddings_endpoint(settings):
    return endpoint_with_api(resolve_ollama_chat_endpoint(settings), "embeddings")


def bundled_ollama_available():
    return BUNDLED_OLLAMA.exists() and os.access(BUNDLED_OLLAMA, os.X_OK)


def bundled_ollama_status():
    return {
        "available": bundled_ollama_available(),
        "binary": str(BUNDLED_OLLAMA),
        "boot": OLLAMA_BOOT_STATUS,
    }


def ollama_server_responds(timeout=0.45):
    endpoint = LOCAL_BACKEND_DEFAULTS["ollamaTagsEndpoint"]
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": "pulse"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def ensure_ollama_runtime():
    global OLLAMA_PROCESS, OLLAMA_BOOT_STATUS
    if ollama_server_responds():
        OLLAMA_BOOT_STATUS = {"started": True, "reason": "existing-daemon"}
        return
    if (os.environ.get("PULSE_DISABLE_BUNDLED_OLLAMA") or os.environ.get("IRATXE_DISABLE_BUNDLED_OLLAMA") or "").strip() == "1":
        OLLAMA_BOOT_STATUS = {"started": False, "reason": "disabled-by-env"}
        return
    if not bundled_ollama_available():
        OLLAMA_BOOT_STATUS = {"started": False, "reason": "bundled-binary-missing"}
        return
    if OLLAMA_PROCESS and OLLAMA_PROCESS.poll() is None:
        OLLAMA_BOOT_STATUS = {"started": True, "reason": "already-running", "pid": OLLAMA_PROCESS.pid}
        return

    OLLAMA_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.setdefault("OLLAMA_MODELS", str(OLLAMA_MODELS_DIR))
    env.setdefault("OLLAMA_HOST", "127.0.0.1:11434")
    try:
        OLLAMA_PROCESS = subprocess.Popen(
            [str(BUNDLED_OLLAMA), "serve"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        OLLAMA_BOOT_STATUS = {
            "started": True,
            "reason": "started-bundled-ollama",
            "pid": OLLAMA_PROCESS.pid,
            "binary": str(BUNDLED_OLLAMA),
        }
    except Exception as error:
        OLLAMA_BOOT_STATUS = {
            "started": False,
            "reason": f"failed-to-start: {error}",
            "binary": str(BUNDLED_OLLAMA),
        }
        return

    for _ in range(15):
        if ollama_server_responds(timeout=0.3):
            OLLAMA_BOOT_STATUS["healthy"] = True
            return
        time_sleep(0.35)


def start_ollama_runtime_background():
    thread = threading.Thread(target=ensure_ollama_runtime, name="pulse-ollama-runtime", daemon=True)
    thread.start()


def normalize_gemma_model(value):
    model = str(value or "").strip()
    if not model or model.lower() in {"default", "auto"}:
        return DEFAULT_GEMMA_MODEL
    return model


def normalize_ollama_endpoint(value, api_name):
    endpoint = str(value or "").strip() or LOCAL_BACKEND_DEFAULTS["ollamaChatEndpoint"]
    return endpoint_with_api(endpoint, api_name)


def endpoint_with_api(endpoint, api_name):
    parsed = urllib.parse.urlparse(endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/api/chat") or path.endswith("/api/generate") or path.endswith("/api/embeddings") or path.endswith("/api/tags"):
        base_path = re.sub(r"/api/(chat|generate|embeddings|tags)$", "", path)
        new_path = f"{base_path}/api/{api_name}" if base_path else f"/api/{api_name}"
    else:
        new_path = f"{path}/api/{api_name}" if path else f"/api/{api_name}"
    return urllib.parse.urlunparse(parsed._replace(path=new_path, params="", query="", fragment=""))


def ollama_tags(settings, timeout=3):
    endpoint = resolve_ollama_tags_endpoint(settings)
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": "pulse"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            models = payload.get("models", [])
            return [item.get("name") for item in models if isinstance(item, dict) and item.get("name")]
    except Exception:
        return []


def ollama_status(settings):
    tags = ollama_tags(settings, timeout=1.5)
    model = resolve_gemma_model(settings)
    embedding_model = resolve_embedding_model(settings)
    online = bool(tags) or ollama_server_responds(timeout=0.35)
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


def require_ollama_model(settings, model, role):
    models = ollama_tags(settings)
    if model not in models:
        label = "Model" if role == "chat" else "Embedding model"
        raise ClientError(400, f"{label} not found in Ollama. Run: ollama pull {model}")
    return True


def require_ai_model(settings, role="chat"):
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
    settings = load_settings()
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
        except Exception as e:
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
        clean = clean_crossref_text(line)
        if not clean:
            continue
        heading = re.match(r"^(abstract|introduction|methods?|materials and methods|results?|discussion|conclusion|references)", clean, re.I)
        if heading:
            current = heading.group(1).title()
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(clean)
    return {k: " ".join(v).strip() for k, v in sections.items() if v}


def chunk_paragraphs(paper):
    sections = detect_sections(paper.get("text") or "")
    chunks = []
    paper_id = paper.get("id") or paper.get("doi") or paper.get("title")
    title = paper.get("title") or "Paper"
    doi = paper.get("doi") or ""
    if not sections:
        raw_text = clean_extracted_text(paper.get("text") or paper.get("abstract") or "")
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
    clean = clean_crossref_text(text).lower()
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


def gemini_embedding(settings, text):
    api_key = resolve_gemini_api_key(settings)
    if not api_key:
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}"
    payload = {
        "model": "models/text-embedding-004",
        "content": {"parts": [{"text": str(text or "")[:2048]}]}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            values = data.get("embedding", {}).get("values")
            if isinstance(values, list) and values:
                return [float(v) for v in values]
    except Exception:
        return None
    return None


def nearest_chunk_context(papers, prompt, limit=10):
    chunks = []
    for paper in papers[:40]:
        chunks.extend(chunk_paragraphs(paper))
    if not chunks:
        return []
    query_terms = " ".join([prompt, *recommendation_query_terms(papers)])
    settings = load_settings()
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
            pass

    query_vector = hybrid_semantic_embedding(query_terms, dimensions=1024)
    scored = []
    for chunk in chunks:
        score = cosine(query_vector, hybrid_semantic_embedding(chunk["text"], dimensions=1024))
        scored.append((score, chunk))
    return [chunk for _, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]]


def call_gemini(settings, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
    api_key = resolve_gemini_api_key(settings)
    if not api_key:
        raise ClientError(400, "Gemini API key is missing. Please enter your Google AI Studio API key in Settings.")
    model = resolve_cloud_model(settings)
    if model.startswith("models/"):
        model = model[len("models/"):]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
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
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Google Gemini API error ({error.code}): {details[:900]}")
    except urllib.error.URLError as error:
        raise ClientError(503, f"Google Gemini API offline or unreachable: {error.reason}")

    try:
        candidates = data.get("candidates") or []
        if candidates and "content" in candidates[0]:
            parts = candidates[0]["content"].get("parts") or []
            if parts and "text" in parts[0]:
                return parts[0]["text"].strip()
    except Exception as e:
        raise ClientError(502, f"Failed to parse Gemini response: {e}")
    return ""


def call_gemma(settings, prompt, temperature=0.2, max_tokens=1200, json_mode=False):
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
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Ollama /api/chat returned an error: {details[:900]}")
    except urllib.error.URLError as error:
        raise ClientError(503, f"Ollama is offline or unreachable at {resolve_ollama_chat_endpoint(settings)}: {error.reason}")

    message = data.get("message") if isinstance(data, dict) else {}
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"].strip()
    if isinstance(data.get("response"), str):
        return data["response"].strip()
    return ""


def call_ai(settings, prompt, temperature=0.2, max_tokens=1800, json_mode=False):
    provider = resolve_ai_provider(settings)
    if provider == "cloud":
        return call_gemini(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)
    return call_gemma(settings, prompt, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode)


def analyze_with_gemma(payload):
    settings = load_settings()
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
        return {}


def clean_string_list(values, limit=24):
    if not isinstance(values, list):
        return []
    cleaned = []
    seen = set()
    for item in values:
        if isinstance(item, str):
            clean = clean_crossref_text(item)
            if clean and clean.lower() not in seen:
                seen.add(clean.lower())
                cleaned.append(clean)
                if len(cleaned) >= limit:
                    break
    return cleaned


def gemma_extraction_to_metadata(data):
    if not isinstance(data, dict):
        return {}
    metadata = {}
    doi = normalize_doi(data.get("doi"))
    if doi:
        metadata["doi"] = doi
    title = clean_crossref_text(data.get("title"))
    if title:
        metadata["title"] = title
    authors = [clean_author_name(a) for a in clean_string_list(data.get("authors"), limit=16) if clean_author_name(a)]
    if authors:
        metadata["authors"] = authors
    journal = clean_crossref_text(data.get("journal"))
    if journal:
        metadata["journal"] = journal
    abstract = clean_extracted_text(data.get("abstract"))
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


def ollama_embedding(settings, text):
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
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"Ollama /api/embeddings returned an error: {details[:900]}")
    except urllib.error.URLError as error:
        raise ClientError(503, f"Ollama embeddings are offline at {resolve_ollama_embeddings_endpoint(settings)}: {error.reason}")

    embedding = data.get("embedding") if isinstance(data, dict) else None
    if not isinstance(embedding, list) or not embedding:
        raise ClientError(502, "Ollama /api/embeddings returned no embedding vector.")
    return [float(value) for value in embedding]


def time_seconds():
    import time
    return time.time()


def time_sleep(seconds):
    import time
    time.sleep(seconds)


def time_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def html_escape(value):
    return html.escape(str(value or ""))


def cleanup_resources():
    global OLLAMA_PROCESS
    if OLLAMA_PROCESS and OLLAMA_PROCESS.poll() is None:
        try:
            OLLAMA_PROCESS.terminate()
            OLLAMA_PROCESS.wait(timeout=2)
        except Exception:
            try:
                OLLAMA_PROCESS.kill()
            except Exception:
                pass
        OLLAMA_PROCESS = None


def signal_handler(sig, frame):
    cleanup_resources()
    sys.exit(0)


try:
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
except (ValueError, AttributeError):
    pass

atexit.register(cleanup_resources)


def start_parent_watchdog():
    launcher_pid = os.getppid()
    if launcher_pid <= 1:
        return
    def _watch():
        import time
        while True:
            time.sleep(3)
            if os.getppid() != launcher_pid:
                cleanup_resources()
                os._exit(0)
    t = threading.Thread(target=_watch, name="pulse-parent-watchdog", daemon=True)
    t.start()


def main():
    global BOUND_PORT, SERVER_INSTANCE
    port = int(os.environ.get("PULSE_PORT") or os.environ.get("IRATXE_PORT") or "8000")

    server = None
    ports_to_try = [port]
    if port != 0:
        ports_to_try.extend([port + 1, port + 2, 8000, 8080, 8888, 0])

    tried = set()
    for p in ports_to_try:
        if p in tried:
            continue
        tried.add(p)
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), PulseHandler)
            break
        except OSError:
            continue

    if not server:
        server = ThreadingHTTPServer(("127.0.0.1", 0), PulseHandler)

    SERVER_INSTANCE = server
    BOUND_PORT = server.server_address[1]

    port_file = (os.environ.get("PULSE_PORT_FILE") or os.environ.get("IRATXE_PORT_FILE") or "").strip()
    if port_file:
        try:
            Path(port_file).write_text(str(BOUND_PORT), "utf-8")
        except Exception as e:
            print(f"Warning: could not write port file: {e}", file=sys.stderr)

    settings = load_settings()
    if resolve_ai_provider(settings) == "local":
        start_ollama_runtime_background()

    start_parent_watchdog()

    print(f"Serving Pulse on http://127.0.0.1:{BOUND_PORT}/index.html", flush=True)
    try:
        server.serve_forever()
    finally:
        cleanup_resources()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        cleanup_resources()
        sys.exit(0)


# Backward compatibility alias
IratxeHandler = PulseHandler
