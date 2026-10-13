"""Unit tests for pipelined cold speed optimizations:
- Deterministic ranking equivalence with and without background pre-computation
- Compressed SQLite HTTP cache roundtrip and transparent fallback
- Persistent cross-encoder worker supervisor recovery and protocol
- OpenCitations DOI retrieval
"""
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock
import zlib
from contextlib import closing

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))

import pulse_performance as perf
from pulse_core import discovery
from pulse_core import discovery_crossencoder as dce
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates


class CompressedHttpCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orig_config_dir = os.environ.get('PULSE_CONFIG_DIR')
        os.environ['PULSE_CONFIG_DIR'] = self.temp_dir.name

    def tearDown(self):
        if self.orig_config_dir:
            os.environ['PULSE_CONFIG_DIR'] = self.orig_config_dir
        else:
            os.environ.pop('PULSE_CONFIG_DIR', None)
        self.temp_dir.cleanup()

    def test_zlib_compressed_roundtrip(self):
        import urllib.request
        req = urllib.request.Request('https://api.openalex.org/works/W8888', headers={'Accept': 'application/json'})
        key = perf._disk_http_cache_key(req)
        payload = {'id': 'W8888', 'title': 'A large simulated paper object' * 20, 'results': list(range(100))}

        perf._disk_http_cache_set(key, req.full_url, {}, payload, status=200)

        # Verify underlying SQLite storage is actually compressed
        db_path = Path(self.temp_dir.name) / 'http-cache.sqlite3'
        with closing(sqlite3.connect(str(db_path))) as conn:
            row = conn.execute("SELECT body FROM http_cache WHERE key = ?", (key,)).fetchone()
            self.assertIsNotNone(row)
            raw_blob = row[0]
            # Decompressing with zlib succeeds
            decompressed = zlib.decompress(raw_blob)
            self.assertEqual(json.loads(decompressed.decode('utf-8')), payload)

        # Reading through helper decompresses cleanly
        cached = perf._disk_http_cache_get(key, req)
        self.assertEqual(cached, payload)

    def test_uncompressed_backward_compatibility(self):
        import urllib.request
        req = urllib.request.Request('https://api.openalex.org/works/W7777', headers={'Accept': 'application/json'})
        key = perf._disk_http_cache_key(req)
        payload = {'id': 'W7777', 'title': 'Legacy Uncompressed Object'}

        # First write via _disk_http_cache_set to create table
        perf._disk_http_cache_set(key, req.full_url, {}, {'dummy': True}, status=200)

        db_path = Path(self.temp_dir.name) / 'http-cache.sqlite3'
        # Manually store uncompressed utf-8 bytes into http_cache
        uncompressed_bytes = json.dumps(payload).encode('utf-8')
        with closing(sqlite3.connect(str(db_path))) as conn:
            conn.execute(
                "UPDATE http_cache SET body = ? WHERE key = ?",
                (uncompressed_bytes, key)
            )
            conn.commit()

        # Cache get should fall back gracefully and return data
        cached = perf._disk_http_cache_get(key, req)
        self.assertEqual(cached, payload)


class OpenCitationsFallbackTests(unittest.TestCase):
    def test_opencitations_citing_dois(self):
        mock_response = [
            {"citing": "10.1016/j.jbusres.2021.01.001", "cited": "10.1000/182"},
            {"citing": "10.1016/respol.2020.104000", "cited": "10.1000/182"}
        ]
        with patch('pulse_performance.request_json', return_value=mock_response):
            dois = discovery.opencitations_citing_dois('10.1000/182', limit=10)
            self.assertEqual(dois, ["10.1016/j.jbusres.2021.01.001", "10.1016/respol.2020.104000"])

    def test_opencitations_referenced_dois(self):
        mock_response = [
            {"citing": "10.1000/182", "cited": "10.1145/12345.67890"}
        ]
        with patch('pulse_performance.request_json', return_value=mock_response):
            dois = discovery.opencitations_referenced_dois('10.1000/182', limit=10)
            self.assertEqual(dois, ["10.1145/12345.67890"])


class PersistentCrossEncoderSupervisorTests(unittest.TestCase):
    def test_worker_supervisor_lifecycle_and_recovery(self):
        # Test supervisor restart on terminated process
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0  # Process has exited
        dce._WORKER_PROC = mock_proc
        dce._WORKER_KEY = ("old_py", "old_worker")

        python_path = Path("/bin/echo")
        worker_path = Path("/bin/echo")

        with patch('subprocess.Popen') as mock_popen:
            new_mock = MagicMock()
            new_mock.poll.return_value = None
            mock_popen.return_value = new_mock

            proc = dce._get_worker(python_path, worker_path)
            self.assertEqual(proc, new_mock)
            mock_popen.assert_called_once()


