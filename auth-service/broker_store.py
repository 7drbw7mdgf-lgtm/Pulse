"""Encrypted tokens and one-use device claims, with transactional SQLite state."""
import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from cryptography.fernet import Fernet
from provider import Failure

def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def challenge(verifier): return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).rstrip(b'=').decode()

class Store:
    def __init__(self,path,key):
        path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
        self.crypto=Fernet(key.encode());self.lock=threading.RLock()
        self.db=sqlite3.connect(path,check_same_thread=False);self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, state TEXT UNIQUE, cookie TEXT, expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0, tokens TEXT, account TEXT, session_id TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, tokens TEXT NOT NULL, account TEXT NOT NULL, expires REAL NOT NULL, created REAL NOT NULL);''')
        path.chmod(0o600)
    def begin(self,proof):
        identity=secrets.token_urlsafe(32)
        with self.lock,self.db:
            self.db.execute('DELETE FROM attempts WHERE expires<?',(time.time(),))
            self.db.execute('DELETE FROM sessions WHERE expires<?',(time.time(),))
            count=self.db.execute('SELECT count(*) FROM attempts').fetchone()[0]
            if count>=10000: raise Failure(429,'Too many pending sign-ins. Try again later.')
            self.db.execute('INSERT INTO attempts(id,challenge,expires) VALUES(?,?,?)',(identity,proof,time.time()+600))
        return identity
    def authorize(self,identity):
        state=secrets.token_urlsafe(32);cookie=secrets.token_urlsafe(32)
        with self.lock,self.db:
            row=self.db.execute('SELECT * FROM attempts WHERE id=?',(identity,)).fetchone()
            if not row or row['expires']<=time.time() or row['state']: raise Failure(400,'Sign-in is invalid or expired. Start again in Pulse.')
            self.db.execute('UPDATE attempts SET state=?,cookie=? WHERE id=?',(state,digest(cookie),identity))
        return state,cookie
    def accept(self,state,cookie):
        with self.lock,self.db:
            row=self.db.execute('SELECT * FROM attempts WHERE state=?',(state,)).fetchone()
            if not row or row['expires']<=time.time() or row['used'] or not hmac.compare_digest(row['cookie'],digest(cookie)):
                raise Failure(400,'This sign-in response is invalid or expired.')
            self.db.execute('UPDATE attempts SET used=1 WHERE id=?',(row['id'],))
        return row['id']
    def fail(self,identity):
        with self.lock,self.db:self.db.execute('UPDATE attempts SET used=2 WHERE id=?',(identity,))
    def complete(self,identity,tokens,account):
        safe=self.crypto.encrypt(json.dumps(tokens).encode()).decode()
        with self.lock,self.db:
            changed=self.db.execute('UPDATE attempts SET tokens=?,account=? WHERE id=? AND expires>? AND used=1',(safe,account,identity,time.time())).rowcount
            if not changed: raise Failure(400,'This sign-in has expired.')
    def claim(self,identity,verifier):
        with self.lock,self.db:
            row=self.db.execute('SELECT * FROM attempts WHERE id=?',(identity,)).fetchone()
            if not row or row['expires']<=time.time() or not hmac.compare_digest(row['challenge'],challenge(verifier)):
                raise Failure(400,'This sign-in claim is invalid or expired.')
            if row['session_id']: raise Failure(409,'This sign-in has already been claimed.')
            if not row['tokens']:
                if row['used']==2: raise Failure(400,'Sign-in could not finish. Connect again in Pulse.')
                return {'pending':True}
            session=secrets.token_urlsafe(48);now=time.time()
            self.db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',(digest(session),row['tokens'],row['account'],now+30*86400,now))
            # Retain a one-use tombstone briefly, but remove account tokens from the attempt.
            self.db.execute('UPDATE attempts SET tokens=NULL,account=NULL,session_id=? WHERE id=?',(digest(session),identity))
            return {'pending':False,'session':session,'accountId':row['account']}
    def get_session(self,session):
        with self.lock:
            row=self.db.execute('SELECT * FROM sessions WHERE id=?',(digest(session),)).fetchone()
        if not row or row['expires']<=time.time() or row['created']+90*86400<=time.time(): raise Failure(401,'Connect your Mendeley account again.')
        return dict(tokens=json.loads(self.crypto.decrypt(row['tokens'].encode())),account=row['account'])
    def update(self,session,tokens):
        safe=self.crypto.encrypt(json.dumps(tokens).encode()).decode()
        with self.lock,self.db:
            changed=self.db.execute('UPDATE sessions SET tokens=?,expires=MIN(created+?,?) WHERE id=? AND expires>?',
                (safe,90*86400,time.time()+30*86400,digest(session),time.time())).rowcount
            if not changed: raise Failure(401,'The connection has been disconnected.')
    def revoke(self,session):
        with self.lock,self.db:self.db.execute('DELETE FROM sessions WHERE id=?',(digest(session),))
