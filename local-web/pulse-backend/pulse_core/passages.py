"""On-demand open PMC text and locally imported S2ORC passages with provenance."""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pulse_core.constants import CONFIG_DIR, ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core.discovery_queries import terms
from pulse_core.literature_search import search_europe_pmc
from pulse_performance import check_cancelled, DiscoveryCancelled, DiscoveryBudgetExceeded

MAX_XML = 8*1024*1024


def aliases(paper):
    ids = []
    doi = normalize_doi(paper.get('doi')).lower()
    if doi: ids.append('doi:'+doi)
    for field, prefix in [('pmcid', 'pmc'), ('pmid', 'pmid'), ('corpusId', 'corpus'), ('s2PaperId', 's2')]:
        value = str(paper.get(field) or '').strip()
        if value: ids.append(prefix+':'+(value.upper() if prefix == 'pmc' else value))
    return ids


def database(directory=None):
    root = Path(directory or CONFIG_DIR); root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root/'fulltext.sqlite', timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, content TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS identifiers (alias TEXT PRIMARY KEY, document TEXT NOT NULL)')
    try: db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS passage_search USING fts5(docid UNINDEXED, text, section UNINDEXED, part UNINDEXED)')
    except sqlite3.OperationalError: pass
    return db


def cache_document(doc, directory=None):
    keys = aliases(doc)
    if not keys or not doc.get('passages'): return False
    ident = hashlib.sha256((doc['source']+keys[0]).encode()).hexdigest()
    db = database(directory)
    try:
        with db:
            db.execute('INSERT OR REPLACE INTO documents VALUES (?,?)', (ident, json.dumps(doc)))
            db.executemany('INSERT OR REPLACE INTO identifiers VALUES (?,?)', [(key, ident) for key in keys])
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='passage_search'").fetchone():
                db.execute('DELETE FROM passage_search WHERE docid=?', (ident,))
                db.executemany('INSERT INTO passage_search VALUES (?,?,?,?)', [(ident,p['text'],p['section'],i) for i,p in enumerate(doc['passages'])])
    finally: db.close()
    return True


def cached_document(paper, directory=None):
    db = database(directory)
    try:
        for key in aliases(paper):
            row = db.execute('SELECT content FROM documents JOIN identifiers ON documents.id=identifiers.document WHERE alias=?', (key,)).fetchone()
            if row:
                doc = json.loads(row[0])
                # Matching one identifier must not override a conflicting known DOI.
                if paper.get('doi') and doc.get('doi') and normalize_doi(paper['doi']).lower() != normalize_doi(doc['doi']).lower(): continue
                return doc
    finally: db.close()


def search_fulltext_library(query, limit=200, directory=None):
    words = list(dict.fromkeys(terms(query)))[:24]
    if not words: return []
    expression = ' OR '.join('"'+word.replace('"','')+'"' for word in words)
    db = database(directory)
    try:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='passage_search'").fetchone():
            return []
        rows = db.execute('SELECT documents.id,content,part FROM passage_search JOIN documents ON documents.id=passage_search.docid WHERE passage_search MATCH ? ORDER BY bm25(passage_search) LIMIT ?', (expression,min(2000,max(1,int(limit))*4))).fetchall()
    finally: db.close()
    papers = {}
    for ident, content, part in rows:
        check_cancelled()
        doc = json.loads(content)
        if ident not in papers:
            paper = {key:doc.get(key) for key in ('title','doi','pmcid','pmid','corpusId','s2PaperId','url')}
            paper.update(source=doc['source'],metadataSource=doc['source'],fullTextUrl=doc.get('url') or '',matchedPassages=[],subType='Full-text passage',
                         retrievalEvidence=[{'channel':'fulltext:question','provider':doc['source'],'rank':len(papers)+1}])
            papers[ident] = paper
        if len(papers[ident]['matchedPassages'])<3:
            papers[ident]['matchedPassages'].append(dict(doc['passages'][int(part)],id='p'+str(int(part)+1)))
    records = list(papers.values())[:max(1,int(limit))]
    missing = [p for p in records if not p.get('title') and p.get('corpusId')][:20]
    if missing:
        try:
            from pulse_core.s2_client import post_s2_json, s2_to_metadata
            from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
            from pulse_core.storage import load_settings
            metadata = post_s2_json('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,authors,year,externalIds,corpusId,abstract',
                                   {'ids':['CorpusId:'+str(p['corpusId']) for p in missing]}, api_key=resolve_semantic_scholar_api_key(load_settings()))
            for paper, row in zip(missing, metadata or []):
                if not row or str(row.get('corpusId')) != str(paper['corpusId']): continue
                paper.update({key:value for key,value in s2_to_metadata(row).items() if value})
        except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
        except Exception: pass
    for paper in records:
        if not paper.get('title'): paper['title'] = 'S2ORC record '+str(paper.get('corpusId') or paper.get('s2PaperId') or paper.get('doi') or '')
    return records


