import io
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
import pulse_backend as backend
import pulse_performance as perf

class PerformanceTests(unittest.TestCase):
    def test_revision_order_and_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(backend,'CONFIG_DIR',Path(folder)),patch.object(backend,'LIBRARY_PATH',Path(folder)/'library.json'):
                backend.save_library({'papers':[{'id':'new'}],'_saveSession':folder,'_saveRevision':2})
                result=backend.save_library({'papers':[{'id':'old'}],'_saveSession':folder,'_saveRevision':1})
                self.assertTrue(result['superseded']);self.assertEqual(backend.load_library()['papers'][0]['id'],'new')
                backend.save_library({'papers':[],'reset':True,'_saveSession':folder,'_saveRevision':3})
                backend.save_library({'papers':[{'id':'old'}],'_saveSession':folder,'_saveRevision':2})
                self.assertEqual(backend.load_library()['papers'],[])
    def test_failed_save_does_not_commit_revision(self):
        with patch.object(backend,'_save_library',side_effect=[OSError('disk full'),{'ok':True}]):
            payload={'papers':[],'_saveSession':'test-disk-failure','_saveRevision':1}
            with self.assertRaises(OSError):backend.save_library(payload)
            self.assertTrue(backend.save_library(payload)['ok'])
    def test_persistent_vectors_and_invalidation(self):
        with tempfile.TemporaryDirectory() as folder:
            config=Path(folder)
            with patch.object(backend,'CONFIG_DIR',config),patch.object(backend,'_ollama_embedding',return_value=[.1,.2]) as compute:
                settings={'embeddingModel':'first'}
                self.assertEqual(backend.ollama_embedding(settings,'document text'),[.1,.2])
                backend.ollama_embedding(settings,'document text');self.assertEqual(compute.call_count,1)
                backend.ollama_embedding(settings,'changed document text')
                backend.ollama_embedding({**settings,'embeddingModel':'second'},'document text');self.assertEqual(compute.call_count,3)
                self.assertNotIn(b'document text',(config/'embedding-cache.sqlite3').read_bytes())
    def test_concurrent_vectors_coalesce(self):
        with tempfile.TemporaryDirectory() as folder:
            calls=[]
            def compute():calls.append(1);time.sleep(.03);return [.2]
            threads=[threading.Thread(target=lambda:perf.cached_embedding(Path(folder),['model'],'same text',compute)) for _ in range(4)]
            for t in threads:t.start()
            for t in threads:t.join()
            self.assertEqual(len(calls),1)
    def test_json_cache_clones_records(self):
        request=urllib.request.Request('https://unit.test/cache-unique-1')
        with patch.object(perf.urllib.request,'urlopen',return_value=io.BytesIO(b'{"items":[1]}')) as network:
            result=perf.request_json(request);result['items'].append(2)
            self.assertEqual(perf.request_json(request),{'items':[1]});self.assertEqual(network.call_count,1)
    def test_retry_after_and_cancellation(self):
        request=urllib.request.Request('https://unit.test/retry-unique-1')
        error=urllib.error.HTTPError(request.full_url,429,'limited',{'Retry-After':'2'},io.BytesIO(b''))
        with patch.object(perf.urllib.request,'urlopen',side_effect=[error,io.BytesIO(b'{"ok":true}')]),patch.object(perf,'_wait') as delay:
            self.assertTrue(perf.request_json(request)['ok']);delay.assert_called_once_with(2.)
        event=threading.Event();event.set();perf.REQUEST_CONTEXT.cancel_event=event
        try:
            with patch.object(perf.urllib.request,'urlopen') as network:
                with self.assertRaises(perf.DiscoveryCancelled):perf.request_json(request)
                network.assert_not_called()
        finally:perf.REQUEST_CONTEXT.cancel_event=None
    def test_parallel_branches_report_deterministically(self):
        barrier=threading.Barrier(3);active=[];updates=[]
        def branch(name):
            def run():active.append(name);barrier.wait(timeout=2);return [name]
            return run
        results,order,errors=perf.parallel_branches({name:branch(name) for name in ['a','b','c']},lambda *args:updates.append(args))
        self.assertEqual(order,['a','b','c']);self.assertEqual(errors,{});self.assertEqual(len(updates),3);self.assertEqual(set(active),{'a','b','c'})
    def test_job_cancel_discards_late_results(self):
        jobs=perf.DiscoveryJobs();release=threading.Event();started=threading.Event()
        def runner(payload,on_progress,cancel_event):
            on_progress({'recommendations':[{'title':'partial'}]});started.set();release.wait(2)
            on_progress({'recommendations':[{'title':'late'}]});return {'recommendations':[{'title':'late'}]}
        job=jobs.start({},runner);started.wait(2);jobs.cancel(job['id']);release.set()
        deadline=time.monotonic()+2
        while not jobs.jobs[job['id']]['_finished'] and time.monotonic()<deadline:time.sleep(.01)
        result=jobs.read(job['id']);self.assertEqual(result['status'],'cancelled');self.assertEqual(result['recommendations'],[{'title':'partial'}])
    def test_failed_branch_keeps_successful_results(self):
        def bad():raise RuntimeError('Provider unavailable')
        results,order,errors=perf.parallel_branches({'good':lambda:[{'title':'kept'}],'bad':bad})
        self.assertEqual(results['good'][0]['title'],'kept');self.assertIn('Provider unavailable',errors['bad'])
