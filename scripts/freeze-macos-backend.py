#!/usr/bin/env python3
"""Freeze the macOS backend so users do not need a separate Python install."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def packaged_data_arguments(backend,runtime):
    runtime=runtime.resolve();manifest=json.loads((runtime/'manifest.json').read_text())
    if manifest.get('format')!='onnx-executable-v1' or manifest.get('platform')!='darwin':
        raise ValueError('Build a portable Mac ranker before freezing the backend.')
    if manifest.get('architecture')!=platform.machine():raise ValueError('The ranker architecture must match this build.')
    executable=(runtime/manifest['executable']).resolve();model=(runtime/manifest['modelDirectory']).resolve()
    executable.relative_to(runtime);model.relative_to(runtime)
    for path in (executable,model/'model.onnx',model/'tokenizer.json',backend/'ocr-data/eng.traineddata',backend/'ocr-data/LICENSE'):
        if not path.is_file():raise ValueError('Required offline asset is missing: '+str(path))
    return ['--add-data',str(runtime)+':.search-runtime','--add-data',str(backend/'ocr-data')+':ocr-data']

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--work-dir',type=Path,required=True);parser.add_argument('--search-runtime',type=Path,required=True);args=parser.parse_args()
    if sys.platform!='darwin':parser.error('Freeze the Mac backend on macOS.')
    work=args.work_dir.resolve();work.mkdir(parents=True,exist_ok=True);backend=ROOT/'local-web/pulse-backend'
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--console','--noupx','--name','pulse_backend',
      '--distpath',str(work/'dist'),'--workpath',str(work/'build'),'--specpath',str(work),'--paths',str(backend),
      '--collect-submodules','pulse_core','--collect-all','pymupdf','--collect-all','certifi',
      '--add-data',str(backend/'pulse_core/mendeley-client.json')+':pulse_core',
      '--add-data',str(backend/'pulse_core/relay-client.json')+':pulse_core',
      '--add-data',str(backend/'pulse_core/reranker_worker.py')+':pulse_core',
      *packaged_data_arguments(backend,args.search_runtime),str(backend/'pulse_backend.py')]
    subprocess.run(command,cwd=ROOT,check=True)
    staged=ROOT/'desktop/src-tauri/resources/backend'
    shutil.copytree(work/'dist/pulse_backend',staged,dirs_exist_ok=True)
    for name in ('.search-runtime','ocr-data','python'):
        target=staged/name
        if target.is_dir():shutil.rmtree(target)
    notices=staged/'LICENSES';notices.mkdir(exist_ok=True)
    python_license=Path(sys.base_prefix)/'LICENSE.txt'
    if python_license.is_file():shutil.copy2(python_license,notices/'Python-LICENSE.txt')
    for package in ('PyMuPDF','certifi'):
        distribution=importlib.metadata.distribution(package)
        for entry in distribution.files or []:
            if entry.name in {'COPYING','LICENSE','LICENSE.txt'}:shutil.copy2(distribution.locate_file(entry),notices/(package+'-'+entry.name))
    assert (staged/'pulse_backend').is_file()
    assert (staged/'_internal/certifi/cacert.pem').is_file()
    print('Staged Mac backend with bundled Python, PDF/OCR, CA certificates and offline ranking.')

if __name__=='__main__':main()
