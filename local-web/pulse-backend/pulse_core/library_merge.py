"""Explicit two-record merges, with a durable recovery point before writing."""
import copy
import json
from pulse_core.constants import ClientError

FIELDS = {'title','authors','year','date','journal','doi','pmid','pmcid','abstract','volume','issue','pages','publisher','url','fullTextUrl','readingStatus','relevance','language','publicationType'}

def unique(values):
    result, seen = [], set()
    for value in values:
        key = json.dumps(value, sort_keys=True, ensure_ascii=False)
        if key not in seen:
            seen.add(key); result.append(copy.deepcopy(value))
    return result

def merge_records(papers, keep_id, other_id, choices):
    by_id = {p['id']:p for p in papers}
    if keep_id == other_id or keep_id not in by_id or other_id not in by_id:
        raise ClientError(409, 'Choose two different papers still in the library.')
    a,b = by_id[keep_id],by_id[other_id]
    if not isinstance(choices,dict) or any(key not in FIELDS or value not in (keep_id,other_id) for key,value in choices.items()):
        raise ClientError(400, 'Choose an existing value for each metadata field.')
    out = copy.deepcopy(a)
    for key,value in b.items():
        if key not in out or out[key] in (None,'',[],{}): out[key]=copy.deepcopy(value)
    for field, identity in choices.items(): out[field]=copy.deepcopy(by_id[identity].get(field,''))
    # A DOI selection also selects its verification and associated identity metadata.
    if 'doi' in choices:
        chosen=by_id[choices['doi']]
        for key in ('doiVerified','metadataVerification','metadataMatch','metadataSnapshot'): out[key]=copy.deepcopy(chosen.get(key))
    for key in ('userTags','tags','paperKeywords','gemmaKeywords','referenceIds','citedByIds','sourceList','fullTextLinks','evidencePassages','pdfAttachments','pdfAnnotations','pdfQuotes','mergedAliases'):
        out[key]=unique((a.get(key) or [])+(b.get(key) or []))
    out['mapIds']=unique((a.get('mapIds') or ([a['mapId']] if a.get('mapId') else []))+(b.get('mapIds') or ([b['mapId']] if b.get('mapId') else [])))
    out['selected']=a.get('selected') is not False or b.get('selected') is not False
    notes=unique([str(p.get('notes') or '') for p in (a,b) if p.get('notes')])
    out['notes']='\n\n'.join(notes)
    out['text']=max((str(a.get('text') or ''),str(b.get('text') or '')),key=len)
    out['sourceIdentifiers']={**(b.get('sourceIdentifiers') or {}),**(a.get('sourceIdentifiers') or {})}
    out['mergedAliases']=unique(out['mergedAliases']+[{key:p.get(key) for key in ('id','syncId','doi','pmid','openAlexId','s2PaperId','mendeleySource') if p.get(key)} for p in (a,b)])
    out['id']=keep_id
    return out

def merge(payload):
    from pulse_core import storage
    with storage.LIBRARY_WRITE_LOCK:
        before=storage._validate_workspace(payload.get('workspace'))
        keep,other=payload.get('keepId'),payload.get('otherId')
        merged=merge_records(before['papers'],keep,other,payload.get('choices',{}))
        after=copy.deepcopy(before)
        after['papers']=[merged if p['id']==keep else p for p in before['papers'] if p['id']!=other]
        after['links']=[]
        for original in before.get('links',[]):
            link=dict(original)
            for field in ('source','target'):
                if link.get(field)==other: link[field]=keep
            if link.get('source')!=link.get('target'): after['links'].append(link)
        after['links']=unique(after['links'])
        for key in ('selectedId','centerId'):
            if after.get(key)==other: after[key]=keep
        identity=storage._snapshot(before,'merge',[keep,other])
        path=storage._core.CONFIG_DIR/'recovery'/(identity+'.json')
        snapshot=json.loads(path.read_text('utf-8'));snapshot['mergedId']=keep;snapshot['mergedPaper']=merged
        storage._write_recovery(path,snapshot)
        storage._core._save_library(dict(after,allowEmpty=True));storage._write_barrier(payload)
        return {'ok':True,'recoveryId':identity,'workspace':after}
