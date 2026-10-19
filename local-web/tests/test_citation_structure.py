import unittest
from unittest.mock import patch
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_core.ranking_evidence import citation_structure
from pulse_core.search_merge import merge_search_records


class CitationStructureTests(unittest.TestCase):
    def setUp(self):
        self.seed = {'doi':'10.1234/seed', 'title':'Vesicle signalling', 'citationCount':100,
                     'referenceIds':['W'+str(i) for i in range(1, 21)]}

    def paper(self, name, **extra):
        return dict(title=name, doi='10.1234/'+name, citationCount=100, **extra)

    def test_many_shared_references_win_with_identical_text_and_neural_scores(self):
        rows = [self.paper('one', referenceIds=['W1','W90']),
                self.paper('many', referenceIds=['W'+str(i) for i in range(1, 9)])]
        with patch('pulse_core.pipeline_ranking.bm25_scores', return_value=[.5,.5]):
            result = rank({'lexicalConceptual':rows}, [self.seed], {'diversify':False,
                '_pairwiseReranker':lambda queries, records:([.5]*len(records),'test')})
        self.assertEqual(result[0]['doi'], '10.1234/many')
        self.assertEqual(result[0]['citationStructure']['sharedReferences'],8)
        self.assertGreater(result[0]['scoreBreakdown']['citationStructureBonus'],0)
        self.assertIn('shared-references', [item['kind'] for item in result[0]['whyFound']])

    def test_co_citation_is_degree_normalized_not_a_popularity_bonus(self):
        specific = self.paper('specific', coCitationCount=8)
        generic = dict(self.paper('generic', coCitationCount=8), citationCount=100000)
        strengths = citation_structure([specific,generic], [self.seed])
        self.assertGreater(strengths[0]['strength'],strengths[1]['strength'])
        self.assertEqual(citation_structure([dict(generic,coCitationCount=0)],[self.seed])[0]['strength'],0)

    def test_duplicate_reference_ids_and_duplicate_seeds_do_not_inflate_coupling(self):
        row = self.paper('shared',referenceIds=['W1','https://openalex.org/W1','W2'])
        one = citation_structure([row],[self.seed])[0]
        two = citation_structure([row],[self.seed,self.seed])[0]
        self.assertEqual(one['sharedReferences'],2)
        self.assertEqual(one['sharedReferenceSimilarity'],two['sharedReferenceSimilarity'])

    def test_common_references_have_less_influence_than_specific_references(self):
        common = self.paper('common',referenceIds=['W1','W2'])
        rare = self.paper('rare',referenceIds=['W3','W4'])
        background = [self.paper('other'+str(i),referenceIds=['W1','W2']) for i in range(12)]
        result = citation_structure([common,rare,*background],[self.seed])
        self.assertGreater(result[1]['strength'], result[0]['strength'])

    def test_rejected_paper_receives_no_new_structural_or_backward_bonus(self):
        row = self.paper('rejected',referenceIds=['W1','W2'],
                         retrievalEvidence=[{'channel':'citations:0:backward','rank':1}])
        with patch('pulse_core.pipeline_ranking.bm25_scores',return_value=[.5]):
            result=rank({'citationGraph':[row]},[self.seed],{'relevanceFeedback':[{'paper':row,'grade':0}]})[0]
        self.assertEqual(result['scoreBreakdown']['citationStructureBonus'],0)
        self.assertEqual(result['scoreBreakdown']['backwardCitationBonus'],0)

    def test_merging_sources_retains_the_full_reference_union_and_largest_co_count(self):
        result=merge_search_records([self.paper('shared',referenceIds=['W1'],coCitationCount=2),
                                    self.paper('shared',referenceIds=['W1','W2'],coCitationCount=6)])[0]
        self.assertEqual(result['referenceIds'],['W1','W2'])
        self.assertEqual(result['coCitationCount'],6)

    def test_author_history_is_conditional_and_does_not_hide_unrelated_candidates(self):
        rows=[self.paper('unrelated',retrievalEvidence=[{'channel':'author:0:last','rank':1}]),
              self.paper('topical',retrievalEvidence=[{'channel':'concepts:0','rank':1}])]
        with patch('pulse_core.pipeline_ranking.bm25_scores',return_value=[0,.5]):
            result=rank({'authorTrajectory':rows[:1],'concepts':rows[1:]},[self.seed],{'diversify':False})
        self.assertEqual(result[0]['doi'],'10.1234/topical')
        self.assertEqual(len(result),2)
        self.assertEqual(result[1]['scoreBreakdown']['fusion'],0)

    def test_first_and_senior_author_history_are_not_counted_as_independent_votes(self):
        row=self.paper('author',retrievalEvidence=[{'channel':'author:0:first','rank':1}])
        other=self.paper('other',retrievalEvidence=[{'channel':'concepts:0','rank':1}])
        options={'diversify':False,'citationStructureWeight':0,'backwardCitationWeight':0}
        with patch('pulse_core.pipeline_ranking.bm25_scores',return_value=[.5,.5]):
            once=rank({'authorTrajectory':[row],'concepts':[other]},[self.seed],options.copy())
            twice=rank({'authorTrajectory':[dict(row,retrievalEvidence=row['retrievalEvidence']+[{'channel':'author:0:last','rank':1}])],'concepts':[other]},[self.seed],options.copy())
        self.assertEqual([(p['doi'],p['score']) for p in once],[(p['doi'],p['score']) for p in twice])
