#!/usr/bin/env python3
"""Install a Windows setup in a temporary directory and check its native launch."""
import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def executable_path(pid):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(buffer))
        return Path(buffer.value) if kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)) else None
    finally:
        kernel.CloseHandle(handle)


def has_window(pid):
    user = ctypes.WinDLL('user32')
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    found = []
    def inspect(hwnd, _):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        title = ctypes.create_unicode_buffer(512)
        user.GetWindowTextW(hwnd, title, len(title))
        if owner.value == pid and user.IsWindowVisible(hwnd) and 'Pulse' in title.value:
            found.append(True)
        return True
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows(callback_type(inspect), 0)
    return bool(found)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('Run the installed-app verification on Windows.')
    installer = args.installer.resolve()
    assert installer.is_file()
    report = {'installer': installer.name, 'sha256': hashlib.sha256(installer.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix='pulse-windows-verify-') as folder:
        root = Path(folder)
        install = root / 'app'
        # NSIS requires /D last and an unquoted destination, including any spaces.
        setup = subprocess.run(f'"{installer}" /S /D={install}', timeout=180)
        assert setup.returncode == 0, f'Installer exited {setup.returncode}'
        executables = [p for p in install.glob('*.exe') if 'uninstall' not in p.name.lower()]
        assert len(executables) == 1, list(install.glob('*'))
        native = executables[0]
        backend = install / 'resources/backend/pulse_backend.exe'
        assert backend.is_file(), list(install.rglob('pulse_backend.exe'))
        environment = dict(os.environ, PULSE_CONFIG_DIR=str(root / 'profile'),
                           PULSE_PORT_FILE=str(root / 'port.txt'), PULSE_DISABLE_BUNDLED_OLLAMA='1',
                           PULSE_PYTHON=str(root / 'python-must-not-be-needed.exe'))
        diagnostic = subprocess.run([str(backend), '--self-test'], env=environment,
                                    capture_output=True, text=True, timeout=90)
        assert diagnostic.returncode == 0, diagnostic.stdout + diagnostic.stderr
        report['bundledBackend'] = json.loads(diagnostic.stdout.strip().splitlines()[-1])
        assert report['bundledBackend']['ok']
        application = subprocess.Popen([str(native)], env=environment)
        backend_pid = None
        try:
            deadline = time.monotonic() + 90
            token_path = root / 'profile/.session_token'
            while not ((root / 'port.txt').exists() and token_path.exists()):
                if application.poll() is not None or time.monotonic() > deadline:
                    log = root / 'profile/backend.log'
                    raise AssertionError('Native app failed to start: ' + (log.read_text() if log.exists() else str(application.poll())))
                time.sleep(.25)
            port = int((root / 'port.txt').read_text())
            token = token_path.read_text()
            base = f'http://127.0.0.1:{port}'
            def request(path, payload=None):
                data = json.dumps(payload).encode() if payload is not None else None
                req = urllib.request.Request(base + path, data=data,
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=20) as response:
                    return json.load(response)
            health = request('/api/health')
            assert health['ok'] and health['version'] == '1.7.2', health
            backend_pid = health['pid']
            assert executable_path(backend_pid) == backend, executable_path(backend_pid)
            while not has_window(application.pid):
                assert application.poll() is None and time.monotonic() < deadline, 'Pulse window did not open'
                time.sleep(.25)
            report['nativeWindow'] = True
            try:
                urllib.request.urlopen(base + '/api/library', timeout=10)
                raise AssertionError('Unauthenticated API request was accepted')
            except urllib.error.HTTPError as error:
                assert error.code == 403, error.code
            report['sessionAuthentication'] = True
            library = {'papers': [{'id': 'windows-test', 'title': 'A synthetic Windows test paper'}]}
            request('/api/library', library)
            assert request('/api/library')['papers'][0]['id'] == 'windows-test'
            report['librarySaveAndRead'] = True
            row = {'paper_id': 'smoke', 'doi': '10.1234/smoke', 'title': 'Transport survey',
                   'body_text': [{'section': 'Results', 'text': 'Protected bicycle lanes reduced intersection injuries in the transport survey.'}]}
            imported = request('/api/corpus/s2orc/import', {'base64': base64.b64encode(json.dumps(row).encode()).decode()})
            assert imported['imported'] == 1, imported
            passages = request('/api/papers/passages', {'paper': {'doi': row['doi']}, 'question': 'bicycle lanes intersection injuries'})
            assert passages['available'] and passages['passages'], passages
            report['installedPassageApi'] = True
            assert 'configured' in request('/api/agent/status') or isinstance(request('/api/agent/status'), dict)
            assert isinstance(request('/api/managers/status'), dict)
            report['agentAndManagerApis'] = True
        finally:
            application.terminate()
            application.wait(timeout=20)
            if backend_pid:
                deadline = time.monotonic() + 15
                while executable_path(backend_pid) and time.monotonic() < deadline:
                    time.sleep(.25)
                assert executable_path(backend_pid) is None, 'Backend survived launcher exit'
                report['backendStopsWithApp'] = True
            uninstallers = list(install.glob('*uninstall*.exe'))
            if uninstallers:
                subprocess.run([str(uninstallers[0]), '/S'], timeout=60)
        report['ok'] = True
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
