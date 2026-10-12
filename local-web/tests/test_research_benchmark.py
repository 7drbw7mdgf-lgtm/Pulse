import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('research_benchmark',ROOT/'tools/benchmark_research.py')
bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)


class ResearchBenchmarkTests(unittest.TestCase):
    def test_mixed_40_questions_keep_provisional_judgments_out_of_default_evaluation(self):
        doc=json.loads((ROOT/'local-web/pulse-frontend/data/research-benchmark.json').read_text())
        self.assertEqual(len(doc['cases']),40)
        self.assertEqual(sum(case['domain']=='biomedical' for case in doc['cases']),20)
        self.assertEqual(len({case['id'] for case in doc['cases']}),40)
        groups={}
        for case in doc['cases']:
            self.assertNotIn(case['group'],groups);groups[case['group']]=case['split']
        general=next(case for case in doc['cases'] if case['domain']=='general research')
        metrics=bench.evaluate(general,[general['targets'][0]['paper']])
        self.assertIsNone(metrics['nDCG@10']);self.assertEqual(metrics['reviewedLandmarks'],0)
        self.assertEqual(bench.evaluate(general,[general['targets'][0]['paper']],True)['nDCG@10'],1)

    def test_refuting_evidence_is_relevant_and_unjudged_papers_are_not_confirmed_negatives(self):
        case={'targets':[{'paper':{'doi':'10.1234/known'},'grade':1,'reviewState':'human-annotated','landmark':False}]}
        result=bench.evaluate(case,[{'doi':'10.1234/unknown','title':'Unknown'},{'doi':'10.1234/known','title':'Refuting evidence'}])
        self.assertEqual(result['KnownRecall'],1);self.assertEqual(result['Hole@10'],.5)
        self.assertIsNone(result['missedLandmarks'])

    def test_conflicting_doi_is_not_matched_on_title_alone(self):
        self.assertFalse(bench.matches({'title':'Same title','doi':'10.1234/one'},{'title':'Same title','doi':'10.1234/two'}))

    def test_seed_target_leakage_is_rejected_before_search(self):
        row=bench.live_case({'id':'one','seeds':[{'doi':'10.1234/one'}],
                            'targets':[{'paper':{'doi':'10.1234/one'}}]})
        self.assertIn('cannot also be a judged target',row['error']);self.assertEqual(row['seconds'],0)

    def test_insufficient_or_empty_dbef_evidence_never_adopts_a_policy(self):
        doc={'cases':[{'id':'one','split':'train','targets':[]}]}
        result=bench.tune(doc,[{'caseId':'one','pool':{'candidates':{}}}])
        self.assertFalse(result['adopted']);self.assertEqual(result['eligibleCases'],0)


if __name__=='__main__':unittest.main()
