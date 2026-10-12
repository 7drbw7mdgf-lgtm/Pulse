#!/usr/bin/env python3
"""Labelled ranking evaluation with optional offline pairwise ranking."""
import argparse
import copy
import json
import math
import statistics
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local-web'/'pulse-backend'))
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates, bm25_scores
from pulse_core.discovery_crossencoder import crossencoder_scores
from pulse_core.metadata_utils import title_overlap_score
from pulse_core.doi_utils import normalize_doi


def identity(paper):
    return str(paper.get('benchmarkId') or '') or normalize_doi(paper.get('doi')).lower() or paper.get('title') or ''


def metrics(ranked, qrels):
    ids=list(dict.fromkeys(identity(paper) for paper in ranked))
    relevant={key for key,grade in qrels.items() if grade>0}
    recall=len(set(ids[:50])&relevant)/len(relevant) if relevant else 0
    def dcg(grades): return sum((2**grade-1)/math.log2(rank+2) for rank,grade in enumerate(grades))
    ideal=dcg(sorted(qrels.values(),reverse=True)[:10])
    ndcg=dcg([qrels.get(key,0) for key in ids[:10]])/ideal if ideal else 0
    first=next((1/(index+1) for index,key in enumerate(ids[:10]) if key in relevant),0)
    judged=[key for key in ids[:10] if key in qrels]
    return {'Recall@50':round(recall,4),'nDCG@10':round(ndcg,4),'MRR@10':round(first,4),
            'JudgedPrecision@10':round(sum(qrels[key]>0 for key in judged)/len(judged),4) if judged else None,
            'JudgedCoverage@10':round(len(judged)/max(1,min(10,len(ids))),4)}


def candidates_for_case(document, case):
    if 'candidateIds' not in case: return copy.deepcopy(case['candidates'])
    corpus={identity(p):p for p in document['corpus']}
    return {'lexicalConceptual': [dict(corpus[key],retrievalEvidence=[{'channel':'concepts:question','rank':rank,'provider':'SciFact'}]) for rank,key in enumerate(case['candidateIds'],1)]}


def evaluate(document, pairwise=False, maximum=None):
    results=[]
    for index,case in enumerate(document['cases'][:maximum]):
        qrels={normalize_doi(key).lower() or key:grade for key,grade in case['qrels'].items()}
        candidates=candidates_for_case(document,case)
        all_papers=[p for rows in candidates.values() for p in rows]
        seed_titles=' '.join(p.get('title','') for p in case['seeds'])
        query=case.get('question') or seed_titles
        baseline=sorted(all_papers,key=lambda p:title_overlap_score(query,p.get('title','')),reverse=True)
        lexical_scores=bm25_scores(all_papers,[query])
        lexical=[all_papers[i] for i in sorted(range(len(all_papers)),key=lambda i:-lexical_scores[i])]
        options={'researchQuestion':case.get('question',''),'limit':500,'diversify':True}
        if pairwise: options['_pairwiseReranker']=lambda queries,records:crossencoder_scores({},queries,records)
        started=time.monotonic()
        ranked=merge_and_rank_pipeline_candidates(candidates,case['seeds'],options)
        relevant={key for key,grade in qrels.items() if grade>0}
        retrieved={identity(p) for p in all_papers}
        results.append({'name':case.get('name',str(index+1)),'judgedOnly':bool(case.get('judgedOnly')),
                        'baseline':metrics(baseline,qrels),'lexical':metrics(lexical,qrels),'hybrid':metrics(ranked,qrels),
                        'candidateRecall':round(len(retrieved & relevant)/max(1,len(relevant)),4),
                        'knownRelevantMissed':sorted(relevant-retrieved),'rankingSeconds':round(time.monotonic()-started,3),
                        'pairwiseApplied':any((p.get('scoreBreakdown') or {}).get('pairwise') is not None for p in ranked),
                        'labels':[{'id':identity(p),'grade':qrels[identity(p)],'evidence':p['matchEvidenceScore'],'mode':'pairwise' if p['scoreBreakdown'].get('pairwise') is not None else 'text'} for p in ranked if identity(p) in qrels],
                        'sourceErrors':case.get('sourceErrors') or {},'providerTimings':case.get('timings') or {}})
    if not results: raise ValueError('The dataset contains no evaluation cases.')
    summary={method:{metric:round(statistics.mean(row[method][metric] for row in results),4) for metric in ('Recall@50','nDCG@10','MRR@10','JudgedCoverage@10')} for method in ('baseline','lexical','hybrid')}
    times=sorted(row['rankingSeconds'] for row in results)
    return {'cases':len(results),'scope':document.get('scope','User-labelled candidates'),
            'semanticRanking':False,'pairwiseRequested':pairwise,'pairwiseCases':sum(row['pairwiseApplied'] for row in results),
            'note':'Known judged relevance only; unjudged papers are not labelled negative. nDCG and recall use the supplied qrels. Live provider recall is not measured by an offline candidate pool.',
            'provenance':document.get('provenance'),'summary':summary,
            'timings':{'medianRankingSeconds':statistics.median(times),'p95RankingSeconds':times[min(len(times)-1,math.ceil(.95*len(times))-1)]},'results':results}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dataset',nargs='?',default=str(Path(__file__).resolve().parents[1]/'benchmarks'/'discovery-synthetic.json'))
    parser.add_argument('--output')
    parser.add_argument('--pairwise',action='store_true')
    parser.add_argument('--cases',type=int)
    args=parser.parse_args()
    report=evaluate(json.loads(Path(args.dataset).read_text()),args.pairwise,args.cases)
    encoded=json.dumps(report,indent=2)
    if args.output: Path(args.output).write_text(encoded+'\n'); print(json.dumps({key:report[key] for key in ('cases','pairwiseCases','summary','timings')},indent=2))
    else: print(encoded)
