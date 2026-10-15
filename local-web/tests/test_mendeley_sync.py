import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-sync-tests-'))
from pulse_core.constants import ClientError
from pulse_core import library_managers as managers, mendeley_sync as sync, mendeley_broker as broker
from pulse_core.metadata_utils import crossref_to_metadata,openalex_to_metadata

CONFIG={'authFlow':'broker','brokerUrl':'https://auth.example','brokerSession':'s'*64,'mendeleyAccountId':'account-one','authGeneration':2}
DOCUMENT={'id':'doc-one','title':'Synthetic transport study','authors':[{'first_name':'Ada','last_name':'Brooks'}],'source':'Transport Review','year':2025,'month':6,'day':5,'identifiers':{'doi':'10.1234/test','issn':'1234-5678'},'volume':'10','issue':'2','pages':'20-29','publisher':'Test Press','websites':['https://example.org/paper'],'keywords':['network'],'tags':['local tag']}

class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.directory=patch.object(managers,'CONFIG_DIR',Path(self.temp.name));self.directory.start();managers.write_config(CONFIG)
    def tearDown(self):self.directory.stop();self.temp.cleanup()
    def test_page_preserves_full_bibliographic_fields(self):
        with patch.object(broker,'library',return_value={'data':[DOCUMENT,{'id':'untitled'}],'next':'/documents?marker=next&limit=100','accountId':'account-one'}):result=sync.page({})
        self.assertEqual(result['next'],'/documents?marker=next&limit=100');self.assertEqual(result['skipped'],1)
        paper=result['items'][0]
        self.assertEqual(paper['authors'],['Ada Brooks']);self.assertEqual(paper['doi'],'10.1234/test');self.assertEqual(paper['date'],'2025-06-05')
        for field in ('volume','issue','pages','publisher','issn','url'):self.assertTrue(paper[field])
        self.assertIn('local tag',paper['paperKeywords'])
    def test_account_change_cannot_apply_a_stale_page(self):
        def fetch(*args,**kwargs):
            managers.write_config(dict(CONFIG,authGeneration=3,mendeleyAccountId='other'))
            return {'data':[DOCUMENT],'next':None,'accountId':'account-one'}
        with patch.object(broker,'library',side_effect=fetch),self.assertRaises(ClientError):sync.page({})
    def test_request_cannot_cross_account_or_proxy_elsewhere(self):
        with patch.object(broker,'library') as fetch:
            with self.assertRaises(ClientError):sync.page({'accountId':'other'})
            for path in ['https://evil.example/documents','//evil.example/documents','/profiles/v2/me','/documents?limit=501','/documents?view=bib']:
                with self.subTest(path=path),self.assertRaises(ClientError):sync.page({'page':path})
        fetch.assert_not_called()
    def test_preferences_are_persistent_and_account_bound(self):
        sync.preferences({'automatic':False});self.assertFalse(managers.read_config()['mendeleyAutomaticSync'])
        with self.assertRaises(ClientError):sync.preferences({'completed':True,'accountId':'other'})
        sync.preferences({'completed':True,'accountId':'account-one'});self.assertTrue(managers.read_config()['mendeleyLastSyncedAt'])
    def test_opaque_session_is_encrypted_and_not_public(self):
        self.assertNotIn('s'*64,(Path(self.temp.name)/'library-managers.json').read_text())
        self.assertNotIn('brokerSession',managers.public_config());self.assertEqual(managers.public_config()['configured'],True)
    def test_disconnect_clears_local_grant_even_when_service_unreachable(self):
        with patch.object(broker,'request',side_effect=ClientError(502,'offline')):result=managers.disconnect_mendeley()
        self.assertTrue(result['ok']);self.assertIn('revocation',result['message']);self.assertNotIn('brokerSession',managers.read_config())
        self.assertEqual(managers.read_config()['authGeneration'],3)
    def test_broker_transfer_does_not_reacquire_file_lock_and_sends_full_metadata(self):
        paper=sync.normalized_document(DOCUMENT);paper['metadataCheckedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        with patch.object(broker,'library',return_value={'data':{'id':'saved'}}) as send:
            result=managers.save_manager_records({'provider':'mendeley','papers':[paper]})
        self.assertEqual(len(result['saved']),1);data=send.call_args[0][2]
        self.assertEqual(data['pages'],'20-29');self.assertEqual(data['publisher'],'Test Press');self.assertEqual(data['websites'],['https://example.org/paper'])
        self.assertEqual(data['month'],6);self.assertEqual(data['authors'][0]['last_name'],'Brooks');self.assertNotIn('text',data)
    def test_disconnect_during_transfer_cannot_restore_old_session(self):
        paper=sync.normalized_document(DOCUMENT);paper['metadataCheckedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        def delayed(*args,**kwargs):
            managers.disconnect_mendeley()
            return {'data':{'id':'saved-before-disconnect'}}
        with patch.object(broker,'request',return_value={'ok':True}),patch.object(broker,'library',side_effect=delayed):
            result=managers.save_manager_records({'provider':'mendeley','papers':[paper]})
        self.assertNotIn('brokerSession',managers.read_config());self.assertFalse(result['ok']);self.assertEqual(result['errors'][0]['error'].startswith('The Mendeley connection changed'),True)
    def test_backend_transfer_resolves_missing_details_and_retains_supplied_edits(self):
        from pulse_core import metadata_resolution
        with patch.object(metadata_resolution,'resolve_metadata',return_value={'matched':True,'metadata':dict(title='Registry title',journal='Transport Review',volume='10',pages='20-29')}):
            record=managers.complete_record({'title':'My chosen title','doi':'10.1234/test'})
        self.assertEqual(record['title'],'My chosen title');self.assertEqual(record['volume'],'10');self.assertEqual(record['pages'],'20-29')
    def test_ris_has_complete_fields_and_safe_line_breaks(self):
        record=sync.normalized_document(DOCUMENT);record['abstract']='One\nTY  - malicious';record['authors']=['Brooks, Ada']
        output=managers.ris([record])
        for field in ['VL  - 10','IS  - 2','SP  - 20','EP  - 29','PB  - Test Press','SN  - 1234-5678','UR  - https://example.org/paper','KW  - network']:self.assertIn(field,output)
        self.assertNotIn('\nTY  - malicious',output);self.assertEqual(managers.mendeley_document(record)['authors'][0],{'first_name':'Ada','last_name':'Brooks'})
    def test_provider_fields_include_full_date_article_number_and_page_range(self):
        cr=crossref_to_metadata({'title':['Synthetic study'],'published-print':{'date-parts':[[2025,6,5]]},'publisher':'Test Press','article-number':'e100','URL':'https://example.org','ISBN':['1234'],'language':'en'})
        self.assertEqual(cr['date'],'2025-06-05');self.assertEqual(cr['articleNumber'],'e100');self.assertEqual(cr['publisher'],'Test Press')
        oa=openalex_to_metadata({'biblio':{'first_page':'20','last_page':'29'},'publication_date':'2025-06-05'})
        self.assertEqual(oa['pages'],'20-29')
    def test_direct_first_and_subsequent_pages_request_document_media_type(self):
        direct=dict(CONFIG,authFlow='code',clientId='test-client',accessToken='test-access',expiresAt=time.time()+3600)
        direct.pop('brokerSession');managers.write_config(direct)
        next_page='/documents?view=all&marker=next&limit=100&reverse=false&order=asc'
        urls=[]
        def fetch(url,headers=None,envelope=False,**kwargs):
            urls.append(url)
            if not headers or headers.get('Accept')!='application/vnd.mendeley-document.1+json':
                raise ClientError(406,'Synthetic unacceptable document media type')
            self.assertTrue(envelope)
            self.assertEqual(headers['Authorization'],'Bearer test-access')
            if url==managers.MENDELEY+'/documents?view=all&limit=100':
                return {'data':[DOCUMENT],'next':next_page}
            self.assertEqual(url,managers.MENDELEY+next_page)
            return {'data':[dict(DOCUMENT,id='doc-two')],'next':None}
        with patch.object(managers,'request',side_effect=fetch):
            first=sync.page({})
            second=sync.page({'page':first['next'],'accountId':'account-one'})
        self.assertEqual(first['items'][0]['remoteId'],'doc-one')
        self.assertEqual(second['items'][0]['remoteId'],'doc-two')
        self.assertIsNone(second['next']);self.assertEqual(len(urls),2)
    def test_direct_sync_confirms_account_with_profile_media_type(self):
        direct=dict(CONFIG,authFlow='code',clientId='test-client',accessToken='test-access',expiresAt=time.time()+3600)
        direct.pop('brokerSession');direct.pop('mendeleyAccountId');managers.write_config(direct)
        with patch.object(managers,'request',return_value={'id':'confirmed-account'}) as request:
            result=sync.connected_config()
        self.assertEqual(result['mendeleyAccountId'],'confirmed-account')
        self.assertEqual(request.call_args.args[0],managers.MENDELEY+'/profiles/me')
        self.assertEqual(request.call_args.kwargs['headers']['Accept'],'application/vnd.mendeley-profiles.1+json')
    def test_broker_sync_does_not_make_direct_provider_request(self):
        with patch.object(broker,'library',return_value={'data':[DOCUMENT],'next':None,'accountId':'account-one'}) as broker_request,patch.object(managers,'request') as request:
            result=sync.page({})
        self.assertEqual(len(result['items']),1)
        request.assert_not_called()
        broker_request.assert_called_once_with('/documents?view=all&limit=100',config=managers.read_config())
    def test_pagination_reverse_accepts_only_single_boolean_value(self):
        for reverse in ['true','false']:
            path='/documents?view=all&marker=next&limit=100&reverse='+reverse+'&order=asc'
            with self.subTest(reverse=reverse):self.assertEqual(sync.validate_page(path),path)
        for suffix in ['reverse=','reverse=True','reverse=0','reverse=anything','reverse=true&reverse=false','reverse=false&reverse=false']:
            with self.subTest(suffix=suffix),self.assertRaises(ClientError):sync.validate_page('/documents?limit=100&'+suffix)
    def test_provider_link_retains_reverse_and_rejects_foreign_host(self):
        next_path='/documents?view=all&marker=next&limit=100&reverse=false&order=asc'
        response=MagicMock();response.__enter__.return_value=response;response.read.return_value=b'[]'
        opener=Mock();opener.open.return_value=response
        response.headers={'Link':'<'+managers.MENDELEY+next_path+'>; rel="next"'}
        with patch.object(managers.urllib.request,'build_opener',return_value=opener):
            envelope=managers.request(managers.MENDELEY+'/documents?view=all&limit=100',headers={'Accept':'application/vnd.mendeley-document.1+json'},envelope=True)
            self.assertEqual(envelope['next'],next_path)
            self.assertEqual(sync.validate_page(envelope['next']),next_path)
            response.headers={'Link':'<https://foreign.example'+next_path+'>; rel="next"'}
            with self.assertRaises(ClientError):
                managers.request(managers.MENDELEY+'/documents?view=all&limit=100',headers={'Accept':'application/vnd.mendeley-document.1+json'},envelope=True)

if __name__=='__main__':unittest.main()
