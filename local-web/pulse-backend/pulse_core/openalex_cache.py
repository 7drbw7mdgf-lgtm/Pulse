"""Public work metadata shared across singleton, search and batch lookups."""
import json
import os
import re
import sqlite3
import time
import urllib.parse
from pulse_core.doi_utils import normalize_doi
from pulse_core.platform_support import config_directory

TTL = 7 * 86400
MAX_WORKS = 5000


def _query(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'api.openalex.org': return None
    return parsed, urllib.parse.parse_qs(parsed.query)


def _connect():
    folder = config_directory()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / 'openalex-works.sqlite3'
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except FileExistsError: pass
    db = sqlite3.connect(path, timeout=.25)
    db.execute('CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, doi TEXT, data TEXT NOT NULL, full INTEGER NOT NULL, expires REAL NOT NULL, used REAL NOT NULL)')
    db.execute('CREATE INDEX IF NOT EXISTS works_doi ON works(doi)')
    return db


def cached_work(url):
    query = _query(url)
    if not query: return None
    parsed, params = query
    if not parsed.path.startswith('/works/') or set(params) - {'select', 'api_key', 'mailto'}: return None
    ident = urllib.parse.unquote(parsed.path[len('/works/'):])
    work_id = ident.upper() if re.fullmatch(r'W\d+', ident, re.I) else ''
    doi = normalize_doi(ident).casefold() if not work_id else ''
    if not work_id and not doi: return None
    db = None
    try:
        db = _connect()
        row = db.execute('SELECT data,full FROM works WHERE '+('id=?' if work_id else 'doi=?')+' AND expires>? ORDER BY used DESC LIMIT 1',
                         (work_id or doi, time.time())).fetchone()
        if not row: return None
        data = json.loads(row[0])
        fields = set(params.get('select', [''])[0].split(',')) - {''}
        if not fields <= data.keys() or (not fields and not row[1]): return None
        return {key:data[key] for key in fields} if fields else data
    except (sqlite3.Error, OSError, ValueError): return None
    finally:
        if db is not None: db.close()


def remember_works(url, response):
    query = _query(url)
    if not query or not isinstance(response, dict): return
    parsed, params = query
    if not (parsed.path == '/works' or parsed.path.startswith('/works/')): return
    works = response.get('results') if isinstance(response.get('results'), list) else [response]
    works = [work for work in works if isinstance(work, dict) and re.fullmatch(r'(?:https://openalex.org/)?W\d+', str(work.get('id') or ''))]
    if not works: return
    db = None
    try:
        db = _connect()
        now = time.time()
        for work in works:
            ident = work['id'].rsplit('/', 1)[-1]
            data, full, expires = work, int('select' not in params), now+TTL
            prior = db.execute('SELECT data,full,expires FROM works WHERE id=? AND expires>?', (ident, now)).fetchone()
            if prior:
                previous = json.loads(prior[0])
                # Partial responses may enrich an entity, but cannot extend the
                # lifetime of fields absent from the new response.
                if not full and not previous.keys() <= work.keys():
                    data = dict(previous, **work)
                    full, expires = prior[1], prior[2]
            raw = json.dumps(data, separators=(',', ':'))
            if len(raw.encode()) > 256_000: continue
            db.execute('INSERT OR REPLACE INTO works VALUES (?,?,?,?,?,?)',
                       (ident, normalize_doi(data.get('doi')).casefold(), raw, full, expires, now))
        db.execute('DELETE FROM works WHERE expires<=?', (now,))
        db.execute('DELETE FROM works WHERE id IN (SELECT id FROM works ORDER BY used DESC LIMIT -1 OFFSET ?)', (MAX_WORKS,))
        db.commit()
    except (sqlite3.Error, OSError, ValueError, TypeError): pass
    finally:
        if db is not None: db.close()


def cached_batch(work_ids, select):
    fields = set(select.split(',')) if select else set()
    found, db = {}, None
    try:
        db = _connect()
        for start in range(0, len(work_ids), 100):
            group = work_ids[start:start+100]
            placeholders = ','.join('?' for _ in group)
            for ident, raw, full in db.execute('SELECT id,data,full FROM works WHERE expires>? AND id IN ('+placeholders+')', (time.time(), *group)):
                data = json.loads(raw)
                if fields <= data.keys() and (fields or full): found[ident] = {key:data[key] for key in fields} if fields else data
        return found
    except (sqlite3.Error, OSError, ValueError): return {}
    finally:
        if db is not None: db.close()
