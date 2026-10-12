"""Offline checks for the shipped backend, using synthetic documents only."""
import io
import json
import os
import sqlite3
import tempfile
from pathlib import Path


def run():
    import pymupdf
    from pulse_core.constants import APP_VERSION, ROOT
    from pulse_core.pdf_utils import extract_document
    from pulse_core.doi_utils import scan_doi_from_bytes
    from pulse_core.security import encrypt_secret, decrypt_secret
    from pulse_core.passages import import_s2orc_stream, retrieve_passages
    from pulse_core.library_managers import read_config, config_lock, transfer_lock
    from pulse_core.platform_support import process_alive
    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text((72, 72), 'A synthetic transport observation study')
    page.insert_text((72, 96), 'doi: 10.1234/pulse-test')
    pdf.set_metadata({'title': 'A synthetic transport observation study', 'author': 'Example Researcher'})
    document = extract_document(pdf.tobytes(), 'test.pdf')
    pdf.close()
    assert document['extractionSource'] == 'PyMuPDF', document
    assert 'synthetic transport' in document['text']
    assert scan_doi_from_bytes(document['text'].encode()) == '10.1234/pulse-test'
    secret = encrypt_secret('synthetic-test-value')
    assert decrypt_secret(secret) == 'synthetic-test-value'
    with tempfile.TemporaryDirectory(prefix='pulse-corpus-check-') as folder:
        row = {'paper_id': 'smoke', 'doi': '10.1234/smoke', 'title': 'Transport survey',
               'body_text': [{'section': 'Results', 'text': 'Protected bicycle lanes reduced intersection injuries in the transport survey.'}]}
        result = import_s2orc_stream(io.BytesIO(json.dumps(row).encode() + b'\n'), folder)
        assert result['imported'] == 1, result
        evidence = retrieve_passages({'paper': {'doi': row['doi']}, 'question': 'bicycle lanes intersection injuries'}, folder)
        assert evidence['available'] and evidence['passages'], evidence
    with sqlite3.connect(':memory:') as connection:
        connection.execute('CREATE VIRTUAL TABLE passages USING fts5(text)')
    with config_lock():
        registration = read_config()
    with transfer_lock():
        pass
    assert process_alive(os.getpid())
    assert (ROOT / 'index.html').is_file(), str(ROOT)
    return {'ok': True, 'version': APP_VERSION, 'pdf': document['extractionSource'],
            'doiExtraction': True, 'sqliteFts5': True, 'fullTextPassages': True,
            'secretRoundTrip': True, 'managerLocks': True,
            'mendeleySharedServiceConfigured': bool(registration.get('brokerUrl'))}
