"""Compare supplied bibliographic fields without inventing missing precision."""
import datetime
import re
import unicodedata


def words(value):
    value=''.join(c for c in unicodedata.normalize('NFKD',str(value or '')).casefold() if not unicodedata.combining(c))
    return re.findall(r'\w+',value)


def author_signature(value):
    if isinstance(value,dict):
        family=value.get('family') or value.get('surname') or ''
        given=value.get('given') or value.get('initials') or ''
        orcid=str(value.get('ORCID') or value.get('orcid') or '').rsplit('/',1)[-1]
    else:
        value=str(value or '').strip()
        orcid=''
        if ',' in value:family,given=value.split(',',1)
        else:
            parts=value.split()
            if len(parts)>1 and re.fullmatch(r'[A-Z]{1,4}',parts[-1]):family,given=' '.join(parts[:-1]),parts[-1]
            else:
                pivot=max(0,len(parts)-1)
                while pivot>0 and parts[pivot-1].casefold() in {'de','del','van','von','den','der','da','di'}:pivot-=1
                family,given=' '.join(parts[pivot:]),' '.join(parts[:pivot])
    initials=[]
    for part in re.findall(r'[^\W\d_]+',str(given),re.UNICODE):
        initials.extend(part if part.isupper() and len(part)<=4 else part[:1])
    return {'family':''.join(words(family)),'initials':''.join(initials).casefold(),'orcid':orcid}


def initials_agree(first,second):
    return first.startswith(second) or second.startswith(first)


def journal_agrees(first,second):
    abbreviations={'natl':'national','intl':'international','inst':'institute','proc':'proceedings'}
    a=[abbreviations.get(w,w) for w in words(first) if w not in {'the','of','and','in','a'}]
    b=[abbreviations.get(w,w) for w in words(second) if w not in {'the','of','and','in','a'}]
    if a==b:return True
    if len(a)==1 and a[0]==''.join(w[0] for w in b):return True
    if len(b)==1 and b[0]==''.join(w[0] for w in a):return True
    return len(a)==len(b) and all(x.startswith(y) or y.startswith(x) for x,y in zip(a,b))


def field_key(value):
    return ''.join(words(value)).lstrip('0')


def pages_key(value):
    value=re.sub(r'\s+','',str(value or '').casefold()).replace('–','-').replace('—','-')
    match=re.fullmatch(r'(\d+)-(\d+)',value)
    if match and len(match[2])<len(match[1]):
        end=match[1][:-len(match[2])]+match[2]
        if int(end)>=int(match[1]):value=match[1]+'-'+end
    return value


def date_check(expected,metadata):
    expected=str(expected or '')
    if not re.fullmatch(r'\d{4}(?:-\d{2}){1,2}',expected):return None
    try:datetime.date.fromisoformat(expected+'-01' if len(expected)==7 else expected)
    except ValueError:return False
    actual=[metadata.get('date'),*(metadata.get('publicationDates') or {}).values()]
    precise=[str(value) for value in actual if re.fullmatch(r'\d{4}(?:-\d{2}){1,2}',str(value or '')) and len(str(value))>=len(expected)]
    return any(value.startswith(expected) for value in precise) if precise else None


def extra_identity_checks(candidate,metadata):
    checks={}
    expected=candidate.get('referenceAuthorDetails') or candidate.get('authorDetails') or candidate.get('authors') or []
    actual=metadata.get('authorDetails') or metadata.get('authors') or []
    if isinstance(expected,str):expected=[expected]
    if isinstance(actual,str):actual=[actual]
    signatures=[author_signature(author) for author in actual]
    initials,orcids=[],[]
    for index,author in enumerate(expected):
        signature=author_signature(author)
        matched=[s for s in signatures if s['family']==signature['family']]
        if index==0 and signatures:matched=signatures[:1] if signatures[0]['family']==signature['family'] else []
        if signature['initials'] and any(s['initials'] for s in matched):
            initials.append(any(initials_agree(signature['initials'],s['initials']) for s in matched if s['initials']))
        if signature['orcid'] and any(s['orcid'] for s in matched):orcids.append(any(signature['orcid']==s['orcid'] for s in matched))
    checks['authorInitials']=all(initials) if initials else None
    checks['orcid']=all(orcids) if orcids else None
    checks['journal']=None
    if candidate.get('journal') and metadata.get('journal'):
        issn_a={value.replace('-','').upper() for value in re.findall(r'\d{4}-?[\dXx]{4}',str(candidate.get('issn') or ''))}
        issn_b={value.replace('-','').upper() for value in re.findall(r'\d{4}-?[\dXx]{4}',str(metadata.get('issn') or ''))}
        checks['journal']=bool(issn_a&issn_b) or journal_agrees(candidate['journal'],metadata['journal'])
    for field in ('volume','issue'):
        checks[field]=field_key(candidate[field])==field_key(metadata[field]) if candidate.get(field) and metadata.get(field) else None
    actual_pages=metadata.get('pages') or metadata.get('articleNumber')
    checks['pages']=pages_key(candidate['pages'])==pages_key(actual_pages) if candidate.get('pages') and actual_pages else None
    checks['publicationDate']=date_check(candidate.get('date'),metadata)
    return checks
