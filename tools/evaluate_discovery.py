#!/usr/bin/env python3
"""Offline labelled retrieval evaluation; no network and no model downloads."""
import argparse
import json
import math
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local-web'/'pulse-backend'))
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_core.metadata_utils import title_overlap_score
from pulse_core.doi_utils import normalize_doi


def identity(paper):
    return normalize_doi(paper.get('doi')).lower() or paper.get('title') or ''


def metrics(ranked, qrels):
    ids=list(dict.fromkeys(identity(paper) for paper in ranked))
    relevant={key for key,grade in qrels.items() if grade>0}
    recall=len(set(ids[:50])&relevant)/len(relevant) if relevant else 0
    def dcg(grades): return sum((2**grade-1)/math.log2(rank+2) for rank,grade in enumerate(grades))
    ideal=dcg(sorted(qrels.values(),reverse=True)[:10])
    ndcg=dcg([qrels.get(key,0) for key in ids[:10]])/ideal if ideal else 0
    return {'Recall@50':round(recall,4),'nDCG@10':round(ndcg,4)}


def evaluate(document):
    results=[]
    for index,case in enumerate(document['cases']):
        qrels={normalize_doi(key).lower() or key:grade for key,grade in case['qrels'].items()}
        candidates=case['candidates']
        all_papers=[p for rows in candidates.values() for p in rows]
        seed_titles=' '.join(p.get('title','') for p in case['seeds'])
        baseline=sorted(all_papers,key=lambda p:title_overlap_score(seed_titles,p.get('title','')),reverse=True)
        ranked=merge_and_rank_pipeline_candidates(candidates,case['seeds'],{'researchQuestion':case.get('question',''),'limit':500,'diversify':True})
        results.append({'name':case.get('name',str(index+1)),'judgedOnly':bool(case.get('judgedOnly')),
                        'baseline':metrics(baseline,qrels),'hybrid':metrics(ranked,qrels)})
    summary={method:{metric:round(sum(row[method][metric] for row in results)/len(results),4) for metric in ('Recall@50','nDCG@10')} for method in ('baseline','hybrid')}
    return {'cases':len(results),'scope':document.get('scope','User-labelled candidates'),
            'semanticRanking':False,'note':'Offline candidate-ranking regression only; provider retrieval and unjudged relevant papers are not measured.',
            'summary':summary,'results':results}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dataset',nargs='?',default=str(Path(__file__).resolve().parents[1]/'benchmarks'/'discovery-synthetic.json'))
    parser.add_argument('--output')
    args=parser.parse_args()
    report=evaluate(json.loads(Path(args.dataset).read_text()))
    encoded=json.dumps(report,indent=2)
    if args.output: Path(args.output).write_text(encoded+'\n')
    print(encoded)
