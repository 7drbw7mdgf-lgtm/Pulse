"""Prevent installed Windows builds silently losing ranking and scanned PDF text."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'local-web/pulse-backend'))
from pulse_core import discovery_crossencoder

spec = importlib.util.spec_from_file_location('freeze_windows', ROOT / 'scripts/freeze-windows-backend.py')
freeze = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freeze)


class WindowsOfflineAssetsTests(unittest.TestCase):
    def fixtures(self, root):
        backend = root / 'backend'
        runtime = root / 'runtime'
        for path in (backend / 'ocr-data/eng.traineddata', backend / 'ocr-data/LICENSE',
                     runtime / 'bin/pulse-reranker/pulse-reranker.exe',
                     runtime / 'model/model.onnx', runtime / 'model/tokenizer.json'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic fixture')
        manifest = {'format': 'onnx-executable-v1', 'platform': 'win32',
                    'executable': 'bin/pulse-reranker/pulse-reranker.exe', 'modelDirectory': 'model'}
        (runtime / 'manifest.json').write_text(json.dumps(manifest))
        return backend, runtime, manifest

    def test_assets_are_discoverable_at_the_frozen_module_location(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend, runtime, _ = self.fixtures(root)
            arguments = freeze.packaged_data_arguments(backend, runtime)
            internal = backend / '_internal'
            import shutil
            # Reproduce PyInstaller's data destinations rather than the staging root.
            for source in arguments[1::2]:
                source, destination = source.rsplit(':', 1)
                shutil.copytree(source, internal / destination)
            with patch.object(discovery_crossencoder, '__file__', str(internal / 'pulse_core/discovery_crossencoder.py')), \
                 patch.object(Path, 'home', return_value=root / 'fresh-profile'), \
                 patch.dict('os.environ', {'PULSE_CONFIG_DIR': str(root / 'fresh-profile')}, clear=True):
                executable, model = discovery_crossencoder._find_search_runtime({})
            self.assertEqual(executable, (internal / '.search-runtime/bin/pulse-reranker/pulse-reranker.exe').resolve())
            self.assertEqual(model, (internal / '.search-runtime/model').resolve())
            self.assertTrue((internal / 'ocr-data/eng.traineddata').is_file())

    def test_model_only_and_wrong_platform_packages_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            backend, runtime, manifest = self.fixtures(Path(directory))
            manifest['platform'] = 'darwin'
            (runtime / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'Windows ranker'):
                freeze.packaged_data_arguments(backend, runtime)
            manifest['platform'] = 'win32'
            (runtime / 'manifest.json').write_text(json.dumps(manifest))
            (runtime / 'model/tokenizer.json').unlink()
            with self.assertRaisesRegex(ValueError, 'Required offline asset'):
                freeze.packaged_data_arguments(backend, runtime)

    def test_external_builder_paths_cannot_be_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            backend, runtime, manifest = self.fixtures(Path(directory))
            manifest['executable'] = '../external/python.exe'
            (runtime / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                freeze.packaged_data_arguments(backend, runtime)
