import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-upgrade-'))
from pulse_core.ranking_evidence import dbef_quality,reference_coverage
from pulse_core.discovery_feedback import contrastive_profile,feedback_adjustment,feedback_for_context
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates as rank
from pulse_core import discovery_crossencoder as pairwise,discovery_semantics as semantic,pdf_utils
from pulse_core.citation_fields import extra_identity_checks,author_signature
from pulse_core.citation_identity import verify_candidate
from pulse_core.bibliography import split_references,reference_metadata
from pulse_core.publication_records import crossref_publication_data,fold_explicit_versions
from pulse_core.publication_status import publication_status
from pulse_core.metadata_utils import crossref_to_metadata
from pulse_performance import DiscoveryCancelled


def paper(doi='10.1234/paper',**kwargs):
    return {'doi':doi,'title':'Scientific document retrieval methods','abstract':'Document indexing and scientific retrieval research.',**kwargs}


class EvidenceAndFeedbackTests(unittest.TestCase):
    def test_dbef_coverage_and_overlap_reduce_the_actual_ranking_influence(self):
        healthy={'candidateReferenceCoverage':1,'seedReferenceCoverage':1,'referenceMetadataCoverage':1,
            'sharedReferenceIds':[str(i) for i in range(20)],'contentFactor':1,'normalizedScore':1}
        sparse={**healthy,'candidateReferenceCoverage':.1,'seedReferenceCoverage':.1,'referenceMetadataCoverage':.1,'sharedReferenceIds':['one']}
        a=paper('10.1234/healthy',dbef=healthy,networkSimilarity=1,retrievalEvidence=[{'channel':'dbef','rank':2}])
        b=paper('10.1234/sparse',dbef=sparse,networkSimilarity=1,retrievalEvidence=[{'channel':'dbef','rank':1}])
        original=copy.deepcopy([a,b]);found=rank({'citationNetwork':[b,a]},[],{'researchQuestion':'Scientific document retrieval','diversify':False})
        self.assertEqual(found[0]['doi'],a['doi'])
        self.assertGreater(found[0]['scoreBreakdown']['dbefEvidenceQuality'],found[1]['scoreBreakdown']['dbefEvidenceQuality'])
        self.assertEqual([a,b],original)
        self.assertIsNone(reference_coverage(10,None));self.assertEqual(reference_coverage(10,100),.1)

    def test_direct_citation_evidence_is_not_removed_by_a_weak_dbef_path(self):
        p=paper(dbef={'sharedReferenceIds':['one']},networkSimilarity=1)
        found=rank({'citationGraph':[p]},[],{'researchQuestion':'Scientific retrieval'})[0]
        self.assertEqual(found['scoreBreakdown']['citationEvidence'],1)

    def test_contrastive_feedback_ignores_shared_vocabulary_and_learns_specific_concepts(self):
        positive=paper(title='Document retrieval with dense embeddings',abstract='Research on document retrieval and semantic embedding representations')
        negative=paper(title='Document retrieval with citation counts',abstract='Research on document retrieval and citation count popularity')
        profile=contrastive_profile([{'grade':1,'paper':positive},{'grade':0,'paper':negative}])
        self.assertNotIn('document',profile['weights'])
        self.assertIn('dense',profile['prefer'])
        self.assertIn('citation',profile['avoid'])
        wanted=feedback_adjustment(positive,profile)[0];avoided=feedback_adjustment(negative,profile)[0]
        self.assertGreater(wanted,0);self.assertLess(avoided,0)

    def test_feedback_remains_scoped_to_question_and_seed_identity(self):
        payload={'researchQuestion':'Current topic','feedbackContext':{'researchQuestion':'Previous topic','seedPapers':[]},'relevanceFeedback':[{'grade':1,'paper':paper()}]}
        self.assertEqual(feedback_for_context(payload,[]),[])

    def test_semantic_feedback_distinguishes_synonyms_with_shared_cached_vectors(self):
        positive=paper('10.1234/positive',title='Dense embeddings')
        negative=paper('10.1234/negative',title='Citation popularity')
        candidate=paper('10.1234/candidate',title='Semantic representations')
        feedback=[{'grade':1,'paper':positive},{'grade':0,'paper':negative}];contrast={}
        def resolve(identity,texts,*args):
            return {text:([1.,0.]+[0.]*6 if 'Citation popularity' not in text else [0.,1.]+[0.]*6) for text in texts}
        with patch.object(semantic,'local_model',return_value=('local','fixture')),patch.object(semantic,'_resolve',side_effect=resolve):
            scores,_=semantic.semantic_scores({},['Question'],[candidate],feedback=feedback,feedback_scores=contrast)
        self.assertEqual(contrast[candidate['doi']],1)
        self.assertEqual(len(scores),1)

    def test_impact_percentiles_preserve_ties_and_small_field_fallback(self):
        records=[paper('10.1234/'+str(i),title='Document retrieval method '+str(i),citationCount=count,year='2020',field='one') for i,count in enumerate((1,1,10))]
        found=rank({'concepts':records},[],{'researchQuestion':'Document retrieval','diversify':False})
        impacts={p['citationCount']:p['scoreBreakdown']['optionalImpact'] for p in found}
        self.assertEqual(impacts[1],0);self.assertAlmostEqual(impacts[10],2/3,places=3)


