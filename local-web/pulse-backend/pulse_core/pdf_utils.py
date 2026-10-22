import re
import time
import math
import os
import threading
from pathlib import Path
from pulse_core.security import decode_pdf_streams

# MuPDF operations must not overlap across the HTTP server's request threads.
PDF_ENGINE_LOCK=threading.RLock()

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


def page_blocks(page,textpage=None):
    """Text blocks with their lines, bounding boxes and dominant type size."""
    import pymupdf as fitz
    flags=fitz.TEXTFLAGS_DICT&~fitz.TEXT_PRESERVE_IMAGES
    data=page.get_text('dict',textpage=textpage,flags=flags) if textpage is not None else page.get_text('dict',flags=flags)
    blocks=[]
    for block in data.get('blocks') or []:
        rows=[]
        for line in block.get('lines') or []:
            spans=sorted((span for span in line.get('spans') or [] if (span.get('text') or '').strip() and span.get('bbox')),key=lambda span:span['bbox'][0])
            # A gutter-sized gap inside a "line" means the engine joined text from two columns.
            pieces=[]
            for span in spans:
                if pieces and span['bbox'][0]-pieces[-1][-1]['bbox'][2]>max(3*span.get('size',10),20):pieces.append([span])
                elif pieces:pieces[-1].append(span)
                else:pieces.append([span])
            for piece in pieces:
                value=' '.join(span.get('text') or '' for span in piece).strip()
                box=(min(span['bbox'][0] for span in piece),min(span['bbox'][1] for span in piece),max(span['bbox'][2] for span in piece),max(span['bbox'][3] for span in piece))
                if value:rows.append((box,value,max(span.get('size',0) for span in piece)))
        if not rows:continue
        parts=[rows]
        if len(rows)>1:
            spans=sorted((row[0][0],row[0][2]) for row in rows);end=spans[0][1];cuts=[]
            for x0,x1 in spans[1:]:
                if x0-end>=15:cuts.append((end+x0)/2)
                end=max(end,x1)
            if cuts:
                split=[[] for _ in range(len(cuts)+1)]
                for row in rows:split[sum(row[0][0]>=cut for cut in cuts)].append(row)
                # Only separate real columns (several lines each), never words spread along one justified line.
                if all(len({round(row[0][3]) for row in part})>=2 for part in split if part):parts=split
        for part in parts:
            if not part:continue
            weights={}
            for _,value,size in part:weights[round(size,1)]=weights.get(round(size,1),0)+len(value)
            blocks.append({'box':(min(r[0][0] for r in part),min(r[0][1] for r in part),max(r[0][2] for r in part),max(r[0][3] for r in part)),
                           'rows':part,'size':max(weights,key=weights.get),'chars':sum(weights.values())})
    return blocks


def block_lines(block,positions=False):
    """Rejoin justified-text fragments that share a baseline into one line."""
    lines=[]
    for box,value,_ in sorted(block['rows'],key=lambda row:(row[0][1],row[0][0])):
        middle=(box[1]+box[3])/2
        if lines and abs(middle-lines[-1][0])<=max(1.5,(box[3]-box[1])*.35):lines[-1][1].append((box[0],value))
        else:lines.append([middle,[(box[0],value)]])
    joined=[(min(x for x,_ in parts),' '.join(value for _,value in sorted(parts))) for _,parts in lines]
    return joined if positions else [value for _,value in joined]


def _column_gaps(blocks,minimum=6):
    spans=sorted((block['box'][0],block['box'][2]) for block in blocks)
    gaps=[];end=spans[0][1]
    for x0,x1 in spans[1:]:
        if x0-end>=minimum:gaps.append((end,x0))
        end=max(end,x1)
    return gaps


def _bands(blocks):
    bands=[];bottom=0
    for block in sorted(blocks,key=lambda block:block['box'][1]):
        if bands and block['box'][1]<bottom-1:bands[-1].append(block);bottom=max(bottom,block['box'][3])
        else:bands.append([block]);bottom=block['box'][3]
    return bands


