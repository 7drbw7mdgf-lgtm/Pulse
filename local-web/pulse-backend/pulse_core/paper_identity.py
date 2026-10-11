"""Conservative seed identity checks shared by all discovery providers."""
from pulse_core.doi_utils import normalize_doi
from pulse_core.metadata_resolution import candidate_score

def confident_candidate(expected, candidates):
    matches = []
    doi = normalize_doi(expected.get('doi')).lower()
    pmid = str(expected.get('pmid') or '')
    for candidate in candidates:
        other_doi = normalize_doi(candidate.get('doi')).lower()
        if doi and other_doi and doi != other_doi: continue
        if pmid and candidate.get('pmid') and pmid != str(candidate['pmid']): continue
        scored = candidate_score(expected, candidate)
        # Exact registered IDs identify a paper; title lookup needs supporting
        # evidence and rejects conflicting authors even on a generic exact title.
        if (doi and doi == other_doi) or (pmid and pmid == str(candidate.get('pmid') or '')):
            if 'title' not in scored['fields'] or scored['fields']['title'] >= .72: return candidate
        if not scored['accepted']: continue
        if expected.get('authors') and candidate.get('authors') and scored['fields'].get('authors', 0) < .5: continue
        if expected.get('year') and candidate.get('year') and scored['fields'].get('year') == 0: continue
        matches.append((scored['score'], candidate))
    matches.sort(key=lambda pair: pair[0], reverse=True)
    if not matches: return None
    if len(matches)>1 and matches[0][0]-matches[1][0]<.05:
        a, b = matches[0][1], matches[1][1]
        if not (normalize_doi(a.get('doi')) and normalize_doi(a.get('doi')) == normalize_doi(b.get('doi'))): return None
    return matches[0][1]
