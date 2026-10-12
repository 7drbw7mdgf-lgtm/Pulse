"""Session-local source circuit breaker, isolated by credential scope."""
import hashlib
import math
import threading
import time
import urllib.error
import urllib.parse
from email.utils import parsedate_to_datetime

_LOCK = threading.Lock()
_STATES = {}
LABELS = {'api.openalex.org':'OpenAlex','api.crossref.org':'Crossref','api.semanticscholar.org':'Semantic Scholar',
          'api.core.ac.uk':'CORE','www.ebi.ac.uk':'Europe PMC'}


class ProviderCooldown(Exception):
    def __init__(self, source, seconds, status=503):
        self.status, self.retry_after, self.source = status, seconds, source
        super().__init__(f'{source} temporarily paused; retry in {seconds} seconds. Other sources can continue.')


def scope(request):
    parsed = urllib.parse.urlsplit(request.full_url)
    credentials = [str(value) for key,value in request.header_items() if key.lower() in {'authorization','x-api-key'}]
    credentials += [value for key,value in urllib.parse.parse_qsl(parsed.query) if key.lower() in {'api_key','apikey','key','token'}]
    return (parsed.hostname or '', hashlib.sha256('\0'.join(credentials).encode()).hexdigest())


def check_source(request):
    key = scope(request)
    with _LOCK:
        state = _STATES.get(key) or {}
        seconds = math.ceil(state.get('until',0)-time.monotonic())
    if seconds>0:
        raise ProviderCooldown(LABELS.get(key[0],key[0]),seconds,state.get('status',503))


def retry_after(error):
    value = error.headers.get('Retry-After','') if getattr(error,'headers',None) else ''
    if not value: return None
    try: return max(0,min(3600,float(value)))
    except (ValueError,OverflowError):
        try: return max(0,min(3600,parsedate_to_datetime(value).timestamp()-time.time()))
        except (ValueError,TypeError,OverflowError): return None


def failed(request,error):
    status = getattr(error,'code',None)
    if status and status not in {429,500,502,503,504}: return
    if not status and not isinstance(error,(urllib.error.URLError,TimeoutError,OSError,ValueError)): return
    key = scope(request)
    with _LOCK:
        state = _STATES.setdefault(key,{'failures':0,'until':0})
        state['failures'] += 1
        delay = retry_after(error)
        if status==429: delay = delay if delay is not None else 60
        elif delay is None and state['failures']>=2: delay = min(300,30*2**min(3,state['failures']-2))
        if delay is not None and delay>0:
            state.update(until=time.monotonic()+delay,status=429 if status==429 else 503,
                         reason='Rate limit' if status==429 else 'Repeated source failures')
        if len(_STATES)>100:
            oldest = min(_STATES,key=lambda item:_STATES[item]['until'])
            if oldest != key: _STATES.pop(oldest,None)


def succeeded(request):
    with _LOCK: _STATES.pop(scope(request),None)


def cooldowns():
    """Public diagnostics omit URLs, credential fingerprints and raw errors."""
    result = {}
    with _LOCK:
        for (host,_),state in _STATES.items():
            seconds = math.ceil(state['until']-time.monotonic())
            if seconds>0 and host in LABELS:
                result[LABELS[host]]={'retryInSeconds':seconds,'reason':state.get('reason') or 'Source unavailable'}
    return result


def clear():
    with _LOCK: _STATES.clear()