def _same_columns(left,right):
    first,second=_column_gaps(left),_column_gaps(right)
    return bool(first) and len(first)==len(second) and all(a[0]<d[1] and d[0]<a[1] for a,d in zip(first,second))


def _reading_order(blocks,layout,depth=0,column=None,counter=None):
    counter=counter if counter is not None else [0]
    # Horizontal bands split at full-width headings and figures; bands sharing a column layout are one region.
    merged=[]
    for band in _bands(blocks):
        if merged and _same_columns(merged[-1],band):merged[-1]=merged[-1]+band
        else:merged.append(band)
    ordered=[]
    for band in merged:
        gaps=_column_gaps(band) if len(band)>1 and depth<6 else []
        if not gaps:
            ordered+=[(block,column) for block in sorted(band,key=lambda block:(block['box'][1],block['box'][0]))];continue
        cuts=[(a+b)/2 for a,b in gaps];columns=[[] for _ in range(len(cuts)+1)]
        for block in band:columns[sum(block['box'][0]>=cut for cut in cuts)].append(block)
        columns=[column for column in columns if column]
        if sum(1 for column in columns if sum(len(block_lines(block)) for block in column)>=3)>=2:layout[0]=True
        # Small-print side notes (editors, correspondence) are read after the main text beside them.
        dominant=max(columns,key=lambda column:sum(block['chars'] for block in column))
        main=max(set(block['size'] for block in dominant),key=lambda size:sum(block['chars'] for block in dominant if block['size']==size))
        width=max(block['box'][2] for block in band)-min(block['box'][0] for block in band)
        def side(column):
            size=sum(block['size']*block['chars'] for block in column)/max(1,sum(block['chars'] for block in column))
            return size<main*.85 and max(block['box'][2] for block in column)-min(block['box'][0] for block in column)<width*.4
        for part in sorted(columns,key=side):
            counter[0]+=1;ordered+=_reading_order(part,layout,depth+1,counter[0],counter)
    return ordered


def ordered_page_text(page,textpage=None,blocks=None,state=None):
    """Read each column top to bottom, keeping full-width headings, side notes and justified lines in order.

    With a state dict (one per document), running headers and footers are returned separately in
    state['header'] and state['footer'], and a reference continued from the previous page is returned
    in state['carry'] so the caller can join it to that page's last entry."""
    blocks=page_blocks(page,textpage) if blocks is None else blocks
    if state is not None:
        height=float(page.rect.height);furniture=lambda block:len(block['rows'])<=3 and (block['box'][3]<=height*.075 or block['box'][1]>=height*.925)
        state['header']=[line for block in sorted(blocks,key=lambda b:(b['box'][1],b['box'][0])) if furniture(block) and block['box'][3]<=height*.075 for line in block_lines(block)]
        state['footer']=[line for block in sorted(blocks,key=lambda b:(b['box'][1],b['box'][0])) if furniture(block) and block['box'][1]>=height*.925 for line in block_lines(block)]
        state['carry']='';blocks=[block for block in blocks if not furniture(block)]
    if not blocks:return '',False
    layout=[False];groups=[]
    for block,column in _reading_order(blocks,layout):
        for line in block_lines(block,positions=True):
            # A reference heading starts its own run, so the list's indentation is judged apart from the text above it.
            if not groups or groups[-1][0]!=column or REFERENCE_HEADING.match(line[1]):groups.append((column,[]))
            groups[-1][1].append(line)
    output=[];hanging=bool(state and state.get('hanging'));carry=[]
    for _,lines in groups:
        if REFERENCE_HEADING.match(lines[0][1]):output.append(lines.pop(0)[1])
        if not lines:continue
        left=min(x for x,_ in lines);indented=[x-left>=3 and x-left<=24 for x,_ in lines]
        # Hanging-indent lists (references): an outdented line starts an entry, indented lines continue it.
        mostly=sum(indented)>=len(lines)*.55
        if mostly and (len(lines)>=4 and len(lines)-sum(indented)>=1 or hanging):
            entries=[]
            for (x,value),inner in zip(lines,indented):
                if inner and not entries and not output and hanging and state is not None:carry.append(value)
                elif inner and (entries or hanging and output):
                    target=entries if entries else output
                    target[-1]=_paragraph([target[-1],value])
                else:entries.append(value)
            output+=entries;hanging=True
        else:output+=[value for _,value in lines];hanging=False
    if state is not None:state['carry']=_paragraph(carry) if carry else '';state['hanging']=hanging
    return '\n'.join(output),layout[0]


