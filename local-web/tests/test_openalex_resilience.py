import json
import os
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch, MagicMock

TEST_DIR = tempfile.mkdtemp(prefix='pulse-oa-test-')
os.environ['PULSE_CONFIG_DIR'] = TEST_DIR

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))

import pulse_core as _core
_core.CONFIG_DIR = Path(TEST_DIR)
_core.CONFIG_PATH = Path(TEST_DIR) / 'settings.json'
_core.LIBRARY_PATH = Path(TEST_DIR) / 'library.json'

import pulse_performance as perf
from pulse_core import discovery
from pulse_core.storage import save_settings, load_settings, public_settings
from pulse_core.security import SENSITIVE_SETTING_KEYS, encrypt_secret, decrypt_secret
from pulse_core.external_apis import fetch_json
from pulse_source_health import cooldowns, clear, clear_source, failed


class OpenAlexResilienceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orig_config_dir = os.environ.get('PULSE_CONFIG_DIR')
        self.orig_config_path = _core.CONFIG_PATH
        self.orig_core_dir = _core.CONFIG_DIR
        os.environ['PULSE_CONFIG_DIR'] = self.temp_dir.name
        _core.CONFIG_DIR = Path(self.temp_dir.name)
        _core.CONFIG_PATH = Path(self.temp_dir.name) / 'settings.json'
        _core.LIBRARY_PATH = Path(self.temp_dir.name) / 'library.json'
        clear()

    def tearDown(self):
        clear()
        _core.CONFIG_PATH = self.orig_config_path
        _core.CONFIG_DIR = self.orig_core_dir
        if self.orig_config_dir:
            os.environ['PULSE_CONFIG_DIR'] = self.orig_config_dir
        else:
            os.environ.pop('PULSE_CONFIG_DIR', None)
        self.temp_dir.cleanup()

    def test_sensitive_keys_contains_openalex_key(self):
        self.assertIn("openAlexApiKey", SENSITIVE_SETTING_KEYS)
        # Verify encryption and decryption works
        encrypted = encrypt_secret("my_openalex_secret_key")
        self.assertTrue(encrypted.startswith("enc:v1:"))
        decrypted = decrypt_secret(encrypted)
        self.assertEqual(decrypted, "my_openalex_secret_key")

    def test_save_and_load_openalex_settings(self):
        # Save OpenAlex API key and contact email
        save_settings({
            "openAlexApiKey": "oa_key_12345",
            "contactEmail": "researcher@lab.edu",
        })
        loaded = load_settings()
        self.assertEqual(loaded.get("openAlexApiKey"), "oa_key_12345")
        self.assertEqual(loaded.get("pulse_contact_email"), "researcher@lab.edu")

        # Verify on-disk file has encrypted secret
        raw_config = json.loads((Path(self.temp_dir.name) / "settings.json").read_text("utf-8"))
        self.assertTrue(raw_config["openAlexApiKey"].startswith("enc:v1:"))
        self.assertEqual(raw_config["pulse_contact_email"], "researcher@lab.edu")

        # Verify public_settings exposes masked preview and configuration
        pub = public_settings(loaded)
        oa_provider = pub.get("providers", {}).get("openAlex", {})
        self.assertTrue(oa_provider.get("configured"))
        self.assertIn("oa_k", oa_provider.get("preview", ""))
        self.assertEqual(oa_provider.get("contactEmail"), "researcher@lab.edu")

    def test_saving_openalex_key_clears_cooldown(self):
        # Simulate OpenAlex cooldown
        req = urllib.request.Request("https://api.openalex.org/works/W100")
        err = urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {"Retry-After": "120"}, None)
        failed(req, err)
        self.assertIn("OpenAlex", cooldowns())

        # Saving new OpenAlex key clears the cooldown
        save_settings({"openAlexApiKey": "new_oa_key_999"})
        self.assertNotIn("OpenAlex", cooldowns())

    def test_fetch_json_injects_openalex_api_key_header(self):
        save_settings({"openAlexApiKey": "secret_oa_token_777"})
        captured_requests = []

        def mock_request_json(req, timeout=12, cache=True):
            captured_requests.append(req)
            return {"results": []}

        with patch("pulse_core.external_apis.request_json", side_effect=mock_request_json):
            fetch_json("https://api.openalex.org/works/W12345", cache=False)

        self.assertEqual(len(captured_requests), 1)
        headers = dict(captured_requests[0].header_items())
        self.assertEqual(headers.get("Api_key"), "secret_oa_token_777")

    def test_fetch_json_injects_polite_pool_email_when_no_key(self):
        save_settings({"contactEmail": "scholar@institute.org"})
        captured_requests = []

        def mock_request_json(req, timeout=12, cache=False):
            captured_requests.append(req)
            return {"results": []}

        with patch("pulse_core.external_apis.request_json", side_effect=mock_request_json):
            fetch_json("https://api.openalex.org/works/W12345", cache=False)

        self.assertEqual(len(captured_requests), 1)
        self.assertIn("mailto=scholar%40institute.org", captured_requests[0].full_url)
        # No api_key header injected
        headers = dict(captured_requests[0].header_items())
        self.assertNotIn("Api_key", headers)

    def test_europepmc_pmid_resolution_and_citations(self):
        doi = "10.1038/s41586-020-2003-7"

        # Test Europe PMC PMID resolution
        with patch("pulse_performance.request_json", return_value={"resultList": {"result": [{"pmid": "32015507", "id": "32015507"}]}}):
            pmid = discovery.europepmc_pmid_for_doi(doi)
            self.assertEqual(pmid, "32015507")

        # Test Europe PMC citations
        mock_cites = {
            "citationList": {
                "citation": [
                    {
                        "id": "33000001",
                        "title": "Downstream study citing seed",
                        "authorString": "Alice Smith, Bob Jones",
                        "pubYear": "2021",
                        "doi": "10.1000/cite1",
                        "journalTitle": "Nature Med",
                        "citedByCount": 15,
                    }
                ]
            }
        }
        with patch("pulse_performance.request_json", return_value=mock_cites):
            cites = discovery.europepmc_citing_papers("32015507", limit=10)
            self.assertEqual(len(cites), 1)
            meta = discovery.europepmc_to_metadata(cites[0])
            self.assertEqual(meta["title"], "Downstream study citing seed")
            self.assertEqual(meta["authors"], ["Alice Smith", "Bob Jones"])
            self.assertEqual(meta["year"], "2021")
            self.assertEqual(meta["metadataSource"], "Europe PMC")

    def test_icite_citations_fallback(self):
        pmid = "32015507"
        # 1st call returns pub with citations list
        first_resp = {
            "data": [
                {
                    "pmid": 32015507,
                    "citations": [34000001, 34000002],
                }
            ]
        }
        # 2nd batch call returns details of citing papers
        second_resp = {
            "data": [
                {
                    "pmid": 34000001,
                    "title": "iCite downstream citation",
                    "authors": "Carol White, David Brown",
                    "year": 2022,
                    "doi": "10.1000/icite1",
                    "journal": "Science",
                    "citation_count": 8,
                }
            ]
        }

        call_count = [0]
        def mock_request(req, timeout=10, cache=True):
            call_count[0] += 1
            return first_resp if call_count[0] == 1 else second_resp

        with patch("pulse_performance.request_json", side_effect=mock_request):
            cites = discovery.icite_citing_papers(pmid, limit=5)
            self.assertEqual(len(cites), 1)
            meta = discovery.icite_to_metadata(cites[0])
            self.assertEqual(meta["title"], "iCite downstream citation")
            self.assertEqual(meta["authors"], ["Carol White", "David Brown"])
            self.assertEqual(meta["year"], "2022")
            self.assertEqual(meta["metadataSource"], "iCite")

    def test_citation_graph_cascade_to_europepmc_when_openalex_in_cooldown(self):
        seed_paper = {
            "id": "seed-1",
            "title": "A SARS-CoV-2 protein interaction map",
            "doi": "10.1038/s41586-020-2286-9",
            "pmid": "32353859",
        }

        # Put OpenAlex into cooldown
        req = urllib.request.Request("https://api.openalex.org/works")
        err = urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {"Retry-After": "60"}, None)
        failed(req, err)
        self.assertIn("OpenAlex", cooldowns())

        epmc_cites = [
            {
                "id": "33000001",
                "title": "Therapeutic targets for SARS-CoV-2",
                "authorString": "Emma Watson, John Doe",
                "pubYear": "2021",
                "doi": "10.1000/epmc_cite",
                "journalTitle": "Cell",
                "citedByCount": 25,
            }
        ]
        epmc_refs = [
            {
                "id": "31000001",
                "title": "Foundational coronavirus biology",
                "authorString": "Alan Turing",
                "pubYear": "2019",
                "doi": "10.1000/epmc_ref",
                "journalTitle": "Virology",
                "citedByCount": 50,
            }
        ]

        with patch("pulse_core.discovery.europepmc_citing_papers", return_value=epmc_cites), \
             patch("pulse_core.discovery.europepmc_reference_papers", return_value=epmc_refs), \
             patch("pulse_core.discovery.openalex_work_for_paper", side_effect=Exception("Should not be called during OpenAlex cooldown")):
            results = discovery.fetch_citation_graph_branch([seed_paper], depth=1, limit=10)

        # Confirm results were retrieved and tagged with provider: 'Europe PMC'
        self.assertGreater(len(results), 0)
        providers = {r.get("provider") for r in results}
        self.assertIn("Europe PMC", providers)
        for r in results:
            evidence = r.get("retrievalEvidence", [{}])[0]
            self.assertEqual(evidence.get("provider"), "Europe PMC")

    def test_citation_graph_cascade_to_icite_when_europepmc_empty(self):
        seed_paper = {
            "id": "seed-2",
            "title": "Biomedical discovery seed",
            "doi": "10.1000/biomed",
            "pmid": "32999999",
        }

        # Put OpenAlex into cooldown
        req = urllib.request.Request("https://api.openalex.org/works")
        failed(req, urllib.error.HTTPError(req.full_url, 429, "Rate limited", {"Retry-After": "60"}, None))

        icite_cites = [
            {
                "pmid": 35000001,
                "title": "NIH iCite validated downstream study",
                "authors": "Grace Hopper",
                "year": 2023,
                "doi": "10.1000/icite_cite",
                "journal": "PNAS",
                "citation_count": 12,
            }
        ]

        with patch("pulse_core.discovery.europepmc_citing_papers", return_value=[]), \
             patch("pulse_core.discovery.europepmc_reference_papers", return_value=[]), \
             patch("pulse_core.discovery.icite_citing_papers", return_value=icite_cites):
            results = discovery.fetch_citation_graph_branch([seed_paper], depth=1, limit=10)

        self.assertGreater(len(results), 0)
        cites = [r for r in results if r.get("subType") == "Forward"]
        self.assertTrue(len(cites) > 0)
        self.assertEqual(cites[0].get("provider"), "iCite")
        self.assertEqual(cites[0]["retrievalEvidence"][0]["provider"], "iCite")


if __name__ == "__main__":
    unittest.main()
