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
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as hybrid,foundational_support
from pulse_core.cocitation_discovery import fetch_cocitation_branch
from pulse_source_health import ProviderCooldown
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
                 'branches':{'citationGraph':False,'citationNetwork':True,'citationCoCitation':False,'semanticSearch':False,'lexicalSearch':False}}
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


class DBEFScalingAndMissingTests(unittest.TestCase):
    def test_three_states_are_reported_without_adding_zero_overlap_to_top_k(self):
        seed=scoring.SeedPaper('S','Retrieval methods','',['R'])
        candidates=[scoring.CandidatePaper('yes','Methods','',['R'],None),
                    scoring.CandidatePaper('zero','Other','',['X'],None),
                    scoring.CandidatePaper('count-known','Other','',[],None,20),
                    scoring.CandidatePaper('unknown','Other','',[],None)]
        ranked,diag=scoring.score_and_rank_candidates(candidates,[seed],{}, {})
        self.assertEqual([r.paper.paper_id for r in ranked],['yes'])
        self.assertEqual(diag['network_status_ids'],{'assessed_overlap':['yes'],'assessed_zero':['zero','count-known'],'unassessed':['unknown']})

    def test_seed_anchor_weak_saturation_and_high_specificity_overlap(self):
        seed=scoring.SeedPaper('S','Retrieval','',[str(i) for i in range(40)])
        scale=scoring.seed_scale([seed],{str(i):10 for i in range(40)})
        self.assertAlmostEqual(scoring.saturate_score(scale['s1'],scale),.15)
        self.assertLessEqual(scoring.saturate_score(scale['s1'],scale),.20)
        self.assertGreaterEqual(scoring.saturate_score(8*10/math.sqrt(40+15),scale),.6)
        self.assertEqual(scale['inputs']['velocityFactor'],1)

    def test_actual_weak_and_eight_specific_reference_scores_use_the_seed_scale(self):
        seed=scoring.SeedPaper('S','Scientific search relevance','Document retrieval',[str(i) for i in range(16)],reference_count=40)
        texts={str(i):('Scientific search relevance','Document retrieval') for i in range(16)}
        counts={str(i):10 for i in range(16)};counts['0']=1000000
        weak=scoring.CandidatePaper('weak','Generic geological materials','Unrelated',['0'],None,40)
        strong=scoring.CandidatePaper('strong',seed.title,seed.abstract,[str(i) for i in range(1,9)],None,40)
        found,diag=scoring.score_and_rank_candidates([weak,strong],[seed],counts,texts,stable_seed_calibration=True)
        scores={row.paper.paper_id:scoring.saturate_score(row.score,diag['scale']) for row in found}
        self.assertLessEqual(scores['weak'],.20);self.assertGreaterEqual(scores['strong'],.6)

    def test_adding_a_weak_candidate_cannot_recalibrate_existing_scores(self):
        seed=scoring.SeedPaper('S','Scientific document retrieval','Semantic indexing',['R','Q'],reference_count=40)
        texts={'R':('Scientific retrieval','Semantic indexing'),'Q':('Document search','Research')}
        a=scoring.CandidatePaper('A','Scientific document retrieval','Semantic indexing',['R','Q'],None,40)
        weak=scoring.CandidatePaper('B','Ocean sediment','Mineral chemistry',['R'],None,100)
        first,d1=scoring.score_and_rank_candidates([a],[seed],{'R':20,'Q':50},texts,stable_seed_calibration=True)
        second,d2=scoring.score_and_rank_candidates([a,weak],[seed],{'R':20,'Q':50},texts,stable_seed_calibration=True)
        other=next(row for row in second if row.paper.paper_id=='A')
        self.assertEqual(d1['scale'],d2['scale']);self.assertEqual(first[0].score,other.score)
        self.assertEqual(scoring.saturate_score(first[0].score,d1['scale']),scoring.saturate_score(other.score,d2['scale']))

    def test_default_median_imputation_differs_from_assessed_zero(self):
        rows=[{'title':'Search paper A','doi':'10.1234/paper-a','networkSimilarity':.4},
              {'title':'Search paper B','doi':'10.1234/paper-b','networkSimilarity':0.},
              {'title':'Search paper C','doi':'10.1234/paper-c'}]
        options={'researchQuestion':'Search paper','diversify':False,'foundationalPrior':False,'citationVelocityPrior':False}
        ranked=hybrid({'concepts':rows},[],options);by={p['doi']:p for p in ranked}
        self.assertEqual(options['_networkEvidence']['imputedValue'],.1)
        self.assertTrue(by['10.1234/paper-c']['scoreBreakdown']['graphImputed'])
        self.assertEqual(by['10.1234/paper-c']['scoreBreakdown']['citationEvidence'],.1)
        self.assertEqual(by['10.1234/paper-b']['networkStatus'],'assessed_zero')
        self.assertEqual(by['10.1234/paper-b']['scoreBreakdown']['citationEvidence'],0)
        self.assertIsNone(by['10.1234/paper-c']['networkSimilarity'])

    def test_renormalize_option_divides_only_missing_graph_hybrid_by_point_88(self):
        row={'title':'Search paper','doi':'10.1234/paper-a'}
        options={'researchQuestion':'Search paper','diversify':False,'foundationalPrior':False,'citationVelocityPrior':False}
        zero=hybrid({'concepts':[row]},[],dict(options,impute_missing_graph='zero'))[0]
        renorm=hybrid({'concepts':[row]},[],dict(options,impute_missing_graph='renormalize'))[0]
        self.assertEqual(zero['score'],88);self.assertEqual(renorm['score'],100)
        self.assertAlmostEqual(renorm['scoreBreakdown']['preliminaryScore'],zero['scoreBreakdown']['preliminaryScore']/.88,places=5)
        self.assertTrue(renorm['scoreBreakdown']['graphRenormalized'])
        self.assertFalse(hybrid({'concepts':[{**row,'networkSimilarity':0}]},[],dict(options,impute_missing_graph='renormalize'))[0]['scoreBreakdown']['graphRenormalized'])

    def test_direct_citation_graph_is_real_and_never_imputed(self):
        row={'title':'Search paper','hop':2}
        ranked=hybrid({'citationGraph':[row]},[],{'researchQuestion':'Search paper','impute_missing_graph':'renormalize'})[0]
        self.assertEqual(ranked['scoreBreakdown']['citationEvidence'],.5)
        self.assertFalse(ranked['scoreBreakdown']['graphImputed']);self.assertFalse(ranked['scoreBreakdown']['graphRenormalized'])
        self.assertEqual(ranked['matchStrengthVersion'],'evidence-v5-dbef-seed-scale')

    def test_assessed_zero_information_survives_a_different_retrieval_channel(self):
        from pulse_core.search_limits import SearchResults
        dbef=SearchResults();dbef.network_assessments={'10.1234/paper-a':{'networkStatus':'assessed_zero','networkSimilarity':0.}}
        found=hybrid({'citationNetwork':dbef,'concepts':[{'doi':'10.1234/paper-a','title':'Search paper'}]},[],{})[0]
        self.assertEqual(found['networkStatus'],'assessed_zero');self.assertEqual(found['networkSimilarity'],0)

    def test_seed_reference_fallback_is_batched_once_and_skips_cooldown(self):
        paper={'doi':'10.1234/seed','title':'Search paper'}
        with patch.object(core,'s2_fetch_references',return_value=[{'doi':'10.1234/ref'}]) as refs, \
             patch.object(core,'fetch_json',return_value={'results':[work('W200',doi='https://doi.org/10.1234/ref')]}) as fetch:
            self.assertEqual(retrieval.seed_reference_fallback(paper),['W200']);self.assertEqual(refs.call_count,1)
            self.assertIn('doi%3A',fetch.call_args.args[0])
        with patch('pulse_source_health.check_source',side_effect=ProviderCooldown('Semantic Scholar',60)),patch.object(core,'s2_fetch_references') as refs:
            self.assertEqual(retrieval.seed_reference_fallback(paper),[]);refs.assert_not_called()

    def test_three_citation_channels_execute_in_parallel(self):
        gate=threading.Barrier(3)
        def branch(*args,**kwargs):gate.wait(timeout=2);return []
        payload={'seedPapers':[{'title':'Scientific search'}],'semanticRerank':False,'pairwiseRerank':False,
                 'branches':{'citationGraph':True,'citationNetwork':True,'citationCoCitation':True,'semanticSearch':False,'lexicalSearch':False}}
        with patch.object(core,'load_settings',return_value={}),patch.object(core,'fetch_citation_graph_branch',side_effect=branch), \
             patch.object(discovery,'fetch_citation_network_branch',side_effect=branch), \
             patch('pulse_core.cocitation_discovery.fetch_cocitation_branch',side_effect=branch):
            result=discovery.run_discovery_pipeline(payload)
        self.assertEqual(result['errors'],{});self.assertEqual(set(result['branchesExecuted']),{'citationGraph','citationNetwork','citationCoCitation'})

    def test_cocitation_keeps_early_results_when_a_later_seed_hits_its_budget(self):
        seed=work('W100');citer=work('W500',refs=['W100','W200'])
        with patch.object(core,'openalex_work_for_paper',side_effect=[seed,DiscoveryBudgetExceeded()]), \
             patch.object(core,'openalex_citing_works',return_value=[citer]), \
             patch.object(core,'fetch_json',return_value={'results':[work('W200')]}):
            result=fetch_cocitation_branch([{'title':'First'},{'title':'Second'}])
        self.assertEqual(len(result),1);self.assertEqual(result.notices[0]['code'],'cocitation-limit')

    def test_cocitation_deduplicates_the_same_citing_paper_across_seeds(self):
        citer=work('W500',refs=['W100','W101','W200'])
        with patch.object(core,'openalex_work_for_paper',side_effect=[work('W100'),work('W101')]), \
             patch.object(core,'openalex_citing_works',return_value=[citer,citer]), \
             patch.object(core,'fetch_json',return_value={'results':[work('W200')]}):
            result=fetch_cocitation_branch([{'title':'First'},{'title':'Second'}])
        self.assertEqual(result[0]['coCitationCount'],1)
        self.assertEqual(result[0]['retrievalEvidence'][0]['seedIndices'],[0,1])

    def test_graph_configuration_validates_and_custom_shrink_changes_only_imputation(self):
        from pulse_core.concept_search import validate_discovery_request
        with self.assertRaises(core.ClientError):validate_discovery_request({'searchMode':'concept','query':'Search','impute_missing_graph':'unsupported'})
        with self.assertRaises(core.ClientError):validate_discovery_request({'searchMode':'concept','query':'Search','graph_imputation_shrink':2})
        options={'researchQuestion':'Search','graph_imputation_shrink':.25}
        hybrid({'concepts':[{'title':'Search A','doi':'10.1234/known','networkSimilarity':.8},{'title':'Search B','doi':'10.1234/unknown'}]},[],options)
        self.assertEqual(options['_networkEvidence']['imputedValue'],.2)

    def test_cocitation_has_its_own_budget_batches_and_foundational_evidence(self):
        seed=work('W100',refs=['W1']);citing=work('W500',refs=['W100','W200'])
        REQUEST_CONTEXT.deadline=50
        def lookup(url,**kwargs):
            self.assertLessEqual(REQUEST_CONTEXT.deadline,time.monotonic()+8)
            self.assertIn('openalex_id%3AW200',url)
            return {'results':[work('W200',cited_by_count=500)]}
        try:
            with patch.object(core,'openalex_work_for_paper',return_value=seed),patch.object(core,'openalex_citing_works',return_value=[citing]),patch.object(core,'fetch_json',side_effect=lookup):
                # Use a future parent deadline; the branch restores it exactly.
                REQUEST_CONTEXT.deadline=time.monotonic()+50;prior=REQUEST_CONTEXT.deadline
                found=fetch_cocitation_branch([{'title':'Search paper'}])
                self.assertEqual(REQUEST_CONTEXT.deadline,prior)
            self.assertEqual(found[0]['subType'],'Co-citation');self.assertGreater(foundational_support(found[0],.8),0)
            self.assertEqual(found[0]['retrievalEvidence'][0]['channel'],'citationCoCitation')
        finally:REQUEST_CONTEXT.deadline=None


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
