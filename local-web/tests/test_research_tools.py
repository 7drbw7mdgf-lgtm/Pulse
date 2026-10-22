"""Research workflow regressions using synthetic papers and isolated storage."""
import copy
import csv
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core import research_evidence as evidence, evidence_matrix as matrix
from pulse_core import screening,cache_maintenance as cache,ranking_experiments as ranking
from pulse_core.passages import parse_pmc_xml
from pulse_core.constants import ClientError
from pulse_performance import DiscoveryCancelled

PAPER={'id':'p1','doi':'10.1234/one','title':'Synthetic trial','year':'2024','abstract':'We studied therapy.'}
OTHER={'id':'p2','doi':'10.1234/two','title':'Synthetic cohort','year':'2023'}
XML=b'''<article><front><article-meta><article-id pub-id-type="doi">10.1234/citing</article-id><article-id pub-id-type="pmc">123</article-id><article-id pub-id-type="pmid">456</article-id></article-meta></front><body><sec id="results"><title>Results</title><p id="p1">We observed reduced mortality <xref ref-type="bibr" rid="r1">[1]</xref>. Another paper measured infection <xref ref-type="bibr" rid="r2">[2]</xref>. No cited statement follows.</p></sec></body><back><ref-list><ref id="r1"><mixed-citation><pub-id pub-id-type="doi">10.1234/one</pub-id><pub-id pub-id-type="pmid">111</pub-id></mixed-citation></ref><ref id="r2"><mixed-citation><pub-id pub-id-type="doi">10.1234/one-extra</pub-id></mixed-citation></ref></ref-list></back></article>'''


