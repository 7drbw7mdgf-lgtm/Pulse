#!/usr/bin/env python3
"""Freeze the Windows backend after staging; run on Windows with Python 3.12."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('The Windows backend must be frozen on Windows.')
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    backend = ROOT / 'local-web/pulse-backend'
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
                    '--console', '--noupx', '--name', 'pulse_backend',
                    '--icon', str(ROOT / 'desktop/src-tauri/icons/icon.ico'),
                    '--distpath', str(work / 'dist'), '--workpath', str(work / 'build'),
                    '--specpath', str(work), '--paths', str(backend),
                    '--collect-submodules', 'pulse_core', '--collect-all', 'pymupdf',
                    '--add-data', str(backend / 'pulse_core/mendeley-client.json') + ':pulse_core',
                    '--add-data', str(backend / 'pulse_core/reranker_worker.py') + ':pulse_core',
                    str(backend / 'pulse_backend.py')], cwd=ROOT, check=True)
    staged = ROOT / 'desktop/src-tauri/resources/backend'
    shutil.copytree(work / 'dist/pulse_backend', staged, dirs_exist_ok=True)
    assert (staged / 'pulse_backend.exe').is_file()
    print('Staged Windows backend with its own Python runtime and PDF dependency.')


if __name__ == '__main__':
    main()
