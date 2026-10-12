#!/usr/bin/env python3
"""Repeatable synthetic latency check; no live retrieval or quality claims."""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'local-web/pulse-backend'))
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_core.discovery_crossencoder import crossencoder_scores
from pulse_core.discovery_semantics import semantic_scores


def run(neural=False):
    pool=json.loads((ROOT/'benchmarks/dbef-frozen-pool.json').read_text())['corpus']
    records=[]
    for i in range(2000):
        record=copy.deepcopy(pool[i%len(pool)])
        record.update(doi=f'10.1234/latency-{i}',title=record['title']+f' latency fixture {i}')
        records.append(record)
    question='How do scientific document indexing and retrieval methods improve search quality?'
    options={'researchQuestion':question,'limit':500,'diversify':True}
    started=time.monotonic();found=rank({'concepts':records},[],options)
    result={'scope':'Synthetic latency workloads on this device; excludes provider collection and relevance-quality evaluation.',
            'cpu':{'inputCount':len(records),'returnedCount':len(found),'seconds':round(time.monotonic()-started,4)}}
    if neural:
        paragraph=('Protected bicycle lanes separate cyclists from traffic at intersections. '
                   'A transport study compares roadway design, injury patterns and cycling conditions across cities. '
                   'Methods include observations of road use and a comparison of protected and unprotected routes. ')
        papers=[{'doi':f'10.1234/neural-{i}','title':f'Cycling routes and intersection injuries study {i}',
                 'abstract':paragraph*15+'Conclusions discuss safer intersection design.'} for i in range(180)]
        queries=['Protected bicycle lanes and intersection safety']
        counts={}
        def meaning(q,rows):
            counts['embeddingRecords']=len(rows)
            return semantic_scores({},q,rows,focus_first=True)
        def pairwise(q,rows):
            counts['pairwiseRecords']=len(rows)
            return crossencoder_scores({},q,rows)
        options={'researchQuestion':queries[0],'limit':100,'_semanticReranker':meaning,'_pairwiseReranker':pairwise}
        started=time.monotonic();rank({'concepts':papers},[],options)
        result['neural']={'seconds':round(time.monotonic()-started,3),**options['_rankingTimings'],**counts,
                          'semanticCount':options['_semanticCount'],'pairwiseCount':options['_pairwiseCount'],
                          'notice':options['_rankingNotice']}
        started=time.monotonic();rank({'concepts':papers},[],options)
        result['repeat']={'seconds':round(time.monotonic()-started,3),**options['_rankingTimings']}
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--neural',action='store_true')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    result=run(args.neural)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
