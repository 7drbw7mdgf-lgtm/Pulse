"""bioRxiv and medRxiv preprints by DOI, from the public api.biorxiv.org service.

The API has no keyword or author search; it identifies a known preprint DOI and reports
every posted version and the DOI of the journal article it became, when there is one.
"""
import re
import urllib.parse
from .constants import ClientError
from .doi_utils import normalize_doi
from .external_apis import fetch_json

SERVERS = {'biorxiv': 'bioRxiv', 'medrxiv': 'medRxiv'}


def is_preprint_doi(value):
    """bioRxiv and medRxiv share Cold Spring Harbor's 10.1101 prefix with dated suffixes."""
    return bool(re.fullmatch(r'10\.1101/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,8}', normalize_doi(value)))


def server_order(doi):
    # medRxiv suffixes are eight digits starting with 2 (e.g. 2020.02.27.20028647); bioRxiv's are six.
    return ('medrxiv', 'biorxiv') if re.search(r'\.2\d{7}$', doi) else ('biorxiv', 'medrxiv')


def author_name(value):
    family, _, given = str(value or '').partition(',')
    return ' '.join(part for part in (given.strip(), family.strip()) if part)


def preprint_record(doi):
    """The latest posted version of a preprint, or None when neither server knows the DOI."""
    doi = normalize_doi(doi)
    if not is_preprint_doi(doi):
        return None
    for server in server_order(doi):
        try:
            data = fetch_json(f'https://api.biorxiv.org/details/{server}/{urllib.parse.quote(doi, safe="/")}/na/json')
        except ClientError:
            continue
        rows = [row for row in data.get('collection') or []
                if isinstance(row, dict) and normalize_doi(row.get('doi')).casefold() == doi.casefold()]
        if rows:
            return to_metadata(max(rows, key=lambda row: int(row.get('version') or 0)), server, len(rows))
    return None


def to_metadata(row, server, versions=1):
    name = SERVERS[server]
    doi = normalize_doi(row.get('doi'))
    version = str(row.get('version') or '1')
    landing = f'https://www.{server}.org/content/{doi}v{version}'
    published = normalize_doi(row.get('published')) if str(row.get('published') or '').upper() != 'NA' else ''
    date = str(row.get('date') or '')
    metadata = {
        'title': re.sub(r'\s+', ' ', str(row.get('title') or '')).strip(),
        'authors': [name for name in (author_name(part) for part in str(row.get('authors') or '').split(';')) if name],
        'abstract': re.sub(r'\s+', ' ', str(row.get('abstract') or '')).strip(),
        'doi': doi, 'year': date[:4], 'date': date, 'journal': name, 'publisher': 'Cold Spring Harbor Laboratory',
        'publicationType': 'preprint', 'url': landing, 'metadataSource': name,
        'preprint': {'server': name, 'version': version, 'versions': versions, 'category': str(row.get('category') or ''),
                     'license': str(row.get('license') or ''), 'postedDate': date},
        # The server's own PDF route; requests stay anonymous and blocked sites are reported, not bypassed.
        'fullTextLinks': [{'url': landing + '.full.pdf', 'format': 'pdf', 'source': name}],
    }
    if published:
        metadata['publicationRelations'] = [{'type': 'is-preprint-of', 'doi': published, 'source': name}]
    return {key: value for key, value in metadata.items() if value not in ('', [], None)}


def preprint_pdf_links(paper):
    """Open-PDF candidates for a bioRxiv or medRxiv DOI, latest version first."""
    record = preprint_record(paper.get('doi'))
    return list(record.get('fullTextLinks') or []) if record else []