class RankingEquivalenceDeterminismTests(unittest.TestCase):
    def test_frozen_pool_ranking_is_byte_deterministic(self):
        # Construct realistic candidate pool
        seed = {'title': 'Urban transport network design', 'doi': '10.1016/j.trb.2020.01', 'year': 2020}
        candidates = []
        for i in range(50):
            c = {
                'id': f'cand_{i}',
                'doi': f'10.1016/paper_{i}',
                'title': f'Paper {i} on transit and networks',
                'abstract': f'Abstract for paper {i} studying multi-modal transit systems.',
                'year': 2018 + (i % 6),
                'citationCount': (i * 17) % 500,
                'retrievalEvidence': [{'channel': f'citations:0:forward', 'rank': i + 1, 'provider': 'OpenAlex'}] if i < 15 else []
            }
            candidates.append(c)

        pool = {'citationGraph': candidates[:25], 'related': candidates[25:]}

        # Run ranking pass 1
        res1 = merge_and_rank_pipeline_candidates(pool, [seed], {'limit': 30})
        # Run ranking pass 2
        res2 = merge_and_rank_pipeline_candidates(pool, [seed], {'limit': 30})

        self.assertEqual(len(res1), len(res2))
        for r1, r2 in zip(res1, res2):
            self.assertEqual(r1.get('id'), r2.get('id'))
            self.assertEqual(r1.get('matchStrength'), r2.get('matchStrength'))
            self.assertEqual(r1.get('scoreBreakdown'), r2.get('scoreBreakdown'))



def _fake_vector(text):
    import hashlib
    digest = hashlib.sha256(text.encode('utf-8')).digest()
    return [((b / 255.0) - 0.5) for b in digest[:16]]


def _equivalence_pool():
    seed = {'title': 'Outer membrane vesicles in Campylobacter host interaction', 'doi': '10.1000/seed',
            'year': 2012, 'abstract': 'Vesicles deliver toxins to intestinal epithelial cells.',
            'paperKeywords': ['outer membrane vesicles', 'Campylobacter']}
    rows = []
    for i in range(140):
        rows.append({'doi': f'10.1000/p{i}', 'title': f'Vesicle study {i} on epithelial toxin delivery variant {i % 7}',
                     'abstract': f'Study {i} of membrane vesicles, toxins and host cells; cohort {i % 11}.',
                     'year': 2005 + i % 18, 'citationCount': (i * 37) % 900,
                     'retrievalEvidence': [{'channel': 'citations:0:forward' if i % 3 == 0 else 'concepts:q1', 'rank': i + 1,
                                            'provider': 'OpenAlex'}]})
    return seed, {'citationGraph': [r for r in rows if r['retrievalEvidence'][0]['channel'].startswith('citations')],
                  'europePmc': [r for r in rows if not r['retrievalEvidence'][0]['channel'].startswith('citations')]}


