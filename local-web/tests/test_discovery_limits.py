import os
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-limit-test-'))
import pulse_core as core
from pulse_core import discovery, literature_search, s2_client
from pulse_core.search_limits import discovery_limit


def rows(start, count):
    return [{'title': f'Transport network study {i}', 'doi': f'10.1234/transport-{i}',
             'paperId': f'paper-{i}', 'externalIds': {'DOI': f'10.1234/transport-{i}'},
             'id': i} for i in range(start, start + count)]


class DiscoveryLimitTests(unittest.TestCase):
    def test_limit_defaults_and_bounds(self):
        self.assertEqual(discovery_limit(None), 500)
        self.assertEqual(discovery_limit('invalid'), 500)
        self.assertEqual(discovery_limit(9000), 2000)
        self.assertEqual(discovery_limit(-20), 1)

    def test_pipeline_returns_more_than_fifty_and_respects_selected_limit(self):
        payload = {'semanticRerank':False,'seedPapers': [{'title': 'A starting transport paper'}],
                   'branches': dict(citationGraph=False, citationNetwork=False, semanticSearch=False, lexicalSearch=True),
                   'searchSources': dict(semanticScholar=False, europePmc=True, core=False)}
        records = [{**item, 'source': 'Europe PMC'} for item in rows(1, 2600)]
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_europe_pmc', return_value=records) as source:
            default = discovery.run_discovery_pipeline(payload)
            expanded = discovery.run_discovery_pipeline({**payload, 'limit': 500})
            bounded = discovery.run_discovery_pipeline({**payload, 'limit': 9000})
        self.assertEqual(len(default['recommendations']), 500)
        self.assertEqual(len(expanded['recommendations']), 500)
        self.assertEqual(len(bounded['recommendations']), 2000)
        self.assertEqual([call.kwargs['limit'] for call in source.call_args_list], [1500, 1500, 2000],
                         'Equivalent seed-title query variants should execute once, with the candidate budget shared over unique queries')

    def test_semantic_scholar_search_pages_with_api_safe_limits(self):
        requests = []
        def transport(url, **kwargs):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            offset, size = int(query['offset'][0]), int(query['limit'][0])
            requests.append((offset, size))
            return {'data': rows(offset, size), 'next': offset + size}
        with patch.object(s2_client, 'fetch_s2_json', side_effect=transport):
            found = s2_client.s2_paper_search('transport', limit=235)
        self.assertEqual(len(found), 235)
        self.assertEqual(requests, [(0, 100), (100, 100), (200, 35)])
        self.assertEqual(len({item['doi'] for item in found}), 235)

    def test_semantic_scholar_stops_at_end_or_non_advancing_page(self):
        for response in ({'data': rows(0, 100)}, {'data': rows(0, 100), 'next': 0}, {'data': rows(0, 3), 'next': 100}):
            with patch.object(s2_client, 'fetch_s2_json', return_value=response) as transport:
                s2_client.s2_paper_search('transport', limit=500)
            transport.assert_called_once()

    def test_core_search_pages_and_stops_at_total(self):
        requests = []
        def transport(url, source, api_key=''):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            offset, size = int(query['offset'][0]), int(query['limit'][0])
            requests.append((offset, size))
            return {'results': rows(offset, min(size, 235 - offset)), 'totalHits': 235}
        with patch.object(literature_search, 'fetch_search', side_effect=transport):
            found = literature_search.search_core('transport', limit=500)
        self.assertEqual(len(found), 235)
        self.assertEqual(requests, [(0, 100), (100, 100), (200, 100)])

    def test_later_page_failure_preserves_results_and_reports_warning(self):
        with patch.object(literature_search, 'fetch_search', side_effect=[{'results': rows(0, 100)}, core.ClientError(429, 'CORE: Search limit reached.')]):
            found = literature_search.search_core('transport', limit=200)
        self.assertEqual(len(found), 100)
        self.assertIn('additional results', found.warning)
        payload = {'semanticRerank':False,'seedPapers': [{'title': 'A starting transport paper'}], 'limit': 200,
                   'branches': dict(citationGraph=False, citationNetwork=False, semanticSearch=False, lexicalSearch=True),
                   'searchSources': dict(semanticScholar=False, europePmc=False, core=True)}
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_core', return_value=found):
            result = discovery.run_discovery_pipeline(payload)
        self.assertEqual(len(result['recommendations']), 100)
        self.assertEqual(result['completed'], 1)
        self.assertIn('additional results', result['errors']['core'])
        with patch.object(s2_client, 'fetch_s2_json', side_effect=[{'data': rows(0, 100), 'next': 100}, core.ClientError(429, 'Search limit reached.')]):
            found = discovery.fetch_conceptual_search_branch([{'title': 'Transport networks'}], limit=200)
        self.assertEqual(len(found), 100)
        self.assertTrue(found.warning)

    def test_openalex_pagination_never_exceeds_supported_page_size(self):
        requests = []
        def transport(url):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            page, size = int(query['page'][0]), int(query['per_page'][0])
            requests.append((page, size))
            return {'results': rows((page - 1) * size, size)}
        with patch.object(discovery, 'fetch_json', side_effect=transport):
            found = discovery.openalex_discovery_works('cites:W1234', limit=235)
        self.assertEqual(len(found), 235)
        self.assertEqual(requests, [(1, 100), (2, 100), (3, 100)])

    def test_semantic_recommendations_and_citation_limits_are_bounded(self):
        with patch.object(s2_client, 'post_s2_json', return_value={}) as post:
            s2_client.s2_recommendations(['fixture'], limit=9000)
        self.assertIn('limit=500', post.call_args.args[0])
        with patch.object(s2_client, 'fetch_s2_json', return_value={}) as fetch:
            s2_client.s2_fetch_citations('fixture', limit=9000)
            s2_client.s2_fetch_references('fixture', limit=9000)
        self.assertTrue(all('limit=500' in call.args[0] for call in fetch.call_args_list))


if __name__ == '__main__':
    unittest.main()
