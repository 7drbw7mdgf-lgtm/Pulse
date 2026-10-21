"""Local screening projects with an append-only decision history and honest exports."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid
from pulse_core.constants import ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core.platform_support import config_directory

STAGES = ('title-abstract','full-text')


def connect(directory=None):
    root=Path(directory or config_directory());root.mkdir(parents=True,exist_ok=True)
    path=root/'screening.sqlite3'
    db=sqlite3.connect(path,timeout=10,isolation_level=None)
    try: os.chmod(path,0o600)
    except OSError: pass
    db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS records (project TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS runs (project TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
        request TEXT NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL, created REAL NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project,request));
    ''')
    for suffix in ('-wal','-shm'):
        try: os.chmod(str(path)+suffix,0o600)
        except OSError: pass
    return db


def identity(paper):
    doi=normalize_doi(paper.get('doi')).lower()
    if doi: return 'doi:'+doi
    for key in ('pmid','s2PaperId','openAlexId'):
        if paper.get(key): return key+':'+str(paper[key]).casefold()
    title=' '.join(re.findall(r'\w+',str(paper.get('title') or '').casefold()))
    if not title: raise ClientError(400,'A screening record needs a title or identifier.')
    return 'title:'+hashlib.sha256((title+'|'+str(paper.get('year') or '')).encode()).hexdigest()


def paper_metadata(paper):
    out={key:str(paper.get(key) or '')[:2000] for key in ('id','title','doi','pmid','s2PaperId','openAlexId','year','journal','url')}
    out['authors']=[str(x)[:200] for x in paper.get('authors',[])[:30]] if isinstance(paper.get('authors'),list) else []
    return out


def blank(paper):
    return {'paper':paper_metadata(paper),'stages':{},'memo':'','tags':[],'feedbackGrade':None,'sources':[]}


def records(db,project):
    return {key:json.loads(data) for key,data in db.execute('SELECT id,data FROM records WHERE project=? ORDER BY id',(project,))}


def snapshot(db,project):
    row=db.execute('SELECT name FROM projects WHERE id=?',(project,)).fetchone()
    if not row: raise ClientError(404,'Screening project was not found.')
    runs=[json.loads(row[0]) for row in db.execute('SELECT data FROM runs WHERE project=?',(project,))]
    count=db.execute("SELECT COUNT(*) FROM events WHERE project=? AND undone=0 AND action!='undo'",(project,)).fetchone()[0]
    return {'project':project,'name':row[0],'records':records(db,project),'runs':runs,'canUndo':bool(count),
        'eventCount':db.execute('SELECT COUNT(*) FROM events WHERE project=?',(project,)).fetchone()[0]}


def screening_counts(data):
    rows=list(data['records'].values());reason_counts={};stages={}
    for stage in STAGES:
        decisions=[row.get('stages',{}).get(stage,{}) for row in rows]
        stages[stage]={key:sum(item.get('decision')==key for item in decisions) for key in ('include','exclude','pending')}
        stages[stage]['screened']=sum(item.get('decision') in ('include','exclude') for item in decisions)
    for row in rows:
        decision=row.get('stages',{}).get('full-text',{})
        if decision.get('decision')=='exclude':
            reason=decision.get('reason') or 'Reason not recorded';reason_counts[reason]=reason_counts.get(reason,0)+1
    return {'schema':'pulse-prisma-working-data-v1','recordsIdentified':None,'duplicatesRemovedBeforeScreening':None,
        'recordsCapturedInPulse':len(rows),'searchRunsCaptured':len(data['runs']),
        'recordsScreened':stages['title-abstract']['screened'],'recordsExcluded':stages['title-abstract']['exclude'],
        'reportsAssessedForEligibility':stages['full-text']['screened'],'reportsExcluded':stages['full-text']['exclude'],
        'reportsIncluded':stages['full-text']['include'],'studiesIncluded':None,'fullTextExclusionReasons':reason_counts,
        'stages':stages,'complete':False,'limitations':[
            'Captured candidates may be ranked, capped or collected while a provider was unavailable.',
            'Identification totals and duplicates removed upstream were not recorded and remain unknown.',
            'Reports are not grouped into studies; included study counts require review.'
        ],'searchRuns':data['runs']}


def safe_csv(value):
    text=str(value or '')
    return "'"+text if text.lstrip()[:1] in '=+-@' and text.strip() else text


def export(data,fmt):
    if fmt=='prisma': return {'filename':'pulse-prisma-working-data.json','mime':'application/json','content':json.dumps(screening_counts(data),indent=2)}
    if fmt=='json': return {'filename':'pulse-screening-project.json','mime':'application/json','content':json.dumps(data,indent=2)}
    if fmt=='ris':
        lines=[]
        clean=lambda s: re.sub(r'[\r\n\x00]+',' ',str(s or ''))
        for key,row in data['records'].items():
            p=row['paper'];lines.extend(['TY  - JOUR','ID  - '+clean(key),'TI  - '+clean(p.get('title'))])
            lines.extend('AU  - '+clean(a) for a in p.get('authors',[]))
            for field,tag in [('doi','DO'),('year','PY'),('journal','JO'),('url','UR')]:
                if p.get(field): lines.append(tag+'  - '+clean(p[field]))
            for stage,decision in row.get('stages',{}).items():
                lines.append('KW  - Pulse:'+stage+':'+decision['decision'])
                if decision.get('reason'): lines.append('N1  - Exclusion reason ('+stage+'): '+clean(decision['reason']))
            lines.extend('KW  - '+clean(tag) for tag in row.get('tags',[]))
            if row.get('memo'): lines.append('N1  - '+clean(row['memo']))
            lines.extend(['ER  - ',''])
        return {'filename':'pulse-screening-decisions.ris','mime':'application/x-research-info-systems','content':'\n'.join(lines)}
    if fmt=='csv':
        stream=io.StringIO();writer=csv.writer(stream)
        writer.writerow(['Record','Title','DOI','Stage','Decision','Exclusion reason','Memo','Tags','Decided at'])
        for key,row in data['records'].items():
            for stage in STAGES:
                decision=row.get('stages',{}).get(stage,{})
                writer.writerow([safe_csv(x) for x in [key,row['paper'].get('title'),row['paper'].get('doi'),stage,
                    decision.get('decision','pending'),decision.get('reason',''),row.get('memo'),'; '.join(row.get('tags',[])),decision.get('at','')]])
        return {'filename':'pulse-screening-decisions.csv','mime':'text/csv','content':stream.getvalue()}
    raise ClientError(400,'Choose RIS, CSV, JSON or PRISMA working data.')


def handle(payload,directory=None):
    action=payload.get('action','open')
    if action not in ('open','list','ingest','decision','annotate','undo','export'): raise ClientError(400,'Unknown screening action.')
    context=payload.get('context')
    project=payload.get('project') or (hashlib.sha256(str(context).encode()).hexdigest() if context else '')
    if action!='list' and not re.fullmatch(r'[a-f0-9]{64}',str(project)): raise ClientError(400,'Choose a screening project.')
    db=connect(directory)
    try:
        if action=='list': return {'projects':[{'id':i,'name':n} for i,n in db.execute('SELECT id,name FROM projects ORDER BY created DESC')]}
        db.execute('BEGIN IMMEDIATE')
        if action in ('open','ingest'):
            db.execute('INSERT OR IGNORE INTO projects VALUES (?,?,?)',(project,str(payload.get('name') or 'Literature screening')[:160],time.time()))
        if not db.execute('SELECT 1 FROM projects WHERE id=?',(project,)).fetchone(): raise ClientError(404,'Screening project was not found.')
        if action=='ingest':
            papers=payload.get('papers') or []
            if not isinstance(papers,list) or len(papers)>2000 or any(not isinstance(p,dict) for p in papers): raise ClientError(400,'Capture up to 2,000 returned candidates at a time.')
            run=str(payload.get('runId') or '')[:180]
            if not run: raise ClientError(400,'The search run identifier is missing.')
            if not db.execute('SELECT 1 FROM runs WHERE project=? AND id=?',(project,run)).fetchone():
                for paper in papers:
                    key=identity(paper);old=db.execute('SELECT data FROM records WHERE project=? AND id=?',(project,key)).fetchone()
                    row=json.loads(old[0]) if old else blank(paper)
                    row['paper'].update({k:v for k,v in paper_metadata(paper).items() if v})
                    if run not in row['sources']: row['sources'].append(run)
                    db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)',(project,key,json.dumps(row)))
                info=payload.get('runInfo') or {}
                run_data={'id':run,'capturedAt':time.time(),'capturedCandidates':len(papers),
                    'sourceCounts':info.get('sourceCounts') or {},'errors':info.get('errors') or {},
                    'stoppedEarly':bool(info.get('stoppedEarly')),'candidateCount':info.get('candidateCount'),
                    'query':str(payload.get('query') or '')[:1000]}
                db.execute('INSERT INTO runs VALUES (?,?,?)',(project,run,json.dumps(run_data)))
        elif action in ('decision','annotate'):
            request=str(payload.get('requestId') or '')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}',request): raise ClientError(400,'A unique action identifier is required.')
            if not db.execute('SELECT 1 FROM events WHERE project=? AND request=?',(project,request)).fetchone():
                papers=payload.get('papers') or []
                if not isinstance(papers,list) or not 1<=len(papers)<=500 or any(not isinstance(p,dict) for p in papers): raise ClientError(400,'Select 1 to 500 screening records.')
                changes=[];seen=set()
                for paper in papers:
                    key=identity(paper)
                    if key in seen: continue
                    seen.add(key)
                    old=db.execute('SELECT data FROM records WHERE project=? AND id=?',(project,key)).fetchone()
                    before=json.loads(old[0]) if old else blank(paper)
                    if not before['stages'] and action=='decision':
                        prior=paper.get('_priorGrade',payload.get('priorGrade'))
                        if prior not in (None,0,1,2):raise ClientError(400,'The previous relevance grade is invalid.')
                        before['feedbackGrade']=prior
                    after=json.loads(json.dumps(before))
                    if action=='decision':
                        stage,decision=payload.get('stage'),payload.get('decision')
                        reason=str(payload.get('reason') or '').strip()[:500]
                        if stage not in STAGES or decision not in ('include','exclude','pending'): raise ClientError(400,'Choose a screening stage and decision.')
                        if stage=='full-text' and decision=='exclude' and not reason: raise ClientError(400,'Record a reason for full-text exclusion.')
                        after['stages'][stage]={'decision':decision,'reason':reason if decision=='exclude' else '', 'at':time.time()}
                        after['feedbackGrade']=2 if decision=='include' else 0 if decision=='exclude' else None
                    else:
                        if 'memo' in payload: after['memo']=str(payload['memo'])[:10000]
                        if 'tags' in payload:
                            if not isinstance(payload['tags'],list): raise ClientError(400,'Tags must be a list.')
                            after['tags']=list(dict.fromkeys(str(t).strip()[:80] for t in payload['tags'] if str(t).strip()))[:30]
                    db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)',(project,key,json.dumps(after)))
                    changes.append({'id':key,'before':before,'after':after})
                db.execute('INSERT INTO events(project,request,action,changes,created) VALUES (?,?,?,?,?)',(project,request,action,json.dumps(changes),time.time()))
        elif action=='undo':
            request=str(payload.get('requestId') or '')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}',request): raise ClientError(400,'A unique action identifier is required.')
            previous=db.execute('SELECT action,changes FROM events WHERE project=? AND request=?',(project,request)).fetchone()
            undo_info=json.loads(previous[1]) if previous and previous[0]=='undo' else {}
            if not previous:
                event=db.execute("SELECT id,changes,action FROM events WHERE project=? AND undone=0 AND action!='undo' ORDER BY id DESC LIMIT 1",(project,)).fetchone()
                if event:
                    changes=json.loads(event[1])
                    for change in changes:
                        current=json.loads(db.execute('SELECT data FROM records WHERE project=? AND id=?',(project,change['id'])).fetchone()[0])
                        restored=dict(change['before'],paper=current['paper'],sources=current['sources'])
                        db.execute('UPDATE records SET data=? WHERE project=? AND id=?',(json.dumps(restored),project,change['id']))
                    db.execute('UPDATE events SET undone=1 WHERE id=?',(event[0],))
                    undo_info={'event':event[0],'action':event[2],'records':[change['id'] for change in changes]}
                db.execute('INSERT INTO events(project,request,action,changes,created) VALUES (?,?,?,?,?)',(project,request,'undo',json.dumps(undo_info),time.time()))
        data=snapshot(db,project)
        if action=='export':
            data['history']=[{'id':i,'action':a,'changes':json.loads(c),'at':t,'undone':bool(u)} for i,a,c,t,u in db.execute('SELECT id,action,changes,created,undone FROM events WHERE project=? ORDER BY id',(project,))]
            result=export(data,payload.get('format','csv'))
        else: result=dict(data,counts=screening_counts(data))
        if action=='undo': result.update(undoneAction=undo_info.get('action'),undoneRecords=undo_info.get('records',[]))
        db.execute('COMMIT');return result
    except Exception:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    finally: db.close()
