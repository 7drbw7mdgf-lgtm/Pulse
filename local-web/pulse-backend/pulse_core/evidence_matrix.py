"""Compare-selected table: rule-based extraction of sentences from each paper (no AI model).

Every cell value is copied from the paper and kept only if its quote is found word for word in the
source text and the value appears in that quote. Extraction can still pick the wrong sentence, so the
interface labels cells as automatically extracted and shows the quote for checking.
"""
import collections
import copy
import concurrent.futures
import csv
import hashlib
import html
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
    """A cell is kept only if its quote is in the source and its value is in its quote."""
    not_stated = f"Not stated in the {source_type}"
    if not claim or not quote or not is_verbatim_quote(quote, source_text):
        return {"value": not_stated, "quote": "", "grounded": False}
    claim_core = normalize_for_matching(str(claim).rstrip("…").rstrip("."))
    if not claim_core or claim_core not in normalize_for_matching(quote):
        return {"value": not_stated, "quote": "", "grounded": False}
    return {"value": normalize_whitespace(claim), "quote": normalize_whitespace(quote), "grounded": True}


# Do not split after common abbreviations ("et al.", "var.", "e.g.") or initials followed by lower case ("C. jejuni").
_NO_SPLIT_AFTER = ["e.g.", "i.e.", " al.", "var.", " sp.", "spp.", "bsp.", " cf.", " vs.", "Fig.", " ca.", " no.", "approx."]
_SENTENCE_SPLIT = re.compile("".join(f"(?<!{re.escape(x)})" for x in _NO_SPLIT_AFTER) + r"(?<=[.!?])\s+(?=[A-Z0-9(\[])")
_SYSTEM_NOUNS = (r"patients|participants|volunteers|adults|children|infants|women|men|workers|students|households|cohorts?|"
                 r"mice|mouse|rats?|zebrafish|primates?|macaques|pigs|dogs|cattle|chickens|"
                 r"cells?|cell lines?|monocytes|macrophages|neurons|organoids|tissues?|biopsies|isolates|strains|cultures|"
                 r"soils?|sediments?|plants|seedlings|leaves|roots")
_BINOMIAL_GENUS = r"[A-Z][a-z]*(?:coccus|bacter|bacillus|bacterium|monas|myces|ella|ia|ium|us|um|a|es|is|opsis|phila)"
_BINOMIAL_EPITHET = r"[a-z]{3,}(?:us|um|a|ae|i|is|ii|e|ensis|ica|oides|er|ans|ens)"
_FINDING_CUES = re.compile(r"\b(?:we\s+(?:also\s+|further\s+|here\s+|now\s+)?(?:found|find|show|showed|shown|demonstrate[ds]?|observed?|report(?:ed)?|identified|reveal(?:ed)?|confirm(?:ed)?)|"
                           r"results?\s+(?:show|showed|indicate[ds]?|suggest(?:ed)?|reveal(?:ed)?|demonstrate[ds]?)|"
                           r"was\s+associated|were\s+associated|increased|decreased|reduced|improved|outperform(?:s|ed)?|"
                           r"significant(?:ly)?|p\s*[<=]\s*0?\.\d|\d+(?:\.\d+)?\s*%)", re.I)
_NOT_FINDING = re.compile(r"\b(?:to\s+(?:test|investigate|examine|determine|assess|explore|address|understand)|"
                          r"we\s+(?:hypothesi[sz]e|aimed|propose|describe|present|introduce)|hypothesis|aim(?:ed)?\s+(?:of|to)|"
                          r"objective|might|may\s+be|could\s+be|however,?\s+unlike|little\s+is\s+known|remains\s+unclear)\b", re.I)
_METHOD_CUES = re.compile(r"\b(?:we\s+(?:used|use|performed|applied|developed|measured|sequenced|analy[sz]ed|conducted|designed|trained|"
                          r"compared|isolated|constructed|generated|recruited|randomi[sz]ed|collected|implemented|modelled|modeled|simulated)|"
                          r"(?:was|were)\s+(?:measured|assessed|analy[sz]ed|performed|isolated|randomi[sz]ed|sequenced|recruited|evaluated|determined)|"
                          r"using|by\s+means\s+of|randomi[sz]ed|cross-sectional|cohort\s+study|meta-analysis|sequencing|assay|mass\s+spectrometry|"
                          r"microscopy|regression|simulation|algorithm|framework|survey|interviews?)\b", re.I)
