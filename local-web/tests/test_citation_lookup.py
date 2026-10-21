import os
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-citation-test-'))
from pulse_core import citation_lookup as lookup, metadata_resolution as resolution, literature_search


def record(doi='10.1234/matched', family='Martín-González', year=2026, title='A synthetic retrieval paper'):
    return {'DOI':doi, 'title':[title], 'author':[{'given':'Ana','family':family},{'given':'Sam','family':'Lee'}],
            'issued':{'date-parts':[[year]]}, 'container-title':['Retrieval Studies'], 'volume':'2', 'page':'1-9'}


class CitationLookupTests(unittest.TestCase):
    def test_unicode_narrative_grouped_and_suffix_parsing(self):
        for value in ['(Martín-González et al., 2026)', 'Martín-González et al. (2026)', 'Martín-González, 2026']:
            found=lookup.parse_in_text_citations(value)
            self.assertEqual(found[0]['authors'],['Martín-González'])
            self.assertEqual(found[0]['year'],'2026')
        groups=lookup.parse_in_text_citations('(Smith & Lee, 2024a; van der Meer et al., 2023)')
        self.assertEqual(groups[0]['authors'],['Smith','Lee'])
        self.assertEqual(groups[0]['suffix'],'a')
        self.assertEqual(groups[1]['authors'],['van der Meer'])
        self.assertEqual(len(lookup.parse_in_text_citations('(Smith, 2024; Smith, 2024)')),1)

    def test_titles_full_references_and_invalid_input_are_not_short_citations(self):
        for text in ['10.1234/paper', 'PMID 2026', 'A study on retrieval 2026', 'Smith (2024). A full reference title. Journal.', 'Smith, 2024\nMore text']:
            self.assertEqual(lookup.parse_in_text_citations(text),[],text)

    def test_first_author_exact_year_and_coauthors_required(self):
        group=lookup.parse_in_text_citations('(Martín-González & Lee, 2026)')[0]
        self.assertTrue(lookup.citation_agrees(group,{'year':'2026','authors':['Ana Martin Gonzalez','Sam Lee']}))
        for metadata in [{'year':'2025','authors':['Ana Martín-González','Sam Lee']},
                         {'year':'2026','authors':['Sam Lee','Ana Martín-González']},
                         {'year':'2026','authors':['Ana Martín-González','Sam Smith']}]:
            self.assertFalse(lookup.citation_agrees(group,metadata))
        self.assertFalse(lookup.surname_matches('Smith','Ada Goldsmith'))

    def test_online_query_registry_doi_full_metadata_and_no_automatic_identity(self):
        calls=[]
        def fetch(url):
            calls.append(url)
            if 'crossref' in url:return {'message':{'items':[record(),record('10.1234/second',title='Another synthetic paper'),record('10.1234/wrong',year=2025)]}}
            return {'results':[{'id':'https://openalex.org/W1','doi':'https://doi.org/10.1234/matched','title':'A synthetic retrieval paper',
                'publication_year':2026,'authorships':[{'author':{'display_name':'Ana Martín-González'}},{'author':{'display_name':'Sam Lee'}}]}]}
        with patch.object(lookup,'fetch_json',side_effect=fetch):
            result=resolution.resolve_metadata({'text':'(Martín-González et al., 2026)','parseInput':True,'context':'retrieval'})
        self.assertFalse(result['matched'])
        self.assertTrue(result['needsSelection'])
        self.assertEqual(result['candidateCount'],2)
        papers=result['groups'][0]['candidates']
        paper=next(p for p in papers if p['doi']=='10.1234/matched')
        self.assertTrue(paper['doiVerified'])
        self.assertEqual(paper['volume'],'2')
        self.assertIsNone(paper.get('citationCount'))
        cross=urllib.parse.parse_qs(urllib.parse.urlsplit(next(u for u in calls if 'crossref' in u)).query)
        self.assertEqual(cross['query.author'],['Martín-González'])
        self.assertEqual(cross['query.title'],['retrieval'])
        self.assertIn('2026-12-31',cross['filter'][0])
        alex=urllib.parse.parse_qs(urllib.parse.urlsplit(next(u for u in calls if 'openalex' in u)).query)
        self.assertIn('raw_author_name.search:Martín-González',alex['filter'][0])

    def test_single_candidate_still_needs_selection_and_failure_keeps_other_source(self):
        def fetch(url):
            if 'openalex' in url:raise TimeoutError('Unavailable')
            return {'message':{'items':[record()]}}
        with patch.object(lookup,'fetch_json',side_effect=fetch):
            result=lookup.lookup_in_text_citations({'text':'Martín-González (2026)'})
        self.assertEqual(result['candidateCount'],1)
        self.assertFalse(result['matched'])
        self.assertTrue(result['partial'])

    def test_europe_pmc_paginates_beyond_old_limit_with_safe_page_size(self):
        calls=[]
        def fetch(url,source,timeout=14):
            query=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            calls.append((query['cursorMark'][0],int(query['pageSize'][0])))
            start=0 if query['cursorMark'][0]=='*' else 1000
            return {'resultList':{'result':[{'id':str(i),'source':'MED','title':f'Indexing paper {i}'} for i in range(start,start+int(query['pageSize'][0]))]},'nextCursorMark':'second'}
        with patch.object(literature_search,'fetch_search',side_effect=fetch):
            results=literature_search.search_europe_pmc('indexing',limit=1500)
        self.assertEqual(len(results),1500)
        self.assertEqual(calls,[('*',1000),('second',500)])


if __name__=='__main__':unittest.main()
