import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-import-test-'))
import pulse_backend as backend


class BackendTests(unittest.TestCase):
    def test_depth_traversal(self):
        def record(key):
            return {'s2PaperId':key, 'title':key, 'citedByCount':1}
        def references(key, **kwargs):
            return [record(key + '-ref')]
        def citations(key, **kwargs):
            return [record(key + '-cite')]
        with patch.object(backend, 's2_paper_id_for_paper', side_effect=lambda p, **kw:p['s2PaperId']), patch.object(backend, 's2_fetch_references', side_effect=references), patch.object(backend, 's2_fetch_citations', side_effect=citations):
            for depth, expected in [('1',1),('2',2),('3',3),('iterative',4)]:
                results = backend.fetch_citation_graph_branch([record('seed')], depth=depth)
                self.assertEqual(max(item.get('hop',1) for item in results), expected)

    def test_iterative_stops_when_exhausted(self):
        with patch.object(backend, 's2_paper_id_for_paper', return_value='seed'), patch.object(backend, 's2_fetch_references', return_value=[]), patch.object(backend, 's2_fetch_citations', return_value=[]), patch.object(backend, 'openalex_work_for_paper', return_value=None):
            self.assertEqual(backend.fetch_citation_graph_branch([{'title':'seed'}],depth='iterative'), [])

    def test_disabled_concepts_never_execute(self):
        with patch.object(backend, 'load_settings', return_value={}), patch.object(backend, 'fetch_conceptual_search_branch') as concepts:
            data = backend.run_discovery_pipeline({'seedPapers':[{'title':'seed'}], 'branches':dict(citationGraph=False,citationNetwork=False,semanticSearch=False,lexicalSearch=False)})
            concepts.assert_not_called()
            self.assertEqual(data['branchesExecuted'], [])

    def test_pipeline_passes_depth(self):
        with patch.object(backend, 'load_settings', return_value={}), patch.object(backend, 'fetch_citation_graph_branch', return_value=[]) as graph:
            backend.run_discovery_pipeline({'seedPapers':[{'title':'seed'}], 'depth':'3', 'branches':dict(citationGraph=True,citationNetwork=False,semanticSearch=False,lexicalSearch=False)})
            self.assertEqual(graph.call_args.kwargs['depth'], '3')

    def test_save_reload_and_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder)
            with patch.object(backend, 'CONFIG_DIR', config), patch.object(backend, 'LIBRARY_PATH', config/'library.json'):
                payload = {'papers':[{'id':'a','title':'A'}], 'explicitLinks':[], 'depth':'3'}
                backend.save_library(payload)
                self.assertEqual(backend.load_library()['papers'], payload['papers'])
                backend.save_library(payload)
                self.assertTrue(list((config/'backups').glob('*.json')))
                backend.save_library({'papers':[], 'reset':True})
                self.assertEqual(backend.load_library()['papers'], [])
                self.assertEqual(list((config/'backups').glob('*.json')), [])

    def test_library_rejects_invalid_data(self):
        for payload in [[], {'papers':'wrong'}, {'papers':[1]}]:
            with self.assertRaises(backend.ClientError):
                backend.save_library(payload)

    def test_pmid_record_parsing(self):
        xml = b'''<PubmedArticleSet><PubmedArticle><MedlineCitation><Article><ArticleTitle>A <i>nested</i> title</ArticleTitle><Journal><Title>Test Journal</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal><AuthorList><Author><ForeName>Alice</ForeName><LastName>Smith</LastName></Author></AuthorList><Abstract><AbstractText>Test abstract.</AbstractText></Abstract></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/test</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>'''
        with patch.object(backend.urllib.request, 'urlopen', return_value=io.BytesIO(xml)):
            data = backend.lookup_pmid_metadata({'pmid':'123'})['metadata']
            self.assertEqual(data['title'], 'A nested title')
            self.assertEqual(data['authors'], ['Alice Smith'])
            self.assertEqual(data['doi'], '10.1234/test')
            self.assertEqual(data['pmid'], '123')

    def test_invalid_pmid(self):
        with self.assertRaises(backend.ClientError):
            backend.lookup_pmid_metadata({'pmid':'not-an-id'})


if __name__ == '__main__':
    unittest.main()
