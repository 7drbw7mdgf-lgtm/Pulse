import copy
import importlib.util
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-benchmark-tests-'))
path=Path(__file__).resolve().parents[2]/'tools/benchmark_dbef.py'
spec=importlib.util.spec_from_file_location('pulse_dbef_benchmark',path)
benchmark=importlib.util.module_from_spec(spec);spec.loader.exec_module(benchmark)


class BenchmarkTests(unittest.TestCase):
    def test_a_paper_without_a_doi_keeps_its_openalex_identity(self):
        self.assertEqual(benchmark.key({'title':'Known work','openAlexId':'https://openalex.org/W1522293245'}),'w1522293245')
    def test_condensed_ndcg_drops_unknowns_and_bpref_uses_only_judged_negatives(self):
        ranked=[{'benchmarkId':'unknown'} for _ in range(12)]+[{'benchmarkId':'negative'},{'benchmarkId':'a'},{'benchmarkId':'b'}]
        result=benchmark.measure(ranked,['a','b'],[],['negative'])
        self.assertLess(result['nDCG@10'],result['condensedNDCG@10'])
        self.assertEqual(result['bpref'],0)
        perfect=benchmark.measure([{'benchmarkId':'a'},{'benchmarkId':'unknown'},{'benchmarkId':'negative'}],['a'],[],['negative'])
        self.assertEqual(perfect['bpref'],1)
        self.assertIsNone(benchmark.measure([{'benchmarkId':'a'}],['a'],[])['bpref'])

    def test_all_judged_rank_deltas_include_misses_and_beyond_top_ten(self):
        rows=benchmark.rank_deltas({'a':30,'b':None,'c':4},{'a':20,'b':8,'c':None})
        self.assertEqual(rows[0]['delta'],10);self.assertEqual(rows[1]['status'],'entered');self.assertEqual(rows[2]['status'],'left')

    def test_retrieval_channel_evidence_is_scoped_to_each_seed_case(self):
        paper={'benchmarkId':'target','title':'Bicycle lane injury evaluation','doi':'10.1234/target','referenceIds':[]}
        seed={'benchmarkId':'seed','title':'Protected bicycle lanes','referenceIds':['R']}
        base={'seed':'seed','question':'Bicycle lanes','candidateIds':['target'],'relevant':['target'],'landmarks':[]}
        first={**base,'name':'Co-citation','candidateEvidence':{'target':{'retrievalBranches':['citationCoCitation'],
               'retrievalEvidence':[{'channel':'citationCoCitation','subType':'Co-citation','rank':1}],'coCitationSimilarity':.2}}}
        second={**base,'name':'Other question','candidateEvidence':{'target':{'retrievalBranches':['controlledPool'],'retrievalEvidence':[]}}}
        result=benchmark.evaluate({'corpus':[seed,paper],'references':{},'cases':[first,second]})
        self.assertEqual(result['cases'][0]['on']['recallByChannel@50']['citationCoCitation'],1)
        self.assertEqual(result['cases'][1]['on']['recallByChannel@50']['citationCoCitation'],0)

    def test_benchmark_reference_fallback_batches_at_most_100(self):
        import urllib.parse
        corpus={f'10.1234/item-{i}':{'doi':f'10.1234/item-{i}','title':'Known title','referenceIds':[]} for i in range(205)}
        sizes=[]
        def lookup(url,**kwargs):
            params=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query);sizes.append(len(params['filter'][0].split('|')))
            return {'results':[]}
        with patch.object(benchmark,'fetch_json',side_effect=lookup):benchmark.reference_fallback(corpus,[])
        self.assertEqual(sizes,[100,100,5])

    def test_known_relevance_and_landmark_metrics_do_not_hide_misses(self):
        ranked=[{'benchmarkId':'a'}]+[{'benchmarkId':str(i)} for i in range(55)]+[{'benchmarkId':'b'}]
        metrics=benchmark.measure(ranked,['a','b'],['a','b'])
        self.assertEqual(metrics['KnownRelevantRecall@50'],.5)
        self.assertEqual(metrics['KnownRelevantHits@20'],1)
        self.assertEqual(metrics['LandmarkHits@50'],1)
        self.assertEqual(metrics['missedLandmarks'],['b'])
        self.assertAlmostEqual(metrics['nDCG@10'],round(3/(3+3/math.log2(3)),4))

    def test_ablation_uses_an_identical_frozen_pool_without_mutating_it(self):
        paper={'benchmarkId':'a','title':'Bicycle lane injury evaluation','abstract':'Cycling safety','referenceIds':['R'],'year':'2020'}
        seed={'benchmarkId':'seed','title':'Protected bicycle lanes','abstract':'Cycling safety','referenceIds':['R']}
        doc={'corpus':[seed,paper,{'benchmarkId':'b','title':'Ocean sediment chemistry','year':'2020','referenceIds':[]}],
             'references':{'R':{'title':'Cycling safety','count':10}},'cases':[{'name':'Transport','seed':'seed','question':'Bicycle lanes cycling safety','candidateIds':['a','b'],'relevant':['a'],'landmarks':['a']} ]}
        original=copy.deepcopy(doc);report=benchmark.evaluate(doc)
        self.assertEqual(doc,original)
        self.assertEqual(report['cases'][0]['candidateCount'],2)
        self.assertEqual(report['cases'][0]['off']['dbefScoredCandidates'],0)
        self.assertEqual(report['cases'][0]['on']['dbefScoredCandidates'],1)
        self.assertEqual(report['cases'][0]['on']['KnownRelevantRecall@50'],1)
        self.assertEqual(report,benchmark.evaluate(doc),'Frozen inputs produce identical reports, without volatile ranking timings')
        self.assertIn('beforeToAfter',report['cases'][0]['rankDeltas'])
        self.assertEqual(report['cases'][0]['networkStatusCounts']['unassessed'],1)


if __name__=='__main__':unittest.main()
