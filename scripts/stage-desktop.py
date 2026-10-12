#!/usr/bin/env python3
"""Stage Pulse local-web source and optional PDF dependencies for Tauri."""
import argparse
import json
from pathlib import Path
import shutil
ROOT = Path(__file__).resolve().parent.parent

def stage(python_dependencies=None, search_runtime=None):
    frontend = ROOT / 'desktop/frontend'
    backend = ROOT / 'desktop/src-tauri/resources/backend'
    for destination in (frontend, backend):
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(ROOT / 'local-web/pulse-frontend', destination,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for source in (ROOT / 'local-web/pulse-backend').iterdir():
        target = backend / source.name
        if source.is_dir():
            if source.name != '__pycache__':
                shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        else:
            shutil.copy2(source, target)
    if python_dependencies:
        shutil.copytree(python_dependencies, backend / 'python',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    search_runtime = search_runtime or ROOT / '.search-runtime'
    if search_runtime.is_dir() and (search_runtime / 'model').is_dir():
        manifest = json.loads((search_runtime / 'manifest.json').read_text())
        if manifest.get('format') != 'onnx-executable-v1':
            raise ValueError('Model-only or machine-specific search runtime cannot be packaged. Build the portable runtime first.')
        executable = (search_runtime / manifest['executable']).resolve()
        model = (search_runtime / manifest['modelDirectory']).resolve()
        executable.relative_to(search_runtime.resolve()); model.relative_to(search_runtime.resolve())
        if not executable.is_file() or not (model / 'model.onnx').is_file() or not (model / 'tokenizer.json').is_file():
            raise ValueError('The portable runtime is incomplete.')
        shutil.copytree(search_runtime, backend / '.search-runtime',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    print('Staged Pulse frontend, backend and PDF dependencies')
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python-dependencies', type=Path)
    parser.add_argument('--search-runtime', type=Path)
    args = parser.parse_args()
    if args.search_runtime and not args.search_runtime.is_dir(): parser.error('Search runtime directory is missing.')
    stage(args.python_dependencies, args.search_runtime)
