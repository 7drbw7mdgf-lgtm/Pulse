import io
import json
import threading
import unittest
from unittest.mock import patch

from pulse_core.research_models import triage
from pulse_core.discovery_crossencoder import _find_search_runtime, crossencoder_scores

class TestPass2AndPass3(unittest.TestCase):
    def test_pass2_resolves_runtime_from_model_and_python(self):
        py, model = _find_search_runtime({})
        if py is None or model is None:
            self.skipTest("Search runtime not bundled in this checkout environment")
        self.assertIsNotNone(py, "Python runtime should be located")
        self.assertIsNotNone(model, "Model directory should be located")
        self.assertTrue(py.is_file())
        self.assertTrue(model.is_dir())

    def test_pass3_triage_continues_after_failed_batch(self):
        # 2 batches of 5 papers each (10 papers total)
        records = [{'title': f'Paper {i}', 'abstract': f'Abstract {i}', 'score': 50} for i in range(10)]
        # First call fails, second call succeeds
        good_response = io.BytesIO(json.dumps({
            'message': {
                'content': json.dumps({
                    'reviews': [{'id': '0', 'decision': 'relevant', 'reason': 'Strong match'}]
                })
            }
        }).encode())
        
        call_count = [0]
        def mock_open(req, timeout=None):
            call_count[0] += 1
            if call_count[0] == 1:
                raise OSError("Ollama temporary failure on batch 1")
            return good_response

        with patch('pulse_core.research_models.LOCAL_HTTP.open', side_effect=mock_open):
            reviewed = triage(records, 'Research Question', {})
        
        self.assertEqual(call_count[0], 2, "Should attempt both batches despite batch 1 failure")
        self.assertEqual(reviewed, 1, "Should successfully review paper from batch 2")
        # Paper 5 (id 0 of batch 2) should have score boosted by 16 points
        self.assertEqual(records[5]['score'], 66)
        self.assertEqual(records[5]['aiReview']['decision'], 'relevant')

    def test_pass3_triage_score_deltas(self):
        records = [
            {'title': 'Paper A', 'abstract': 'Abstract A', 'score': 50},
            {'title': 'Paper B', 'abstract': 'Abstract B', 'score': 50},
            {'title': 'Paper C', 'abstract': 'Abstract C', 'score': 50}
        ]
        response = io.BytesIO(json.dumps({
            'message': {
                'content': json.dumps({
                    'reviews': [
                        {'id': '0', 'decision': 'relevant', 'reason': 'Relevant paper'},
                        {'id': '1', 'decision': 'not_relevant', 'reason': 'Irrelevant paper'},
                        {'id': '2', 'decision': 'uncertain', 'reason': 'Uncertain'}
                    ]
                })
            }
        }).encode())
        with patch('pulse_core.research_models.LOCAL_HTTP.open', return_value=response):
            reviewed = triage(records, 'Question', {})
        self.assertEqual(reviewed, 3)
        self.assertEqual(records[0]['score'], 66) # +16
        self.assertEqual(records[1]['score'], 22) # -28
        self.assertEqual(records[2]['score'], 50) # +0

if __name__ == '__main__':
    unittest.main()