def split_passage(text, section='', anchor=''):
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    for start in range(0, len(text), 1500):
        segment = text[start:start+1800]
        if len(segment) >= 40:
            yield {'text': segment, 'section': section or 'Article text', 'anchor': anchor, 'start': start, 'end': start+len(segment)}


def parse_pmc_xml(raw, expected):
    if len(raw) > MAX_XML or b'<!ENTITY' in raw.upper(): raise ClientError(422, 'Article XML exceeds the safe text limit.')
    root = ET.fromstring(raw)
    for node in root.iter(): node.tag = node.tag.rsplit('}', 1)[-1]
    ids = {node.get('pub-id-type'): ''.join(node.itertext()).strip() for node in root.iter('article-id')}
    doi = normalize_doi(ids.get('doi')).lower()
    pmcid = str(ids.get('pmc') or ids.get('pmcid') or expected.get('pmcid') or '').upper()
    if pmcid.isdigit(): pmcid = 'PMC'+pmcid
    if expected.get('doi') and normalize_doi(expected['doi']).lower() != doi: raise ClientError(409, 'The retrieved article DOI does not match this paper.')
    if expected.get('pmcid') and pmcid != str(expected['pmcid']).upper(): raise ClientError(409, 'The retrieved archive identifier does not match this paper.')
    body = root.find('.//body')
    if body is None: raise ClientError(404, 'This archive record has no article body.')
    passages = []
    def walk(node, section='Article text', anchor=''):
        if node.tag == 'sec':
            title = node.find('title')
            section = ''.join(title.itertext()).strip() if title is not None else section
            anchor = node.get('id') or anchor
        if node.tag == 'p':
            passages.extend(split_passage(''.join(node.itertext()), section, anchor)); return
        for child in node: walk(child, section, anchor)
    walk(body)
    permissions = root.find('.//permissions')
    licence = ' '.join(permissions.itertext()).strip() if permissions is not None else 'Open-access PMC archive; consult article permissions.'
    title = root.find('.//article-title')
    return {'source': 'PMC / Europe PMC', 'title': ''.join(title.itertext()) if title is not None else expected.get('title', ''),
            'doi': doi, 'pmcid': pmcid, 'pmid': ids.get('pmid') or '', 'url': 'https://europepmc.org/articles/'+pmcid,
            'license': licence[:1200], 'retrievedAt': int(time.time()), 'passages': passages[:2000]}


def get_document(paper, directory=None):
    doc = cached_document(paper, directory)
    if doc: return doc
    pmcid = str(paper.get('pmcid') or '').upper()
    if not re.fullmatch(r'PMC\d+', pmcid):
        doi, pmid = normalize_doi(paper.get('doi')), str(paper.get('pmid') or '')
        if not doi and not pmid.isdigit(): return None
        rows = search_europe_pmc('', limit=3, doi=doi) if doi else search_europe_pmc('EXT_ID:'+pmid+' AND SRC:MED', limit=3, structured=True)
        match = next((row for row in rows if row.get('pmcid') and ((doi and normalize_doi(row.get('doi')).lower()==doi.lower()) or (not doi and str(row.get('pmid'))==pmid))), None)
        if not match: return None
        pmcid = str(match['pmcid']).upper()
    if not re.fullmatch(r'PMC\d+', pmcid): return None
    check_cancelled()
    request = urllib.request.Request('https://www.ebi.ac.uk/europepmc/webservices/rest/'+pmcid+'/fullTextXML', headers={'Accept': 'application/xml', 'User-Agent': 'Pulse literature reader'})
    with urllib.request.urlopen(request, timeout=15) as response: raw = response.read(MAX_XML+1)
    check_cancelled()
    doc = parse_pmc_xml(raw, dict(paper, pmcid=pmcid))
    cache_document(doc, directory)
    return doc