class EvidenceIntegration(unittest.TestCase):
    def test_full_text_has_page_section_provenance_and_skips_bibliography(self):
        paper=dict(PAPER,text='available',evidencePassages=[
            {'page':2,'source':'Local PDF','text':'Methods\nWe used microscopy on human cells.'},
            {'page':3,'source':'Local PDF','text':'Results\nWe found a 24% improvement in survival.\nDiscussion\nA limitation is the small sample size.'},
            {'page':4,'source':'Local PDF','text':'References\nWe found a 99% improvement in an unrelated paper.'}])
        with patch.object(evidence,'local_matches',return_value=[]),patch.object(evidence.passages,'get_document') as network:
            hydrated=evidence.hydrate([paper],False)[0]
        network.assert_not_called()
        row=matrix.build_evidence_row(hydrated,matrix.DEFAULT_COLUMNS)
        self.assertEqual(row['cells']['method']['provenance']['page'],2)
        self.assertEqual(row['cells']['limitation']['provenance']['section'],'Discussion')
        self.assertIn('24%',row['cells']['finding']['quote'])
        self.assertNotIn('99%',str(row))

    def test_library_resolves_by_doi_and_rejects_conflicting_id(self):
        saved=dict(PAPER,text='Methods\nWe used microscopy on human cells.')
        found=evidence.local_paper(dict(PAPER,id='search-id'),[saved])
        self.assertEqual(found['text'],saved['text'])
        with self.assertRaises(ClientError):evidence.local_paper(dict(PAPER,doi='10.1234/conflict'),[saved])

    def test_network_is_opt_in_and_failure_keeps_abstract(self):
        with patch.object(evidence,'local_matches',return_value=[]),patch.object(evidence.passages,'cached_document',return_value=None),patch.object(evidence.passages,'get_document',side_effect=TimeoutError) as request:
            evidence.hydrate([PAPER],False);request.assert_not_called()
            result=evidence.hydrate([PAPER],True)[0]
        self.assertEqual(result['abstract'],PAPER['abstract']);self.assertIn('could not',result['evidenceWarning'])

    def test_matrix_cache_invalidates_late_text_and_returns_independent_rows(self):
        first=dict(PAPER,text='Neutral background. '*1300+'A limitation is the small sample size.')
        before=matrix.build_evidence_row(first,matrix.DEFAULT_COLUMNS)
        after=matrix.build_evidence_row(dict(first,text=first['text'].replace('small sample size','observational nature')),matrix.DEFAULT_COLUMNS)
        self.assertIn('observational nature',after['cells']['limitation']['quote'])
        self.assertNotEqual(before['cells']['limitation'],after['cells']['limitation'])
        after['cells']['limitation']['quote']='mutated'
        self.assertNotEqual(matrix.build_evidence_row(first,matrix.DEFAULT_COLUMNS)['cells']['limitation']['quote'],'mutated')
        self.assertIn('small sample',before['cells']['limitation']['passage'])

    def test_page_passages_work_without_duplicate_flat_text_and_export_provenance(self):
        paper=dict(PAPER,text='',evidencePassages=[{'text':'A limitation is the small sample size.','page':7,'section':'Discussion','source':'Local PDF'}])
        row=matrix.build_evidence_row(paper,matrix.DEFAULT_COLUMNS)
        self.assertTrue(row['cells']['limitation']['grounded'])
        document={'rows':[row],'columns':matrix.DEFAULT_COLUMNS}
        csv_text=matrix.export_matrix_csv(document);markdown=matrix.export_matrix_markdown(document)
        self.assertIn('Limitation source',csv_text);self.assertIn('Local PDF',csv_text)
        self.assertIn('page',markdown);self.assertIn('small sample',markdown)

    def test_jats_sentence_reference_identity_and_article_pmid(self):
        doc=parse_pmc_xml(XML,{'doi':'10.1234/citing','pmid':'456'})
        self.assertEqual(doc['pmid'],'456')
        self.assertEqual(len(doc['citationPassages']),2)
        self.assertEqual(doc['citationPassages'][0]['referenceIds'],['r1'])
        self.assertNotIn('infection',doc['citationPassages'][0]['text'])
        with self.assertRaises(ClientError):parse_pmc_xml(XML,{'pmid':'wrong'})
        with patch.object(evidence,'local_matches',return_value=[]),patch.object(evidence.passages,'get_document',return_value=doc):
            result=evidence.verify_citation({'paper':{'doi':'10.1234/citing'},'target':PAPER})
        self.assertTrue(result['verified']);self.assertEqual(len(result['contexts']),1)
        self.assertNotIn('infection',result['contexts'][0]['text'])

    def test_local_pdf_numbered_doi_requires_exact_match_and_body_marker(self):
        paper=dict(PAPER,text='Results\nWe found a useful result [2]. Another claim [3].\nReferences\n[2] Example (2024). Study. doi:10.1234/two\n[3] Other (2024). Study. doi:10.1234/two-extra')
        contexts=evidence.local_citation_contexts(paper,OTHER)
        self.assertEqual(len(contexts),1);self.assertNotIn('Another',contexts[0]['text'])
        self.assertFalse(evidence.local_citation_contexts(paper,dict(OTHER,doi='10.1234/missing')))
        # Duplicate bibliography numbering cannot establish reference identity.
        self.assertFalse(evidence.local_citation_contexts(dict(paper,text=paper['text']+'\n[2] A conflicting entry'),OTHER))

    def test_verification_timeout_is_explicit_but_identity_mismatch_is_error(self):
        with patch.object(evidence,'local_matches',return_value=[]),patch.object(evidence.passages,'get_document',side_effect=TimeoutError):
            self.assertFalse(evidence.verify_citation({'paper':OTHER,'target':PAPER})['verified'])
        with patch.object(evidence,'local_matches',return_value=[]),patch.object(evidence.passages,'get_document',side_effect=ClientError(409,'Wrong article')):
            with self.assertRaises(ClientError):evidence.verify_citation({'paper':OTHER,'target':PAPER})


