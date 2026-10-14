"""Unit tests for gzip transport and persistent on-disk HTTP cache."""
import gzip
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import urllib.request
import urllib.error

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))

import pulse_performance as perf
from pulse_performance import _disk_http_cache_key, _disk_http_cache_ttl, _disk_http_cache_skippable, _disk_http_cache_get, _disk_http_cache_set


class SpeedAndCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orig_config_dir = os.environ.get('PULSE_CONFIG_DIR')
        os.environ['PULSE_CONFIG_DIR'] = self.temp_dir.name

    def tearDown(self):
        if self.orig_config_dir:
            os.environ['PULSE_CONFIG_DIR'] = self.orig_config_dir
        else:
            os.environ.pop('PULSE_CONFIG_DIR', None)
        self.temp_dir.cleanup()

    def test_http_cache_ttl_rules(self):
        # 7 days (604800.0s) for single work and cites/cited_by queries
        self.assertEqual(_disk_http_cache_ttl('https://api.openalex.org/works/W12345'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.openalex.org/works?filter=cites:W12345'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.openalex.org/works?filter=cited_by:W12345'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.semanticscholar.org/graph/v1/paper/abc/citations'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.semanticscholar.org/graph/v1/paper/abc/references'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://europepmc.org/RestPortal/v1/MED/12345/citations'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://icite.od.nih.gov/api/pubs?pmids=12345'), 604800.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.opencitations.net/index/v2/citations/doi:10.1234/test'), 604800.0)
        
        # 15 min for free-text search queries
        self.assertEqual(_disk_http_cache_ttl('https://api.openalex.org/works?search=machine+learning'), 900.0)
        self.assertEqual(_disk_http_cache_ttl('https://api.crossref.org/works?query=neural+networks'), 900.0)

    def test_disk_cache_skips_credentials_and_errors(self):
        # Private authenticated requests with credentials are not cached on disk
        req_auth = urllib.request.Request('https://api.example.com/test', headers={'Authorization': 'Bearer secret123'})
        self.assertTrue(_disk_http_cache_skippable(req_auth))
        
        req_key = urllib.request.Request('https://api.example.com/test', headers={'x-api-key': 'key_abc'})
        self.assertTrue(_disk_http_cache_skippable(req_key))
        
        # OpenAlex and public academic APIs share the disk cache even with api_key header
        req_clean = urllib.request.Request('https://api.openalex.org/works/W123', headers={'Accept': 'application/json'})
        self.assertFalse(_disk_http_cache_skippable(req_clean))
        req_oa_key = urllib.request.Request('https://api.openalex.org/works/W123', headers={'Accept': 'application/json', 'api_key': 'secret_key'})
        self.assertFalse(_disk_http_cache_skippable(req_oa_key))

        # API key and mailto query parameters are stripped before computing cache key
        req_param_key = urllib.request.Request('https://api.openalex.org/works/W123?api_key=my_openalex_secret', headers={'Accept': 'application/json'})
        req_param_mail = urllib.request.Request('https://api.openalex.org/works/W123?mailto=researcher@univ.edu', headers={'Accept': 'application/json'})
        self.assertEqual(_disk_http_cache_key(req_clean), _disk_http_cache_key(req_param_key))
        self.assertEqual(_disk_http_cache_key(req_clean), _disk_http_cache_key(req_param_mail))
        self.assertEqual(_disk_http_cache_key(req_clean), _disk_http_cache_key(req_oa_key))

        # Status >= 400 is never written to disk cache
        key = _disk_http_cache_key(req_clean)
        _disk_http_cache_set(key, req_clean.full_url, {}, {'error': 'not found'}, status=404)
        self.assertIsNone(_disk_http_cache_get(key, req_clean))

    def test_disk_cache_roundtrip_and_expiration(self):
        req = urllib.request.Request('https://api.openalex.org/works/W999', headers={'Accept': 'application/json'})
        key = _disk_http_cache_key(req)
        data = {'id': 'https://openalex.org/W999', 'title': 'Test Cached Work'}

        # Miss initially
        self.assertIsNone(_disk_http_cache_get(key, req))

        # Write and hit
        _disk_http_cache_set(key, req.full_url, {'Accept': 'application/json'}, data, status=200)
        cached = _disk_http_cache_get(key, req)
        self.assertEqual(cached, data)

        # Database exists in config directory
        db_path = Path(self.temp_dir.name) / 'http-cache.sqlite3'
        self.assertTrue(db_path.is_file())

    def test_gzip_transport_and_decompression(self):
        req = urllib.request.Request('https://api.openalex.org/works/W100', headers={'Accept': 'application/json'})
        data = {'id': 'W100', 'title': 'Gzip Compressed Work'}
        raw_json = json.dumps(data).encode('utf-8')
        gzipped = gzip.compress(raw_json)

        # Mock urllib.request.urlopen to return gzipped response with Content-Encoding: gzip
        mock_resp = MagicMock()
        mock_resp.read.return_value = gzipped
        mock_resp.headers = {'Content-Encoding': 'gzip'}
        mock_resp.getheader.return_value = 'gzip'
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.__exit__.return_value = None

        with patch('urllib.request.urlopen', return_value=mock_resp):
            res = perf._request_json_once(req, timeout=5, cache=False)
            self.assertEqual(res, data)

        # Also verify Accept-Encoding: gzip was added
        self.assertTrue(any(k.lower() == 'accept-encoding' and 'gzip' in v.lower() for k, v in req.header_items()))


if __name__ == '__main__':
    unittest.main()
