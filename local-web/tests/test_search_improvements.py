import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-search-test-'))
from pulse_core.discovery_queries import build_query_plan, provider_query, search_query_plan
from pulse_core.discovery_feedback import feedback_for_context
from pulse_core.discovery_crossencoder import crossencoder_scores
from pulse_core.discovery_matches import fit_calibration
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_core import discovery, discovery_semantics
import pulse_core as core
import pulse_performance as perf

SEED={'title':'Urban mobility research','doi':'10.1234/seed','s2PaperId':'seed-id','paperKeywords':['protected bicycle lanes','intersection injuries']}
def paper(index,**kwargs):
    return {'title':f'Transport catalogue {index}','doi':f'10.1234/article-{index}','abstract':'Historical transport catalogues',**kwargs}


class SearchImprovementsTests(unittest.TestCase):
    def tearDown(self):
        for key in ('deadline','request_counter','cancel_event','on_partial'):setattr(perf.REQUEST_CONTEXT,key,None)

    def test_preserved_phrases_and_concept_conjunction(self):
        plan=build_query_plan([SEED],preferred=['protected bicycle lanes','intersection injuries'])
        for source in ('europePmc','core'):
            query=provider_query(plan[0],source)
            self.assertIn('"protected bicycle lanes"',query);self.assertIn(' AND ',query)
            broad=provider_query(dict(plan[0],kind='broader'),source)
            self.assertNotIn('intersection injuries',broad)
        dangerous=provider_query({'kind':'concepts','text':'"cycling" OR *:* http://evil.example TITLE:injected'},'core')
        self.assertNotIn('*:*',dangerous);self.assertNotIn('://',dangerous)

    def test_synonyms_share_a_concept_instead_of_new_requirements(self):
        query=provider_query(build_query_plan([dict(SEED,paperKeywords=['machine learning','intersection injuries'])],preferred=['machine learning','intersection injuries'])[0],'europePmc')
        self.assertIn('("machine learning" OR "ML") AND ("intersection injuries")',query)

    def test_sparse_focus_loosens_one_concept_and_streams(self):
        calls,updates=[],[]
        def source(query,limit):
            calls.append(query)
            return [] if 'AND' in query else [paper('found')]
        plan=build_query_plan([SEED],preferred=SEED['paperKeywords'])
        found=search_query_plan(plan,'europePmc',source,300,on_progress=lambda rows:updates.append(copy.deepcopy(rows)))
        self.assertTrue(found);self.assertTrue(any(rows for rows in updates))
        self.assertGreater(len(calls),1)

    def test_partial_response_survives_deadline_expiring(self):
        def source(query,limit):
            perf.REQUEST_CONTEXT.deadline=time.monotonic()-1
            return [paper('partial')]
        found=search_query_plan(build_query_plan([SEED]),'semanticScholar',source,300)
        self.assertEqual(found[0]['doi'],'10.1234/article-partial');self.assertIn('budget',found.warning)

    def test_sparse_broadening_does_not_skip_remaining_seed_queries(self):
        other = dict(SEED, title='Freight railway capacity', paperKeywords=[])
        calls=[]
        def source(query, limit):
            calls.append(query)
            return [paper('railway')] if 'Freight railway capacity' in query else []
        found=search_query_plan(build_query_plan([SEED,other]),'europePmc',source,300)
        self.assertTrue(found);self.assertTrue(any('Freight railway capacity' in query for query in calls))

    def test_independent_sources_start_together(self):
        barrier=threading.Barrier(6)
        def run():barrier.wait(timeout=2);return [paper('one')]
        result,completed,errors=perf.parallel_branches({str(i):run for i in range(6)})
        self.assertEqual(len(completed),6);self.assertFalse(errors);self.assertEqual(len(result),6)

    def test_branch_budget_preserves_streamed_results(self):
        updates=[]
        def run():
            perf.publish_partial([paper('partial')]);perf.REQUEST_CONTEXT.deadline=time.monotonic()-1;perf.check_cancelled()
        rows,completed,errors=perf.parallel_branches({'slow':run},lambda *args:updates.append(args))
        self.assertEqual(rows['slow'][0]['doi'],'10.1234/article-partial');self.assertFalse(completed);self.assertIn('budget',errors['slow']);self.assertTrue(updates)

    def test_transport_budget_is_shared_with_nested_lookups(self):
        perf.REQUEST_CONTEXT.request_counter={'remaining':1,'lock':threading.Lock()}
        with patch.object(perf.urllib.request,'urlopen',return_value=io.BytesIO(b'{}')) as network:
            with self.assertRaises(perf.DiscoveryBudgetExceeded):
                perf.parallel_lookup(lambda value:perf.request_json(urllib.request.Request('https://unit.test/'+str(value)),cache=False),[1,2])
            self.assertEqual(network.call_count,1)

    def test_request_timeout_respects_remaining_budget(self):
        perf.REQUEST_CONTEXT.deadline=101.0
        # Exact binary fractions avoid platform clock resolution and subtraction noise.
        with patch.object(perf.time,'monotonic',return_value=100.25), patch.object(perf.urllib.request,'urlopen',return_value=io.BytesIO(b'{}')) as network:
            perf.request_json(urllib.request.Request('https://unit.test/budget'),cache=False)
            self.assertEqual(network.call_args.kwargs['timeout'],.75)

    def test_feedback_is_scoped_to_question_and_seed_identity(self):
        payload={'researchQuestion':'Safer cycling','feedbackContext':{'researchQuestion':'Safer cycling','seedPapers':[SEED]},'relevanceFeedback':[{'grade':0,'paper':paper('no')},{'grade':2,'paper':paper('yes')}]}
        self.assertEqual(len(feedback_for_context(payload,[SEED])),2)
        self.assertFalse(feedback_for_context(dict(payload,researchQuestion='Train timetables'),[SEED]))
        self.assertFalse(feedback_for_context(payload,[dict(SEED,doi='10.1234/different')]))

    def test_rejected_feedback_demotes_matching_paper(self):
        a=paper('no',title='Urban mobility historical records');b=paper('yes',title='Safer intersections',abstract='Protected bicycle lanes reduce intersection injuries')
        found=rank({'one':[a,b]},[SEED],{'relevanceFeedback':[{'grade':0,'paper':a},{'grade':2,'paper':b}],'diversify':False})
        self.assertEqual(found[0]['doi'],b['doi']);self.assertEqual(found[-1]['matchLabel'],'Not relevant')

    def test_feedback_reaches_semantic_scholar_positive_and_negative_examples(self):
        with patch.object(core,'s2_paper_id_for_paper',return_value='seed-id'),patch.object(discovery,'s2_recommendations',return_value=[]) as recommend:
            discovery.fetch_semantic_search_branch([SEED],feedback=[{'grade':2,'paper':paper('yes',s2PaperId='positive-id')},{'grade':0,'paper':paper('no',s2PaperId='negative-id')}])
        self.assertEqual(recommend.call_args.args[0],['seed-id','positive-id']);self.assertEqual(recommend.call_args.kwargs['negative_ids'],['negative-id'])

    def test_large_pool_is_kept_and_neural_shortlist_has_source_coverage(self):
        records=[paper(i) for i in range(800)]
        novel=paper('novel',title='Designing safer crossings',abstract='An independent conceptual vocabulary')
        captured=[]
        def neural(queries,rows):
            captured.extend(rows);return [1 if p['doi']==novel['doi'] else 0 for p in rows],'fixture'
        options={'limit':500,'_pairwiseReranker':neural,'diversify':False}
        found=rank({'major':records,'independent':[novel]},[SEED],options)
        self.assertEqual(len(found),500);self.assertEqual(options['_candidateCount'],801)
        self.assertIn(novel['doi'],[p['doi'] for p in captured]);self.assertEqual(len(captured),75)
        self.assertEqual(found[0]['doi'],novel['doi'])

    def test_missing_model_keeps_all_candidates(self):
        found=rank({'one':[paper(i) for i in range(650)]},[SEED],{'limit':500,'_semanticReranker':lambda q,r:(None,'unavailable')})
        self.assertEqual(len(found),500)

    def test_ranker_runtime_launch_failure_falls_back(self):
        with patch('pulse_core.discovery_crossencoder.Path.is_file',return_value=True),patch('pulse_core.discovery_crossencoder.Path.is_dir',return_value=True),patch('pulse_core.discovery_crossencoder.subprocess.Popen',side_effect=OSError('Unavailable runtime')):
            scores,notice=crossencoder_scores({},['Question'],[paper('one')])
        self.assertIsNone(scores);self.assertIn('using text',notice)

    def test_weak_best_hit_does_not_become_strong_relative_to_pool(self):
        found=rank({'one':[paper(1,abstract='Bicycles in a historical catalogue')]},[SEED],{'researchQuestion':'Do bicycles reduce intersection injuries through protected lanes in cities?'})
        self.assertEqual(found[0]['matchLabel'],'Related');self.assertFalse(found[0]['strongMatchEligible']);self.assertLess(found[0]['queryCoverage'],.35)
        other=rank({'one':[paper(2,abstract='Completely unrelated'),paper(1,abstract='Bicycles in a historical catalogue')]},[SEED],{'researchQuestion':'Do bicycles reduce intersection injuries through protected lanes in cities?'})
        self.assertEqual(next(p for p in other if p['doi'].endswith('article-1'))['matchLabel'],found[0]['matchLabel'])

    def test_empirical_calibration_requires_sufficient_explicit_classes(self):
        samples=[{'id':f'p{i}','grade':2,'evidence':.72+i*.01} for i in range(10)]+[{'id':f'n{i}','grade':0,'evidence':.1+i*.01} for i in range(10)]
        self.assertIsNotNone(fit_calibration(samples));self.assertIsNone(fit_calibration(samples[:10]))
        self.assertIsNone(fit_calibration([dict(row,grade=2) for row in samples]))

    def test_long_abstract_is_sent_to_local_embeddings(self):
        discovery_semantics._cache.clear()
        abstract='Background. '*300+'Precise information near the end of the abstract.'
        sent=[]
        def request(req,**kwargs):
            payload=json.loads(req.data);sent.extend(payload['input']);return {'embeddings':[[.1]*8 for _ in payload['input']]}
        with patch.object(discovery_semantics,'local_model',return_value=('http://127.0.0.1:11434/api/embed','fixture-long')),patch.object(discovery_semantics,'request_json',side_effect=request):
            scores,_=discovery_semantics.semantic_scores({},['Question'],[paper('long',abstract=abstract)])
        self.assertIsNotNone(scores);self.assertTrue(any('Precise information near the end' in value for value in sent))


if __name__=='__main__':unittest.main()
