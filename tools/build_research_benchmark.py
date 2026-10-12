#!/usr/bin/env python3
"""Build 40 mixed-domain questions with explicit judgment provenance."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'local-web/pulse-backend'))
from pulse_core.metadata_utils import crossref_to_metadata
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_resolution import title_similarity
import urllib.parse

GENERAL=[
 ('attention','How do attention-based models represent long-range dependencies in sequences?','Attention Is All You Need','10.48550/arxiv.1706.03762'),
 ('language','How does bidirectional pretraining improve language representation for downstream tasks?','BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding','10.18653/v1/n19-1423'),
 ('embeddings','How can distributed word representations capture semantic relationships?','Efficient Estimation of Word Representations in Vector Space','10.48550/arxiv.1301.3781'),
 ('ensembles','How do randomized decision-tree ensembles improve classification?','Random Forests','10.1023/a:1010933404324'),
 ('classification','How do support-vector methods classify data with nonlinear decision boundaries?','Support-vector networks','10.1007/bf00994018'),
 ('uncertainty','How does Bayesian model averaging account for model uncertainty?','Bayesian model averaging: a tutorial','10.1214/ss/1009212519'),
 ('social-networks','How do weak social ties affect information flow between communities?','The Strength of Weak Ties','10.1086/225469'),
 ('network-topology','How can networks combine short path lengths with high local clustering?','Collective dynamics of small-world networks','10.1038/30918'),
 ('community-detection','How can communities be detected in complex networks?','Community structure in social and biological networks','10.1073/pnas.122653799'),
 ('information','How does information theory quantify communication and uncertainty?','A Mathematical Theory of Communication','10.1002/j.1538-7305.1948.tb01338.x'),
 ('sequence-models','How do hidden Markov models represent sequential observations?','A tutorial on hidden Markov models and selected applications in speech recognition','10.1109/5.18626'),
 ('discriminant-analysis','How can multiple measurements distinguish groups in classification?','The use of multiple measurements in taxonomic problems','10.1111/j.1469-1809.1936.tb02137.x'),
 ('causal-inference','How do propensity scores address confounding in observational comparisons?','The central role of the propensity score in observational studies for causal effects','10.1093/biomet/70.1.41'),
 ('multiple-testing','How can false discovery rate be controlled across multiple statistical tests?','Controlling the False Discovery Rate: A Practical and Powerful Approach to Multiple Testing','10.1111/j.2517-6161.1995.tb02031.x'),
 ('resampling','How does bootstrap resampling estimate statistical uncertainty?','Bootstrap Methods: Another Look at the Jackknife','10.1214/aos/1176344552'),
 ('evaluation','How should receiver operating characteristic curves be used to assess classifiers?','An introduction to ROC analysis','10.1016/j.patrec.2005.10.010'),
 ('deep-learning','How do multilayer neural models learn representations from data?','Deep learning','10.1038/nature14539'),
 ('optimization','How does adaptive moment estimation optimize stochastic objectives?','Adam: A Method for Stochastic Optimization','10.48550/arxiv.1412.6980'),
 ('network-science','Which structural properties explain the behavior of complex networks?','The Structure and Function of Complex Networks','10.1137/s003614450342480'),
 ('retrieval','How do term weighting and probabilistic retrieval models rank documents?','The Probabilistic Relevance Framework: BM25 and Beyond','10.1561/1500000019'),
]
SCIFACT_SHA='11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be'


def build(archive):
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=SCIFACT_SHA:raise ValueError('Official SciFact archive checksum changed')
    with tarfile.open(archive) as handle:
        corpus={str(row['doc_id']):row for row in map(json.loads,handle.extractfile('data/corpus.jsonl'))}
        claims=[json.loads(line) for line in handle.extractfile('data/claims_dev.jsonl')]
    cases=[];seen=set()
    clinical=re.compile(r'genom|anemi|thalass|cancer|rna|fibrosis|neuron|stem cell|renal|cardiac|diabet|cohort|mortality|blood|liver|kidney|tissue|hematopoietic|chromosom',re.I)
    for claim in sorted(claims,key=lambda row:int(row['id'])):
        ids=tuple(sorted(claim.get('evidence') or {}))
        if not ids or ids in seen or not clinical.search(claim['claim']):continue
        seen.add(ids)
        targets=[{'paper':{'benchmarkId':'scifact:'+ident,'title':corpus[ident]['title']},'grade':1,
            'judgmentSource':'SciFact human evidence annotations','reviewState':'human-annotated',
            'landmark':False,'landmarkReviewState':'unreviewed',
            'evidenceLabels':sorted({row['label'] for row in claim['evidence'][ident]})} for ident in ids]
        cases.append({'id':f'b{len(cases)+1:02d}','domain':'biomedical','group':'scifact:'+','.join(ids),
            'question':'Which research supports or challenges this dataset claim: '+claim['claim'],
            'sourceClaimId':claim['id'],'targets':targets,'seeds':[]})
        if len(cases)==20:break
    for index,(topic,question,title,doi) in enumerate(GENERAL):
        cases.append({'id':f'g{index+1:02d}','domain':'general research','group':topic,'question':question,'seeds':[],
            'targets':[{'paper':{'title':title,'doi':doi},'grade':2,'judgmentSource':'Assistant manual curation from the named paper and research question',
                'reviewState':'provisional','landmark':True,'landmarkReviewState':'provisional',
                'rationale':'Proposed foundational paper addressing the named method; expert review is required.'}]})
    # Explicitly proposed distractors are review tasks, never assumed negatives.
    for case in cases:
        distractor=cases[20]['targets'][0]['paper'] if case['domain']=='biomedical' else cases[0]['targets'][0]['paper']
        case['targets'].append({'paper':dict(distractor),'grade':0,'landmark':False,'reviewState':'provisional',
            'judgmentSource':'Assistant proposed cross-domain distractor','rationale':'Review whether this paper answers this particular question.'})
    for index,case in enumerate(cases):
        # Entire topics/evidence groups stay in one split; no paraphrase leakage.
        case['split']='test' if index%5==4 else 'validation' if index%5==3 else 'train'
    return {'formatVersion':1,'name':'Pulse mixed research benchmark','cases':cases,
        'provenance':{'biomedical':'https://github.com/allenai/scifact','archiveSha256':SCIFACT_SHA,
            'claimsLicense':'CC BY 4.0','abstractsLicense':'ODC-By 1.0','sourceArchive':'https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz',
            'general':'Assistant-curated question/paper pairs; provisional until reviewed',
            'selection':'First 20 distinct annotated SciFact evidence groups in clinical/genetic topics, ordered by claim id; 20 declared general-method questions',
            'negativeJudgments':'Proposed distractors require review; unjudged retrieved papers are never silently labelled irrelevant',
            'landmarks':'Provisional general-method anchors; clinical landmark labels require review'}}


def verify_general(doc):
    diagnostics=[]
    for case in doc['cases']:
        if case['domain']!='general research':continue
        paper=case['targets'][0]['paper'];doi=paper['doi']
        try:
            if doi.startswith('10.48550/'):
                data=fetch_json('https://api.datacite.org/dois/'+urllib.parse.quote(doi,safe=''))['data']['attributes']
                actual={'title':data['titles'][0]['title'],'doi':doi,'year':str(data.get('publicationYear') or '')}
            else:actual=crossref_to_metadata(fetch_json('https://api.crossref.org/works/'+urllib.parse.quote(doi,safe=''))['message'])
            if max(title_similarity(paper['title'],actual.get('title')),title_similarity(paper['title'],actual.get('primaryTitle'))) <.85:raise ValueError('Title disagreement')
            for field in ('title','authors','year','journal','doi'): 
                if actual.get(field):paper[field]=actual[field]
            paper['registryVerified']=True
        except Exception:diagnostics.append({'case':case['id'],'issue':'Registry identity not verified during collection'})
    doc['registryDiagnostics']=diagnostics


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path)
    parser.add_argument('--verify-registry',action='store_true')
    parser.add_argument('--output',type=Path,default=ROOT/'local-web/pulse-frontend/data/research-benchmark.json')
    args=parser.parse_args();doc=build(args.archive)
    if args.verify_registry:verify_general(doc)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    print('Built',len(doc['cases']),'questions; human evidence and provisional judgments are separately identified.')
