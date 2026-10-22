"""Local, content-addressed PDF attachments and bounded single-page rendering."""
import base64
import hashlib
import os
import re
import tempfile
import json
import threading
import time
from collections import OrderedDict
from functools import lru_cache
from pulse_core.constants import CONFIG_DIR, ClientError
from pulse_core.pdf_utils import PDF_ENGINE_LOCK

MAX_BYTES=50*1024*1024
PREVIEW_TTL=24*60*60
PREVIEW_CACHE_BYTES=256*1024*1024
PREVIEWS=OrderedDict()
PREVIEW_LOCK=threading.Lock()

def engine():
    try: import pymupdf
    except ImportError: raise ClientError(503,'The PDF reader requires the bundled PyMuPDF component. Install the full Pulse package.')
    return pymupdf

def path_for(identity, permanent=False):
    if not isinstance(identity,str) or not re.fullmatch(r'[a-f0-9]{64}',identity):
        raise ClientError(400,'Choose a valid PDF attachment.')
    path=CONFIG_DIR/'pdfs'/(identity+'.pdf')
    if not path.is_file() and not permanent:
        path=CONFIG_DIR/'pdf-previews'/(identity+'.pdf')
        if path.is_file() and time.time()-path.stat().st_mtime>PREVIEW_TTL:
            path.unlink(missing_ok=True)
    if not path.is_file(): raise ClientError(404,'This PDF is not available on this computer. Find an open PDF or attach the file again.')
    return path

def attach(payload):
    content=payload.get('contentBase64')
    if not isinstance(content,str) or len(content)>MAX_BYTES*4//3+8: raise ClientError(413,'Choose a PDF smaller than 50 MB.')
    try: raw=base64.b64decode(content,validate=True)
    except (ValueError,TypeError): raise ClientError(400,'The PDF upload is invalid.')
    return store_bytes(raw,payload.get('name'))

