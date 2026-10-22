"""Export explicit edits to a new local PDF, preserving the source file."""
import math
from pulse_core.constants import ClientError
from pulse_core import pdf_reader

COLORS={'yellow':(1,.90,.42),'green':(.57,.90,.67),'blue':(.25,.55,.95),'pink':(.97,.64,.82),'red':(.85,.18,.18),'black':(.12,.12,.15)}

def number(value,low,high,label):
    try: result=float(value)
    except (TypeError,ValueError):raise ClientError(400,'Invalid '+label+'.')
    if not math.isfinite(result) or not low<=result<=high:raise ClientError(400,'Invalid '+label+'.')
    return result

def point(value,page):
    fitz=pdf_reader.engine()
    if not isinstance(value,dict):raise ClientError(400,'Invalid PDF point.')
    x=number(value.get('x'),0,1,'point');y=number(value.get('y'),0,1,'point')
    return fitz.Point(x*page.rect.width,y*page.rect.height)*page.derotation_matrix

def rectangle(value,page):
    fitz=pdf_reader.engine()
    if not isinstance(value,dict):raise ClientError(400,'Invalid PDF rectangle.')
    x=number(value.get('x'),0,1,'rectangle');y=number(value.get('y'),0,1,'rectangle')
    width=number(value.get('width'),.00001,1,'rectangle');height=number(value.get('height'),.00001,1,'rectangle')
    if x+width>1.00001 or y+height>1.00001:raise ClientError(400,'Keep edits within the PDF page.')
    return fitz.Rect(x*page.rect.width,y*page.rect.height,min(1,x+width)*page.rect.width,min(1,y+height)*page.rect.height)*page.derotation_matrix

def export(payload):
    fitz=pdf_reader.engine()
    try:path=pdf_reader.path_for(payload.get('id'),permanent=True)
    except ClientError as error:
        if error.status==404:raise ClientError(409,'Download a local copy before editing this PDF.')
        raise
    marks=payload.get('annotations',[])
    if not isinstance(marks,list) or len(marks)>500:raise ClientError(400,'Export up to 500 PDF marks at a time.')
    with pdf_reader.PDF_ENGINE_LOCK, fitz.open(path) as doc:
        if doc.is_encrypted and not doc.permissions & fitz.PDF_PERM_MODIFY:raise ClientError(409,'This PDF does not permit editing. Use an editable source copy.')
        order=payload.get('pageOrder',list(range(1,len(doc)+1)))
        if not isinstance(order,list) or not order or len(order)>len(doc) or any(type(n) is not int or not 1<=n<=len(doc) for n in order) or len(set(order))!=len(order):
            raise ClientError(400,'Keep at least one page, with no duplicate or invalid page numbers.')
        rotations=payload.get('rotations',{})
        if not isinstance(rotations,dict):raise ClientError(400,'Invalid page rotations.')
        for key,value in rotations.items():
            if not str(key).isdigit() or not 1<=int(key)<=len(doc) or type(value) is not int or value not in (0,90,180,270):raise ClientError(400,'Invalid page rotation.')
        for mark in marks:
            if not isinstance(mark,dict) or type(mark.get('page')) is not int or not 1<=mark['page']<=len(doc):raise ClientError(400,'Invalid annotation page.')
            if mark['page'] not in order:continue
            p=doc[mark['page']-1];kind=mark.get('kind') or 'highlight';color=COLORS.get(mark.get('color'),COLORS['yellow']);annot=None
            rects=mark.get('rects') or []
            if not isinstance(rects,list) or len(rects)>1000:raise ClientError(400,'Invalid annotation rectangles.')
            if kind in ('highlight','underline','strikeout'):
                if not rects:raise ClientError(400,'Select text before exporting markup.')
                boxes=[rectangle(r,p) for r in rects]
                annot=getattr(p,{'highlight':'add_highlight_annot','underline':'add_underline_annot','strikeout':'add_strikeout_annot'}[kind])(boxes)
                annot.set_colors(stroke=color)
            elif kind=='rectangle':
                annot=p.add_rect_annot(rectangle(mark.get('rect'),p));annot.set_colors(stroke=color);annot.set_border(width=number(mark.get('strokeWidth',2),.5,12,'stroke width'))
            elif kind=='ink':
                points=mark.get('points') or []
                if not isinstance(points,list) or not 2<=len(points)<=2000:raise ClientError(400,'Invalid pen stroke.')
                annot=p.add_ink_annot([[tuple(point(value,p)) for value in points]])
                annot.set_colors(stroke=color);annot.set_border(width=number(mark.get('strokeWidth',2),.5,12,'stroke width'))
            elif kind=='text':
                text=str(mark.get('text') or '')
                if not text.strip() or len(text)>5000:raise ClientError(400,'Enter up to 5,000 characters in a text box.')
                annot=p.add_freetext_annot(rectangle(mark.get('rect'),p),text,fontsize=number(mark.get('fontSize',12),6,72,'font size'),text_color=color)
            elif kind=='note':
                text=str(mark.get('memo') or '')
                if not text.strip() or len(text)>20000:raise ClientError(400,'Enter a comment of up to 20,000 characters.')
                annot=p.add_text_annot(point(mark.get('point'),p),text)
            else:raise ClientError(400,'This annotation type is not supported.')
            if annot:
                content=mark.get('text') if kind=='text' else mark.get('memo') or mark.get('quote') or ''
                annot.set_info(title='Pulse',content=str(content)[:20000])
                if kind=='text' and mark.get('memo'):annot.set_info(subject=str(mark['memo'])[:20000])
                annot.update()
        for original in order:
            p=doc[original-1];p.set_rotation((p.rotation+rotations.get(str(original),0))%360)
        doc.select([n-1 for n in order])
        raw=doc.tobytes(garbage=4,deflate=True)
    result=pdf_reader.store_bytes(raw,str(payload.get('name') or 'Edited paper.pdf')[:240])
    return dict(result,editedFrom=payload['id'],source='Edited local copy')
