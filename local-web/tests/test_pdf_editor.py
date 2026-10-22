import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core import pdf_reader,pdf_editor,pdf_access
from pulse_core.constants import ClientError

class PDFEditorTests(unittest.TestCase):
    def setUp(self):
        import pymupdf
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        p=patch.object(pdf_reader,'CONFIG_DIR',Path(self.tmp.name));p.start();self.addCleanup(p.stop)
        pdf_reader.page_text.cache_clear()
        with pymupdf.open() as doc:
            for text in ['First source page with verified findings.','Second source page with limitations.','Third source page.']:
                page=doc.new_page();page.insert_text((50,80),text,fontsize=14)
            self.raw=doc.tobytes()
        self.file=pdf_reader.store_bytes(self.raw,'Source.pdf')

    def test_export_contains_native_editable_marks_and_preserves_original(self):
        import pymupdf
        rect={'x':.08,'y':.075,'width':.5,'height':.035}
        marks=[{'kind':kind,'page':1,'rects':[rect],'color':'yellow','quote':'First source page'} for kind in ['highlight','underline','strikeout']]
        marks += [{'kind':'text','page':1,'text':'Editorial note','memo':'Layout review','fontSize':14,'color':'black','rect':{'x':.15,'y':.25,'width':.5,'height':.12}},
                  {'kind':'note','page':1,'point':{'x':.6,'y':.3},'memo':'Check the methods'},
                  {'kind':'rectangle','page':1,'rect':rect,'color':'blue'},
                  {'kind':'ink','page':1,'points':[{'x':.2,'y':.6},{'x':.3,'y':.7}],'color':'red'}]
        result=pdf_editor.export({'id':self.file['id'],'annotations':marks})
        with pymupdf.open(pdf_reader.path_for(result['id'])) as doc:
            page=doc[0];annotations=list(page.annots());self.assertEqual(len(annotations),7)
            self.assertTrue(any('Editorial note' in a.info.get('content','') for a in annotations))
            self.assertTrue(any(a.info.get('content')=='Editorial note' and a.info.get('subject')=='Layout review' for a in annotations))
            self.assertGreater(doc[0].get_pixmap().width,500)
        self.assertEqual(pdf_reader.path_for(self.file['id']).read_bytes(),self.raw)

    def test_page_order_rotation_and_removal_export_to_a_new_file(self):
        import pymupdf
        result=pdf_editor.export({'id':self.file['id'],'pageOrder':[3,1],'rotations':{'1':90}})
        with pymupdf.open(pdf_reader.path_for(result['id'])) as doc:
            self.assertEqual(len(doc),2);self.assertIn('Third',doc[0].get_text());self.assertIn('First',doc[1].get_text());self.assertEqual(doc[1].rotation,90)
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(),self.file['id'])

    def test_preview_is_searchable_but_cannot_be_edited(self):
        preview=pdf_reader.store_bytes(self.raw+b'\n',preview=True)
        self.assertEqual(pdf_reader.search({'id':preview['id'],'query':'limitations'})['matches'][0]['page'],2)
        with self.assertRaises(ClientError) as error:pdf_editor.export({'id':preview['id']})
        self.assertEqual(error.exception.status,409)

    def test_thumbnail_and_rotated_render_have_real_images(self):
        thumb=pdf_reader.page({'id':self.file['id'],'thumbnail':True,'scale':.18})
        self.assertEqual(thumb['words'],[]);self.assertTrue(thumb['image'].startswith('data:image/png;base64,'))
        page=pdf_reader.page({'id':self.file['id'],'rotation':90})
        self.assertGreater(page['width'],page['height']);self.assertGreater(len(page['words']),3)

    def test_invalid_edits_do_not_create_a_file(self):
        for edits in [{'pageOrder':[]},{'pageOrder':[1,1]},{'rotations':{'1':13}},
                      {'annotations':[{'kind':'text','page':1,'text':'Bad','rect':{'x':float('nan'),'y':0,'width':.5,'height':.2}}]},
                      {'annotations':[{'kind':'note','page':1,'point':{'x':2,'y':0},'memo':'Invalid'}]}]:
            with self.subTest(edits=edits),self.assertRaises(ClientError):pdf_editor.export(dict(edits,id=self.file['id']))
        self.assertEqual(len(list((Path(self.tmp.name)/'pdfs').glob('*.pdf'))),1)

    def test_cloud_metadata_uses_exact_identifier_and_real_pdf_url(self):
        listing=b'<ListBucketResult><Contents><Key>metadata/PMC12345.2.json</Key></Contents></ListBucketResult>'
        metadata={'pmcid':'PMC12345','doi':'10.1234/article','pdf_url':'s3://pmc-oa-opendata/PMC12345.2/PMC12345.2.pdf?md5=abc'}
        with patch.object(pdf_access,'fetch_public',side_effect=[(listing,'','application/xml'),(json.dumps(metadata).encode(),'','application/json')]):
            rows=pdf_access.pmc_cloud_links({'pmcid':'PMC12345','doi':'10.1234/article'})
        self.assertEqual(rows[0]['url'],'https://pmc-oa-opendata.s3.amazonaws.com/PMC12345.2/PMC12345.2.pdf?md5=abc')
        with patch.object(pdf_access,'fetch_public',side_effect=[(listing,'','application/xml'),(json.dumps(metadata).encode(),'','application/json')]):
            self.assertEqual(pdf_access.pmc_cloud_links({'pmcid':'PMC12345','doi':'10.1234/other'}),[])

if __name__=='__main__':unittest.main()
