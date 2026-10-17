"""Merge matching provider records without confusing different editions/DOIs."""
import copy
import html
import re
import unicodedata
from pulse_core.doi_utils import normalize_doi
from pulse_core.metadata_utils import citation_count


def title_key(value):
    value = unicodedata.normalize("NFKC", html.unescape(str(value or ""))).casefold()
    return " ".join(re.findall(r"\w+", value))


# Supporting-information and figure/table DOIs identify a part of a paper.
SUPPLEMENT_DOI_RE = re.compile(r"^(10\.(?:1021|1371)/.+?)\.(?:s|g|t|sd)\d{3,}$", re.I)


def canonical_doi(value):
    doi = normalize_doi(value)
    match = SUPPLEMENT_DOI_RE.match(doi)
    return match.group(1) if match else doi


def sane_year(record):
    """Blank impossible publication years (index artefacts such as 1753)."""
    import datetime
    year = str(record.get("year") or "")[:4]
    if year.isdigit() and not 1800 <= int(year) <= datetime.date.today().year + 1:
        record["year"] = ""
        if str(record.get("date") or "").startswith(year):
            record["date"] = ""
    return record


def clean_title(value):
    """Index titles sometimes carry markup ("<i>Campylobacter</i>") or entities."""
    text = html.unescape(re.sub(r"<[^>]+>", "", html.unescape(str(value or ""))))
    return re.sub(r"\s+", " ", text).strip()


def known_count(record):
    for field in ('citationCount', 'citedByCount'):
        value = citation_count(record.get(field))
        if value is not None:
            return value
    return None


def compatible(first, second):
    years = [str(record.get("year") or record.get("date") or "")[:4] for record in (first, second)]
    if all(years) and years[0] != years[1]:
        return False
    authors = [{title_key(name) for name in record.get("authors") or []} for record in (first, second)]
    # Author initials can vary across indexes; compare family names as well.
    def surname(value):
        name = title_key(str(value).split(',')[0])
        words = [word for word in name.split() if len(word) > 1]
        return words[-1] if words else name
    surnames = [{surname(name) for name in record.get("authors") or [] if name} for record in (first, second)]
    return not all(authors) or bool(authors[0] & authors[1] or surnames[0] & surnames[1])


def merge_search_records(records):
    records = [sane_year(copy.deepcopy(record)) for record in records if record.get("title") or record.get("doi")]
    for record in records:
        if record.get("doi"):
            record["doi"] = canonical_doi(record["doi"])
        if record.get("title"):
            record["title"] = clean_title(record["title"])
    groups, by_doi, by_title = [], {}, {}
    # Establish DOI identities before attaching records which only have a title.
    ordered = sorted(enumerate(records), key=lambda pair: not bool(normalize_doi(pair[1].get("doi"))))
    for position, record in ordered:
        doi, title = normalize_doi(record.get("doi")).lower(), title_key(record.get("title"))
        if doi:
            record["doi"] = normalize_doi(record["doi"])
        group = by_doi.get(doi) if doi else None
        if group is None and not doi and title:
            matches = [item for item in by_title.get(title, []) if compatible(item["record"], record)]
            if len(matches) == 1:
                group = matches[0]
        if group is None:
            group = {"record": record, "position": position}
            groups.append(group)
            if doi:
                by_doi[doi] = group
            if title:
                by_title.setdefault(title, []).append(group)
        else:
            base = group["record"]
            for key, value in record.items():
                if key not in {"branches", "sourceList", "fullTextLinks", "discoveryBadges", "sourceIdentifiers", "citationCountsBySource", "retrievalEvidence", "citationCount", "citedByCount", "citationCountSource", "citationContexts", "citationIntents"} and value not in (None, "", [], {}) and base.get(key) in (None, "", [], {}):
                    base[key] = value
            for key in ("branches", "sourceList", "fullTextLinks", "discoveryBadges", "retrievalEvidence", "publicationRelations", "publicationNotices", "citationIntents"):
                if key in base or key in record:
                    base[key] = list(base.get(key) or [])
                    for value in record.get(key) or []:
                        if value not in base[key]:
                            base[key].append(value)
            if "citationContexts" in base or "citationContexts" in record:
                merged_ctx = list(base.get("citationContexts") or [])
                for ctx in record.get("citationContexts") or []:
                    s = str(ctx or "").strip()
                    if s and s not in merged_ctx and len(merged_ctx) < 3:
                        merged_ctx.append(s[:300])
                if merged_ctx:
                    base["citationContexts"] = merged_ctx
            if record.get("isInfluentialCitation") is True:
                base["isInfluentialCitation"] = True
            if record.get('isRetracted') is True:base['isRetracted']=True
            # Several indexes may report citations; keep the highest known count.
            incoming = known_count(record)
            if incoming is not None and (known_count(base) is None or incoming > known_count(base)):
                base["citationCount"] = base["citedByCount"] = incoming
                base["citationCountSource"] = record.get("citationCountSource") or record.get("metadataSource") or ''
            for key in ("sourceIdentifiers", "citationCountsBySource"):
                if key in base or key in record:
                    base[key] = {**(record.get(key) or {}), **(base.get(key) or {})}
            if record.get("date") and str(record["date"]).startswith(str(base.get("date") or "")) and len(str(record["date"])) > len(str(base.get("date") or "")):
                base["date"] = record["date"]
            group["position"] = min(group["position"], position)
            # DOI records establish the identity; additional providers fill
            # gaps, and their citation counts retain provenance.
    return [group["record"] for group in sorted(groups, key=lambda group: group["position"])]
