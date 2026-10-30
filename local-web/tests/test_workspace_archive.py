import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pulse-backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pulse_core.constants import ClientError
from pulse_core.library_store import LibraryStore
from pulse_core.workspace_archive import (
    export_workspace_archive,
    inspect_workspace_archive,
    restore_workspace_archive,
)
import pulse_core.workspace_archive as workspace_archive
from unittest.mock import patch
import zipfile


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

    def test_workspace_archive_merge_preserves_two_tier_content(self):
        store = LibraryStore(self.legacy_path, lambda: {}, lambda data, r: None)
        store.write({
            'papers': [{
                'id': 'p-merge-1',
                'title': 'Merged Paper',
                'fullText': 'Full text body for merged paper',
                'ocrText': 'OCR body for merged paper',
            }]
        })
        archive_path = self.root / 'merge.pulse-workspace'
        export_workspace_archive(output_path=archive_path, directory=self.root, include_pdfs=False)

        dest_root = Path(tempfile.mkdtemp())
        try:
            dest_store = LibraryStore(dest_root / 'library.json', lambda: {}, lambda data, r: None)
            dest_store.write({'papers': [{'id': 'p-existing', 'title': 'Existing Paper'}]})
            res = restore_workspace_archive(archive_path, directory=dest_root, mode='merge')
            self.assertTrue(res['ok'])
            self.assertEqual(res['restored']['papers'], 1)
            full_read = dest_store.read(include_content=True)
            by_id = {p['id']: p for p in full_read['papers']}
            self.assertIn('p-existing', by_id)
            self.assertIn('p-merge-1', by_id)
            self.assertEqual(by_id['p-merge-1'].get('fullText'), 'Full text body for merged paper')
            self.assertEqual(by_id['p-merge-1'].get('ocrText'), 'OCR body for merged paper')
        finally:
            shutil.rmtree(dest_root, ignore_errors=True)

    def test_workspace_archive_rejects_invalid_sqlite_pdf_and_traversal(self):
        bad_sqlite_zip = self.root / 'bad-sqlite.pulse-workspace'
        with zipfile.ZipFile(bad_sqlite_zip, 'w') as zf:
            zf.writestr('manifest.json', json.dumps({'format': 'pulse-workspace', 'version': 1}))
            zf.writestr('library.sqlite3', b'not-an-sqlite-database-at-all')
        with self.assertRaises(ClientError) as ctx:
            inspect_workspace_archive(bad_sqlite_zip)
        self.assertEqual(ctx.exception.status, 400)

        traversal_zip = self.root / 'traversal.pulse-workspace'
        with zipfile.ZipFile(traversal_zip, 'w') as zf:
            zf.writestr('manifest.json', json.dumps({'format': 'pulse-workspace', 'version': 1}))
            zf.writestr('pdfs/../evil.pdf', b'%PDF-1.4 evil')
        with self.assertRaises(ClientError) as ctx:
            inspect_workspace_archive(traversal_zip)
        self.assertEqual(ctx.exception.status, 400)

        oversized_zip = self.root / 'oversized.pulse-workspace'
        with zipfile.ZipFile(oversized_zip, 'w') as zf:
            zf.writestr('manifest.json', json.dumps({'format': 'pulse-workspace', 'version': 1}))
            zf.writestr('pdfs/large.pdf', b'%PDF-1.4 ' + (b'0' * 2048))
        with patch.object(workspace_archive, 'MAX_PDF_ENTRY_BYTES', 512):
            with self.assertRaises(ClientError) as ctx:
                inspect_workspace_archive(oversized_zip)
            self.assertEqual(ctx.exception.status, 413)


if __name__ == '__main__':
    unittest.main()
