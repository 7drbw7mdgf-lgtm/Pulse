"""Shared, bounded multi-phrase and tag semantics for library and online search."""
import re
import unicodedata
from pulse_core.constants import ClientError

MAX_TERMS = 12

def clean(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value))).strip()

def unique(values):
    result=[];seen=set()
    for value in values:
        if not isinstance(value,str): raise ClientError(400,'Search terms must be text.')
        value=clean(value)
        if not value: continue
        if len(value)>120: raise ClientError(400,'Keep each search phrase or tag to 120 characters.')
        if value.casefold() not in seen: result.append(value);seen.add(value.casefold())
    return result

def parse_search(query='', keywords=None, tags=None, match=None):
    if not isinstance(query,str) or len(query)>1000: raise ClientError(400,'Use a search of up to 1,000 characters.')
    if keywords is not None and not isinstance(keywords,list) or tags is not None and not isinstance(tags,list):
        raise ClientError(400,'Keywords and tags must be lists.')
    found_tags=[]
    def tag(match):
        found_tags.append(match.group(1) or match.group(2));return ' '
    rest=re.sub(r'(?<![\w])(?:#|tag:)(?:"([^"]+)"|([\w][\w.-]*))',tag,query,flags=re.I)
    parts=[];buf=[];quoted=False;operators=set();i=0
    while i<len(rest):
        ch=rest[i]
        if ch=='"':
            if quoted and i+1<len(rest) and rest[i+1]=='"':buf.append('"');i+=2;continue
            quoted=not quoted;i+=1;continue
        operator=next((word for word in (' AND ',' OR ') if not quoted and rest.startswith(word,i)),None)
        if not quoted and (ch in ',;\n' or operator):
            parts.append(''.join(buf));buf=[]
            if operator:operators.add(operator.strip());i+=len(operator)
            else:i+=1
            continue
        buf.append(ch);i+=1
    if quoted: raise ClientError(400,'Close the quotation mark around your search phrase.')
    parts.append(''.join(buf))
    if len(operators)>1: raise ClientError(400,'Choose All or Any instead of mixing AND and OR in one search.')
    structured=keywords is not None or bool(tags) or bool(found_tags) or any(c in query for c in ',;\n"') or bool(operators)
    words=unique(keywords if keywords is not None else parts) if structured else []
    selected_tags=unique((tags or [])+found_tags)
    if len(words)+len(selected_tags)>MAX_TERMS: raise ClientError(400,f'Use up to {MAX_TERMS} keyword phrases and tags in one search.')
    mode=match or ('any' if 'OR' in operators else 'all')
    if mode not in {'all','any'}: raise ClientError(400,'Choose All or Any matching.')
    return {'keywords':words,'tags':selected_tags,'match':mode,'structured':structured}

def normalize_search_request(payload):
    parsed=parse_search(payload.get('query',payload.get('researchQuestion','')) or '',payload.get('queryKeywords'),payload.get('queryTags'),payload.get('queryMatch'))
    result=dict(payload,queryKeywords=parsed['keywords'],queryTags=parsed['tags'],queryMatch=parsed['match'])
    mode=payload.get('rankingMode')
    if mode is not None and mode not in {'fast','enhanced'}: raise ClientError(400,'Choose Fast or Enhanced ranking.')
    if mode=='fast':result.update(semanticRerank=False,pairwiseRerank=False,aiTriage=False)
    if parsed['structured'] and payload.get('searchMode')=='concept':
        query=' '.join(parsed['keywords']+parsed['tags'])
        if not query: raise ClientError(400,'Enter at least one keyword phrase or tag.')
        result.update(query=query,researchQuestion=query)
    return result,parsed

def matches_search(paper, keywords=(), tags=(), match='all', local=False):
    terms=list(keywords)+list(tags)
    if not terms:return True
    fields=[paper.get('title',''),paper.get('abstract',''),' '.join(str(x) for x in paper.get('paperKeywords') or []),' '.join(str(x) for x in paper.get('gemmaKeywords') or [])]
    if local: fields += [paper.get('notes',''),' '.join(str(x) for x in paper.get('authors') or [])]
    text=' '+' '.join(re.findall(r'\w+',clean(' '.join(str(x) for x in fields)).casefold()))+' '
    def phrase(value): return ' '+' '.join(re.findall(r'\w+',clean(value).casefold()))+' '
    tests=[phrase(value) in text for value in keywords]
    if local:
        actual={clean(x).casefold() for key in ('userTags','tags','paperKeywords','gemmaKeywords') for x in paper.get(key) or [] if isinstance(x,str)}
        tests += [clean(value).casefold() in actual for value in tags]
    else: tests += [phrase(value) in text for value in tags]
    return any(tests) if match=='any' else all(tests)

def prepared_search(parsed, query):
    terms=parsed['keywords']+parsed['tags']
    return {'query':query,'keywords':terms,'groups':[[term] for term in terms],
            'aiAssisted':False,'structured':True,'match':parsed['match'],
            'notice':'Matching '+parsed['match']+' keyword phrases and tags in paper metadata. Tags are search terms online.'}