class PairwiseSpeedTests(unittest.TestCase):
    def setUp(self):pairwise.clear_score_cache()
    def test_one_window_preserves_tail_evidence_without_changing_the_paper(self):
        p=paper(abstract=('Unrelated boilerplate. '*400)+'The decisive semantic retrieval evidence appears at the end.')
        original=copy.deepcopy(p);prepared=pairwise.ranking_excerpt(p,['semantic retrieval evidence'])
        self.assertIn('decisive semantic retrieval evidence',prepared['abstract'])
        self.assertLessEqual(len(prepared['abstract'].split()),120);self.assertEqual(p,original)

    def test_repeated_scores_are_cached_and_metadata_or_query_changes_invalidate_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);runtime=root/'python';runtime.write_text('fixture');model=root/'model';model.mkdir();(model/'model.onnx').write_text('model')
            with patch.object(pairwise,'_find_search_runtime',return_value=(runtime,model)),patch.object(pairwise,'_infer',return_value=([.8],'fixture')) as infer:
                first=pairwise.crossencoder_scores({},['Question'],[paper()]);second=pairwise.crossencoder_scores({},['Question'],[paper()])
                self.assertEqual(first[0],second[0]);self.assertEqual(infer.call_count,1)
                pairwise.crossencoder_scores({},['A different question'],[paper()]);self.assertEqual(infer.call_count,2)
                pairwise.crossencoder_scores({},['Question'],[paper(abstract='Changed retrieval evidence.')]);self.assertEqual(infer.call_count,3)

    def test_cache_does_not_override_cancellation(self):
        event=threading.Event();event.set()
        with self.assertRaises(DiscoveryCancelled):pairwise.crossencoder_scores({},['Question'],[paper()],event)


