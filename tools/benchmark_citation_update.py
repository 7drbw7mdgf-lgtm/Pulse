#!/usr/bin/env python3
"""Compare citation policies on fixed pools without provider calls or neural models.

Use --source to run against another checkout and --compare to report paired
bootstrap deltas from a previously generated baseline JSON. No labels enter
the ranking function; judgments are used only after ranking.
"""
import argparse
import datetime
import json
from pathlib import Path
import sys


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--pools-dir',type=Path)
    parser.add_argument('--compare',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--policy',choices=('fixed','adaptive'),default='fixed')
    parser.add_argument('--intent',choices=('auto','bibliography','focused'),default='auto')
    args=parser.parse_args()
    sys.path.insert(0,str(args.source.resolve()/'tools'))
    import benchmark_independent as benchmark
    pools=args.pools_dir or benchmark.DEFAULT_POOLS_DIR
    results={}
    for name in ('relish','synergy','scidocs','headtohead'):
        data=benchmark.load_pool_file(pools/(name+'_pools.json.gz'))
        result=benchmark.evaluate_variant_on_dataset(data,'sec1_author_trajectory',ranking_options={
            'adaptiveStructure':args.policy=='adaptive','structuralIntent':args.intent})
        results[name]=result
        print(name,{metric:result['summary'][metric]['mean'] for metric in ('nDCG@20','Recall@20','Recall@50')},flush=True)
    report={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'source':str(args.source.resolve()),'scope':'Fixed-pool text/citation ranking only; no live retrieval or neural models.',
            'policy':args.policy,'intent':args.intent,'heldOut':False,
            'datasets':results}
    if args.compare:
        previous=json.loads(args.compare.read_text())
        previous=previous.get('datasets',previous)
        report['comparisons']={name:benchmark.compare_variant_against_baseline(previous[name],results[name]) for name in results}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':main()