_LIMIT_CUES = re.compile(r"\b(?:limitation|caveat|limited\s+by|small\s+sample|did\s+not\s+(?:assess|measure|include)|cannot\s+rule\s+out|"
                         r"further\s+(?:studies|research|work)\s+(?:is|are)\s+(?:needed|required)|observational\s+nature|may\s+not\s+generali[sz]e)\b", re.I)
_MAX_SENTENCE = 300
_TAXON_GENUS_SUFFIX = r"(?:coccus|bacter|bacillus|bacterium|monas|myces|ella|opsis|phila|plasma|vibrio|virus|ococcus|ensis)$"
# Common English words that happen to look like Latin genus/species names ("Data were", "Area under").
_ENGLISH_WORDS = {"data", "area", "media", "formula", "criteria", "phenomena", "were", "are", "here", "there", "where", "more", "some",
                  "these", "those", "whose", "become", "became", "same", "while", "since", "once", "further", "therefore", "thus",
                  "case", "type", "future", "nature", "culture", "measure", "response", "disease", "true", "sample", "time",
                  "include", "includes", "use", "uses", "made", "make", "rate", "state", "range", "base", "role", "scale", "value"}
_SYSTEM_STOPWORDS = {"the", "a", "an", "of", "in", "from", "and", "or", "with", "on", "these", "this", "our", "all", "both", "for", "to", "by",
                     "we", "were", "was", "at", "regarding", "about", "concerning", "among", "amongst", "between", "within", "into", "two", "three", "several", "many", "each", "most", "some",
                     "against", "allows", "allow", "using", "used", "including", "such", "as", "like", "than", "via", "per", "data", "is", "are", "be", "been", "that", "which", "whose"}


def _sentences(source_text):
    return [x.strip() for x in _SENTENCE_SPLIT.split(normalize_whitespace(source_text)) if len(x.strip()) >= 15]


def _sentence_value(sentence):
    return sentence if len(sentence) <= _MAX_SENTENCE else sentence[:_MAX_SENTENCE].rsplit(" ", 1)[0] + "…"


