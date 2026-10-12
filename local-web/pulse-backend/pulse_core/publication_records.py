"""Registry publication relationships, kept distinct from correction notices."""
import datetime
from .doi_utils import normalize_doi

VERSION_RELATIONS={'is-preprint-of','has-preprint','is-version-of','has-version','is-identical-to'}
NOTICE_TYPES={'retraction','withdrawal','correction','erratum','expression-of-concern','addendum','new-version','clarification','partial-retraction'}


def checked_at():return datetime.datetime.now(datetime.timezone.utc).isoformat()


def notice_date(update):
    parts=(update.get('updated') or {}).get('date-parts') or []
    return '-'.join(str(value) if index==0 else str(value).zfill(2) for index,value in enumerate(parts[0][:3])) if parts and parts[0] else ''


def crossref_publication_data(item):
    doi=normalize_doi(item.get('DOI')).lower()
    relations=[]
    for kind,rows in (item.get('relation') or {}).items():
        if kind not in VERSION_RELATIONS or not isinstance(rows,list):continue
        for row in rows[:40]:
            if not isinstance(row,dict) or str(row.get('id-type') or '').lower()!='doi':continue
            target=normalize_doi(row.get('id'))
            if target:relations.append({'type':kind,'doi':target,'source':'Crossref'})
    updates=[row for row in item.get('update-to') or [] if isinstance(row,dict) and row.get('type') in NOTICE_TYPES and normalize_doi(row.get('DOI'))]
    notices=[{'type':row['type'],'doi':normalize_doi(row['DOI']),'relation':'updates','date':notice_date(row),
              'source':'Crossref / Retraction Watch' if row.get('source')=='retraction-watch' else 'Crossref'} for row in updates]
    data={'publicationRelations':relations,'publicationNotices':notices}
    if any(normalize_doi(row['DOI']).lower()!=doi for row in updates):data['publicationRole']='notice'
    return data


def fold_explicit_versions(records):
    """Only DOI relationships assert versions; update notices are never folded."""
    by_doi={normalize_doi(record.get('doi')).lower():i for i,record in enumerate(records) if normalize_doi(record.get('doi'))}
    parents=list(range(len(records)))
    def find(index):
        while parents[index]!=index:parents[index]=parents[parents[index]];index=parents[index]
        return index
    for index,record in enumerate(records):
        if record.get('publicationRole')=='notice':continue
        for relation in record.get('publicationRelations') or []:
            other=by_doi.get(normalize_doi(relation.get('doi')).lower())
            if relation.get('type') not in VERSION_RELATIONS or other is None or records[other].get('publicationRole')=='notice':continue
            parents[find(other)]=find(index)
    groups={}
    for index,record in enumerate(records):groups.setdefault(find(index),[]).append(record)
    folded=[]
    for rows in groups.values():
        def published(record):
            if any(relation.get('type')=='is-preprint-of' for relation in record.get('publicationRelations') or []):return False
            return str(record.get('publicationType') or record.get('documentType') or '') not in {'preprint','posted-content','working-paper'}
        primary=max(rows,key=lambda row:(published(row),bool(row.get('doi')),row.get('score',0)))
        for other in rows:
            if other is primary:continue
            primary.setdefault('relatedVersions',[]).append({key:other.get(key) for key in ('title','doi','url','year','publicationType','sourceList')})
            primary['score']=max(primary.get('score',0),other.get('score',0))
            for key in ('retrievalEvidence','sourceList','branches'):
                primary[key]=list(primary.get(key) or [])+[item for item in other.get(key) or [] if item not in primary.get(key,[])]
        folded.append(primary)
    return folded
