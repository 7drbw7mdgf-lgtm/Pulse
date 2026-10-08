"""Pulse's confidential Mendeley sign-in service; put behind the included TLS proxy."""
import base64
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.parse
from broker_store import Store, digest
from provider import Failure, call, token, validate_path

class Service:
    def __init__(self,origin,client_id,secret,key,database):
        target=urllib.parse.urlsplit(origin)
        if target.scheme!='https' or not target.hostname or target.username or target.password or target.path not in {'','/'} or target.query or target.fragment:
            raise ValueError('PULSE_AUTH_ORIGIN must be an HTTPS origin.')
        if not client_id or not secret: raise ValueError('Registered Mendeley application credentials are required.')
        self.origin=origin.rstrip('/');self.host=target.netloc;self.client_id=client_id;self.secret=secret
        self.redirect=self.origin+'/oauth/callback';self.store=Store(database,key)
        self.guard=threading.Lock();self.locks={};self.rates={}
    def rate(self,peer,start=False):
        now=time.time();key=(peer,'start' if start else 'api');limit=20 if start else 240
        with self.guard:
            if len(self.rates)>10000:self.rates={k:v for k,v in self.rates.items() if now-v[0]<60}
            epoch,count=self.rates.get(key,(now,0))
            if now-epoch>=60:epoch,count=now,0
            if count>=limit:raise Failure(429,'Please wait before trying again.')
            self.rates[key]=(epoch,count+1)
    @contextmanager
    def session_lock(self,session):
        identity=digest(session)
        with self.guard:
            entry=self.locks.setdefault(identity,[threading.RLock(),0]);entry[1]+=1
        entry[0].acquire()
        try:yield
        finally:
            entry[0].release()
            with self.guard:
                entry[1]-=1
                if not entry[1]:self.locks.pop(identity,None)
    def library(self,session,path,method='GET',data=None):
        validate_path(path,method)
        if method == 'GET' and data is not None: raise Failure(400,'GET requests cannot include document data.')
        with self.session_lock(session):
            account=self.store.get_session(session);tokens=account['tokens']
            if tokens['expires']<=time.time()+60:
                fresh=token(self.client_id,self.secret,self.redirect,{'grant_type':'refresh_token','refresh_token':tokens['refresh']})
                fresh['expires']=time.time()+fresh.pop('lifetime');tokens=fresh
                # Do not reconnect a session deleted during a delayed refresh.
                self.store.update(session,tokens)
            content,following=call(path,method,json.dumps(data).encode() if data is not None else None,
                {'Authorization':'Bearer '+tokens['access'],'Content-Type':'application/vnd.mendeley-document.1+json','Accept':'application/json' if path.split('?')[0]=='/profiles/v2/me' else 'application/vnd.mendeley-document.1+json'})
            self.store.update(session,tokens)
            return {'data':content,'next':following,'accountId':account['account']}

