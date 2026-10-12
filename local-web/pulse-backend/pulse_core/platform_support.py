"""User data paths, parent liveness and file locks across desktop platforms."""
import os
import sys
from contextlib import contextmanager
from pathlib import Path


def config_directory(platform=None, environment=None, home=None):
    platform = sys.platform if platform is None else platform
    environment = os.environ if environment is None else environment
    home = Path.home() if home is None else Path(home)
    override = environment.get('PULSE_CONFIG_DIR') or environment.get('IRATXE_CONFIG_DIR')
    if override:
        return Path(override)
    if platform == 'win32':
        return Path(environment.get('LOCALAPPDATA') or home / 'AppData' / 'Local') / 'Pulse'
    if platform == 'darwin':
        return home / 'Library' / 'Application Support' / 'pulse'
    return Path(environment.get('XDG_DATA_HOME') or home / '.local' / 'share') / 'pulse'


def process_alive(pid):
    if pid <= 1:
        return False
    if sys.platform == 'win32':
        # os.kill(pid, 0) can terminate a process on Windows; query its handle instead.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied is not proof of exit.
        try:
            return kernel.WaitForSingleObject(handle, 0) != 0  # WAIT_OBJECT_0: exited
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@contextmanager
def exclusive_file_lock(path):
    with Path(path).open('a+b') as stream:
        if sys.platform == 'win32':
            import msvcrt
            if stream.seek(0, os.SEEK_END) == 0:
                stream.write(b'\0')
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)
