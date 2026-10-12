import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-reliability-'))
from pulse_core import bibliography, citation_lookup, citation_identity, metadata_scanner, metadata_resolution
from pulse_core.metadata_utils import crossref_to_metadata
import pulse_performance as performance
import pulse_source_health as health

REFERENCES='''Martín-González, A., & Lee, S. (2026a). Complete indexing methods. Retrieval Journal, 2(1), 10-20. https://doi.org/10.1234/first
Martín-González, A., & Lee, S. (2026b). Assessing retrieval precision.
Retrieval Journal, 3(2), 30-40. https://doi.org/10.1234/second'''
META={'title':'Complete indexing methods','authors':['Ana Martín-González','Sam Lee'],'doi':'10.1234/first',
      'year':'2026','journal':'Retrieval Journal','volume':'2','issue':'1','pages':'10-20'}


class BibliographyIdentityTests(unittest.TestCase):
    def test_bibliography_first_uses_the_actual_year_suffix_without_search(self):
        with patch.object(citation_lookup,'search_citation') as search:
            result=citation_lookup.lookup_in_text_citations({'text':'(Martín-González et al., 2026b)',
                'parentPaper':{'title':'Selected document','bibliographyText':REFERENCES}})
        search.assert_not_called()
        group=result['groups'][0]
        self.assertEqual(group['lookupStrategy'],'bibliography')
        self.assertEqual(group['candidates'][0]['doi'],'10.1234/second')
        self.assertEqual(group['candidates'][0]['pages'],'30-40')
        self.assertFalse(group['candidates'][0]['doiVerified'])

    def test_unsuffixed_is_ambiguous_and_suffixes_are_never_invented(self):
        group=citation_lookup.parse_in_text_citations('(Martín-González et al., 2026)')[0]
        self.assertEqual(len(bibliography.matching_references(group,{'bibliographyText':REFERENCES})),2)
        group['suffix']='c'
        self.assertEqual(bibliography.matching_references(group,{'bibliographyText':REFERENCES}),[])

    def test_reference_tail_is_retained_from_long_extracted_pdfs(self):
        text='Article front matter\n'+('A long readable paragraph. '*7000)+'\nReferences\n'+REFERENCES
        with patch('pulse_core.pdf_utils.extract_document',return_value={'text':text,'metadata':{},'doiText':''}):
            result=metadata_scanner._scan_file_for_metadata_local({'content':b'fixture','filename':'test.pdf'})
        self.assertEqual(result['bibliographyText'],REFERENCES)

    def test_selected_doi_gets_complete_metadata_and_identity_checks(self):
        selected={'title':META['title'],'doi':META['doi'],'citationMatch':{'authors':['Martín-González'],'year':'2026'}}
        with patch.object(citation_identity,'lookup_doi_metadata',return_value={'metadata':META,'source':'Crossref'}):
            result=citation_identity.verify_candidate(selected)
        self.assertTrue(result['verified'])
        self.assertEqual(result['metadata']['pages'],'10-20')
        self.assertTrue(result['metadata']['metadataVerification']['checks']['authors'])
        self.assertEqual(result['verification']['missingFields'],[])

    def test_registry_subtitles_are_part_of_the_verified_title(self):
        record=crossref_to_metadata({'title':['Indexing'],'subtitle':['Methods and evaluation'], 'DOI':'10.1234/test'})
        self.assertEqual(record['title'],'Indexing: Methods and evaluation')

    def test_wrong_doi_title_first_author_and_year_are_rejected(self):
        selected={**META,'citationMatch':{'authors':['Martín-González'],'year':'2026'}}
        for overrides in [{'doi':'10.1234/wrong'},{'title':'Unrelated marine geology'},{'authors':['Ada Smith']},{'year':'2020'}]:
            with self.subTest(overrides=overrides),patch.object(citation_identity,'lookup_doi_metadata',return_value={'metadata':{**META,**overrides},'source':'Crossref'}):
                self.assertFalse(citation_identity.verify_candidate(selected)['verified'])

    def test_online_and_print_dates_can_both_identify_the_same_work(self):
        meta={**META,'year':'2025','publicationDates':{'published-online':'2025-12-03','published-print':'2026-02'}}
        with patch.object(citation_identity,'lookup_doi_metadata',return_value={'metadata':meta,'source':'Crossref'}):
            self.assertTrue(citation_identity.verify_candidate(META)['verified'])

    def test_reference_without_doi_resolves_full_metadata_then_verifies(self):
        with patch.object(citation_identity,'resolve_metadata',return_value={'matched':True,'metadata':META}) as resolve,patch.object(citation_identity,'lookup_doi_metadata',return_value={'metadata':META,'source':'Crossref'}):
            self.assertTrue(citation_identity.verify_candidate({**META,'doi':'','referenceText':'A complete reference'})['verified'])
        self.assertEqual(resolve.call_args.args[0]['text'],'A complete reference')

    def test_unavailable_registry_adds_no_verified_metadata(self):
        with patch.object(citation_identity,'lookup_doi_metadata',side_effect=TimeoutError('offline')):
            result=citation_identity.verify_citation_selection({'papers':[META]})
        self.assertEqual(result['verifiedCount'],0)
        self.assertNotIn('metadata',result['results'][0])

    def test_expired_metadata_budget_does_not_launch_fallback_sources(self):
        with patch.object(metadata_resolution,'fetch_json',side_effect=performance.DiscoveryBudgetExceeded('Time limit')) as transport:
            with self.assertRaises(performance.DiscoveryBudgetExceeded):metadata_resolution.search_metadata(META)
        self.assertEqual(transport.call_count,1)


