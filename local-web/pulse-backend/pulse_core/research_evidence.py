"""Resolve comparison text from the saved library or identity-checked OA articles."""
import concurrent.futures
import json
import re
import time
from pulse_core.constants import ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core import passages


def local_matches(papers):
    from pulse_core.storage import library_store
    ids = list({str(p.get('id')) for p in papers if p.get('id')})
    dois = list({normalize_doi(p.get('doi')).lower() for p in papers if p.get('doi')})
    if not ids and not dois:
        return []
    db = library_store().connect()
    try:
        clauses, params = [], []
        if ids:
            clauses.append('id IN (' + ','.join('?' for _ in ids) + ')'); params.extend(ids)
        if dois:
            clauses.append("lower(json_extract(data,'$.doi')) IN (" + ','.join('?' for _ in dois) + ')'); params.extend(dois)
        return [json.loads(row[0]) for row in db.execute('SELECT data FROM papers WHERE ' + ' OR '.join(clauses), params)]
    finally:
        db.close()


def local_paper(paper, saved):
    doi = normalize_doi(paper.get('doi')).lower()
    for candidate in saved:
        other = normalize_doi(candidate.get('doi')).lower()
        same_id = paper.get('id') and candidate.get('id') == paper['id']
        if same_id and doi and other and doi != other:
            raise ClientError(409, 'The saved paper DOI conflicts with the selected paper.')
        if same_id or (doi and doi == other):
            merged=dict(paper, **candidate)
            # A quote can be sent to the matrix before the coalesced autosave.
            # Accept only quotations verified against the local attachment.
            if 'evidencePassages' in paper:
                pending=[]
                for block in paper.get('evidencePassages') or []:
                    if not isinstance(block,dict) or not block.get('pdfId') or not block.get('evidenceColumn'): continue
                    try:
                        from pulse_core.pdf_reader import passage
                        passage({'id':block['pdfId'],'page':block.get('page'),'quote':block.get('text')})
                        pending.append(block)
                    except ClientError: continue
                merged['evidencePassages']=[block for block in candidate.get('evidencePassages') or [] if not (block.get('pdfId') and block.get('evidenceColumn'))]+pending
            return merged
    return dict(paper)


def text_blocks(paper):
    supplied = paper.get('evidencePassages')
    inputs = supplied if isinstance(supplied,list) and supplied else [{'text':str(paper.get('text') or ''), 'source':'Local imported text'}]
    section, blocks = 'Article text', []
    headings = re.compile(r'(?im)^\s*(?:\d+(?:\.\d+)*[.\s]+)?(abstract|introduction|background|materials? and methods|methods|results|discussion|conclusions?|limitations?|references|bibliography)\s*[:.]?\s*$')
    for item in inputs[:2000]:
        if not isinstance(item,dict) or not isinstance(item.get('text'),str): continue
        if item.get('section') and item['section']!='Article text': section=item['section']
        text, start = item['text'], 0
        for heading in list(headings.finditer(text))+[None]:
            part = text[start:heading.start() if heading else len(text)].strip()
            if part: blocks.append(dict(item, text=part, section=section))
            if heading: section, start = heading[1].title(), heading.end()
    return blocks


def hydrate(papers, use_open_access=True):
    saved = local_matches(papers)
    deadline = time.monotonic() + 25
    def resolve(paper):
        paper = local_paper(paper, saved)
        text = str(paper.get('text') or '').strip()
        abstract = str(paper.get('abstract') or '').strip()
        if (text and text != abstract) or paper.get('evidencePassages'):
            paper['evidencePassages'] = text_blocks(paper)
            paper['evidenceSource'] = 'Local imported text'
            return paper
        try:
            doc = passages.cached_document(paper)
            remaining = deadline - time.monotonic()
            if not doc and use_open_access and remaining > 1:
                doc = passages.get_document(paper, timeout=min(8, remaining))
            if doc:
                paper.update(text='\n\n'.join(p['text'] for p in doc['passages']),
                    evidencePassages=[dict(p, source=doc['source'], url=doc.get('url','')) for p in doc['passages']],
                    evidenceSource=doc['source'], evidenceUrl=doc.get('url',''), evidenceLicense=doc.get('license',''))
        except Exception:
            paper['evidenceWarning'] = 'Full text could not be retrieved; available local text or abstract is used.'
        return paper
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        return list(executor.map(resolve, papers))