class CitationPrecisionTests(unittest.TestCase):
    META={'title':'Scientific document retrieval methods','doi':'10.1234/paper','authors':['John A. Smith','Alice Lee'],
        'authorDetails':[{'family':'Smith','given':'John A.','ORCID':'https://orcid.org/0000-0001-1111-1111'},{'family':'Lee','given':'Alice'}],
        'year':'2026','date':'2026-02-04','publicationDates':{'published-online':'2025-12-03','published-print':'2026-02-04'},
        'journal':'Proceedings of the National Academy of Sciences','volume':'12','issue':'2','pages':'121-129'}
    def test_initials_journal_abbreviations_short_pages_and_date_precision_agree(self):
        candidate=paper(authors=['Smith JA','Lee A'],year='2026',journal='PNAS',volume='012',issue='2',pages='121–9',date='2026-02')
        checks=extra_identity_checks(candidate,self.META)
        self.assertTrue(checks['authorInitials']);self.assertTrue(checks['journal']);self.assertTrue(checks['pages']);self.assertTrue(checks['publicationDate'])

    def test_conflicting_extra_fields_are_rejected_and_missing_precision_is_unknown(self):
        candidate=paper(authors=['Smith B'],year='2026',journal='Nature',volume='13',pages='40-50',date='2026-02-05')
        with patch('pulse_core.citation_identity.lookup_doi_metadata',return_value={'metadata':self.META,'source':'Crossref'}):result=verify_candidate(candidate)
        self.assertFalse(result['verified']);self.assertIn('authorInitials',result['conflicts']);self.assertIn('publicationDate',result['conflicts'])
        checks=extra_identity_checks(paper(date='2026-02-04'),{**self.META,'date':'2026','publicationDates':{}})
        self.assertIsNone(checks['publicationDate'])

    def test_reference_initials_survive_bibliography_matching(self):
        p=reference_metadata('Smith, J. A., & Lee, A. (2026b). Scientific document retrieval methods. PNAS, 12(2), 121-129.')
        self.assertEqual(p['referenceYearSuffix'],'b');self.assertEqual(p['referenceAuthorDetails'][0]['given'].strip(),'J. A.')
        self.assertEqual(author_signature(p['referenceAuthorDetails'][0])['initials'],'ja')

    def test_orcid_conflicts_are_explicit(self):
        checks=extra_identity_checks(paper(authorDetails=[{'family':'Smith','given':'John','ORCID':'0000-0002-2222-2222'}]),self.META)
        self.assertFalse(checks['orcid'])

    def test_journal_abbreviations_and_issn_formatting_do_not_create_conflicts(self):
        candidate=paper(journal='Proc Natl Acad Sci')
        self.assertTrue(extra_identity_checks(candidate,self.META)['journal'])
        self.assertTrue(extra_identity_checks(paper(journal='Registry abbreviation',issn='1234567x'),
                         {**self.META,'issn':'1234-567X'})['journal'])


class PublicationRecordTests(unittest.TestCase):
    def test_metadata_merging_retains_independent_relationships_and_true_retraction(self):
        from pulse_core.metadata_utils import merge_metadata
        base={'publicationRelations':[{'type':'has-preprint','doi':'10.1234/pre'}],
              'publicationDates':{'issued':'2026-02'},'isRetracted':True}
        incoming={'publicationRelations':[{'type':'is-version-of','doi':'10.1234/v1'}],
                  'publicationDates':{'published-online':'2026-01-03'},'isRetracted':False}
        result=merge_metadata(base,incoming)
        self.assertEqual(len(result['publicationRelations']),2)
        self.assertEqual(result['publicationDates']['published-online'],'2026-01-03')
        self.assertTrue(result['isRetracted']);self.assertEqual(len(base['publicationRelations']),1)

    def test_notice_is_not_mistaken_for_the_article_it_updates(self):
        record={'DOI':'10.1234/notice','update-to':[{'DOI':'10.1234/original','type':'retraction','updated':{'date-parts':[[2026,2,4]]}}]}
        result=crossref_publication_data(record)
        self.assertEqual(result['publicationRole'],'notice');self.assertEqual(result['publicationNotices'][0]['relation'],'updates')
        self.assertNotIn('isRetracted',result)

    def test_explicit_version_relations_group_renamed_preprint_and_published_article(self):
        preprint=paper('10.1234/pre',title='Earlier title',publicationType='posted-content',score=90,citationCount=100,
            publicationRelations=[{'type':'is-preprint-of','doi':'10.1234/pub'}])
        published=paper('10.1234/pub',title='Different final title',publicationType='journal-article',score=50,citationCount=10)
        found=fold_explicit_versions([preprint,published]);self.assertEqual(len(found),1)
        self.assertEqual(found[0]['doi'],published['doi']);self.assertEqual(found[0]['citationCount'],10)
        self.assertEqual(found[0]['relatedVersions'][0]['doi'],preprint['doi'])

    def test_update_notice_is_kept_separate_even_with_a_version_pointer(self):
        notice=paper('10.1234/notice',publicationRole='notice',score=40,publicationRelations=[{'type':'is-version-of','doi':'10.1234/paper'}])
        self.assertEqual(len(fold_explicit_versions([notice,paper(score=50)])),2)

    def test_selected_doi_finds_reverse_updates_without_guessing_from_a_title(self):
        original={'DOI':'10.1234/paper','title':['Scientific document retrieval methods']}
        notice={'DOI':'10.1234/notice','update-to':[{'DOI':'10.1234/paper','type':'retraction','source':'retraction-watch'}]}
        with patch('pulse_core.publication_status.fetch_json',side_effect=[{'message':original},{'message':{'items':[notice],'total-results':1}}]):result=publication_status({'doi':'10.1234/paper'})
        self.assertTrue(result['available']);self.assertTrue(result['metadata']['isRetracted'])
        self.assertEqual(result['metadata']['publicationNotices'][0]['doi'],'10.1234/notice')

    def test_unavailable_status_does_not_clear_existing_notices(self):
        with patch('pulse_core.publication_status.fetch_json',side_effect=TimeoutError()):result=publication_status({'doi':'10.1234/paper'})
        self.assertFalse(result['available']);self.assertNotIn('metadata',result)


