import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("update_manifest",ROOT/"scripts/create-update-manifest.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def package(self,name):
        path=self.root/name;path.write_bytes(b"signed payload")
        Path(str(path)+".sig").write_text((ROOT/"desktop/src-tauri/tests/fixtures/update.sig").read_text())
        return path

    def test_both_platforms_and_versioned_urls(self):
        manifest=module.create_manifest({"darwin-aarch64":self.package("Pulse-2.1.3-macOS-arm64.app.tar.gz"),"windows-x86_64":self.package("Pulse-2.1.3-Windows-x64-Setup.exe")},"Release notes")
        self.assertEqual(manifest["version"],"2.1.3")
        self.assertEqual(len(manifest["platforms"]),2)
        self.assertIn("/v2.1.3/Pulse-2.1.3-",manifest["platforms"]["darwin-aarch64"]["url"])

    def test_signature_bound_to_other_version_rejected(self):
        with self.assertRaises(ValueError):
            module.create_manifest({"darwin-aarch64":self.package("Pulse-2.1.4-macOS-arm64.app.tar.gz")})

    def test_missing_signature_and_noncanonical_filename_rejected(self):
        path=self.root/"Pulse-2.1.3-Windows-x64-Setup.exe";path.write_bytes(b"exe")
        with self.assertRaises(FileNotFoundError):module.create_manifest({"windows-x86_64":path})
        with self.assertRaises(ValueError):module.create_manifest({"windows-x86_64":self.package("Pulse-2.1.3.dmg")})
