"""Sign-in through Pulse's Mendeley token-exchange service (auth-service/cloudflare)."""
import importlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'local-web' / 'pulse-backend'))
l = importlib.import_module('pulse_core.library_managers')
oauth = importlib.import_module('pulse_core.mendeley_oauth')
exchange = importlib.import_module('pulse_core.mendeley_exchange')
broker = importlib.import_module('pulse_core.mendeley_broker')


class ExchangeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.registration = Path(self.temp.name) / 'mendeley-client.json'
        self.registration.write_text(json.dumps({'exchangeUrl': 'https://pulse-mendeley.example.workers.dev', 'brokerUrl': '', 'clientId': ''}))
        patches = [patch.object(l, 'CONFIG_DIR', Path(self.temp.name)),
                   patch.object(l, 'Path', side_effect=lambda value: Path(self.temp.name) / 'pulse_core.py' if value == l.__file__ else Path(value))]
        for item in patches: item.start(); self.addCleanup(item.stop)
        oauth._PENDING = None
        self.addCleanup(oauth.cancel_oauth)

    def test_shared_exchange_registration_is_configured_without_any_secret(self):
        config = l.read_config()
        self.assertEqual(config['authFlow'], 'exchange')
        self.assertEqual(config['exchangeUrl'], 'https://pulse-mendeley.example.workers.dev')
        self.assertNotIn('clientSecret', config)
        public = l.public_config()
        self.assertTrue(public['configured']); self.assertTrue(public['sharedRegistration'])

    def test_own_application_settings_take_precedence(self):
        l.write_config({'clientId': 'mine', 'clientSecret': 'secret', 'redirectUri': 'http://127.0.0.1:8765/mendeley/callback', 'authFlow': 'code'})
        self.assertEqual(l.read_config()['authFlow'], 'code')

    def test_recover_from_invalid_custom_application_without_changing_library(self):
        l.write_config({'clientId':'obsolete-app','clientSecret':'obsolete-secret','authFlow':'code',
                        'redirectUri':'http://127.0.0.1:8767/mendeley/callback','authGeneration':4,
                        'accessToken':'old-access','refreshToken':'old-refresh','mendeleyAccountId':'old-account',
                        'mendeleyAutomaticSync':False,'mendeleyLastSyncedAt':'2026-10-14T10:00:00Z'})
        library=Path(self.temp.name)/'library.json'
        library.write_text('{"papers":[{"title":"Keep my local notes","notes":"Local edits"}]}')
        before=library.read_bytes()
        self.assertTrue(l.public_config()['defaultSignInAvailable'])
        with patch.object(oauth,'cancel_oauth') as cancel:
            self.assertTrue(l.configure_mendeley({'usePulseSignIn':True})['ok'])
        cancel.assert_called_once()
        config=l.read_config()
        self.assertEqual(config['authFlow'],'exchange')
        self.assertEqual(config['authGeneration'],5)
        for key in ['clientId','clientSecret','accessToken','refreshToken','mendeleyAccountId','redirectUri']:
            self.assertNotIn(key,config)
        self.assertFalse(config['mendeleyAutomaticSync'])
        self.assertEqual(config['mendeleyLastSyncedAt'],'2026-10-14T10:00:00Z')
        self.assertEqual(library.read_bytes(),before)
        self.assertTrue(l.public_config()['sharedRegistration'])
        self.assertTrue(l.public_config()['configured'])

    def test_missing_shared_registration_cannot_erase_custom_settings(self):
        self.registration.write_text('{}')
        l.write_config({'clientId':'mine','clientSecret':'keep-this-secret','authFlow':'code'})
        path=Path(self.temp.name)/'library-managers.json';before=path.read_bytes()
        with self.assertRaises(l.ClientError):l.configure_mendeley({'usePulseSignIn':True})
        self.assertEqual(path.read_bytes(),before)
        self.assertFalse(l.public_config()['defaultSignInAvailable'])

    def test_truthy_strings_cannot_reset_the_connection(self):
        l.write_config({'clientId':'mine','clientSecret':'keep-this-secret','authFlow':'code'})
        path=Path(self.temp.name)/'library-managers.json';before=path.read_bytes()
        with self.assertRaises(l.ClientError):l.configure_mendeley({'usePulseSignIn':'true'})
        self.assertEqual(path.read_bytes(),before)

    def test_tokens_come_from_the_service_and_mendeley_token_endpoint_is_never_called(self):
        config = l.read_config()
        calls = []
        def service(base, path, payload):
            calls.append((path, payload)); return {'access_token': 'svc-token', 'refresh_token': 'svc-refresh', 'expires_in': 3600, 'token_type': 'bearer'}
        def provider(url, *args, **kwargs):
            self.assertNotIn('/oauth/token', url); return {'id': 'profile-1'}
        with patch.object(exchange, 'call', side_effect=service), patch.object(l, 'request', side_effect=provider):
            l.token_exchange(config, {'grant_type': 'authorization_code', 'code': 'c', 'state': 's.t', 'code_verifier': 'v' * 64})
        self.assertEqual(calls, [('/token', {'code': 'c', 'state': 's.t', 'verifier': 'v' * 64})])
        stored = l.read_config()
        self.assertEqual(stored['accessToken'], 'svc-token'); self.assertEqual(stored['refreshToken'], 'svc-refresh')
        raw = (Path(self.temp.name) / 'library-managers.json').read_text()
        self.assertNotIn('svc-token', raw); self.assertNotIn('svc-refresh', raw)
        # Refresh also goes through the service.
        current = dict(stored, expiresAt=0)
        l.write_config(current)
        with patch.object(exchange, 'call', side_effect=service) as refreshed, patch.object(l, 'request', side_effect=provider):
            l.access_token()
        self.assertEqual(refreshed.call_args.args[1:], ('/refresh', {'refresh_token': 'svc-refresh'}))

    def test_service_reply_must_point_at_mendeley(self):
        config = l.read_config()
        with patch.object(exchange, 'call', return_value={'authorizationUrl': 'https://evil.example/authorize', 'state': 'a.b'}):
            with self.assertRaises(l.ClientError): exchange.start(config, 'c' * 43, 50000)
    def test_service_application_401_preserves_stage_and_owner_recovery_advice(self):
        error=urllib.error.HTTPError('https://service.example/token',401,'Unauthorized',{},io.BytesIO(json.dumps({
            'error':'Credentials are required to access this resource. do-not-echo',
            'code':'mendeley_application_authentication_failed','stage':'application_authentication','providerStatus':401
        }).encode()))
        opener=Mock();opener.open.side_effect=error
        with patch.object(exchange.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(l.ClientError) as rejected:
                exchange.call('https://service.example','/token',{'code':'dummy-code'})
        self.assertEqual(rejected.exception.status,401)
        self.assertEqual(rejected.exception.mendeley_stage,'application_authentication')
        self.assertEqual(rejected.exception.mendeley_code,'mendeley_application_authentication_failed')
        self.assertIn('service owner must verify',str(rejected.exception))
        self.assertNotIn('do-not-echo',str(rejected.exception));self.assertEqual(opener.open.call_count,1)
    def test_invalid_grant_remains_token_exchange_failure(self):
        error=urllib.error.HTTPError('https://service.example/token',400,'Bad Request',{},
            io.BytesIO(b'{"error":"Invalid access code","code":"mendeley_token_exchange_failed","stage":"token_exchange"}'))
        opener=Mock();opener.open.side_effect=error
        with patch.object(exchange.urllib.request,'build_opener',return_value=opener):
            with self.assertRaises(l.ClientError) as rejected:exchange.call('https://service.example','/token',{})
        self.assertEqual(rejected.exception.status,400)
        self.assertEqual(rejected.exception.mendeley_stage,'token_exchange')
        self.assertIn('Invalid access code',str(rejected.exception))
        self.assertNotIn('application ID and secret',str(rejected.exception))

    @unittest.skipUnless(shutil.which('node'), 'Node.js is needed to run the worker')
    def test_end_to_end_with_the_worker(self):
        harness = subprocess.Popen(['node', str(ROOT / 'auth-service/cloudflare/test/serve-local.mjs')], stdout=subprocess.PIPE, text=True)
        def stop_harness():
            if harness.poll() is None: harness.terminate()
            try: harness.wait(timeout=3)
            except subprocess.TimeoutExpired:
                harness.kill(); harness.wait(timeout=3)
            harness.stdout.close()
        self.addCleanup(stop_harness)
        port = int(harness.stdout.readline())
        service = f'http://127.0.0.1:{port}'
        self.registration.write_text(json.dumps({'exchangeUrl': 'https://placeholder.example'}))
        real_origin = broker.origin
        def loopback_origin(value):  # The real service is HTTPS; the harness is plain local HTTP.
            return service if value in ('https://placeholder.example', service) else real_origin(value)
        profiles = []
        real_request = l.request
        def provider(url, *args, **kwargs):
            if url.startswith(l.MENDELEY + '/profiles/me'):
                profiles.append(kwargs['headers']['Authorization']); return {'id': 'account-1'}
            return real_request(url, *args, **kwargs)
        no_redirects = urllib.request.build_opener(type('Stop', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *a: None}))
        with patch.object(l, 'request', side_effect=provider), patch.object(exchange, 'origin', side_effect=loopback_origin), \
             patch('pulse_core.mendeley_broker.origin', side_effect=loopback_origin):
            started = oauth.start_oauth()
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(started['authorizationUrl']).query)
            self.assertEqual(query['client_id'], ['harness-client'])
            self.assertEqual(query['redirect_uri'], [service + '/callback'])
            self.assertNotIn('harness-secret', started['authorizationUrl'])
            # Mendeley sends the browser to the service; the service sends it to Pulse on this computer.
            with self.assertRaises(urllib.error.HTTPError) as hop:
                no_redirects.open(service + '/callback?' + urllib.parse.urlencode({'code': 'good-code', 'state': query['state'][0]}), timeout=5)
            local = hop.exception.headers['Location']; hop.exception.close()
            self.assertTrue(local.startswith('http://127.0.0.1:'))
            with urllib.request.urlopen(local, timeout=10) as page:
                self.assertIn('Mendeley connected', page.read().decode())
            deadline = time.time() + 5
            while oauth.oauth_status().get('pending') and time.time() < deadline: time.sleep(.05)
            stored = l.read_config()
            self.assertEqual(stored['accessToken'], 'harness-access')
            self.assertEqual(profiles, ['Bearer harness-access'])
            l.write_config(dict(stored, expiresAt=0))
            self.assertEqual(l.access_token(), 'harness-access-2', 'refresh goes through the service')


if __name__ == '__main__':
    unittest.main()
