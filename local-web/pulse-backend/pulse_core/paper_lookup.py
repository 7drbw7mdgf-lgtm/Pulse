"""Resolve a pasted DOI or public article link without running a keyword search."""
from html.parser import HTMLParser
import re
import time
import urllib.parse

from pulse_core.constants import ClientError
from pulse_core.doi_utils import normalize_doi
from pulse_core.metadata_scanner import lookup_doi_metadata, lookup_pmid_metadata
from pulse_core.metadata_resolution import clean, resolve_metadata
from pulse_core.pdf_access import fetch_public, public_url


class ArticleMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attributes):
        if tag.lower() != 'meta':
            return
        attrs = {key.lower(): value for key, value in attributes}
        name = (attrs.get('name') or attrs.get('property') or '').lower()
        value = clean(attrs.get('content'), 5000)
        if name and value:
            self.values.setdefault(name, []).append(value)

    def first(self, *names):
        return next((self.values[name][0] for name in names if self.values.get(name)), '')


def lookup_paper(payload):
    query = payload.get('query')
    if not isinstance(query, str) or not query.strip() or len(query) > 4096:
        raise ClientError(400, 'Paste a DOI or a public paper link, then press Enter.')
    query = query.strip()
    doi = normalize_doi(urllib.parse.unquote(query))
    metadata, source = {}, ''
    if doi:
        result = lookup_doi_metadata({'doi': doi})
        metadata, source = result['metadata'], result.get('source') or 'DOI'
        if normalize_doi(metadata.get('doi')).casefold() != doi.casefold():
            raise ClientError(404, 'The registry did not return the requested DOI. Check it and try again.')
        metadata = dict(metadata, doiVerified=True)
    else:
        try:
            url = public_url(re.sub(r'^http://', 'https://', query, flags=re.I))
        except ValueError:
            raise ClientError(400, 'Use a DOI or a public HTTPS article link.') from None
        parsed = urllib.parse.urlsplit(url)
        pmid = re.fullmatch(r'/(\d{1,10})/?', parsed.path) if parsed.hostname == 'pubmed.ncbi.nlm.nih.gov' else None
        if pmid:
            metadata = lookup_pmid_metadata({'pmid': pmid[1]})['metadata']
            source = 'PubMed'
        else:
            try:
                body, final_url, content_type = fetch_public(url, time.monotonic() + 20, 1024 * 1024)
            except (OSError, ValueError, TimeoutError):
                raise ClientError(502, 'This website could not be read. Paste the paper’s DOI instead.') from None
            if 'html' not in content_type and not body.lstrip().lower().startswith((b'<!doctype html', b'<html')):
                raise ClientError(400, 'Use the paper’s article-page link or DOI rather than a PDF download.')
            page = ArticleMetadata()
            page.feed(body.decode('utf-8', errors='replace'))
            doi = normalize_doi(page.first('citation_doi', 'dc.identifier', 'dc.identifier.doi', 'prism.doi'))
            if doi:
                result = lookup_doi_metadata({'doi': doi})
                metadata, source = result['metadata'], result.get('source') or 'DOI'
                if normalize_doi(metadata.get('doi')).casefold() != doi.casefold():
                    raise ClientError(404, 'The article’s DOI could not be verified.')
                metadata = dict(metadata, doiVerified=True)
            else:
                title = page.first('citation_title', 'dc.title', 'dcterms.title')
                if not title:
                    raise ClientError(404, 'No paper metadata was found at this link. Paste its DOI or an article-page link.')
                original = {'title': title, 'authors': page.values.get('citation_author') or page.values.get('dc.creator') or [],
                            'journal': page.first('citation_journal_title', 'prism.publicationname'),
                            'date': page.first('citation_publication_date', 'dc.date', 'dcterms.issued'),
                            'abstract': page.first('citation_abstract', 'dc.description'), 'url': final_url}
                found = resolve_metadata(original)
                metadata = found.get('metadata') if found.get('matched') else original
                source = found.get('source') if found.get('matched') else 'Article page'
            metadata = dict(metadata, url=metadata.get('url') or final_url)
        metadata = dict(metadata, url=metadata.get('url') or url)
    if not metadata.get('title'):
        raise ClientError(404, 'No paper was found for this DOI or link.')
    paper = dict(metadata, score=None, paperLookup=True, matchLabel='Exact lookup', sourceList=[source],
                 discoveryBadges=['Exact lookup'], reason='Found using the DOI or article link you entered.', branches=['paperLookup'],
                 whyFound=[{'kind':'search','label':'DOI or article link','detail':'Found using the DOI or article link you entered.'}])
    return {'ok': True, 'status': 'complete', 'searchMode': 'paper', 'searchQuery': query,
            'recommendations': [paper], 'sourceCounts': {'paperLookup': 1}, 'branchesExecuted': ['paperLookup'],
            'rankingNotice': 'Exact paper lookup · no similarity ranking applied', 'errors': {}}
