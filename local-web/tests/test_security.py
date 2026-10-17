"""Current desktop security regressions, using isolated data and mocked providers."""
import base64
import importlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'local-web/pulse-backend'
sys.path.insert(0, str(BACKEND))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-security-import-'))
import pulse_core as core
from pulse_core import security, storage
ai = importlib.import_module('pulse_core.ai_inference')
embeddings = importlib.import_module('pulse_core.embeddings')
server = importlib.import_module('pulse_core.server')


class ReleaseVersionTests(unittest.TestCase):
    def test_current_frontend_backend_and_build_metadata_agree(self):
        expected = json.loads((ROOT / 'package.json').read_text())['version']
        for name in ['package-lock.json', 'desktop/package.json', 'desktop/package-lock.json', 'desktop/src-tauri/tauri.conf.json']:
            with self.subTest(path=name):
                document = json.loads((ROOT / name).read_text())
                self.assertEqual(document['version'], expected)
                if 'packages' in document:
                    self.assertEqual(document['packages']['']['version'], expected)
        cargo = (ROOT / 'desktop/src-tauri/Cargo.toml').read_text()
        lock = (ROOT / 'desktop/src-tauri/Cargo.lock').read_text()
        self.assertEqual(re.search(r'\[package\][\s\S]*?\bversion\s*=\s*"([^"]+)"', cargo).group(1), expected)
        self.assertEqual(re.search(r'\[\[package\]\]\s*name = "pulse-desktop"\s*version = "([^"]+)"', lock).group(1), expected)
        self.assertIn('<title>Pulse v' + expected + ' ', (ROOT / 'local-web/pulse-frontend/index.html').read_text())
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in os.environ.items() if key not in {'PULSE_APP_VERSION', 'IRATXE_APP_VERSION'}}
            environment.update(PULSE_CONFIG_DIR=directory, PYTHONDONTWRITEBYTECODE='1')
            actual = subprocess.check_output([sys.executable, '-c', 'from pulse_core.constants import APP_VERSION; print(APP_VERSION)'],
                                             cwd=BACKEND, env=environment, text=True).strip()
        self.assertEqual(actual, expected)


class CredentialSecurityTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for replacement in [patch.object(core, 'CONFIG_DIR', root), patch.object(core, 'CONFIG_PATH', root / 'settings.json'),
                            patch.object(security, 'CONFIG_DIR', root)]:
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_every_saved_provider_secret_is_encrypted_and_round_trips(self):
        values = {key: 'synthetic-private-' + key for key in security.SENSITIVE_SETTING_KEYS}
        storage.write_settings(values)
        persisted = json.loads(core.CONFIG_PATH.read_text())
        loaded = storage.load_settings()
        for key, value in values.items():
            with self.subTest(key=key):
                self.assertTrue(persisted[key].startswith('enc:v1:'))
                self.assertNotIn(value, core.CONFIG_PATH.read_text())
                self.assertEqual(loaded[key], value)

    def test_tampered_secret_is_rejected(self):
        encoded = security.encrypt_secret('synthetic-private-value')
        raw = bytearray(base64.b64decode(encoded[len('enc:v1:'):]))
        raw[-1] ^= 1
        self.assertEqual(security.decrypt_secret('enc:v1:' + base64.b64encode(raw).decode()), '')

    def test_gemini_generation_and_embedding_use_header_credentials(self):
        key = 'synthetic-provider-key'
        for module, invoke, response_body in [
            (ai, lambda: ai.call_gemini({'apiKey': key}, 'Synthetic prompt'), {'candidates': [{'content': {'parts': [{'text': 'Synthetic result'}]}}]}),
            (embeddings, lambda: embeddings._gemini_embedding({'apiKey': key}, 'Synthetic text'), {'embedding': {'values': [.1, .2]}}),
        ]:
            with self.subTest(provider=module.__name__):
                with patch.object(module, 'resolve_gemini_api_key', return_value=key), \
                        patch.object(module.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response_body).encode())) as transport:
                    invoke()
                request = transport.call_args.args[0]
                self.assertEqual(request.get_header('X-goog-api-key'), key)
                self.assertNotIn(key, request.full_url)
                self.assertNotIn('key=', request.full_url)


class PdfSecurityTests(unittest.TestCase):
    def test_compressed_pdf_streams_respect_per_stream_and_document_limits(self):
        compressed = zlib.compress(b'A' * (5 * 1024 * 1024))
        inflated = security.safe_decompress_flate(compressed, max_bytes=2 * 1024 * 1024)
        self.assertIsNotNone(inflated)
        self.assertLessEqual(len(inflated), 2 * 1024 * 1024)
        observed = []
        pdf = (b'<< /Filter /FlateDecode >> stream\n' + compressed + b'\nendstream\n') * 9
        with patch.object(security, 'decode_pdf_text_bytes', side_effect=lambda value: observed.append(len(value)) or []):
            security.decode_pdf_streams(pdf)
        self.assertTrue(observed)
        self.assertLessEqual(max(observed), security.MAX_DECOMPRESSED_STREAM_BYTES)
        self.assertLessEqual(sum(observed), security.MAX_TOTAL_DECOMPRESSED_BYTES)


class HttpSecurityTests(unittest.TestCase):
    def setUp(self):
        self.token = 'synthetic-session-token'
        frontend = ROOT / 'local-web/pulse-frontend'
        for replacement in [patch.object(server, 'API_TOKEN', self.token), patch.object(server, 'ROOT', frontend),
                            patch.object(server, 'BOOTSTRAP_CONSUMED', False), patch.object(server, 'load_settings', return_value={}),
                            patch.object(server, 'public_settings', return_value={'configured': False})]:
            replacement.start()
            self.addCleanup(replacement.stop)
        class QuietHandler(server.PulseHandler):
            def log_message(self, *args):
                pass
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)

    def close_server(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def fetch(self, path, headers=None):
        return urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers or {}), timeout=5)

    def test_bootstrap_token_is_one_use_and_authenticated_reload_keeps_security_headers(self):
        with self.fetch('/') as first:
            self.assertIn(self.token, first.read().decode())
            self.assertIn('HttpOnly', first.headers['Set-Cookie'])
            self.assertIn('SameSite=Strict', first.headers['Set-Cookie'])
            self.assertIn("frame-ancestors 'none'", first.headers['Content-Security-Policy'])
            self.assertEqual(first.headers['X-Frame-Options'], 'DENY')
            self.assertEqual(first.headers['X-Content-Type-Options'], 'nosniff')
        with self.fetch('/index.html') as anonymous:
            self.assertNotIn(self.token, anonymous.read().decode())
            self.assertIsNone(anonymous.headers.get('Set-Cookie'))
        with self.fetch('/index.html', {'Cookie': 'pulse_session=' + self.token}) as authenticated:
            self.assertIn(self.token, authenticated.read().decode())

    def test_cross_site_origins_referers_and_hosts_cannot_get_a_session(self):
        for headers in [{'Origin': 'https://untrusted.invalid'}, {'Referer': 'https://untrusted.invalid/page'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Host': 'untrusted.invalid'}]:
            with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as caught:
                self.fetch('/api/session', headers)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()

    def test_settings_api_requires_the_current_cookie_or_header_token(self):
        for headers in [{}, {'X-Pulse-Token': 'wrong-synthetic-session'}]:
            with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as caught:
                self.fetch('/api/settings', headers)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
        for headers in [{'Cookie': 'pulse_session=' + self.token}, {'X-Pulse-Token': self.token}]:
            with self.fetch('/api/settings', headers) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response), {'configured': False})


if __name__ == '__main__':
    unittest.main()
