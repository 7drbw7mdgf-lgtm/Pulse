import copy
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-concept-test-'))
import pulse_core as core
from pulse_core import concept_search, discovery, ai_inference
from pulse_core.constants import ClientError
from pulse_core.discovery_queries import provider_query
from pulse_performance import DiscoveryCancelled


AI_PLAN = {'concepts': [
    {'phrase':'bicycle lanes', 'alternatives':['cycling infrastructure']},
    {'phrase':'intersection injuries', 'alternatives':['junction safety']},
]}
QUERY = 'How do bicycle lanes reduce intersection injuries?'
RESULT = {'title':'Protected bicycle lanes reduce intersection injuries', 'abstract':QUERY,
          'doi':'10.1234/cycling', 'authors':['Ada Brooks'], 'year':'2025', 'source':'Europe PMC'}


class ConceptSearchTests(unittest.TestCase):
    def prepare(self, response=None):
        with patch.object(concept_search, 'call_ai', return_value=json.dumps(response or AI_PLAN)):
            return concept_search.prepare_concept_search(QUERY, {})

    def test_topic_requires_no_paper_and_never_creates_a_synthetic_seed(self):
        seeds, query = concept_search.validate_discovery_request({'searchMode':'concept','query':QUERY,
            'seedPapers':[{'title':'An unrelated selected paper'}]})
        self.assertEqual(seeds, [])
        self.assertEqual(query, QUERY)
        for payload in ({}, {'searchMode':'concept','query':'   '}, {'searchMode':'concept','query':[]},
                        {'searchMode':'concept','query':'x'*1001}, {'searchMode':'concept','query':'!!!'}):
            with self.subTest(payload=payload), self.assertRaises(ClientError):
                concept_search.validate_discovery_request(payload)

    def test_configured_ai_extracts_bounded_phrases_and_synonyms(self):
        with patch.object(concept_search,'call_ai',return_value=json.dumps(AI_PLAN)) as call:
            prepared=concept_search.prepare_concept_search(QUERY, {'aiProvider':'local'})
        self.assertTrue(prepared['aiAssisted'])
        self.assertEqual(prepared['keywords'], ['bicycle lanes','intersection injuries'])
        self.assertEqual(prepared['groups'][0], ['bicycle lanes','cycling infrastructure'])
        self.assertEqual(prepared['query'], QUERY)
        self.assertEqual(call.call_args.kwargs['timeout'],8)
        self.assertTrue(call.call_args.kwargs['json_mode'])
        self.assertIn(json.dumps(QUERY), call.call_args.args[1])
        self.assertEqual(call.call_args.args[0]['gemmaModel'],'llama3.2:3b')

    def test_keyword_role_keeps_report_model_and_cloud_configuration_intact(self):
        for settings in ({'aiProvider':'local','gemmaModel':'qwen2.5:7b','triageModel':'custom-review:3b'},
                         {'aiProvider':'cloud','cloudModel':'configured-cloud','apiKey':'fixture'}):
            original=dict(settings)
            with self.subTest(settings=settings),patch.object(concept_search,'call_ai',return_value=json.dumps(AI_PLAN)) as call:
                concept_search.prepare_concept_search(QUERY,settings)
            self.assertEqual(settings,original)
            if settings['aiProvider']=='local':self.assertEqual(call.call_args.args[0]['gemmaModel'],'custom-review:3b')
            else:self.assertEqual(call.call_args.args[0],settings)

    def test_invalid_json_shapes_and_unavailable_ai_preserve_original_query(self):
        for value in ('invalid', '[]', '{"concepts":[]}', '{"concepts":[{"phrase":12}]}'):
            with self.subTest(value=value), patch.object(concept_search,'call_ai',return_value=value):
                prepared=concept_search.prepare_concept_search(QUERY,{})
                self.assertFalse(prepared['aiAssisted'])
                self.assertEqual(prepared['query'],QUERY)
                self.assertTrue(prepared['keywords'])
        with patch.object(concept_search,'call_ai',side_effect=TimeoutError('private runtime failure')):
            prepared=concept_search.prepare_concept_search(QUERY,{})
        self.assertFalse(prepared['aiAssisted'])
        self.assertNotIn('private',prepared['notice'])

    def test_single_concept_and_acronym_are_valid_queries(self):
        for text in ('CRISPR','ML','immunology'):
            with self.subTest(text=text),patch.object(concept_search,'call_ai',side_effect=TimeoutError()):
                prepared=concept_search.prepare_concept_search(text,{})
                plan=concept_search.concept_query_plan(prepared)
                self.assertEqual(plan[0]['text'],text)
                self.assertEqual(plan[0]['kind'],'question')

    def test_synonyms_are_alternatives_not_extra_required_concepts(self):
        prepared=self.prepare()
        plan=concept_search.concept_query_plan(prepared)
        primary=next(query for query in plan if query['id']=='topic-concepts')
        structured=provider_query(primary,'europePmc')
        self.assertIn('"bicycle lanes" OR "cycling infrastructure"',structured)
        self.assertIn('"intersection injuries" OR "junction safety"',structured)
        self.assertIn(') AND (',structured)
        self.assertEqual(plan[0]['text'],'How do bicycle lanes reduce intersection injuries')
        self.assertTrue(any(q['text']=='cycling infrastructure junction safety' for q in plan))
        self.assertTrue(all(q.get('seedIndex') is None for q in plan))

    def test_keyword_output_is_validated_deduplicated_and_bounded(self):
        data={'concepts':[{'phrase':'bicycle lanes','alternatives':['Bicycle lanes',[],
            'cycling infrastructure','different roads','ignored fourth synonym']},
            {'phrase':'Bicycle lanes'}, {'phrase':'x'*121}, {'phrase':'intersection injuries'},
            {'phrase':'transport planning'},{'phrase':'city policy'},{'phrase':'ignored fifth concept'}]}
        with patch.object(concept_search,'call_ai',return_value=json.dumps(data)):
            prepared=concept_search.prepare_concept_search(QUERY+' transport planning; city policy; ignored fifth concept',{})
        self.assertEqual(len(prepared['keywords']),4)
        self.assertEqual(prepared['groups'][0],['bicycle lanes','cycling infrastructure','different roads'])
        self.assertNotIn('ignored fifth concept',prepared['keywords'])

    def test_ai_cannot_turn_inferred_background_topics_into_required_facets(self):
        prepared=self.prepare({'concepts':AI_PLAN['concepts']+[{'phrase':'traffic accidents'},
            {'phrase':'transportation safety'}]})
        self.assertEqual(prepared['keywords'],['bicycle lanes','intersection injuries'])
        for data in ({'concepts':[{'phrase':'unrelated background topic'}]}, {'keywords':['unrelated background topic']}):
            with self.subTest(data=data):self.assertFalse(self.prepare(data)['aiAssisted'])

    def test_question_scaffolding_never_becomes_a_required_topic(self):
        query='Which research supports or challenges this dataset claim: semantic retrieval improves indexing'
        with patch.object(concept_search,'call_ai',return_value=json.dumps({'concepts':[{'phrase':'dataset claim'},{'phrase':'semantic retrieval'}]})) as call:
            prepared=concept_search.prepare_concept_search(query,{})
        self.assertEqual(prepared['keywords'],['semantic retrieval'])
        self.assertEqual(prepared['query'],query)
        self.assertNotIn('dataset claim',call.call_args.args[1].split('USER TOPIC:\n',1)[1])

    def test_cancellation_before_and_after_ai_does_not_search(self):
        event=threading.Event();event.set()
        with patch.object(concept_search,'call_ai') as call,self.assertRaises(DiscoveryCancelled):
            concept_search.prepare_concept_search(QUERY,{},event)
        call.assert_not_called()
        event.clear()
        def cancel(*args,**kwargs):event.set();return json.dumps(AI_PLAN)
        with patch.object(concept_search,'call_ai',side_effect=cancel),self.assertRaises(DiscoveryCancelled):
            concept_search.prepare_concept_search(QUERY,{},event)

    def test_no_sources_fails_before_an_ai_request(self):
        with patch.object(concept_search,'call_ai') as call,self.assertRaises(ClientError):
            discovery.run_discovery_pipeline({'searchMode':'concept','query':QUERY,
                'searchSources':{'semanticScholar':False,'europePmc':False,'core':False}})
        call.assert_not_called()

    def test_pipeline_searches_topics_and_ai_keywords_without_seed_branches(self):
        requests=[];progress=[];original=copy.deepcopy(RESULT)
        def search(query,limit,**kwargs):requests.append(query);return [copy.deepcopy(RESULT)]
        def forbidden(*args,**kwargs):raise AssertionError('A concept query cannot use citation or recommendation seeds')
        payload={'searchMode':'concept','query':QUERY,'limit':100,
            'branches':{'citationGraph':True,'citationNetwork':True,'semanticSearch':True,'lexicalSearch':False},
            'bridgeMode':True,'seedPapers':[{'title':'Unrelated seed'}],
            'searchSources':{'semanticScholar':False,'europePmc':True,'core':False},
            'semanticRerank':False,'pairwiseRerank':False}
        with patch.object(core,'load_settings',return_value={}),patch.object(concept_search,'call_ai',return_value=json.dumps(AI_PLAN)), \
             patch.object(core,'search_europe_pmc',side_effect=search), \
             patch.object(core,'fetch_citation_graph_branch',side_effect=forbidden), \
             patch.object(discovery,'fetch_citation_network_branch',side_effect=forbidden), \
             patch.object(discovery,'fetch_semantic_search_branch',side_effect=forbidden):
            found=discovery.run_discovery_pipeline(payload,on_progress=progress.append)
        self.assertEqual(found['seedCount'],0)
        self.assertEqual(found['searchMode'],'concept')
        self.assertTrue(found['conceptSearch']['aiAssisted'])
        self.assertEqual(found['branchesExecuted'],['europePmc'])
        self.assertEqual(len(found['recommendations']),1)
        self.assertTrue(any('cycling infrastructure' in query for query in requests))
        self.assertEqual(progress[0]['stage'],'keywords')
        self.assertTrue(any(row.get('conceptSearch') for row in progress))
        self.assertEqual(RESULT,original)
        self.assertTrue(payload['bridgeMode'],'Effective topic options must not mutate the caller')

    def test_original_question_reaches_neural_ranking_with_no_seeds(self):
        captured=[]
        def semantic(settings,queries,records,*args,**kwargs):captured.extend(queries);return [1]*len(records),'fixture'
        with patch.object(core,'load_settings',return_value={}),patch.object(concept_search,'call_ai',return_value=json.dumps(AI_PLAN)), \
             patch.object(discovery,'s2_paper_search',return_value=[RESULT]), \
             patch.object(discovery,'semantic_scores',side_effect=semantic),patch.object(discovery,'pre_embed_papers'), \
             patch.object(discovery,'crossencoder_scores',return_value=([1],'fixture')):
            found=discovery.run_discovery_pipeline({'searchMode':'concept','query':QUERY,
                'searchSources':{'semanticScholar':True,'europePmc':False,'core':False}})
        self.assertEqual(captured[0],QUERY)
        self.assertIn('bicycle lanes intersection injuries',captured)
        self.assertEqual(found['semanticRankedCount'],1)

    def test_timeout_reaches_both_supported_ai_transports(self):
        for provider,body in [('local',{'message':{'content':json.dumps(AI_PLAN)}}),
                              ('cloud',{'candidates':[{'content':{'parts':[{'text':json.dumps(AI_PLAN)}]}}]})]:
            with self.subTest(provider=provider),patch('urllib.request.urlopen',return_value=io.BytesIO(json.dumps(body).encode())) as transport:
                ai_inference.call_ai({'aiProvider':provider,'apiKey':'fixture'},'Extract phrases',json_mode=True,timeout=8)
            self.assertEqual(transport.call_args.kwargs['timeout'],8)


if __name__=='__main__':unittest.main()
