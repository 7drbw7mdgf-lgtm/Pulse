"""Incomplete-judgment metrics, implemented independently in the stdlib."""
import math


def metrics(ids,grades,landmarks=(),tags=None,channels=None):
    ids=list(dict.fromkeys(ids));grades={key:int(value) for key,value in grades.items()}
    positive={key for key,grade in grades.items() if grade>0};negative={key for key,grade in grades.items() if grade==0}
    landmarks=set(landmarks);tags=tags or {};channels=channels or {}
    def recall(wanted,cutoff):return round(len(set(ids[:cutoff])&wanted)/len(wanted),4) if wanted else None
    def dcg(values):return sum((2**grade-1)/math.log2(index+2) for index,grade in enumerate(values))
    result={}
    condensed=[ident for ident in ids if ident in grades]
    for k in (10,20):
        ideal=dcg(sorted(grades.values(),reverse=True)[:k])
        result[f'nDCG@{k}']=round(dcg([grades.get(ident,0) for ident in ids[:k]])/ideal,4) if ideal else None
        result[f'condensedNDCG@{k}']=round(dcg([grades[ident] for ident in condensed[:k]])/ideal,4) if ideal else None
    # Ignore unjudged documents. Missing known relevant papers contribute zero.
    denominator=min(len(positive),len(negative));nonrel=0;preference=0.
    for ident in ids:
        if ident in negative:nonrel+=1
        elif ident in positive and denominator:preference+=1-min(nonrel,denominator)/denominator
    result['bpref']=round(preference/len(positive),4) if denominator else None
    result.update({'KnownRelevantRecall@20':recall(positive,20),'KnownRelevantRecall@50':recall(positive,50),
        'LandmarkRecall@50':recall(landmarks,50),'KnownRelevantHits@20':len(set(ids[:20])&positive),
        'LandmarkHits@50':len(set(ids[:50])&landmarks),'missedLandmarks':sorted(landmarks-set(ids[:50])),
        'missedKnownPapers':sorted(positive-set(ids[:50])),
        'ranks':{ident:ids.index(ident)+1 if ident in ids else None for ident in sorted(grades)},'top20':ids[:20],
        'unjudged@20':sum(ident not in grades for ident in ids[:20]),'judgedRelevant':len(positive),'judgedNonRelevant':len(negative),
        'recallByTag@50':{tag:recall({ident for ident in positive if tags.get(ident)==tag},50) for tag in ('ancestor','contemporary')},
        'recallByChannel@50':{channel:round(len(set(ids[:50])&positive&set(found))/len(positive),4) if positive else None
                             for channel,found in sorted(channels.items())}})
    return result


def rank_deltas(before,after):
    result=[]
    for ident in sorted(set(before)|set(after)):
        a,b=before.get(ident),after.get(ident)
        result.append({'paper':ident,'before':a,'after':b,'delta':a-b if a is not None and b is not None else None,
                       'status':'entered' if a is None and b is not None else 'left' if a is not None and b is None else 'missing' if a is None else 'ranked'})
    return result
