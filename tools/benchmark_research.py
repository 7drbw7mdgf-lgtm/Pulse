#!/usr/bin/env python3
"""Run full discovery, or replay frozen pools, with incomplete judgments explicit."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'local-web/pulse-backend'))
from pulse_core.discovery import run_discovery_pipeline
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_core.discovery_crossencoder import crossencoder_scores
from pulse_core.discovery_semantics import semantic_scores
from pulse_core.doi_utils import normalize_doi
from pulse_core.search_merge import title_key


def trusted(target,include_provisional=False):
    return target.get('reviewState') in {'reviewed','human-annotated'} or include_provisional


def matches(paper,target):
    a=normalize_doi(paper.get('doi')).lower();b=normalize_doi(target.get('doi')).lower()
    if a and b:return a==b or any(normalize_doi(p.get('doi')).lower()==b for p in paper.get('relatedVersions') or [])
    return bool(title_key(paper.get('title'))) and title_key(paper.get('title'))==title_key(target.get('title'))


def evaluate(case,records,include_provisional=False):
    targets=[target for target in case['targets'] if trusted(target,include_provisional)]
    positive=[target for target in targets if target.get('grade',0)>0]
    grades=[];hits=set();unknown=0
    for paper in records:
        identified=[i for i,target in enumerate(targets) if matches(paper,target['paper'])]
        if not identified:grades.append(0);unknown+=1;continue
        grades.append(max(targets[i]['grade'] for i in identified));hits.update(identified)
    ideal=sorted([target['grade'] for target in positive],reverse=True)[:10]
    dcg=lambda values:sum((2**grade-1)/math.log2(i+2) for i,grade in enumerate(values[:10]))
    idcg=dcg(ideal)
    top10=records[:10]
    landmark=[target for target in targets if target.get('landmark') and (target.get('landmarkReviewState')=='reviewed' or include_provisional)]
    misses=[target['paper'] for target in positive if not any(matches(paper,target['paper']) for paper in records)]
    unknown10=sum(not any(matches(paper,target['paper']) for target in targets) for paper in top10)
    return {'nDCG@10':round(dcg(grades)/idcg,4) if idcg else None,
        'KnownPrecision@10':round(sum(grade>0 for grade in grades[:10])/max(1,len(top10)),4) if positive else None,
        'KnownRecall':round((len(positive)-len(misses))/len(positive),4) if positive else None,
        'Hole@10':round(unknown10/max(1,len(top10)),4),'knownMisses':misses,
        'missedLandmarks':[target['paper'] for target in landmark if not any(matches(paper,target['paper']) for paper in records[:50])] if landmark else None,
        'reviewedTargets':len(targets),'reviewedLandmarks':len(landmark),'eligibleForTuning':len(records)>=10 and bool(positive)}


def live_case(case,limit=100,neural=True):
    if any(matches(seed,target['paper']) for seed in case.get('seeds') or [] for target in case['targets']):
        return {'caseId':case['id'],'error':'A benchmark seed cannot also be a judged target. Choose a distinct related paper.','seconds':0,'pool':{}}
    started=time.monotonic();first=[None];pool={}
    def progress(data):
        if first[0] is None and data.get('recommendations'):first[0]=round(time.monotonic()-started,3)
    def capture(rows,seeds,options):pool.update(candidates=copy.deepcopy(rows),seeds=copy.deepcopy(seeds),options={key:copy.deepcopy(value) for key,value in options.items() if not key.startswith('_')})
    payload={'searchMode':'concept','query':case['question'],'limit':limit,'aiTriage':False,
        'semanticRerank':neural,'pairwiseRerank':neural,'searchSources':{'semanticScholar':True,'europePmc':True,'core':True}}
    if case.get('seeds'):payload.update(searchMode='related',seedPapers=case['seeds'],researchQuestion=case['question'])
    try:
        result=run_discovery_pipeline(payload,on_progress=progress,on_candidates=capture)
        return {'caseId':case['id'],'result':result,'pool':pool,'timeToFirstResults':first[0],
            'seconds':round(time.monotonic()-started,3),'configuration':payload}
    except Exception as error:return {'caseId':case['id'],'error':type(error).__name__,'seconds':round(time.monotonic()-started,3),'pool':pool}


def replay(row,policy=None,neural=False,settings=None):
    pool=row['pool'];options=copy.deepcopy(pool['options'])
    if policy is not None:options['dbefPolicy']=policy
    if neural:
        options['_semanticReranker']=lambda queries,records:semantic_scores(settings or {},queries,records,focus_first=bool(options.get('researchQuestion')))
        options['_pairwiseReranker']=lambda queries,records:crossencoder_scores(settings or {},queries,records)
    started=time.monotonic();records=merge_and_rank_pipeline_candidates(copy.deepcopy(pool['candidates']),pool.get('seeds') or [],options)
    return {'caseId':row['caseId'],'result':{'recommendations':records,'timings':options['_rankingTimings']},
            'seconds':round(time.monotonic()-started,3),'pool':pool}


def summarize(doc,rows,include_provisional=False):
    cases={case['id']:case for case in doc['cases']};report=[]
    for row in rows:
        case=cases[row['caseId']];records=(row.get('result') or {}).get('recommendations') or []
        metrics=evaluate(case,records,include_provisional)
        report.append({'caseId':case['id'],'domain':case['domain'],'split':case['split'],'question':case['question'],
            **metrics,'resultCount':len(records),'timeToFirstResults':row.get('timeToFirstResults'),'seconds':row['seconds'],
            'sourceErrors':(row.get('result') or {}).get('errors') or row.get('error'),
            'timings':(row.get('result') or {}).get('timings') or {}})
    averages={metric:round(statistics.mean(case[metric] for case in report if case[metric] is not None),4)
              for metric in ('nDCG@10','KnownPrecision@10','KnownRecall','Hole@10') if any(case[metric] is not None for case in report)}
    return {'formatVersion':1,'cases':report,'means':averages,
        'provenance':doc['provenance'],'includeProvisional':include_provisional,
        'note':'Incomplete judgments: unknown papers are unjudged, not confirmed irrelevant. KnownPrecision is a lower bound. Landmark metrics require reviewed landmark labels. Source outages and empty pools are reported separately. No gold paper is inserted into retrieval.'}


def tune(doc,rows,include_provisional=False):
    definitions={case['id']:case for case in doc['cases']}
    eligible=[row for row in rows if row.get('pool',{}).get('candidates') and
        any(record.get('dbef') for papers in row['pool']['candidates'].values() for record in papers) and
        evaluate(definitions[row['caseId']],(row.get('result') or {}).get('recommendations') or [],include_provisional)['eligibleForTuning']]
    train=[row for row in eligible if definitions[row['caseId']]['split']=='train']
    validation=[row for row in eligible if definitions[row['caseId']]['split']=='validation']
    test=[row for row in eligible if definitions[row['caseId']]['split']=='test']
    if min(len(train),len(validation),len(test))<3:
        return {'adopted':False,'reason':'At least three reviewed DBEF-supported cases per split are required; no policy was learned from missing or unjudged evidence.',
                'eligibleCases':len(eligible),'train':len(train),'validation':len(validation),'test':len(test)}
    def score(group,policy):
        values=[evaluate(definitions[row['caseId']],replay(row,policy)['result']['recommendations'],include_provisional)['nDCG@10'] for row in group]
        return statistics.mean(value for value in values if value is not None)
    policies=[{'coveragePower':power,'overlapScale':scale} for power in (.5,1,1.5) for scale in (2,4,8)]
    chosen=max(policies,key=lambda policy:score(train,policy))
    baseline={'coveragePower':1,'overlapScale':4}
    baseline_validation=score(validation,baseline);validation_score=score(validation,chosen)
    improved=validation_score>baseline_validation+.001
    test_baseline=score(test,baseline);test_score=score(test,chosen)
    return {'adopted':improved and test_score>=test_baseline and not include_provisional,'provisional':include_provisional,'policy':chosen,
            'validationBaseline':baseline_validation,'validationScore':validation_score,
            'heldOutTestBaseline':test_baseline,'heldOutTestScore':test_score,
            'note':'Choice uses train only; adoption requires a validation gain. Test is evaluated once after selection and is never used for choosing parameters.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--definitions',type=Path,default=ROOT/'local-web/pulse-frontend/data/research-benchmark.json')
    parser.add_argument('--snapshot',type=Path)
    parser.add_argument('--live',action='store_true')
    parser.add_argument('--no-neural',action='store_true')
    parser.add_argument('--include-provisional',action='store_true')
    parser.add_argument('--cases',help='Comma-separated case ids; default all 40')
    parser.add_argument('--workers',type=int,default=2)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();doc=json.loads(args.definitions.read_text());cases=doc['cases']
    if args.cases:cases=[case for case in cases if case['id'] in args.cases.split(',')]
    if args.live:
        with ThreadPoolExecutor(max_workers=max(1,min(4,args.workers))) as executor:
            rows=list(executor.map(lambda case:live_case(case,neural=not args.no_neural),cases))
        snapshot=args.output.with_suffix('.snapshot.json');snapshot.parent.mkdir(parents=True,exist_ok=True)
        snapshot.write_text(json.dumps({'definitionSha256':hashlib.sha256(args.definitions.read_bytes()).hexdigest(),'rows':rows},ensure_ascii=False))
    elif args.snapshot:
        frozen=json.loads(args.snapshot.read_text());rows=[replay(row,neural=not args.no_neural) for row in frozen['rows'] if row['caseId'] in {case['id'] for case in cases}]
    else:parser.error('Choose --live or an explicit --snapshot; no network runs implicitly.')
    report=summarize(doc,rows,args.include_provisional);report['dbefTuning']=tune(doc,rows,args.include_provisional)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cases':len(rows),'means':report['means'],'dbefTuning':report['dbefTuning']},indent=2))
