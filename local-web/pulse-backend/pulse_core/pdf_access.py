"""Find public PDF copies by exact identifiers, without cookies or access bypasses."""
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeout
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.parse
import unicodedata

from pulse_core.constants import APP_VERSION, ClientError
from pulse_core.doi_utils import normalize_doi

LOOKUPS = ThreadPoolExecutor(max_workers=3, thread_name_prefix='pdf-access')
MAX_HTML = 1024 * 1024


def public_url(value):
    """Only normal public HTTPS origins; DNS is checked again at connection time."""
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid PDF address.')
    parsed = urllib.parse.urlsplit(value.strip())
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
            or parsed.port not in (None, 443) or host.endswith(('.local', '.internal', '.localhost'))
            or host.lower() == 'localhost' or '%' in host):
        raise ValueError('A public HTTPS PDF address is required.')
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError('Private network PDF addresses are blocked.')
    except ValueError:
        # A hostname is allowed here, but non-global literal IPs are not.
        if re.fullmatch(r'[\d.]+', host) or ':' in host:
            raise ValueError('Private or invalid network address.')
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, ''))


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
            raise ValueError('Private network PDF addresses are blocked.')
        # Pin the validated address. TLS still verifies the original hostname.
        def connect_address(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
            last = None
            for row in addresses:
                try:
                    return socket.create_connection((row[4][0], 443), timeout, source_address)
                except OSError as error:
                    last = error
            raise last or OSError('PDF host unavailable.')
        self._create_connection = connect_address
        super().connect()


def fetch_public(url, deadline, max_bytes):
    """Bounded, anonymous fetch with public-address checks on every redirect."""
    for _ in range(6):
        url = public_url(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('PDF lookup timed out.')
        parsed = urllib.parse.urlsplit(url)
        connection = PublicHTTPSConnection(parsed.hostname, timeout=min(8, remaining), context=ssl.create_default_context())
        try:
            connection.request('GET', urllib.parse.urlunsplit(('', '', parsed.path, parsed.query, '')),
                               headers={'User-Agent': f'Pulse/{APP_VERSION} (open-access PDF reader)',
                                        'Accept': 'application/pdf,text/html,application/json;q=0.8', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                url = urllib.parse.urljoin(url, response.getheader('Location') or '')
                continue
            if response.status != 200:
                raise ValueError('This source did not provide a freely accessible PDF.')
            length = response.getheader('Content-Length')
            if length and int(length) > max_bytes:
                raise ValueError('The PDF exceeds the download limit.')
            data = bytearray()
            content_type = (response.getheader('Content-Type') or '').lower()
            limit = min(max_bytes, MAX_HTML) if 'html' in content_type else max_bytes
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError('PDF download timed out.')
                if connection.sock:
                    connection.sock.settimeout(min(8, max(.1, deadline-time.monotonic())))
                chunk = response.read1(min(65536, limit + 1 - len(data)))
                if not chunk:
                    return bytes(data), url, content_type
                data.extend(chunk)
                if len(data) > limit:
                    raise ValueError('This source exceeds the PDF reader download limit.')
        finally:
            connection.close()
    raise ValueError('Too many PDF redirects.')


class PDFLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.anchors = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'meta' and (attrs.get('name') or attrs.get('property') or '').lower() in {'citation_pdf_url', 'wkhealth_pdf_url', 'eprints.document_url'}:
            self.links.append(attrs.get('content', ''))
        elif tag == 'link' and attrs.get('type', '').lower() == 'application/pdf':
            self.links.append(attrs.get('href', ''))
        elif tag == 'a' and re.search(r'(?:\.pdf(?:[?#]|$)|/pdf(?:[/?#]|$)|\?pdf=render)', attrs.get('href', ''), re.I):
            self.anchors.append(attrs['href'])


def pdf_bytes(url, deadline):
    from pulse_core.pdf_reader import MAX_BYTES
    raw, final, content_type = fetch_public(url, deadline, MAX_BYTES)
    if raw.startswith(b'%PDF-'):
        return raw, final
    if 'html' not in content_type and b'<html' not in raw[:1024].lower():
        raise ValueError('This source did not return a PDF.')
    parser = PDFLinks()
    parser.feed(raw[:MAX_HTML].decode('utf-8', errors='replace'))
    parsed=urllib.parse.urlsplit(final)
    stem=re.sub(r'\.(?:html?|php|aspx?)$','',parsed.path.rstrip('/').rsplit('/',1)[-1],flags=re.I)
    identities=[value for value in [stem]+[item for values in urllib.parse.parse_qs(parsed.query).values() for item in values]
                if len(value)>=5 and value.lower() not in {'article','articles','index','download','fulltext'}]
    # A cited paper's PDF is not this article's PDF. Generic anchors need an
    # article-specific ID shared with the open landing page; citation metadata
    # and typed PDF alternate links already explicitly identify the article.
    matching=[target for target in parser.anchors if any(re.search(r'(?<!\w)'+re.escape(value)+r'(?!\w)',urllib.parse.unquote(target),re.I) for value in identities)]
    # Inspect an open landing page once; never submit forms, cookies or passwords.
    for target in list(dict.fromkeys(parser.links+matching))[:3]:
        try:
            data, address, _ = fetch_public(urllib.parse.urljoin(final, target), deadline, MAX_BYTES)
            if data.startswith(b'%PDF-'):
                return data, address
        except (OSError, ValueError, http.client.HTTPException):
            continue
    raise ValueError('The open page did not supply an accessible PDF.')


def supplied_links(paper):
    rows = [dict(row) for row in (paper.get('fullTextLinks') or [])[:12] if isinstance(row, dict)]
    access = paper.get('openAccessPdf')
    if isinstance(access, dict):
        rows.insert(0, {'url': access.get('url'), 'format': 'pdf', 'source': 'Semantic Scholar'})
    for key in ('pdfUrl', 'fullTextUrl'):
        if isinstance(paper.get(key), str):
            rows.append({'url': paper[key], 'source': 'Paper full-text link'})
    arxiv = str(paper.get('arxivId') or '')
    if not arxiv:
        match = re.search(r'https?://(?:www\.)?arxiv.org/(?:abs|pdf)/([^?#]+)', str(paper.get('url') or ''))
        arxiv = match[1].removesuffix('.pdf') if match else ''
    if re.fullmatch(r'(?:\d{4}\.\d{4,5}|[a-z.-]+/\d{7})(?:v\d+)?', arxiv, re.I):
        rows.insert(0, {'url': 'https://arxiv.org/pdf/'+arxiv, 'format': 'pdf', 'source': 'arXiv'})
    return sorted(rows, key=lambda row: str(row.get('format', '')).lower() != 'pdf')


def openalex_links(paper):
    from pulse_core.external_apis import fetch_json
    doi = normalize_doi(paper.get('doi'))
    identity = str(paper.get('openAlexId') or paper.get('openalexId') or '').rsplit('/', 1)[-1]
    select='id,doi,best_oa_location,locations'
    if doi or re.fullmatch(r'W\d+', identity):
        identity = 'https://doi.org/'+doi if doi else identity
        data = fetch_json('https://api.openalex.org/works/'+urllib.parse.quote(identity, safe='')+'?select='+select)
    else:
        title=str(paper.get('title') or '').strip()
        normalize=lambda value:' '.join(re.findall(r'\w+',unicodedata.normalize('NFKC',str(value or '')).casefold()))
        authors=[normalize(value).split()[-1] for value in paper.get('authors',[]) if normalize(value)]
        if len(normalize(title).split())<6 and not (authors and paper.get('year')):
            return []
        params=urllib.parse.urlencode({'search':title[:500],'per-page':5,'select':select+',display_name,publication_year,authorships'})
        results=fetch_json('https://api.openalex.org/works?'+params).get('results') or []
        matches=[row for row in results if normalize(row.get('display_name'))==normalize(title)
                 and (not paper.get('year') or str(row.get('publication_year'))==str(paper['year']))
                 and (not authors or any(name in normalize(item.get('author',{}).get('display_name','')).split()
                                        for name in authors for item in row.get('authorships',[])))]
        if len({row.get('id') for row in matches})!=1:
            return []
        data=matches[0]
    if doi and normalize_doi(data.get('doi')).casefold() != doi.casefold():
        return []
    if not doi and re.fullmatch(r'W\d+',identity) and str(data.get('id', '')).rsplit('/', 1)[-1] != identity:
        return []
    locations = [data.get('best_oa_location')] + (data.get('locations') or [])
    return [{'url': row.get(key), 'format': kind, 'source': 'OpenAlex'}
            for key,kind in [('pdf_url','pdf'),('landing_page_url','html')]
            for row in locations if isinstance(row, dict) and row.get('is_oa') is True and row.get(key)]


def europe_pmc_links(paper):
    from pulse_core.literature_search import search_europe_pmc
    doi = normalize_doi(paper.get('doi'))
    pmcid, pmid = str(paper.get('pmcid') or '').upper(), str(paper.get('pmid') or '')
    query = 'PMCID:'+pmcid if re.fullmatch(r'PMC\d+', pmcid) else ('EXT_ID:'+pmid+' AND SRC:MED' if pmid.isdigit() else '')
    if not doi and not query:
        return []
    rows = search_europe_pmc(query, limit=3, doi=doi, structured=True, timeout=8)
    found = []
    for row in rows:
        matches = normalize_doi(row.get('doi')).casefold() == doi.casefold() if doi else (row.get('pmcid') == pmcid if pmcid else str(row.get('pmid')) == pmid)
        if matches:
            found.extend(supplied_links(row))
            identity = str(row.get('pmcid') or '')
            if re.fullmatch(r'PMC\d+', identity):
                found.insert(0, {'url': 'https://europepmc.org/articles/'+identity+'?pdf=render', 'source': 'Europe PMC', 'format': 'pdf'})
    return found


def unpaywall_links(paper):
    from pulse_core.storage import load_settings
    from pulse_core.config_resolvers import resolve_contact_email
    doi, email = normalize_doi(paper.get('doi')), resolve_contact_email(load_settings())
    if not doi or not email:
        return []
    raw, _, _ = fetch_public('https://api.unpaywall.org/v2/'+urllib.parse.quote(doi, safe='')+'?'+urllib.parse.urlencode({'email': email}), time.monotonic()+8, 2*1024*1024)
    data = json.loads(raw)
    if normalize_doi(data.get('doi')).casefold() != doi.casefold() or data.get('is_oa') is not True:
        return []
    return [{'url': row.get('url_for_pdf') or row.get('url_for_landing_page'), 'source': 'Unpaywall',
             'format': 'pdf' if row.get('url_for_pdf') else 'html'}
            for row in [data.get('best_oa_location')]+(data.get('oa_locations') or []) if isinstance(row, dict)]


def find_pdf(paper):
    deadline = time.monotonic()+30
    futures = [LOOKUPS.submit(provider, paper) for provider in (openalex_links, europe_pmc_links, unpaywall_links)]
    seen, attempts = set(), 0
    def try_links(rows):
        nonlocal attempts
        for row in rows:
            if attempts >= 8 or time.monotonic() >= deadline:
                break
            url = row.get('url')
            if not isinstance(url,str) or not url or url in seen:
                continue
            seen.add(url)
            try:
                # Old index records sometimes still use HTTP. Upgrade them;
                # actual requests and subsequent redirects must stay HTTPS.
                if url.startswith('http://'): url='https://'+url[7:]
                url = public_url(url)
                attempts += 1
                raw, address = pdf_bytes(url, deadline)
                from pulse_core.pdf_reader import engine
                try:
                    with engine().open(stream=raw,filetype='pdf') as document:
                        if document.needs_pass or not 0<document.page_count<=10000:
                            raise ValueError('This PDF cannot be previewed.')
                except Exception as error:
                    raise ValueError('The source did not supply a readable PDF.') from error
                return raw, address, str(row.get('source') or 'Open full text')[:100]
            except (OSError, ValueError, http.client.HTTPException):
                continue
        return None
    try:
        result = try_links(supplied_links(paper))
        if result:
            return result
        for future in as_completed(futures, timeout=max(.1, deadline-time.monotonic())):
            try:
                result = try_links(future.result())
                if result:
                    return result
            except Exception:
                continue
    except FuturesTimeout:
        pass
    finally:
        for future in futures:
            future.cancel()
    raise ClientError(404, 'No accessible open PDF was found. Try again, open the publisher page, or attach a PDF you have access to.')
