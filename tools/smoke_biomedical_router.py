#!/usr/bin/env python3
"""Offline component smoke check, not a relevance benchmark."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',type=Path,required=True,help='Portable .search-runtime folder')
    parser.add_argument('--model',type=Path,required=True)
    args=parser.parse_args()
    runtime=args.runtime.resolve();manifest=json.loads((runtime/'manifest.json').read_text())
    executable=runtime/manifest['executable'];baseline=runtime/manifest['modelDirectory']
    with tempfile.TemporaryDirectory(prefix='pulse-biomedical-smoke-') as profile:
        os.environ['PULSE_CONFIG_DIR']=profile
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local-web/pulse-backend'))
        from pulse_core.ranking_experiments import routed_scores,optional_model
        from pulse_core.discovery_crossencoder import _stop_worker
        settings={'searchRerankerPython':str(executable),'searchRerankerModel':str(baseline),
            'searchBiomedicalModelPath':str(args.model.resolve()),'searchBiomedicalRouter':True}
        if optional_model(settings) is None:raise ValueError('Model manifest verification failed.')
        topic={'score':.95,'domain':{'id':'https://openalex.org/domains/4'}}
        rows=[{'title':'Diabetes treatment comparison','abstract':'We compared therapies in adult patients with diabetes.','primaryTopic':topic},
            {'title':'Bicycle transport simulation','abstract':'A simulation assessed bicycle lanes.'}]
        results=[]
        try:
            for condition in ('cold','warm'):
                started=time.monotonic()
                scores,notice=routed_scores(settings,['diabetes treatment'],rows,[{'title':'Clinical diabetes therapy','primaryTopic':topic}])
                if scores is None or 'Experimental biomedical blend' not in notice:raise ValueError(notice)
                if not scores[0]>scores[1]:raise ValueError('The synthetic related/unrelated check failed.')
                results.append({'condition':condition,'seconds':round(time.monotonic()-started,3),'scores':scores,'notice':notice})
        finally:_stop_worker()
    print(json.dumps({'scope':__doc__,'results':results},indent=2))


if __name__=='__main__':main()
