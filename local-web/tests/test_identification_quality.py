"""Paper identification and duplicate handling added in 1.6.

Fixtures mirror real failures seen against live indexes: review records that
repeat a famous title, near-identical titles of different papers, subtitle
and typo variants, repository copies and supplementary-file DOIs.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-identity-test-'))
from pulse_core import metadata_resolution as r
from pulse_core.search_merge import canonical_doi, sane_year, merge_search_records
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank

ALPHAFOLD = 'Highly accurate protein structure prediction with AlphaFold'
LANCET = 'Clinical features of patients infected with 2019 novel coronavirus in Wuhan, China'


def crossref(doi, title, year=2021, family='Jumper', kind='journal-article', cited=0):
    return {'DOI': doi, 'title': [title], 'author': [{'given': 'J.', 'family': family}],
            'container-title': ['Nature'], 'issued': {'date-parts': [[year]]}, 'type': kind,
            'is-referenced-by-count': cited}


def openalex(doi, title, year=2021, name='John Jumper', cited=0, kind='article'):
    return {'doi': 'https://doi.org/' + doi, 'title': title, 'publication_year': year, 'type': kind,
            'authorships': [{'author': {'display_name': name}}], 'cited_by_count': cited}


def fake_services(crossref_items, openalex_items=()):
    def fetch(url):
        if 'api.crossref.org' in url:
            return {'message': {'items': list(crossref_items)}}
        return {'results': list(openalex_items)}
    return fetch


def resolve(text, crossref_items, openalex_items=()):
    with patch.object(r, 'fetch_json', side_effect=fake_services(crossref_items, openalex_items)), \
         patch('pulse_core.literature_search.request_json', side_effect=TimeoutError('offline')):
        return r.resolve_metadata({'text': text, 'parseInput': True})


class TitleMatchingTests(unittest.TestCase):
    def test_word_order_matters(self):
        self.assertLess(r.title_similarity('Attention is all you need', 'Is Attention All You Need?'), .95)
        self.assertFalse(r.candidate_score({'title': 'Attention is all you need'},
                                           {'title': 'Is Attention All You Need?'})['accepted'])

    def test_near_identical_title_of_another_paper_is_rejected_on_title_alone(self):
        other = 'Clinical features of familial clustering in patients infected with 2019 novel coronavirus in Wuhan, China'
        self.assertFalse(r.candidate_score({'title': LANCET}, {'title': other})['accepted'])

    def test_missing_subtitle_and_typo_still_match(self):
        short = 'Revisiting Campylobacter jejuni virulence and fitness factors'
        full = 'Revisiting Campylobacter jejuni Virulence and Fitness Factors: Role in Sensing, Adapting, and Competing'
        self.assertTrue(r.candidate_score({'title': short}, {'title': full})['accepted'])
        self.assertTrue(r.candidate_score({'title': 'Highly acurate protein structure prediction with AlphaFold'},
                                          {'title': ALPHAFOLD})['accepted'])

    def test_typographic_punctuation_and_accents_do_not_change_a_title(self):
        self.assertEqual(r.title_similarity('STRING v11: protein-protein association networks',
                                            'STRING v11: protein\u2013protein association networks'), 1.0)
        self.assertEqual(r.title_similarity('Caf\u00e9 culture and \u201cthird places\u201d', 'Cafe culture and "third places"'), 1.0)

    def test_one_changed_word_is_a_different_paper(self):
        mice = 'Effects of dietary fibre on gut microbiota composition and inflammation in mice'
        rats = 'Effects of dietary fibre on gut microbiota composition and inflammation in rats'
        self.assertFalse(r.candidate_score({'title': mice}, {'title': rats})['accepted'])

    def test_partial_title_needs_two_supporting_fields(self):
        partial = {'title': 'Clinical features of patients with 2019 novel coronavirus in Wuhan'}
        candidate = {'title': LANCET, 'authors': ['Chaolin Huang'], 'year': '2020', 'journal': 'The Lancet'}
        self.assertFalse(r.candidate_score(partial, {'title': LANCET})['accepted'])
        self.assertTrue(r.candidate_score({**partial, 'authors': ['Huang C'], 'year': '2020', 'journal': 'Lancet'},
                                          candidate)['accepted'])
        self.assertTrue(r.candidate_score({'title': LANCET.replace(', China', '')}, {'title': LANCET})['accepted'])


class CandidateSearchTests(unittest.TestCase):
    def test_review_records_are_ignored_and_openalex_finds_the_paper(self):
        reviews = [crossref(f'10.3410/f.7404.{i}', f'Faculty Opinions recommendation of {ALPHAFOLD}.') for i in range(5)]
        found = resolve(ALPHAFOLD, reviews, [openalex('10.1038/s41586-021-03819-2', ALPHAFOLD, cited=30000)])
        self.assertTrue(found['matched'])
        self.assertEqual(found['metadata']['doi'], '10.1038/s41586-021-03819-2')

    def test_wrong_paper_with_similar_title_is_not_attached(self):
        other = crossref('10.1016/j.virusres.2020.198043',
                         'Clinical features of familial clustering in patients infected with 2019 novel coronavirus in Wuhan, China', 2020, 'Xia')
        found = resolve(LANCET, [other])
        self.assertFalse(found['matched'])
        self.assertNotIn('doi', found['metadata'])

    def test_unrelated_journal_article_does_not_beat_a_famous_preprint(self):
        title = 'Attention is all you need'
        found = resolve(title, [], [openalex('10.48550/arxiv.1706.03762', title, 2017, 'Ashish Vaswani', 100000, 'preprint'),
                                    openalex('10.9999/other', title, 2023, 'Someone Else', 4)])
        self.assertEqual(found['metadata'].get('doi'), '10.48550/arxiv.1706.03762')

    def test_published_version_preferred_over_preprint(self):
        found = resolve(ALPHAFOLD, [crossref('10.1101/2021.01.01.000001', ALPHAFOLD, kind='posted-content'),
                                    crossref('10.1038/s41586-021-03819-2', ALPHAFOLD)])
        self.assertTrue(found['matched'])
        self.assertEqual(found['metadata']['doi'], '10.1038/s41586-021-03819-2')

    def test_exact_title_tie_resolved_only_by_decisive_citation_gap(self):
        title = 'Attention is all you need'
        decisive = resolve(title, [], [openalex('10.48550/arxiv.1706.03762', title, 2017, 'Ashish Vaswani', 100000),
                                       openalex('10.9999/other', title, 2023, 'Someone Else', 4)])
        self.assertEqual(decisive['metadata'].get('doi'), '10.48550/arxiv.1706.03762')
        close = resolve(title, [], [openalex('10.1111/one', title, 2020, 'Ana Moreau', 40),
                                    openalex('10.1111/two', title, 2021, 'Ben Silva', 30)])
        self.assertFalse(close['matched'])
        self.assertTrue(close['ambiguous'])

    def test_exact_title_outranks_subtitle_extensions(self):
        title = 'Attention is all you need'
        found = resolve(title, [], [openalex('10.48550/arxiv.1706.03762', title, 2017, 'Ashish Vaswani', 5),
                                    openalex('10.2139/ssrn.1', title + ': an analysis of valuation', 2024, 'M Akpan', 5)])
        self.assertEqual(found['metadata'].get('doi'), '10.48550/arxiv.1706.03762')


class CitationParsingTests(unittest.TestCase):
    CITATION = ('Huang C, Wang Y, Li X, et al. Clinical features of patients infected with 2019 novel '
                'coronavirus in Wuhan, China. Lancet 2020;395(10223):497-506.')

    def test_vancouver_reference_fields(self):
        fields = r.extract_text_metadata(self.CITATION)
        self.assertEqual(fields['title'], LANCET)
        self.assertEqual(fields['journal'], 'Lancet')
        self.assertEqual((fields['year'], fields['volume'], fields['issue'], fields['pages']), ('2020', '395', '10223', '497-506'))
        self.assertEqual(fields['authors'], ['Huang C', 'Wang Y', 'Li X'])

    def test_pasted_reference_resolves_to_the_cited_paper(self):
        real = crossref('10.1016/S0140-6736(20)30183-5', LANCET, 2020, 'Huang')
        decoy = crossref('10.1016/j.virusres.2020.198043',
                         'Clinical features of familial clustering in patients infected with 2019 novel coronavirus in Wuhan, China', 2020, 'Xia')
        found = resolve(self.CITATION, [decoy, real])
        self.assertTrue(found['matched'])
        self.assertEqual(found['metadata']['doi'].lower(), '10.1016/s0140-6736(20)30183-5')
        self.assertNotIn('_citation', found['metadata'])


class DuplicateHandlingTests(unittest.TestCase):
    SEED = {'title': 'Protein structure prediction with deep learning', 'abstract': 'protein structure prediction deep learning',
            'authors': ['Ada Brooks'], 'year': '2021'}

    def paper(self, doi, title='Accurate prediction of protein assembly structure by combining AlphaFold and symmetrical docking',
              authors=('Mads Jeppesen', 'Ingemar André'), year='2023', **extra):
        return dict(title=title, abstract='protein structure prediction deep learning AlphaFold docking', doi=doi,
                    authors=list(authors), year=year, **extra)

    def test_supplementary_dois_and_impossible_years(self):
        self.assertEqual(canonical_doi('10.1021/acs.jctc.3c00528.s001'), '10.1021/acs.jctc.3c00528')
        self.assertEqual(canonical_doi('10.1371/journal.pone.0123456.g002'), '10.1371/journal.pone.0123456')
        self.assertEqual(canonical_doi('10.1038/s41586-021-03819-2'), '10.1038/s41586-021-03819-2')
        self.assertEqual(sane_year({'year': '1753', 'date': '1753-01-01'}), {'year': '', 'date': ''})
        self.assertEqual(sane_year({'year': '1943'})['year'], '1943')
        merged = merge_search_records([{'title': 'A', 'doi': '10.1021/acs.jctc.3c00528.s001'}, {'title': 'A', 'doi': '10.1021/acs.jctc.3c00528'}])
        self.assertEqual(len(merged), 1)

    def test_repository_copies_fold_into_the_publisher_record(self):
        found = rank({'core': [self.paper('10.5281/zenodo.10116276'), self.paper('10.1038/s41467-023-43681-6'),
                               self.paper('', authors=('Jeppesen MD', 'André I'))]}, [self.SEED], {})
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['doi'], '10.1038/s41467-023-43681-6')
        self.assertEqual(len(found[0]['relatedVersions']), 2)

    def test_distinct_publisher_editions_stay_separate(self):
        title = 'Comparative protein structure modeling using MODELLER'
        found = rank({'core': [self.paper('10.1002/0471250953.bi0506s15', title, year='2006'),
                               self.paper('10.1002/0471250953.bi0506s47', title, year='2014')]}, [self.SEED], {})
        self.assertEqual(len(found), 2)

    def test_numbered_series_from_the_same_authors_stay_separate(self):
        base = 'Structural analysis of bacterial outer membrane vesicle proteins using deep learning'
        found = rank({'core': [self.paper('10.1000/part1', base + ' part 1'), self.paper('10.1000/part2', base + ' part 2')]},
                     [self.SEED], {})
        self.assertEqual(len(found), 2)

    def test_generic_title_repeats_move_to_the_end(self):
        generic = [self.paper(f'10.1000/generic{i}', 'Protein structure prediction', (f'Author {name}',), str(1990 + i))
                   for i, name in enumerate(['Moreau', 'Silva', 'Novak', 'Haddad'])]
        specific = [self.paper(f'10.1000/specific{i}', f'Deep learning protein structure prediction method number {i}',
                               (f'Writer {name}',)) for i, name in enumerate(['Okafor', 'Lindqvist', 'Tanaka'])]
        found = rank({'core': generic + specific}, [self.SEED], {})
        titles = [item['title'] for item in found]
        self.assertEqual(len(found), 7)
        self.assertEqual(titles.count('Protein structure prediction'), 4)
        self.assertTrue(all(title == 'Protein structure prediction' for title in titles[-3:]))


if __name__ == '__main__':
    unittest.main()