class SourceHealthTests(unittest.TestCase):
    def setUp(self):
        health.clear();performance._JSON_CACHE.clear();performance._JSON_INFLIGHT.clear()
    def tearDown(self):health.clear()
    def response(self):
        response=io.BytesIO(b'{"results":[]}')
        return response

    def test_rate_limit_pauses_new_requests_and_credentials_are_isolated(self):
        first=urllib.request.Request('https://api.core.ac.uk/a',headers={'Authorization':'Bearer private-one'})
        second=urllib.request.Request('https://api.core.ac.uk/b',headers={'Authorization':'Bearer private-one'})
        other=urllib.request.Request('https://api.core.ac.uk/b',headers={'Authorization':'Bearer private-two'})
        error=urllib.error.HTTPError(first.full_url,429,'Limit',{'Retry-After':'60'},None)
        with patch('urllib.request.urlopen',side_effect=error) as transport:
            with self.assertRaises(health.ProviderCooldown):performance.request_json(first)
            with self.assertRaises(health.ProviderCooldown):performance.request_json(second)
        self.assertEqual(transport.call_count,1)
        with patch('urllib.request.urlopen',return_value=self.response()):performance.request_json(other)
        self.assertNotIn('private',json.dumps(health.cooldowns()))

    def test_repeated_failures_pause_and_recovery_clears_the_state(self):
        request=urllib.request.Request('https://api.crossref.org/check')
        with patch('urllib.request.urlopen',side_effect=[urllib.error.HTTPError(request.full_url,500,'Failure',{},None),urllib.error.HTTPError(request.full_url,500,'Failure',{},None)]) as transport:
            with self.assertRaises(urllib.error.HTTPError):performance.request_json(request,cache=False)
            with self.assertRaises(health.ProviderCooldown):performance.request_json(request,cache=False)
            with self.assertRaises(health.ProviderCooldown):performance.request_json(request,cache=False)
        self.assertEqual(transport.call_count,2)
        with health._LOCK:
            for state in health._STATES.values():state['until']=0
        with patch('urllib.request.urlopen',return_value=self.response()):performance.request_json(request)
        self.assertEqual(health.cooldowns(),{})

    def test_cached_successes_remain_available_while_source_is_paused(self):
        request=urllib.request.Request('https://api.core.ac.uk/cached')
        with patch('urllib.request.urlopen',return_value=self.response()):performance.request_json(request)
        error=urllib.error.HTTPError(request.full_url,429,'Limit',{},None)
        try:health.failed(request,error)
        finally:error.close()
        with patch('urllib.request.urlopen') as transport:
            self.assertEqual(performance.request_json(request),{'results':[]})
        transport.assert_not_called()

    def test_local_request_budget_does_not_pause_a_healthy_source(self):
        request=urllib.request.Request('https://api.crossref.org/check')
        performance.REQUEST_CONTEXT.request_counter={'remaining':0,'lock':threading.Lock()}
        try:
            with patch('urllib.request.urlopen') as transport:
                with self.assertRaises(performance.DiscoveryBudgetExceeded):performance.request_json(request,cache=False)
            transport.assert_not_called()
            self.assertEqual(health._STATES,{})
        finally:performance.REQUEST_CONTEXT.request_counter=None


if __name__=='__main__':unittest.main()
