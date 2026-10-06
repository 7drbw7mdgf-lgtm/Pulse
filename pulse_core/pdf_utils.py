import re
from pulse_core.security import decode_pdf_streams

def readable_text_score(text):
    if not text:
        return 0
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return 0
    alnum = sum(1 for ch in clean if ch.isalnum() or ch.isspace())
    ratio = alnum / max(1, len(clean))
    words = clean.split()
    avg_len = sum(len(w) for w in words) / max(1, len(words))
    score = ratio * min(1.0, len(clean) / 400.0)
    if 2.5 <= avg_len <= 10.0:
        score += 0.2
    return round(score, 3)

def clean_extracted_text(value):
    lines = [re.sub(r"\s+", " ", line).strip() for line in (value or "").splitlines()]
    clean = "\n".join(line for line in lines if line)
    return clean.strip()

def extract_text_from_upload(raw, name):
    lower_name = (name or "").lower()
    if lower_name.endswith(".txt") or lower_name.endswith(".md"):
        try:
            return clean_extracted_text(raw.decode("utf-8"))
        except UnicodeDecodeError:
            return clean_extracted_text(raw.decode("latin-1", errors="ignore"))
    if lower_name.endswith(".pdf") or raw.startswith(b"%PDF-"):
        streams = decode_pdf_streams(raw)
        text = "\n".join(streams)
        return clean_extracted_text(text)
    try:
        return clean_extracted_text(raw.decode("utf-8"))
    except UnicodeDecodeError:
        return clean_extracted_text(raw.decode("latin-1", errors="ignore"))
