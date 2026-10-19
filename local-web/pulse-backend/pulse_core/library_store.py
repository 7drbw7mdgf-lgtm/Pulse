"""Transactional per-paper storage with a preserved JSON migration checkpoint."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

from pulse_core.constants import APP_VERSION, ClientError, time_iso

PROTECTED = {'papers', '_storageRevision', '_saveSession', '_saveRevision', '_saveMode', '_baseStorageRevision', 'savedAt'}

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

class LibraryStore:
    def __init__(self, legacy_path, legacy_loader, checkpoint):
        self.legacy_path = Path(legacy_path)
        self.path = self.legacy_path.with_suffix('.sqlite3')
        self.legacy_loader = legacy_loader
        self.checkpoint = checkpoint

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor=os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600);os.close(descriptor)
        except FileExistsError: pass
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS workspace (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS paper_tags (paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                tag TEXT NOT NULL, PRIMARY KEY(paper_id, tag));
            CREATE INDEX IF NOT EXISTS paper_tags_tag ON paper_tags(tag, paper_id);
            CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE VIRTUAL TABLE IF NOT EXISTS library_search USING fts5(
                paper_id UNINDEXED, title, authors, keywords, tags, abstract, notes, tokenize='unicode61');
        ''')
        if db.execute("SELECT 1 FROM store_meta WHERE key='initialized'").fetchone() is None:
            legacy = self.legacy_loader()
            if self.legacy_path.exists():
                self.checkpoint(legacy, 'pre_sqlite')
            db.execute('BEGIN IMMEDIATE')
            try:
                if db.execute("SELECT 1 FROM store_meta WHERE key='initialized'").fetchone() is None:
                    papers = legacy.get('papers') or []
                    repaired, seen = [], set()
                    for i, paper in enumerate(papers):
                        paper = dict(paper)
                        identity = paper.get('id')
                        if not isinstance(identity, str) or not identity or identity in seen:
                            identity = uuid.uuid5(uuid.NAMESPACE_URL, encode([i, paper])).hex
                            paper['id'] = identity
                        seen.add(identity);repaired.append(paper)
                    self._write_full(db, dict(legacy, papers=repaired), migration=True)
                    db.execute("INSERT INTO store_meta VALUES ('initialized','1')")
                    db.execute("INSERT OR REPLACE INTO store_meta VALUES ('backupAt',?)", (str(time.time()),))
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK');db.close();raise
        for path in (self.path, Path(str(self.path)+'-wal'), Path(str(self.path)+'-shm')):
            if path.exists():
                try: path.chmod(0o600)
                except OSError: pass
        return db

    @staticmethod
    def _workspace(db):
        return {key:json.loads(value) for key,value in db.execute('SELECT key,value FROM workspace')}

    def read(self):
        db = self.connect()
        try:
            db.execute('BEGIN')
            data = self._workspace(db)
            by_id = {identity:json.loads(raw) for identity,raw in db.execute('SELECT id,data FROM papers')}
            order = data.pop('_paperOrder', list(by_id))
            data['papers'] = [by_id[identity] for identity in order if identity in by_id]
            db.execute('COMMIT')
            return data
        finally: db.close()

    @staticmethod
    def _set(db, key, value):
        raw = encode(value)
        db.execute('INSERT INTO workspace(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value', (key,raw))

    @staticmethod
    def _index_values(paper):
        values = lambda name: [str(x) for x in paper.get(name) or [] if isinstance(x,(str,int,float))] if isinstance(paper.get(name),list) else []
        tags = list(dict.fromkeys(x.casefold().strip() for name in ('userTags','tags','paperKeywords','gemmaKeywords') for x in values(name) if x.strip()))
        keywords = values('paperKeywords') + values('gemmaKeywords')
        return (str(paper.get('title') or ''), ' '.join(values('authors')), ' '.join(keywords),
                ' '.join(tags), str(paper.get('abstract') or ''), str(paper.get('notes') or '')), tags

    def _upsert(self, db, paper):
        identity = paper['id']; raw = encode(paper)
        old = db.execute('SELECT data FROM papers WHERE id=?',(identity,)).fetchone()
        if old and old[0] == raw: return 0
        db.execute('INSERT INTO papers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (identity,raw))
        index, tags = self._index_values(paper)
        if not old or self._index_values(json.loads(old[0])) != (index,tags):
            db.execute('DELETE FROM library_search WHERE paper_id=?',(identity,))
            db.execute('INSERT INTO library_search VALUES (?,?,?,?,?,?,?)',(identity,*index))
            db.execute('DELETE FROM paper_tags WHERE paper_id=?',(identity,))
            db.executemany('INSERT INTO paper_tags VALUES (?,?)',[(identity,tag) for tag in tags])
        return 1

    def _write_full(self, db, payload, migration=False):
        papers = payload.get('papers')
        if not isinstance(papers,list) or not all(isinstance(p,dict) and isinstance(p.get('id'),str) and p['id'] for p in papers):
            raise ClientError(400,'Library papers must have unique IDs.')
        order = [p['id'] for p in papers]
        if len(set(order)) != len(order): raise ClientError(400,'Library paper IDs must be unique.')
        existing = {r[0] for r in db.execute('SELECT id FROM papers')}
        if not papers and existing and not payload.get('allowEmpty') and not payload.get('reset'):
            raise ClientError(409,'An empty autosave cannot replace a saved library. Reload your papers or use Clear papers.')
        removed = existing - set(order)
        for identity in removed:
            db.execute('DELETE FROM library_search WHERE paper_id=?',(identity,))
            db.execute('DELETE FROM papers WHERE id=?',(identity,))
        changed = sum(self._upsert(db,paper) for paper in papers)
        data = {k:v for k,v in payload.items() if k not in {'papers','allowEmpty','_saveMode','_baseStorageRevision'}}
        data.setdefault('format','pulse-map');data.setdefault('version',APP_VERSION)
        if not migration or not data.get('_storageRevision'): data['_storageRevision']=uuid.uuid4().hex
        if not migration: data['savedAt']=time_iso()
        data['_paperOrder']=order
        for key, in db.execute('SELECT key FROM workspace').fetchall():
            if key not in data: db.execute('DELETE FROM workspace WHERE key=?',(key,))
        for key,value in data.items(): self._set(db,key,value)
        return data,changed,len(removed)

    def _write_delta(self, db, payload):
        token=payload.get('_baseStorageRevision')
        if not isinstance(token,str) or not re.fullmatch(r'[a-f0-9]{32}',token):
            raise ClientError(400,'A valid library save baseline is required.')
        row=db.execute("SELECT value FROM workspace WHERE key='_storageRevision'").fetchone()
        if not row or json.loads(row[0]) != token:
            raise ClientError(409,'The saved library changed elsewhere. Your changes are kept locally; reload or use Recovery before saving again.')
        updates,removed,order=payload.get('upsertPapers'),payload.get('removePaperIds'),payload.get('paperOrder')
        changes,missing=payload.get('workspaceChanges'),payload.get('removeWorkspaceKeys')
        if not isinstance(updates,list) or not all(isinstance(p,dict) and isinstance(p.get('id'),str) and p['id'] for p in updates):
            raise ClientError(400,'Changed library papers must have IDs.')
        if not isinstance(removed,list) or not all(isinstance(i,str) for i in removed) or len(set(removed))!=len(removed):
            raise ClientError(400,'Removed library paper IDs must be unique.')
        if not isinstance(order,list) or not all(isinstance(i,str) for i in order) or len(set(order))!=len(order):
            raise ClientError(400,'Library paper order must contain unique IDs.')
        update_ids={p['id'] for p in updates}
        if len(update_ids)!=len(updates) or set(removed)&update_ids:
            raise ClientError(400,'Changed library paper IDs must be unique and cannot also be removed.')
        if not isinstance(changes,dict) or set(changes)&PROTECTED or not isinstance(missing,list) or not all(isinstance(k,str) for k in missing) or set(missing)&PROTECTED or '_paperOrder' in changes or '_paperOrder' in missing:
            raise ClientError(400,'Invalid library workspace changes.')
        existing={r[0] for r in db.execute('SELECT id FROM papers')}
        if not set(removed)<=existing: raise ClientError(409,'Reload the saved library before making incremental changes.')
        if set(order)!=(existing-set(removed))|update_ids: raise ClientError(400,'Library paper order must include every remaining paper.')
        if not order and existing and not changes.get('allowEmpty') and not changes.get('reset'):
            raise ClientError(409,'An empty autosave cannot replace a saved library. Reload your papers or use Clear papers.')
        for identity in removed:
            db.execute('DELETE FROM library_search WHERE paper_id=?',(identity,));db.execute('DELETE FROM papers WHERE id=?',(identity,))
        changed=sum(self._upsert(db,paper) for paper in updates)
        for key in missing: db.execute('DELETE FROM workspace WHERE key=?',(key,))
        data={k:v for k,v in changes.items() if k!='allowEmpty'}
        data.update(_paperOrder=order,_storageRevision=uuid.uuid4().hex,savedAt=time_iso(),
                    _saveSession=payload.get('_saveSession'),_saveRevision=payload.get('_saveRevision'))
        for key,value in data.items(): self._set(db,key,value)
        return data,changed,len(removed)

    def write(self, payload):
        if not isinstance(payload,dict): raise ClientError(400,'Library payload must be a JSON object.')
        db=self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            data,changed,removed=(self._write_delta(db,payload) if payload.get('_saveMode')=='paper-delta-v1' else self._write_full(db,payload))
            # An initial JSON checkpoint supports recovery and moving back to an
            # older app. Subsequent ordinary edits update only SQLite rows.
            has_checkpoint=db.execute("SELECT value FROM store_meta WHERE key='checkpoint'").fetchone()
            last_backup=db.execute("SELECT value FROM store_meta WHERE key='backupAt'").fetchone()
            due=not last_backup or time.time()-float(last_backup[0])>=300
            if not has_checkpoint or due:
                snapshot=self._workspace(db)
                order=snapshot.pop('_paperOrder',[])
                by_id={i:json.loads(raw) for i,raw in db.execute('SELECT id,data FROM papers')}
                snapshot['papers']=[by_id[i] for i in order]
                self.checkpoint(snapshot,'initial' if not has_checkpoint else 'checkpoint')
                db.execute("INSERT OR REPLACE INTO store_meta VALUES ('checkpoint','1')")
                db.execute("INSERT OR REPLACE INTO store_meta VALUES ('backupAt',?)",(str(time.time()),))
            db.execute('COMMIT')
            return {'ok':True,'path':str(self.path),'savedAt':data['savedAt'],'storageRevision':data['_storageRevision'],
                    'deltaSupported':True,'storageType':'sqlite','changedPapers':changed,'removedPapers':removed}
        except Exception:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        finally: db.close()

    def search(self, keywords=(), tags=(), match='all', limit=200, offset=0):
        keywords=list(dict.fromkeys(str(x).strip() for x in keywords if str(x).strip()))[:20]
        tags=list(dict.fromkeys(str(x).casefold().strip() for x in tags if str(x).strip()))[:20]
        clauses=[];params=[]
        for keyword in keywords:
            clauses.append('id IN (SELECT paper_id FROM library_search WHERE library_search MATCH ?)')
            params.append('"'+keyword.replace('"','""')+'"')
        for tag in tags:
            clauses.append('id IN (SELECT paper_id FROM paper_tags WHERE tag=?)');params.append(tag)
        where=(' OR ' if match=='any' else ' AND ').join(clauses) or '1'
        db=self.connect()
        try:
            total=db.execute('SELECT COUNT(*) FROM papers WHERE '+where,params).fetchone()[0]
            rows=db.execute('SELECT data FROM papers WHERE '+where+' ORDER BY id LIMIT ? OFFSET ?',(*params,max(1,min(int(limit),500)),max(0,int(offset)))).fetchall()
            return {'ok':True,'total':total,'papers':[json.loads(row[0]) for row in rows]}
        finally: db.close()
