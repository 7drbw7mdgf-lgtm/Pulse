"""Discovery results explain why each paper was found, in plain language (1.8)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-reasons-test-'))
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank, why_found, _surname
from pulse_core.search_merge import clean_title, merge_search_records
from pulse_core import literature_search

SEED = {'title': 'Campylobacter jejuni outer membrane vesicles and intestinal epithelial cells',
        'abstract': 'Outer membrane vesicles deliver cytolethal distending toxin to intestinal epithelial cells.',
        'authors': ['Abdi Elmi', 'Ozan Gundogdu', 'Brendan W. Wren', 'Nick Dorrell'], 'year': '2012',
        'paperKeywords': ['outer membrane vesicles', 'cytolethal distending toxin', 'intestinal epithelial cells']}


def paper(title, doi, authors=('Someone Else',), **extra):
    return dict(title=title, abstract='Outer membrane vesicles and intestinal epithelial cells in Campylobacter jejuni.',
                doi=doi, authors=list(authors), year='2019', **extra)


def kinds(record):
    return [item['kind'] for item in record['whyFound']]


class SurnameTests(unittest.TestCase):
    def test_name_forms(self):
        for name in ('Abdi Elmi', 'Elmi, Abdi', 'A. Elmi', 'Elmi A', 'ELMI A.'):
            with self.subTest(name=name):
                self.assertEqual(_surname(name), 'elmi')
        self.assertEqual(_surname('Cezary Czaplewski (1522870)'), 'czaplewski')


class WhyFoundTests(unittest.TestCase):
    def test_shared_authors_and_citation_direction(self):
        record = paper('OMV proteases cleave E-cadherin', '10.1/a', ['A. Elmi', 'F. Nasher', 'O. Gundogdu', 'N. Dorrell'],
                       retrievalEvidence=[{'channel': 'citations:0:forward'}, {'channel': 'concepts:q1'}], sourceList=['Semantic Scholar'])
        why = why_found(record, [SEED], {})
        self.assertEqual([item['kind'] for item in why][:2], ['authors', 'cites-seed'])
        self.assertEqual(why[0]['label'], 'Shares 3 authors')
        self.assertEqual(why[0]['detail'], 'Shares authors with your seed: Elmi, Gundogdu, Dorrell')
        self.assertEqual(why[1]['detail'], 'This paper cites your seed paper')
        topic = next(item for item in why if item['kind'] == 'topic')
        self.assertEqual(topic['detail'], 'Matches your topic: outer membrane vesicles, intestinal epithelial cells')
        self.assertNotIn('search', [item['kind'] for item in why], 'search provenance only when nothing better explains it')

    def test_backward_cocitation_coupling_and_chase(self):
        record = paper('A foundational study', '10.1/b', retrievalEvidence=[
            {'channel': 'citations:0:backward'},
            {'channel': 'citationNetwork', 'subType': 'Co-citation', 'detail': 'Co-citation triangulation: cited together with seed paper by 7 citing papers.'},
            {'channel': 'citationNetwork', 'subType': 'Bibliographic coupling', 'detail': 'Bibliographic coupling: shares 4 foundational references with seed paper.'},
            {'channel': 'citationGraph', 'subType': 'Iterative Chase (2-Hop)', 'via': 'Bridging review of vesicles'}])
        why = {item['kind']: item for item in why_found(record, [SEED], {})}
        self.assertEqual(why['cited-by-seed']['detail'], 'Your seed paper cites this paper')
        self.assertEqual(why['co-cited']['detail'], 'Cited together with your seed paper by 7 citing papers.')
        self.assertEqual(why['shared-references']['detail'], 'Shares 4 foundational references with your seed paper.')
        self.assertEqual(why['two-steps']['detail'], 'Linked to your seed through "Bridging review of vesicles"')

    def test_search_only_and_multiple_seeds(self):
        record = paper('Unrelated wording', '10.1/c', sourceList=['Europe PMC'], branches=['europePmc'])
        record['abstract'] = 'Nothing in common.'
        why = why_found(record, [SEED, dict(SEED, authors=[])], {})
        self.assertEqual([item['kind'] for item in why], ['search'])
        self.assertEqual(why[0]['detail'], 'Found by topic search in Europe PMC')
        forward = paper('X', '10.1/d', retrievalEvidence=[{'channel': 'citations:1:forward'}])
        self.assertEqual(why_found(forward, [SEED, SEED], {})[0]['detail'], 'This paper cites one of your seed papers')

    def test_reasons_survive_merging_across_sources(self):
        cited = paper('Vesicle study', '10.1/e', ['A. Elmi'], subType='Forward', retrievalEvidence=[{'channel': 'citations:0:forward', 'rank': 1}])
        searched = paper('Vesicle study', '10.1/e', ['A. Elmi'], sourceList=['Europe PMC'])
        found = rank({'citationGraph': [cited], 'europePmc': [searched]}, [SEED], {})
        self.assertEqual(len(found), 1)
        self.assertIn('cites-seed', kinds(found[0]))
        self.assertIn('authors', kinds(found[0]))
        self.assertEqual(found[0]['matchReasons'][0], 'Shares authors with your seed: Elmi')


class RecordCleanupTests(unittest.TestCase):
    def test_titles_lose_markup(self):
        self.assertEqual(clean_title('<i>Campylobacter jejuni</i> extracellular vesicles &amp; CDT'), 'Campylobacter jejuni extracellular vesicles & CDT')
        merged = merge_search_records([{'title': '<i>C. jejuni</i>  OMVs', 'doi': '10.1/x'}])
        self.assertEqual(merged[0]['title'], 'C. jejuni OMVs')

    def test_unknown_citation_counts_do_not_hide_real_ones(self):
        core = literature_search.provider_metadata({}, 'CORE', 'id', literature_search.number(0) or None)
        self.assertNotIn('citationCount', core, 'CORE 0 means no citation data')
        merged = merge_search_records([
            {'title': 'A', 'doi': '10.1/y', 'citationCount': 0, 'citationCountSource': 'Index A'},
            {'title': 'A', 'doi': '10.1/y', 'citationCount': 41, 'citationCountSource': 'OpenAlex'}])
        self.assertEqual((merged[0]['citationCount'], merged[0]['citationCountSource']), (41, 'OpenAlex'))


if __name__ == '__main__':
    unittest.main()