class BackgroundPrecomputeEquivalenceTests(unittest.TestCase):
    """A.4: background pre-computation only fills caches; the final ranking is identical."""

    def setUp(self):
        from pulse_core import discovery_semantics as ds
        self.ds = ds
        self.embed_calls = []
        self.pair_calls = []
        def fake_request_json(request, timeout=None, cache=True):
            texts = json.loads(request.data.decode('utf-8'))['input']
            self.embed_calls.append(len(texts))
            return {'embeddings': [_fake_vector(text) for text in texts]}
        def fake_infer(python, worker, payload, count, cancel_event, timeout):
            self.pair_calls.append(len(payload['records']))
            scores = [round((sum(map(ord, json.dumps(r, sort_keys=True))) % 997) / 997, 6) for r in payload['records']]
            return scores, 'Titles and abstracts assessed together with your research question.'
        self.patches = [
            patch.object(ds, 'local_model', return_value=('http://127.0.0.1:9/api/embed', 'fake-embed')),
            patch.object(ds, 'request_json', side_effect=fake_request_json),
            patch.object(ds, '_disk_cached', return_value=None),
            patch.object(ds, 'cached_embeddings', return_value={}),
            patch.object(dce, '_find_search_runtime', return_value=(Path(sys.executable), Path(tempfile.gettempdir()))),
            patch.object(dce, '_infer', side_effect=fake_infer),
            patch.object(dce, '_cached_crossencoder_disk', return_value={}),
        ]
        for item in self.patches: item.start()
        self.clear()

    def tearDown(self):
        for item in self.patches: item.stop()
        self.clear()

    def clear(self):
        self.ds._cache.clear()
        dce.clear_score_cache()

    def rank(self, pool, seed, probe=None, neural=True):
        settings = {}
        options = {'limit': 200, 'researchQuestion': ''}
        if probe: options['_shortlistProbe'] = probe
        if neural:
            options['_semanticReranker'] = lambda queries, records: self.ds.semantic_scores(settings, queries, records)
            options['_pairwiseReranker'] = lambda queries, records: dce.crossencoder_scores(settings, queries, records)
        return merge_and_rank_pipeline_candidates(pool, [seed], options)

    def signature(self, ranked):
        return [(r.get('doi'), r.get('score'), json.dumps(r.get('scoreBreakdown'), sort_keys=True)) for r in ranked]

    def test_final_ranking_identical_with_and_without_precompute(self):
        seed, pool = _equivalence_pool()
        cold = self.signature(self.rank(pool, seed))
        self.clear(); self.embed_calls.clear(); self.pair_calls.clear()
        shortlists = []
        self.rank(pool, seed, probe=lambda semantic, pairwise: shortlists.append((semantic, pairwise)), neural=False)
        self.assertEqual(len(shortlists), 1)
        semantic_rows, pairwise_rows = shortlists[0]
        queries = [discovery.text_for_paper(seed)]
        discovery.pre_embed_papers({}, semantic_rows, queries=queries)
        pair_queries = [seed['title'] + ' ' + ' '.join(seed['paperKeywords'])]
        discovery.pre_score_crossencoder({}, pair_queries, pairwise_rows)
        precomputed_embed, precomputed_pair = sum(self.embed_calls), sum(self.pair_calls)
        self.assertGreater(precomputed_embed, 0); self.assertGreater(precomputed_pair, 0)
        warm = self.signature(self.rank(pool, seed))
        self.assertEqual(cold, warm, 'Background pre-computation must not change the final ranking')
        # Foreground found every shortlisted text already embedded.
        self.assertEqual(sum(self.embed_calls), precomputed_embed)

    def test_probe_semantic_shortlist_matches_foreground(self):
        seed, pool = _equivalence_pool()
        probed, assessed = [], []
        self.rank(pool, seed, probe=lambda semantic, pairwise: probed.extend(r['doi'] for r in semantic), neural=False)
        options = {'limit': 200, 'researchQuestion': '',
                   '_semanticReranker': lambda queries, records: (assessed.extend(r['doi'] for r in records), (None, 'off'))[1]}
        merge_and_rank_pipeline_candidates(pool, [seed], options)
        self.assertEqual(probed, assessed)

    def test_pre_score_does_not_deadlock_on_inference_lock(self):
        seed, pool = _equivalence_pool()
        rows = pool['citationGraph'][:40]
        started = time.monotonic()
        discovery.pre_score_crossencoder({}, ['vesicles'], rows)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(sum(self.pair_calls), 40)
        self.assertTrue(all(size <= dce.PRE_SCORE_BATCH for size in self.pair_calls))
        self.assertTrue(dce._inference_lock.acquire(blocking=False)); dce._inference_lock.release()

    def test_background_pre_score_yields_to_foreground(self):
        seed, pool = _equivalence_pool()
        self.assertTrue(dce._inference_lock.acquire(blocking=False))
        try:
            scores, notice = dce.crossencoder_scores({}, ['vesicles'], pool['citationGraph'][:5], nonblocking=True)
        finally:
            dce._inference_lock.release()
        self.assertIsNone(scores); self.assertEqual(self.pair_calls, [])


class PersistentWorkerProtocolTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        dce._stop_worker()

    def tearDown(self):
        dce._stop_worker()
        self.dir.cleanup()

    def script(self, body):
        path = Path(self.dir.name) / 'worker.py'
        path.write_text('import json, sys, time\n' + body)
        return path

    def test_persistent_worker_answers_by_request_id_and_survives_requests(self):
        worker = self.script('for line in sys.stdin:\n'
                             '    req = json.loads(line)\n'
                             '    print(json.dumps({"id": req["id"], "scores": [0.5] * len(req["records"])}), flush=True)\n')
        for _ in range(3):
            scores, _ = dce._infer(Path(sys.executable), worker, {'records': [{}, {}]}, 2, None, timeout=5)
            self.assertEqual(scores, [0.5, 0.5])
        first = dce._WORKER_PROC
        dce._infer(Path(sys.executable), worker, {'records': [{}]}, 1, None, timeout=5)
        self.assertIs(dce._WORKER_PROC, first, 'one worker process serves repeated requests')

    def test_hung_worker_times_out_and_is_replaced(self):
        worker = self.script('for line in sys.stdin:\n    time.sleep(30)\n')
        started = time.monotonic()
        scores, notice = dce._infer(Path(sys.executable), worker, {'records': [{}]}, 1, None, timeout=0.6)
        self.assertIsNone(scores)
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertIsNone(dce._WORKER_PROC)

    def test_crashed_worker_is_restarted(self):
        marker = Path(self.dir.name) / 'started-once'
        worker = self.script(f'import os\nmarker = {str(marker)!r}\n'
                             'if not os.path.exists(marker):\n'
                             '    open(marker, "w").close(); sys.exit(1)\n'
                             'for line in sys.stdin:\n'
                             '    req = json.loads(line)\n'
                             '    print(json.dumps({"id": req["id"], "scores": [0.25]}), flush=True)\n')
        scores, _ = dce._infer(Path(sys.executable), worker, {'records': [{}]}, 1, None, timeout=5)
        self.assertEqual(scores, [0.25])

    def test_single_shot_mode_still_supported(self):
        from pulse_core import reranker_onnx_worker as onnx_worker
        source = Path(onnx_worker.__file__).read_text()
        self.assertIn('for line in sys.stdin', source)
        self.assertIn('break', source)



