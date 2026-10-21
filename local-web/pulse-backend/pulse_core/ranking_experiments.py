"""Conservative, opt-in ranking policies. No model downloads at search time."""
import hashlib
import json
import math
from pathlib import Path
import re

MODEL_ID='ncbi/MedCPT-Cross-Encoder'
_verified={}


def structural_policy(options,seeds,structures):
    if options.get('adaptiveStructure') is not True:
        return {'mode':'fixed','weight':max(0,min(.3,float(options.get('citationStructureWeight',.06)))),
            'backwardWeight':max(0,min(.1,float(options.get('backwardCitationWeight',.03)))),'topicGate':False}
    intent=options.get('structuralIntent','auto')
    question=str(options.get('researchQuestion') or '').strip()
    if intent not in ('auto','bibliography','focused'):intent='auto'
    selected=intent if intent!='auto' else 'focused' if question or options.get('queryKeywords') or options.get('queryTags') else 'bibliography'
    coverage=sum(bool(p.get('referenceIds')) for p in seeds)/len(seeds) if seeds else 0
    observed=sum(float(p.get('strength') or 0)>0 for p in structures)/max(1,len(structures))
    # Better indexed coverage supports a stronger, still bounded prior.
    confidence=math.sqrt(coverage)*(.5+.5*math.sqrt(observed))
    weight=(.035 if selected=='focused' else .10)*confidence
    return {'mode':'adaptive-experimental','intent':selected,'weight':round(weight,6),
        'backwardWeight':round((.015 if selected=='focused' else .03)*confidence,6),
        'seedReferenceCoverage':round(coverage,4),'observedCandidateShare':round(observed,4),'topicGate':True}


def biomedical_confidence(paper):
    topic=paper.get('primaryTopic') or {}
    if not isinstance(topic,dict):return 0
    domain=topic.get('domain') or {}
    if not isinstance(domain,dict):return 0
    # OpenAlex domains 1 (Life Sciences) and 4 (Health Sciences).
    if str(domain.get('id') or '').rsplit('/',1)[-1] not in ('1','4'):return 0
    try:score=float(topic.get('score') or 0)
    except (ValueError,TypeError):return 0
    return score if math.isfinite(score) and 0<=score<=1 else 0


def route_indices(seeds,queries,records):
    # A domain label alone is insufficient for multidisciplinary questions.
    query=' '.join(str(q) for q in queries).casefold()
    biomedical_query=bool(re.search(r'\b(?:patients?|disease|clinical|therapy|treatment|cancer|tumou?r|diabetes|protein|gene|genomic|cell|cells|immune|infection|bacteria|bacterial|virus|neuron|drug|cohort|biomedical|medical|mortality)\b',query))
    if not biomedical_query or not seeds or not all(biomedical_confidence(p)>=.8 for p in seeds):return []
    return [i for i,p in enumerate(records) if biomedical_confidence(p)>=.8]


def optional_model(settings):
    value=str(settings.get('searchBiomedicalModelPath') or '').strip()
    if not value:return None
    root=Path(value).expanduser()
    try:
        files=[root/name for name in ('manifest.json','model.onnx','tokenizer.json')]
        if not 0<files[0].stat().st_size<65536 or not 0<files[2].stat().st_size<32*1024*1024:return None
        fingerprint=tuple((str(p.resolve()),p.stat().st_size,p.stat().st_mtime_ns) for p in files)
        if fingerprint in _verified:return root
        manifest=json.loads(files[0].read_text())
        if manifest.get('model')!=MODEL_ID or manifest.get('format') not in ('pulse-medcpt-onnx-v1','pulse-medcpt-onnx-int8-v1'):return None
        hashes=manifest.get('sha256') or {}
        if set(hashes)!= {'model.onnx','tokenizer.json'}:return None
        if not 0<files[1].stat().st_size<512*1024*1024:return None
        for name,expected in hashes.items():
            digest=hashlib.sha256()
            with (root/name).open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
            if digest.hexdigest()!=expected:return None
        _verified.clear();_verified[fingerprint]=True
        return root
    except (OSError,ValueError,TypeError):return None


def routed_scores(settings,queries,records,seeds,cancel_event=None):
    from pulse_core.discovery_crossencoder import crossencoder_scores,_find_search_runtime
    baseline,notice=crossencoder_scores(settings,queries,records,cancel_event)
    if settings.get('searchBiomedicalRouter') is not True:return baseline,notice
    if baseline is None:return baseline,notice+' Biomedical routing needs the default offline runtime.'
    indices=route_indices(seeds,queries,records)[:24]
    if not indices:return baseline,notice+' Biomedical routing skipped: mixed or uncertain topic evidence.'
    model=optional_model(settings)
    executable,_=_find_search_runtime(settings)
    if model is None or not executable or executable.name not in ('pulse-reranker','pulse-reranker.exe'):
        return baseline,notice+' Optional biomedical model unavailable; MiniLM retained.'
    options=dict(settings,searchRerankerPython=str(executable),searchRerankerModel=str(model))
    options['_runtimeOverride']=(executable,model)
    options['_rankTimeBudget']=6
    scores,detail=crossencoder_scores(options,queries,[records[i] for i in indices],cancel_event)
    if scores is None:return baseline,notice+' Biomedical scoring unavailable; MiniLM retained.'
    # Scores from two differently trained models are not interchangeable. A
    # small blend bounds the effect of an incorrect route or score calibration.
    result=list(baseline)
    for i,score in zip(indices,scores):result[i]=.75*baseline[i]+.25*score
    return result,f'Experimental biomedical blend used for {len(indices)} papers; MiniLM retained for all candidates.'


def status(settings):
    model=optional_model(settings)
    return {'adaptiveStructure':settings.get('searchAdaptiveStructure') is True,
        'structuralIntent':settings.get('searchStructuralIntent','auto'),
        'biomedicalRouter':settings.get('searchBiomedicalRouter') is True,
        'biomedicalModelPath':str(settings.get('searchBiomedicalModelPath') or ''),
        'biomedicalModelAvailable':model is not None,'experimental':True}