def retrieve_passages(payload, directory=None):
    paper = payload.get('paper') or {}
    if not isinstance(paper, dict): raise ClientError(400, 'Choose a paper to read.')
    try: doc = get_document(paper, directory)
    except (DiscoveryCancelled, DiscoveryBudgetExceeded): raise
    except Exception as error:
        if isinstance(error, ClientError) and error.status == 409: raise
        doc = None
    if not doc:
        return {'available': False, 'source': 'Abstract' if paper.get('abstract') else 'Metadata only', 'passages': [],
                'message': 'Full text is unavailable here. Import a readable PDF or a matching S2ORC record; the abstract remains available.'}
    query = set(terms(str(payload.get('question') or paper.get('title') or '')[:1000]))
    ranked = []
    for index, item in enumerate(doc['passages']):
        tokens = set(terms(item['text']))
        score = len(query & tokens)/max(1, len(query))
        # Small section preference; lexical match remains primary.
        score += .03 if re.search('result|discussion|limitation|conclusion', item['section'], re.I) else 0
        ranked.append(dict(item, id='p'+str(index+1), score=round(score, 4)))
    ranked.sort(key=lambda p: (-p['score'], int(p['id'][1:])))
    try: limit = max(1, min(20, int(payload.get('limit') or 8)))
    except (TypeError, ValueError): raise ClientError(400, 'Choose a passage count from 1 to 20.')
    chosen = []
    for item in ranked:
        if any(old['section']==item['section'] and abs(old['start']-item['start'])<1500 and old['text']==item['text'] for old in chosen): continue
        chosen.append(item)
        if len(chosen) == limit: break
    return {**{key: value for key, value in doc.items() if key != 'passages'}, 'available': True,
            'passages': chosen, 'totalPassages': len(ranked), 'message': 'Selected passages from available full text; this is not a whole-paper assessment.'}


def s2orc_document(row):
    if not isinstance(row, dict): raise ValueError('Invalid S2ORC record')
    metadata = row.get('metadata') or {}
    ids = row.get('externalids') or row.get('externalIds') or metadata.get('external_ids') or {}
    ids = {str(k).lower(): v for k, v in ids.items()}
    body = row.get('body_text') or (row.get('pdf_parse') or {}).get('body_text') or []
    passages = []
    extracted_title = ''
    if body:
        for part in body:
            passages.extend(split_passage(part.get('text'), str(part.get('section') or 'Article text')))
    else:
        content = row.get('content') or {}
        text = str(content.get('text') or '')
        annotations = content.get('annotations') or {}
        def annotation(name):
            value = annotations.get(name) or []
            return json.loads(value) if isinstance(value, str) else value
        headers = annotation('sectionheader')
        titles = annotation('title')
        if titles:
            span = titles[0]
            if 0 <= int(span['start']) < int(span['end']) <= len(text):
                extracted_title = text[int(span['start']):int(span['end'])]
        for span in annotation('paragraph'):
            start, end = int(span['start']), int(span['end'])
            if not 0 <= start < end <= len(text): continue
            prior = [h for h in headers if int(h['end']) <= start]
            header = max(prior, key=lambda h: int(h['end'])) if prior else None
            section = text[int(header['start']):int(header['end'])] if header else 'Article text'
            passages.extend(split_passage(text[start:end], section))
    pmcid = str(ids.get('pubmedcentral') or ids.get('pmcid') or '')
    if pmcid.isdigit(): pmcid = 'PMC'+pmcid
    return {'source': 'S2ORC local corpus', 'corpusId': row.get('corpusid') or row.get('corpusId') or '',
            's2PaperId': row.get('paper_id') or row.get('paperId') or '', 'doi': normalize_doi(ids.get('doi') or row.get('doi')),
            'pmcid': pmcid, 'pmid': str(ids.get('pubmed') or ids.get('pmid') or ''),
            'title': row.get('title') or metadata.get('title') or extracted_title or '', 'url': 'https://www.semanticscholar.org/paper/'+str(row.get('paper_id') or row.get('paperId') or '') if row.get('paper_id') or row.get('paperId') else '',
            'license': str(row.get('license') or 'S2ORC ODC-By 1.0; underlying article rights remain applicable.'),
            'retrievedAt': int(time.time()), 'passages': passages[:2000]}


def import_s2orc_stream(stream, directory=None, max_bytes=200*1024*1024):
    imported = skipped = read = 0
    while True:
        raw = stream.readline(1024*1024+1)
        if not raw: break
        read += len(raw)
        if len(raw)>1024*1024 or (max_bytes is not None and read>max_bytes): raise ClientError(413, 'Use a smaller S2ORC excerpt or split this corpus shard.')
        try:
            doc = s2orc_document(json.loads(raw))
            if cache_document(doc, directory): imported += 1
            else: skipped += 1
        except (ValueError, TypeError, KeyError): skipped += 1
    return {'ok': True, 'imported': imported, 'skipped': skipped}


def import_s2orc(payload):
    encoded = str(payload.get('base64') or '')
    if len(encoded)>28*1024*1024: raise ClientError(413, 'Use a S2ORC excerpt up to 20 MB, or the command-line importer for larger shards.')
    try: raw = base64.b64decode(encoded, validate=True)
    except ValueError: raise ClientError(400, 'The S2ORC file could not be read.')
    stream = gzip.GzipFile(fileobj=io.BytesIO(raw)) if raw[:2]==b'\x1f\x8b' else io.BytesIO(raw)
    return import_s2orc_stream(stream)
