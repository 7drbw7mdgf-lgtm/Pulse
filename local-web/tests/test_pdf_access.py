import io
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-pdf-access-tests-'))
from pulse_core import pdf_access, pdf_reader
from pulse_core.constants import ClientError


class PDFAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        p = patch.object(pdf_reader, 'CONFIG_DIR', self.profile)
        p.start(); self.addCleanup(p.stop)
        pdf_reader.PREVIEWS.clear(); pdf_reader.page_text.cache_clear()
        import pymupdf
        with pymupdf.open() as document:
            page = document.new_page()
            page.insert_text((50, 70), 'This open paper contains a verified passage.')
            self.raw = document.tobytes()

    def test_rejects_local_private_credentialed_and_non_https_addresses(self):
        for value in ['file:///etc/passwd', 'http://example.org/paper.pdf', 'https://localhost/a',
                      'https://127.0.0.1/a', 'https://10.1.1.1/a', 'https://169.254.169.254/a',
                      'https://[::1]/a', 'https://user:secret@example.org/a',
                      'https://example.org:8080/a', 'https://printer.local/a', 'https://example.org/\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                pdf_access.public_url(value)
        self.assertEqual(pdf_access.public_url('https://example.org/a.pdf#page=2'), 'https://example.org/a.pdf')

    def test_dns_rebinding_cannot_change_the_validated_destination(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        connection = pdf_access.PublicHTTPSConnection('example.org')
        connect = Mock(return_value=object())
        def tls_connect(instance):
            self.assertEqual(instance.host, 'example.org')
            instance._create_connection(('example.org', 443), 2, None)
        with patch('socket.getaddrinfo', return_value=records), patch('socket.create_connection', connect), \
                patch('http.client.HTTPSConnection.connect', tls_connect):
            connection.connect()
        self.assertEqual(connect.call_args.args[0], ('93.184.216.34', 443))
        private = records + [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch('socket.getaddrinfo', return_value=private), patch('socket.create_connection') as dial:
            with self.assertRaises(ValueError): pdf_access.PublicHTTPSConnection('example.org').connect()
            dial.assert_not_called()

    def response(self, body=b'', status=200, headers=None):
        stream = io.BytesIO(body)
        response = Mock(status=status)
        response.getheader.side_effect = lambda name: (headers or {}).get(name)
        response.read1.side_effect = stream.read
        connection = Mock(sock=None)
        connection.getresponse.return_value = response
        return connection

    def test_redirects_cannot_reach_private_networks_or_downgrade_https(self):
        for target in ['https://127.0.0.1/private', 'http://example.org/a.pdf']:
            with patch.object(pdf_access, 'PublicHTTPSConnection', return_value=self.response(status=302, headers={'Location': target})) as connect:
                with self.assertRaises(ValueError): pdf_access.fetch_public('https://example.org/a', time.monotonic()+5, 1000)
                self.assertEqual(connect.call_count, 1)

    def test_anonymous_transport_enforces_size_and_access_status(self):
        for response in [self.response(status=403), self.response(headers={'Content-Length': '1001'}), self.response(b'x'*1001)]:
            with patch.object(pdf_access, 'PublicHTTPSConnection', return_value=response):
                with self.assertRaises(ValueError): pdf_access.fetch_public('https://example.org/a', time.monotonic()+5, 1000)
                headers = response.request.call_args.kwargs['headers']
                self.assertNotIn('Cookie', headers); self.assertNotIn('Authorization', headers)

    def test_open_landing_page_exposes_pdf_without_submitting_forms(self):
        html = b'<html><meta name="citation_pdf_url" content="/files/article.pdf"><form action="/login"></form></html>'
        with patch.object(pdf_access, 'fetch_public', side_effect=[(html, 'https://example.org/article', 'text/html'), (self.raw, 'https://example.org/files/article.pdf', 'application/pdf')]) as fetch:
            data, url = pdf_access.pdf_bytes('https://example.org/article', time.monotonic()+5)
        self.assertEqual(data, self.raw); self.assertTrue(url.endswith('/files/article.pdf'))
        self.assertEqual(fetch.call_count, 2)

    def test_openalex_requires_exact_identifier_and_an_open_location(self):
        work = {'doi': 'https://doi.org/10.1234/open-paper', 'locations': [
            {'is_oa': False, 'pdf_url': 'https://closed.example/a.pdf'},
            {'is_oa': True, 'pdf_url': 'https://open.example/a.pdf', 'landing_page_url': 'https://open.example/a'}]}
        with patch('pulse_core.external_apis.fetch_json', return_value=work):
            found = pdf_access.openalex_links({'doi': '10.1234/open-paper'})
            self.assertEqual([row['url'] for row in found], ['https://open.example/a.pdf', 'https://open.example/a'])
            self.assertEqual(pdf_access.openalex_links({'doi': '10.1234/different'}), [])

    def test_landing_page_does_not_open_a_cited_papers_pdf(self):
        html=b'<html><a href="/articles/PMC99999/pdf/reference.pdf">PDF</a></html>'
        with patch.object(pdf_access,'fetch_public',return_value=(html,'https://example.org/articles/PMC12345','text/html')) as fetch:
            with self.assertRaises(ValueError):pdf_access.pdf_bytes('https://example.org/articles/PMC12345',time.monotonic()+5)
            self.assertEqual(fetch.call_count,1)

    def test_repository_pdf_anchor_must_share_the_article_id(self):
        html=b'<html><a href="/articles/PMC12345/pdf/article.pdf">Download PDF</a></html>'
        with patch.object(pdf_access,'fetch_public',side_effect=[(html,'https://example.org/articles/PMC12345','text/html'),(self.raw,'https://example.org/articles/PMC12345/pdf/article.pdf','application/pdf')]):
            self.assertEqual(pdf_access.pdf_bytes('https://example.org/articles/PMC12345',time.monotonic()+5)[0],self.raw)

    def test_failed_or_invalid_publisher_copy_falls_back_to_repository(self):
        with patch.object(pdf_access, 'openalex_links', return_value=[]), \
                patch.object(pdf_access, 'europe_pmc_links', return_value=[]), \
                patch.object(pdf_access, 'unpaywall_links', return_value=[]), \
                patch.object(pdf_access, 'pdf_bytes', side_effect=[(b'%PDF-invalid', 'https://publisher.example/a.pdf'), (self.raw, 'https://repository.example/a.pdf')]) as fetch:
            data, url, _ = pdf_access.find_pdf({'fullTextLinks': [
                {'url': 'http://publisher.example/a.pdf', 'format': 'pdf'},
                {'url': 'https://repository.example/a.pdf', 'format': 'pdf'}]})
        self.assertEqual(data, self.raw); self.assertIn('repository.example', url)
        self.assertEqual(fetch.call_args_list[0].args[0], 'https://publisher.example/a.pdf')

    def test_title_lookup_requires_a_unique_exact_match_and_corroborating_metadata(self):
        title='A specific scientific study of open retrieval'
        work={'id':'https://openalex.org/W123','display_name':title,'publication_year':2024,
              'authorships':[{'author':{'display_name':'Ada Smith'}}],
              'best_oa_location':{'is_oa':True,'pdf_url':'https://open.example/paper.pdf'}}
        with patch('pulse_core.external_apis.fetch_json',return_value={'results':[work]}):
            self.assertTrue(pdf_access.openalex_links({'title':title,'authors':['Ada Smith'],'year':'2024'}))
            self.assertEqual(pdf_access.openalex_links({'title':title,'authors':['Other Author'],'year':'2024'}),[])
            self.assertEqual(pdf_access.openalex_links({'title':title,'year':'2025'}),[])
            self.assertEqual(pdf_access.openalex_links({'title':'Different scientific study of open retrieval methods'}),[])
        with patch('pulse_core.external_apis.fetch_json',return_value={'results':[work,dict(work,id='https://openalex.org/W456')]}):
            self.assertEqual(pdf_access.openalex_links({'title':title}),[])

    def test_europe_pmc_does_not_use_a_different_doi(self):
        rows=[{'doi':'10.1234/different','pmcid':'PMC12345','fullTextLinks':[{'url':'https://open.example/other.pdf','format':'pdf'}]}]
        with patch('pulse_core.literature_search.search_europe_pmc',return_value=rows):
            self.assertEqual(pdf_access.europe_pmc_links({'doi':'10.1234/open-paper'}),[])

    def test_unavailable_sources_do_not_produce_an_attachment(self):
        with patch.object(pdf_access,'openalex_links',return_value=[]), \
                patch.object(pdf_access,'europe_pmc_links',return_value=[]), \
                patch.object(pdf_access,'unpaywall_links',return_value=[]):
            with self.assertRaises(ClientError) as error:
                pdf_reader.preview({'paper':{'doi':'10.1234/unavailable'}})
            self.assertEqual(error.exception.status,404)
            self.assertFalse((self.profile/'pdfs').exists())

    def test_preview_is_temporary_and_read_only_until_explicit_download(self):
        with patch.object(pdf_access, 'find_pdf', return_value=(self.raw, 'https://open.example/a.pdf', 'OpenAlex')) as find:
            item = pdf_reader.preview({'paper': {'doi': '10.1234/open-paper', 'title': 'Open paper'}})
            self.assertTrue(item['preview']); self.assertFalse((self.profile/'pdfs').exists())
            self.assertGreater(len(pdf_reader.page({'id': item['id']})['words']), 3)
            with self.assertRaises(ClientError) as error:
                pdf_reader.passage({'id': item['id'], 'page': 1, 'quote': 'This open paper contains a verified passage.'})
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(pdf_reader.preview({'paper': {'doi': '10.1234/open-paper', 'title': 'Open paper'}}), item)
            self.assertEqual(find.call_count, 1)
        kept = pdf_reader.keep(item)
        self.assertEqual(kept['id'], item['id']); self.assertEqual(pdf_reader.path_for(kept['id'], permanent=True).read_bytes(), self.raw)
        passage = pdf_reader.passage({'id': kept['id'], 'page': 1, 'quote': 'This open paper contains a verified passage.'})
        self.assertEqual(passage['pdfId'], kept['id'])

    def test_preview_expiry_does_not_remove_the_saved_copy(self):
        item = pdf_reader.store_bytes(self.raw, preview=True)
        pdf_reader.keep(item)
        temporary = self.profile/'pdf-previews'/(item['id']+'.pdf')
        os.utime(temporary, (0, 0))
        self.assertEqual(pdf_reader.path_for(item['id']).parent, self.profile/'pdfs')
        self.assertTrue(pdf_reader.path_for(item['id'], permanent=True).exists())

    def test_expired_unsaved_preview_requires_a_fresh_lookup(self):
        item = pdf_reader.store_bytes(self.raw, preview=True)
        os.utime(pdf_reader.path_for(item['id']), (0, 0))
        with self.assertRaises(ClientError): pdf_reader.path_for(item['id'])
        refreshed = pdf_reader.store_bytes(self.raw, preview=True)
        self.assertTrue(pdf_reader.path_for(refreshed['id']).exists())

    def test_preview_cache_eviction_keeps_permanent_files(self):
        kept = pdf_reader.store_bytes(self.raw)
        old = self.profile/'pdf-previews'/('0'*64+'.pdf')
        old.parent.mkdir(); old.write_bytes(b'old preview'); os.utime(old, (0, 0))
        pdf_reader.store_bytes(self.raw, preview=True)
        self.assertFalse(old.exists()); self.assertTrue(pdf_reader.path_for(kept['id'], permanent=True).exists())


if __name__ == '__main__': unittest.main()