class ScreeningPersistence(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.project=screening.handle({'context':'synthetic-review','name':'Trial review'},self.temp.name)['project']
        self.sequence=0

    def call(self,action,**data):
        self.sequence+=1
        return screening.handle(dict(project=self.project,action=action,requestId='request-%08d'%self.sequence,**data),self.temp.name)

    def test_search_run_idempotence_and_doi_deduplication_across_runs(self):
        self.call('ingest',runId='run1',papers=[PAPER,dict(PAPER,id='duplicate')],runInfo={'errors':{'arxiv':'rate limited'}})
        self.call('ingest',runId='run1',papers=[OTHER])
        data=self.call('ingest',runId='run2',papers=[PAPER,OTHER])
        self.assertEqual(len(data['records']),2);self.assertEqual(len(data['runs']),2)
        self.assertEqual(data['records']['doi:10.1234/one']['sources'],['run1','run2'])
        self.assertEqual(data['counts']['recordsIdentified'],None)
        self.assertFalse(data['counts']['complete'])

    def test_separate_stages_and_required_full_text_reason_are_atomic(self):
        self.call('decision',papers=[PAPER],stage='title-abstract',decision='include',priorGrade=1)
        with self.assertRaisesRegex(ClientError,'reason'):
            self.call('decision',papers=[PAPER,OTHER],stage='full-text',decision='exclude')
        data=self.call('open');self.assertNotIn('full-text',data['records']['doi:10.1234/one']['stages'])
        data=self.call('decision',papers=[PAPER],stage='full-text',decision='exclude',reason='Wrong outcome')
        self.assertEqual(data['counts']['recordsScreened'],1)
        self.assertEqual(data['counts']['fullTextExclusionReasons'],{'Wrong outcome':1})
        self.assertEqual(data['records']['doi:10.1234/one']['stages']['title-abstract']['decision'],'include')

    def test_durable_undo_preserves_later_metadata_and_only_returns_affected_ids(self):
        self.call('decision',papers=[PAPER],stage='title-abstract',decision='include',priorGrade=1)
        self.call('annotate',papers=[PAPER,OTHER],memo='Check assay',tags=['methods','methods','review'])
        self.call('ingest',runId='later',papers=[dict(PAPER,title='Corrected title')])
        data=self.call('undo');self.assertEqual(data['undoneAction'],'annotate')
        self.assertEqual(len(data['undoneRecords']),2)
        self.assertEqual(data['records']['doi:10.1234/one']['paper']['title'],'Corrected title')
        data=self.call('undo');self.assertEqual(data['undoneRecords'],['doi:10.1234/one'])
        self.assertEqual(data['records']['doi:10.1234/one']['feedbackGrade'],1)
        self.assertFalse(data['canUndo'])
        self.assertEqual(self.call('open')['eventCount'],4)

    def test_replayed_actions_and_undo_are_idempotent(self):
        payload=dict(project=self.project,action='decision',requestId='same-request',papers=[PAPER,PAPER],stage='title-abstract',decision='include')
        screening.handle(payload,self.temp.name);screening.handle(payload,self.temp.name)
        undo=dict(project=self.project,action='undo',requestId='same-undo')
        first=screening.handle(undo,self.temp.name);second=screening.handle(undo,self.temp.name)
        self.assertEqual(first['undoneRecords'],second['undoneRecords']);self.assertEqual(second['eventCount'],2)
        self.assertEqual(second['undoneAction'],'decision')

    def test_batch_decision_is_one_undo_action_with_individual_prior_grades(self):
        data=self.call('decision',papers=[dict(PAPER,_priorGrade=2),dict(OTHER,_priorGrade=0)],stage='title-abstract',decision='include')
        self.assertEqual(data['eventCount'],1)
        restored=self.call('undo')
        self.assertEqual(restored['records']['doi:10.1234/one']['feedbackGrade'],2)
        self.assertEqual(restored['records']['doi:10.1234/two']['feedbackGrade'],0)

    def test_exports_keep_decisions_reasons_tags_history_and_unknown_counts(self):
        self.call('decision',papers=[dict(PAPER,title='=SUM(1,2)')],stage='full-text',decision='exclude',reason='Wrong outcome')
        self.call('annotate',papers=[PAPER],memo='  =danger()',tags=['follow-up'])
        output=self.call('export',format='csv')['content'];rows=list(csv.reader(io.StringIO(output)))
        self.assertTrue(rows[1][1].startswith("'="));self.assertTrue(rows[1][6].startswith("'"))
        ris=self.call('export',format='ris')['content']
        self.assertIn('KW  - Pulse:full-text:exclude',ris);self.assertIn('Wrong outcome',ris);self.assertIn('KW  - follow-up',ris)
        audit=json.loads(self.call('export',format='json')['content']);self.assertEqual(len(audit['history']),2)
        prisma=json.loads(self.call('export',format='prisma')['content']);self.assertIsNone(prisma['studiesIncluded'])
        self.assertEqual(prisma['reportsExcluded'],1)

    def test_prisma_svg_blind_json_and_reconciliation(self):
        self.call('decision', papers=[PAPER], stage='title-abstract', decision='include')
        self.call('decision', papers=[OTHER], stage='title-abstract', decision='exclude')
        svg_exp = self.call('export', format='prisma-svg')
        self.assertEqual(svg_exp['mime'], 'image/svg+xml')
        self.assertIn('<svg', svg_exp['content'])
        self.assertIn('PRISMA 2020', svg_exp['content'])

        blind = self.call('export', format='blind-json')
        self.assertEqual(blind['mime'], 'application/json')
        blind_data = json.loads(blind['content'])
        self.assertEqual(blind_data['records']['doi:10.1234/one']['stages'], {})

        r2_data = {
            'records': {
                'doi:10.1234/one': {'stages': {'title-abstract': {'decision': 'include'}}},
                'doi:10.1234/two': {'stages': {'title-abstract': {'decision': 'include'}}},
            }
        }
        reconciled = screening.handle({'action': 'reconcile', 'project': self.project, 'reviewer2': r2_data}, self.temp.name)
        self.assertEqual(reconciled['concordant'], 1)
        self.assertEqual(reconciled['discrepant'], 1)
        self.assertEqual(len(reconciled['discrepancies']), 1)
        self.assertIn('kappa', reconciled)


class CacheMaintenance(unittest.TestCase):
    def test_expiry_byte_and_row_limits_prefer_recent_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            db=sqlite3.connect(Path(root)/'http-cache.sqlite3');now=time.time()
            db.execute('CREATE TABLE http_cache (key TEXT PRIMARY KEY,size INTEGER,expires_at REAL,used REAL)')
            db.executemany('INSERT INTO http_cache VALUES (?,?,?,?)',[
                ('expired',5,now-1,now-100),('old-query',5,now+500,now-100),('new-query',5,now+500,now),('metadata',5,now+604800,now-200)])
            db.commit();db.close()
            result=cache.maintain(root,max_bytes=10,max_rows=2)
            self.assertEqual(result['entries'],2);self.assertEqual(result['removed'],2)
            db=sqlite3.connect(Path(root)/'http-cache.sqlite3')
            self.assertEqual({r[0] for r in db.execute('SELECT key FROM http_cache')},{'new-query','metadata'});db.close()
            self.assertFalse((Path(root)/'library.sqlite3').exists())


class TargetedSourceRetry(unittest.TestCase):
    def test_only_requested_enabled_source_executes(self):
        import pulse_core as core
        from pulse_core.discovery import run_discovery_pipeline
        payload={'seedPapers':[PAPER],'semanticRerank':False,'authorTrajectory':False,
            'branches':{'citationGraph':False,'citationNetwork':False,'citationCoCitation':False,'semanticSearch':False,'lexicalSearch':True},
            'searchSources':{'semanticScholar':False,'europePmc':True,'core':True},'retryBranches':['europePmc']}
        with patch.object(core,'load_settings',return_value={}),patch.object(core,'search_europe_pmc',return_value=[dict(OTHER,source='Europe PMC')]) as pmc,patch.object(core,'search_core') as core_search:
            result=run_discovery_pipeline(payload)
        self.assertTrue(pmc.called);core_search.assert_not_called()
        self.assertEqual(result['branchesExecuted'],['europePmc'])
        with self.assertRaises(ClientError):run_discovery_pipeline(dict(payload,retryBranches=['citationGraph']))


class RankingExperiments(unittest.TestCase):
    def bio(self,score=.95,domain='4'):
        return dict(PAPER,primaryTopic={'score':score,'domain':{'id':'https://openalex.org/domains/'+domain}})

    def test_defaults_are_fixed_and_adaptation_respects_intent_and_coverage(self):
        self.assertEqual(ranking.structural_policy({},[],[])['weight'],.06)
        seeds=[dict(PAPER,referenceIds=['x'])];structures=[{'strength':.5}]
        broad=ranking.structural_policy({'adaptiveStructure':True},seeds,structures)
        narrow=ranking.structural_policy({'adaptiveStructure':True,'researchQuestion':'specific assay'},seeds,structures)
        self.assertLess(narrow['weight'],broad['weight']);self.assertLessEqual(broad['weight'],.10)
        missing=ranking.structural_policy({'adaptiveStructure':True,'structuralIntent':'focused'},[PAPER],structures)
        self.assertEqual(missing['weight'],0);self.assertEqual(missing['backwardWeight'],0)

    def test_mixed_or_uncertain_topics_and_generic_queries_do_not_route(self):
        self.assertEqual(ranking.route_indices([self.bio()],['diabetes treatment'],[self.bio(),PAPER]),[0])
        for seeds,queries in [([self.bio(.79)],['therapy']),([self.bio(),PAPER],['therapy']),([self.bio()],['transport systems'])]:
            self.assertFalse(ranking.route_indices(seeds,queries,[self.bio()]))

    def test_manifest_checks_corruption_and_invalid_format(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root);(path/'model.onnx').write_bytes(b'synthetic model');(path/'tokenizer.json').write_bytes(b'{}')
            manifest={'model':ranking.MODEL_ID,'format':'pulse-medcpt-onnx-int8-v1','sha256':{name:hashlib.sha256((path/name).read_bytes()).hexdigest() for name in ('model.onnx','tokenizer.json')}}
            (path/'manifest.json').write_text(json.dumps(manifest));settings={'searchBiomedicalModelPath':root}
            self.assertEqual(ranking.optional_model(settings),path)
            (path/'model.onnx').write_bytes(b'corrupt');self.assertIsNone(ranking.optional_model(settings))

    def test_optional_router_blends_only_confident_candidates_and_falls_back(self):
        settings={'searchBiomedicalRouter':True}
        with patch('pulse_core.discovery_crossencoder.crossencoder_scores',side_effect=[([.2,.4],'baseline'),([.8],'bio')]),patch('pulse_core.discovery_crossencoder._find_search_runtime',return_value=(Path('/tmp/pulse-reranker'),None)),patch.object(ranking,'optional_model',return_value=Path('/tmp/model')):
            scores,notice=ranking.routed_scores(settings,['diabetes treatment'],[self.bio(),PAPER],[self.bio()])
        self.assertAlmostEqual(scores[0],.35);self.assertEqual(scores[1],.4);self.assertIn('Experimental',notice)
        with patch('pulse_core.discovery_crossencoder.crossencoder_scores',return_value=([.2],'baseline')),patch('pulse_core.discovery_crossencoder._find_search_runtime',return_value=(None,None)),patch.object(ranking,'optional_model',return_value=None):
            self.assertEqual(ranking.routed_scores(settings,['therapy'],[self.bio()],[self.bio()])[0],[.2])

    def test_cancellation_is_not_converted_into_fallback(self):
        with patch('pulse_core.discovery_crossencoder.crossencoder_scores',side_effect=DiscoveryCancelled):
            with self.assertRaises(DiscoveryCancelled):ranking.routed_scores({},['therapy'],[PAPER],[PAPER])


if __name__=='__main__':unittest.main()
