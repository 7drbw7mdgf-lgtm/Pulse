import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("manifest", ROOT / "scripts/create-install-manifest.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)

    def payload(self, name):
        path = self.root / name
        path.write_bytes(b"actual package bytes")
        return path

    def test_actual_files_and_both_platforms(self):
        result = module.create_manifest({"macos-arm64": self.payload("Pulse-2.1.1.dmg"), "windows-x64": self.payload("Pulse-2.1.1-Windows-x64-Setup.exe")})
        self.assertEqual(result["version"], "2.1.1")
        self.assertEqual(set(result["bundled"]), {"python", "pdf", "ocr", "search-ranker"})
        for component in result["components"].values():
            self.assertEqual(component["sha256"], hashlib.sha256(b"actual package bytes").hexdigest())
            self.assertEqual(component["bytes"], 20)

    def test_reject_legacy_runtime(self):
        with self.assertRaises(ValueError):
            module.create_manifest({"macos-arm64": self.payload("Pulse-2.0.1.dmg")})

    def test_mixed_versions(self):
        with self.assertRaises(ValueError):
            module.create_manifest({"macos-arm64": self.payload("Pulse-2.1.1.dmg"), "windows-x64": self.payload("Pulse-2.1.2-Windows-x64-Setup.exe")})

    def test_empty_and_missing_rejected(self):
        with self.assertRaises(ValueError):
            module.create_manifest({})
        path = self.payload("Pulse-2.1.1.dmg")
        path.write_bytes(b"")
        with self.assertRaises(ValueError):
            module.create_manifest({"macos-arm64": path})

    def test_wrong_platform_name_rejected(self):
        with self.assertRaises(ValueError):
            module.create_manifest({"windows-x64": self.payload("Pulse-2.1.1.dmg")})


if __name__ == "__main__":
    unittest.main()
