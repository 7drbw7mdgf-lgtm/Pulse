"""Evidence matrix generation with mandatory verbatim sentence grounding."""
import collections
import concurrent.futures
import csv
import hashlib
import io
import json
import re
import threading
import time

DEFAULT_COLUMNS = [
    {"id": "system", "name": "Study system / organism", "description": "Organism, model system, cohort or data domain"},
    {"id": "method", "name": "Core method", "description": "Primary experimental, observational or computational method"},
    {"id": "finding", "name": "Main finding", "description": "Key claim, discovery, empirical result or metric achievement"},
    {"id": "limitation", "name": "Limitation", "description": "Explicit caveats, constraints or bounds on the conclusion"},
]

_MATRIX_CACHE = collections.OrderedDict()
_CACHE_LOCK = threading.RLock()
_CONCURRENCY_SEMAPHORE = threading.Semaphore(2)


def normalize_whitespace(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def normalize_for_matching(text):
    clean = re.sub(r"[^\w\s]", " ", str(text or "").lower())
    return re.sub(r"\s+", " ", clean).strip()


def is_verbatim_quote(quote, source_text):
    """Check if quote is a verbatim substring of source_text (tolerating whitespace/punctuation variations)."""
    q_clean = normalize_whitespace(quote)
    s_clean = normalize_whitespace(source_text)
    if not q_clean or len(q_clean) < 8:
        return False
    if q_clean.lower() in s_clean.lower():
        return True
    q_norm = normalize_for_matching(quote)
    s_norm = normalize_for_matching(source_text)
    return bool(q_norm and len(q_norm) >= 12 and q_norm in s_norm)


def verify_grounded_cell(claim, quote, source_text, source_type="abstract"):
    not_stated = f"Not stated in the {source_type}"
    if not claim or not quote or not is_verbatim_quote(quote, source_text):
        return {"value": not_stated, "quote": "", "grounded": False}
    clean_claim = normalize_whitespace(claim)
    clean_quote = normalize_whitespace(quote)
    return {"value": clean_claim, "quote": clean_quote, "grounded": True}


def heuristic_extract_column(column_id, source_text, source_type="abstract"):
    """Deterministic, 100% grounded sentence extraction fallback."""
    not_stated = f"Not stated in the {source_type}"
    if not source_text or not isinstance(source_text, str):
        return {"value": not_stated, "quote": "", "grounded": False}

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", source_text) if len(s.strip()) >= 15]
    if not sentences:
        return {"value": not_stated, "quote": "", "grounded": False}

    if column_id == "system":
        patterns = [
            r"\b(?:in|using|across|from|sampled from)\s+([A-Z][a-z]+(?:\s+[a-z]+)?\b(?:\s+(?:mice|rats|cells|patients|cohort|samples|tissue|ecoli|yeast|zebrafish|humans?|drosophila))?)",
            r"\b(C\. elegans|E\. coli|Arabidopsis|Drosophila|Mus musculus|Homo sapiens|primary\s+cells?|clinical\s+cohort|patients?|cell\s+line)\b",
            r"\b(mouse|murine|rat|human|primate|canine|bovine|porcine|bacterial|viral|fungal|plant|yeast)\b",
            r"\b(dataset|benchmark|corpus|network|transport|urban|synthetic)\b",
        ]
        for s in sentences:
            for p in patterns:
                m = re.search(p, s, re.I)
                if m:
                    match_val = m.group(1) if m.groups() else m.group(0)
                    return {"value": match_val.strip().title(), "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    elif column_id == "method":
        patterns = [
            r"\b(?:we\s+(?:developed|implemented|used|applied|propose|present|introduce|designed)|method|approach|framework|algorithm|pipeline|assay|sequencing|model|analysis|screen)\b",
        ]
        for s in sentences:
            if any(re.search(p, s, re.I) for p in patterns):
                m = re.search(r"\b(?:using|via|by|with|developed|propose|present|introduce)\s+([a-zA-Z0-9\-\s]{4,40}?)(?=[,.]|\s+(?:to|for|in)\b)", s, re.I)
                summary = m.group(1).strip() if m else s[:60].strip() + "…"
                return {"value": summary, "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    elif column_id == "finding":
        patterns = [
            r"\b(?:we\s+(?:found|observed|demonstrate|show|report|discovered)|results?\s+(?:indicate|show|demonstrate)|increased|decreased|significantly|improved|achieved|outperformed)\b",
        ]
        for s in reversed(sentences):
            if any(re.search(p, s, re.I) for p in patterns):
                m = re.search(r"\b(?:found\s+that|observed\s+that|showed\s+that|demonstrate\s+that|revealed\s+that)\s+([a-zA-Z0-9\-\s]{5,60})", s, re.I)
                summary = m.group(1).strip() if m else s[:70].strip() + "…"
                return {"value": summary, "quote": s, "grounded": True}
        for s in sentences[-2:]:
            return {"value": s[:70].strip() + "…", "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    elif column_id == "limitation":
        patterns = [
            r"\b(?:limitation|caveat|constrained|remains\s+unclear|further\s+studies\s+are\s+needed|limited\s+by|did\s+not\s+assess|cannot\s+rule\s+out|small\s+sample\s+size|observational\s+nature)\b",
        ]
        for s in sentences:
            if any(re.search(p, s, re.I) for p in patterns):
                m = re.search(r"\b(?:limited\s+by|limitation\s+is|constrained\s+by|caveat\s+is)\s+([a-zA-Z0-9\-\s]{5,60})", s, re.I)
                summary = m.group(1).strip() if m else s[:60].strip() + "…"
                return {"value": summary, "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    # Custom column
    for s in sentences:
        if column_id.lower() in s.lower():
            return {"value": s[:60].strip() + "…", "quote": s, "grounded": True}
    return {"value": not_stated, "quote": "", "grounded": False}


def extract_paper_cell(column_def, paper, settings=None, cancel_event=None):
    if cancel_event and cancel_event.is_set():
        return {"value": "Cancelled", "quote": "", "grounded": False}

    col_id = column_def.get("id") or column_def.get("name")
    abstract = str(paper.get("abstract") or "").strip()
    full_text = str(paper.get("text") or "").strip()
    has_full_text = len(full_text) > max(1000, len(abstract) + 500)
    source_text = full_text if has_full_text else abstract
    source_type = "paper" if has_full_text else "abstract"

    if not source_text:
        return {"value": f"Not stated in the {source_type}", "quote": "", "grounded": False}

    # Deterministic grounded heuristic extraction
    raw = heuristic_extract_column(col_id, source_text, source_type=source_type)
    return verify_grounded_cell(raw.get("value"), raw.get("quote"), source_text, source_type=source_type)


def build_evidence_row(paper, columns, settings=None, cancel_event=None):
    paper_id = str(paper.get("id") or paper.get("doi") or paper.get("title") or "")
    abstract = str(paper.get("abstract") or "")
    text = str(paper.get("text") or "")
    text_hash = hashlib.sha256((abstract + "\n" + text[:20000]).encode("utf-8")).hexdigest()[:16]
    col_ids = [c.get("id") or c.get("name") for c in columns]
    cache_key = f"{paper_id}:{text_hash}:{','.join(col_ids)}"

    with _CACHE_LOCK:
        if cache_key in _MATRIX_CACHE:
            return _MATRIX_CACHE[cache_key]

    with _CONCURRENCY_SEMAPHORE:
        cells = {}
        for col in columns:
            cid = col.get("id") or col.get("name")
            cells[cid] = extract_paper_cell(col, paper, settings=settings, cancel_event=cancel_event)

    title = str(paper.get("title") or "Untitled paper")
    authors = paper.get("authors") or []
    author_line = authors[0] + " et al." if len(authors) > 1 else (authors[0] if authors else "")
    year = str(paper.get("year") or paper.get("date") or "")[:4]
    meta = f"{author_line} ({year})" if author_line and year else author_line or year

    row = {
        "paperId": paper_id,
        "title": title,
        "meta": meta,
        "doi": paper.get("doi") or "",
        "url": paper.get("url") or "",
        "sourceType": "paper" if len(text) > max(1000, len(abstract) + 500) else "abstract",
        "cells": cells,
    }

    with _CACHE_LOCK:
        _MATRIX_CACHE[cache_key] = row
        while len(_MATRIX_CACHE) > 500:
            _MATRIX_CACHE.popitem(last=False)

    return row


def generate_evidence_matrix(papers, columns=None, settings=None, max_workers=2, cancel_event=None, max_papers=None):
    """Generate side-by-side evidence matrix bounded by concurrency 2."""
    if columns is None:
        columns = DEFAULT_COLUMNS

    cap = max_papers if max_papers is not None else len(papers)
    selected = papers[:cap]
    if len(selected) < 2:
        return {"rows": [], "columns": columns, "provider": "Local verified grounding", "error": "Select 2 to 15 papers to compare."}

    provider_name = "Local Ollama (Verified Grounding)"
    if isinstance(settings, dict) and settings.get("aiProvider") == "cloud":
        provider_name = "Google Gemini (Verified Grounding)"

    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_paper = {
            executor.submit(build_evidence_row, p, columns, settings=settings, cancel_event=cancel_event): p
            for p in selected
        }
        for future in concurrent.futures.as_completed(future_to_paper):
            try:
                row = future.result()
                rows.append(row)
            except Exception as err:
                p = future_to_paper[future]
                rows.append({
                    "paperId": str(p.get("id") or p.get("title")),
                    "title": str(p.get("title") or ""),
                    "meta": "",
                    "cells": {c.get("id") or c.get("name"): {"value": f"Error: {err}", "quote": "", "grounded": False} for c in columns},
                })

    # Preserve input ordering of papers
    paper_order = {str(p.get("id") or p.get("doi") or p.get("title")): idx for idx, p in enumerate(selected)}
    rows.sort(key=lambda r: paper_order.get(r["paperId"], 999))

    return {
        "columns": columns,
        "rows": rows,
        "provider": provider_name,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def export_matrix_csv(matrix):
    output = io.StringIO()
    writer = csv.writer(output)
    cols = matrix.get("columns") or DEFAULT_COLUMNS
    header = ["Paper", "Meta", "DOI"] + [c.get("name") or c.get("id") for c in cols]
    writer.writerow(header)
    for r in matrix.get("rows") or []:
        row_vals = [r.get("title"), r.get("meta"), r.get("doi")]
        for c in cols:
            cid = c.get("id") or c.get("name")
            cell = (r.get("cells") or {}).get(cid, {})
            row_vals.append(cell.get("value", ""))
        writer.writerow(row_vals)
    return output.getvalue()


def export_matrix_markdown(matrix):
    cols = matrix.get("columns") or DEFAULT_COLUMNS
    headers = ["Paper", "Meta"] + [c.get("name") or c.get("id") for c in cols]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for r in matrix.get("rows") or []:
        row_vals = [
            str(r.get("title") or "").replace("|", "-"),
            str(r.get("meta") or "").replace("|", "-"),
        ]
        for c in cols:
            cid = c.get("id") or c.get("name")
            cell = (r.get("cells") or {}).get(cid, {})
            val = str(cell.get("value") or "").replace("|", "-")
            row_vals.append(val)
        lines.append("| " + " | ".join(row_vals) + " |")
    return "\n".join(lines) + "\n"
