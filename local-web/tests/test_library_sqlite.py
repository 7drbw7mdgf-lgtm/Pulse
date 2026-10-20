import json
from pathlib import Path
import sqlite3
import threading
import unittest
from contextlib import closing
from unittest.mock import patch
import test_library_save as fixtures
from test_library_save import storage, core, ClientError

class SQLiteLibraryTests(unittest.TestCase):
    def setUp(self):
        fixtures.LibrarySaveTests.setUp(self);storage.SAVE_REVISIONS.clear()
    def test_migration_retains_personal_fields_and_original_json(self):
        original={'papers':[{'id':'a','title':'Study','notes':'Personal note','userTags':['My tag'],'text':'Local full text','syncId':'retained'}],
                  'maps':[{'id':'one'}],'savedSearches':[{'id':'watch'}],'mendeleyIgnored':['removed'],'_storageRevision':'a'*32}
        core.LIBRARY_PATH.write_text(json.dumps(original));before=core.LIBRARY_PATH.read_bytes()
        after=storage.load_library()
        self.assertEqual(after['papers'],original['papers']);self.assertEqual(after['savedSearches'],original['savedSearches'])
        self.assertEqual(after['_storageRevision'],'a'*32);self.assertEqual(core.LIBRARY_PATH.read_bytes(),before)
        self.assertTrue(list((self.root/'backups').glob('library_pre_sqlite_*.json')))
    def test_one_paper_delta_does_not_rewrite_other_rows_or_json(self):
        papers=[{'id':str(i),'title':'Study '+str(i),'text':'Full text '*1000} for i in range(40)]
        first=storage.save_library({'papers':papers});baseline=core.LIBRARY_PATH.read_bytes()
        db=sqlite3.connect(core.LIBRARY_PATH.with_suffix('.sqlite3'))
        db.executescript('CREATE TABLE updates(id TEXT);CREATE TRIGGER track_updates AFTER UPDATE ON papers BEGIN INSERT INTO updates VALUES(new.id); END;');db.close()
        result=storage.save_library({'_saveMode':'paper-delta-v1','_baseStorageRevision':first['storageRevision'],
            'upsertPapers':[dict(papers[4],notes='Edited')],'removePaperIds':[],'paperOrder':[p['id'] for p in papers],
            'workspaceChanges':{},'removeWorkspaceKeys':[]})
        self.assertEqual(result['changedPapers'],1);self.assertEqual(core.LIBRARY_PATH.read_bytes(),baseline)
        with closing(sqlite3.connect(core.LIBRARY_PATH.with_suffix('.sqlite3'))) as db:self.assertEqual(db.execute('SELECT id FROM updates').fetchall(),[('4',)])
        self.assertEqual(storage.load_library()['papers'][4]['notes'],'Edited')
    def test_indexed_phrase_and_tag_search_all_any_and_removed_indexes(self):
        storage.save_library({'papers':[{'id':'a','title':'Outer membrane vesicles','abstract':'Biofilm formation','userTags':['Immunity']},
            {'id':'b','title':'Biofilm assembly','userTags':['Transport']} ]})
        store=storage.library_store()
        self.assertEqual([p['id'] for p in store.search(['outer membrane vesicles'],['IMMUNITY'])['papers']],['a'])
        self.assertEqual(store.search(['Biofilm'],['Transport'],match='any')['total'],2)
        self.assertEqual(store.search(['Biofilm'],['Transport'],match='all')['total'],1)
        storage.save_library({'papers':[{'id':'b','title':'Changed title'}]})
        self.assertEqual(store.search([],['Immunity'])['total'],0)
        self.assertEqual(store.search(['Biofilm'])['total'],0)
    def test_failed_transaction_rolls_back_paper_data_and_search_index(self):
        storage.save_library({'papers':[{'id':'a','title':'Original study'}]});before=storage.load_library()
        from pulse_core.library_store import LibraryStore
        original=LibraryStore._upsert
        def broken(store,db,paper):
            original(store,db,paper);raise OSError('Synthetic disk failure')
        with patch.object(LibraryStore,'_upsert',broken):
            with self.assertRaises(OSError):storage.save_library({'papers':[{'id':'a','title':'New title'}]})
        self.assertEqual(storage.load_library(),before)
        self.assertEqual(storage.library_store().search(['Original'])['total'],1)
    def test_distinct_connections_cannot_both_commit_one_baseline(self):
        first=storage.save_library({'papers':[{'id':'a','title':'Study'}]});outcomes=[]
        payload={'_saveMode':'paper-delta-v1','_baseStorageRevision':first['storageRevision'], 'upsertPapers':[],
            'removePaperIds':[],'paperOrder':['a'],'workspaceChanges':{},'removeWorkspaceKeys':[]}
        def write():
            try:storage.library_store().write(payload);outcomes.append('saved')
            except ClientError as e:outcomes.append(e.status)
        threads=[threading.Thread(target=write) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertCountEqual(outcomes,['saved',409])
