"""Bounded status lookup for the selected DOI, never every ranking candidate."""
import copy
import time
import urllib.parse
from .constants import ClientError
from .doi_utils import normalize_doi
from .external_apis import fetch_json
from .publication_records import crossref_publication_data,checked_at,notice_date,NOTICE_TYPES
from pulse_performance import REQUEST_CONTEXT


def publication_status(payload):
    doi=normalize_doi(payload.get('doi') or (payload.get('paper') or {}).get('doi'))
    if not doi:raise ClientError(400,'Select a paper with a DOI to check publication updates.')
    previous=getattr(REQUEST_CONTEXT,'deadline',None)
    REQUEST_CONTEXT.deadline=min(previous,time.monotonic()+8) if previous else time.monotonic()+8
    from .preprint_servers import is_preprint_doi,preprint_record
    preprint=[]
    if is_preprint_doi(doi):
        # The preprint server records its journal version even when the registry does not.
        try:preprint=(preprint_record(doi) or {}).get('publicationRelations') or []
        except Exception:preprint=[]
    try:
        item=fetch_json('https://api.crossref.org/works/'+urllib.parse.quote(doi,safe='')).get('message') or {}
        if normalize_doi(item.get('DOI')).casefold()!=doi.casefold():raise ValueError('Registry identity mismatch')
        data=crossref_publication_data(item)
        notices=[]
        query=urllib.parse.urlencode({'filter':'updates:'+doi,'rows':40})
        found=fetch_json('https://api.crossref.org/works?'+query).get('message') or {}
        for notice in found.get('items') or []:
            for update in notice.get('update-to') or []:
                if not isinstance(update,dict) or normalize_doi(update.get('DOI')).casefold()!=doi.casefold() or update.get('type') not in NOTICE_TYPES:continue
                notice_doi=normalize_doi(notice.get('DOI'))
                if not notice_doi:continue
                entry={'type':update['type'],'doi':notice_doi,'date':notice_date(update),'relation':'updated-by',
                    'source':'Crossref / Retraction Watch' if update.get('source')=='retraction-watch' else 'Crossref'}
                if entry not in notices:notices.append(entry)
        data['publicationNotices']+=notices
        known={(relation['type'],relation['doi'].casefold()) for relation in data['publicationRelations']}
        data['publicationRelations']+=[relation for relation in preprint if (relation['type'],relation['doi'].casefold()) not in known]
        kinds={notice['type'] for notice in notices}
        status='notice' if data.get('publicationRole')=='notice' else 'retracted' if kinds&{'retraction','withdrawal'} else 'concern' if kinds&{'expression-of-concern','partial-retraction'} else 'corrected' if kinds&{'correction','erratum'} else 'updated' if kinds else 'no-notice-found'
        data['publicationStatus']={'status':status,'source':'Crossref','checkedAt':checked_at(),'complete':int(found.get('total-results') or 0)<=40}
        if status=='retracted':data['isRetracted']=True
        return {'ok':True,'available':True,'doi':doi,'metadata':data}
    except Exception:
        if preprint:return {'ok':True,'available':True,'doi':doi,'metadata':{'publicationRelations':preprint}}
        return {'ok':True,'available':False,'doi':doi,'message':'Publication updates could not be checked. Previously recorded notices are retained.'}
    finally:REQUEST_CONTEXT.deadline=previous
