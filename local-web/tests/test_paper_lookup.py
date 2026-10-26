import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
p=importlib.import_module('pulse_core.paper_lookup')

class PaperLookupTests(unittest.TestCase):
    def test_doi_and_encoded_publisher_link_use_registry_not_page_or_keywords(self):
        for query in ('10.3390/antiox14101156','doi: 10.3390/antiox14101156','https://doi.org/10.3390/antiox14101156','https://journal.example/doi/full/10.3390%2Fantiox14101156?via=search'):
            with self.subTest(query=query),patch.object(p,'fetch_public') as fetch,patch.object(p,'lookup_doi_metadata',return_value={'metadata':{'doi':'10.3390/antiox14101156','title':'Verified article title'},'source':'Crossref'}) as lookup:
                result=p.lookup_paper({'query':query})
                self.assertEqual(lookup.call_args.args[0]['doi'],'10.3390/antiox14101156')
                self.assertEqual(result['recommendations'][0]['title'],'Verified article title')
                self.assertTrue(result['recommendations'][0]['doiVerified']);fetch.assert_not_called()
    def test_article_page_only_reads_primary_metadata_not_reference_dois(self):
        page=b'<meta name="citation_doi" content="10.1234/primary"><body>References 10.1234/wrong</body>'
        with patch.object(p,'fetch_public',return_value=(page,'https://journal.example/article','text/html')),patch.object(p,'lookup_doi_metadata',return_value={'metadata':{'title':'Primary paper','doi':'10.1234/primary'}}) as lookup:
            result=p.lookup_paper({'query':'https://journal.example/article'})
            self.assertEqual(lookup.call_args.args[0],{'doi':'10.1234/primary'})
            self.assertEqual(result['recommendations'][0]['url'],'https://journal.example/article')
    def test_pubmed_link_uses_exact_pmid(self):
        with patch.object(p,'lookup_pmid_metadata',return_value={'metadata':{'title':'PubMed paper','pmid':'12345678'}}) as lookup,patch.object(p,'fetch_public') as fetch:
            result=p.lookup_paper({'query':'https://pubmed.ncbi.nlm.nih.gov/12345678/?tracking=yes'})
            lookup.assert_called_once_with({'pmid':'12345678'});fetch.assert_not_called()
            self.assertEqual(result['recommendations'][0]['sourceList'],['PubMed'])
    def test_doi_response_cannot_silently_substitute_another_paper(self):
        with patch.object(p,'lookup_doi_metadata',return_value={'metadata':{'title':'Wrong paper','doi':'10.1234/other'}}):
            with self.assertRaises(p.ClientError) as e:p.lookup_paper({'query':'10.1234/requested'})
            self.assertEqual(e.exception.status,404)
    def test_public_link_without_doi_uses_explicit_article_metadata(self):
        page=b'<meta name="citation_title" content="An exact title for this scientific paper"><meta name="citation_author" content="Ada Example">'
        with patch.object(p,'fetch_public',return_value=(page,'https://arxiv.org/abs/1234.56789','text/html')),patch.object(p,'resolve_metadata',return_value={'matched':False}) as resolve:
            result=p.lookup_paper({'query':'https://arxiv.org/abs/1234.56789'})
            self.assertEqual(result['recommendations'][0]['authors'],['Ada Example'])
            self.assertEqual(result['recommendations'][0]['sourceList'],['Article page'])
            self.assertEqual(resolve.call_args.args[0]['title'],'An exact title for this scientific paper')
    def test_private_local_and_invalid_links_are_blocked(self):
        for query in ('https://127.0.0.1/a','https://192.168.1.1/a','https://localhost/a','https://[::1]/a','https://host.local/a','file:///etc/passwd','https://user:password@journal.example/a','ordinary keywords'):
            with self.subTest(query=query),patch.object(p,'fetch_public') as fetch:
                with self.assertRaises(p.ClientError):p.lookup_paper({'query':query})
                fetch.assert_not_called()
    def test_website_failure_does_not_create_a_synthetic_result(self):
        for body,ctype in ((b'<html><title>Not a paper</title>10.1234/reference</html>','text/html'),(b'%PDF-random','application/pdf')):
            with patch.object(p,'fetch_public',return_value=(body,'https://journal.example/page',ctype)):
                with self.assertRaises(p.ClientError):p.lookup_paper({'query':'https://journal.example/page'})
        with patch.object(p,'fetch_public',side_effect=TimeoutError()):
            with self.assertRaises(p.ClientError) as e:p.lookup_paper({'query':'https://journal.example/page'})
            self.assertIn('DOI instead',str(e.exception))

if __name__=='__main__':unittest.main()