def store_bytes(raw,name=None,preview=False):
    if len(raw)>MAX_BYTES or not raw.startswith(b'%PDF-'): raise ClientError(400,'Choose a valid PDF smaller than 50 MB.')
    fitz=engine()
    try:
        with PDF_ENGINE_LOCK, fitz.open(stream=raw,filetype='pdf') as doc:
            if doc.needs_pass: raise ClientError(400,'Unlock this PDF before attaching it.')
            count=doc.page_count
            if not 0<count<=10000: raise ClientError(400,'The PDF page count is not supported.')
    except ClientError: raise
    except Exception: raise ClientError(400,'This PDF cannot be opened.')
    identity=hashlib.sha256(raw).hexdigest();directory=CONFIG_DIR/('pdf-previews' if preview else 'pdfs');directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=directory/(identity+'.pdf')
    if not path.exists():
        fd,temp=tempfile.mkstemp(dir=directory,prefix='.pdf-')
        try:
            with os.fdopen(fd,'wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(temp,path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
    if preview:
        # Preview bytes are a bounded temporary render cache, never library attachments.
        os.utime(path,None)
        total=0
        files=[]
        for item in directory.glob('*.pdf'):
            try: files.append((item,item.stat()))
            except FileNotFoundError: pass
        for item,stat in sorted(files,key=lambda row:row[1].st_mtime,reverse=True):
            total+=stat.st_size
            if item!=path and (time.time()-stat.st_mtime>PREVIEW_TTL or total>PREVIEW_CACHE_BYTES):
                item.unlink(missing_ok=True)
    return {'id':identity,'name':str(name or 'Paper.pdf')[:240],'pages':count,'size':len(raw)}

def preview(payload):
    from pulse_core.pdf_access import find_pdf
    paper=payload.get('paper')
    if not isinstance(paper,dict): raise ClientError(400,'Choose a paper to preview.')
    engine()
    paper={key:str(paper.get(key) or '')[:4096] for key in ('title','doi','pmid','pmcid','openAlexId','arxivId','url','pdfUrl','fullTextUrl','year')} | {
        'authors':[str(value)[:240] for value in paper.get('authors',[])[:30]] if isinstance(paper.get('authors'),list) else [],
        'fullTextLinks':[row for row in paper.get('fullTextLinks',[])[:12] if isinstance(row,dict)] if isinstance(paper.get('fullTextLinks'),list) else [],
        'openAccessPdf':paper.get('openAccessPdf') if isinstance(paper.get('openAccessPdf'),dict) else None}
    key=json.dumps(paper,sort_keys=True)
    with PREVIEW_LOCK:
        cached=PREVIEWS.get(key)
        if cached and cached[0]>time.monotonic():
            try:
                path_for(cached[1]['id'])
                PREVIEWS.move_to_end(key)
                return dict(cached[1])
            except ClientError: pass
    raw,url,source=find_pdf(paper)
    result=dict(store_bytes(raw,(paper.get('title') or 'Paper')[:180]+'.pdf',preview=True),preview=True,url=url,source=source)
    with PREVIEW_LOCK:
        PREVIEWS[key]=(time.monotonic()+900,result)
        PREVIEWS.move_to_end(key)
        while len(PREVIEWS)>128: PREVIEWS.popitem(last=False)
    return result

def keep(payload):
    identity=payload.get('id');path=path_for(identity)
    result=store_bytes(path.read_bytes(),payload.get('name'))
    return dict(result,source=str(payload.get('source') or 'Open PDF')[:100],url=str(payload.get('url') or '')[:4096])

def page(payload):
    fitz=engine();path=path_for(payload.get('id'))
    thumbnail=payload.get('thumbnail') is True
    # Zoom changes only need a sharper image; the client keeps the page's text and links.
    with_text=not thumbnail and payload.get('text') is not False
    try:
        number=int(payload.get('page',1));scale=max(.15 if thumbnail else .6,min(2 if thumbnail else 4,float(payload.get('scale',1.25))))
        rotation=int(payload.get('rotation',0))
    except (ValueError,TypeError): raise ClientError(400,'Choose a valid page and zoom.')
    if rotation not in (0,90,180,270):raise ClientError(400,'Choose a quarter-turn rotation.')
    with PDF_ENGINE_LOCK, fitz.open(path) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        p=doc[number-1]
        p.set_rotation((p.rotation+rotation)%360)
        if p.rect.width*p.rect.height*scale*scale>12_000_000: scale=(12_000_000/(p.rect.width*p.rect.height))**.5
        pix=p.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
        result={'page':number,'pages':doc.page_count,'width':p.rect.width,'height':p.rect.height,'scale':scale,
                'image':'data:image/png;base64,'+base64.b64encode(pix.tobytes('png')).decode('ascii'),'rotation':rotation}
        if not with_text:
            return result|({'words':[],'text':'','source':'Local PDF','warning':''} if thumbnail else {})
        text_data=page_text(payload['id'],number)
        words=text_data['words']
        return result|{'words':[{'box':list(fitz.Rect(word[:4])*p.rotation_matrix),'origin':list(fitz.Point(word[0],word[1])*p.rotation_matrix),
                          'width':word[2]-word[0],'height':word[3]-word[1],'rotation':p.rotation,
                          'text':word[4],'block':word[5],'line':word[6]} for word in words[:20000]],
                'links':page_links(doc,p),'text':text_data['text'],'source':text_data['source'],'warning':text_data['warning']}

def target_y(doc,number,to):
    """Vertical position of a link or bookmark destination as a fraction of its page."""
    if not to: return 0
    target=doc[number-1];height=target.rect.height if target.rotation%180==0 else target.rect.width
    return max(0,min(1,float(to.y)/height)) if height else 0

def page_links(doc,p):
    links=[]
    for link in p.get_links()[:500]:
        r=link['from']*p.rotation_matrix
        box={'x':r.x0/p.rect.width,'y':r.y0/p.rect.height,'width':r.width/p.rect.width,'height':r.height/p.rect.height}
        if link.get('kind') in (1,4) and isinstance(link.get('page'),int) and 0<=link['page']<doc.page_count:
            links.append(box|{'page':link['page']+1,'targetY':target_y(doc,link['page']+1,link.get('to'))})
        elif link.get('kind')==2:
            uri=str(link.get('uri') or '').strip()
            if uri.lower().startswith('doi:'): uri='https://doi.org/'+uri[4:].strip()
            # Only web links leave the reader; file, script and launch actions are ignored.
            if re.match(r'https?://[^\s]+$',uri,re.I) and len(uri)<=2048: links.append(box|{'url':uri})
    return links

def info(payload):
    identity=payload.get('id');path_for(identity)
    return document_info(identity)

@lru_cache(maxsize=16)
def document_info(identity):
    fitz=engine()
    with PDF_ENGINE_LOCK, fitz.open(path_for(identity)) as doc:
        return {'pages':doc.page_count,'sizes':[[round(p.rect.width,2),round(p.rect.height,2)] for p in doc]}

def outline(payload):
    identity=payload.get('id');path_for(identity)
    return document_outline(identity)

SECTION_HEADING=re.compile(r'(?:\d+(?:\.\d+)*\.?\s+|[IVX]+\.\s+)?(?:abstract|summary|introduction|background|methods?|materials and methods|methodology|study design|results|results and discussion|findings|discussion|conclusions?|limitations|acknowledge?ments?|references|bibliography|supplementary (?:material|information)|appendix|funding|data availability|author contributions|conflicts? of interest|competing interests)\s*:?',re.I)

@lru_cache(maxsize=16)
def document_outline(identity):
    fitz=engine()
    with PDF_ENGINE_LOCK, fitz.open(path_for(identity)) as doc:
        rows=[]
        for level,title,number,*rest in doc.get_toc(simple=False)[:500]:
            title=' '.join(str(title).split())[:200]
            if not title or not 1<=number<=doc.page_count: continue
            dest=rest[0] if rest and isinstance(rest[0],dict) else {}
            rows.append({'level':max(1,min(6,int(level))),'title':title,'page':number,'y':target_y(doc,number,dest.get('to'))})
        if rows: return {'outline':rows,'source':'bookmarks'}
        rows=heading_outline(doc)
        return {'outline':rows,'source':'headings' if rows else ''}

def heading_outline(doc):
    """Section headings for PDFs without bookmarks, from type size, weight and common section names."""
    started=time.monotonic();lines=[];sizes={}
    for index,p in enumerate(doc):
        if index>=40 or time.monotonic()-started>2: break
        for block in p.get_text('dict',flags=0)['blocks']:
            for line in block.get('lines',[]):
                spans=[span for span in line['spans'] if span['text'].strip()]
                if not spans: continue
                for span in spans: sizes[round(span['size'],1)]=sizes.get(round(span['size'],1),0)+len(span['text'])
                text=' '.join(''.join(span['text'] for span in spans).split())
                bold=all(span['flags']&16 or 'bold' in span['font'].lower() for span in spans)
                lines.append((index+1,line['bbox'][1]/p.rect.height,text,max(span['size'] for span in spans),bold))
    if not sizes: return []
    body=max(sizes,key=sizes.get);rows=[];seen=set()
    for number,y,text,size,bold in lines:
        if not 3<=len(text)<=80 or text.casefold() in seen: continue
        prominent=bold or size>=body*1.12 or (text.isupper() and size>=body)
        named=SECTION_HEADING.fullmatch(text) and (prominent or text.isupper())
        numbered=re.match(r'(?:\d+(?:\.\d+){0,2}\.?)\s+[A-Z][^.]{2,}$',text) and prominent and size>=body
        if not (named or numbered): continue
        seen.add(text.casefold())
        rows.append({'level':2 if re.match(r'\d+\.\d+',text) else 1,'title':text,'page':number,'y':max(0,min(1,y))})
        if len(rows)>=100: break
    return rows

def search(payload):
    fitz=engine();path=path_for(payload.get('id'))
    query=str(payload.get('query') or '').strip()
    if not 1<=len(query)<=200:raise ClientError(400,'Enter up to 200 characters to find in this PDF.')
    results=[];started=time.monotonic();scanned=0;complete=True
    with PDF_ENGINE_LOCK, fitz.open(path) as doc:
        for index,p in enumerate(doc):
            if len(results)>=200 or time.monotonic()-started>8:complete=False;break
            text=p.get_text('text',sort=True)
            if not text.strip():scanned+=1;continue
            matches=p.search_for(query)
            if not matches:continue
            offset=text.casefold().find(query.casefold())
            snippet=' '.join(text[max(0,offset-65):max(0,offset)+len(query)+100].split())
            for rect in matches:
                r=rect*p.rotation_matrix
                results.append({'page':index+1,'snippet':snippet,'rect':{'x':r.x0/p.rect.width,'y':r.y0/p.rect.height,'width':r.width/p.rect.width,'height':r.height/p.rect.height}})
                if len(results)>=200:complete=False;break
        return {'matches':results,'complete':complete,'scannedPages':scanned}

@lru_cache(maxsize=16)
def page_text(identity,number):
    fitz=engine()
    with PDF_ENGINE_LOCK, fitz.open(path_for(identity)) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        p=doc[number-1];words=p.get_text('words',sort=True);source='Local PDF';warning=''
        if len(words)<4:
            try:
                from pulse_core.pdf_utils import local_ocr
                words=p.get_text('words',sort=True,textpage=local_ocr(p));source='Local PDF (OCR)'
            except Exception: warning='No selectable text on this page. OCR language data may be unavailable.'
        return {'words':words,'text':' '.join(word[4] for word in words),'source':source,'warning':warning}

def passage(payload):
    fitz=engine()
    try: path=path_for(payload.get('id'),permanent=True)
    except ClientError as error:
        if error.status==404: raise ClientError(409,'Download this PDF to your library before highlighting or quoting it.')
        raise
    try: number=int(payload.get('page',0))
    except (ValueError,TypeError): raise ClientError(400,'Choose a valid page.')
    quote=str(payload.get('quote') or '').strip()
    if not 1<=len(quote)<=20000: raise ClientError(400,'Select a passage in the PDF first.')
    with PDF_ENGINE_LOCK, fitz.open(path) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        data=page_text(payload['id'],number);text=data['text']
        normalize=lambda value:' '.join(re.findall(r'\w+',value.casefold()))
        clean=normalize(quote)
        if not clean or ' '+clean+' ' not in ' '+normalize(text)+' ': raise ClientError(409,'The selected quotation could not be verified on this PDF page.')
        return {'text':quote,'source':data['source'],'page':number,'pdfId':payload['id'],'section':str(payload.get('section') or 'Article text')[:80]}
