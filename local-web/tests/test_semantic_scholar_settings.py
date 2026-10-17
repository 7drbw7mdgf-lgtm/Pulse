"""Semantic Scholar settings and real request headers with mocked transport."""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-s2-settings-'))
import pulse_core as core
from pulse_core import config_resolvers, security, storage
from pulse_source_health import clear, cooldowns, failed
s2 = importlib.import_module('pulse_core.s2_client')
citations = importlib.import_module('pulse_core.citation_services')
ollama = importlib.import_module('pulse_core.ollama_mgr')

KEY = 'fixture-semantic-scholar-private-key'
RAW = {'paperId':'fixture-paper', 'title':'Synthetic Semantic Scholar search study', 'year':2024,
       'authors':[{'name':'Ada Brooks'}], 'externalIds':{'DOI':'10.1234/fixture'}, 'citationCount':3}

class SemanticScholarSettingsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        patches = [
            patch.object(core, 'CONFIG_DIR', root), patch.object(core, 'CONFIG_PATH', root / 'settings.json'),
            patch.object(security, 'CONFIG_DIR', root),
            patch.dict(os.environ, {'SEMANTIC_SCHOLAR_API_KEY':'', 'GEMINI_API_KEY':'', 'DIMENSIONS_API_KEY':'', 'CORE_API_KEY':'', 'OPENALEX_API_KEY':''}),
            patch.object(ollama, 'ollama_status', return_value={'online':False}),
            patch.object(ollama, 'bundled_ollama_status', return_value={}),
            patch.object(ollama, 'workflow_capabilities', return_value={'pdfExtraction':'test', 'vectorAvailable':False, 'vectorDb':'test'}),
        ]
        for item in patches:
            item.start(); self.addCleanup(item.stop)
        s2.S2_CACHE.clear(); s2._INVALID_S2_KEYS.clear(); clear()
        self.addCleanup(clear)
        self.addCleanup(s2._INVALID_S2_KEYS.clear)

    def test_saved_key_is_encrypted_blank_keeps_it_and_explicit_clear_removes_it(self):
        storage.save_settings({'semanticScholarApiKey':'  ' + KEY + '  '})
        self.assertEqual(storage.load_settings()['semanticScholarApiKey'], KEY)
        encoded = json.loads(core.CONFIG_PATH.read_text())['semanticScholarApiKey']
        self.assertTrue(encoded.startswith('enc:v1:'))
        self.assertNotIn(KEY, core.CONFIG_PATH.read_text())
        storage.save_settings({'semanticScholarApiKey':''})
        self.assertEqual(storage.load_settings()['semanticScholarApiKey'], KEY)
        storage.save_settings({'clearSemanticScholarApiKey':True})
        self.assertFalse(storage.load_settings()['semanticScholarApiKey'])

    def test_public_status_has_presence_and_source_without_key_or_preview(self):
        storage.save_settings({'semanticScholarApiKey':KEY})
        public = storage.public_settings(storage.load_settings())
        status = public['providers']['semanticScholar']
        self.assertTrue(status['configured']); self.assertTrue(status['saved'])
        self.assertEqual(status['source'], 'saved')
        self.assertNotIn('preview', status)
        self.assertNotIn(KEY, json.dumps(public))
        self.assertNotIn(KEY[-4:], json.dumps(status))

    def test_environment_precedence_and_clear_only_changes_saved_key(self):
        storage.save_settings({'semanticScholarApiKey':KEY})
        with patch.dict(os.environ, {'SEMANTIC_SCHOLAR_API_KEY':'   '}):
            self.assertEqual(config_resolvers.resolve_semantic_scholar_api_key(storage.load_settings()), KEY)
            self.assertEqual(storage.public_settings(storage.load_settings())['providers']['semanticScholar']['source'], 'saved')
        with patch.dict(os.environ, {'SEMANTIC_SCHOLAR_API_KEY':' fixture-computer-key '}):
            self.assertEqual(config_resolvers.resolve_semantic_scholar_api_key(storage.load_settings()), 'fixture-computer-key')
            status = storage.public_settings(storage.load_settings())['providers']['semanticScholar']
            self.assertEqual(status['source'], 'environment'); self.assertTrue(status['saved'])
            storage.save_settings({'clearSemanticScholarApiKey':True})
            status = storage.public_settings(storage.load_settings())['providers']['semanticScholar']
            self.assertTrue(status['configured']); self.assertFalse(status['saved'])
            self.assertEqual(status['source'], 'environment')
            with patch.object(s2, 'request_json', return_value=RAW) as request:
                s2.fetch_s2_json('https://api.semanticscholar.org/graph/v1/paper/fixture-paper', cache=False)
            self.assertEqual(request.call_args.args[0].get_header('X-api-key'), 'fixture-computer-key')

    def test_saved_key_reaches_search_metadata_references_citations_and_recommendations(self):
        storage.save_settings({'semanticScholarApiKey':KEY})
        requests = []
        def transport(request, **kwargs):
            requests.append(request)
            url = request.full_url
            if '/recommendations/' in url: return {'recommendedPapers':[RAW]}
            if '/references?' in url: return {'data':[{'citedPaper':RAW}]}
            if '/citations?' in url: return {'data':[{'citingPaper':RAW}]}
            if '/search?' in url: return {'data':[RAW]}
            if '/batch?' in url: return [RAW]
            return RAW
        with patch.object(s2, 'request_json', side_effect=transport):
            self.assertEqual(len(s2.s2_paper_search('synthetic study', limit=1)), 1)
            self.assertEqual(s2.fetch_s2_json('https://api.semanticscholar.org/graph/v1/paper/fixture-paper')['paperId'], 'fixture-paper')
            self.assertEqual(len(s2.s2_fetch_references('fixture-paper')), 1)
            self.assertEqual(len(s2.s2_fetch_citations('fixture-paper')), 1)
            self.assertEqual(len(s2.s2_recommendations(['fixture-paper'])), 1)
            self.assertEqual(len(s2.post_s2_json('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title', {'ids':['fixture-paper']})), 1)
            self.assertTrue(citations.enrich_citations({'papers':[{'s2PaperId':'fixture-paper'}]})['ok'])
        self.assertGreaterEqual(len(requests), 8)
        for request in requests:
            self.assertEqual(request.get_header('X-api-key'), KEY)
            self.assertNotIn(KEY, request.full_url)

    def test_public_requests_work_after_clearing_saved_key(self):
        storage.save_settings({'semanticScholarApiKey':KEY})
        storage.save_settings({'clearSemanticScholarApiKey':True})
        with patch.object(s2, 'request_json', return_value={'data':[]}) as request:
            s2.s2_paper_search('synthetic study', limit=1)
        self.assertIsNone(request.call_args.args[0].get_header('X-api-key'))

    def test_key_update_resets_rejected_key_and_source_cooldown(self):
        s2._INVALID_S2_KEYS.add(KEY)
        request = urllib.request.Request('https://api.semanticscholar.org/graph/v1/paper/search', headers={'x-api-key':KEY})
        error = urllib.error.HTTPError(request.full_url, 429, 'test rate limit', {'Retry-After':'60'}, None)
        self.addCleanup(error.close)
        failed(request, error)
        self.assertIn('Semantic Scholar', cooldowns())
        storage.save_settings({'semanticScholarApiKey':KEY})
        self.assertNotIn(KEY, s2._INVALID_S2_KEYS)
        self.assertNotIn('Semantic Scholar', cooldowns())
        self.assertEqual(s2.s2_request_headers(KEY)['x-api-key'], KEY)

    def test_key_cannot_be_sent_to_other_hosts_or_insecure_urls(self):
        storage.save_settings({'semanticScholarApiKey':KEY})
        with patch.object(s2, 'request_json') as request:
            for url in ['https://other.example/search', 'http://api.semanticscholar.org/graph/v1/paper/search',
                        'https://api.semanticscholar.org.evil.example/search', 'https://user@api.semanticscholar.org/search',
                        'https://api.semanticscholar.org:invalid/search']:
                with self.subTest(url=url), self.assertRaises(core.ClientError): s2.fetch_s2_json(url)
            with self.assertRaises(core.ClientError): s2.post_s2_json('https://other.example/search', {})
        request.assert_not_called()

if __name__ == '__main__': unittest.main()
