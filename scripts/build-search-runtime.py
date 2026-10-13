#!/usr/bin/env python3
"""Build a relocatable, offline cross-encoder runtime for a desktop release.

Run in an isolated venv with requirements-search-runtime.txt. Building downloads
the pinned public ONNX model; normal app searches never download weights.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2'
REVISION = '233902d25c440f23af6f7d6e94d2946bac0bee0a'
FILES = {'onnx/model.onnx': 'model.onnx', 'tokenizer.json': 'tokenizer.json',
         'config.json': 'config.json', 'README.md': 'MODEL-README.md'}


def verify_macos_dependencies(directory):
    """Reject a builder interpreter or native wheel newer than advertised macOS."""
    if sys.platform != 'darwin': return
    magic = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}
    for path in directory.rglob('*'):
        if not path.is_file() or path.is_symlink(): continue
        with path.open('rb') as file:
            if file.read(4) not in magic: continue
        info = subprocess.check_output(['otool', '-l', str(path)], text=True)
        for command in info.split('Load command '):
            field = 'minos' if 'cmd LC_BUILD_VERSION\n' in command else 'version' if 'cmd LC_VERSION_MIN_MACOSX\n' in command else None
            version = re.search(r'\b' + field + r'\s+(\d+\.\d+)', command) if field else None
            if version and tuple(map(int, version.group(1).split('.'))) > (11, 0):
                raise ValueError('Bundled native dependency requires macOS newer than 11: ' + str(path))
        links = subprocess.check_output(['otool', '-L', str(path)], text=True).splitlines()[1:]
        for link in links:
            name = link.strip().split(' (')[0]
            if name.startswith('/') and not name.startswith(('/usr/lib/', '/System/Library/')):
                raise ValueError('Bundled native dependency refers to an external build path: ' + name)


def build(output):
    if output.exists(): raise ValueError('Use a fresh runtime directory.')
    output.mkdir(parents=True)
    model = output / 'model'
    model.mkdir()
    hashes = {}
    for remote, local in FILES.items():
        path = model / local
        with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{remote}', timeout=60) as response:
            with path.open('wb') as target:
                while True:
                    chunk = response.read(1024*1024)
                    if not chunk: break
                    target.write(chunk)
        hashes[local] = hashlib.sha256(path.read_bytes()).hexdigest()
    with urllib.request.urlopen('https://www.apache.org/licenses/LICENSE-2.0.txt', timeout=30) as response:
        (model / 'LICENSE.txt').write_bytes(response.read())
    with tempfile.TemporaryDirectory(prefix='pulse-freeze-ranker-') as temporary:
        command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
                   '--name', 'pulse-reranker', '--distpath', str(output / 'bin'),
                   '--workpath', str(Path(temporary) / 'build'), '--specpath', temporary,
                   '--collect-all', 'onnxruntime', '--collect-all', 'tokenizers',
                   '--copy-metadata', 'numpy', '--exclude-module', 'torch',
                   '--exclude-module', 'transformers', '--exclude-module', 'sentence_transformers',
                   str(ROOT / 'local-web/pulse-backend/pulse_core/reranker_onnx_worker.py')]
        subprocess.run(command, check=True)
    verify_macos_dependencies(output / 'bin')
    executable = 'bin/pulse-reranker/pulse-reranker' + ('.exe' if os.name == 'nt' else '')
    manifest = {'format': 'onnx-executable-v1', 'model': MODEL, 'revision': REVISION,
                'modelDirectory': 'model', 'executable': executable,
                'platform': sys.platform, 'architecture': platform.machine(), 'sha256': hashes}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    payload = {'model': str(model), 'queries': ['Protected bicycle lanes and intersection safety'],
               'records': [{'title': 'Protected bicycle lanes reduce intersection injuries',
                            'abstract': 'A transport study of protected lanes and cycling safety.'},
                           {'title': 'Marine sediment chemistry', 'abstract': 'Mineral samples from the deep ocean.'}]}
    # No user-installed runtime, PATH Python or model cache is involved.
    with tempfile.TemporaryDirectory(prefix='pulse-ranker-fresh-profile-') as profile:
        env = {key: value for key, value in os.environ.items() if not key.startswith(('PULSE_', 'PYTHON', 'HF_'))}
        env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        if sys.platform == 'win32':
            env.update(USERPROFILE=profile, LOCALAPPDATA=str(Path(profile) / 'Local'),
                       APPDATA=str(Path(profile) / 'Roaming'),
                       PATH=str(Path(os.environ['SystemRoot']) / 'System32'))
        else:
            env.update(HOME=profile, PATH='/usr/bin:/bin')
        response = subprocess.run([str(output / executable)], input=json.dumps(payload), text=True,
                                  capture_output=True, env=env, timeout=60, check=True)
        scores = json.loads(response.stdout)['scores']
        assert len(scores) == 2 and scores[0] > scores[1], 'Packaged ranker smoke check failed.'
    print('Portable offline ranker verified:', output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output.resolve())