REFERENCE_HEADING=re.compile(r'^\s*(?:\d+\.?\s+)?(?:references|bibliography|literature cited|works cited)\s*:?\s*$',re.I)
SECTION_START=re.compile(r'^(?:\d+\.?\s+|[IVX]+\.\s+)?(?:introduction|background|keywords?|key words|abbreviations|main text|materials and methods|methods?)\b',re.I)


def _paragraph(lines):
    text=''
    for line in lines:
        text=text[:-1]+line if text.endswith('-') and line[:1].islower() else (text+' '+line if text else line)
    return re.sub(r'\s+',' ',text).strip()


def first_page_abstract(page,textpage=None):
    """The abstract, labelled or not: the main paragraph above the first section heading or keyword line."""
    blocks=page_blocks(page,textpage)
    if not blocks:return ''
    # Consecutive same-size blocks in one column with ordinary line spacing form one paragraph.
    paragraphs=[]
    for block,column in _reading_order(blocks,[False]):
        last=paragraphs[-1] if paragraphs else None
        if last and last['column']==column and abs(last['size']-block['size'])<.3 and 0<=block['box'][1]-last['box'][3]<=block['size']*.8:
            last['box']=(min(last['box'][0],block['box'][0]),last['box'][1],max(last['box'][2],block['box'][2]),block['box'][3]);last['lines']+=block_lines(block)
        else:paragraphs.append({'box':block['box'],'size':block['size'],'column':column,'lines':block_lines(block)})
    texts=[(block,_paragraph(block['lines'])) for block in paragraphs]
    for index,(block,text) in enumerate(texts):
        label=re.match(r'^(?:abstract|summary)\b[\s:.\u2014\u2013-]*',text,re.I)
        if not label:continue
        body=text[label.end():].strip();parts=[body] if body else []
        for _,following in texts[index+1:]:
            if len(' '.join(parts).split())>=30 or SECTION_START.match(following):break
            parts.append(following)
        body=' '.join(parts)
        return body[:2500] if len(body.split())>=30 else ''
    weights={}
    for block in blocks:weights[block['size']]=weights.get(block['size'],0)+block['chars']
    body_size=max(weights,key=weights.get)
    stop=min((block['box'][1] for block,text in texts if SECTION_START.match(text)),default=None)
    if stop is None:return ''
    candidates=[(len(text.split()),text) for block,text in texts if block['box'][3]<=stop+2 and len(text.split())>=50 and block['size']>=body_size*.9]
    return max(candidates)[1][:2500] if candidates else ''


