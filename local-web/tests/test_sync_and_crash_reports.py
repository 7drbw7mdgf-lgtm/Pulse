"""Encrypted multi-Mac sync state and local crash reports."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-sync-test-'))
from pulse_core import sync_relay, crash_reports
from pulse_core.constants import ClientError

CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK'


class TempConfig(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='pulse-sync-'))
        for module in (sync_relay, crash_reports):
            patcher = patch.object(module, 'CONFIG_DIR', self.dir); patcher.start(); self.addCleanup(patcher.stop)
        import pulse_core.security as security
        patcher = patch.object(security, 'CONFIG_DIR', self.dir); patcher.start(); self.addCleanup(patcher.stop)


class SyncStateTests(TempConfig):
    def test_code_is_encrypted_at_rest_and_state_round_trips(self):
        sync_relay.save_state({'code': CODE[:4] + '-' + CODE[4:], 'device': 'a' * 32, 'lastSeq': 7, 'base': {'s1': {'title': 'T'}}})
        raw = (self.dir / 'sync-state.json').read_text()
        self.assertNotIn(CODE, raw)
        state = sync_relay.get_state()
        self.assertEqual(state['code'], CODE); self.assertTrue(state['enabled'])
        self.assertEqual((state['device'], state['lastSeq'], state['base']), ('a' * 32, 7, {'s1': {'title': 'T'}}))
        sync_relay.save_state({'lastSeq': 9})
        self.assertEqual(sync_relay.get_state()['code'], CODE, 'fields not sent are kept')

    def test_invalid_values_are_rejected(self):
        for payload in ({'code': 'not-a-code'}, {'device': 'xyz'}, {'lastSeq': -1}, {'base': []}):
            with self.assertRaises(ClientError): sync_relay.save_state(payload)

    def test_forget_turns_sync_off_without_touching_the_library(self):
        (self.dir / 'library.json').write_text('{"papers": []}')
        sync_relay.save_state({'code': CODE})
        sync_relay.forget()
        self.assertFalse(sync_relay.get_state()['enabled'])
        self.assertTrue((self.dir / 'library.json').exists())

    def test_relay_forwards_only_known_operations(self):
        with patch.object(sync_relay, 'post', return_value={'ok': True}) as post:
            sync_relay.relay({'op': 'pull', 'body': {'vault': 'v'}})
            post.assert_called_once_with('/sync/v1/pull', {'vault': 'v'})
            for bad in ({'op': 'delete-everything', 'body': {}}, {'op': 'pull', 'body': []}, {}):
                with self.assertRaises(ClientError): sync_relay.relay(bad)

    def test_relay_url_must_be_https(self):
        with patch.dict(os.environ, {'PULSE_RELAY_URL': ''}):
            with patch.object(sync_relay.Path, 'read_text', return_value='{"relayUrl": "http://evil.example"}'):
                with self.assertRaises(ClientError): sync_relay.relay_url()


class CrashReportTests(TempConfig):
    def test_scrub_removes_library_content_and_personal_data(self):
        text = (f"KeyError: 'Outer membrane vesicles in C. jejuni' for 10.1128/iai.61.8 at {Path.home()}/Documents/x.pdf "
                "by jane@lab.ac.uk via https://api.openalex.org/works?search=private+query token sk-ABCDEFGH12345678 "
                + 'Z' * 40)
        clean = crash_reports.scrub(text)
        for secret in ('Outer membrane', '10.1128', str(Path.home()), 'jane@lab', 'private+query', 'ABCDEFGH12345678', 'Z' * 40):
            self.assertNotIn(secret, clean)
        self.assertIn('KeyError', clean); self.assertIn('api.openalex.org', clean)

    def test_exception_report_keeps_location_but_not_values(self):
        try: {}['Secret paper title']
        except KeyError as error: report_id = crash_reports.record_exception('backend-request', error, {'endpoint': '/api/library'})
        report = crash_reports.get_report({'id': report_id})['report']
        self.assertEqual(report['errorType'], 'KeyError')
        self.assertNotIn('Secret paper title', json.dumps(report))
        self.assertTrue(any('test_sync_and_crash_reports.py' in frame for frame in report['frames']))
        self.assertEqual(report['context'], {'endpoint': '/api/library'})
        self.assertFalse(report['sent'])

    def test_frontend_stack_frames_are_reduced_to_file_line_function(self):
        stack = 'TypeError: x\n    at renderTrends (http://127.0.0.1:8000/js/trends.js?v=1:42:7)\n    at tauri://localhost/js/part_10.js:88:3'
        report_id = crash_reports.record_frontend({'errorType': 'TypeError', 'message': "Cannot read 'Private note'", 'stack': stack, 'view': 'trends'})['id']
        report = crash_reports.get_report({'id': report_id})['report']
        self.assertEqual(report['frames'], ['trends.js:42 renderTrends', 'part_10.js:88 <anonymous>'])
        self.assertNotIn('Private note', json.dumps(report))

    def test_repeats_are_counted_and_list_dismiss_delete_work(self):
        for _ in range(3): crash_reports.record('frontend', 'TypeError', 'same', 'at f (http://h/js/a.js:1:1)')
        listing = crash_reports.list_reports()
        self.assertEqual(len(listing['reports']), 1); self.assertEqual(listing['reports'][0]['repeats'], 3)
        self.assertEqual(listing['unsent'], 1)
        crash_reports.dismiss_reports({})
        self.assertEqual(crash_reports.list_reports()['unsent'], 0)
        crash_reports.delete_reports({'all': True})
        self.assertEqual(crash_reports.list_reports()['reports'], [])

    def test_send_uploads_exactly_the_viewed_report_and_marks_it_sent(self):
        report_id = crash_reports.record('frontend', 'TypeError', 'boom', '')
        shown = crash_reports.get_report({'id': report_id})['report']
        with patch('pulse_core.sync_relay.post', return_value={'ok': True}) as post:
            crash_reports.send_report({'id': report_id})
        path, body = post.call_args.args[:2]
        self.assertEqual(path, '/reports/v1')
        self.assertEqual(body['report'], {k: v for k, v in shown.items() if k != 'sent'})
        self.assertTrue(crash_reports.get_report({'id': report_id})['report']['sent'])

    def test_nothing_is_sent_without_send(self):
        with patch('pulse_core.sync_relay.post') as post, patch('urllib.request.urlopen') as urlopen:
            crash_reports.record('frontend', 'TypeError', 'boom', '')
            crash_reports.list_reports(); crash_reports.dismiss_reports({})
        post.assert_not_called(); urlopen.assert_not_called()

    def test_store_is_capped(self):
        for i in range(crash_reports.MAX_REPORTS + 5): crash_reports.record('frontend', f'Error{i}', '', f'at f{i} (http://h/a.js:{i}:1)')
        self.assertEqual(len(list((self.dir / 'crash-reports').glob('*.json'))), crash_reports.MAX_REPORTS)

    def test_invalid_ids_are_rejected(self):
        for bad in ('../../etc/passwd', '', None, 'a' * 100):
            with self.assertRaises(ClientError): crash_reports.get_report({'id': bad})


class MemoryMeasurementTests(unittest.TestCase):
    def windows_api(self, success=True):
        kernel, memory = Mock(), Mock()
        kernel.GetCurrentProcess.return_value = -1
        def measure(handle, pointer, size):
            self.assertEqual(handle, -1)
            self.assertEqual(pointer._obj.cb, size)
            pointer._obj.PeakWorkingSetSize = 513 * 1024 * 1024
            pointer._obj.WorkingSetSize = 128 * 1024 * 1024
            return success
        memory.GetProcessMemoryInfo.side_effect = measure
        return kernel, memory

    def test_windows_uses_peak_working_set_in_mebibytes(self):
        kernel, memory = self.windows_api()
        with patch.object(crash_reports.sys, 'platform', 'win32'), \
             patch('ctypes.WinDLL', side_effect=[kernel, memory], create=True):
            self.assertEqual(crash_reports._memory_mb(), 513)
        self.assertEqual(memory.GetProcessMemoryInfo.call_count, 1)

    def test_windows_api_failure_is_optional(self):
        kernel, memory = self.windows_api(success=False)
        with patch.object(crash_reports.sys, 'platform', 'win32'), \
             patch('ctypes.WinDLL', side_effect=[kernel, memory], create=True):
            self.assertIsNone(crash_reports._memory_mb())
        with patch.object(crash_reports.sys, 'platform', 'win32'), \
             patch('ctypes.WinDLL', side_effect=OSError('Unavailable'), create=True):
            self.assertIsNone(crash_reports._memory_mb())

    def test_unix_memory_units_are_unchanged(self):
        resource = Mock()
        with patch.dict(sys.modules, {'resource': resource}):
            resource.getrusage.return_value.ru_maxrss = 513 * 1024 * 1024
            with patch.object(crash_reports.sys, 'platform', 'darwin'):
                self.assertEqual(crash_reports._memory_mb(), 513)
            resource.getrusage.return_value.ru_maxrss = 513 * 1024
            with patch.object(crash_reports.sys, 'platform', 'linux'):
                self.assertEqual(crash_reports._memory_mb(), 513)

    def test_memory_watch_records_locally_once_at_the_threshold(self):
        with patch.object(crash_reports, '_memory_mb', side_effect=[1024, 2048]), \
             patch.object(crash_reports, 'MEMORY_LIMIT_MB', 2048), \
             patch.object(crash_reports, '_MEMORY_REPORTED', False), \
             patch.object(crash_reports, 'record') as record, \
             patch.object(crash_reports.time, 'sleep'), \
             patch.object(crash_reports.threading, 'Thread') as thread, \
             patch.object(crash_reports.sys, 'excepthook'), \
             patch.object(crash_reports.threading, 'excepthook'), \
             patch('pulse_core.sync_relay.post') as post:
            crash_reports.install_hooks()
            thread.call_args.kwargs['target']()
            record.assert_called_once_with('memory', 'HighMemory', 'Peak memory 2048 MB (limit 2048 MB)')
            post.assert_not_called()

    @unittest.skipUnless(sys.platform == 'win32', 'Requires the actual Windows process API')
    def test_actual_windows_process_has_a_positive_peak(self):
        self.assertGreater(crash_reports._memory_mb(), 0)


if __name__ == '__main__':
    unittest.main()
