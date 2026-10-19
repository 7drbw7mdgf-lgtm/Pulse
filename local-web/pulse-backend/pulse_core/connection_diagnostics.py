"""Explicit connection checks with actionable classifications and no credentials in output."""
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pulse_core.constants import ClientError, time_iso
from pulse_core import library_managers as managers


def classify_error(error, provider='Mendeley'):
    status=getattr(error,'status',None)
    stage=getattr(error,'mendeley_stage','')
    code=getattr(error,'mendeley_code','')
    message=str(error).lower()
    if status==429:
        return {'status':'warning','code':'rate_limited','message':provider+' is temporarily rate-limiting requests. Wait, then retry; your saved papers are unchanged.'}
    if provider=='Mendeley' and ('client' in stage or 'client' in code or 'application authentication' in message or 'application credentials' in message):
        return {'status':'error','code':'application_credentials','message':'Mendeley rejected the application credentials. Choose Use Pulse sign-in in Connection settings; if the shared service still fails, its registration needs repair.'}
    if status in {401,403}:
        return {'status':'error','code':'sign_in_expired' if provider=='Mendeley' else 'api_key_rejected',
                'message':'Mendeley sign-in expired or was rejected. Connect again in Reference managers.' if provider=='Mendeley' else provider+' rejected the API key. Update or remove it in Search sources settings.'}
    if status==406:
        return {'status':'error','code':'api_format','message':provider+' rejected the API response format. Update Pulse and retry.'}
    return {'status':'warning','code':'service_unavailable','message':provider+' could not be reached. Check the connection and retry; your saved papers are unchanged.'}


def check_mendeley():
    config=managers.read_config()
    if not any(config.get(key) for key in ('accessToken','refreshToken','brokerSession')):
        return {'name':'Mendeley','status':'warning','code':'not_connected','message':'Not signed in. Choose Use Pulse sign-in in Reference managers to connect.'}
    try:
        if config.get('authFlow')=='broker': managers.mendeley_request('/profiles/me')
        else: managers.request(managers.MENDELEY+'/profiles/me',headers={'Authorization':'Bearer '+managers.access_token(),
                              'Accept':'application/vnd.mendeley-profiles.1+json'},timeout=6)
        return {'name':'Mendeley','status':'ok','code':'connected','message':'Account access is working. You can sync citations.'}
    except Exception as error: return {'name':'Mendeley',**classify_error(error)}


def check_semantic_scholar():
    from pulse_core.storage import load_settings
    from pulse_core.config_resolvers import resolve_semantic_scholar_api_key
    key=resolve_semantic_scholar_api_key(load_settings())
    if not key:
        return {'name':'Semantic Scholar','status':'info','code':'public_search','message':'No API key is configured. Public search remains available, with provider limits.'}
    try:
        managers.request('https://api.semanticscholar.org/graph/v1/paper/search?query=connection%20check&limit=1&fields=title',headers={'x-api-key':key},timeout=6)
        return {'name':'Semantic Scholar','status':'ok','code':'connected','message':'The configured API key was accepted.'}
    except Exception as error:return {'name':'Semantic Scholar',**classify_error(error,'Semantic Scholar')}


def check_library():
    from pulse_core.storage import library_store
    try:
        db=library_store().connect()
        try:
            result=db.execute('PRAGMA quick_check(1)').fetchone()[0]
            count=db.execute('SELECT COUNT(*) FROM papers').fetchone()[0]
        finally:db.close()
        if result!='ok':return {'name':'Library storage','status':'error','code':'database_check','message':'The database check found an issue. Export your library or use a recovery point before continuing.'}
        return {'name':'Library storage','status':'ok','code':'sqlite','message':f'SQLite integrity check passed. {count} papers saved.'}
    except Exception:return {'name':'Library storage','status':'error','code':'storage_unavailable','message':'Pulse could not check the saved library. Check available disk space and the data-folder permissions.'}


def check_connections(payload=None):
    checks=[check_library,check_mendeley,check_semantic_scholar]
    with ThreadPoolExecutor(max_workers=3,thread_name_prefix='pulse-connection-check') as pool:
        results=list(pool.map(lambda check:check(),checks))
    return {'ok':True,'checkedAt':time_iso(),'checks':results,'runtime':{'bundledPython':bool(getattr(sys,'frozen',False)),'pythonVersion':sys.version.split()[0]}}
