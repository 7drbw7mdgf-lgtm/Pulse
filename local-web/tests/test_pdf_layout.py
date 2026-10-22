from pathlib import Path
import unittest
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core import pdf_utils
from pulse_core.bibliography import split_references,bibliography_text

ABSTRACT=('Campylobacter jejuni is a frequent cause of foodborne illness worldwide. This review summarises the bacterial factors, '
          'host cell receptors and signalling pathways involved in epithelial invasion, and presents a model of how the pathogen '
          'interacts with the intestinal epithelium during infection and disease. We discuss open questions about receptor usage, '
          'cytoskeletal rearrangements and intracellular survival that remain to be resolved in future studies.')

def words_in(page,x,y,width,text,size,font='helv',leading=1.25):
    """Write text left-aligned in a column, wrapping by measured width."""
    import pymupdf as fitz
    line='';top=y
    for word in text.split():
        trial=(line+' '+word).strip()
        if fitz.get_text_length(trial,fontname=font,fontsize=size)>width and line:
            page.insert_text((x,top),line,fontsize=size,fontname=font);top+=size*leading;line=word
        else:line=trial
    if line:page.insert_text((x,top),line,fontsize=size,fontname=font);top+=size*leading
    return top

class PDFLayoutTests(unittest.TestCase):
    def setUp(self):
        try:import pymupdf
        except ImportError:self.skipTest('PyMuPDF required for layout extraction')

    def extract(self,build):
        import pymupdf as fitz
        with fitz.open() as doc:
            build(doc);raw=doc.tobytes()
        return pdf_utils.extract_document(raw,'layout.pdf')

    def test_unlabelled_abstract_beside_a_side_box_is_found_and_read_first(self):
        def build(doc):
            page=doc.new_page(width=595,height=780)
            page.insert_text((45,70),'Host cell invasion by Campylobacter jejuni',fontsize=18,fontname='hebo')
            page.insert_text((45,110),'Ada One and Ben Two',fontsize=10)
            y=165
            for label,value in [('Edited by:','Cyd Three, Example University'),('Reviewed by:','Dee Four, Example Institute'),('*Correspondence:','Ada One, Example School')]:
                page.insert_text((45,y),label,fontsize=7);y=words_in(page,45,y+9,110,value,7)+6
            end=words_in(page,176,165,370,ABSTRACT,9.5)
            page.insert_text((176,end+10),'Keywords: invasion, signalling, virulence',fontsize=7)
            words_in(page,45,end+40,245,'INTRODUCTION Campylobacter jejuni and related species are commensals in many birds and mammals and are a leading cause of gastroenteritis.',9.5)
            words_in(page,303,end+40,245,'Two general strategies are used by enteric pathogens to enter host target cells, called the zipper and trigger mechanisms.',9.5)
        result=self.extract(build)
        self.assertEqual(result['metadata']['abstract'],' '.join(ABSTRACT.split()))
        text=result['text']
        self.assertLess(text.index('Campylobacter jejuni is a frequent'),text.index('Edited by:'),'Main text precedes the side box')
        abstract_lines=text[text.index('Campylobacter jejuni is a frequent'):text.index('disease.')]
        self.assertNotIn('Reviewed by',abstract_lines,'The side box is not interleaved with the abstract')

    def test_labelled_abstract_heading_is_used(self):
        def build(doc):
            page=doc.new_page()
            page.insert_text((50,60),'A labelled paper title for testing',fontsize=16)
            page.insert_text((50,100),'Abstract',fontsize=11,fontname='hebo')
            end=words_in(page,50,118,500,ABSTRACT,10)
            page.insert_text((50,end+20),'1. Introduction',fontsize=11,fontname='hebo')
            words_in(page,50,end+38,500,'The introduction text follows the abstract and is not part of it in any way.',10)
        self.assertEqual(self.extract(build)['metadata']['abstract'],' '.join(ABSTRACT.split()))

    def test_four_column_hanging_indent_references_stay_whole(self):
        references=[f'Author{n}, A. B., Coauthor, C. D., and Third, E. F. (20{10+n}). A study of bacterial invasion number {n} in cultured epithelial cells. J. Microbiol. {n}, {n}0-{n}9.' for n in range(1,13)]
        def build(doc):
            page=doc.new_page(width=595,height=780)
            page.insert_text((45,50),'REFERENCES',fontsize=10,fontname='hebo')
            for column in range(4):
                x=45+column*129;y=70
                for reference in references[column*3:column*3+3]:
                    words=reference.split();first,rest=' '.join(words[:3]),' '.join(words[3:])
                    page.insert_text((x,y),first,fontsize=7.5);y+=9.4
                    y=words_in(page,x+10,y,100,rest,7.5)+4
        result=self.extract(build)
        entries=split_references(bibliography_text(result['text']))
        self.assertEqual(len(entries),12)
        for expected,entry in zip(references,entries):self.assertEqual(entry,expected)
        self.assertEqual(result['bibliographyProvenance']['layoutPages'],[1])

    def test_justified_fragments_on_one_baseline_become_one_line(self):
        def build(doc):
            page=doc.new_page()
            for index,word in enumerate(['Mulholland,','F.,','Williamson,','A.,','and','Smith,','B.']):
                page.insert_text((50+index*62,100),word,fontsize=8)
        self.assertIn('Mulholland, F., Williamson, A., and Smith, B.',self.extract(build)['text'])

    def test_two_column_body_paragraphs_are_not_joined(self):
        def build(doc):
            page=doc.new_page(width=595,height=780)
            for x in (45,303):
                y=80
                for n in range(3):
                    page.insert_text((x+12,y),f'Paragraph {n} at {x} opens with an indented line.',fontsize=9.5);y+=12
                    y=words_in(page,x,y,245,'The rest of this paragraph runs flush with the column edge across several lines of ordinary body text.',9.5)+6
        lines=self.extract(build)['text'].splitlines()
        self.assertIn('Paragraph 1 at 45 opens with an indented line.',lines)
        self.assertLess(lines.index('Paragraph 2 at 45 opens with an indented line.'),lines.index('Paragraph 0 at 303 opens with an indented line.'))

    def test_running_headers_footers_and_page_breaks_inside_references(self):
        first='Alpha, A., Beta, B., and Gamma, C. (2011). A long reference that starts on one page and finishes on the next page of the list. J. Test. 1, 1-9.'
        second='Delta, D., and Epsilon, E. (2012). The following reference stays on the second page. J. Test. 2, 10-19.'
        def build(doc):
            for number in range(1,4):
                page=doc.new_page(width=595,height=780)
                page.insert_text((45,30),'Ó Author and Other   Mechanism of invasion',fontsize=7)
                page.insert_text((45,752),f'Frontiers in Testing   www.example.org   March 2012 | Volume 2 | Article 25 | {number}',fontsize=7)
                if number==1:words_in(page,45,80,500,'Body text of the article before its reference list begins on the next page.',9.5)
                if number==2:
                    page.insert_text((45,600),'REFERENCES',fontsize=10)
                    for n in range(4):page.insert_text((45,620+n*28),f'Filler{n}, F. (2010). Filler reference {n}.',fontsize=7.5);page.insert_text((55,629+n*28),'J. Filler. 1, 1-2.',fontsize=7.5)
                    page.insert_text((45,732),'Alpha, A., Beta, B., and Gamma, C. (2011). A long',fontsize=7.5)
                if number==3:
                    y=words_in(page,55,80,480,'reference that starts on one page and finishes on the next page of the list. J. Test. 1, 1-9.',7.5)
                    cut=second.index('The following');page.insert_text((45,y+4),second[:cut].strip(),fontsize=7.5);words_in(page,55,y+13,480,second[cut:],7.5)
                    for n in range(3):page.insert_text((45,y+40+n*20),f'Zeta{n}, Z. (2013). Closing reference {n}.',fontsize=7.5);page.insert_text((55,y+49+n*20),'J. Close. 3, 3-4.',fontsize=7.5)
        result=self.extract(build)
        self.assertNotIn('Frontiers in Testing',result['text']);self.assertNotIn('Mechanism of invasion',result['text'])
        entries=split_references(bibliography_text(result['text']))
        self.assertIn(first,entries);self.assertIn(second,entries)

    def test_reader_words_follow_columns_so_quotes_verify(self):
        import pymupdf as fitz
        from unittest.mock import patch
        import tempfile
        from pulse_core import pdf_reader
        with tempfile.TemporaryDirectory() as folder,patch.object(pdf_reader,'CONFIG_DIR',Path(folder)):
            pdf_reader.page_text.cache_clear()
            with fitz.open() as doc:
                page=doc.new_page(width=595,height=780)
                for row,(left,right) in enumerate([('Oxidative stress responses differ','Unrelated words in the right'),('between bacterial lineages markedly','column of the same page here')]):
                    page.insert_text((45,100+row*12),left,fontsize=9.5);page.insert_text((303,100+row*12),right,fontsize=9.5)
                for row in range(4):page.insert_text((45,130+row*12),'Further left column text line.',fontsize=9.5);page.insert_text((303,130+row*12),'Further right column text line.',fontsize=9.5)
                stored=pdf_reader.store_bytes(doc.tobytes(),'Columns.pdf')
            words=[word['text'] for word in pdf_reader.page({'id':stored['id'],'page':1})['words']]
            self.assertLess(words.index('markedly'),words.index('Unrelated'))
            passage=pdf_reader.passage({'id':stored['id'],'page':1,'quote':'responses differ between bacterial lineages'})
            self.assertEqual(passage['page'],1)

if __name__=='__main__':unittest.main()
