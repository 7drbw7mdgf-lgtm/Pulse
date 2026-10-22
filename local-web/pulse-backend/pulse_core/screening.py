"""Local screening projects with an append-only decision history and honest exports."""
import copy
import csv
import hashlib
import html
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


def generate_prisma_svg(data):
    c = screening_counts(data)
    total_captured = c.get('recordsCapturedInPulse', 0)
    ta_screened = c.get('recordsScreened', 0)
    ta_excluded = c.get('recordsExcluded', 0)
    ft_assessed = c.get('reportsAssessedForEligibility', 0)
    ft_excluded = c.get('reportsExcluded', 0)
    included = c.get('reportsIncluded', 0)
    reasons = c.get('fullTextExclusionReasons') or {}

    reason_lines = []
    for r, count in list(reasons.items())[:5]:
        reason_lines.append(f"• {html.escape(r[:30])}: {count}")
    if not reason_lines:
        reason_lines = ["• None recorded"]
    reasons_text = "<tspan x='560' dy='16'>" + "</tspan><tspan x='560' dy='16'>".join(reason_lines) + "</tspan>"

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 680" width="850" height="680" style="background:#ffffff; font-family:system-ui, -apple-system, sans-serif;">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#0284c7" />
    </marker>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/>
    </filter>
  </defs>

  <text x="425" y="36" text-anchor="middle" font-size="20" font-weight="700" fill="#0f172a">PRISMA 2020 Flow Diagram</text>
  <text x="425" y="58" text-anchor="middle" font-size="12" fill="#64748b">Generated by Pulse · Systematic Literature Screening</text>

  <rect x="50" y="80" width="120" height="30" rx="4" fill="#0284c7" />
  <text x="110" y="100" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">Identification</text>
  <rect x="220" y="80" width="280" height="60" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="360" y="105" text-anchor="middle" font-size="13" font-weight="600" fill="#1e293b">Records identified from databases</text>
  <text x="360" y="125" text-anchor="middle" font-size="12" fill="#0284c7" font-weight="600">(n = {total_captured})</text>

  <line x1="360" y1="140" x2="360" y2="200" stroke="#0284c7" stroke-width="2" marker-end="url(#arrow)"/>

  <rect x="50" y="200" width="120" height="30" rx="4" fill="#0284c7" />
  <text x="110" y="220" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">Screening</text>
  <rect x="220" y="200" width="280" height="60" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="360" y="225" text-anchor="middle" font-size="13" font-weight="600" fill="#1e293b">Records screened (Title/Abstract)</text>
  <text x="360" y="245" text-anchor="middle" font-size="12" fill="#0284c7" font-weight="600">(n = {ta_screened})</text>

  <line x1="500" y1="230" x2="550" y2="230" stroke="#0284c7" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="550" y="200" width="250" height="60" rx="6" fill="#fff1f2" stroke="#fecdd3" stroke-width="1.5"/>
  <text x="675" y="225" text-anchor="middle" font-size="13" font-weight="600" fill="#9f1239">Records excluded</text>
  <text x="675" y="245" text-anchor="middle" font-size="12" fill="#e11d48" font-weight="600">(n = {ta_excluded})</text>

  <line x1="360" y1="260" x2="360" y2="340" stroke="#0284c7" stroke-width="2" marker-end="url(#arrow)"/>

  <rect x="50" y="340" width="120" height="30" rx="4" fill="#0284c7" />
  <text x="110" y="360" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">Eligibility</text>
  <rect x="220" y="340" width="280" height="60" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="360" y="365" text-anchor="middle" font-size="13" font-weight="600" fill="#1e293b">Reports assessed for eligibility</text>
  <text x="360" y="385" text-anchor="middle" font-size="12" fill="#0284c7" font-weight="600">(n = {ft_assessed})</text>

  <line x1="500" y1="370" x2="550" y2="370" stroke="#0284c7" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="550" y="330" width="250" height="130" rx="6" fill="#fff1f2" stroke="#fecdd3" stroke-width="1.5"/>
  <text x="675" y="355" text-anchor="middle" font-size="13" font-weight="600" fill="#9f1239">Reports excluded (n = {ft_excluded})</text>
  <text x="560" y="375" font-size="11" fill="#475569">{reasons_text}</text>

  <line x1="360" y1="400" x2="360" y2="520" stroke="#0284c7" stroke-width="2" marker-end="url(#arrow)"/>

  <rect x="50" y="520" width="120" height="30" rx="4" fill="#0284c7" />
  <text x="110" y="540" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">Included</text>
  <rect x="220" y="520" width="280" height="70" rx="6" fill="#f0fdf4" stroke="#86efac" stroke-width="2" filter="url(#shadow)"/>
  <text x="360" y="550" text-anchor="middle" font-size="14" font-weight="700" fill="#15803d">Studies included in review</text>
  <text x="360" y="572" text-anchor="middle" font-size="13" fill="#16a34a" font-weight="700">(n = {included})</text>
