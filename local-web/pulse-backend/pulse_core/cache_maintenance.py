"""Bounded maintenance of public search responses; never touches the user's library."""
import sqlite3
import threading
import time
from pathlib import Path
from pulse_core.constants import ClientError
from pulse_core.platform_support import config_directory

_lock=threading.Lock()
_started=False
MAX_BYTES=256*1024*1024
MAX_ROWS=10000


def maintain(directory=None,max_bytes=MAX_BYTES,max_rows=MAX_ROWS):
    path=Path(directory or config_directory())/'http-cache.sqlite3'
    if not path.is_file(): return {'entries':0,'bytes':0,'removed':0}
    with _lock:
        db=sqlite3.connect(path,timeout=.5)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='http_cache'").fetchone(): return {'entries':0,'bytes':0,'removed':0}
            before=db.total_changes
            db.execute('DELETE FROM http_cache WHERE expires_at<=?',(time.time(),))
            # Stable identifier/citation responses outlive free-text queries, but
            # all entries still expire; citation counts and notices can change.
            rows=db.execute('SELECT key,size FROM http_cache ORDER BY (expires_at-used>86400) DESC,used DESC').fetchall()
            used=0;remove=[];kept=0
            for key,size in rows:
                if kept>=max_rows or used+size>max_bytes: remove.append((key,))
                else: used+=size;kept+=1
            db.executemany('DELETE FROM http_cache WHERE key=?',remove)
            removed=db.total_changes-before
            db.commit()
            db.execute('PRAGMA optimize')
            return {'entries':kept,'bytes':used,'removed':removed,'metadataTtlDays':7,'queryTtlMinutes':15}
        finally: db.close()


def status(directory=None):
    path=Path(directory or config_directory())/'http-cache.sqlite3'
    if not path.is_file(): return {'entries':0,'bytes':0}
    db=sqlite3.connect(path,timeout=.5)
    try:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='http_cache'").fetchone():return {'entries':0,'bytes':0}
        count,size=db.execute('SELECT COUNT(*),COALESCE(SUM(size),0) FROM http_cache').fetchone()
        return {'entries':count,'bytes':size,'metadataTtlDays':7,'queryTtlMinutes':15}
    finally:db.close()


def idle():
    from pulse_core import discovery
    return not discovery._ACTIVE_SEARCHES[0]


def handle(payload):
    if payload.get('action')=='clean':
        if not idle(): raise ClientError(409,'Wait for the active search to finish before cleaning its cache.')
        return maintain()
    return status()


def start():
    global _started
    if _started:return
    _started=True
    def worker():
        time.sleep(15)
        while True:
            try:
                if idle():maintain()
            except (OSError,sqlite3.Error):pass
            time.sleep(3600)
    threading.Thread(target=worker,name='pulse-cache-maintenance',daemon=True).start()
