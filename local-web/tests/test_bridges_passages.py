import copy
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core.discovery_bridges import bridge_queries, apply_bridges
from pulse_core.discovery import run_discovery_pipeline
from pulse_core.passages import parse_pmc_xml, cache_document, cached_document, retrieve_passages, s2orc_document, import_s2orc_stream, search_fulltext_library
from pulse_core.research_models import triage, role
from pulse_core.paper_agent import PaperSummaryJobs
from pulse_core.constants import ClientError
from pulse_performance import DiscoveryCancelled

A = {'id':'a', 'title':'Protected bicycle lanes prevent intersection injuries', 'doi':'10.1234/a'}
B = {'id':'b', 'title':'Graph neural networks predict urban transport flows', 'doi':'10.1234/b'}
XML = b'''<article><front><article-meta><article-id pub-id-type="doi">10.1234/study</article-id><article-id pub-id-type="pmc">12345</article-id><title-group><article-title>Transport study</article-title></title-group><permissions><license>CC BY 4.0</license></permissions></article-meta></front><body><sec id="s1"><title>Introduction</title><p>Previous transport records establish an urban observation background without specific cycling results.</p><sec id="s2"><title>Results</title><p>Protected bicycle lanes reduced intersection injuries in this transport survey. The study includes thirty observations.</p></sec></sec></body><back><ref-list><ref>Unrelated reference must not be extracted.</ref></ref-list></back></article>'''


