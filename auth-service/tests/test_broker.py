import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cryptography.fernet import Fernet
from broker import Service, Server, handler
from broker_store import Store, challenge
from provider import Failure, validate_path

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=Store(Path(self.temp.name)/'auth.sqlite',Fernet.generate_key().decode())
        self.verifier='v'*64;self.identity=self.store.begin(challenge(self.verifier))
    def tearDown(self): self.store.db.close();self.temp.cleanup()
    def finish(self):
        state,cookie=self.store.authorize(self.identity);self.store.accept(state,cookie)
        self.store.complete(self.identity,{'access':'PRIVATE_ACCESS','refresh':'PRIVATE_REFRESH','expires':time.time()+3600},'account-one')
        return self.store.claim(self.identity,self.verifier)['session']
    def test_proof_cookie_and_replay(self):
        with self.assertRaises(Failure): self.store.claim(self.identity,'wrong'*16)
        state,cookie=self.store.authorize(self.identity)
        with self.assertRaises(Failure): self.store.accept(state,'wrong')
        self.assertEqual(self.store.accept(state,cookie),self.identity)
        with self.assertRaises(Failure): self.store.accept(state,cookie)
        self.assertTrue(self.store.claim(self.identity,self.verifier)['pending'])
        self.store.complete(self.identity,{'access':'a','refresh':'r','expires':time.time()+3600},'one')
        self.store.claim(self.identity,self.verifier)
        with self.assertRaises(Failure): self.store.claim(self.identity,self.verifier)
    def test_tokens_encrypted_and_sessions_hashed(self):
        session=self.finish()
        row=self.store.db.execute('SELECT * FROM sessions').fetchone()
        self.assertNotIn('PRIVATE_ACCESS',row['tokens']);self.assertNotIn(session,row['id'])
        self.assertEqual(self.store.get_session(session)['account'],'account-one')
        self.assertEqual((Path(self.temp.name)/'auth.sqlite').stat().st_mode&0o777,0o600)
    def test_disconnect_cannot_be_reversed_by_delayed_refresh(self):
        session=self.finish();self.store.revoke(session)
        with self.assertRaises(Failure): self.store.update(session,{'access':'new','refresh':'new'})
        with self.assertRaises(Failure): self.store.get_session(session)
    def test_expired_claim_and_callback_rejected(self):
        state,cookie=self.store.authorize(self.identity)
        with self.store.db:self.store.db.execute('UPDATE attempts SET expires=0')
        with self.assertRaises(Failure): self.store.accept(state,cookie)
        with self.assertRaises(Failure): self.store.claim(self.identity,self.verifier)
    def test_failed_callback_does_not_poll_forever(self):
        self.store.fail(self.identity)
        with self.assertRaises(Failure):self.store.claim(self.identity,self.verifier)
    def test_two_sessions_stay_separate(self):
        one=self.finish();other=self.store.begin(challenge('x'*64));state,cookie=self.store.authorize(other);self.store.accept(state,cookie)
        self.store.complete(other,{'access':'other','refresh':'other','expires':time.time()+3600},'account-two');two=self.store.claim(other,'x'*64)['session']
        self.store.revoke(one);self.assertEqual(self.store.get_session(two)['account'],'account-two')