class FrozenRuntimeProtocolTests(unittest.TestCase):
    """Runtimes frozen before the persistent protocol must still work (single-shot)."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        dce._stop_worker(); dce._protocol_cache.clear()

    def tearDown(self):
        dce._stop_worker(); dce._protocol_cache.clear()
        self.dir.cleanup()

    def frozen(self, manifest):
        root = Path(self.dir.name) / 'runtime'
        exe = root / 'bin' / 'pulse-reranker' / 'pulse-reranker'
        exe.parent.mkdir(parents=True)
        # Reads one JSON document until end of input, like runtimes frozen before 1.8.1.
        exe.write_text(f'#!{sys.executable}\nimport json, sys\n'
                       'payload = json.load(sys.stdin)\n'
                       'print(json.dumps({"scores": [0.75] * len(payload["records"])}))\n')
        exe.chmod(0o755)
        (root / 'manifest.json').write_text(json.dumps(manifest))
        return exe

    @unittest.skipIf(os.name == 'nt', 'The fake frozen runtime is a #! script, which Windows cannot execute directly.')
    def test_old_runtime_without_protocol_uses_single_shot(self):
        exe = self.frozen({'format': 'onnx-executable-v1'})
        self.assertFalse(dce._supports_persistent(exe))
        started = time.monotonic()
        scores, _ = dce._infer(exe, Path('unused'), {'records': [{}, {}]}, 2, None, timeout=5)
        self.assertEqual(scores, [0.75, 0.75])
        self.assertLess(time.monotonic() - started, 3.0, 'must not wait for a persistent reply')
        self.assertIsNone(dce._WORKER_PROC)

    def test_runtime_declaring_protocol_is_persistent(self):
        exe = self.frozen({'format': 'onnx-executable-v1', 'protocol': 'jsonl-v1'})
        self.assertTrue(dce._supports_persistent(exe))

    def test_source_workers_are_persistent(self):
        self.assertTrue(dce._supports_persistent(Path(sys.executable)))


class OpenCitationsLookupTests(unittest.TestCase):
    def test_doi_metadata_lookup_is_url_encoded_and_batched(self):
        seen = []
        with patch.object(discovery._core, 'fetch_json', side_effect=lambda url: seen.append(url) or {'results': []}):
            discovery.openalex_works_by_dois(['10.1002/(SICI)1097-0258(1998)17:3<1::AID>3.0.CO;2-#'] + [f'10.1000/batch{i}' for i in range(150)])
        self.assertEqual(len(seen), 2)
        self.assertNotIn('<', seen[0]); self.assertNotIn('#', seen[0]); self.assertNotIn(';', seen[0])
        self.assertIn('select=', seen[0])


class PrewarmCancellationTests(unittest.TestCase):
    def test_prewarm_skipped_while_search_running(self):
        with patch.object(discovery, 'openalex_work_for_paper') as lookup:
            with discovery._ACTIVE_LOCK: discovery._ACTIVE_SEARCHES[0] += 1
            try:
                discovery.warm_paper_discovery({'title': 'x', 'doi': '10.1/x'})
            finally:
                with discovery._ACTIVE_LOCK: discovery._ACTIVE_SEARCHES[0] -= 1
            lookup.assert_not_called()

    def test_search_start_cancels_running_prewarm(self):
        discovery._WARM_CANCEL.clear()
        with patch.object(discovery, '_run_discovery_pipeline', return_value={'ok': True}):
            discovery.run_discovery_pipeline({'seedPapers': []})
        self.assertTrue(discovery._WARM_CANCEL.is_set())
        self.assertEqual(discovery._ACTIVE_SEARCHES[0], 0)


if __name__ == '__main__':
    unittest.main()
