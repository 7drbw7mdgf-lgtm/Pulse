"""Desktop side of shared sign-in. Browser/UI receives no service credentials."""
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pulse_core.constants import ClientError

_LOCK=threading.Lock()
_PENDING=None
_STATUS={'pending':False,'authorizationMessage':''}

def origin(value):
    target=urllib.parse.urlsplit(value)
    if target.scheme!='https' or not target.hostname or target.username or target.password or target.path not in {'','/'} or target.query or target.fragment:
        raise ClientError(400,'The shared Mendeley service address is invalid.')
    return value.rstrip('/')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def request(base,path,payload,session=None):
    base=origin(base)
    if path not in {'/start','/claim','/library','/disconnect'}:raise ClientError(400,'Invalid Mendeley service operation.')
    headers={'Content-Type':'application/json','Accept':'application/json'}
    if session:headers['Authorization']='Bearer '+session
    req=urllib.request.Request(base+path,data=json.dumps(payload).encode(),headers=headers,method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=25) as response:
            raw=response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024:raise ValueError()
            result=json.loads(raw)
            if not isinstance(result,dict):raise ValueError()
            return result
    except urllib.error.HTTPError as error:
        raise ClientError(error.code if error.code in {400,401,403,409,429} else 502,'Mendeley sign-in or library access could not finish. Connect again or try later.') from None
    except (OSError,ValueError):raise ClientError(502,'The Mendeley connection service is unavailable. You can export citations instead.') from None

def status():
    with _LOCK:return dict(_STATUS)

def cancel():
    global _PENDING
    with _LOCK:
        if _PENDING:_PENDING.set()
        _PENDING=None;_STATUS.update(pending=False,authorizationMessage='')

def start(config):
    global _PENDING
    from pulse_core.mendeley_oauth import pkce_challenge
    from pulse_core import library_managers as managers
    cancel();base=origin(config['brokerUrl']);verifier=secrets.token_urlsafe(64)
    result=request(base,'/start',{'challenge':pkce_challenge(verifier)})
    identity=result.get('requestId');authorization=result.get('authorizationUrl','')
    if not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',identity) or authorization!=base+'/authorize?'+urllib.parse.urlencode({'request':identity}):
        raise ClientError(502,'The Mendeley service returned an invalid sign-in request.')
    cancelled=threading.Event()
    with _LOCK:_PENDING=cancelled;_STATUS.update(pending=True,authorizationMessage='Finish signing in with Mendeley, then return to Pulse.')
    def poll():
        message='Sign-in expired. Connect again in Pulse.'
        try:
            deadline=time.time()+600
            while not cancelled.wait(3) and time.time()<deadline:
                claim=request(base,'/claim',{'requestId':identity,'verifier':verifier})
                if claim.get('pending'):continue
                session=claim.get('session');account=claim.get('accountId')
                if not isinstance(session,str) or not re.fullmatch(r'[A-Za-z0-9_-]{64}',session) or not isinstance(account,str) or not account:
                    raise ClientError(502,'The account connection could not be confirmed.')
                accepted=False
                with managers.config_lock():
                    current=managers.read_config()
                    if not cancelled.is_set() and current.get('authGeneration',0)==config.get('authGeneration',0) and current.get('brokerUrl')==base and current.get('authFlow')=='broker':
                        current.update(brokerSession=session,mendeleyAccountId=account);managers.write_config(current);accepted=True
                if not accepted:
                    request(base,'/disconnect',{},session);message='Sign-in was cancelled.'
                else:message='Mendeley connected. Sync your library or send chosen papers.'
                break
        except ClientError as error:message=str(error)
        finally:
            with _LOCK:
                if _PENDING is cancelled:_STATUS.update(pending=False,authorizationMessage=message)
    threading.Thread(target=poll,daemon=True).start()
    return {'ok':True,'authorizationUrl':authorization}

def library(path,method='GET',data=None,config=None):
    from pulse_core import library_managers as managers
    if config is None:
        with managers.config_lock():config=managers.read_config()
    session=config.get('brokerSession')
    if not session:raise ClientError(401,'Connect your Mendeley account first.')
    result=request(config['brokerUrl'],'/library',{'path':path,'method':method,'data':data},session)
    if result.get('accountId')!=config.get('mendeleyAccountId'):raise ClientError(409,'The connected Mendeley account changed. Connect again.')
    return result
