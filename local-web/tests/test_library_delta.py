"""Optimistic changed-paper saves retain atomic checkpoints and recovery barriers."""
import threading
import unittest
import test_library_save as save_tests
from test_library_save import storage, core, ClientError, patch, json

class LibraryDeltaTests(unittest.TestCase):
    def setUp(self):
        save_tests.LibrarySaveTests.setUp(self);storage.SAVE_REVISIONS.clear();self.addCleanup(storage.SAVE_REVISIONS.clear)
        self.papers=[{'id':str(i),'title':'Synthetic paper '+str(i),'text':'full text '*2000,'notes':''} for i in range(3)]
        self.workspace={'papers':self.papers,'areas':[],'links':[],'clusters':[], 'selectedId':None,'obsoleteSetting':'remove me'}
        self.initial=storage.save_library(dict(self.workspace,_saveSession='session-a',_saveRevision=1))
    def delta(self,**changes):
        payload={'_saveMode':'paper-delta-v1','_baseStorageRevision':self.initial['storageRevision'],
            '_saveSession':'session-a','_saveRevision':2,'upsertPapers':[], 'removePaperIds':[],
            'paperOrder':['0','1','2'],'workspaceChanges':{},'removeWorkspaceKeys':[]}
        payload.update(changes);return payload
    def test_changed_paper_metadata_and_order_preserve_other_full_text_and_backup(self):
        changed=dict(self.papers[1],notes='Latest local note')
        result=storage.save_library(self.delta(upsertPapers=[changed],paperOrder=['2','1','0'],
            workspaceChanges={'selectedId':'1'},removeWorkspaceKeys=['obsoleteSetting']))
        after=storage.load_library()
        self.assertEqual([p['id'] for p in after['papers']],['2','1','0'])
        self.assertEqual(after['papers'],[self.papers[2],changed,self.papers[0]])
        self.assertEqual(after['selectedId'],'1');self.assertNotIn('obsoleteSetting',after)
        self.assertTrue(result['deltaSupported']);self.assertNotEqual(result['storageRevision'],self.initial['storageRevision'])
        self.assertEqual(after['_storageRevision'],result['storageRevision'])
        for key in ['_saveMode','_baseStorageRevision','upsertPapers','workspaceChanges']:
            self.assertNotIn(key,after)
        backups=[json.loads(p.read_text()) for p in (self.root/'backups').glob('library_*.json')]
        self.assertTrue(any(b['papers']==self.papers for b in backups))
    def test_external_clear_blocks_delayed_patch_and_never_resurrects_papers(self):
        cleared=storage.change_library({'action':'clear','workspace':self.workspace,'_saveSession':'other-session','_saveRevision':1})
        with self.assertRaises(ClientError) as rejected:
            storage.save_library(self.delta(upsertPapers=[dict(self.papers[0],notes='late edit')]))
        self.assertEqual(rejected.exception.status,409)
        self.assertEqual(storage.load_library()['papers'],[])
        self.assertEqual(storage.SAVE_REVISIONS['session-a'],1,'A rejected delta does not advance the session')
        self.assertTrue((self.root/'recovery'/(cleared['recoveryId']+'.json')).exists())
    def test_own_clear_barrier_supersedes_older_patch_and_recovery_invalidates_baseline(self):
        result=storage.change_library({'action':'clear','workspace':self.workspace,'_saveSession':'session-a','_saveRevision':3})
        self.assertTrue(storage.save_library(self.delta())['superseded'])
        self.assertEqual(storage.load_library()['papers'],[])
        restored=storage.restore_recovery({'id':result['recoveryId'],'workspace':storage.load_library(),
            '_saveSession':'session-a','_saveRevision':4})
        with self.assertRaises(ClientError):storage.save_library(self.delta(_saveRevision=5))
        self.assertEqual(storage.load_library()['papers'],self.papers)
        self.assertTrue(restored['ok'])
    def test_invalid_delta_fields_cannot_partially_change_library(self):
        cases=[{'upsertPapers':[self.papers[0],self.papers[0]]}, {'paperOrder':['0','0','2']},
            {'removePaperIds':['missing']}, {'workspaceChanges':{'papers':[]}},
            {'removeWorkspaceKeys':['_storageRevision']}, {'upsertPapers':[{'title':'No ID'}]},
            {'removePaperIds':['0'],'paperOrder':['1','2'],'upsertPapers':[self.papers[0]]}]
        before=core.LIBRARY_PATH.read_bytes()
        for changes in cases:
            with self.subTest(changes=changes),self.assertRaises(ClientError):storage.save_library(self.delta(**changes))
            self.assertEqual(core.LIBRARY_PATH.read_bytes(),before)
            self.assertEqual(storage.SAVE_REVISIONS['session-a'],1)
    def test_last_paper_removal_requires_explicit_empty_permission(self):
        payload=self.delta(removePaperIds=['0','1','2'],paperOrder=[])
        with self.assertRaises(ClientError):storage.save_library(payload)
        self.assertEqual(storage.load_library()['papers'],self.papers)
        payload['workspaceChanges']={'allowEmpty':True}
        self.assertTrue(storage.save_library(payload)['ok']);self.assertEqual(storage.load_library()['papers'],[])
    def test_failed_checkpoint_can_retry_same_delta_revision(self):
        before=core.LIBRARY_PATH.read_bytes()
        with patch.object(core,'_save_library',side_effect=OSError('Synthetic disk failure')):
            with self.assertRaises(OSError):storage.save_library(self.delta())
        self.assertEqual(core.LIBRARY_PATH.read_bytes(),before)
        self.assertEqual(storage.SAVE_REVISIONS['session-a'],1)
        self.assertTrue(storage.save_library(self.delta())['ok'])
    def test_concurrent_baselines_have_one_winner_without_lost_updates(self):
        outcomes=[]
        def save(index):
            try:
                storage.save_library(self.delta(_saveSession='parallel-'+str(index),_saveRevision=1,
                    upsertPapers=[dict(self.papers[index],notes='winner-'+str(index))]))
                outcomes.append(('saved',index))
            except ClientError as error:outcomes.append((error.status,index))
        threads=[threading.Thread(target=save,args=(index,)) for index in [0,1]]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(sum(o[0]=='saved' for o in outcomes),1)
        self.assertEqual(sum(o[0]==409 for o in outcomes),1)
        winner=next(o[1] for o in outcomes if o[0]=='saved')
        self.assertEqual(storage.load_library()['papers'][winner]['notes'],'winner-'+str(winner))

if __name__=='__main__':
    import unittest
    unittest.main()
