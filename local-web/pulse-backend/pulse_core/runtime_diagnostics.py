"""Offline checks for the shipped backend, using synthetic documents only."""
import io
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path


def check_packaged_windows_assets():
    """Exercise installed OCR and ranking, excluding user/developer runtimes."""
    import hashlib
    import math
    import pymupdf
    from pulse_core.pdf_utils import extract_document
    from pulse_core.discovery_crossencoder import _find_search_runtime, crossencoder_scores
    internal = Path(__file__).resolve().parent.parent
    data = internal / 'ocr-data'
    provenance = json.loads((data / 'provenance.json').read_text())
    assert hashlib.sha256((data / 'eng.traineddata').read_bytes()).hexdigest() == provenance['sha256']
    assert (data / 'LICENSE').is_file()
    with pymupdf.open() as text_pdf, pymupdf.open() as scan_pdf:
        page = text_pdf.new_page()
        page.insert_text((72, 72), 'Synthetic bicycle transport study', fontsize=20)
        scan = scan_pdf.new_page()
        scan.insert_image(scan.rect, stream=page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes('png'))
        document = extract_document(scan_pdf.tobytes(), 'synthetic-scan.pdf')
    assert document['bibliographyProvenance']['ocrPages'] == [1], document
    assert 'bicycle' in document['text'].lower(), document
    executable, model = _find_search_runtime({})
    assert executable is not None and model is not None, 'Installed ranker unavailable'
    executable.resolve().relative_to(internal / '.search-runtime')
    model.resolve().relative_to(internal / '.search-runtime')
    scores, notice = crossencoder_scores({}, ['Protected bicycle lanes and intersection safety'], [
        {'title': 'Protected bicycle lanes reduce intersection injuries',
         'abstract': 'A transport study of protected lanes and cycling safety.'},
        {'title': 'Marine sediment chemistry', 'abstract': 'Mineral samples from the deep ocean.'}])
    assert scores and len(scores) == 2 and all(math.isfinite(score) for score in scores), notice
    assert scores[0] > scores[1], scores
    return {'localOcr': True, 'offlinePairwiseRanker': True}


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
    assets = check_packaged_windows_assets() if getattr(sys, 'frozen', False) and sys.platform in {'win32','darwin'} else {}
    if getattr(sys, 'frozen', False):
        import ssl
        assert os.environ.get('SSL_CERT_FILE') and Path(os.environ['SSL_CERT_FILE']).is_file()
        assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0
        assets['bundledCertificateStore'] = True
    return {'ok': True, 'version': APP_VERSION, 'pdf': document['extractionSource'],
            'doiExtraction': True, 'sqliteFts5': True, 'fullTextPassages': True,
            'secretRoundTrip': True, 'managerLocks': True,
            'mendeleySharedServiceConfigured': bool(registration.get('exchangeUrl') or registration.get('brokerUrl')), **assets}
