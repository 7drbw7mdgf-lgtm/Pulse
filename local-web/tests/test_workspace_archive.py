import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pulse_core.library_store import LibraryStore
from pulse_core.workspace_archive import (
    export_workspace_archive,
    inspect_workspace_archive,
    restore_workspace_archive,
)


class WorkspaceStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.root = Path(self.temp_dir)
        self.legacy_path = self.root / 'library.json'
        self.checkpoint_dir = self.root / 'backups'
        self.checkpoints = []

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_two_tier_lazy_loading_and_content_retrieval(self):
        store = LibraryStore(self.legacy_path, lambda: {}, lambda data, r: self.checkpoints.append(r))
        papers = [
            {
                'id': 'paper-1',
                'title': 'Lightweight Title 1',
                'authors': ['Author A'],
                'abstract': 'Abstract 1',
                'fullText': 'Very long full text ' * 1000,
                'ocrText': 'Scanned OCR text ' * 500,
            },
            {
                'id': 'paper-2',
                'title': 'Lightweight Title 2',
                'authors': ['Author B'],
                'abstract': 'Abstract 2',
            }
        ]
        store.write({'papers': papers})

        # 1. Metadata-only read (lazy loading)
        meta_read = store.read(include_content=False)
        p1_meta = next(p for p in meta_read['papers'] if p['id'] == 'paper-1')
        p2_meta = next(p for p in meta_read['papers'] if p['id'] == 'paper-2')
        self.assertNotIn('fullText', p1_meta)
        self.assertNotIn('ocrText', p1_meta)
        self.assertTrue(p1_meta.get('hasFullText'))
        self.assertTrue(p1_meta.get('hasOcr'))
        self.assertFalse(p2_meta.get('hasFullText', False))

        # 2. Content retrieval on demand
        content = store.get_paper_content('paper-1')
        self.assertIn('fullText', content)
        self.assertIn('ocrText', content)
        self.assertTrue(content['fullText'].startswith('Very long full text'))

        # 3. Full read joins content transparently
        full_read = store.read(include_content=True)
        p1_full = next(p for p in full_read['papers'] if p['id'] == 'paper-1')
        self.assertIn('fullText', p1_full)
        self.assertEqual(p1_full['fullText'], papers[0]['fullText'])

    def test_workspace_archive_export_inspect_and_restore(self):
        store = LibraryStore(self.legacy_path, lambda: {}, lambda data, r: None)
        papers = [{'id': f'p-{i}', 'title': f'Paper {i}', 'userTags': ['Genetics']} for i in range(10)]
        store.write({'papers': papers, 'savedSearches': [{'id': 's1', 'name': 'Search 1'}]})

        # Create dummy PDF
        pdf_dir = self.root / 'pdfs'
        pdf_dir.mkdir(parents=True, exist_ok=True)
        (pdf_dir / 'test-paper.pdf').write_text('%PDF-1.4 dummy')

        # Export archive
        archive_path = self.root / 'test.pulse-workspace'
        exported = export_workspace_archive(output_path=archive_path, directory=self.root, include_pdfs=True)
        self.assertTrue(exported.exists())

        # Inspect archive
        manifest = inspect_workspace_archive(exported)
        self.assertEqual(manifest['paperCount'], 10)
        self.assertEqual(manifest['pdfCount'], 1)
        self.assertIn('genetics', [t.lower() for t in manifest['tags']])

        # Restore into a fresh directory
        fresh_root = Path(tempfile.mkdtemp())
        try:
            res = restore_workspace_archive(exported, directory=fresh_root, mode='replace')
            self.assertTrue(res['ok'])
            self.assertEqual(res['restored']['papers'], 10)
            self.assertEqual(res['restored']['pdfs'], 1)
            self.assertTrue((fresh_root / 'library.sqlite3').exists())
            self.assertTrue((fresh_root / 'pdfs' / 'test-paper.pdf').exists())
        finally:
            shutil.rmtree(fresh_root, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
