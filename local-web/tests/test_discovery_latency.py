import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-latency-tests-'))
import pulse_core as core
from pulse_core import discovery, discovery_semantics as semantic
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_core.search_limits import SearchResults
from pulse_performance import REQUEST_CONTEXT, DiscoveryCancelled, request_json

SEED = {'title': 'Urban transport research', 'doi': '10.1234/seed'}


def paper(i, **fields):
    return dict({'title': f'Protected bicycle lanes improve intersection safety study {i}',
                 'abstract': 'Protected lanes reduce intersection injuries.', 'doi': f'10.1234/result-{i}'}, **fields)


class ShortlistTests(unittest.TestCase):
    def test_reduced_neural_lists_keep_full_pool_and_channel_coverage(self):
        captured = {}
        def scorer(name):
            def run(queries, rows):
                captured.setdefault(name,[]).extend(rows)
                return [1 if p['doi'].endswith('rare') else .5 for p in rows], 'fixture'
            return run
        records = [paper(i) for i in range(800)]
        rare = paper('rare', title='Independent evidence on protected infrastructure and injuries')
        options = {'limit': 500, '_semanticReranker': scorer('meaning'), '_pairwiseReranker': scorer('pairwise')}
        found = rank({'major': records, 'independent': [rare]}, [SEED], options)
        self.assertEqual(len(found), 500)
        self.assertEqual(options['_candidateCount'], 801)
        self.assertEqual(len(captured['meaning']), 96)
        self.assertEqual(len(captured['pairwise']), 48)
        for rows in captured.values(): self.assertIn(rare['doi'], [p['doi'] for p in rows])
        self.assertEqual(options['_semanticCount'], 96)
        self.assertEqual(options['_pairwiseCount'], 48)
        self.assertTrue(all(value >= 0 for value in options['_rankingTimings'].values()))


class ProviderBudgetTests(unittest.TestCase):
    def tearDown(self):
        for field in ('deadline', 'cancel_event', 'on_partial', 'request_counter'): setattr(REQUEST_CONTEXT, field, None)

    def test_partial_review_bands_use_display_limit_even_below_warmup_size(self):
        updates = []
        rows = [paper(i, source='Europe PMC') for i in range(200)]
        def branches(tasks, progress, cancel):
            progress({'europePmc': rows}, ['europePmc'], {}, 1)
            return {'europePmc': rows}, ['europePmc'], {}
        payload = {'seedPapers': [SEED], 'limit': 50, 'semanticRerank': False, 'pairwiseRerank': False,
                   'branches': {'citationGraph': False, 'citationNetwork': False, 'semanticSearch': False},
                   'searchSources': {'semanticScholar': False, 'core': False}}
        with patch.object(core, 'load_settings', return_value={}), \
             patch.object(discovery, 'parallel_branches', side_effect=branches):
            discovery.run_discovery_pipeline(payload, on_progress=updates.append)
        partial = next(update['recommendations'] for update in updates if update.get('recommendations'))
        self.assertEqual(len(partial), 50)
        self.assertTrue(all(p['matchDisplaySize'] == 50 for p in partial))
        self.assertEqual(sum(p['matchLabel'] == 'Related' for p in partial), 20)

    def test_europe_pmc_and_core_clip_transport_to_eight_seconds_and_keep_partials(self):
        REQUEST_CONTEXT.deadline = 50
        observed = {}
        def search(plan, provider, searcher, limit, **kwargs):
            observed[provider] = REQUEST_CONTEXT.deadline
            request_json(__import__('urllib.request', fromlist=['Request']).Request('https://unit.test/'+provider), cache=False)
            rows = SearchResults([paper(provider, source=provider)])
            rows.warning = 'Search time budget reached; showing collected results.'
            return rows
        def branches(tasks, progress, cancel):
            results = {}
            for name, task in tasks.items():
                results[name] = task()
                self.assertEqual(REQUEST_CONTEXT.deadline, 50)
            return results, list(results), {}
        payload = {'seedPapers': [SEED], 'semanticRerank': False, 'pairwiseRerank': False,
                   'branches': {'citationGraph': False, 'citationNetwork': False, 'semanticSearch': False},
                   'searchSources': {'semanticScholar': False}}
        with patch.object(discovery.time, 'monotonic', return_value=0), \
             patch.object(core, 'load_settings', return_value={}), \
             patch.object(discovery, 'search_query_plan', side_effect=search), \
             patch.object(discovery, 'parallel_branches', side_effect=branches), \
             patch('pulse_performance.urllib.request.urlopen', side_effect=lambda *args, **kwargs: io.BytesIO(b'{}')) as network:
            result = discovery.run_discovery_pipeline(payload)
        self.assertEqual(observed, {'europePmc': 8, 'core': 8})
        self.assertTrue(all(call.kwargs['timeout'] == 8 for call in network.call_args_list))
        self.assertEqual(len(result['recommendations']), 2)
        self.assertIn('budget', result['errors']['europePmc'])


