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


def extract_document(raw, name):
    """Extract PDF text, document metadata, XMP identifiers and link targets."""
    if not ((name or '').lower().endswith('.pdf') or raw.startswith(b'%PDF-')):
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('latin-1', errors='ignore')
        return {'text': clean_extracted_text(text), 'metadata': {}, 'doiText': text, 'extractionSource': 'text'}
    try:
        import pymupdf as fitz
    except ImportError:
        text = clean_extracted_text('\n'.join(decode_pdf_streams(raw)))
        return {'text': text, 'metadata': {}, 'doiText': text, 'extractionSource': 'PDF stream fallback'}
    with fitz.open(stream=raw, filetype='pdf') as doc:
        if doc.needs_pass:
            raise ValueError('This PDF is password protected. Import an unlocked copy.')
        metadata = {}
        info = doc.metadata or {}
        title = (info.get('title') or '').strip()
        if len(title) >= 12 and not re.match(r'^(?:untitled|microsoft word|document\d*)\b', title, re.I):
            metadata['title'] = title
        author = (info.get('author') or '').strip()
        if author and not re.search(r'^(?:unknown|administrator|user|author|microsoft|acrobat|elsevier|springer)$', author, re.I):
            metadata['authors'] = [part.strip() for part in re.split(r';|\s+and\s+', author) if part.strip()]
        if info.get('keywords'):
            metadata['keywords'] = info['keywords']
        chunks = []
        identifiers = []
        try:
            identifiers.append(doc.get_xml_metadata() or '')
        except Exception:
            pass
        identifiers += [info.get(key) or '' for key in ('subject', 'keywords', 'title')]
        for index, page in enumerate(doc):
            if index >= 80:
                break
            chunks.append(page.get_text('text', sort=True))
            if index < 3:
                identifiers += [link.get('uri') or '' for link in page.get_links()]
            if index == 0 and not metadata.get('title'):
                lines = []
                for block in page.get_text('dict').get('blocks') or []:
                    for line in block.get('lines') or []:
                        spans = line.get('spans') or []
                        value = ' '.join(span.get('text') or '' for span in spans).strip()
                        if len(value) >= 12 and len(value.split()) >= 3 and not re.match(r'^(?:doi|https?|copyright|journal|volume|issn|references|abstract)\b', value, re.I):
                            lines.append((max((span.get('size', 0) for span in spans), default=0), value))
                if lines:
                    largest = max(size for size, _ in lines)
                    title_lines = [value for size, value in lines if size >= largest - .3]
                    candidate = ' '.join(title_lines)
                    if len(candidate) <= 350:
                        metadata['title'] = candidate
        text = clean_extracted_text('\n'.join(chunks))[:350000]
        # Readable page text and structured identifiers precede binary scanning.
        return {'text': text, 'metadata': metadata, 'doiText': '\n'.join(identifiers),
                'extractionSource': 'PyMuPDF', 'pageCount': len(doc), 'textAvailable': bool(text)}


def extract_text_from_upload(raw, name):
    return extract_document(raw, name)['text']
