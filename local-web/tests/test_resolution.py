import base64
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.parse
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pulse-backend"))
TEST_CONFIG = tempfile.TemporaryDirectory(prefix="pulse-parser-test-")
os.environ['PULSE_CONFIG_DIR'] = TEST_CONFIG.name
from pulse_core import metadata_resolution as r
from pulse_core import metadata_scanner as scan
from pulse_core.doi_utils import normalize_doi
from pulse_core.pdf_utils import extract_document
from pulse_core.constants import ClientError
import pymupdf as fitz

TITLE = 'A theory of human motivation'
META = {'title': TITLE, 'authors': ['Abraham H. Maslow'], 'journal': 'Psychological Review', 'year': '1943', 'doi': '10.1037/h0054346'}
def crossref(doi='10.1037/h0054346', title=TITLE, year=1943):
    return {'DOI':doi, 'title':[title], 'author':[{'given':'Abraham H.','family':'Maslow'}],
            'container-title':['Psychological Review'], 'issued':{'date-parts':[[year]]},
            'volume':'50', 'issue':'4', 'page':'370-396', 'ISSN':['0033-295X']}

class ResolutionTests(unittest.TestCase):
    def test_doi_variants(self):
        for value in ['https://doi.org/10.1037%2Fh0054346?utm_source=test',
                      'DOI: 10.\n1037 / h0054346.', '%31%30%2E%31%30%33%37%2Fh0054346',
                      '１０．１０３７／h0054346', 'doi: 10&#46;1037&#47;h0054346',
                      '(10.1037/h0054346)', '10.1037/\nh0054346']:
            with self.subTest(value=value): self.assertEqual(normalize_doi(value), META['doi'])
    def test_references_not_primary(self):
        self.assertEqual(r.primary_doi_candidates(TITLE+'\nReferences\nDOI: 10.1037/h0054346'), [])
    def test_fields_from_pasted_citation(self):
        result=r.extract_text_metadata('Maslow, A. H. (1943). A theory of human motivation. Psychological Review, 50(4), 370–396.')
        self.assertEqual(result['title'], TITLE)
        self.assertEqual(result['year'], '1943')
        self.assertEqual(result['journal'], 'Psychological Review')
        self.assertEqual(result['volume'], '50')
        self.assertEqual(result['issue'], '4')
        self.assertEqual(result['pages'], '370-396')
    def test_labelled_metadata(self):
        result=r.extract_text_metadata('Title: '+TITLE+'\nAuthors: Abraham H. Maslow\nJournal: Psychological Review\nYear: 1943\nVolume: 50\nPages: 370-396')
        self.assertEqual(result['authors'], ['Abraham H. Maslow'])
        self.assertEqual(result['volume'], '50')
    def test_wrong_first_search_result(self):
        captured=[]
        def fetch(url):
            captured.append(url)
            return {'message': {'items':[crossref('10.0001/wrong', 'A different study of motivation', 2005), crossref()]}}
        with patch.object(r,'fetch_json',side_effect=fetch):
            found=r.search_metadata({**META, 'volume':'50','issue':'4','pages':'370-396','issn':'0033-295X'})
        self.assertTrue(found['matched'])
        self.assertEqual(found['metadata']['doi'], META['doi'])
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(captured[0]).query)['query.bibliographic'][0]
        for part in [TITLE,'Abraham H. Maslow','1943','Psychological Review','50','370-396','0033-295X']:
            self.assertIn(part, query)
    def test_ambiguous_match_preserves_extracted_fields(self):
        with patch.object(r,'fetch_json',return_value={'message':{'items':[crossref(),crossref('10.0002/other')]}}):
            found=r.resolve_metadata({key:val for key,val in META.items() if key!='doi'})
        self.assertFalse(found['matched'])
        self.assertTrue(found['ambiguous'])
        self.assertEqual(found['metadata']['title'],TITLE)
        self.assertNotIn('doi',found['metadata'])
    def test_unrelated_top_results_rejected(self):
        self.assertFalse(r.candidate_score(META,{'title':'A different study of emotions','authors':['Other Person'],'year':'2020'})['accepted'])
    def test_identical_short_titles_with_contradictions_rejected(self):
        result=r.candidate_score(META,{**META,'authors':['Unrelated Researcher'],'year':'2005'})
        self.assertFalse(result['accepted'])
    def test_doi_first(self):
        with patch.object(scan,'lookup_doi_metadata',return_value={'metadata':META,'source':'Crossref'}) as doi_lookup, patch.object(r,'search_metadata') as search:
            found=r.resolve_metadata({'doi':'https://doi.org/10.1037/h0054346'})
        self.assertEqual(found['strategy'],'doi')
        self.assertTrue(found['metadata']['doiVerified'])
        doi_lookup.assert_called_once()
        search.assert_not_called()
    def test_unresolved_doi_falls_back_to_other_metadata(self):
        with patch.object(scan,'lookup_doi_metadata',side_effect=ClientError(404,'Not found')), patch.object(r,'search_metadata',return_value={'matched':True,'metadata':META,'match':{'score':1},'query':TITLE,'candidates':[],'errors':[]}) as fallback:
            found=r.resolve_metadata({**META,'doi':'10.0000/unresolved'})
        self.assertEqual(found['strategy'],'metadata')
        self.assertEqual(found['metadata']['doi'],META['doi'])
        self.assertEqual(fallback.call_args[0][0]['authors'],META['authors'])
    def test_doi_for_a_different_paper_rejected(self):
        with patch.object(scan,'lookup_doi_metadata',return_value={'metadata':{**META,'title':'Unrelated paper with a wrong DOI'},'source':'Crossref'}), patch.object(r,'search_metadata',return_value={'matched':False,'query':TITLE,'candidates':[],'errors':[]}):
            found=r.resolve_metadata(META)
        self.assertFalse(found['matched'])
        self.assertEqual(found['metadata']['title'],TITLE)
        self.assertFalse(found['metadata'].get('doiVerified',False))
    def test_service_failure_keeps_metadata(self):
        with patch.object(r,'fetch_json',side_effect=TimeoutError('offline')):
            found=r.resolve_metadata({key:val for key,val in META.items() if key!='doi'})
        self.assertFalse(found['matched'])
        self.assertEqual(found['metadata']['authors'],META['authors'])
        self.assertEqual(len(found['errors']),2)
    def test_pdf_text_links_and_metadata(self):
        doc=fitz.open();page=doc.new_page()
        page.insert_text((50,60), TITLE, fontsize=18)
        page.insert_text((50,90),'Abraham H. Maslow\nYear: 1943\nJournal: Psychological Review',fontsize=11)
        page.insert_link({'kind':fitz.LINK_URI,'from':fitz.Rect(50,120,350,140),'uri':'https://doi.org/10.1037/h0054346'})
        doc.set_metadata({'title':TITLE,'author':'Abraham H. Maslow'})
        raw=doc.tobytes(deflate=True);doc.close()
        document=extract_document(raw,'upload.pdf')
        self.assertIn(TITLE,document['text'])
        self.assertIn(META['doi'],document['doiText'])
        self.assertEqual(document['extractionSource'],'PyMuPDF')
        found=scan._scan_file_for_metadata_local({'name':'upload.pdf','contentBase64':base64.b64encode(raw).decode()})
        self.assertEqual(found['doi'],META['doi'])
        self.assertEqual(found['metadata']['title'],TITLE)
    def test_pdf_reference_doi_is_not_assigned(self):
        doc=fitz.open();page=doc.new_page()
        page.insert_text((50,60),'An independent original research paper\nReferences\nDOI: 10.1037/h0054346')
        raw=doc.tobytes(deflate=True);doc.close()
        found=scan._scan_file_for_metadata_local({'name':'upload.pdf','content':raw})
        self.assertEqual(found['candidates'],[])
    def test_invalid_base64(self):
        with self.assertRaises(ClientError): scan._scan_file_for_metadata_local({'name':'a.pdf','contentBase64':'invalid!!!'})

if __name__=='__main__': unittest.main(verbosity=2)
