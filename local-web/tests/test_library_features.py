import base64
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
os.environ.setdefault('PULSE_CONFIG_DIR',tempfile.mkdtemp(prefix='pulse-feature-tests-'))
import pulse_core as core
from pulse_core import storage,pdf_reader,evidence_matrix
from pulse_core.library_merge import merge,merge_records
from pulse_core.constants import ClientError

class LibraryFeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.directory=Path(self.temp.name)
        for module,key,value in [(core,'CONFIG_DIR',self.directory),(core,'LIBRARY_PATH',self.directory/'library.json'),(pdf_reader,'CONFIG_DIR',self.directory)]:
            p=patch.object(module,key,value);p.start();self.addCleanup(p.stop)
        pdf_reader.page_text.cache_clear()
        self.a={'id':'a','title':'Campylobacter and stress','doi':'10.1234/a','year':'2024','notes':'First memo','userTags':['A'],'mapIds':['one'],'selected':True,'text':'Short text','pdfAnnotations':[{'id':'annotation-a'}]}
        self.b={'id':'b','title':'Campylobacter and stress','doi':'10.1234/a','year':'2023','notes':'Second memo','userTags':['B'],'mapIds':['two'],'selected':False,'text':'A longer full-text source','pdfAnnotations':[{'id':'annotation-b'}]}
    def test_merge_preserves_notes_tags_membership_attachments_and_aliases(self):
        merged=merge_records([self.a,self.b],'a','b',{'year':'b'})
        self.assertEqual(merged['year'],'2023');self.assertEqual(merged['id'],'a')
        self.assertEqual(merged['notes'],'First memo\n\nSecond memo');self.assertEqual(merged['userTags'],['A','B'])
        self.assertEqual(merged['mapIds'],['one','two']);self.assertEqual(len(merged['pdfAnnotations']),2)
        self.assertEqual({p['id'] for p in merged['mergedAliases']},{'a','b'});self.assertEqual(merged['text'],self.b['text'])
        self.assertEqual(self.a['notes'],'First memo')
    def test_merge_rejects_unselected_ids_and_invented_metadata(self):
        for keep,other,choices in [('a','a',{}),('a','missing',{}),('a','b',{'notes':'b'}),('a','b',{'year':'invented'})]:
            with self.assertRaises(ClientError):merge_records([self.a,self.b],keep,other,choices)
    def test_durable_merge_and_targeted_undo_preserve_unrelated_changes(self):
        before={'papers':[self.a,self.b,{'id':'c','title':'Other'}],'links':[{'source':'a','target':'b','score':.8},{'source':'b','target':'c','score':.7}],'libraryFeatures':{'collections':[{'id':'rule'}]}}
        result=merge({'keepId':'a','otherId':'b','choices':{},'workspace':before})
        self.assertEqual(len(storage.load_library()['papers']),2)
        self.assertEqual(result['workspace']['links'],[{'source':'a','target':'c','score':.7}])
        current=copy.deepcopy(result['workspace']);current['papers'][1]['notes']='New unrelated note';current['papers'][0]['x']=123
        restored=storage.restore_recovery({'id':result['recoveryId'],'workspace':current})['workspace']
        self.assertEqual(next(p for p in restored['papers'] if p['id']=='a'),self.a)
        self.assertEqual(next(p for p in restored['papers'] if p['id']=='b'),self.b)
        self.assertEqual(next(p for p in restored['papers'] if p['id']=='c')['notes'],'New unrelated note')
        self.assertEqual(restored['links'],before['links']);self.assertEqual(restored['libraryFeatures'],before['libraryFeatures'])
    def test_undo_does_not_silently_discard_new_master_edits(self):
        result=merge({'keepId':'a','otherId':'b','workspace':{'papers':[self.a,self.b]}})
        result['workspace']['papers'][0]['notes']='A later edit'
        with self.assertRaises(ClientError):storage.restore_recovery({'id':result['recoveryId'],'workspace':result['workspace']})
    def test_recovery_write_failure_keeps_library(self):
        before={'papers':[self.a,self.b]};storage.save_library(before)
        with patch.object(storage,'_write_recovery',side_effect=OSError('Disk full')):
            with self.assertRaises(OSError):merge({'keepId':'a','otherId':'b','workspace':before})
        self.assertEqual(storage.load_library()['papers'],before['papers'])
    def pdf(self):
        import pymupdf
        doc=pymupdf.open();p=doc.new_page();p.insert_text((50,70),'Campylobacter responds to oxidative stress.',fontsize=14)
        p=doc.new_page();p.insert_text((50,70),'A limitation is the small sample size.',fontsize=14)
        raw=doc.tobytes();doc.close();return raw
    def attachment(self):return pdf_reader.attach({'name':'Fixture.pdf','contentBase64':base64.b64encode(self.pdf()).decode()})
    def test_pdf_store_render_and_verified_page_quotation(self):
        a=self.attachment();self.assertEqual(a['pages'],2)
        page=pdf_reader.page({'id':a['id'],'page':2});self.assertTrue(page['image'].startswith('data:image/png;base64,'));self.assertGreater(len(page['words']),3)
        quote=pdf_reader.passage({'id':a['id'],'page':2,'quote':'A limitation is the small sample size.'})
        self.assertEqual(quote['page'],2);self.assertEqual(quote['pdfId'],a['id'])
        with self.assertRaises(ClientError):pdf_reader.passage({'id':a['id'],'page':1,'quote':quote['text']})
        with self.assertRaises(ClientError):pdf_reader.page({'id':a['id'],'page':3})
        if os.name!='nt':self.assertEqual(pdf_reader.path_for(a['id']).stat().st_mode&0o777,0o600)
    def test_pdf_rejects_arbitrary_paths_bad_data_and_oversized_upload(self):
        for identity in ['../../settings.json','/etc/passwd','file.pdf',None]:
            with self.assertRaises(ClientError):pdf_reader.path_for(identity)
        for content in ['!',base64.b64encode(b'Not a PDF').decode()]:
            with self.assertRaises(ClientError):pdf_reader.attach({'contentBase64':content})
        with patch.object(pdf_reader,'MAX_BYTES',3):
            with self.assertRaises(ClientError):pdf_reader.attach({'contentBase64':'AAAAAAAAAAAAAAAA'})
    def test_rotated_page_text_coordinates_follow_the_page_image(self):
        import pymupdf
        doc=pymupdf.open(stream=self.pdf(),filetype='pdf');doc[0].set_rotation(90);raw=doc.tobytes();doc.close()
        a=pdf_reader.attach({'contentBase64':base64.b64encode(raw).decode()})
        page=pdf_reader.page({'id':a['id'],'page':1});self.assertGreater(page['width'],page['height'])
        for word in page['words']:
            self.assertEqual(word['rotation'],90);self.assertGreaterEqual(word['box'][0],0);self.assertLessEqual(word['box'][2],page['width']);self.assertLessEqual(word['box'][3],page['height'])
    def test_matrix_uses_verified_reviewer_selected_pdf_quote(self):
        a=self.attachment();text='A limitation is the small sample size.'
        p={'id':'a','title':'Fixture','evidencePassages':[{'text':text,'page':2,'pdfId':a['id'],'evidenceColumn':'limitation','source':'Local PDF'}]}
        cell=evidence_matrix.extract_paper_cell({'id':'limitation'},p)
        self.assertTrue(cell['grounded']);self.assertTrue(cell['reviewerSelected']);self.assertEqual(cell['quote'],text)
        self.assertEqual(cell['provenance']['pdfId'],a['id']);self.assertEqual(cell['provenance']['paperId'],'a')
    def test_invalid_pdf_quotation_cannot_fall_through_as_grounded(self):
        a=self.attachment()
        p={'id':'a','title':'Fixture','evidencePassages':[{'text':'A limitation is a fabricated limitation.','page':1,'pdfId':a['id'],'evidenceColumn':'limitation','source':'Local PDF'}]}
        cell=evidence_matrix.extract_paper_cell({'id':'limitation'},p)
        self.assertFalse(cell['grounded']);self.assertEqual(cell['quote'],'')
    def test_fresh_pdf_quote_survives_saved_metadata_hydration(self):
        from pulse_core.research_evidence import local_paper
        a=self.attachment();block={'text':'A limitation is the small sample size.','page':2,'pdfId':a['id'],'evidenceColumn':'limitation'}
        incoming={'id':'a','title':'Fixture','evidencePassages':[block]}
        result=local_paper(incoming,[{'id':'a','title':'Saved metadata','evidencePassages':[]}])
        self.assertEqual(result['evidencePassages'],[block]);self.assertEqual(result['title'],'Saved metadata')