def heuristic_extract_column(column_id, source_text, source_type="abstract", title=""):
    """Rule-based extraction: every value is copied from a sentence of the paper; nothing is generated.
    When no rule fits, the cell says "Not stated" rather than guessing."""
    not_stated = f"Not stated in the {source_type}"
    if not source_text or not isinstance(source_text, str):
        return {"value": not_stated, "quote": "", "grounded": False}
    sentences = _sentences(source_text)
    if not sentences:
        return {"value": not_stated, "quote": "", "grounded": False}

    if column_id == "system":
        for s in sentences:  # Abbreviated binomial (S. aureus), expanded to the full name when the text has it
            m = re.search(r"\b([A-Z])\.\s?(" + _BINOMIAL_EPITHET + r")\b", s)
            if m:
                full = re.search(r"\b(" + m.group(1) + r"[a-z]{2,}\s" + m.group(2) + r")\b", source_text)
                if full:
                    host = next((x for x in sentences if full.group(1) in x), s)
                    return {"value": full.group(1), "quote": host, "grounded": True}
                return {"value": m.group(0), "quote": s, "grounded": True}
        context = (title or "") + " " + source_text
        for s in sentences:
            for m in re.finditer(r"\b(" + _BINOMIAL_GENUS + r"\s" + _BINOMIAL_EPITHET + r")\b", s):
                name = m.group(1)
                if re.match(r"(?:The|This|These|Those|Our|Here|In|We|It|Its|A|An)\s", name) or set(name.lower().split()) & _ENGLISH_WORDS:
                    continue
                # Two capitalised-then-lower-case words are often not a species ("Mahalanobis distance"):
                # require a clearly taxonomic genus ending, or the name repeated (title or text).
                if re.search(_TAXON_GENUS_SUFFIX, name.split()[0]) or context.count(name) >= 2:
                    return {"value": name, "quote": s, "grounded": True}
        for s in sentences:
            m = re.search(r"\b((?:[A-Za-z][\w-]+\s){0,2}(?:" + _SYSTEM_NOUNS + r"))\b", s, re.I)
            if m:
                words = m.group(1).split()
                cut = max((i + 1 for i, w in enumerate(words) if w.lower() in _SYSTEM_STOPWORDS), default=0)
                words = words[cut:]  # keep only the noun phrase after the last verb or preposition
                if len(words) > 2 and re.search(r"(?:ed|ing)$", words[0], re.I):
                    words = words[1:]  # "enrolled healthy adults" -> "healthy adults"; "infected mice" is kept
                if not words or not re.fullmatch(r"(?:" + _SYSTEM_NOUNS + r")", words[-1], re.I):
                    continue
                if words and words[-1].lower().startswith("strain") and len(words) > 1 and words[-2].lower() in {"small", "large", "high", "low", "shear", "tensile"}:
                    continue  # mechanical strain, not bacterial strains
                if words:
                    phrase = " ".join(words)
                    return {"value": phrase, "quote": s, "grounded": True}
        for s in sentences:
            m = re.search(r"\b([A-Z][\w-]{2,}\s(?:dataset|benchmark|corpus))\b", s)
            if m:
                return {"value": m.group(1), "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    if column_id == "method":
        for s in sentences:
            if _METHOD_CUES.search(s) and not _NOT_FINDING.search(s[:40]):
                return {"value": _sentence_value(s), "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    if column_id == "finding":
        # Conclusions sit at the end of an abstract; the first sentence is usually background.
        for s in reversed(sentences[1:] if len(sentences) > 1 else sentences):
            if _FINDING_CUES.search(s) and not _NOT_FINDING.search(s):
                return {"value": _sentence_value(s), "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    if column_id == "limitation":
        for s in sentences:
            if _LIMIT_CUES.search(s):
                return {"value": _sentence_value(s), "quote": s, "grounded": True}
        return {"value": not_stated, "quote": "", "grounded": False}

    # Custom column: the first sentence that mentions the column name
    for s in sentences:
        if str(column_id).lower() in s.lower():
            return {"value": _sentence_value(s), "quote": s, "grounded": True}
    return {"value": not_stated, "quote": "", "grounded": False}


def extract_paper_cell(column_def, paper, settings=None, cancel_event=None):
    if cancel_event and cancel_event.is_set():
        return {"value": "Cancelled", "quote": "", "grounded": False}

    col_id = column_def.get("id") or column_def.get("name")
    abstract = str(paper.get("abstract") or "").strip()
    full_text = str(paper.get("text") or "").strip()
    blocks = paper.get('evidencePassages') or []
    has_full_text = bool(blocks) or len(full_text) > max(1000, len(abstract) + 500)
    source_text = (full_text or '\n\n'.join(p.get('text','') for p in blocks)) if has_full_text else abstract
    source_type = "paper" if has_full_text else "abstract"

    if not source_text:
        return {"value": f"Not stated in the {source_type}", "quote": "", "grounded": False}

    # Deterministic grounded heuristic extraction
    if blocks:
        preferred = {'system':r'method|material|study|participant', 'method':r'method|material',
            'finding':r'result|conclu|discussion', 'limitation':r'limit|discussion'}
        eligible = [p for p in blocks if not re.search(r'references|bibliography|acknowledg', p.get('section',''), re.I)]
        eligible.sort(key=lambda p: not bool(re.search(preferred.get(col_id, r'^$'),p.get('section',''),re.I)))
        for block in eligible:
            raw = heuristic_extract_column(col_id, block['text'], source_type='paper', title=str(paper.get('title') or ''))
            cell = verify_grounded_cell(raw.get('value'),raw.get('quote'),block['text'],source_type='paper')
            if cell['grounded']:
                cell['provenance'] = {key:block.get(key) for key in ('section','page','anchor','url','source') if block.get(key)}
                cell['passage'] = context_excerpt(block['text'],cell['quote'])
                return cell
        return {'value':'Not stated in the paper','quote':'','grounded':False}
    raw = heuristic_extract_column(col_id, source_text, source_type=source_type, title=str(paper.get("title") or ""))
    cell = verify_grounded_cell(raw.get("value"), raw.get("quote"), source_text, source_type=source_type)
    if cell['grounded']: cell.update(provenance={'source':'Abstract' if source_type=='abstract' else 'Local imported text'},passage=context_excerpt(source_text,cell['quote']))
    return cell


def context_excerpt(text,quote):
    normalized=normalize_whitespace(text)
    index=normalized.find(quote)
    start=max(0,index-1500) if index>=0 else 0
    return normalized[start:start+max(6000,len(quote)+3000)]


def build_evidence_row(paper, columns, settings=None, cancel_event=None):
    paper_id = str(paper.get("id") or paper.get("doi") or paper.get("title") or "")
    abstract = str(paper.get("abstract") or "")
    text = str(paper.get("text") or "")
    text_hash = hashlib.sha256(json.dumps([abstract,text,paper.get('title'),paper.get('evidencePassages'),paper.get('evidenceWarning')],sort_keys=True).encode()).hexdigest()
    col_ids = [c.get("id") or c.get("name") for c in columns]
    cache_key = f"{paper_id}:{text_hash}:{','.join(col_ids)}"

    with _CACHE_LOCK:
        if cache_key in _MATRIX_CACHE:
            return copy.deepcopy(_MATRIX_CACHE[cache_key])

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
        "sourceType": "paper" if paper.get('evidencePassages') or len(text) > max(1000, len(abstract) + 500) else "abstract",
        "source":paper.get('evidenceSource') or '', 'warning':paper.get('evidenceWarning') or '',
        "cells": cells,
    }

    with _CACHE_LOCK:
        _MATRIX_CACHE[cache_key] = copy.deepcopy(row)
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
        return {"rows": [], "columns": columns, "provider": "Automatic sentence extraction (no AI)", "error": "Select 2 to 15 papers to compare."}

    provider_name = "Automatic sentence extraction (no AI)"

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


def _csv_safe(value):
    """Stop spreadsheet apps from running a cell as a formula (CSV injection)."""
    text = str(value if value is not None else "")
    return "'" + text if text[:1] in ("\t","\r") or text.lstrip()[:1] in ("=", "+", "-", "@") else text


def export_matrix_csv(matrix):
    output = io.StringIO()
    writer = csv.writer(output)
    cols = matrix.get("columns") or DEFAULT_COLUMNS
    header = ["Paper", "Meta", "DOI"] + [c.get("name") or c.get("id") for c in cols]
    for c in cols: header.extend([str(c.get('name') or c.get('id'))+' quote',str(c.get('name') or c.get('id'))+' source'])
    writer.writerow([_csv_safe(h) for h in header])
    for r in matrix.get("rows") or []:
        row_vals = [r.get("title"), r.get("meta"), r.get("doi")]
        for c in cols:
            cid = c.get("id") or c.get("name")
            cell = (r.get("cells") or {}).get(cid, {})
            row_vals.append(cell.get("value", ""))
        for c in cols:
            cell=(r.get('cells') or {}).get(c.get('id') or c.get('name'),{})
            row_vals.extend([cell.get('quote',''),json.dumps(cell.get('provenance') or {},ensure_ascii=False)])
        writer.writerow([_csv_safe(v) for v in row_vals])
    return output.getvalue()


def export_matrix_markdown(matrix):
    def clean(value):return html.escape(normalize_whitespace(value),quote=False).replace('|','\\|')
    cols = matrix.get("columns") or DEFAULT_COLUMNS
    headers = ["Paper", "Meta"] + [clean(c.get("name") or c.get("id")) for c in cols]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for r in matrix.get("rows") or []:
        row_vals = [
            clean(r.get("title") or ""),
            clean(r.get("meta") or ""),
        ]
        for c in cols:
            cid = c.get("id") or c.get("name")
            cell = (r.get("cells") or {}).get(cid, {})
            val = clean(cell.get("value") or "")
            row_vals.append(val)
        lines.append("| " + " | ".join(row_vals) + " |")
    lines.extend(['','Supporting quotations and provenance (automatically extracted; check context):',''])
    for r in matrix.get('rows') or []:
        for c in cols:
            cell=(r.get('cells') or {}).get(c.get('id') or c.get('name'),{})
            if cell.get('quote'):
                lines.extend([clean(r.get('title'))+' · '+clean(c.get('name') or c.get('id')),
                    '> '+clean(cell['quote']),clean(json.dumps(cell.get('provenance') or {},ensure_ascii=False)),''])
    return "\n".join(lines) + "\n"
