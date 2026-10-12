"""Conservative reference-list parsing; year suffixes come from the document."""
import re
from .doi_utils import normalize_doi, ranked_doi_candidates
from .metadata_resolution import extract_text_metadata

HEADING = re.compile(r'^\s*(?:\d+[.\s]+)?(?:references(?: and notes)?|bibliography|literature cited|works cited|reference list)\s*:?\s*$', re.I | re.M)
YEAR = re.compile(r'\b((?:18|19|20)\d{2})([a-z]?)\b', re.I)


def bibliography_text(text):
    text = str(text or '')
    match = HEADING.search(text)
    return text[match.end():].strip()[:120000] if match else ''


def split_references(text):
    entries, current = [], []
    for line in str(text or '').splitlines():
        line = line.strip()
        if not line or re.fullmatch(r'\d{1,4}', line):
            continue
        numbered = bool(re.match(r'^(?:\[\d{1,4}\]|\d{1,4}[.)])\s+', line))
        dated_author = bool(re.match(r"^[^\W\d_][\w\s,.'’&\-‐‑–]{2,220}\s*\((?:18|19|20)\d{2}[a-z]?\)", line))
        author_initials = bool(re.match(r"^[^\W\d_][\w\s'’\-‐‑–]{1,70},\s*(?:[A-Z]\.[\s-]*)+", line))
        if current and (numbered or dated_author or author_initials):
            entries.append(' '.join(current)); current = []
        current.append(line)
    if current: entries.append(' '.join(current))
    return entries[:400]


def reference_metadata(reference):
    raw = re.sub(r'^\s*(?:\[\d+\]|\d+[.)])\s*', '', reference).strip()
    # The author's date is before the article title in author–year references.
    dated = re.search(r'\(((?:18|19|20)\d{2})([a-z]?)\)', raw[:500], re.I)
    metadata = extract_text_metadata(raw)
    if dated:
        prefix = raw[:dated.start()].strip(' ,')
        families = re.findall(r"(?:^|[,;&]\s*|\band\s+)([^\W\d_][\w\s'’\-‐‑–]{1,70}?),\s*(?:[A-Z]\.[\s-]*)+", prefix)
        if not families:
            families = [name.strip(' .,') for name in re.split(r';|\s+and\s+|\s*&\s*', re.sub(r'\s+et\s+al\.?$', '', prefix, flags=re.I))]
        metadata['authors'] = families
        metadata['year'] = dated[1]
        metadata['referenceYearSuffix'] = dated[2].lower()
    else:
        # Numbered/Vancouver records already yield author strings, title and date.
        families = [re.sub(r'\s+[A-Z]{1,4}$', '', name).strip() for name in metadata.get('authors') or []]
        metadata['authors'] = families
        year = YEAR.search(raw)
        metadata['referenceYearSuffix'] = year[2].lower() if year else ''
    doi = next(iter(ranked_doi_candidates(raw)), '')
    metadata.update(doi=normalize_doi(doi), doiVerified=False, referenceText=raw,
                    metadataSource='Selected paper bibliography', lookupSources=['Selected paper bibliography'])
    return metadata


def matching_references(group, parent):
    from .citation_lookup import citation_agrees
    text = str(parent.get('bibliographyText') or '')[:120000] or bibliography_text(parent.get('text'))
    records = [reference_metadata(reference) for reference in split_references(text)]
    supplied = parent.get('referenceEntries') or []
    if isinstance(supplied, list):
        records += [dict(record, metadataSource='Selected paper bibliography', doiVerified=False) for record in supplied[:400] if isinstance(record, dict)]
    matches, seen = [], set()
    for record in records:
        if not citation_agrees(group, record): continue
        # Never infer a/b from alphabetical order or a truncated bibliography.
        if group.get('suffix') and record.get('referenceYearSuffix') != group['suffix']: continue
        if not record.get('title'): continue
        identity = normalize_doi(record.get('doi')) or record.get('referenceText') or record['title']
        if identity in seen: continue
        seen.add(identity)
        record.update(citationMatch={key:group.get(key) for key in ('citation','authors','year','suffix','etAl')},
                      bibliographyParent={'id':str(parent.get('id') or ''), 'title':str(parent.get('title') or '')[:500]})
        matches.append(record)
    return matches[:60]
