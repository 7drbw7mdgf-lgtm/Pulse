#!/usr/bin/env python3
"""Index a local S2ORC JSONL or JSONL.GZ excerpt for exact-ID passage lookup."""
import argparse
import gzip
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local-web/pulse-backend'))
from pulse_core.passages import import_s2orc_stream

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--profile', type=Path, help='Pulse workspace profile directory')
    args = parser.parse_args()
    opener = gzip.open if args.file.suffix.lower() == '.gz' else open
    with opener(args.file, 'rb') as stream:
        print(import_s2orc_stream(stream, args.profile, max_bytes=None))