def handler(service):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def setup(self):
            super().setup();self.connection.settimeout(5)
        def send(self,status,value,headers=None):
            raw=json.dumps(value).encode() if isinstance(value,dict) else value.encode()
            self.send_response(status)
            for key,val in {'Content-Type':'application/json' if isinstance(value,dict) else 'text/html; charset=utf-8','Content-Length':str(len(raw)),
                'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
                'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",**(headers or {})}.items():self.send_header(key,val)
            self.end_headers();self.wfile.write(raw)
        def error(self,error):self.send(error.status,{'error':str(error)})
        def body(self):
            if self.headers.get('Transfer-Encoding') or self.headers.get_content_type()!='application/json':raise Failure(400,'Send a JSON request.')
            try:size=int(self.headers.get('Content-Length','0'))
            except ValueError:raise Failure(400,'Invalid request length.')
            if not 0<size<=32768:raise Failure(413,'Request is too large.')
            try:
                payload=json.loads(self.rfile.read(size))
                if not isinstance(payload,dict):raise ValueError()
                return payload
            except (ValueError,OSError):raise Failure(400,'Invalid JSON request.')
        def check(self):
            if self.headers.get('Host')!=service.host:raise Failure(400,'Invalid service host.')
            if self.headers.get('Origin') and self.headers['Origin']!=service.origin:raise Failure(403,'Cross-site requests are not permitted.')
            peer=self.client_address[0]
            # Only enable when the broker port is private and the included proxy overwrites this header.
            if os.environ.get('PULSE_TRUST_PROXY')=='1':peer=self.headers.get('X-Pulse-Client-IP',peer)
            service.rate(peer,self.path=='/start')
        def session(self):
            value=self.headers.get('Authorization','')
            if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{64}',value):raise Failure(401,'Connect your Mendeley account first.')
            return value[7:]
        def do_GET(self):
            try:
                target=urllib.parse.urlsplit(self.path)
                if target.path=='/health':self.send(200,{'ok':True,'service':'pulse-mendeley','protocol':1});return
                self.check();fields=urllib.parse.parse_qs(target.query,keep_blank_values=True)
                if any(len(v)!=1 for v in fields.values()):raise Failure(400,'Invalid sign-in response.')
                if target.path=='/authorize':
                    identity=fields.get('request',[''])[0];state,cookie=service.store.authorize(identity)
                    url='https://api.mendeley.com/oauth/authorize?'+urllib.parse.urlencode({'client_id':service.client_id,'redirect_uri':service.redirect,'response_type':'code','scope':'all','state':state})
                    self.send(303,'',{'Location':url,'Set-Cookie':'pulse_auth='+cookie+'; Secure; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600'});return
                if target.path=='/oauth/callback':
                    cookies=SimpleCookie();cookies.load(self.headers.get('Cookie',''))
                    cookie=cookies.get('pulse_auth');identity=service.store.accept(fields.get('state',[''])[0],cookie.value if cookie else '')
                    try:
                        if fields.get('error'):raise Failure(400,'Sign-in was declined.')
                        code=fields.get('code',[''])[0]
                        if not 1<=len(code)<=4096 or any(ord(c)<33 or ord(c)>126 for c in code):raise Failure(400,'Invalid sign-in response.')
                        tokens=token(service.client_id,service.secret,service.redirect,{'grant_type':'authorization_code','code':code})
                        profile,_=call('/profiles/v2/me',headers={'Authorization':'Bearer '+tokens['access'],'Accept':'application/json'})
                        if not isinstance(profile,dict) or not isinstance(profile.get('id'),str) or not profile['id']:raise Failure(502,'The account could not be confirmed.')
                        tokens['expires']=time.time()+tokens.pop('lifetime');service.store.complete(identity,tokens,profile['id'])
                        message='Mendeley connected. Return to Pulse to sync your library.';status=200
                    except Failure:
                        service.store.fail(identity);message='Sign-in could not finish. Return to Pulse and connect again.';status=400
                    # No authorization code or account credential is ever rendered in the page.
                    nonce=secrets.token_urlsafe(24)
                    page='<html lang="en"><meta charset="utf-8"><title>Mendeley connection</title><style>body{font:17px system-ui;max-width:520px;margin:15vh auto;padding:24px;line-height:1.6}</style><h1>Mendeley connection</h1><p>'+message+'</p><script nonce="'+nonce+'">history.replaceState(null,"",location.pathname)</script></html>'
                    self.send(status,page,{'Set-Cookie':'pulse_auth=; Secure; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0',
                        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'; frame-ancestors 'none'; base-uri 'none'"});return
                raise Failure(404,'Unknown service endpoint.')
            except Failure as error:self.error(error)
            except Exception:self.send(500,{'error':'The connection could not be completed.'})
        def do_POST(self):
            try:
                self.check();payload=self.body()
                if self.path=='/start':
                    proof=payload.get('challenge')
                    if not isinstance(proof,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',proof):raise Failure(400,'Invalid device proof.')
                    identity=service.store.begin(proof)
                    self.send(200,{'requestId':identity,'authorizationUrl':service.origin+'/authorize?'+urllib.parse.urlencode({'request':identity})});return
                if self.path=='/claim':
                    verifier=payload.get('verifier');identity=payload.get('requestId')
                    if not isinstance(identity,str) or not isinstance(verifier,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',verifier):raise Failure(400,'Invalid device claim.')
                    self.send(200,service.store.claim(identity,verifier));return
                session=self.session()
                if self.path=='/disconnect':service.store.revoke(session);self.send(200,{'ok':True});return
                if self.path=='/library':
                    method=payload.get('method','GET');data=payload.get('data')
                    if method=='POST':
                        if not isinstance(data,dict) or not isinstance(data.get('title'),str) or not data['title'].strip():raise Failure(400,'A paper title is required.')
                        if set(data)-{'type','title','source','abstract','authors','identifiers','year','volume','issue','pages','publisher','language','keywords','websites','month','day'}:raise Failure(400,'Only bibliographic metadata can be sent.')
                    self.send(200,service.library(session,payload.get('path'),method,data));return
                raise Failure(404,'Unknown service endpoint.')
            except Failure as error:self.error(error)
            except Exception:self.send(500,{'error':'The library request could not be completed.'})
    return Handler

class Server(HTTPServer):
    def __init__(self,*args):
        super().__init__(*args);self.pool=ThreadPoolExecutor(max_workers=32);self.slots=threading.BoundedSemaphore(64)
    def process_request(self,request,address):
        if not self.slots.acquire(False):self.shutdown_request(request);return
        self.pool.submit(self.work,request,address)
    def work(self,request,address):
        try:self.finish_request(request,address)
        finally:self.shutdown_request(request);self.slots.release()
    def server_close(self):
        super().server_close();self.pool.shutdown(wait=True)

if __name__=='__main__':
    service=Service(os.environ['PULSE_AUTH_ORIGIN'],os.environ['MENDELEY_CLIENT_ID'],os.environ['MENDELEY_CLIENT_SECRET'],os.environ['PULSE_TOKEN_KEY'],os.environ.get('PULSE_AUTH_DATABASE','/data/auth.sqlite'))
    server=Server(('0.0.0.0',int(os.environ.get('PORT','8000'))),handler(service))
    try:server.serve_forever()
    finally:server.server_close()
