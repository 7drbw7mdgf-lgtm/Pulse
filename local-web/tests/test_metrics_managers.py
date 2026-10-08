import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-connections-tests-'))
from pulse_core import paper_metrics as exported_metrics
import importlib
m = importlib.import_module('pulse_core.paper_metrics')
l = importlib.import_module('pulse_core.library_managers')
oauth = importlib.import_module('pulse_core.mendeley_oauth')
from pulse_core.constants import ClientError
import pulse_mcp

PAPER = {'title':'A theory of human motivation', 'doi':'10.1037/h0054346', 'authors':['Abraham H. Maslow'], 'year':'1943', 'metadataCheckedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
RAW = {'paperId':'abc123','title':PAPER['title'],'authors':[{'name':'Abraham H. Maslow'}], 'year':1943,
       'externalIds':{'DOI':PAPER['doi']}, 'citationCount':0, 'referenceCount':202, 'influentialCitationCount':0}

class MetricsTests(unittest.TestCase):
    def setUp(self): m._CACHE.clear()
    def test_zero_counts_preserved_from_confirmed_doi(self):
        with patch.object(m,'fetch_s2_json',return_value=RAW):
            result=m.paper_metrics({'paper':PAPER})['metrics']
        self.assertEqual(result['citationCount'],0)
        self.assertEqual(result['influentialCitationCount'],0)
        self.assertEqual(result['referenceCount'],202)
        self.assertEqual(result['source'],'Semantic Scholar')
        self.assertTrue(result['checkedAt'])
    def test_missing_count_is_not_zero(self):
        raw={k:v for k,v in RAW.items() if k!='influentialCitationCount'}
        with patch.object(m,'fetch_s2_json',return_value=raw): result=m.paper_metrics({'paper':PAPER})['metrics']
        self.assertIsNone(result['influentialCitationCount'])
    def test_different_doi_rejected_even_if_title_matches(self):
        raw=dict(RAW,externalIds={'DOI':'10.9999/wrong'})
        with patch.object(m,'fetch_s2_json',return_value=raw),patch.object(m,'_openalex_snapshot',return_value=None):
            with self.assertRaises(ClientError):m.paper_metrics({'paper':PAPER})
    def test_ambiguous_title_does_not_pick_first(self):
        a={'title':PAPER['title'],'authors':PAPER['authors'],'year':'1943','doi':'10.1/a'}
        self.assertIsNone(m.choose_candidate({'title':PAPER['title']},[a,dict(a,doi='10.1/b')]))
    def test_all_reference_pages_and_unresolved_coverage(self):
        snapshot=m.snapshot('Semantic Scholar','abc123',RAW,m.s2_to_metadata(RAW))
        def fetch(url,**kwargs):
            offset=int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['offset'][0])
            size=min(100,202-offset)
            rows=[{'citedPaper':{'paperId':str(i),'title':f'Reference {i}','authors':[]}} for i in range(offset,offset+size)]
            if offset==200: rows[-1]['citedPaper']=None
            return {'data':rows,**({'next':offset+size} if offset+size<202 else {})}
        with patch.object(m,'paper_metrics',return_value={'metrics':snapshot}),patch.object(m,'fetch_s2_json',side_effect=fetch):
            pages=[m.paper_relations({'paper':PAPER,'kind':'references','offset':n}) for n in (0,100,200)]
        self.assertEqual(sum(len(p['items']) for p in pages),201)
        self.assertEqual(pages[-1]['unresolved'],1)
        self.assertTrue(pages[-1]['complete'])
        self.assertEqual(pages[0]['total'],202)
    def test_openalex_fallback_is_not_mixed_with_s2(self):
        raw={'id':'https://openalex.org/W123','title':PAPER['title'],'doi':'https://doi.org/'+PAPER['doi'],
             'cited_by_count':0,'referenced_works':['https://openalex.org/W456'],'publication_year':1943}
        with patch.object(m,'fetch_s2_json',side_effect=ClientError(429,'Rate limited')),patch.object(m,'fetch_json',return_value=raw):
            result=m.paper_metrics({'paper':PAPER})['metrics']
        self.assertEqual(result['source'],'OpenAlex')
        self.assertEqual(result['referenceCount'],1)
        self.assertIsNone(result['influentialCitationCount'])
    def test_repeated_cursor_is_an_error(self):
        snapshot={'source':'OpenAlex','identifier':'W123','citationCount':3,'checkedAt':'today'}
        with patch.object(m,'paper_metrics',return_value={'metrics':snapshot}),patch.object(m,'fetch_json',return_value={'results':[{'title':'Paper'}],'meta':{'next_cursor':'*'}}):
            with self.assertRaises(ClientError):m.paper_relations({'paper':PAPER,'kind':'citations'})
    def test_list_index_total_and_paper_counter_are_separate(self):
        snapshot={'source':'OpenAlex','identifier':'W123','citationCount':500,'checkedAt':'today'}
        with patch.object(m,'paper_metrics',return_value={'metrics':snapshot}),patch.object(m,'fetch_json',return_value={'results':[{'title':'Paper'}],'meta':{'count':480,'next_cursor':'next-page'}}):
            result=m.paper_relations({'paper':PAPER,'kind':'citations'})
        self.assertEqual(result['total'],480)
        self.assertEqual(result['reportedTotal'],500)
        self.assertFalse(result['complete'])
    def test_provider_change_requires_new_list(self):
        with patch.object(m,'paper_metrics',return_value={'metrics':{'source':'OpenAlex'}}):
            with self.assertRaises(ClientError) as error:m.paper_relations({'paper':PAPER,'kind':'references','source':'Semantic Scholar'})
        self.assertEqual(error.exception.status,409)
    def test_withheld_references_are_not_a_complete_empty_list(self):
        snapshot=m.snapshot('Semantic Scholar','abc123',RAW,m.s2_to_metadata(RAW))
        with patch.object(m,'paper_metrics',return_value={'metrics':snapshot}),patch.object(m,'fetch_s2_json',return_value={'data':None}):
            with self.assertRaises(ClientError) as error:m.paper_relations({'paper':PAPER,'kind':'references'})
        self.assertEqual(error.exception.status,403)

