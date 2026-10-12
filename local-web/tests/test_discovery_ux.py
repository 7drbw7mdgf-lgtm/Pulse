import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-ux-tests-'))
import pulse_core as core
from pulse_core import discovery
from pulse_core.metadata_utils import crossref_to_metadata, openalex_to_metadata, merge_metadata
from pulse_core.s2_client import s2_to_metadata
from pulse_core.recommendations import dimensions_recommendation_item
from pulse_core.literature_search import europe_pmc_to_metadata
from pulse_core.search_limits import SearchResults
from pulse_core.search_merge import merge_search_records


class DiscoveryStatusTests(unittest.TestCase):
    def run_with_rows(self, rows):
        updates = []
        def collect(tasks, progress, cancel):
            result = {'citationGraph': rows}
            progress(result, ['citationGraph'], {}, 1)
            return result, ['citationGraph'], {}
        payload = {'seedPapers': [{'title': 'Library indexing methods'}],
                   'branches': {'citationGraph': True, 'citationNetwork': False,
                                'semanticSearch': False, 'lexicalSearch': False},
                   'semanticRerank': False, 'pairwiseRerank': False}
        with patch.object(core, 'load_settings', return_value={}), \
             patch.object(discovery, 'parallel_branches', side_effect=collect):
            result = discovery.run_discovery_pipeline(payload, on_progress=updates.append)
        return result, updates

    def test_expected_hop_limit_is_information_in_live_and_completed_results(self):
        rows = SearchResults([{'title': 'Library indexing study', 'doi': '10.1234/index'}])
        rows.notices.append({'code': 'extra-hop-limit', 'message': 'Extra hops stopped at the limit.'})
        result, updates = self.run_with_rows(rows)
        for event in [result] + [u for u in updates if u.get('recommendations')]:
            self.assertEqual(event['errors'], {})
            self.assertEqual(event['notices']['citationGraph'][0]['code'], 'extra-hop-limit')
            self.assertEqual(event['sourceCounts']['citationGraph'], 1)
        self.assertEqual(len(result['recommendations']), 1)

    def test_real_provider_warning_survives_an_informational_hop_limit(self):
        rows = SearchResults([{'title': 'Library indexing study'}])
        rows.warning = 'Reference lookup failed.'
        rows.notices.append({'code': 'extra-hop-limit', 'message': 'Extra hops stopped at the limit.'})
        result, _ = self.run_with_rows(rows)
        self.assertEqual(result['errors']['citationGraph'], rows.warning)
        self.assertTrue(result['notices']['citationGraph'])

    def test_notices_are_not_shared_between_searches(self):
        first, second = SearchResults(), SearchResults()
        first.notices.append({'code': 'extra-hop-limit'})
        self.assertEqual(second.notices, [])


class CitationCountTests(unittest.TestCase):
    def providers(self, value=None, missing=False):
        fields = lambda key: {} if missing else {key: value}
        return [crossref_to_metadata({'title': ['Indexing study'], **fields('is-referenced-by-count')}),
                openalex_to_metadata({'title': 'Indexing study', **fields('cited_by_count')}),
                s2_to_metadata({'title': 'Indexing study', **fields('citationCount')}),
                dimensions_recommendation_item({'title': 'Indexing study', **fields('times_cited')})[0],
                europe_pmc_to_metadata({'title': 'Indexing study', **fields('citedByCount')})]

    def test_missing_and_invalid_counts_remain_unknown(self):
        for missing, value in [(True, None), (False, None), (False, ''), (False, -1),
                               (False, True), (False, 2.5)]:
            for row in self.providers(value, missing):
                with self.subTest(source=row['metadataSource'], value=value, missing=missing):
                    self.assertIsNone(row.get('citationCount'))
                    self.assertFalse(row.get('citationCountSource'))
                    self.assertFalse(row.get('citationCountsBySource'))

    def test_explicit_zero_and_positive_counts_have_provenance(self):
        for value in [0, 17, '0', '17']:
            for row in self.providers(value):
                source = row['metadataSource']
                self.assertEqual(row['citationCount'], int(value))
                self.assertEqual(row['citationCountsBySource'][source], int(value))
                self.assertEqual(row['citationCountSource'], source)

    def test_merging_fills_a_known_zero_but_never_overwrites_a_known_count_with_unknown(self):
        unknown = openalex_to_metadata({'title': 'Indexing study'})
        zero = s2_to_metadata({'title': 'Indexing study', 'citationCount': 0})
        known = crossref_to_metadata({'title': ['Indexing study'], 'is-referenced-by-count': 12})
        for merge in [lambda rows: merge_search_records(rows)[0],
                      lambda rows: merge_metadata(merge_metadata(rows[0], rows[1]), rows[2])]:
            row = merge([unknown, zero, known])
            self.assertEqual(row['citationCount'], 12)
            self.assertEqual(row['citedByCount'], 12)
            self.assertEqual(row['citationCountSource'], 'Crossref')
            self.assertEqual(row['citationCountsBySource']['Semantic Scholar'], 0)
            row = merge([known, unknown, zero])
            self.assertEqual(row['citationCount'], 12)
            self.assertEqual(row['citationCountSource'], 'Crossref')
        row = merge_metadata(unknown, zero)
        self.assertEqual(row['citationCount'], 0)
        self.assertEqual(row['citationCountSource'], 'Semantic Scholar')


if __name__ == '__main__':
    unittest.main()
