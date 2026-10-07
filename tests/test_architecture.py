"""Service extraction regressions: instance scope, transport and ranking parity."""
import json
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from pulse import discovery, http, providers, ranking, storage
from pulse.context import AppContext, ClientError, contextual, get_context, use_context
from pulse.types import Metadata, Paper

ROOT = Path(__file__).resolve().parent.parent


class ArchitectureTests(unittest.TestCase):
    def test_original_ranking_fixtures(self):
        cases = json.loads((ROOT / 'tests/fixtures/discovery-parity.json').read_text())
        for index, case in enumerate(cases):
            with self.subTest(case=index):
                actual = discovery.merge_and_rank_pipeline_candidates(case['candidates'], case['seed'], case['options'])
                self.assertEqual(actual, case['expected'])

    def test_instance_scope_and_worker_inheritance(self):
        with tempfile.TemporaryDirectory() as folder:
            first = AppContext(ROOT, Path(folder) / 'first')
            second = AppContext(ROOT, Path(folder) / 'second')
            with use_context(first):
                storage.save_library({'papers': [{'id': 'first'}], '_saveSession': 'same', '_saveRevision': 7})
                inherited = []
                thread = threading.Thread(target=contextual(lambda: inherited.append(get_context())))
                thread.start(); thread.join(2)
                self.assertEqual(inherited, [first])
                with use_context(second):
                    storage.save_library({'papers': [{'id': 'second'}], '_saveSession': 'same', '_saveRevision': 1})
                    self.assertEqual(storage.load_library()['papers'][0]['id'], 'second')
                self.assertIs(get_context(), first)
                self.assertEqual(storage.load_library()['papers'][0]['id'], 'first')
            self.assertNotEqual(first.api_token, second.api_token)
            self.assertEqual(first.save_revisions['same'], 7)
            self.assertEqual(second.save_revisions['same'], 1)

    def test_expected_provider_failure_logs_and_programming_error_propagates(self):
        with tempfile.TemporaryDirectory() as folder, use_context(AppContext(ROOT, Path(folder))):
            with patch('pulse.providers.request_json', side_effect=urllib.error.URLError('offline')):
                with self.assertLogs('pulse.providers', level='WARNING') as captured:
                    with self.assertRaises(ClientError):
                        providers.fetch_json('https://test.invalid/offline')
                self.assertIn('URLError', captured.output[0])
            with patch('pulse.providers.request_json', side_effect=NameError('regression')):
                with self.assertRaises(NameError):
                    providers.fetch_json('https://test.invalid/programming-error')

    def test_http_uses_own_context_and_validates_json(self):
        with tempfile.TemporaryDirectory() as folder:
            servers = []
            try:
                for name in ['first', 'second']:
                    context = AppContext(ROOT, Path(folder) / name)
                    server = http.PulseServer(('127.0.0.1', 0), context)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    servers.append(server)
                    request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/library', data=json.dumps({'papers': [{'id': name}]}).encode(), headers={'X-Pulse-Token': context.api_token, 'Content-Type': 'application/json'})
                    self.assertTrue(json.load(urllib.request.urlopen(request))['ok'])
                for server, name in zip(servers, ['first', 'second']):
                    url = f'http://127.0.0.1:{server.server_port}/api/library'
                    headers = {'X-Pulse-Token': server.context.api_token}
                    self.assertEqual(json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers)))['papers'][0]['id'], name)
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(url, data=b'{bad json', headers=headers))
                    self.assertEqual(error.exception.code, 400)
                    wrong = servers[1].context.api_token if name == 'first' else servers[0].context.api_token
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(url, headers={'X-Pulse-Token': wrong}))
                    self.assertEqual(error.exception.code, 403)
            finally:
                for server in servers:
                    server.shutdown(); server.server_close()

    def test_import_has_no_runtime_side_effects(self):
        code = "from unittest.mock import patch; import threading,signal;\nwith patch.object(threading.Thread,'start',side_effect=AssertionError('started on import')), patch.object(signal,'signal',side_effect=AssertionError('signal on import')):\n import pulse.runtime, pulse.http\n"
        subprocess.run([sys.executable, '-c', code], cwd=ROOT, check=True, timeout=10)

    def test_typed_record_contract(self):
        self.assertIn('title', Metadata.__annotations__)
        self.assertIn('id', Paper.__annotations__)
        self.assertIn('doi', Paper.__annotations__)


if __name__ == '__main__':
    unittest.main()
