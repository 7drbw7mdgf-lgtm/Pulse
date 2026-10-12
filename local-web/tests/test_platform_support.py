import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
from pulse_core.platform_support import config_directory, process_alive, exclusive_file_lock


class DesktopPlatformTests(unittest.TestCase):
    def test_platform_defaults_and_overrides(self):
        self.assertEqual(config_directory('win32', {'LOCALAPPDATA': '/user/local'}, '/user'), Path('/user/local/Pulse'))
        self.assertEqual(config_directory('win32', {}, '/user'), Path('/user/AppData/Local/Pulse'))
        self.assertEqual(config_directory('darwin', {}, '/user'), Path('/user/Library/Application Support/pulse'))
        self.assertEqual(config_directory('linux', {'XDG_DATA_HOME': '/user/data'}, '/user'), Path('/user/data/pulse'))
        for platform in ('win32', 'darwin', 'linux'):
            self.assertEqual(config_directory(platform, {'PULSE_CONFIG_DIR': '/custom', 'IRATXE_CONFIG_DIR': '/legacy'}, '/user'), Path('/custom'))
            self.assertEqual(config_directory(platform, {'IRATXE_CONFIG_DIR': '/legacy'}, '/user'), Path('/legacy'))

    def test_liveness_does_not_terminate_the_process(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            self.assertTrue(process_alive(child.pid))
            self.assertTrue(process_alive(child.pid))
            self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=10)
        self.assertFalse(process_alive(child.pid))
        self.assertTrue(process_alive(os.getpid()))

    def test_file_lock_excludes_other_process_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manager.lock'
            marker = Path(directory) / 'acquired'
            module_path = str(Path(__file__).resolve().parents[1] / 'pulse-backend')
            code = ('import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); '
                    'from pulse_core.platform_support import exclusive_file_lock; '
                    '\nwith exclusive_file_lock(sys.argv[2]): Path(sys.argv[3]).touch()')
            with exclusive_file_lock(path):
                child = subprocess.Popen([sys.executable, '-c', code, module_path, str(path), str(marker)])
                try:
                    child.wait(timeout=.5)
                    self.fail('A second process acquired the held lock')
                except subprocess.TimeoutExpired:
                    self.assertFalse(marker.exists())
            try:
                self.assertEqual(child.wait(timeout=10), 0)
                self.assertTrue(marker.exists())
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=10)