def local_ocr(page):
    data=Path(os.environ['PULSE_OCR_DATA']) if os.environ.get('PULSE_OCR_DATA') else Path(__file__).resolve().parent.parent/'ocr-data'
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
    with PDF_ENGINE_LOCK, fitz.open(stream=raw, filetype='pdf') as doc:
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
        pages = [];state = {}
        evidence_passages = []
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
            page=doc[index];previous={'hanging':state.get('hanging',False)}
            state=dict(previous);native,columns=ordered_page_text(page,state=state)
            if readable_text_score(native)<.35 and (page.get_images() or len(page.get_drawings())>20):
                if len(ocr_pages)<8 and time.monotonic()-started<16:
                    try:
                        textpage=local_ocr(page)
                        state=dict(previous);native,columns=ordered_page_text(page,textpage,state=state)
                        ocr_pages.append(index+1)
                    except Exception:warnings.append(f'Page {index+1} could not be read with local OCR; verify its references manually.')
                else:warnings.append(f'Page {index+1} needs OCR beyond the extraction budget; verify its references manually.')
            body=native.split('\n') if native else []
            # A reference that runs over the page break rejoins its entry on the previous page.
            if state.get('carry'):
                if pages and pages[-1]['body']:pages[-1]['body'][-1]=_paragraph([pages[-1]['body'][-1],state['carry']])
                else:body.insert(0,state['carry'])
            pages.append({'number':index+1,'header':state['header'],'body':body,'footer':state['footer']})
            if columns:layout_pages.append(index+1)
            if index < 3:
                identifiers += [link.get('uri') or '' for link in page.get_links()]
            if index == 0 and not metadata.get('abstract'):
                abstract = first_page_abstract(page, textpage if index+1 in ocr_pages else None)
                if abstract:
                    metadata['abstract'] = abstract
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
        # Running headers, footers and page numbers repeated across pages are page furniture, not article text.
        key=lambda line:re.sub(r'\s+',' ',re.sub(r'\d+','#',line.lower())).strip()
        seen={}
        for row in pages:
            for line in {key(line) for line in row['header']+row['footer']}:seen[line]=seen.get(line,0)+1
        repeated={line for line,count in seen.items() if count>=2} if len(pages)>=3 else set()
        chunks=[]
        for row in pages:
            native='\n'.join([line for line in row['header'] if key(line) not in repeated]+row['body']+[line for line in row['footer'] if key(line) not in repeated])
            chunks.append(native)
            remaining=350000-sum(len(p['text']) for p in evidence_passages)
            if remaining>0:
                evidence_passages.append({'text':native[:min(30000,remaining)], 'page':row['number'], 'section':'Article text',
                    'source':'Local PDF / OCR' if row['number'] in ocr_pages else 'Local PDF'})
            if len(native)>min(30000,max(0,remaining)) and not any('Evidence text is capped' in w for w in warnings):
                warnings.append('Evidence text is capped at 350,000 characters and 30,000 per page; some text is omitted.')
        text = clean_extracted_text('\n'.join(chunks))[:350000]
        # Readable page text and structured identifiers precede binary scanning.
        return {'text': text, 'metadata': metadata, 'doiText': '\n'.join(identifiers),
                'extractionSource': 'PyMuPDF + local OCR' if ocr_pages else 'PyMuPDF', 'pageCount': len(doc), 'textAvailable': bool(text),
                'evidencePassages':evidence_passages,
                'bibliographyProvenance':{'layoutPages':layout_pages,'ocrPages':ocr_pages,'pagesRead':len(page_indices),
                    'pageCount':len(doc),'completeExtraction':not warnings,'warnings':warnings}}


def extract_text_from_upload(raw, name):
    return extract_document(raw, name)['text']


def reading_order_words(page,textpage=None):
    """Page words in column reading order, so selection and quote checks follow the article, not the page's raw order."""
    found=page_blocks(page,textpage);blocks=[block for block,_ in _reading_order(found,[False])] if found else []
    words=page.get_text('words',textpage=textpage) if textpage is not None else page.get_text('words')
    def rank(word):
        cx,cy=(word[0]+word[2])/2,(word[1]+word[3])/2
        for index,block in enumerate(blocks):
            x0,y0,x1,y1=block['box']
            if x0-1<=cx<=x1+1 and y0-1<=cy<=y1+1:return index
        return len(blocks)
    return sorted(words,key=lambda word:(rank(word),round(word[3]),word[0]))