class BridgesAndPassages(unittest.TestCase):
    def test_single_seed_bridge_request_rejected_before_network(self):
        with self.assertRaisesRegex(ClientError, 'two different'):
            run_discovery_pipeline({'seedPapers':[A,dict(A)],'bridgeMode':True})
        with self.assertRaisesRegex(ClientError, 'eight'):
            run_discovery_pipeline({'seedPapers':[dict(A,doi=f'10.1234/seed{i}') for i in range(9)],'bridgeMode':True})

    def test_pair_queries_preserve_both_seed_concepts(self):
        plan=bridge_queries([A,B,A])
        self.assertEqual(len(plan),1);self.assertEqual(len(plan[0]['groups']),2)
        self.assertEqual(plan[0]['seedIndices'],[0,1])

    def test_a_bridge_needs_support_for_both_seeds(self):
        rows=[{'title':'Protected bicycle lanes prevent intersection injuries','abstract':'Road safety observations','score':99},
              {'title':'Graph neural networks for protected bicycle lanes','abstract':'Networks predict urban transport flows and prevent intersection injuries','score':60}]
        apply_bridges(rows,[A,B],{'bridgeMode':True})
        self.assertFalse(rows[0]['isBridge']);self.assertTrue(rows[1]['isBridge'])
        self.assertGreater(rows[1]['score'],rows[0]['score']);self.assertEqual(len(rows[1]['bridgeEvidence']),2)

    def test_original_seed_indices_survive_duplicate_seed_deduplication(self):
        rows=[{'title':'A distinct connector','abstract':'Independent vocabulary','score':80,'retrievalEvidence':[{'channel':'citations:0:backward'},{'channel':'citations:2:forward'}]}]
        apply_bridges(rows,[A,A,B],{'bridgeMode':True,'_originalSeeds':[A,A,B]})
        self.assertTrue(rows[0]['isBridge']);self.assertEqual(rows[0]['bridgeEvidence'][1]['seedId'],'b')

    def test_explicit_rejection_is_not_overridden_by_bridge_bonus(self):
        row={'title':A['title']+' '+B['title'],'score':10,'relevanceGrade':0}
        apply_bridges([row],[A,B],{'bridgeMode':True})
        self.assertEqual(row['score'],0)

    def test_pmc_sections_permissions_and_identifier_provenance(self):
        doc=parse_pmc_xml(XML,{'doi':'10.1234/study','pmcid':'PMC12345'})
        self.assertEqual(doc['pmcid'],'PMC12345');self.assertIn('CC BY',doc['license'])
        self.assertEqual([p['section'] for p in doc['passages']],['Introduction','Results'])
        self.assertEqual(doc['passages'][1]['anchor'],'s2');self.assertNotIn('Unrelated reference',str(doc['passages']))

    def test_wrong_article_and_entity_declarations_are_rejected(self):
        for expected in ({'doi':'10.1234/wrong'},{'pmcid':'PMC999'}):
            with self.assertRaises(ClientError):parse_pmc_xml(XML,expected)
        with self.assertRaises(ClientError):parse_pmc_xml(b'<!ENTITY x "evil">'+XML,{})

    def test_cached_text_keeps_exact_identifiers_and_refuses_conflicting_doi(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_document(parse_pmc_xml(XML,{}),directory)
            self.assertIsNotNone(cached_document({'doi':'10.1234/study'},directory))
            self.assertIsNone(cached_document({'doi':'10.1234/wrong','pmcid':'PMC12345'},directory))

    def test_passages_rank_for_question_and_keep_source(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_document(parse_pmc_xml(XML,{}),directory)
            result=retrieve_passages({'paper':{'doi':'10.1234/study'},'question':'bicycle lanes intersection injuries','limit':1},directory)
        self.assertTrue(result['available']);self.assertEqual(result['passages'][0]['section'],'Results')
        self.assertEqual(result['source'],'PMC / Europe PMC');self.assertIn('not a whole',result['message'])

    def test_unavailable_full_text_falls_back_without_invented_passages(self):
        with patch('pulse_core.passages.get_document',side_effect=OSError('Unavailable')):
            result=retrieve_passages({'paper':{'abstract':'An available abstract'}})
        self.assertFalse(result['available']);self.assertEqual(result['source'],'Abstract');self.assertFalse(result['passages'])

    def test_identity_mismatch_and_cancellation_are_not_silently_swallowed(self):
        for error in (ClientError(409,'Wrong DOI'),DiscoveryCancelled()):
            with patch('pulse_core.passages.get_document',side_effect=error):
                with self.assertRaises(type(error)):retrieve_passages({'paper':A})

    def test_s2orc_classic_and_current_offset_records(self):
        classic=s2orc_document({'paper_id':'hash','metadata':{'title':'Survey'},'externalids':{'DOI':'10.1234/s2'},'body_text':[{'section':'Results','text':'A measured observational result in the transport survey with enough passage text.'}]})
        text='Results\nA measured observational result in the transport survey with enough passage text.'
        modern=s2orc_document({'corpusid':123,'externalids':{'DOI':'10.1234/current'},'content':{'text':text,'annotations':{'sectionheader':json.dumps([{'start':0,'end':7}]),'paragraph':json.dumps([{'start':8,'end':len(text)}])}}})
        self.assertEqual(classic['passages'][0]['section'],'Results');self.assertEqual(modern['passages'][0]['section'],'Results')
        self.assertEqual(modern['corpusId'],123)

    def test_streamed_local_corpus_import_skips_bad_records(self):
        row={'corpusid':123,'body_text':[{'text':'A measured observational result with enough text for an indexed source passage.'}]}
        stream=io.BytesIO((json.dumps(row)+'\ninvalid\n[]\n').encode())
        with tempfile.TemporaryDirectory() as directory:
            result=import_s2orc_stream(stream,directory)
            doc=cached_document({'corpusId':123},directory)
        self.assertEqual(result,{'ok':True,'imported':1,'skipped':2});self.assertEqual(doc['source'],'S2ORC local corpus')

    def test_fulltext_search_finds_body_evidence_absent_from_title(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_document(parse_pmc_xml(XML,{}),directory)
            found=search_fulltext_library('bicycle intersection injuries',10,directory)
        self.assertEqual(len(found),1);self.assertEqual(found[0]['title'],'Transport study')
        self.assertEqual(found[0]['matchedPassages'][0]['section'],'Results');self.assertNotIn('abstract',found[0])
        self.assertEqual(found[0]['retrievalEvidence'][0]['channel'],'fulltext:question')

    def test_reindexing_does_not_duplicate_old_passage_hits(self):
        with tempfile.TemporaryDirectory() as directory:
            doc=parse_pmc_xml(XML,{});cache_document(doc,directory);cache_document(doc,directory)
            self.assertEqual(len(search_fulltext_library('bicycle',20,directory)),1)

    def test_corpus_metadata_is_joined_only_by_matching_identifier(self):
        doc=s2orc_document({'corpusid':123,'body_text':[{'text':'Protected bicycle lanes reduced intersection injuries in the transport survey.'}]})
        with tempfile.TemporaryDirectory() as directory:
            cache_document(doc,directory)
            with patch('pulse_core.s2_client.post_s2_json',return_value=[{'corpusId':123,'title':'Verified transport survey','externalIds':{'DOI':'10.1234/transport'},'authors':[]}]) as request:
                found=search_fulltext_library('intersection injuries',10,directory)
            self.assertEqual(found[0]['title'],'Verified transport survey');self.assertEqual(found[0]['doi'],'10.1234/transport')
            self.assertEqual(request.call_args.args[1]['ids'],['CorpusId:123'])
            with patch('pulse_core.s2_client.post_s2_json',return_value=[{'corpusId':999,'title':'Wrong paper'}]):
                found=search_fulltext_library('intersection injuries',10,directory)
            self.assertEqual(found[0]['title'],'S2ORC record 123')

    def test_current_corpus_title_annotations_are_preserved(self):
        text='Transport survey\nResults\nProtected bicycle lanes reduced intersection injuries in the transport survey.'
        doc=s2orc_document({'corpusid':123,'content':{'text':text,'annotations':{'title':[{'start':0,'end':16}],'sectionheader':[{'start':17,'end':24}],'paragraph':[{'start':25,'end':len(text)}]}}})
        self.assertEqual(doc['title'],'Transport survey');self.assertEqual(doc['passages'][0]['section'],'Results')

    def test_selected_report_uses_passages_and_preserves_coverage(self):
        evidence={'available':True,'source':'PMC / Europe PMC','passages':[{'id':'p2','section':'Results','text':'Thirty observations supported the reported result.'}]}
        jobs=PaperSummaryJobs();job={'view':{'model':'qwen2.5:7b','total':1},'cancel':threading.Event()}
        with patch('pulse_core.passages.retrieve_passages',return_value=evidence),patch('pulse_core.paper_agent.local_chat',return_value='Reported result [p2].') as chat:
            result=jobs.summarize(job,{'name':'Europe PMC recommendation','title':'Survey','doi':'10.1234/study','text':'Metadata text','abstract':'Survey abstract'},'',1)
        self.assertIn('Selected full-text passages',result['source']);self.assertIn('not the whole article',chat.call_args.args[1]);self.assertEqual(result['evidence'],evidence)

    def test_triage_cannot_hide_records_or_override_missing_abstract(self):
        rows=[{'title':'Survey','abstract':'An observed study result','score':80},{'title':'No abstract','score':70}]
        response=io.BytesIO(json.dumps({'message':{'content':json.dumps({'reviews':[{'id':'0','decision':'not_relevant','reason':'Wrong scope'},{'id':'1','decision':'not_relevant','reason':'Missing data'},{'id':'99','decision':'relevant'}]})}}).encode())
        with patch('pulse_core.research_models.LOCAL_HTTP.open',return_value=response):
            count=triage(rows,'Transport safety',{})
        self.assertEqual(count,2);self.assertEqual(len(rows),2);self.assertEqual(rows[1]['aiReview']['decision'],'uncertain');self.assertEqual(rows[1]['score'],70)

    def test_unavailable_model_preserves_original_scores_and_cancel_propagates(self):
        rows=[{'score':80}];before=copy.deepcopy(rows)
        with patch('pulse_core.research_models.LOCAL_HTTP.open',side_effect=OSError('Offline')):
            self.assertEqual(triage(rows,'Question',{}),0)
        self.assertEqual(rows,before)
        cancel=threading.Event();cancel.set()
        with self.assertRaises(DiscoveryCancelled):triage(rows,'Question',{},cancel)
        self.assertEqual(role({'reportModel':'qwen-cloud'},'reportModel'),'qwen2.5:7b')


if __name__=='__main__':unittest.main()