</svg>"""

def export_blind_project(data):
    blind_data = copy.deepcopy(data)
    for key, row in blind_data.get('records', {}).items():
        row['stages'] = {}
        row['memo'] = ''
        row['feedbackGrade'] = None
    return blind_data

def reconcile(db, project, reviewer2_data):
    r1_records = records(db, project)
    r2_records = reviewer2_data.get('records') if isinstance(reviewer2_data, dict) else {}
    all_keys = set(r1_records) | set(r2_records)
    if not all_keys:
        return {'concordant': 0, 'discrepant': 0, 'kappa': 1.0, 'discrepancies': []}

    concordant = 0
    discrepant = 0
    discrepancies = []
    both_yes, both_no, yes_no, no_yes = 0, 0, 0, 0

    for key in sorted(all_keys):
        r1 = r1_records.get(key, {})
        r2 = r2_records.get(key, {})
        d1 = r1.get('stages', {}).get('title-abstract', {}).get('decision') or 'pending'
        d2 = r2.get('stages', {}).get('title-abstract', {}).get('decision') or 'pending'

        if d1 == d2 and d1 != 'pending':
            concordant += 1
            if d1 == 'include': both_yes += 1
            elif d1 == 'exclude': both_no += 1
        elif d1 != 'pending' and d2 != 'pending':
            discrepant += 1
            if d1 == 'include' and d2 == 'exclude': yes_no += 1
            elif d1 == 'exclude' and d2 == 'include': no_yes += 1
            discrepancies.append({
                'recordId': key,
                'title': r1.get('paper', {}).get('title') or r2.get('paper', {}).get('title'),
                'reviewer1': d1,
                'reviewer2': d2,
                'reason1': r1.get('stages', {}).get('title-abstract', {}).get('reason'),
                'reason2': r2.get('stages', {}).get('title-abstract', {}).get('reason'),
            })

    total_judged = both_yes + both_no + yes_no + no_yes
    if total_judged > 0:
        po = (both_yes + both_no) / total_judged
        pyes = ((both_yes + yes_no) / total_judged) * ((both_yes + no_yes) / total_judged)
        pno = ((both_no + no_yes) / total_judged) * ((both_no + yes_no) / total_judged)
        pe = pyes + pno
        kappa = (po - pe) / (1 - pe) if pe < 1.0 else 1.0
    else:
        kappa = 1.0

    return {
        'totalEvaluated': len(all_keys),
        'totalJudgedByBoth': total_judged,
        'concordant': concordant,
        'discrepant': discrepant,
        'kappa': round(kappa, 3),
        'discrepancies': discrepancies[:100],
    }

def export(data,fmt):
    if fmt=='prisma-svg': return {'filename':'pulse-prisma-flowchart.svg','mime':'image/svg+xml','content':generate_prisma_svg(data)}
    if fmt=='blind-json': return {'filename':'pulse-screening-blind.json','mime':'application/json','content':json.dumps(export_blind_project(data),indent=2)}
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
    raise ClientError(400,'Choose RIS, CSV, JSON, blind JSON or PRISMA working data/SVG.')


def handle(payload,directory=None):
    action=payload.get('action','open')
    if action not in ('open','list','ingest','decision','annotate','undo','export','reconcile'): raise ClientError(400,'Unknown screening action.')
    context=payload.get('context')
    project=payload.get('project') or (hashlib.sha256(str(context).encode()).hexdigest() if context else '')
    if action!='list' and not re.fullmatch(r'[a-f0-9]{64}',str(project)): raise ClientError(400,'Choose a screening project.')
    db=connect(directory)
    try:
        if action=='list': return {'projects':[{'id':i,'name':n} for i,n in db.execute('SELECT id,name FROM projects ORDER BY created DESC')]}
        if action=='reconcile': return reconcile(db, project, payload.get('reviewer2') or {})
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
