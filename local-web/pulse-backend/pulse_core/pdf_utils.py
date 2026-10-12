import re
import time
import math
from pathlib import Path
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


def ordered_page_text(page,textpage=None):
    """Read each column vertically, respecting full-width headings and captions."""
    import pymupdf as fitz
    flags=fitz.TEXTFLAGS_DICT&~fitz.TEXT_PRESERVE_IMAGES
    data=page.get_text('dict',textpage=textpage,flags=flags) if textpage is not None else page.get_text('dict',flags=flags)
    lines=[]
    for block in data.get('blocks') or []:
        for line in block.get('lines') or []:
            value=' '.join(span.get('text') or '' for span in line.get('spans') or []).strip()
            box=line.get('bbox') or block.get('bbox')
            if value and box:lines.append((tuple(box),value))
    width=float(page.rect.width)
    left=[row for row in lines if row[0][2]<width*.52]
    right=[row for row in lines if row[0][0]>width*.45]
    if len(left)<3 or len(right)<3:
        return page.get_text('text',sort=True,textpage=textpage) if textpage is not None else page.get_text('text',sort=True),False
    spanning=sorted([row for row in lines if row[0][0]<width*.5<row[0][2]],key=lambda row:row[0][1])
    ordered=[];remaining=[row for row in lines if row not in spanning]
    def column_band(rows):
        return sorted(rows,key=lambda row:(row[0][0]>=width*.5,row[0][1],row[0][0]))
    for heading in spanning:
        above=[row for row in remaining if row[0][1]<heading[0][1]]
        ordered.extend(column_band(above));ordered.append(heading)
        remaining=[row for row in remaining if row not in above]
    ordered.extend(column_band(remaining))
    return '\n'.join(value for _,value in ordered),True


def local_ocr(page):
    data=Path(__file__).resolve().parent.parent/'ocr-data'
    if not (data/'eng.traineddata').is_file():raise RuntimeError('Local OCR language data unavailable')
    area=float(page.rect.width)*float(page.rect.height)
    if not math.isfinite(area) or area<=0 or area>20_000_000:raise ValueError('Page geometry exceeds the local OCR rendering budget')
    dpi=min(150,max(72,int(72*math.sqrt(20_000_000/area))))
    return page.get_textpage_ocr(language='eng',dpi=dpi,full=True,tessdata=str(data))

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
        warnings=[];ocr_pages=[];layout_pages=[];started=time.monotonic()
        try:
            identifiers.append(doc.get_xml_metadata() or '')
        except Exception:
            pass
        identifiers += [info.get(key) or '' for key in ('subject', 'keywords', 'title')]
        page_indices=list(range(len(doc))) if len(doc)<=80 else list(range(72))+list(range(max(72,len(doc)-8),len(doc)))
        if len(doc)>80:warnings.append('Text extraction includes the first 72 and final 8 pages; intermediate pages are omitted.')
        for index in page_indices:
            page=doc[index]
            native,columns=ordered_page_text(page)
            if readable_text_score(native)<.35 and (page.get_images() or len(page.get_drawings())>20):
                if len(ocr_pages)<8 and time.monotonic()-started<16:
                    try:
                        textpage=local_ocr(page)
                        native,columns=ordered_page_text(page,textpage)
                        ocr_pages.append(index+1)
                    except Exception:warnings.append(f'Page {index+1} could not be read with local OCR; verify its references manually.')
                else:warnings.append(f'Page {index+1} needs OCR beyond the extraction budget; verify its references manually.')
            chunks.append(native)
            if columns:layout_pages.append(index+1)
            if index < 3:
                identifiers += [link.get('uri') or '' for link in page.get_links()]
            if index == 0 and not metadata.get('title'):
                lines = []
                for block in page.get_text('dict',flags=fitz.TEXTFLAGS_DICT&~fitz.TEXT_PRESERVE_IMAGES).get('blocks') or []:
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
                'extractionSource': 'PyMuPDF + local OCR' if ocr_pages else 'PyMuPDF', 'pageCount': len(doc), 'textAvailable': bool(text),
                'bibliographyProvenance':{'layoutPages':layout_pages,'ocrPages':ocr_pages,'pagesRead':len(page_indices),
                    'pageCount':len(doc),'completeExtraction':not warnings,'warnings':warnings}}


def extract_text_from_upload(raw, name):
    return extract_document(raw, name)['text']
