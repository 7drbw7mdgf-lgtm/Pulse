from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
import importlib
from pulse_core import preprint_servers,metadata_scanner,pdf_access
# The package also exports a function of this name; patch the module itself.
status_module=importlib.import_module('pulse_core.publication_status')
from pulse_core.constants import ClientError

def version(number,published='10.1038/s41467-020-20841-6',server='bioRxiv',doi='10.1101/2020.03.04.977314'):
    return {'title':'Alt-RPL36 downregulates the PI3K-AKT-mTOR signaling pathway','authors':'Cao, X.; Khitun, A.; Slavoff, S. A.',
            'doi':doi,'date':'2020-0%d-05'%(number+2),'version':str(number),'type':'new results','license':'cc_by_nc_nd',
            'category':'genomics','abstract':'  Thousands of alt-ORFs   were found. ','published':published,'server':server}

class PreprintServerTests(unittest.TestCase):
    def test_latest_version_becomes_metadata_with_published_version_and_pdf(self):
        calls=[]
        def fake(url,cache=True):
            calls.append(url);return {'collection':[version(1),version(2)]}
        with patch.object(preprint_servers,'fetch_json',side_effect=fake):
            record=preprint_servers.preprint_record('https://doi.org/10.1101/2020.03.04.977314')
        self.assertEqual(calls,['https://api.biorxiv.org/details/biorxiv/10.1101/2020.03.04.977314/na/json'])
        self.assertEqual(record['authors'],['X. Cao','A. Khitun','S. A. Slavoff'])
        self.assertEqual(record['abstract'],'Thousands of alt-ORFs were found.')
        self.assertEqual((record['journal'],record['publicationType'],record['year'],record['date']),('bioRxiv','preprint','2020','2020-04-05'))
        self.assertEqual(record['preprint'],{'server':'bioRxiv','version':'2','versions':2,'category':'genomics','license':'cc_by_nc_nd','postedDate':'2020-04-05'})
        self.assertEqual(record['publicationRelations'],[{'type':'is-preprint-of','doi':'10.1038/s41467-020-20841-6','source':'bioRxiv'}])
        self.assertEqual(record['fullTextLinks'],[{'url':'https://www.biorxiv.org/content/10.1101/2020.03.04.977314v2.full.pdf','format':'pdf','source':'bioRxiv'}])

    def test_medrxiv_doi_asks_medrxiv_first_and_unpublished_preprints_have_no_relation(self):
        doi='10.1101/2020.02.27.20028647';calls=[]
        def fake(url,cache=True):
            calls.append(url)
            return {'collection':[version(1,published='NA',server='medRxiv',doi=doi)]} if '/medrxiv/' in url else {'collection':[]}
        with patch.object(preprint_servers,'fetch_json',side_effect=fake):record=preprint_servers.preprint_record(doi)
        self.assertIn('/details/medrxiv/',calls[0]);self.assertEqual(len(calls),1)
        self.assertEqual(record['journal'],'medRxiv');self.assertNotIn('publicationRelations',record)
        self.assertTrue(record['url'].startswith('https://www.medrxiv.org/content/'+doi+'v1'))

    def test_other_dois_and_unknown_preprints_do_not_create_records(self):
        with patch.object(preprint_servers,'fetch_json') as fake:
            self.assertIsNone(preprint_servers.preprint_record('10.1038/s41467-020-20841-6'));fake.assert_not_called()
        with patch.object(preprint_servers,'fetch_json',side_effect=ClientError(404,'missing')):
            self.assertIsNone(preprint_servers.preprint_record('10.1101/2020.03.04.977314'))
        with patch.object(preprint_servers,'fetch_json',return_value={'collection':[version(1,doi='10.1101/2020.01.01.111111')]}):
            self.assertIsNone(preprint_servers.preprint_record('10.1101/2020.03.04.977314'),'A different DOI in the response is ignored')

    def test_doi_lookup_adds_preprint_details_to_registry_metadata(self):
        crossref={'message':{'DOI':'10.1101/2020.03.04.977314','type':'posted-content','title':['Alt-RPL36 downregulates the PI3K-AKT-mTOR signaling pathway'],
                             'author':[{'given':'Xiongwen','family':'Cao'}],'institution':[{'name':'bioRxiv'}],'abstract':'<jats:title>Abstract</jats:title><jats:p>Registry copy.</jats:p>'}}
        crossref['message']['relation']={'is-preprint-of':[{'id-type':'doi','id':'10.1038/s41467-020-20841-6'}]}
        def registry(url,cache=True):
            if 'crossref' in url:return crossref
            # OpenAlex can fold the preprint into its journal article.
            return {'id':'W1','doi':'https://doi.org/10.1101/2020.03.04.977314','title':'Alt-RPL36 downregulates the PI3K-AKT-mTOR signaling pathway','publication_year':2021,
                    'primary_location':{'source':{'display_name':'Nature Communications'}},'type':'article'}
        with patch.object(metadata_scanner,'fetch_json',side_effect=registry),patch.object(preprint_servers,'fetch_json',return_value={'collection':[version(1),version(2)]}):
            result=metadata_scanner.lookup_doi_metadata({'doi':'10.1101/2020.03.04.977314'})
        metadata=result['metadata']
        self.assertIn('bioRxiv',result['source']);self.assertEqual(metadata['abstract'],'Thousands of alt-ORFs were found.')
        self.assertEqual(metadata['preprint']['version'],'2');self.assertEqual(metadata['authors'],['X. Cao','A. Khitun','S. A. Slavoff'])
        self.assertEqual([(row['type'],row['doi']) for row in metadata['publicationRelations']],[('is-preprint-of','10.1038/s41467-020-20841-6')],'Listed once')
        self.assertEqual((metadata['journal'],metadata['publicationType'],metadata['year']),('bioRxiv','preprint','2020'),'The preprint DOI keeps its own venue')
        self.assertTrue(any('biorxiv.org' in row['url'] for row in metadata['fullTextLinks']))

    def test_status_check_reports_the_journal_version_even_without_the_registry(self):
        with patch.object(status_module,'fetch_json',side_effect=ClientError(503,'Crossref down')),patch.object(preprint_servers,'fetch_json',return_value={'collection':[version(1)]}):
            result=status_module.publication_status({'doi':'10.1101/2020.03.04.977314'})
        self.assertTrue(result['available'])
        self.assertEqual(result['metadata'],{'publicationRelations':[{'type':'is-preprint-of','doi':'10.1038/s41467-020-20841-6','source':'bioRxiv'}]})
        def registry(url,cache=True):
            if '/works/' in url:return {'message':{'DOI':'10.1101/2020.03.04.977314','relation':{'is-preprint-of':[{'id-type':'doi','id':'10.1038/s41467-020-20841-6'}]}}}
            return {'message':{'items':[],'total-results':0}}
        with patch.object(status_module,'fetch_json',side_effect=registry),patch.object(preprint_servers,'fetch_json',return_value={'collection':[version(1)]}):
            relations=status_module.publication_status({'doi':'10.1101/2020.03.04.977314'})['metadata']['publicationRelations']
        self.assertEqual(len(relations),1,'The same journal version from both sources is listed once')

    def test_open_pdf_retrieval_uses_the_preprint_server(self):
        raw=b'%PDF-1.7 preprint'
        def download(url,deadline):
            if 'biorxiv.org' in url:return raw,url
            raise ValueError('This source returned HTTP 403.')
        with patch.object(pdf_access,'openalex_links',return_value=[]),patch.object(pdf_access,'europe_pmc_links',return_value=[]),\
                patch.object(pdf_access,'unpaywall_links',return_value=[]),patch.object(preprint_servers,'fetch_json',return_value={'collection':[version(2)]}),\
                patch.object(pdf_access,'pdf_bytes',side_effect=download),patch('pulse_core.pdf_reader.engine') as engine:
            engine.return_value.open.return_value.__enter__.return_value.needs_pass=False
            engine.return_value.open.return_value.__enter__.return_value.page_count=12
            data,url,source=pdf_access.find_pdf({'doi':'10.1101/2020.03.04.977314','title':'Alt-RPL36'})
        self.assertEqual((data,source),(raw,'bioRxiv'));self.assertIn('v2.full.pdf',url)

if __name__=='__main__':unittest.main()
