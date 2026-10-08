#!/usr/bin/env python3
"""Stage Pulse 1.5 local-web source and optional PDF dependencies for Tauri."""
import argparse
from pathlib import Path
import shutil
ROOT = Path(__file__).resolve().parent.parent

def stage(python_dependencies=None):
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
    print('Staged Pulse 1.5 frontend, backend and PDF dependencies')
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python-dependencies', type=Path)
    stage(parser.parse_args().python_dependencies)
