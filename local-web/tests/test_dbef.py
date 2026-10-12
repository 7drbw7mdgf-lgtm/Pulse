import datetime
import io
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-dbef-test-'))
import pulse_core as core
from pulse_core import dbef_content as scoring, dbef_discovery as retrieval, discovery
from pulse_core.discovery_queries import search_query_plan
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as hybrid
from pulse_core.discovery_matches import independent_channel_count
from pulse_core.discovery_bridges import apply_bridges
from pulse_performance import REQUEST_CONTEXT, DiscoveryCancelled, DiscoveryBudgetExceeded, request_json


class DBEFScoringTests(unittest.TestCase):
    def test_supplied_equation_in_citation_only_mode(self):
        seed=scoring.SeedPaper('S','Bicycle intersection safety','Urban transport',['R1','R2'])
        candidate=scoring.CandidatePaper('C','Bicycle safety','Urban transport',['R1','R2','other'],4)
        ranked,_=scoring.score_and_rank_candidates([candidate],[seed],{'R1':10,'R2':100},{},rho=1,lam=1,n_corpus=10000)
        expected=(math.log1p(10000/11)+math.log1p(10000/101))/math.sqrt(3+15)*(1+.5*math.log1p(4))
        self.assertAlmostEqual(ranked[0].score,expected,places=12)

    def test_specific_on_topic_references_outweigh_generic_methods(self):
        seeds=[scoring.SeedPaper('S','Protected bicycle lanes reduce intersection injuries','Transport safety',['methods','lanes'])]
        texts={'methods':('Generic statistical methods','Analysis of common measurements'),
               'lanes':('Protected bicycle lanes reduce intersection injuries','Transport safety')}
        papers=[scoring.CandidatePaper('relevant',*texts['lanes'],['lanes'],1),
                scoring.CandidatePaper('generic',*texts['methods'],['methods'],1)]
        ranked,diag=scoring.score_and_rank_candidates(papers,seeds,{'methods':50000,'lanes':20},texts)
        self.assertEqual(ranked[0].paper.paper_id,'relevant')
        self.assertGreater(diag['weights']['lanes'],diag['weights']['methods'])
        self.assertGreater(ranked[0].content_factor,ranked[1].content_factor)

    def test_known_full_bibliography_length_is_used_for_saturation(self):
        seed=scoring.SeedPaper('S','Transport safety','',['R'])
        papers=[scoring.CandidatePaper('short','Transport safety','',['R'],None),
                scoring.CandidatePaper('long','Transport safety','',['R'],None,300)]
        found,_=scoring.score_and_rank_candidates(papers,[seed],{}, {})
        self.assertEqual(found[0].paper.paper_id,'short')
        self.assertAlmostEqual(found[1].saturation,1/math.sqrt(315))

    def test_percentiles_missing_content_and_compound_identifiers(self):
        for actual,expected in zip(scoring.calibrate([0,.1,.2,float('nan')]),[0,.5,1,.5]):
            self.assertAlmostEqual(actual,expected,places=12)
        self.assertEqual(scoring.calibrate([float('nan')]),[1])
        self.assertEqual(scoring.bio_tokenise('TLR4 IL-8 NF-κB Caco-2 networks'),['tlr4','il-8','nf-kb','caco-2','caco','network'])

    def test_stage_one_bound_reports_an_unproven_shortlist(self):
        seed=scoring.SeedPaper('S','Bicycle lanes','',['R'])
        papers=[scoring.CandidatePaper(str(i),'Unrelated mineral samples','',['R'],i+1) for i in range(8)]
        found,diag=scoring.score_and_rank_candidates(papers,[seed],{}, {},top_k=1,stage1_k=2,calibration='none')
        self.assertFalse(diag['exact'])
        all_found,all_diag=scoring.score_and_rank_candidates(papers,[seed],{}, {},top_k=1,stage1_k=8,calibration='none')
        self.assertTrue(all_diag['exact'])
        self.assertEqual(found[0].paper.paper_id,all_found[0].paper.paper_id)

    def test_cancellation_applies_to_cpu_scoring(self):
        def cancel(): raise DiscoveryCancelled()
        with self.assertRaises(DiscoveryCancelled):
            scoring.score_and_rank_candidates([scoring.CandidatePaper('C','Transport','',['R'],None)],
                [scoring.SeedPaper('S','Transport','',['R'])],{}, {},check=cancel)


def work(ident,title='Protected bicycle lanes reduce intersection injuries',refs=None,**fields):
    return dict(id='https://openalex.org/'+ident,title=title,publication_year=2020,
                referenced_works=['https://openalex.org/'+ref for ref in (refs or [])],
                abstract_inverted_index={'Transport':[0],'safety':[1]},**fields)


class DBEFRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.seed=work('W100',refs=['W1','W2','W3','W4','W5'],primary_topic={'field':{'id':'https://openalex.org/fields/17'}})
        self.refs=[work('W'+str(i),'Generic statistical methods',cited_by_count=50000) for i in range(1,5)]
        self.refs.append(work('W5',cited_by_count=20))
        self.candidates=[work('W200',refs=['W5'],counts_by_year=[{'year':2025,'cited_by_count':3}]),
                         work('W201','Statistical measurements',refs=['W1'],cited_by_count=0)]

    def tearDown(self):
        REQUEST_CONTEXT.deadline=None
        REQUEST_CONTEXT.cancel_event=None

    def metadata(self,url,**kwargs):
        return {'works_count':2000000} if '/fields/' in url else {'results':self.refs}

    def test_new_route_replaces_both_legacy_searches_and_deduplicates_candidates(self):
        with patch.object(core,'openalex_work_for_paper',return_value=self.seed), \
             patch.object(core,'fetch_json',side_effect=self.metadata), \
             patch.object(core,'openalex_discovery_works',return_value=self.candidates) as retrieve, \
             patch.object(discovery,'openalex_citing_works') as old_cocitations:
            found=discovery.fetch_citation_network_branch([{'title':self.seed['title']}],limit=200)
        old_cocitations.assert_not_called()
        self.assertEqual(len(found),2)
        self.assertTrue(any('W5' in call.args[0] for call in retrieve.call_args_list),'The fifth, on-topic reference must be a pivot')
        self.assertTrue(all(call.args[0].startswith('cites:') for call in retrieve.call_args_list))
        self.assertEqual(found[0]['rankingMethod'],'DBEF-content')
        self.assertEqual(found[0]['openAlexId'],'https://openalex.org/W200')
        self.assertIsNone(found[0]['citationCount'],'Unknown citations are not overwritten by DBEF weighting defaults')
        self.assertEqual(found.dbef_summary['corpusSizeSource'],'OpenAlex field totals')
        self.assertEqual(found.dbef_summary['corpusSize'],2000000)
        self.assertEqual(found[0]['dbef']['sharedReferenceIds'],['W5'])

    def test_collection_cap_preserves_results_and_restores_parent_deadline(self):
        clock=[0.0]; REQUEST_CONTEXT.deadline=50
        def retrieve(*args,**kwargs):
            self.assertEqual(REQUEST_CONTEXT.deadline,12)
            if clock[0]: raise DiscoveryBudgetExceeded()
            clock[0]=13
            return self.candidates
        with patch.object(retrieval.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(core,'openalex_work_for_paper',return_value=self.seed), \
             patch.object(core,'fetch_json',side_effect=self.metadata), \
             patch.object(core,'openalex_discovery_works',side_effect=retrieve):
            found=retrieval.fetch_dbef_branch([{'title':self.seed['title']}])
        self.assertEqual(len(found),2)
        self.assertFalse(found.warning)
        self.assertEqual(found.notices[0]['code'],'dbef-limit')
        self.assertEqual(REQUEST_CONTEXT.deadline,50)

    def test_missing_seed_resolution_keeps_original_seed_indices(self):
        with patch.object(core,'openalex_work_for_paper',side_effect=[None,self.seed]), \
             patch.object(core,'fetch_json',side_effect=self.metadata), \
             patch.object(core,'openalex_discovery_works',return_value=self.candidates):
            found=retrieval.fetch_dbef_branch([{'title':'Unknown seed'},{'title':self.seed['title']}])
        self.assertEqual(found[0]['dbef']['seedMatches'][0]['seedIndex'],1)

    def test_pipeline_returns_dbef_scores_and_summary_with_no_legacy_search(self):
        payload={'seedPapers':[{'title':self.seed['title']}], 'semanticRerank':False,'pairwiseRerank':False,
                 'branches':{'citationGraph':False,'citationNetwork':True,'semanticSearch':False,'lexicalSearch':False}}
        with patch.object(core,'load_settings',return_value={}), \
             patch.object(core,'openalex_work_for_paper',return_value=self.seed), \
             patch.object(core,'fetch_json',side_effect=self.metadata), \
             patch.object(core,'openalex_discovery_works',return_value=self.candidates), \
             patch.object(discovery,'openalex_citing_works') as legacy:
            result=discovery.run_discovery_pipeline(payload)
        legacy.assert_not_called()
        self.assertEqual(result['errors'],{})
        self.assertEqual(result['dbef']['method'],'DBEF-content')
        self.assertEqual(result['branchesExecuted'],['citationNetwork'])
        self.assertEqual(result['sourceCounts']['citationNetwork'],2)
        self.assertTrue(all(p['scoreBreakdown']['dbef'] for p in result['recommendations']))
        self.assertTrue(all(p['independentChannelCount']==1 for p in result['recommendations']))
        self.assertTrue(all(p['matchLabel']!='Strong match' for p in result['recommendations']))

    def test_missing_annual_data_stays_unknown_and_uses_completed_years(self):
        today=datetime.date(2026,10,12)
        self.assertIsNone(retrieval.recent_velocity({},today))
        self.assertIsNone(retrieval.recent_velocity({'publication_year':2026,'counts_by_year':[{'year':2026,'cited_by_count':30}]},today))
        self.assertEqual(retrieval.recent_velocity({'publication_year':2024,'counts_by_year':[{'year':2024,'cited_by_count':2},{'year':2025,'cited_by_count':8},{'year':2026,'cited_by_count':100}]},today),5)

    def test_dbef_is_one_retrieval_channel_and_avoids_a_second_velocity_bonus(self):
        record={'title':'Protected bicycle lane safety','year':'2020','citationCount':100,
                'dbef':{'normalizedScore':1,'velocityFactor':2},'networkSimilarity':1,
                'retrievalEvidence':[{'channel':'dbef:0','rank':1},{'channel':'dbef:1','rank':1}]}
        self.assertEqual(independent_channel_count(record),1)
        ranked=hybrid({'citationNetwork':[record]},[{'title':'Bicycle lane safety'}],{'diversify':False})
        self.assertEqual(ranked[0]['scoreBreakdown']['citationVelocityPrior'],0)
        self.assertEqual(ranked[0]['scoreBreakdown']['dbef']['velocityFactor'],2)


class RedundantRequestTests(unittest.TestCase):
    def test_equivalent_queries_execute_once_per_provider(self):
        queries=[{'id':'a','text':'Cycle lane safety','kind':'seed'},
                 {'id':'b','text':'cycle  lane safety','kind':'preferred'}]
        def search(text,**kwargs): return [{'title':'Cycle lane safety study'}]
        retrieve=Mock(side_effect=search)
        found=search_query_plan(queries,'semanticScholar',retrieve,100)
        self.assertEqual(retrieve.call_count,1)
        self.assertEqual(found.queries_executed,['a'])
        self.assertEqual(len(found),1)
        self.assertEqual(len(found[0]['retrievalEvidence']),1)

    def test_concurrent_identical_gets_share_io_and_return_independent_records(self):
        import urllib.request
        import pulse_performance as transport
        entered,release=threading.Event(),threading.Event()
        def network(*args,**kwargs):
            entered.set(); release.wait(2); return io.BytesIO(b'{"results":[{"title":"Original"}]}')
        result=[]
        def fetch(): result.append(request_json(urllib.request.Request('https://unit.test/dbef-shared')))
        transport._JSON_CACHE.clear()
        with patch('pulse_performance.urllib.request.urlopen',side_effect=network) as calls:
            first=threading.Thread(target=fetch);first.start();entered.wait(1)
            second=threading.Thread(target=fetch);second.start();time.sleep(.05);release.set()
            first.join(2);second.join(2)
        self.assertEqual(calls.call_count,1)
        self.assertEqual(len(result),2)
        result[0]['results'][0]['title']='Changed'
        self.assertEqual(result[1]['results'][0]['title'],'Original')

    def test_waiting_caller_can_cancel_without_cancelling_request_owner(self):
        import urllib.request
        entered,release,cancel=threading.Event(),threading.Event(),threading.Event()
        def network(*args,**kwargs):
            entered.set();release.wait(2);return io.BytesIO(b'{"ok":true}')
        successes,errors=[],[]
        request=lambda:urllib.request.Request('https://unit.test/dbef-cancel-waiter')
        def owner():successes.append(request_json(request()))
        def waiter():
            REQUEST_CONTEXT.cancel_event=cancel
            try:request_json(request())
            except DiscoveryCancelled:errors.append('cancelled')
        with patch('pulse_performance.urllib.request.urlopen',side_effect=network) as calls:
            first=threading.Thread(target=owner);first.start();entered.wait(1)
            second=threading.Thread(target=waiter);second.start();cancel.set();second.join(1)
            release.set();first.join(2)
        self.assertEqual(errors,['cancelled']);self.assertEqual(successes,[{'ok':True}]);self.assertEqual(calls.call_count,1)


if __name__ == '__main__': unittest.main()
