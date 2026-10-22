from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core import pdf_reader
from pulse_core.constants import ClientError

class PDFViewerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        p=patch.object(pdf_reader,'CONFIG_DIR',Path(self.tmp.name));p.start();self.addCleanup(p.stop)
        for cached in (pdf_reader.page_text,pdf_reader.document_info,pdf_reader.document_outline):cached.cache_clear()

    def store(self,build):
        import pymupdf
        with pymupdf.open() as doc:
            build(doc,pymupdf);raw=doc.tobytes()
        return pdf_reader.store_bytes(raw,'Viewer.pdf')['id']

    def test_info_lists_every_page_size_for_the_scroll_layout(self):
        def build(doc,fitz):
            doc.new_page(width=595,height=842);doc.new_page(width=842,height=595);doc.new_page(width=300,height=400).set_rotation(90)
        info=pdf_reader.info({'id':self.store(build)})
        self.assertEqual(info['pages'],3);self.assertEqual(info['sizes'],[[595,842],[842,595],[400,300]])

    def test_bookmarks_become_the_outline_with_target_positions(self):
        def build(doc,fitz):
            for text in ['Introduction','Methods','References']:doc.new_page().insert_text((50,600),text,fontsize=14)
            doc.set_toc([[1,'Introduction',1],[2,'Study design',2],[1,'References',3,{'kind':fitz.LINK_GOTO,'page':2,'to':fitz.Point(50,590)}]])
        result=pdf_reader.outline({'id':self.store(build)})
        self.assertEqual(result['source'],'bookmarks')
        self.assertEqual([(row['level'],row['title'],row['page']) for row in result['outline']],[(1,'Introduction',1),(2,'Study design',2),(1,'References',3)])
        self.assertAlmostEqual(result['outline'][2]['y'],590/842,places=3)

    def test_headings_build_an_outline_when_a_pdf_has_no_bookmarks(self):
        def build(doc,fitz):
            page=doc.new_page();page.insert_text((50,60),'Abstract',fontsize=14,fontname='helvetica-bold')
            for y in range(90,400,14):page.insert_text((50,y),'Results were measured in a cohort of participants over time.',fontsize=10)
            page.insert_text((50,430),'2.1 Study population',fontsize=12,fontname='helvetica-bold')
            page.insert_text((50,460),'Results show a reduction in the outcome.',fontsize=10)
            page=doc.new_page();page.insert_text((50,60),'REFERENCES',fontsize=12)
            for y in range(90,300,14):page.insert_text((50,y),'1. Author A. A study title. Journal. 2020.',fontsize=9)
        result=pdf_reader.outline({'id':self.store(build)})
        self.assertEqual(result['source'],'headings')
        self.assertEqual([(row['title'],row['page'],row['level']) for row in result['outline']],[('Abstract',1,1),('2.1 Study population',1,2),('REFERENCES',2,1)])

    def test_links_are_rotated_with_the_page_and_unsafe_actions_are_dropped(self):
        def build(doc,fitz):
            doc.new_page().insert_text((50,70),'See reference [1] and the data.',fontsize=12)
            doc.new_page().insert_text((50,421),'References',fontsize=14)
            page=doc[0];page.insert_link({'kind':fitz.LINK_GOTO,'from':fitz.Rect(50,58,160,74),'page':1,'to':fitz.Point(50,421)})
            page.insert_link({'kind':fitz.LINK_URI,'from':fitz.Rect(50,100,160,116),'uri':'https://example.org/data'})
            page.insert_link({'kind':fitz.LINK_URI,'from':fitz.Rect(50,130,160,146),'uri':'javascript:alert(1)'})
            page.insert_link({'kind':fitz.LINK_URI,'from':fitz.Rect(50,160,160,176),'uri':'doi:10.1234/abc'})
        identity=self.store(build)
        links=pdf_reader.page({'id':identity,'page':1})['links']
        self.assertEqual([row.get('page') or row.get('url') for row in links],[2,'https://example.org/data','https://doi.org/10.1234/abc'])
        self.assertAlmostEqual(links[0]['x'],50/595,places=3);self.assertAlmostEqual(links[0]['y'],58/842,places=3);self.assertAlmostEqual(links[0]['targetY'],421/842,places=3)
        rotated=pdf_reader.page({'id':identity,'page':1,'rotation':90})['links'][0]
        self.assertAlmostEqual(rotated['x'],(842-74)/842,places=3);self.assertAlmostEqual(rotated['height'],110/595,places=3)

    def test_zoom_renders_are_sharper_and_can_skip_text(self):
        def build(doc,fitz):doc.new_page().insert_text((50,70),'Sharp page text for zoom checks.',fontsize=12)
        identity=self.store(build)
        crisp=pdf_reader.page({'id':identity,'scale':3.5,'text':False})
        self.assertEqual(crisp['scale'],3.5);self.assertNotIn('words',crisp);self.assertNotIn('links',crisp)
        capped=pdf_reader.page({'id':identity,'scale':9})
        self.assertEqual(capped['scale'],4);self.assertGreater(len(capped['words']),3)
        with self.assertRaises(ClientError):pdf_reader.info({'id':'0'*64})

if __name__=='__main__':unittest.main()
