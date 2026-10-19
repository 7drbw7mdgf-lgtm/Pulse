import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import pulse_core as core
from pulse_core import discovery, external_apis, openalex_cache
from pulse_performance import REQUEST_CONTEXT, DiscoveryCancelled, submit_with_context, _disk_http_cache_ttl


class OpenAlexSharedCacheTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory()
        self.env=patch.dict(os.environ,{'PULSE_CONFIG_DIR':self.folder.name});self.env.start()
        self.addCleanup(self.env.stop);self.addCleanup(self.folder.cleanup)

    def test_batch_response_reuses_singleton_by_doi_and_id_without_another_request(self):
        item={'id':'https://openalex.org/W1','doi':'https://doi.org/10.1234/cache','title':'Cached paper','referenced_works':['W2']}
        openalex_cache.remember_works('https://api.openalex.org/works?filter=openalex_id:W1',{'results':[item]})
        with patch.object(external_apis,'request_json') as network:
            for ident in ('W1','https%3A%2F%2Fdoi.org%2F10.1234%2Fcache'):
                data=external_apis.fetch_json('https://api.openalex.org/works/'+ident+'?select=id,title,referenced_works')
                self.assertEqual(data['referenced_works'],['W2'])
            network.assert_not_called()

    def test_partial_cache_never_pretends_missing_reference_fields_are_complete(self):
        openalex_cache.remember_works('https://api.openalex.org/works?select=id,title',{'results':[{'id':'W1','title':'Short metadata'}]})
        self.assertIsNone(openalex_cache.cached_work('https://api.openalex.org/works/W1?select=id,title,referenced_works'))
        self.assertIsNone(openalex_cache.cached_work('https://api.openalex.org/works/W1'))

    def test_partial_refresh_cannot_extend_old_reference_data_lifetime(self):
        url='https://api.openalex.org/works/W1'
        with patch.object(openalex_cache.time,'time',return_value=100):
            openalex_cache.remember_works(url,{'id':'W1','title':'Original','referenced_works':['W2']})
        with patch.object(openalex_cache.time,'time',return_value=200):
            openalex_cache.remember_works(url+'?select=id,title',{'id':'W1','title':'Updated'})
        with patch.object(openalex_cache.time,'time',return_value=101+openalex_cache.TTL):
            self.assertIsNone(openalex_cache.cached_work(url))

    def test_cache_contains_no_api_key_or_contact_email_and_honors_expiry(self):
        openalex_cache.remember_works('https://api.openalex.org/works/W1?api_key=synthetic-private-key&mailto=private@example.com',{'id':'W1','title':'Public metadata'})
        db=Path(self.folder.name)/'openalex-works.sqlite3'
        self.assertNotIn(b'synthetic-private-key',db.read_bytes());self.assertNotIn(b'private@example.com',db.read_bytes())
        self.assertEqual(db.stat().st_mode & 0o777,0o600)
        connection=sqlite3.connect(db)
        try:
            connection.execute('UPDATE works SET expires=0');connection.commit()
        finally: connection.close()
        self.assertIsNone(openalex_cache.cached_work('https://api.openalex.org/works/W1'))

    def test_encoded_citation_urls_receive_the_intended_seven_day_cache(self):
        for field in ('cites','cited_by','openalex_id'):
            self.assertEqual(_disk_http_cache_ttl('https://api.openalex.org/works?'+urllib.parse.urlencode({'filter':field+':W1'})),604800)

    def test_full_reference_list_fetches_in_parallel_even_with_small_display_limit(self):
        gate=threading.Barrier(3)
        def fetch(url):
            gate.wait(timeout=2)
            params=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            ids=params['filter'][0].split(':')[1].split('|')
            return {'results':[{'id':ident,'title':'Reference '+ident} for ident in ids]}
        with patch.object(core,'fetch_json',side_effect=fetch),patch.object(discovery,'openalex_discovery_works') as query:
            found=discovery.openalex_reference_works('W9999',limit=20,referenced_works=['W'+str(i) for i in range(250)])
        self.assertEqual(len(found),250);query.assert_not_called()

    def test_nested_requests_share_cancellation_deadline_and_counter(self):
        event=threading.Event();counter={'remaining':3,'lock':threading.Lock()};deadline=time.monotonic()+5
        with patch.object(REQUEST_CONTEXT,'cancel_event',event,create=True),patch.object(REQUEST_CONTEXT,'deadline',deadline,create=True),patch.object(REQUEST_CONTEXT,'request_counter',counter,create=True):
            with ThreadPoolExecutor(max_workers=1) as pool:
                self.assertEqual(submit_with_context(pool,lambda:(REQUEST_CONTEXT.deadline,REQUEST_CONTEXT.request_counter is counter)).result(),(deadline,True))
                event.set()
                with self.assertRaises(DiscoveryCancelled):submit_with_context(pool,lambda:None).result()

    def test_reference_results_are_published_before_a_slow_forward_stream(self):
        ready=threading.Event()
        def citing(*args,**kwargs):
            self.assertTrue(ready.wait(timeout=2),'References were blocked behind the slower forward stream')
            return [{'id':'W3','title':'Citing paper'}]
        def partial(rows):
            if any(row.get('subType')=='Backward' for row in rows):ready.set()
        with patch.object(REQUEST_CONTEXT,'on_partial',partial,create=True),patch.object(discovery,'openalex_citing_works',side_effect=citing),patch.object(discovery,'openalex_reference_works',return_value=[{'id':'W2','title':'Reference'}]):
            found=discovery.fetch_citation_graph_branch([{'title':'Seed'}],seed_works=[{'id':'W1','referenced_works':['W2']}],depth=1)
        self.assertEqual(len(found),2)

    def test_topic_search_begins_while_seed_resolution_is_waiting(self):
        ready=threading.Event();observed=[]
        def resolve(paper): observed.append(ready.wait(timeout=2));return None
        def search(*args,**kwargs): ready.set();return []
        payload={'seedPapers':[{'title':'Bacterial vesicles'}], 'semanticRerank':False,'pairwiseRerank':False,
                 'branches':{'citationGraph':True,'citationNetwork':False,'citationCoCitation':False,'authorTrajectory':False,'semanticSearch':False,'lexicalSearch':True},
                 'searchSources':{'europePmc':True,'semanticScholar':False,'core':False,'arxiv':False}}
        with patch.object(core,'load_settings',return_value={}),patch.object(core,'openalex_work_for_paper',side_effect=resolve),patch.object(core,'fetch_citation_graph_branch',return_value=[]),patch.object(discovery,'search_query_plan',side_effect=search):
            result=discovery.run_discovery_pipeline(payload)
        self.assertEqual(observed,[True]);self.assertEqual(result['errors'],{})
