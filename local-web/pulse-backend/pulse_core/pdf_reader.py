"""Local, content-addressed PDF attachments and bounded single-page rendering."""
import base64
import hashlib
import os
import re
import tempfile
from functools import lru_cache
from pulse_core.constants import CONFIG_DIR, ClientError

MAX_BYTES=50*1024*1024

def engine():
    try: import pymupdf
    except ImportError: raise ClientError(503,'The PDF reader requires the bundled PyMuPDF component. Install the full Pulse package.')
    return pymupdf

def path_for(identity):
    if not isinstance(identity,str) or not re.fullmatch(r'[a-f0-9]{64}',identity):
        raise ClientError(400,'Choose a valid PDF attachment.')
    path=CONFIG_DIR/'pdfs'/(identity+'.pdf')
    if not path.is_file(): raise ClientError(404,'This PDF is not available on this computer. Attach the file again.')
    return path

def attach(payload):
    content=payload.get('contentBase64')
    if not isinstance(content,str) or len(content)>MAX_BYTES*4//3+8: raise ClientError(413,'Choose a PDF smaller than 50 MB.')
    try: raw=base64.b64decode(content,validate=True)
    except (ValueError,TypeError): raise ClientError(400,'The PDF upload is invalid.')
    if len(raw)>MAX_BYTES or not raw.startswith(b'%PDF-'): raise ClientError(400,'Choose a valid PDF smaller than 50 MB.')
    fitz=engine()
    try:
        with fitz.open(stream=raw,filetype='pdf') as doc:
            if doc.needs_pass: raise ClientError(400,'Unlock this PDF before attaching it.')
            count=doc.page_count
            if not 0<count<=10000: raise ClientError(400,'The PDF page count is not supported.')
    except ClientError: raise
    except Exception: raise ClientError(400,'This PDF cannot be opened.')
    identity=hashlib.sha256(raw).hexdigest();directory=CONFIG_DIR/'pdfs';directory.mkdir(parents=True,exist_ok=True)
    path=directory/(identity+'.pdf')
    if not path.exists():
        fd,temp=tempfile.mkstemp(dir=directory,prefix='.pdf-')
        try:
            with os.fdopen(fd,'wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(temp,path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
    return {'id':identity,'name':str(payload.get('name') or 'Paper.pdf')[:240],'pages':count,'size':len(raw)}

def page(payload):
    fitz=engine();path=path_for(payload.get('id'))
    try: number=int(payload.get('page',1));scale=max(.6,min(2,float(payload.get('scale',1.25))))
    except (ValueError,TypeError): raise ClientError(400,'Choose a valid page and zoom.')
    with fitz.open(path) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        p=doc[number-1]
        if p.rect.width*p.rect.height*scale*scale>12_000_000: scale=(12_000_000/(p.rect.width*p.rect.height))**.5
        pix=p.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
        text_data=page_text(payload['id'],number)
        words=text_data['words']
        return {'page':number,'pages':doc.page_count,'width':p.rect.width,'height':p.rect.height,
                'image':'data:image/png;base64,'+base64.b64encode(pix.tobytes('png')).decode('ascii'),
                'words':[{'box':list(fitz.Rect(word[:4])*p.rotation_matrix),'origin':list(fitz.Point(word[0],word[1])*p.rotation_matrix),
                          'width':word[2]-word[0],'height':word[3]-word[1],'rotation':p.rotation,
                          'text':word[4],'block':word[5],'line':word[6]} for word in words[:20000]],
                'text':text_data['text'],'source':text_data['source'],'warning':text_data['warning']}

@lru_cache(maxsize=16)
def page_text(identity,number):
    fitz=engine()
    with fitz.open(path_for(identity)) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        p=doc[number-1];words=p.get_text('words',sort=True);source='Local PDF';warning=''
        if len(words)<4:
            try:
                from pulse_core.pdf_utils import local_ocr
                words=p.get_text('words',sort=True,textpage=local_ocr(p));source='Local PDF (OCR)'
            except Exception: warning='No selectable text on this page. OCR language data may be unavailable.'
        return {'words':words,'text':' '.join(word[4] for word in words),'source':source,'warning':warning}

def passage(payload):
    fitz=engine();path=path_for(payload.get('id'))
    try: number=int(payload.get('page',0))
    except (ValueError,TypeError): raise ClientError(400,'Choose a valid page.')
    quote=str(payload.get('quote') or '').strip()
    if not 1<=len(quote)<=20000: raise ClientError(400,'Select a passage in the PDF first.')
    with fitz.open(path) as doc:
        if not 1<=number<=doc.page_count: raise ClientError(400,'This page does not exist.')
        data=page_text(payload['id'],number);text=data['text']
        normalize=lambda value:' '.join(re.findall(r'\w+',value.casefold()))
        clean=normalize(quote)
        if not clean or ' '+clean+' ' not in ' '+normalize(text)+' ': raise ClientError(409,'The selected quotation could not be verified on this PDF page.')
        return {'text':quote,'source':data['source'],'page':number,'pdfId':payload['id'],'section':str(payload.get('section') or 'Article text')[:80]}
