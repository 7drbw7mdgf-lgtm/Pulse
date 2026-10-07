"""Uploaded text extraction and verified metadata enrichment."""
from __future__ import annotations
from typing import List
from .types import JSONDict, Library, Metadata, MetadataResult, Paper
import base64
import re
import urllib.request
import urllib.error
import urllib.parse
import logging

logger = logging.getLogger(__name__)
from .context import get_context, ClientError, LOCAL_BACKEND_DEFAULTS
from . import ai as ai_service
from . import metadata as metadata_service
from . import providers as providers_service
from . import storage as storage_service


def extract_text_from_upload(raw, name):
    lower_name = str(name or "").lower()
    is_pdf = lower_name.endswith(".pdf") or raw.startswith(b"%PDF")
    if is_pdf:
        try:
            import fitz  # PyMuPDF, optional bundled dependency.
            with fitz.open(stream=raw, filetype="pdf") as document:
                text = "\n\n".join(page.get_text("text") for page in document)
            text = metadata_service.clean_extracted_text(text)
            if metadata_service.readable_text_score(text) > 0.20:
                return text[:240000], "PyMuPDF"
        except (ImportError, OSError, RuntimeError, ValueError):
            logger.debug('extract_text_from_upload: recovering from expected failure')
            pass

        try:
            import io
            import pdfplumber  # optional bundled dependency.
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                text = "\n\n".join((page.extract_text() or "") for page in pdf.pages)
            text = metadata_service.clean_extracted_text(text)
            if metadata_service.readable_text_score(text) > 0.20:
                return text[:240000], "pdfplumber"
        except (ImportError, OSError, RuntimeError, ValueError):
            logger.debug('extract_text_from_upload: recovering from expected failure')
            pass

        stream_text = metadata_service.clean_extracted_text("\n".join(metadata_service.decode_pdf_streams(raw[:8_000_000])))
        if metadata_service.readable_text_score(stream_text) > 0.22:
            return stream_text[:160000], "PDF stream fallback"
        return "", "PDF extraction unavailable"

    for encoding in ("utf-8", "latin-1", "utf-16"):
        try:
            text = metadata_service.clean_extracted_text(raw.decode(encoding, errors="ignore"))
            if metadata_service.readable_text_score(text) > 0.20:
                return text[:240000], encoding
        except LookupError:
            logger.debug('extract_text_from_upload: recovering from expected failure')
            continue
    return "", "text extraction unavailable"


def title_from_text_or_name(text, name):
    raw_text = str(text or "")
    lines = [metadata_service.clean_crossref_text(line) for line in raw_text.splitlines()]
    if len([line for line in lines if line]) <= 1:
        flattened = metadata_service.clean_crossref_text(raw_text)
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
            filename_overlap = metadata_service.title_overlap_score(filename_title, candidate)
            position_bonus = max(0.0, 3.4 - index * 0.09)
            length_bonus = min(len(words), 18) * 0.15
            punctuation_penalty = 1.5 if candidate.count(";") >= 2 else 0
            author_line_penalty = 12 if candidate.count(",") >= 2 and re.search(r"\b(?:and|et al\.?|\*)\b", candidate, re.I) else 0
            candidates.append((filename_overlap * 9 + position_bonus + length_bonus - punctuation_penalty - author_line_penalty, candidate))
    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return filename_title


def lookup_metadata_by_title(text, name):
    title = title_from_text_or_name(text, name)
    if len(title) < 18:
        raise ClientError(404, "No reliable title text was available for metadata lookup.")

    errors = []
    candidates = []
    query = urllib.parse.urlencode({"query.title": title, "rows": 5})
    try:
        data = providers_service.fetch_json(f"https://api.crossref.org/works?{query}")
        for item in (data.get("message") or {}).get("items") or []:
            metadata = metadata_service.crossref_to_metadata(item)
            if metadata.get("doi"):
                candidates.append(("Crossref title search", metadata))
    except ClientError as error:
        logger.warning('lookup_metadata_by_title: recovering from expected failure (%s)', type(error).__name__)
        errors.append(str(error))

    params = urllib.parse.urlencode({"search": title, "per-page": 5})
    try:
        data = providers_service.fetch_json(f"https://api.openalex.org/works?{params}")
        for item in data.get("results") or []:
            metadata = metadata_service.openalex_to_metadata(item)
            if metadata.get("doi"):
                candidates.append(("OpenAlex title search", metadata))
    except ClientError as error:
        logger.warning('lookup_metadata_by_title: recovering from expected failure (%s)', type(error).__name__)
        errors.append(str(error))

    ranked = []
    for source, metadata in candidates:
        overlap = metadata_service.title_overlap_score(title, metadata.get("title") or "")
        score = metadata_service.metadata_completeness_score(metadata) + overlap * 10
        candidate_title = metadata.get("title") or ""
        if overlap >= 0.55 or title.lower() in candidate_title.lower() or candidate_title.lower() in title.lower():
            ranked.append((score, source, metadata))

    if not ranked:
        raise ClientError(404, "No DOI-bearing title match found. " + " ".join(errors[:2]))

    _, source, metadata = sorted(ranked, key=lambda item: item[0], reverse=True)[0]
    return {"ok": True, "doi": metadata.get("doi") or "", "source": source, "metadata": metadata}


