import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import pulse_backend as backend


class LiteLimitTests(unittest.TestCase):
    def test_save_cap_preserves_existing_library(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder)
            with patch.object(backend, 'CONFIG_DIR', config), patch.object(backend, 'LIBRARY_PATH', config/'library.json'):
                papers = [{'id':str(i), 'title':f'Paper {i}'} for i in range(15)]
                backend.save_library({'papers':papers, 'paperLimit':999})
                saved = backend.load_library()
                self.assertEqual(saved['paperLimit'], 15)
                self.assertEqual(saved['edition'], 'lite')
                before = backend.LIBRARY_PATH.read_bytes()
                with self.assertRaises(backend.ClientError) as raised:
                    backend.save_library({'papers':papers+[{'title':'Sixteenth'}], 'paperLimit':999})
                self.assertEqual(raised.exception.status, 413)
                self.assertEqual(backend.LIBRARY_PATH.read_bytes(), before)
                self.assertEqual(list((config/'backups').glob('*.json')), [])
                self.assertEqual(len(backend.load_library()['papers']), 15)

    def test_oversized_saved_and_backup_files_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder)
            contents = json.dumps({'papers':[{'title':str(i)} for i in range(16)]})
            with patch.object(backend, 'CONFIG_DIR', config), patch.object(backend, 'LIBRARY_PATH', config/'library.json'):
                backend.LIBRARY_PATH.write_text(contents)
                with self.assertRaises(backend.ClientError): backend.load_library()
                self.assertEqual(backend.LIBRARY_PATH.read_text(), contents)
                backend.LIBRARY_PATH.unlink()
                backup = config/'backups/library_oversized.json'
                backup.write_text(contents)
                with self.assertRaises(backend.ClientError): backend.load_library()
                self.assertEqual(backup.read_text(), contents)

    def test_full_app_storage_overrides_are_ignored(self):
        with tempfile.TemporaryDirectory() as full_folder:
            full = Path(full_folder)
            sentinel = full/'library.json'
            sentinel.write_text(json.dumps({'papers':[{'title':str(i)} for i in range(40)]}))
            before = sentinel.read_bytes()
            env = dict(os.environ)
            env.pop('PULSE_LITE_CONFIG_DIR', None)
            env.update(PULSE_CONFIG_DIR=str(full), IRATXE_CONFIG_DIR=str(full))
            actual = subprocess.check_output(['python3','-c','import pulse_backend; print(pulse_backend.CONFIG_DIR)'], cwd=Path(__file__).resolve().parent.parent, env=env, text=True).strip()
            self.assertEqual(Path(actual), Path.home()/'Library/Application Support/pulse-lite')
            self.assertEqual(sentinel.read_bytes(), before)


if __name__ == '__main__': unittest.main()
