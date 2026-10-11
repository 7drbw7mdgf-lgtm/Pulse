import copy
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-quality-test-'))
from pulse_core.discovery_queries import build_query_plan, search_query_plan, provider_query
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank, normalized_reference_similarity, balanced_frontier
from pulse_core.paper_identity import confident_candidate
from pulse_core import discovery_semantics, s2_client, discovery
from pulse_performance import DiscoveryCancelled

SEED={'title':'Understanding urban transport design','abstract':'Protected bicycle lanes reduce intersection injuries','authors':['Ada Brooks'],'year':'2024'}
def paper(title='Outcomes of safer travel',abstract='Protected bicycle lanes reduce intersection injuries',doi='10.1234/result',**kwargs):
    return dict(title=title,abstract=abstract,doi=doi,authors=['Ada Brooks'],year='2024',**kwargs)

class DiscoveryQualityTests(unittest.TestCase):
    def test_queries_cover_each_seed_abstract_question_and_defined_acronym(self):
        plan=build_query_plan([dict(SEED,paperKeywords=['bicycle lanes']),{'title':'Information retrieval evaluation','abstract':'Information retrieval (IR) ranks documents'}],question='How can road safety be improved?')
        self.assertEqual(plan[0]['kind'],'question')
        self.assertEqual({q['seedIndex'] for q in plan if q['kind']=='seed'},{0,1})
        self.assertTrue(any('bicycle lanes' in q['text'] for q in plan))
        self.assertTrue(any('IR' in q['text'] or 'document search' in q['text'] for q in plan))
        self.assertNotIn('://',provider_query({'text':'https://evil TITLE:injected','kind':'concepts'},'core'))

    def test_adaptive_broadening_and_rank_evidence_do_not_mutate_sources(self):
        item=paper();calls=[]
        def source(query,limit): calls.append(query);return [item]
        result=search_query_plan(build_query_plan([SEED]),'semanticScholar',source,100)
        self.assertGreater(len(calls),1)
        self.assertTrue(all(e['rank']==1 for e in result[0]['retrievalEvidence']))
        self.assertNotIn('retrievalEvidence',item)

    def test_abstract_relevance_beats_superficial_title_and_popularity(self):
        irrelevant=paper(SEED['title']+' commentary','An unrelated historical catalogue',doi='10.1234/popular',citationCount=999999)
        relevant=paper()
        found=rank({'concepts':[irrelevant,relevant]},[SEED],{'diversify':False})
        self.assertEqual(found[0]['doi'],relevant['doi'])
        irrelevant['citationCount']=0
        other=rank({'concepts':[irrelevant,relevant]},[SEED],{'diversify':False})
        self.assertEqual(found[0]['score'],other[0]['score'])

    def test_provider_mirrors_do_not_cast_extra_fusion_votes(self):
        record=paper(retrievalEvidence=[{'channel':'concepts:q1','provider':'one','rank':2}])
        other=copy.deepcopy(record);other['retrievalEvidence'][0]['provider']='two'
        one=rank({'one':[record]},[SEED],{})[0]
        two=rank({'one':[record],'two':[other]},[SEED],{})[0]
        self.assertEqual(one['scoreBreakdown']['fusion'],two['scoreBreakdown']['fusion'])
        self.assertEqual(one['score'],two['score'])
        self.assertEqual(len(two['retrievalEvidence']),2)

    def test_strict_exclusion_and_soft_avoid_are_distinct_and_phrase_based(self):
        record=paper(abstract='Protected bicycle lanes and financial review')
        self.assertEqual(len(rank({'one':[record]},[SEED],{'excludeKeywords':['financial review']})),1)
        self.assertEqual(rank({'one':[record]},[SEED],{'strictExcludeKeywords':['financial review']}),[])
        self.assertEqual(len(rank({'one':[record]},[SEED],{'strictExcludeKeywords':['finance']})),1)

    def test_identity_rejects_wrong_first_hit_conflicts_and_ambiguity(self):
        wrong=paper(title='A different unrelated transport system',doi='10.1234/wrong')
        correct=dict(SEED,s2PaperId='correct',doi='10.1234/right')
        self.assertEqual(confident_candidate(SEED,[wrong,correct]),correct)
        self.assertIsNone(confident_candidate(SEED,[dict(correct,authors=['Bob Jones'])]))
        self.assertIsNone(confident_candidate(SEED,[correct,dict(correct,doi='10.1234/other')]))
        with patch.object(s2_client,'s2_paper_search',return_value=[wrong,correct]):
            self.assertEqual(s2_client.s2_paper_id_for_paper(SEED),'correct')

    def test_exact_doi_has_to_match_returned_identity(self):
        self.assertIsNone(confident_candidate(dict(SEED,doi='10.1234/expected'),[dict(SEED,doi='10.1234/other')]))

    def test_normalised_references_and_balanced_frontier(self):
        self.assertGreater(normalized_reference_similarity(4,10,10),normalized_reference_similarity(4,10,100))
        papers=[paper(doi=f'10.1234/{i}') for i in range(6)]
        papers[-1].update(year='2026',citationCount=0)
        self.assertIn(papers[-1],balanced_frontier(papers,[SEED]))

    def test_versions_group_only_supported_preprint_published_pairs(self):
        first=paper(publicationType='preprint',doi='10.1234/preprint')
        second=paper(publicationType='journal-article',doi='10.1234/published')
        found=rank({'one':[first,second]},[SEED],{})
        self.assertEqual(len(found),1);self.assertEqual(found[0]['doi'],second['doi'])
        self.assertEqual(found[0]['relatedVersions'][0]['doi'],first['doi'])
        first['publicationType']='journal-article'
        self.assertEqual(len(rank({'one':[first,second]},[SEED],{})),2)

    def test_neural_reranker_uses_full_query_and_abstract_and_changes_order(self):
        candidates=[paper('A catalogue','irrelevant',doi='10.1234/one'),paper(doi='10.1234/two')]
        captured=[]
        def reranker(queries,records):
            captured.extend(queries)
            return [1.0 if p['doi'].endswith('two') else 0 for p in records],'local semantic enabled'
        found=rank({'one':candidates},[SEED],{'researchQuestion':'Safer cycling','_semanticReranker':reranker,'diversify':False})
        self.assertEqual(found[0]['doi'],'10.1234/two');self.assertIn(SEED['abstract'],captured[1])
        self.assertIsNotNone(found[0]['scoreBreakdown']['semantic'])

    def test_local_embeddings_validation_fallback_and_cancellation(self):
        with patch.object(discovery_semantics,'local_model',return_value=('http://127.0.0.1:11434/api/embed','fixture')):
            with patch.object(discovery_semantics,'request_json',return_value={'embeddings':[[float('nan')]*8]}):
                scores,notice=discovery_semantics.semantic_scores({},['query'],[paper()])
                self.assertIsNone(scores)
            event=threading.Event();event.set()
            with self.assertRaises(DiscoveryCancelled):discovery_semantics.semantic_scores({},['query'],[paper()],event)

    def test_diversification_preserves_explicit_rank_and_metadata(self):
        records=[paper(doi=f'10.1234/{i}',title=f'Protected bicycle lanes {i}') for i in range(10)]
        records.append(paper(title='Safer intersection design',doi='10.1234/diverse',abstract='Intersection injuries are reduced by protected infrastructure'))
        original=copy.deepcopy(records)
        found=rank({'one':records},[SEED],{'diversify':True})
        self.assertEqual([p['rank'] for p in found],list(range(1,len(found)+1)))
        self.assertEqual(records,original)

    def test_citation_retrieval_includes_recent_and_established_streams(self):
        calls=[]
        def fetch(work_filter,limit,sort='cited_by_count:desc'):
            calls.append(sort)
            return [{'id':f'W{1000+i if sort.startswith("publication") else 2000+i}'} for i in range(limit)]
        with patch.object(discovery,'openalex_discovery_works',side_effect=fetch):
            found=discovery.openalex_citing_works('W42',20)
        self.assertEqual(len(found),20)
        self.assertEqual(set(calls),{'publication_date:desc','cited_by_count:desc'})

    def test_research_question_takes_priority_over_other_seed_topics(self):
        seed=paper(title='Urban transport planning',abstract='Bus route frequency and bicycle lanes in cities')
        bike=paper(title='Safer bicycle lanes',abstract='Bicycle lanes reduce cyclist injuries',doi='10.1234/bike')
        bus=paper(title='Urban transport planning overview',abstract='Urban transport bus routes and service frequency',doi='10.1234/bus')
        found=rank({'concepts':[bus,bike]},[seed],{'researchQuestion':'Bicycle lanes reduce cyclist injuries','diversify':False})
        self.assertEqual(found[0]['doi'],bike['doi'])

if __name__=='__main__':unittest.main()
