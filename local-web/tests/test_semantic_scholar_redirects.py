"""Exercise real urllib redirect processing with a synthetic HTTPS transport."""
import io
import json
import os
from email.message import Message
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request
import urllib.response
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
import pulse_performance as perf
from pulse_core import s2_client as s2
from pulse_core.constants import ClientError
from pulse_source_health import clear

KEY='fixture-s2-private-key-never-forward'
ORIGIN='https://api.semanticscholar.org'
URL=ORIGIN+'/graph/v1/paper/fixture'
RAW={'paperId':'fixture','title':'Synthetic paper'}

class SemanticScholarRedirectTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        environment=patch.dict(os.environ,{'PULSE_CONFIG_DIR':folder.name});environment.start();self.addCleanup(environment.stop)
        self.directory=Path(folder.name)
        s2.S2_CACHE.clear();s2._INVALID_S2_KEYS.clear();perf._JSON_CACHE.clear();clear()
        self.addCleanup(clear);self.addCleanup(s2._INVALID_S2_KEYS.clear)
        self.seen=[]

    def transport(self,route):
        seen=self.seen
        class FakeHTTPS(urllib.request.HTTPSHandler):
            def https_open(self,request):
                seen.append(request)
                status,headers,body=route(request)
                response_headers=Message()
                for name,value in headers.items():response_headers[name]=value
                response=urllib.response.addinfourl(io.BytesIO(body),response_headers,request.full_url,status)
                response.msg='Synthetic response'
                return response
        real_builder=urllib.request.build_opener
        def opener(*handlers):return real_builder(*handlers,FakeHTTPS())
        # Force precisely the production fallback that previously followed any host.
        return (patch.object(perf,'_urlopen_persistent',side_effect=OSError('Synthetic pooled transport failure')),
                patch.object(perf.urllib.request,'build_opener',side_effect=opener))

    def fetch_with_route(self,route,post=False,cache=False):
        fallback,opener=self.transport(route)
        with fallback,opener:
            if post:return s2.post_s2_json(URL,{'ids':['fixture']},api_key=KEY)
            return s2.fetch_s2_json(URL,api_key=KEY,cache=cache)

    def test_cross_origin_downgrade_and_userinfo_redirects_never_receive_the_key(self):
        for target in ['https://other.example/collect','https://api.semanticscholar.org.evil.example/collect',
                       'http://api.semanticscholar.org/collect','https://api.semanticscholar.org:444/collect',
                       'https://api.semanticscholar.org:0/collect',
                       'https://user@api.semanticscholar.org/collect','https://@api.semanticscholar.org/collect']:
            for post in [False,True]:
                with self.subTest(target=target,post=post):
                    self.seen.clear();clear()
                    with self.assertRaises(ClientError) as blocked:
                        self.fetch_with_route(lambda request:(302,{'Location':target},b''),post=post)
                    self.assertEqual(blocked.exception.status,502)
                    self.assertEqual(len(self.seen),1,'A forbidden destination is never requested')
                    self.assertEqual(self.seen[0].full_url,URL)
                    self.assertEqual(self.seen[0].get_header('X-api-key'),KEY)
                    self.assertNotIn(KEY,str(blocked.exception))

    def test_same_origin_redirect_retains_key_and_keeps_guard_for_later_hops(self):
        destination=ORIGIN+':443/graph/v1/paper/canonical'
        def route(request):
            if request.full_url==URL:return 302,{'Location':destination},b''
            return 200,{'Content-Type':'application/json'},json.dumps(RAW).encode()
        self.assertEqual(self.fetch_with_route(route),RAW)
        self.assertEqual(len(self.seen),2)
        self.assertTrue(all(request.get_header('X-api-key')==KEY for request in self.seen))
        self.seen.clear();clear()
        def two_hops(request):
            return 302,{'Location':destination if request.full_url==URL else 'https://other.example/collect'},b''
        with self.assertRaises(ClientError):self.fetch_with_route(two_hops)
        self.assertEqual(len(self.seen),2,'The second redirect remains origin restricted')

    def test_rejected_key_retries_publicly_without_key_in_url_or_disk_cache(self):
        def route(request):
            if request.get_header('X-api-key'):
                return 403,{'Content-Type':'application/json'},b'{"message":"Invalid API key"}'
            return 200,{'Content-Type':'application/json'},json.dumps(RAW).encode()
        self.assertEqual(self.fetch_with_route(route,cache=True),RAW)
        self.assertEqual(len(self.seen),2)
        self.assertEqual(self.seen[0].get_header('X-api-key'),KEY)
        self.assertIsNone(self.seen[1].get_header('X-api-key'))
        self.assertEqual(self.seen[1].pulse_redirect_origin,ORIGIN)
        self.assertTrue(all(KEY not in request.full_url for request in self.seen))
        self.assertIn(KEY,s2._INVALID_S2_KEYS)
        database=self.directory/'http-cache.sqlite3'
        self.assertTrue(database.is_file())
        self.assertNotIn(KEY.encode(),database.read_bytes())
        self.assertNotIn(KEY,repr(perf._JSON_CACHE))

    def test_successful_authenticated_response_keeps_key_out_of_cache(self):
        self.assertEqual(self.fetch_with_route(lambda request:(200,{'Content-Type':'application/json'},json.dumps(RAW).encode()),cache=True),RAW)
        self.assertEqual(self.seen[0].get_header('X-api-key'),KEY)
        self.assertNotIn(KEY,self.seen[0].full_url)
        self.assertNotIn(KEY.encode(),(self.directory/'http-cache.sqlite3').read_bytes())
        self.assertNotIn(KEY,repr(perf._JSON_CACHE))

    def test_rejected_post_key_keeps_public_fallback_origin_restricted(self):
        def route(request):
            if request.get_header('X-api-key'):return 403,{},b'Invalid API key'
            return 302,{'Location':'https://other.example/collect'},b''
        with self.assertRaises(ClientError):self.fetch_with_route(route,post=True)
        self.assertEqual(len(self.seen),2)
        self.assertIsNone(self.seen[1].get_header('X-api-key'))
        self.assertEqual(self.seen[1].pulse_redirect_origin,ORIGIN)

    def test_rejected_post_key_retries_publicly_with_the_same_payload(self):
        def route(request):
            if request.get_header('X-api-key'):return 403,{},b'Invalid API key'
            return 200,{'Content-Type':'application/json'},json.dumps(RAW).encode()
        self.assertEqual(self.fetch_with_route(route,post=True),RAW)
        self.assertEqual(len(self.seen),2)
        self.assertTrue(all(request.get_method()=='POST' for request in self.seen))
        self.assertEqual(self.seen[0].data,self.seen[1].data)
        self.assertIsNone(self.seen[1].get_header('X-api-key'))

if __name__=='__main__':unittest.main()