class EmbeddingReuseTests(unittest.TestCase):
    def setUp(self):
        self.profile = tempfile.TemporaryDirectory()
        self.addCleanup(self.profile.cleanup)
        self.patchers = [patch.object(semantic, 'local_model', return_value=('http://127.0.0.1:11434/api/embed', 'fixture-latency')),
                         patch.object(semantic, 'config_directory', return_value=Path(self.profile.name))]
        for p in self.patchers: p.start(); self.addCleanup(p.stop)
        semantic._cache.clear()

    def response(self, request, **kwargs):
        texts = json.loads(request.data)['input']
        return {'embeddings': [[.2]*8 for _ in texts]}

    def test_exact_query_warmup_and_restart_cache_avoid_new_requests(self):
        records = [paper(1)]
        with patch.object(semantic, 'request_json', side_effect=self.response) as network:
            semantic.pre_embed_papers({}, records, queries=['Question'])
            found, _ = semantic.semantic_scores({}, ['Question'], records)
            semantic._cache.clear()
            again, _ = semantic.semantic_scores({}, ['Question'], records)
        self.assertEqual(network.call_count, 1)
        self.assertEqual(found, again)

    def test_question_is_warmed_without_arriving_papers(self):
        with patch.object(semantic, 'request_json', side_effect=self.response) as network:
            semantic.pre_embed_papers({}, [], queries=['Question'])
        self.assertEqual(json.loads(network.call_args.args[0].data)['input'], ['Question'])

    def test_richer_metadata_for_same_doi_does_not_reuse_stale_vector(self):
        with patch.object(semantic, 'request_json', side_effect=self.response) as network:
            semantic.pre_embed_papers({}, [paper(1, abstract='')], queries=['Question'])
            found, _ = semantic.semantic_scores({}, ['Question'], [paper(1)])
        self.assertIsNotNone(found)
        self.assertEqual(network.call_count, 2)
        self.assertEqual(len(json.loads(network.call_args.args[0].data)['input']), 1)

    def test_foreground_reuses_inflight_warmup_after_collection_stops(self):
        entered, release, stopped, finished = (threading.Event() for _ in range(4))
        results, errors = [], []
        def network(request, **kwargs):
            entered.set()
            if not release.wait(2): raise TimeoutError('Test request not released')
            return self.response(request)
        def foreground():
            try: results.append(semantic.semantic_scores({}, ['Question'], [paper(1)]))
            except Exception as error: errors.append(error)
            finally: finished.set()
        with patch.object(semantic, 'request_json', side_effect=network) as request:
            warmup = threading.Thread(target=lambda: semantic.pre_embed_papers({}, [paper(1)], queries=['Question'], stop_event=stopped))
            warmup.start()
            self.assertTrue(entered.wait(2))
            ranking = threading.Thread(target=foreground)
            ranking.start()
            try:
                self.assertFalse(finished.wait(.05))
                stopped.set(); release.set()
                warmup.join(2); ranking.join(2)
                self.assertFalse(warmup.is_alive() or ranking.is_alive())
                self.assertFalse(errors)
                self.assertIsNotNone(results[0][0])
                self.assertEqual(request.call_count, 1)
            finally:
                release.set(); warmup.join(2); ranking.join(2)

    def test_cancellation_while_waiting_for_inference_lock(self):
        cancel, done = threading.Event(), threading.Event()
        errors = []
        def ranking():
            try: semantic.semantic_scores({}, ['Question'], [paper(1)], cancel)
            except DiscoveryCancelled as error: errors.append(error)
            finally: done.set()
        semantic._inference_lock.acquire()
        try:
            thread = threading.Thread(target=ranking)
            thread.start(); cancel.set()
            self.assertTrue(done.wait(2))
            self.assertEqual(len(errors), 1)
        finally:
            semantic._inference_lock.release(); thread.join(2)


if __name__ == '__main__': unittest.main()
