import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-library-tests-'))
import pulse_core as core
storage = importlib.import_module('pulse_core.storage')
from pulse_core.constants import ClientError

class LibrarySaveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for key,value in [('CONFIG_DIR',self.root),('LIBRARY_PATH',self.root/'library.json')]:
            patcher = patch.object(core,key,value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.paper = {'id':'fixture','title':'Synthetic test record'}

    def seed(self):
        storage.save_library({'papers':[self.paper]})

    def test_empty_autosave_cannot_replace_saved_papers(self):
        self.seed()
        backup = self.root/'backups/library_existing.json'
        backup.write_text(json.dumps({'papers':[self.paper]}))
        with self.assertRaises(ClientError): storage.save_library({'papers':[]})
        self.assertEqual(storage.load_library()['papers'],[self.paper])
        self.assertTrue(backup.exists())

    def test_confirmed_reset_can_clear(self):
        self.seed()
        storage.save_library({'papers':[],'reset':True})
        self.assertEqual(storage.load_library()['papers'],[])

    def test_explicit_last_paper_removal_keeps_backup(self):
        self.seed()
        storage.save_library({'papers':[],'allowEmpty':True})
        self.assertEqual(storage.load_library()['papers'],[])
        backups=list((self.root/'backups').glob('library_*.json'))
        self.assertTrue(any(json.loads(p.read_text())['papers']==[self.paper] for p in backups))

    def test_fresh_empty_workspace_can_save(self):
        storage.save_library({'papers':[]})
        self.assertEqual(storage.load_library()['papers'],[])