class LayoutOCRTests(unittest.TestCase):
    def make_pdf(self):
        import pymupdf as fitz
        doc=fitz.open();page=doc.new_page();page.insert_text((45,55),'References',fontsize=15)
        page.insert_textbox(fitz.Rect(40,80,290,250),'[1] Brooks A. (2026). Indexing methods.\nRetrieval Journal. 2: 10-20.\n[2] Lee S. (2025). Search relevance.\nResearch Journal. 3: 20-30.',fontsize=11)
        page.insert_textbox(fitz.Rect(325,80,585,250),'[3] Chen M. (2024). Topic matching.\nLibrary Journal. 1: 30-40.\n[4] Jones T. (2023). Record linkage.\nData Journal. 2: 40-50.',fontsize=11)
        return doc
    def setUp(self):
        try:import pymupdf
        except ImportError:self.skipTest('PyMuPDF required for layout/OCR integration')
    def test_columns_are_read_in_order_instead_of_interleaving_references(self):
        with self.make_pdf() as doc:result=pdf_utils.extract_document(doc.tobytes(),'columns.pdf')
        self.assertEqual(result['bibliographyProvenance']['layoutPages'],[1])
        self.assertLess(result['text'].index('[2]'),result['text'].index('[3]'))
        self.assertEqual(len(split_references(result['text'].split('References\n',1)[1])),4)
    def test_scanned_reference_page_is_read_with_bundled_local_language_data(self):
        import pymupdf as fitz
        with self.make_pdf() as source,fitz.open() as scan:
            page=scan.new_page();page.insert_image(page.rect,stream=source[0].get_pixmap(dpi=150).tobytes('png'))
            result=pdf_utils.extract_document(scan.tobytes(),'scan.pdf')
        self.assertEqual(result['bibliographyProvenance']['ocrPages'],[1]);self.assertIn('Indexing methods',result['text'])
    def test_ocr_failure_is_visible_and_never_invents_text(self):
        import pymupdf as fitz
        with self.make_pdf() as source,fitz.open() as scan:
            page=scan.new_page();page.insert_image(page.rect,stream=source[0].get_pixmap(dpi=150).tobytes('png'))
            with patch.object(pdf_utils,'local_ocr',side_effect=RuntimeError('Missing engine')):result=pdf_utils.extract_document(scan.tobytes(),'scan.pdf')
        self.assertFalse(result['bibliographyProvenance']['completeExtraction']);self.assertTrue(result['bibliographyProvenance']['warnings'])
        self.assertEqual(result['text'],'')


if __name__=='__main__':unittest.main()
