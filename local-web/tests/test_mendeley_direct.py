import importlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
l = importlib.import_module('pulse_core.library_managers')
oauth = importlib.import_module('pulse_core.mendeley_oauth')
from pulse_core.constants import ClientError

class CodeMendeleyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(l, 'CONFIG_DIR', Path(self.temp.name)); self.patch.start()
    def tearDown(self):
        oauth.cancel_oauth(); self.patch.stop(); self.temp.cleanup()
    def config(self, public=False):
        config = {'clientId':'test-client', 'redirectUri':'http://127.0.0.1:8765/mendeley/callback', 'authFlow':'pkce' if public else 'code', 'authGeneration':1}
        if public: config['pkceVerified']=True
        else: config['clientSecret']='test-private-secret'
        return config
    def test_rfc7636_challenge(self):
        self.assertEqual(oauth.pkce_challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    def test_implicit_and_unverified_public_clients_are_blocked(self):
        for flow in ['implicit','pkce']:
            config=self.config(True);config.update(authFlow=flow,pkceVerified=False);l.write_config(config)
            self.assertFalse(l.public_config()['configured'])
            with self.assertRaises(ClientError):oauth.start_oauth()
    def test_verified_public_registration_needs_no_secret(self):
        l.write_config(self.config(True));result=l.public_config()
        self.assertTrue(result['configured']);self.assertFalse(result['hasClientSecret'])
    def test_public_token_exchange_verifies_token_and_never_sends_secret(self):
        config=self.config(True);l.write_config(config)
        with patch.object(l,'request',side_effect=[{'access_token':'test-token','refresh_token':'test-refresh','expires_in':3600,'token_type':'bearer'}, {'id':'profile'}]) as call:
            l.token_exchange(config, {'grant_type':'authorization_code','code':'test-code','code_verifier':'test-verifier'})
        fields=urllib.parse.parse_qs(call.call_args_list[0].args[2].decode())
        self.assertEqual(fields['client_id'],['test-client']);self.assertEqual(fields['code_verifier'],['test-verifier'])
        self.assertNotIn('Authorization',call.call_args_list[0].args[3]);self.assertNotIn('client_secret',fields)
        raw=(Path(self.temp.name)/'library-managers.json').read_text();self.assertNotIn('test-token',raw);self.assertNotIn('test-refresh',raw)
        self.assertEqual(l.access_token(),'test-token')
    def test_provider_rejection_does_not_store_token(self):
        config=self.config();l.write_config(config)
        with patch.object(l,'request',side_effect=[{'access_token':'test-token'}, ClientError(401,'Rejected')]):
            with self.assertRaises(ClientError):l.token_exchange(config,{'grant_type':'authorization_code','code':'test-code'})
        self.assertNotIn('accessToken',l.read_config())
    def test_invalid_token_does_not_reach_profile(self):
        config=self.config();l.write_config(config)
        for result in [{'access_token':'bad\r\ntoken'},{'access_token':'valid','token_type':'other'}, {'access_token':'valid','expires_in':-1}]:
            with patch.object(l,'request',return_value=result) as call:
                with self.assertRaises(ClientError):l.token_exchange(config,{})
                self.assertEqual(call.call_count,1)
    def test_callback_clears_query_without_exposing_tokens(self):
        body=oauth.callback_page('Success','test-nonce')
        self.assertIn('history.replaceState',body);self.assertNotIn('access_token',body);self.assertNotIn('code_verifier',body)
    def test_callback_rejects_invalid_state_host_and_duplicates_then_sends_matching_verifier(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        config=self.config();config['redirectUri']=f'http://127.0.0.1:{port}/mendeley/callback';l.write_config(config)
        with patch.object(oauth,'token_exchange') as exchange:
            result=oauth.start_oauth();query=urllib.parse.parse_qs(urllib.parse.urlsplit(result['authorizationUrl']).query)
            self.assertEqual(query['response_type'],['code']);self.assertEqual(query['code_challenge_method'],['S256'])
            self.assertNotIn('client_secret',query);self.assertNotIn('code_verifier',query)
            def get(fields, headers=None):
                return urllib.request.urlopen(urllib.request.Request(config['redirectUri']+'?'+urllib.parse.urlencode(fields,doseq=True),headers=headers or {}),timeout=3)
            for fields,headers in [({'state':'wrong','code':'test-code'},{}), ({'state':query['state'],'code':'test-code'},{'Host':'other.example'}), ({'state':[query['state'][0],query['state'][0]],'code':'test-code'}, {})]:
                with self.assertRaises(urllib.error.HTTPError) as failure:get(fields,headers)
                failure.exception.close()
            exchange.assert_not_called()
            with get({'state':query['state'],'code':'test-code'}) as response:
                self.assertEqual(response.status,200);self.assertIn('no-store',response.headers['Cache-Control'])
                self.assertIn('history.replaceState',response.read().decode())
            exchange.assert_called_once()
            fields=exchange.call_args.args[1]
            self.assertEqual(oauth.pkce_challenge(fields['code_verifier']),query['code_challenge'][0])
            self.assertFalse(oauth.oauth_status()['pending'])

if __name__=='__main__':unittest.main()