class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.directory=patch.object(l,'CONFIG_DIR',Path(self.temp.name));self.directory.start()
    def tearDown(self):self.directory.stop();self.temp.cleanup()
    def test_client_secret_private_and_config_redacted(self):
        l.configure_mendeley({'clientId':'test-client','clientSecret':'test-private-secret'})
        raw=(Path(self.temp.name)/'library-managers.json').read_text()
        self.assertNotIn('test-private-secret',raw)
        self.assertNotIn('clientSecret',l.public_config())
        self.assertEqual((Path(self.temp.name)/'library-managers.json').stat().st_mode&0o777,0o600)
    def test_callback_must_be_loopback_and_fixed_path(self):
        for url in ['https://example.com/mendeley/callback','http://127.0.0.1:8765/other','http://user@127.0.0.1:8765/mendeley/callback']:
            with self.subTest(url=url),self.assertRaises(ClientError):l.validate_redirect(url)
    def test_zotero_duplicate_send_and_metadata_only(self):
        calls=[]
        def request(url,*args,**kwargs):
            calls.append((url,args))
            return {'name':'My test collection','libraryID':1,'id':2,'editable':True} if 'getSelectedCollection' in url else {}
        with patch.object(l,'request',side_effect=request):
            first=l.save_manager_records({'provider':'zotero','papers':[dict(PAPER,text='PRIVATE FULL TEXT',abstract='Test abstract')]})
            second=l.save_manager_records({'provider':'zotero','papers':[PAPER]})
        imports=[args for url,args in calls if '/connector/import' in url]
        self.assertEqual(len(imports),1)
        self.assertNotIn('PRIVATE FULL TEXT',imports[0][1].decode())
        self.assertEqual(len(first['saved']),1)
        self.assertEqual(len(second['skipped']),1)
    def test_read_only_zotero_target_is_not_written(self):
        with patch.object(l,'request',return_value={'editable':False}) as request:
            with self.assertRaises(ClientError):l.save_manager_records({'provider':'zotero','papers':[PAPER]})
        self.assertEqual(request.call_count,1)
    def test_partial_mendeley_failure_keeps_success_receipt(self):
        l.write_config({'accessToken':'test-token','expiresAt':time.time()+3600})
        with patch.object(l,'access_token',return_value='test-token'),patch.object(l,'request',side_effect=[{'id':'doc1'},ClientError(429,'Rate limited')]):
            result=l.save_manager_records({'provider':'mendeley','papers':[PAPER,dict(PAPER,title='Other title',doi='10.1234/other')]})
        self.assertEqual(len(result['saved']),1)
        self.assertEqual(len(result['errors']),1)
        self.assertFalse(result['ok'])
        self.assertIn(l.fingerprint(l.record_metadata(PAPER)),l.read_config()['mendeleyReceipts'])
    def test_disconnect_prevents_delayed_token_exchange(self):
        l.configure_mendeley({'clientId':'test-client','clientSecret':'test-secret'})
        config=l.read_config();l.disconnect_mendeley()
        with patch.object(l,'request',side_effect=[{'access_token':'new-token'}, {'id':'test-profile'}]):
            with self.assertRaises(ClientError):l.token_exchange(config,{'grant_type':'authorization_code','code':'example'})
        self.assertNotIn('accessToken',l.read_config())
    def test_restart_waits_for_previous_callback_listener(self):
        worker=Mock()
        previous={'cancelled':False,'worker':worker}
        with patch.object(oauth,'_PENDING',previous):
            oauth.cancel_oauth()
            self.assertIsNone(oauth._PENDING)
        self.assertTrue(previous['cancelled'])
        worker.join.assert_called_once_with(timeout=.75)
    def test_mcp_initialization_and_write_error(self):
        init=pulse_mcp.dispatch({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}})
        self.assertEqual(init['result']['capabilities'],{'tools':{'listChanged':False}})
        tools=pulse_mcp.dispatch({'jsonrpc':'2.0','id':2,'method':'tools/list'})['result']['tools']
        save=next(t for t in tools if t['name']=='library_manager_save')
        self.assertFalse(save['annotations']['readOnlyHint'])
        result=pulse_mcp.dispatch({'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'library_manager_save','arguments':{'provider':'zotero','papers':[]}}})
        self.assertTrue(result['result']['isError'])

if __name__=='__main__':unittest.main()
