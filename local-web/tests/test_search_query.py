import unittest
import test_library_save
from pulse_core.search_query import parse_search, matches_search, normalize_search_request, prepared_search
from pulse_core.concept_search import concept_query_plan
from pulse_core.constants import ClientError
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates

class SearchQueryTests(unittest.TestCase):
    def test_phrases_tags_unicode_and_boolean_choice(self):
        r=parse_search('"outer membrane vesicles", biofilm; #immunity tag:"host response"',match='all')
        self.assertEqual(r['keywords'],['outer membrane vesicles','biofilm'])
        self.assertEqual(r['tags'],['immunity','host response']);self.assertEqual(r['match'],'all')
        self.assertEqual(parse_search('biofilm OR vesicles')['match'],'any')
        self.assertEqual(parse_search('β-catenin, #α')['tags'],['α'])
        self.assertFalse(parse_search('How do bacteria form biofilms?')['structured'])
    def test_bad_and_oversized_queries_are_rejected(self):
        for q in ['"not closed','a AND b OR c',','.join('keyword'+str(i) for i in range(13))]:
            with self.subTest(q=q),self.assertRaises(ClientError):parse_search(q)
    def test_all_any_tags_and_phrase_boundaries(self):
        paper={'title':'Outer membrane vesicles mediate biofilm formation','userTags':['Host response']}
        self.assertTrue(matches_search(paper,['outer membrane vesicles','biofilm']))
        self.assertFalse(matches_search(paper,['biofilm','compiler']))
        self.assertTrue(matches_search(paper,['biofilm','compiler'],match='any'))
        self.assertFalse(matches_search(paper,['film']))
        self.assertTrue(matches_search(paper,[],['host response'],local=True))
        self.assertFalse(matches_search(paper,[],['host response'],local=False))
    def test_explicit_modes_and_query_plans(self):
        payload,terms=normalize_search_request({'searchMode':'concept','query':'biofilm, #immunity','rankingMode':'fast'})
        self.assertFalse(payload['semanticRerank']);self.assertFalse(payload['pairwiseRerank']);self.assertFalse(payload['aiTriage'])
        plan=concept_query_plan(prepared_search(terms,payload['query']))
        self.assertEqual(plan[0]['groups'],[['biofilm'],['immunity']])
        terms['match']='any';self.assertEqual(len(concept_query_plan(prepared_search(terms,payload['query']))),2)
    def test_filters_use_metadata_merged_across_sources(self):
        ranked=merge_and_rank_pipeline_candidates({'lexicalSearch':[{'title':'Biofilm formation','doi':'10.1000/merged'}],
            'semanticSearch':[{'title':'Biofilm formation','doi':'10.1000/merged','abstract':'Outer membrane vesicles.'}]},[],
            {'queryKeywords':['biofilm','vesicles'],'queryMatch':'all','limit':20})
        self.assertEqual([r['doi'] for r in ranked],['10.1000/merged'])

    def test_pipeline_filters_every_branch_without_losing_matching_records(self):
        papers=[{'title':'Biofilm formation','doi':'10.1000/yes','abstract':'Outer membrane vesicles'},
                {'title':'Compiler architecture','doi':'10.1000/no'}]
        ranked=merge_and_rank_pipeline_candidates({'lexicalSearch':papers},[],{'queryKeywords':['biofilm','vesicles'],'queryMatch':'all','limit':20})
        self.assertEqual([r['doi'] for r in ranked],['10.1000/yes'])
