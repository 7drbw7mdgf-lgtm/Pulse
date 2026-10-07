#!/usr/bin/env python3
"""Stage canonical source for Tauri; generated resources are excluded from Git."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
STATIC_FILES = ('index.html', 'app.js', 'style.css', 'favicon.png', 'graph-engine.js', 'graph-worker.js')
BACKEND_FILES = ('pulse_backend.py', 'pulse_performance.py', 'iratxe_backend.py', 'requirements.txt')


def stage(template_resources=None):
    frontend = ROOT / 'desktop/frontend'
    backend = ROOT / 'desktop/src-tauri/resources/backend'
    for destination in (frontend, backend):
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        for name in STATIC_FILES:
            shutil.copy2(ROOT / name, destination / name)
        for folder in ('js', 'css'):
            shutil.copytree(ROOT / folder, destination / folder)
    for name in BACKEND_FILES:
        shutil.copy2(ROOT / name, backend / name)
    shutil.copytree(ROOT / 'pulse', backend / 'pulse', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    if template_resources:
        for folder in ('python', 'bin'):
            source = template_resources / folder
            if source.exists():
                shutil.copytree(source, backend / folder, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.h', '*.a'))
    print('Staged frontend and backend from canonical Pulse source')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template-resources', type=Path)
    stage(parser.parse_args().template_resources)
