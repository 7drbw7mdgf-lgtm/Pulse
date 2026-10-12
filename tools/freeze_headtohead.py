#!/usr/bin/env python3
"""Freeze historical Pulse pools and batch-enrich public reference metadata."""
import argparse
import hashlib
import json
from pathlib import Path
from benchmark_dbef import key,reference_fallback,abstract_features
from pulse_core.discovery import run_discovery_pipeline
from pulse_core.search_merge import merge_search_records
from concurrent.futures import ThreadPoolExecutor
import copy


def freeze(labels_path,pools_path,output):
    labels=json.loads(labels_path.read_text());pools=json.loads(pools_path.read_text());by_seed={row['seed'].lower():row for row in pools}
    corpus={};cases=[];issues=[]
    for index,entry in enumerate(labels['seeds'],1):
        seed=entry['seed'];ident=seed['doi'].lower();corpus[ident]={**seed,'benchmarkId':ident,'referenceIds':[]}
        targets=entry['mustFind'];relevant=[];landmarks=[];tags={}
        for target in targets:
            tid=str(target.get('doi') or target['openalex']).lower();relevant.append(tid)
            tag='contemporary' if target['relation']=='cites seed' else 'ancestor';tags[tid]=tag
            if tag=='ancestor':landmarks.append(tid)
            corpus.setdefault(tid,{**target,'benchmarkId':tid,'referenceIds':[],'citationCount':target.get('cites')})
        ids=[]
        for paper in by_seed.get(ident,{}).get('results') or []:
            tid=str(paper.get('doi') or paper.get('openalex') or paper.get('title')).lower()
            corpus.setdefault(tid,{**paper,'benchmarkId':tid,'referenceIds':[]})
            if tid!=ident:ids.append(tid)
        cases.append({'name':f'Head-to-head {index}: '+seed['title'],'seed':ident,'question':seed['title'],
                      'relevant':relevant,'landmarks':landmarks,'tags':tags,'candidateIds':list(dict.fromkeys(ids))})
    references=reference_fallback(corpus,issues,[case['seed'] for case in cases])
    doc={'formatVersion':2,'asOfDate':'2026-10-12','scope':'Five fixed seed cases from historical Pulse head-to-head retrieval; no judged papers added to candidate pools.',
         'labelProvenance':{'rule':labels['rule'],'createdAt':labels['createdAt'],'landmarks':'Top-five cited-by-seed references, used as must-find ancestor landmarks, not expert relevance judgments.'},
         'cases':cases,'corpus':list(corpus.values()),'references':references,
         'provenance':{'labelsSha256':hashlib.sha256(labels_path.read_bytes()).hexdigest(),'poolsSha256':hashlib.sha256(pools_path.read_bytes()).hexdigest(),
           'poolSource':pools_path.name,'positiveInjection':False,'neuralModels':False,
           'provider':'Historical Pulse retrieval with OpenAlex batched metadata enrichment','issues':sorted(set(issues)),
           'unassessedReferencePapers':sum(not p.get('referenceIds') and not p.get('referenceCount') for p in corpus.values())}}
    output.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cases':len(cases),'poolSizes':[len(case['candidateIds']) for case in cases],'papers':len(corpus),'issues':sorted(set(issues))}))


def freeze_live(labels_path,output):
    labels=json.loads(labels_path.read_text());corpus={};cases=[];issues=[]
    def collect(entry):
        captured={}
        def capture(branches,seeds,options):
            captured.update(branches=copy.deepcopy(branches))
        seed=entry['seed']
        result=run_discovery_pipeline({'seedPapers':[seed],'researchQuestion':seed['title'],'limit':200,
            'semanticRerank':False,'pairwiseRerank':False,'aiTriage':False,'depth':1},on_candidates=capture)
        records=[]
        for branch,rows in captured.get('branches',{}).items():
            for row in rows:
                paper=copy.deepcopy(row);paper['retrievalBranches']=[branch]
                for field in ('dbef','networkSimilarity','networkStatus','score','scoreBreakdown','matchLabel'):paper.pop(field,None)
                paper['abstract']=abstract_features(paper.get('abstract'))
                records.append(paper)
        # Preserve actual branch membership and evidence when provider copies merge.
        merged=merge_search_records(records)
        for paper in merged:
            identities={key(paper),str(paper.get('openAlexId') or '').lower()}
            paper['retrievalBranches']=sorted({branch for row in records if key(row) in identities or (paper.get('doi') and row.get('doi')==paper['doi']) for branch in row['retrievalBranches']})
        return entry,merged,result
    with ThreadPoolExecutor(max_workers=2) as executor:
        collected=list(executor.map(collect,labels['seeds']))
    for index,(entry,records,result) in enumerate(collected,1):
        seed=entry['seed'];ident=seed['doi'].lower();corpus.setdefault(ident,{**seed,'benchmarkId':ident,'referenceIds':[]})
        ids=[]
        for paper in records:
            tid=key(paper);paper['benchmarkId']=tid;ids.append(tid)
            if tid not in corpus:corpus[tid]=paper
        relevant=[];landmarks=[];tags={}
        for target in entry['mustFind']:
            tid=str(target.get('doi') or target['openalex']).lower();relevant.append(tid)
            tag='contemporary' if target['relation']=='cites seed' else 'ancestor';tags[tid]=tag
            if tag=='ancestor':landmarks.append(tid)
            corpus.setdefault(tid,{**target,'benchmarkId':tid,'referenceIds':[],'citationCount':target.get('cites')})
        cases.append({'name':f'Head-to-head {index}: '+seed['title'],'seed':ident,'question':seed['title'],
            'candidateIds':list(dict.fromkeys(ids)),'relevant':relevant,'landmarks':landmarks,'tags':tags,
            'collectionSeconds':result['timings']['retrievalSeconds'],'sourceCounts':result['sourceCounts'],
            'sourceErrors':{name:'Source unavailable or limited' for name in result['errors']},
            'candidateEvidence':{key(p):{field:p[field] for field in ('retrievalBranches','retrievalEvidence','coCitationSimilarity','coCitationCount','hop','subType') if field in p} for p in records}})
        issues.extend(result['errors'])
        print('Frozen head-to-head case',index,'candidates',len(ids),flush=True)
    references=reference_fallback(corpus,issues,[case['seed'] for case in cases])
    doc={'formatVersion':2,'asOfDate':'2026-10-12','scope':'Actual full-discovery provider pools, frozen before ranking; judged targets never injected into candidate lists.',
        'labelProvenance':{'rule':labels['rule'],'createdAt':labels['createdAt'],'landmarks':'Top-five cited-by-seed reference targets, not expert relevance judgments.'},
        'cases':cases,'corpus':list(corpus.values()),'references':references,
        'provenance':{'labelsSha256':hashlib.sha256(labels_path.read_bytes()).hexdigest(),'positiveInjection':False,'neuralModels':False,
            'provider':'Pulse full-discovery provider pools with benchmark-only OpenAlex reference fallback','issues':sorted(set(issues))}}
    output.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    print('Wrote five live frozen pools; all source errors are retained.',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--labels',type=Path,required=True);parser.add_argument('--pools',type=Path);parser.add_argument('--live',action='store_true')
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.live:freeze_live(args.labels,args.output)
    elif args.pools:freeze(args.labels,args.pools,args.output)
    else:parser.error('Choose --live or an existing --pools file.')
