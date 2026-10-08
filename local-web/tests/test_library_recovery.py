from test_library_save import storage, core, ClientError, patch, json
import unittest, tempfile
from pathlib import Path

class LibraryRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for key, value in [('CONFIG_DIR',self.root), ('LIBRARY_PATH',self.root/'library.json')]:
            patcher=patch.object(core,key,value);patcher.start();self.addCleanup(patcher.stop)
        self.paper={'id':'fixture','title':'Synthetic test record'}
    def seed(self): storage.save_library({'papers':[self.paper]})
    def workspace(self):
        return {'papers':[dict(self.paper,text='Complete synthetic paper text',paperKeywords=['original'],selected=False,areaId='area'), {'id':'other','title':'Second synthetic paper'}], 'areas':[{'id':'area','name':'Saved area'}], 'threshold':.25, 'graphStyle':{'showGrid':False}, 'links':[{'source':'fixture','target':'other'}]}
    def test_remove_only_chosen_and_merge_restore_with_new_papers(self):
        before=self.workspace();storage.save_library(before)
        result=storage.change_library({'action':'remove','ids':['fixture'],'workspace':before})
        self.assertEqual([p['id'] for p in result['workspace']['papers']],['other'])
        current=result['workspace'];current['papers'].append({'id':'new','title':'New paper'})
        restored=storage.restore_recovery({'id':result['recoveryId'],'workspace':current})
        self.assertEqual({p['id'] for p in restored['workspace']['papers']},{'fixture','other','new'})
        self.assertEqual(next(p for p in restored['workspace']['papers'] if p['id']=='fixture'),before['papers'][0])
        with self.assertRaises(ClientError):storage.restore_recovery({'id':result['recoveryId'],'workspace':current})
    def test_clear_recovery_survives_reload_and_keeps_backups(self):
        before=self.workspace();storage.save_library(before);storage.save_library(before)
        backups=list((self.root/'backups').glob('*.json'))
        result=storage.change_library({'action':'clear','workspace':before})
        self.assertEqual(storage.load_library()['papers'],[])
        self.assertTrue(all(path.exists() for path in backups))
        listed=storage.list_recovery();self.assertEqual(listed['items'][0]['count'],2)
        restored=storage.restore_recovery({'id':result['recoveryId'],'workspace':storage.load_library()})
        self.assertEqual(restored['workspace'],before)
    def test_restore_workspace_can_be_undone_without_losing_new_papers(self):
        cleared=storage.change_library({'action':'clear','workspace':self.workspace()})
        current={'papers':[{'id':'new','title':'New paper','text':'New full text'}], 'areas':[]}
        result=storage.restore_recovery({'id':cleared['recoveryId'],'workspace':current})
        undo=storage.restore_recovery({'id':result['recoveryId'],'workspace':result['workspace']})
        self.assertEqual(undo['workspace'],current)
    def test_delayed_save_cannot_resurrect_a_clear(self):
        storage.SAVE_REVISIONS.clear();before=self.workspace()
        storage.save_library(dict(before,_saveSession='fixture-session',_saveRevision=1))
        storage.change_library({'action':'clear','workspace':before,'_saveSession':'fixture-session','_saveRevision':3})
        result=storage.save_library(dict(before,_saveSession='fixture-session',_saveRevision=2))
        self.assertTrue(result['superseded']);self.assertEqual(storage.load_library()['papers'],[])
    def test_clear_retains_sync_removal_and_pause_state(self):
        before=dict(self.workspace(),mendeleyIgnored=['account:removed'])
        storage.change_library({'action':'clear','workspace':before})
        after=storage.load_library()
        self.assertTrue(after['mendeleySyncPaused']);self.assertEqual(after['mendeleyIgnored'],['account:removed'])
    def test_last_removal_and_restore(self):
        self.seed();before=storage.load_library()
        result=storage.change_library({'action':'remove','ids':['fixture'],'workspace':before})
        self.assertEqual(storage.load_library()['papers'],[])
        storage.restore_recovery({'id':result['recoveryId'],'workspace':result['workspace']})
        self.assertEqual(storage.load_library()['papers'],[self.paper])
    def test_snapshot_failure_does_not_change_saved_library(self):
        self.seed();before=storage.load_library()
        with patch.object(storage,'_write_recovery',side_effect=OSError('Disk full')):
            with self.assertRaises(OSError):storage.change_library({'action':'clear','workspace':before})
        self.assertEqual(storage.load_library()['papers'],[self.paper])
    def test_missing_selection_and_path_traversal_are_rejected(self):
        before=self.workspace()
        with self.assertRaises(ClientError):storage.change_library({'action':'remove','ids':['missing'],'workspace':before})
        with self.assertRaises(ClientError):storage.restore_recovery({'id':'../../library','workspace':before})
        self.assertEqual(storage.list_recovery()['items'],[])
    def test_recovery_files_are_private_and_listing_has_no_paper_text(self):
        result=storage.change_library({'action':'clear','workspace':self.workspace()})
        path=self.root/'recovery'/ (result['recoveryId']+'.json')
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertNotIn('Complete synthetic paper text',json.dumps(storage.list_recovery()))
