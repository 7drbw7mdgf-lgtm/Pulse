#!/usr/bin/env python3
"""Explicit developer setup for the optional local pairwise search ranker."""
import argparse
import json
import re
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2'
FILES = ['config.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'model.safetensors']


def install(root):
    python = root / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    if not python.is_file(): venv.EnvBuilder(with_pip=True).create(root)
    subprocess.run([str(python), '-m', 'pip', 'install', 'sentence-transformers>=5.1,<6'], check=True)
    # Pin the downloaded files to one revision; never load .bin/pickle weights.
    with urllib.request.urlopen('https://huggingface.co/api/models/'+MODEL, timeout=30) as response:
        revision = json.load(response)['sha']
    if not re.fullmatch(r'[0-9a-f]{40}', revision): raise ValueError('Invalid model revision')
    model = root / 'model'; model.mkdir(exist_ok=True)
    for name in FILES:
        target = model / name
        with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{revision}/{name}', timeout=60) as response:
            target.write_bytes(response.read())
    (root/'manifest.json').write_text(json.dumps({'model': MODEL, 'revision': revision, 'python': str(python.absolute())}, indent=2)+'\n')
    print('Installed local search ranker at', root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parents[1]/'.search-runtime')
    install(parser.parse_args().directory.resolve())
