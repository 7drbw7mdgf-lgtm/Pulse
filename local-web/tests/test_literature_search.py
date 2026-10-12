import copy
import io
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-search-test-'))
import pulse_core as core
from pulse_core import literature_search as search, metadata_resolution as resolution, storage, security
from pulse_core.discovery import run_discovery_pipeline
from pulse_core.search_merge import merge_search_records

TITLE = 'Accessible data visualization for urban transport networks'
EP = {'id': '123456', 'source': 'MED', 'pmcid': 'PMC123456', 'doi': 'https://doi.org/10.1234/visualization',
      'title': TITLE, 'authorList': {'author': [{'fullName': 'Ada Brooks'}, {'firstName': 'Sam', 'lastName': 'Rivera'}]},
      'journalInfo': {'dateOfPublication': '2024 Oct', 'yearOfPublication': 2024, 'volume': '12', 'issue': '3',
                      'journal': {'title': 'Research Interfaces', 'issn': '1234-5678'}},
      'pageInfo': '12-18', 'abstractText': '<p>An accessible &amp; reproducible diagram.</p>', 'citedByCount': 0,
      'keywordList': {'keyword': ['data visualization', 'transport']}, 'isOpenAccess': 'Y',
      'fullTextUrlList': {'fullTextUrl': [{'url': 'https://europepmc.org/articles/PMC123456', 'availabilityCode': 'F', 'documentStyle': 'html'},
                                        {'url': 'javascript:alert(1)', 'availabilityCode': 'F'},
                                        {'url': 'https://publisher.example/paywall', 'availabilityCode': 'S'}]}}
CORE = {'id': 12345, 'title': TITLE, 'authors': [{'name': 'Ada Brooks'}, {'name': 'Sam Rivera'}],
        'doi': '10.1234/visualization', 'yearPublished': 2024, 'publishedDate': '2024-10-08T00:00:00',
        'abstract': 'A repository description.', 'citationCount': None, 'publisher': 'Example Press',
        'fullText': 'Not available for public API users.', 'downloadUrl': 'https://repository.example/paper.pdf',
        'sourceFulltextUrls': ['https://repository.example/paper.pdf', 'https://repository.example/paper'],
        'journals': [{'title': 'Research Interfaces', 'identifiers': ['1234-5678']}],
        'links': [{'type': 'display', 'url': 'https://core.ac.uk/works/12345'}]}


