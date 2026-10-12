#!/usr/bin/env python3
"""Freeze the Windows backend after staging; run on Windows with Python 3.12."""
import argparse
import importlib.metadata
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
    notices = staged / 'LICENSES'
    notices.mkdir(exist_ok=True)
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if python_license.is_file():
        shutil.copy2(python_license, notices / 'Python-LICENSE.txt')
    distribution = importlib.metadata.distribution('PyMuPDF')
    for entry in distribution.files or []:
        if entry.name == 'COPYING':
            shutil.copy2(distribution.locate_file(entry), notices / 'PyMuPDF-COPYING.txt')
    (notices / 'README.txt').write_text('Pulse source: https://github.com/7drbw7mdgf-lgtm/Pulse\nPyMuPDF: https://github.com/pymupdf/PyMuPDF (AGPL-3.0)\nPython: https://www.python.org/\n', encoding='utf-8')
    assert (staged / 'pulse_backend.exe').is_file()
    print('Staged Windows backend with its own Python runtime and PDF dependency.')


if __name__ == '__main__':
    main()
