import copy
import importlib.util
import math
import os
from pathlib import Path
import tempfile
import unittest

os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-benchmark-tests-'))
path=Path(__file__).resolve().parents[2]/'tools/benchmark_dbef.py'
spec=importlib.util.spec_from_file_location('pulse_dbef_benchmark',path)
benchmark=importlib.util.module_from_spec(spec);spec.loader.exec_module(benchmark)


class BenchmarkTests(unittest.TestCase):
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


if __name__=='__main__':unittest.main()