class LiteratureSearchTests(unittest.TestCase):
    def test_europe_pmc_metadata_links_and_zero_citations(self):
        item = search.europe_pmc_to_metadata(EP)
        self.assertEqual(item['doi'], '10.1234/visualization')
        self.assertEqual(item['authors'], ['Ada Brooks', 'Sam Rivera'])
        self.assertEqual(item['date'], '2024-10')
        self.assertEqual(item['pages'], '12-18')
        self.assertEqual(item['citationCount'], 0)
        self.assertEqual(item['citationCountSource'], 'Europe PMC')
        self.assertEqual(len(item['fullTextLinks']), 1)
        self.assertEqual(item['abstract'], 'An accessible & reproducible diagram.')
        self.assertEqual(item['pmid'], '123456')
        item = search.europe_pmc_to_metadata({**EP, 'authorList': {'author': [{'fullName': 'Brooks A', 'firstName': 'Ada', 'lastName': 'Brooks'}]}})
        self.assertEqual(item['authors'], ['Ada Brooks'], 'Export the full author name when the provider supplies it')

    def test_inferred_index_dates_do_not_invent_precision(self):
        item = search.europe_pmc_to_metadata({'title': TITLE, 'pubYear': '2024', 'firstPublicationDate': '2024-01-01'})
        self.assertEqual(item['date'], '2024')
        self.assertNotIn('citationCount', item)

    def test_core_metadata_and_permission_message(self):
        item = search.core_to_metadata(CORE)
        self.assertEqual(item['date'], '2024-10-08')
        self.assertEqual(item['authors'], ['Ada Brooks', 'Sam Rivera'])
        self.assertEqual(item['coreId'], '12345')
        self.assertEqual(item['publisher'], 'Example Press')
        self.assertEqual(len(item['fullTextLinks']), 2)
        self.assertNotIn('fullText', item)
        self.assertNotIn('citationCount', item, 'An unknown metric must not be presented as zero')
        self.assertEqual(item['abstract'], CORE['abstract'])

    def test_core_identifier_fallback_and_unsafe_urls(self):
        item = search.core_to_metadata({'title': TITLE, 'identifiers': [{'type': 'DOI', 'identifier': 'https://doi.org/10.1234/example'}],
                                      'downloadUrl': 'javascript:alert(1)', 'sourceFulltextUrls': ['http://[bad', 'file:///etc/passwd']})
        self.assertEqual(item['doi'], '10.1234/example')
        self.assertEqual(item['fullTextLinks'], [])

    def test_search_transport_and_optional_key(self):
        captured = []
        def transport(request, **kwargs):
            captured.append(request)
            return {'results': [CORE]} if request.full_url.startswith('https://api.core.ac.uk/') else {'resultList': {'result': [EP]}}
        with patch.object(search, 'request_json', side_effect=transport):
            self.assertEqual(len(search.search_europe_pmc('urban transport', limit=1000)), 1)
            self.assertEqual(len(search.search_core('', doi='10.1234/visualization', api_key='fixture-private-key')), 1)
            self.assertEqual(len(search.search_core('urban transport')), 1)
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(captured[0].full_url).query)
        self.assertEqual(params['pageSize'], ['1000'])
        self.assertEqual(params['resultType'], ['core'])
        self.assertEqual(captured[1].get_header('Authorization'), 'Bearer fixture-private-key')
        self.assertNotIn('fixture-private-key', captured[1].full_url)
        self.assertIsNone(captured[2].get_header('Authorization'))
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(captured[1].full_url).query)
        self.assertEqual(params['q'], ['doi:"10.1234/visualization"'])

    def test_errors_never_echo_credentials_or_upstream_body(self):
        for code in (401, 403, 429, 500):
            error = urllib.error.HTTPError('https://api.core.ac.uk/', code, 'fixture-private-key', {}, io.BytesIO(b'fixture-private-key'))
            with patch.object(search, 'request_json', side_effect=error), self.assertRaises(core.ClientError) as caught:
                search.search_core('urban transport', api_key='fixture-private-key')
            self.assertNotIn('fixture-private-key', str(caught.exception))
            self.assertIn('CORE', str(caught.exception))

    def test_cross_provider_identity_and_metadata_merge(self):
        no_doi = {'title': TITLE.replace(' ', '  ') + '.', 'authors': ['Ada Brooks'], 'year': '2024', 'sourceList': ['Semantic Scholar']}
        records = [no_doi, search.europe_pmc_to_metadata(EP), search.core_to_metadata(CORE)]
        original = copy.deepcopy(records)
        merged = merge_search_records(records)
        self.assertEqual(len(merged), 1)
        self.assertEqual(set(merged[0]['sourceList']), {'Europe PMC', 'CORE', 'Semantic Scholar'})
        self.assertEqual(merged[0]['publisher'], 'Example Press')
        self.assertEqual(merged[0]['citationCount'], 0)
        self.assertEqual(len(merged[0]['fullTextLinks']), 3)
        self.assertEqual(records, original, 'Ranking/merging must not mutate cached API responses')
        self.assertEqual(len(merge_search_records([{'title': TITLE, 'doi': '10.1234/paper', 'authors': ['Brooks A'], 'year': '2024'}, {'title': TITLE, 'authors': ['Brooks, Ada'], 'year': '2024'}])), 1)

    def test_different_dois_or_editions_do_not_merge(self):
        one = {'title': TITLE, 'doi': '10.1234/one', 'year': '2024'}
        two = {'title': TITLE, 'doi': '10.1234/two', 'year': '2024'}
        unknown = {'title': TITLE, 'authors': ['Ada Brooks'], 'year': '2024'}
        self.assertEqual(len(merge_search_records([one, two, unknown])), 3)
        self.assertEqual(len(merge_search_records([one, {'title': TITLE, 'year': '2020'}])), 2)

    def test_discovery_sources_selection_deduplication_and_seed_exclusion(self):
        payload = {'semanticRerank':False,'seedPapers': [{'title': 'A synthetic starting document', 'paperKeywords': ['urban transport']}],
                   'branches': dict(citationGraph=False, citationNetwork=False, semanticSearch=False, lexicalSearch=True),
                   'searchSources': dict(semanticScholar=False, europePmc=True, core=True)}
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_europe_pmc', return_value=[search.europe_pmc_to_metadata(EP)]) as europe, patch.object(core, 'search_core', return_value=[search.core_to_metadata(CORE)]) as repository, patch.object(core, 'fetch_conceptual_search_branch') as s2:
            found = run_discovery_pipeline(payload)
        self.assertEqual(len(found['recommendations']), 1)
        self.assertEqual(set(found['branchesExecuted']), {'europePmc', 'core'})
        self.assertEqual(set(found['recommendations'][0]['branches']), {'europePmc', 'core'})
        self.assertTrue(any('urban' in call.args[0] for call in europe.call_args_list))
        self.assertTrue(any('transport' in call.args[0] for call in repository.call_args_list))
        self.assertTrue(all(1 <= call.kwargs['limit'] <= 2000 and call.kwargs['structured'] for call in europe.call_args_list))
        self.assertEqual(len(europe.call_args_list),len(set(' '.join(call.args[0].split()).casefold() for call in europe.call_args_list)),
                         'Public-provider queries should not repeat equivalent text')
        s2.assert_not_called()
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_europe_pmc', return_value=[search.europe_pmc_to_metadata(EP)]), patch.object(core, 'search_core', return_value=[]):
            found = run_discovery_pipeline({**payload, 'seedPapers': [{'title': TITLE, 'doi': EP['doi']}]})
        self.assertEqual(found['recommendations'], [])

    def test_partial_failure_keeps_other_source_results(self):
        payload = {'semanticRerank':False,'seedPapers': [{'title': 'A synthetic starting document'}],
                   'branches': dict(citationGraph=False, citationNetwork=False, semanticSearch=False, lexicalSearch=True),
                   'searchSources': dict(semanticScholar=False, europePmc=True, core=True)}
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_europe_pmc', return_value=[search.europe_pmc_to_metadata(EP)]), patch.object(core, 'search_core', side_effect=core.ClientError(502, 'CORE: Search limit reached.')):
            found = run_discovery_pipeline(payload)
        self.assertEqual(len(found['recommendations']), 1)
        self.assertEqual(found['completed'], 2)
        self.assertEqual(found['branchesExecuted'], ['europePmc'])
        self.assertIn('core', found['errors'])

    def test_disabled_sources_and_invalid_responses_are_not_silent_success(self):
        with patch.object(search, 'request_json', return_value={'error': 'Provider is offline'}):
            with self.assertRaises(core.ClientError):
                search.search_core('urban transport')
            with self.assertRaises(core.ClientError):
                search.search_europe_pmc('data visualization')
        with patch.object(core, 'load_settings', return_value={}), patch.object(core, 'search_europe_pmc') as europe, patch.object(core, 'search_core') as repository, patch.object(core, 'fetch_conceptual_search_branch') as s2:
            found = run_discovery_pipeline({'semanticRerank':False,'seedPapers': [{'title': TITLE}],
                'branches': dict(citationGraph=False, citationNetwork=False, semanticSearch=False, lexicalSearch=True),
                'searchSources': dict(semanticScholar=False, europePmc=False, core=False)})
        europe.assert_not_called(); repository.assert_not_called(); s2.assert_not_called()
        self.assertEqual(found['branchesExecuted'], [])
        self.assertEqual(found['recommendations'], [])

    def test_metadata_fallback_matches_using_bibliographic_evidence(self):
        with patch.object(resolution, 'fetch_json', return_value={}), patch.object(search, 'search_europe_pmc', return_value=[search.europe_pmc_to_metadata(EP)]), patch.object(search, 'search_core', return_value=[search.core_to_metadata(CORE)]):
            found = resolution.search_metadata({'title': TITLE, 'authors': ['Ada Brooks'], 'year': '2024'})
        self.assertTrue(found['matched'])
        self.assertFalse(found['ambiguous'])
        self.assertEqual(found['metadata']['doi'], '10.1234/visualization')
        self.assertEqual(set(found['metadata']['sourceList']), {'Europe PMC', 'CORE'})

    def test_core_key_is_encrypted_preserved_and_clearable(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with patch.object(core, 'CONFIG_DIR', folder), patch.object(core, 'CONFIG_PATH', folder / 'settings.json'), patch.object(security, 'CONFIG_DIR', folder):
                storage.save_settings({'coreApiKey': 'fixture-private-key'})
                self.assertNotIn('fixture-private-key', core.CONFIG_PATH.read_text())
                self.assertEqual(storage.load_settings()['coreApiKey'], 'fixture-private-key')
                storage.save_settings({'coreApiKey': ''})
                self.assertEqual(storage.load_settings()['coreApiKey'], 'fixture-private-key')
                storage.save_settings({'clearCoreApiKey': True})
                self.assertFalse(storage.load_settings()['coreApiKey'])


if __name__ == '__main__':
    unittest.main()
