#!/usr/bin/env python3
"""Validate match thresholds using explicit positive and negative judgements."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local-web/pulse-backend'))
from pulse_core.discovery_matches import fit_calibration

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evaluation',type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    document=json.loads(args.evaluation.read_text())
    rows=[dict(row,id=str(index)+':'+row['id']) for index,case in enumerate(document['results']) for row in case.get('labels') or []]
    report={}
    for mode in sorted({row['mode'] for row in rows}):
        samples=[row for row in rows if row['mode']==mode]
        profile=fit_calibration(samples)
        report[mode]=dict(profile,mode=mode) if profile else {'status':'insufficient validated judgements','sampleCount':len(samples),'positiveCount':sum(row['grade']>0 for row in samples),'negativeCount':sum(row['grade']==0 for row in samples)}
    encoded=json.dumps(report,indent=2)
    if args.output:args.output.write_text(encoded+'\n')
    print(encoded)
