import importlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import MagicMock, Mock, patch

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
        self.assertEqual(call.call_args_list[1].args[0],l.MENDELEY+'/profiles/me')
        self.assertEqual(call.call_args_list[1].kwargs['headers']['Accept'],'application/vnd.mendeley-profiles.1+json')
        raw=(Path(self.temp.name)/'library-managers.json').read_text();self.assertNotIn('test-token',raw);self.assertNotIn('test-refresh',raw)
        self.assertEqual(l.access_token(),'test-token')
    def test_provider_rejection_does_not_store_token(self):
        config=self.config();l.write_config(config)
        with patch.object(l,'request',side_effect=[{'access_token':'test-token'}, ClientError(401,'Rejected')]):
            with self.assertRaises(ClientError):l.token_exchange(config,{'grant_type':'authorization_code','code':'test-code'})
        self.assertNotIn('accessToken',l.read_config())
    def test_direct_token_401_identifies_application_credentials_without_retry(self):
        config=self.config();l.write_config(config)
        error=urllib.error.HTTPError(l.MENDELEY+'/oauth/token',401,'Unauthorized',{},
            io.BytesIO(b'{"message":"Credentials are required to access this resource. test-private-secret"}'))
        opener=Mock();opener.open.side_effect=error
        with patch.object(l.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(ClientError) as rejected:
                l.token_exchange(config,{'grant_type':'authorization_code','code':'dummy-code'})
        self.assertEqual(rejected.exception.status,401)
        self.assertEqual(rejected.exception.mendeley_stage,'application_authentication')
        self.assertEqual(rejected.exception.mendeley_code,'mendeley_application_authentication_failed')
        self.assertIn('application ID and secret in Connection settings',str(rejected.exception))
        self.assertNotIn('test-private-secret',str(rejected.exception))
        self.assertEqual(opener.open.call_count,1)
        self.assertNotIn('accessToken',l.read_config())
    def test_profile_401_is_distinct_from_application_authentication_and_does_not_store_tokens(self):
        config=self.config();l.write_config(config)
        token=MagicMock();token.__enter__.return_value=token
        token.read.return_value=b'{"access_token":"issued-token","refresh_token":"issued-refresh","expires_in":3600}'
        error=urllib.error.HTTPError(l.MENDELEY+'/profiles/me',401,'Unauthorized',{},
            io.BytesIO(b'{"message":"Credentials are required to access this resource."}'))
        opener=Mock();opener.open.side_effect=[token,error]
        with patch.object(l.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(ClientError) as rejected:
                l.token_exchange(config,{'grant_type':'authorization_code','code':'dummy-code'})
        self.assertEqual(rejected.exception.mendeley_stage,'account_verification')
        self.assertEqual(rejected.exception.mendeley_code,'mendeley_account_verification_failed')
        self.assertIn('account verification failed',str(rejected.exception))
        self.assertNotIn('application ID and secret',str(rejected.exception))
        self.assertEqual(opener.open.call_args_list[1].args[0].get_header('Authorization'),'Bearer issued-token')
        self.assertNotIn('accessToken',l.read_config());self.assertNotIn('refreshToken',l.read_config())
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
        listeners=[]
        class FakeServer:
            def __init__(self,address,handler):
                self.handler=handler;listeners.append(self)
        config=self.config();l.write_config(config)
        with patch.object(oauth,'HTTPServer',FakeServer),patch.object(oauth.threading,'Thread'),patch.object(oauth,'token_exchange') as exchange:
            result=oauth.start_oauth();query=urllib.parse.parse_qs(urllib.parse.urlsplit(result['authorizationUrl']).query)
            self.assertEqual(query['response_type'],['code']);self.assertEqual(query['code_challenge_method'],['S256'])
            self.assertNotIn('client_secret',query);self.assertNotIn('code_verifier',query)
            def get(fields, headers=None):
                callback=object.__new__(listeners[0].handler)
                callback.path='/mendeley/callback?'+urllib.parse.urlencode(fields,doseq=True)
                callback.headers={'Host':'127.0.0.1:8765',**(headers or {})}
                callback.wfile=io.BytesIO();callback.send_response=Mock();callback.send_header=Mock();callback.end_headers=Mock()
                callback.do_GET()
                return callback
            for fields,headers in [({'state':'wrong','code':'test-code'},{}), ({'state':query['state'],'code':'test-code'},{'Host':'other.example'}), ({'state':[query['state'][0],query['state'][0]],'code':'test-code'}, {})]:
                callback=get(fields,headers)
                callback.send_response.assert_called_once_with(400)
            exchange.assert_not_called()
            callback=get({'state':query['state'],'code':'test-code'})
            callback.send_response.assert_called_once_with(200)
            callback.send_header.assert_any_call('Cache-Control','no-store')
            self.assertIn('history.replaceState',callback.wfile.getvalue().decode())
            exchange.assert_called_once()
            fields=exchange.call_args.args[1]
            self.assertEqual(oauth.pkce_challenge(fields['code_verifier']),query['code_challenge'][0])
            self.assertFalse(oauth.oauth_status()['pending'])
            oauth._PENDING=None
    def test_confidential_exchange_preserves_existing_pkce_omission(self):
        config=self.config();l.write_config(config)
        with patch.object(l,'request',side_effect=[{'access_token':'test-token','expires_in':3600}, {'id':'profile'}]) as request:
            l.token_exchange(config,{'grant_type':'authorization_code','code':'test-code','code_verifier':'test-verifier'})
        fields=urllib.parse.parse_qs(request.call_args_list[0].args[2].decode())
        self.assertNotIn('code_verifier',fields)
        self.assertIn('Authorization',request.call_args_list[0].args[3])
    def test_restart_rejects_an_old_exchange_already_in_flight(self):
        listeners=[]
        class FakeServer:
            def __init__(self,address,handler):
                self.handler=handler;listeners.append(self)
        l.write_config(self.config())
        with patch.object(oauth,'HTTPServer',FakeServer),patch.object(oauth.threading,'Thread'):
            first=oauth.start_oauth();old=l.read_config();pending=oauth._PENDING
            second=oauth.start_oauth();current=l.read_config()
        self.assertTrue(pending['cancelled'])
        self.assertNotEqual(first['authorizationUrl'],second['authorizationUrl'])
        self.assertEqual(current['authGeneration'],old['authGeneration']+1)
        with patch.object(l,'request',side_effect=[{'access_token':'stale-token','expires_in':3600},{'id':'old-account'}]):
            with self.assertRaises(ClientError) as rejected:
                l.token_exchange(old,{'grant_type':'authorization_code','code':'old-code'})
        self.assertEqual(rejected.exception.status,409)
        self.assertNotIn('accessToken',l.read_config())
        self.assertTrue(oauth.oauth_status()['pending'])
        oauth._PENDING=None
    def test_provider_request_identifies_pulse_with_version(self):
        response=MagicMock();response.read.return_value=b'{}'
        response.__enter__.return_value=response
        opener=Mock();opener.open.return_value=response
        with patch.object(l.urllib.request,'build_opener',return_value=opener):
            l.request(l.MENDELEY+'/oauth/token','POST',b'grant_type=authorization_code')
        from pulse_core.constants import APP_VERSION
        self.assertEqual(opener.open.call_args.args[0].get_header('User-agent'),f'Pulse/{APP_VERSION} (Mendeley OAuth)')
    def test_local_zotero_does_not_receive_provider_user_agent(self):
        response=MagicMock();response.read.return_value=b'{}'
        response.__enter__.return_value=response
        opener=Mock();opener.open.return_value=response
        with patch.object(l.urllib.request,'build_opener',return_value=opener):
            l.request(l.ZOTERO+'/connector/ping')
        self.assertIsNone(opener.open.call_args.args[0].get_header('User-agent'))
    def test_direct_status_requests_documented_profile(self):
        config=self.config();config.update(accessToken='test-token',expiresAt=9999999999);l.write_config(config)
        with patch.object(l,'request',return_value={'id':'profile','name':'Test collection'}) as request:
            result=l.manager_status()
        self.assertTrue(result['mendeley']['connected'])
        profile=request.call_args_list[-1]
        self.assertEqual(profile.args[0],l.MENDELEY+'/profiles/me')
        self.assertEqual(profile.kwargs['headers']['Accept'],'application/vnd.mendeley-profiles.1+json')
    def test_callback_failure_displays_client_error_without_missing_attribute(self):
        listeners=[]
        class FakeServer:
            def __init__(self,address,handler):
                self.handler=handler;listeners.append(self)
        config=self.config();l.write_config(config)
        with patch.object(oauth,'HTTPServer',FakeServer),patch.object(oauth.threading,'Thread'),patch.object(oauth,'token_exchange',side_effect=ClientError(406,'Mendeley returned HTTP 406')):
            started=oauth.start_oauth()
            state=urllib.parse.parse_qs(urllib.parse.urlsplit(started['authorizationUrl']).query)['state'][0]
            callback=object.__new__(listeners[0].handler)
            callback.path='/mendeley/callback?'+urllib.parse.urlencode({'state':state,'code':'test-code'})
            callback.headers={'Host':'127.0.0.1:8765'};callback.reply=Mock()
            callback.do_GET()
        message=callback.reply.call_args.args[1]
        self.assertIn('Mendeley returned HTTP 406',message)
        self.assertEqual(oauth.oauth_status()['authorizationMessage'],message)
        self.assertFalse(oauth.oauth_status()['pending'])
        oauth._PENDING=None
    def test_callback_preserves_application_error_stage_and_recovery_advice(self):
        listeners=[]
        class FakeServer:
            def __init__(self,address,handler): self.handler=handler;listeners.append(self)
        config=self.config();l.write_config(config)
        failure=l.mendeley_failure(401,'Mendeley application authentication failed. Correct the application ID and secret first.',
            'application_authentication','mendeley_application_authentication_failed')
        with patch.object(oauth,'HTTPServer',FakeServer),patch.object(oauth.threading,'Thread'),patch.object(oauth,'token_exchange',side_effect=failure):
            started=oauth.start_oauth()
            state=urllib.parse.parse_qs(urllib.parse.urlsplit(started['authorizationUrl']).query)['state'][0]
            callback=object.__new__(listeners[0].handler)
            callback.path='/mendeley/callback?'+urllib.parse.urlencode({'state':state,'code':'dummy-code'})
            callback.headers={'Host':'127.0.0.1:8765'};callback.reply=Mock();callback.do_GET()
        status=oauth.oauth_status()
        self.assertEqual(status['authorizationStage'],'application_authentication')
        self.assertEqual(status['authorizationErrorCode'],'mendeley_application_authentication_failed')
        self.assertIn('Correct the application ID and secret first',status['authorizationMessage'])
        self.assertNotIn('Return to Pulse and connect again',status['authorizationMessage'])
        self.assertFalse(status['pending']);oauth.cancel_oauth()
        self.assertEqual(oauth.oauth_status()['authorizationStage'],'')
        self.assertEqual(oauth.oauth_status()['authorizationErrorCode'],'')

if __name__=='__main__':unittest.main()