def verify_citation(payload):
    citing, target = payload.get('paper'), payload.get('target')
    if not isinstance(citing,dict) or not isinstance(target,dict):
        raise ClientError(400, 'Choose the citing paper and the cited paper.')
    if not (normalize_doi(target.get('doi')) or re.fullmatch(r'\d+', str(target.get('pmid') or ''))):
        return {'verified':False, 'contexts':[], 'message':'A DOI or PMID is required to verify the cited reference.'}
    local=local_paper(citing,local_matches([citing]))
    contexts=local_citation_contexts(local,target)
    if contexts:
        return {'verified':True,'contexts':contexts,'source':'Local PDF / imported text','url':'',
            'message':'Exact DOI in the numbered bibliography and a matching printed citation marker verified. Check extracted text for OCR errors. Citation does not establish agreement or contradiction.'}
    try:
        doc = passages.get_document(citing, refresh=True, timeout=10)
    except Exception as error:
        if isinstance(error,ClientError) and error.status==409: raise
        return {'verified':False,'contexts':[],'message':'Full text is unavailable or could not be retrieved. Citation context remains unverified.'}
    if not doc:
        return {'verified':False, 'contexts':[], 'message':'No matching open-access full text is available.'}
    doi, pmid = normalize_doi(target.get('doi')).lower(), str(target.get('pmid') or '')
    references = {ref['id'] for ref in doc.get('references',[]) if
        (doi and normalize_doi(ref.get('doi')).lower()==doi) or (pmid and str(ref.get('pmid') or '')==pmid)}
    contexts = [p for p in doc.get('citationPassages',[]) if references.intersection(p.get('referenceIds',[]))]
    return {'verified':bool(contexts), 'contexts':contexts[:10], 'source':doc['source'], 'url':doc.get('url',''),
        'message':'Reference identity and citing passage verified. Citation does not establish agreement or contradiction.' if contexts else 'No passage citing that exact DOI or PMID was found.'}


def local_citation_contexts(paper,target):
    """Verify only explicit numbered references containing the exact DOI.

    Author/year guesses, superscripts lost by OCR and ambiguous numbering remain
    unverified. A marker establishes citation identity, never stance.
    """
    from pulse_core.bibliography import bibliography_text,split_references
    from pulse_core.doi_utils import ranked_doi_candidates
    from pulse_core.evidence_matrix import _SENTENCE_SPLIT
    doi=normalize_doi(target.get('doi')).lower()
    if not doi:return []
    blocks=text_blocks(paper)
    bibliography='\n'.join(p['text'] for p in blocks if re.search('references|bibliography',p.get('section',''),re.I))
    bibliography=bibliography or bibliography_text(paper.get('text'))
    entries=split_references(bibliography)
    numbered={}
    for entry in entries:
        marker=re.match(r'^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)])\s+',entry)
        if marker:numbered.setdefault(marker[1] or marker[2],[]).append(entry)
    numbers={number for number,rows in numbered.items() if len(rows)==1 and doi in {
        normalize_doi(value).lower() for value in ranked_doi_candidates(rows[0])}}
    contexts=[]
    for block in blocks:
        if re.search('references|bibliography',block.get('section',''),re.I):continue
        for sentence in _SENTENCE_SPLIT.split(block['text']):
            markers=re.findall(r'\[(\d{1,4}(?:\s*[,;]\s*\d{1,4})*)\]',sentence)
            cited={n for marker in markers for n in re.split(r'\s*[,;]\s*',marker)}
            if cited&numbers:
                contexts.append(dict(block,text=' '.join(sentence.split()),referenceIds=sorted(cited&numbers)))
    return contexts[:10]
