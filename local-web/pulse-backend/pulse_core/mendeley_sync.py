"""Account-bound, paged import of bibliographic records. No uploads or deletions."""
import re
import time
import urllib.parse
from pulse_core import library_managers as managers
from pulse_core.constants import ClientError


def validate_page(path):
    if not isinstance(path,str) or len(path)>4096 or '\\' in path: raise ClientError(400,'Invalid library page.')
    target=urllib.parse.urlsplit(path)
    fields=urllib.parse.parse_qs(target.query,keep_blank_values=True)
    if target.scheme or target.netloc or target.fragment or target.path!='/documents' or set(fields)-{'view','limit','marker','order','sort','modified_since'} or any(len(v)!=1 for v in fields.values()):
        raise ClientError(400,'Invalid library page.')
    if fields.get('view',['all'])[0] not in {'all','client'}: raise ClientError(400,'Use JSON library records.')
    try: valid=1<=int(fields.get('limit',['100'])[0])<=100
    except ValueError: valid=False
    if not valid: raise ClientError(400,'Use pages of at most 100 records.')
    return path


def connected_config():
    with managers.config_lock(): config=managers.read_config()
    if config.get('authFlow')=='broker':
        if not config.get('brokerSession'): raise ClientError(401,'Connect Mendeley to sync your library.')
        return config
    access=managers.access_token()
    if not config.get('mendeleyAccountId'):
        profile=managers.request(managers.MENDELEY+'/profiles/v2/me',headers={'Authorization':'Bearer '+access})
        if not isinstance(profile,dict) or not isinstance(profile.get('id'),str) or not profile['id']: raise ClientError(502,'The account could not be confirmed.')
        with managers.config_lock():
            current=managers.read_config()
            if current.get('authGeneration',0)!=config.get('authGeneration',0): raise ClientError(409,'The Mendeley connection changed.')
            current['mendeleyAccountId']=profile['id'];managers.write_config(current);config=current
    return config


def normalized_document(item):
    if not isinstance(item,dict) or not item.get('id') or not str(item.get('title') or '').strip(): return None
    identifiers=item.get('identifiers') or {}
    authors=[' '.join(filter(None,(a.get('first_name'),a.get('last_name')))) for a in item.get('authors') or [] if isinstance(a,dict)]
    date=str(item.get('year') or '')
    if date and item.get('month'):
        date+='-'+str(item['month']).zfill(2)
        if item.get('day'): date+='-'+str(item['day']).zfill(2)
    record=managers.record_metadata(dict(item,authors=authors,journal=item.get('source'),doi=identifiers.get('doi'),
        pmid=identifiers.get('pmid'),issn=identifiers.get('issn'),isbn=identifiers.get('isbn'),date=date,url=(item.get('websites') or [''])[0]))
    return dict(record,remoteId=str(item['id']),paperKeywords=list(dict.fromkeys(record['keywords']+[str(v) for v in item.get('tags') or []])),metadataSource='Mendeley')


def page(payload):
    config=connected_config();account=config.get('mendeleyAccountId')
    if not isinstance(account,str) or not account: raise ClientError(401,'Reconnect Mendeley to confirm your account.')
    if payload.get('accountId') and payload['accountId']!=account: raise ClientError(409,'Your Mendeley account changed. Start sync again.')
    path=validate_page(payload.get('page') or '/documents?view=all&limit=100')
    if config.get('authFlow')=='broker':
        from pulse_core.mendeley_broker import library
        envelope=library(path,config=config)
    else:
        envelope=managers.request(managers.MENDELEY+path,headers={'Authorization':'Bearer '+managers.access_token()},envelope=True)
    with managers.config_lock(): current=managers.read_config()
    if current.get('authGeneration',0)!=config.get('authGeneration',0) or current.get('mendeleyAccountId')!=account:
        raise ClientError(409,'Your Mendeley account changed. Start sync again.')
    items=envelope.get('data')
    if not isinstance(items,list): raise ClientError(502,'Mendeley did not return a library page.')
    following=envelope.get('next')
    if following: validate_page(following)
    records=[record for item in items if (record:=normalized_document(item))]
    return {'ok':True,'accountId':account,'items':records,'next':following,'skipped':len(items)-len(records)}


def preferences(payload):
    with managers.config_lock():
        config=managers.read_config()
        if 'automatic' in payload:
            if not isinstance(payload['automatic'],bool): raise ClientError(400,'Choose whether to sync automatically.')
            config['mendeleyAutomaticSync']=payload['automatic']
        if payload.get('completed'):
            if config.get('mendeleyAccountId')!=payload.get('accountId'): raise ClientError(409,'Your Mendeley account changed.')
            config['mendeleyLastSyncedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        managers.write_config(config)
    return {'ok':True}