class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.service=Service('https://auth.example','example-id','SERVER_SECRET',Fernet.generate_key().decode(),Path(self.temp.name)/'auth.sqlite')
        self.server=Server(('127.0.0.1',0),handler(self.service));self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self): self.server.shutdown();self.server.server_close();self.thread.join();self.service.store.db.close();self.temp.cleanup()
    def send(self,path,method='GET',body=None,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        conn.request(method,path,json.dumps(body) if body is not None else None,{'Host':'auth.example',**({'Content-Type':'application/json'} if body is not None else {}),**(headers or {})})
        response=conn.getresponse();data=response.read().decode();result=(response.status,dict(response.getheaders()),data);conn.close();return result
    def auth(self,account='me'):
        status,_,raw=self.send('/start','POST',{'challenge':challenge('v'*64)});self.assertEqual(status,200);identity=json.loads(raw)['requestId']
        status,headers,_=self.send('/authorize?request='+identity);self.assertEqual(status,303)
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(headers['Location']).query);state=query['state'][0];cookie=headers['Set-Cookie'].split(';')[0]
        with patch('broker.token',return_value={'access':'PROVIDER_ACCESS','refresh':'PROVIDER_REFRESH','lifetime':3600}),patch('broker.call',return_value=({'id':account},None)):
            status,_,page=self.send('/oauth/callback?'+urllib.parse.urlencode({'state':state,'code':'SHORT_CODE'}),headers={'Cookie':cookie})
        self.assertEqual(status,200)
        for secret in ['PROVIDER_ACCESS','PROVIDER_REFRESH','SERVER_SECRET','SHORT_CODE']:self.assertNotIn(secret,page)
        status,_,raw=self.send('/claim','POST',{'requestId':identity,'verifier':'v'*64});self.assertEqual(status,200)
        result=json.loads(raw);self.assertNotIn('access',result);return result['session']
    def test_flow_and_metadata_only_proxy(self):
        session=self.auth()
        with patch('broker.call',return_value=([{'id':'d','title':'Test title'}],'/documents?marker=next&limit=100')) as provider:
            status,_,raw=self.send('/library','POST',{'path':'/documents?limit=100','method':'GET'},headers={'Authorization':'Bearer '+session})
        self.assertEqual(status,200);self.assertEqual(json.loads(raw)['accountId'],'me');self.assertIn('PROVIDER_ACCESS',provider.call_args[0][3]['Authorization'])
        self.assertEqual(self.send('/library','POST',{'path':'/documents','method':'POST','data':{'title':'Test','fullText':'PRIVATE'}},headers={'Authorization':'Bearer '+session})[0],400)
        self.assertEqual(self.send('/disconnect','POST',{},headers={'Authorization':'Bearer '+session})[0],200)
        self.assertEqual(self.send('/library','POST',{'path':'/documents'},headers={'Authorization':'Bearer '+session})[0],401)
    def test_host_origin_path_and_request_limits(self):
        self.assertEqual(self.send('/start','POST',{'challenge':challenge('v'*64)},headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.send('/start','POST',{'challenge':challenge('v'*64)},headers={'Host':'evil.example'})[0],400)
        self.assertEqual(self.send('/start','POST',{'challenge':'x'*40000})[0],413)
        for path in ['https://evil.example/documents','//evil.example/documents','/oauth/token','/documents?limit=501','/documents?view=bib','/documents?limit=1&limit=2']:
            with self.subTest(path=path),self.assertRaises(Failure):validate_path(path)
    def test_refresh_is_serialized_and_revoke_wins(self):
        session=self.auth();tokens=self.service.store.get_session(session)['tokens'];tokens['expires']=0;self.service.store.update(session,tokens)
        def refresh(*args):self.service.store.revoke(session);return {'access':'new','refresh':'new','lifetime':3600}
        with patch('broker.token',side_effect=refresh),patch('broker.call') as provider:
            with self.assertRaises(Failure):self.service.library(session,'/documents')
        provider.assert_not_called()
    def test_profile_uses_json_accept(self):
        session=self.auth()
        with patch('broker.call',return_value=({'id':'me'},None)) as provider:self.service.library(session,'/profiles/v2/me')
        self.assertEqual(provider.call_args[0][3]['Accept'],'application/json')
    def test_callback_with_wrong_cookie_does_not_exchange_code(self):
        _,_,raw=self.send('/start','POST',{'challenge':challenge('v'*64)});identity=json.loads(raw)['requestId'];_,headers,_=self.send('/authorize?request='+identity)
        state=urllib.parse.parse_qs(urllib.parse.urlsplit(headers['Location']).query)['state'][0]
        with patch('broker.token') as token:
            self.assertEqual(self.send('/oauth/callback?state='+state+'&code=example',headers={'Cookie':'pulse_auth=wrong'})[0],400)
        token.assert_not_called()

if __name__=='__main__':unittest.main()