def _scan_file_for_metadata_local(payload: JSONDict):
    name = str(payload.get("name") or "paper")
    content = payload.get("contentBase64") or ""
    if not content:
        raise ClientError(400, "No file content was provided for DOI scanning.")
    try:
        raw = base64.b64decode(content, validate=False)
    except (ValueError, TypeError) as error:
        logger.warning('_scan_file_for_metadata_local: recovering from expected failure (%s)', type(error).__name__)
        raise ClientError(400, f"Could not decode file content: {error}")

    extracted_text, extraction_source = extract_text_from_upload(raw, name)
    expected_title = title_from_text_or_name(extracted_text, name)
    candidates = metadata_service.dedupe_strings([
        *metadata_service.ranked_doi_candidates(extracted_text),
        *metadata_service.scan_doi_candidates_from_bytes(raw),
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
            logger.warning('_scan_file_for_metadata_local: recovering from expected failure (%s)', type(error).__name__)
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
            result = providers_service.lookup_doi_metadata({"doi": doi, "expectedTitle": expected_title})
            score = metadata_service.metadata_completeness_score(result.get("metadata") or {})
            if score > best_score:
                best = result
                best_score = score
            if metadata_service.metadata_is_filled(result.get("metadata") or {}):
                break
        except ClientError as error:
            logger.warning('_scan_file_for_metadata_local: recovering from expected failure (%s)', type(error).__name__)
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
        fallback["candidates"] = metadata_service.dedupe_strings([fallback.get("doi") or "", *candidates[:12]])
        return fallback
    except ClientError as error:
        logger.warning('_scan_file_for_metadata_local: recovering from expected failure (%s)', type(error).__name__)
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


def scan_file_for_metadata(payload: JSONDict):
    result = _scan_file_for_metadata_local(payload)
    settings = storage_service.load_settings()
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
        logger.warning('scan_file_for_metadata: recovering from expected failure (%s)', type(error).__name__)
        result["gemmaProcessed"] = False
        result["gemmaError"] = str(error)
        return result

    gemma_metadata = dict(gemma.get("metadata") or {})
    for key in ("keyFindings", "organisms", "techniques", "discoveryTerms"):
        if gemma.get(key):
            gemma_metadata[key] = gemma.get(key)
    merged = metadata_service.merge_verified_doi_metadata(gemma_metadata, existing) if result.get("doi") else metadata_service.merge_metadata(gemma_metadata, existing)
    result["metadata"] = merged
    result["doi"] = merged.get("doi") or result.get("doi") or gemma.get("doi") or ""
    result["candidates"] = metadata_service.dedupe_strings([
        result.get("doi") or "",
        *(gemma.get("candidates") or []),
        *(result.get("candidates") or []),
    ])[:12]
    result["found"] = bool(result.get("doi") or merged.get("title") or merged.get("paperKeywords"))
    source_parts = []
    for value in (result.get("source") or "", gemma.get("source") or "Local Gemma extraction"):
        source_parts.extend(part.strip() for part in value.split(" + ") if part.strip())
    result["source"] = " + ".join(metadata_service.dedupe_strings(source_parts))
    result["scanSource"] = "pdf-text-local-parser-gemma-doi-validation"
    result["gemmaProcessed"] = True
    result["gemma"] = gemma
    return result


def model_paper_excerpt(text, max_chars=32000):
    full_text = metadata_service.clean_extracted_text(text)
    if not full_text:
        return ""

    sections = ai_service.detect_sections(full_text)
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
        clean = metadata_service.clean_extracted_text(value)
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


def extract_metadata_with_gemma(payload: JSONDict):
    settings = storage_service.load_settings()
    ai_service.require_ai_model(settings, "chat")
    model = ai_service.resolve_cloud_model(settings) if ai_service.resolve_ai_provider(settings) == "cloud" else ai_service.resolve_gemma_model(settings)

    name = metadata_service.clean_crossref_text(payload.get("name") or "paper")
    title = metadata_service.clean_crossref_text(payload.get("title") or "")
    abstract = metadata_service.clean_crossref_text(payload.get("abstract") or "")
    keywords = metadata_service.dedupe_strings(payload.get("keywords") or [])[:24]
    doi_candidates = metadata_service.dedupe_strings([metadata_service.normalize_doi(value) for value in payload.get("doiCandidates") or [] if metadata_service.normalize_doi(value)])[:12]
    text = metadata_service.clean_extracted_text(payload.get("text") or "")
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

    text_response = ai_service.call_ai(settings, instruction, temperature=0.0, max_tokens=2200, json_mode=True)
    extracted = ai_service.parse_json_object(text_response)
    metadata = ai_service.gemma_extraction_to_metadata(extracted)
    all_dois = metadata_service.dedupe_strings([
        metadata.get("doi") or "",
        *metadata.get("doiCandidates", []),
        *doi_candidates,
    ])
    doi_metadata = {}
    doi_source = ""
    doi = ""
    for candidate in all_dois[:12]:
        try:
            result = providers_service.lookup_doi_metadata({"doi": candidate, "expectedTitle": metadata.get("title") or title})
            doi = result.get("doi") or candidate
            doi_metadata = result.get("metadata") or {}
            doi_source = result.get("source") or "DOI"
            break
        except ClientError:
            logger.warning('extract_metadata_with_gemma: recovering from expected failure')
            continue
    if doi_metadata:
        metadata = metadata_service.merge_verified_doi_metadata(metadata, doi_metadata)
        metadata["doi"] = doi
    else:
        # Nothing verified (offline or no match): keep a DOI only if it is
        # printed in the paper itself, never one the model produced on its own.
        in_text = {value.lower() for value in [*metadata_service.ranked_doi_candidates(payload.get("text") or ""), *doi_candidates]}
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
        "organisms": ai_service.clean_string_list(extracted.get("organisms") or [], limit=16),
        "techniques": ai_service.clean_string_list(extracted.get("techniques") or [], limit=16),
        "discoveryTerms": ai_service.clean_string_list(extracted.get("discoveryTerms") or [], limit=24),
        "confidence": extracted.get("confidence", ""),
    }
