#!/usr/bin/env python3
"""Freeze public metadata, then compare DBEF on/off on identical ranking pools."""
import argparse
import copy
import hashlib
import json
import math
import re
import statistics
import sys
import time
import urllib.parse
from pathlib import Path
def abstract_features(text):
    # Preserve unigram frequencies for this lexical/TF-IDF ablation without
    # redistributing publishers' abstract narratives.
    return ' '.join(sorted(re.findall(r'[\w]+(?:[-/][\w]+)*',str(text or '').casefold())))

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'local-web/pulse-backend'))
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_resolution import title_similarity
from pulse_core.metadata_utils import openalex_to_metadata,crossref_to_metadata
from pulse_core.doi_utils import normalize_doi
from pulse_core.dbef_content import SeedPaper,CandidatePaper,score_and_rank_candidates
from pulse_core.dbef_discovery import recent_velocity,work_id
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_source_health import cooldowns


def key(paper):return str(paper.get('benchmarkId') or paper.get('doi') or paper.get('openalexId') or paper.get('title')).lower()


def collect(definitions):
    started=time.monotonic();corpus={};issues=[]
    dois=list(definitions['papers'])
    url='https://api.openalex.org/works?'+urllib.parse.urlencode({'filter':'doi:'+'|'.join(dois),'per-page':100})
    try:data=fetch_json(url)
    except Exception:
        return collect_crossref(definitions,started)
    def add(work,benchmark_id=None):
        paper=openalex_to_metadata(work)
        paper['abstract']=abstract_features(paper.get('abstract'))
        paper.update(benchmarkId=(benchmark_id or paper.get('doi') or work_id(work.get('id'))).lower(),
          referenceIds=[work_id(ref) for ref in work.get('referenced_works') or []],
          citationCountsByYear=work.get('counts_by_year') or [])
        corpus[key(paper)]=paper
        return paper
    for work in data.get('results') or []:
        wanted=next((doi for doi in dois if str(work.get('doi') or '').lower().endswith(doi.lower())),None)
        if wanted:add(work,wanted)
    for doi,title in definitions['papers'].items():
        if doi.lower() in corpus:continue
        try:
            rows=fetch_json('https://api.openalex.org/works?'+urllib.parse.urlencode({'search':title,'per-page':5})).get('results') or []
            matches=[row for row in rows if title_similarity(title,row.get('title'))>=.95]
            if len(matches)==1:add(matches[0],doi)
            else:issues.append('Missing or ambiguous known paper: '+doi)
        except Exception as error:issues.append('Known-paper lookup unavailable: '+doi)
    cases=[]
    for case in definitions['cases']:
        beginning=time.monotonic();ids=[]
        try:
            rows=fetch_json('https://api.openalex.org/works?'+urllib.parse.urlencode({'search':case['question'],'per-page':100})).get('results') or []
            for work in rows:
                ident=next((key(p) for p in corpus.values() if p.get('openalexId')==work_id(work.get('id'))),None)
                paper=corpus[ident] if ident else add(work)
                ids.append(key(paper))
        except Exception as error:issues.append('Candidate collection unavailable: '+case['name'])
        # Curated positives are deliberately included to isolate ranking.
        # This pool therefore cannot measure live retrieval recall.
        ids=list(dict.fromkeys(ids+[doi.lower() for doi in definitions['papers'] if doi.lower() in corpus]))
        ids=[ident for ident in ids if ident!=case['seed'].lower()]
        cases.append({**case,'candidateIds':ids,'collectionSeconds':round(time.monotonic()-beginning,3)})
    reference_ids=list(dict.fromkeys(ref for case in cases for ref in corpus.get(case['seed'].lower(),{}).get('referenceIds') or []))[:400]
    references={}
    for offset in range(0,len(reference_ids),100):
        try:
            rows=fetch_json('https://api.openalex.org/works?'+urllib.parse.urlencode({'filter':'openalex_id:'+'|'.join(reference_ids[offset:offset+100]),'per-page':100})).get('results') or []
            for row in rows:references[work_id(row.get('id'))]={'title':row.get('title') or '', 'count':row.get('cited_by_count')}
        except Exception:issues.append('Some reference metadata unavailable')
    return {'formatVersion':1,'scope':definitions['scope'],'labelProvenance':definitions['labelProvenance'],'cases':cases,'corpus':list(corpus.values()),'references':references,
        'provenance':{'provider':'OpenAlex public metadata','knownPaperCount':sum(doi.lower() in corpus for doi in dois),'curatedKnownPapers':len(dois),
          'collectionSeconds':round(time.monotonic()-started,3),'issues':issues,'sourceCooldowns':cooldowns(),'positiveInjection':True,'retrievalRecallMeasured':False,'neuralModels':False,'abstractRepresentation':'Unordered unigram features; raw abstract narrative omitted','corpusSizeAssumption':10000000}}


def collect_crossref(definitions,started):
    """Keep the benchmark usable while another public index is rate-limited."""
    corpus={};issues=[];references={}
    def add(item,benchmark_id=None):
        paper=crossref_to_metadata(item)
        doi=normalize_doi(paper.get('doi')).lower()
        if not paper.get('title') or not doi:return None
        refs=[]
        for reference in item.get('reference') or []:
            ident=normalize_doi(reference.get('DOI')).lower()
            if not ident:continue
            refs.append(ident);references.setdefault(ident,{'title':reference.get('article-title') or '', 'count':None})
        paper['abstract']=abstract_features(paper.get('abstract'))
        paper.update(benchmarkId=(benchmark_id or doi).lower(),referenceIds=refs,referenceCount=item.get('reference-count') or len(item.get('reference') or []),citationCountsByYear=[])
        corpus[key(paper)]=paper
        return paper
    for doi,title in definitions['papers'].items():
        try:
            if doi.lower().startswith('10.48550/'):
                attributes=fetch_json('https://api.datacite.org/dois/'+urllib.parse.quote(doi,safe=''))['data']['attributes']
                paper={'benchmarkId':doi.lower(),'doi':doi,'title':attributes['titles'][0]['title'],
                    'authors':[creator.get('name') or ' '.join(filter(None,[creator.get('givenName'),creator.get('familyName')])) for creator in attributes.get('creators') or []],
                    'year':str(attributes.get('publicationYear') or ''),'abstract':' '.join(description.get('description') or '' for description in attributes.get('descriptions') or [] if description.get('descriptionType')=='Abstract'),
                    'metadataSource':'DataCite','referenceIds':[],'citationCountsByYear':[]}
                if title_similarity(title,paper['title'])<.95:raise ValueError('Title mismatch')
                paper['abstract']=abstract_features(paper.get('abstract'))
                corpus[key(paper)]=paper
            else:
                item=fetch_json('https://api.crossref.org/works/'+urllib.parse.quote(doi,safe='')).get('message') or {}
                if max(title_similarity(title,crossref_to_metadata(item).get('title')),title_similarity(title,crossref_to_metadata(item).get('primaryTitle')))<.85:raise ValueError('Title mismatch')
                add(item,doi)
        except Exception:issues.append('Missing or unavailable known paper: '+doi)
    cases=[]
    for case in definitions['cases']:
        beginning=time.monotonic();ids=[]
        try:
            items=fetch_json('https://api.crossref.org/works?'+urllib.parse.urlencode({'query.bibliographic':case['question'],'rows':100})).get('message',{}).get('items') or []
            for item in items:
                paper=add(item)
                if paper:ids.append(key(paper))
        except Exception:issues.append('Candidate collection unavailable: '+case['name'])
        ids=list(dict.fromkeys(ids+[doi.lower() for doi in definitions['papers'] if doi.lower() in corpus]))
        cases.append({**case,'candidateIds':[ident for ident in ids if ident!=case['seed'].lower()],'collectionSeconds':round(time.monotonic()-beginning,3)})
    for paper in corpus.values():
        if key(paper) in references:references[key(paper)]['count']=paper.get('citationCount')
    return {'formatVersion':1,'scope':definitions['scope'],'labelProvenance':definitions['labelProvenance'],'cases':cases,'corpus':list(corpus.values()),'references':references,
        'provenance':{'provider':'Crossref and DataCite public metadata; OpenAlex rate-limited','knownPaperCount':sum(doi.lower() in corpus for doi in definitions['papers']),'curatedKnownPapers':len(definitions['papers']),
          'collectionSeconds':round(time.monotonic()-started,3),'issues':issues,'sourceCooldowns':cooldowns(),'positiveInjection':True,'retrievalRecallMeasured':False,'neuralModels':False,'abstractRepresentation':'Unordered unigram features; raw abstract narrative omitted','corpusSizeAssumption':10000000,
          'limitations':'Many abstracts and reference DOIs are missing; annual citation velocity is neutral. Only supplied bibliography DOIs form shared-reference evidence.'}}


def measure(ranked,relevant,landmarks):
    ids=list(dict.fromkeys(key(paper) for paper in ranked));relevant=set(doi.lower() for doi in relevant);landmarks=set(doi.lower() for doi in landmarks)
    grades={ident:2 if ident in landmarks else 1 for ident in relevant}
    def dcg(values):return sum((2**grade-1)/math.log2(index+2) for index,grade in enumerate(values))
    ideal=dcg(sorted(grades.values(),reverse=True)[:10])
    return {'nDCG@10':round(dcg([grades.get(ident,0) for ident in ids[:10]])/ideal,4) if ideal else 0,
      'KnownRelevantRecall@50':round(len(set(ids[:50])&relevant)/len(relevant),4) if relevant else 0,
      'KnownRelevantHits@20':len(set(ids[:20])&relevant),'LandmarkHits@50':len(set(ids[:50])&landmarks),
      'missedLandmarks':sorted(landmarks-set(ids[:50])),'missedKnownPapers':sorted(relevant-set(ids[:50])),
      'ranks':{ident:ids.index(ident)+1 if ident in ids else None for ident in sorted(relevant)},'top20':ids[:20]}


def evaluate(document):
    corpus={key(p):p for p in document['corpus']};rows=[]
    references=document.get('references') or {};counts={ident:entry['count'] for ident,entry in references.items() if isinstance(entry.get('count'),int)}
    texts={ident:(entry.get('title') or '','') for ident,entry in references.items()}
    for case in document['cases']:
        seed=corpus.get(case['seed'].lower())
        if not seed:raise ValueError('Missing benchmark seed: '+case['seed'])
        papers=[copy.deepcopy(corpus[ident]) for ident in case['candidateIds'] if ident in corpus]
        options={'researchQuestion':case['question'],'limit':500,'diversify':True}
        comparison={}
        # Alternate order across cases; both conditions use the same frozen pool.
        for enabled in ([False,True] if len(rows)%2==0 else [True,False]):
            started=time.monotonic();pool=copy.deepcopy(papers)
            if enabled:
                candidates=[CandidatePaper(key(p),p.get('title') or '',p.get('abstract') or '',p.get('referenceIds') or [],
                    recent_velocity({'publication_year':p.get('year'),'counts_by_year':p.get('citationCountsByYear')}),p.get('referenceCount')) for p in pool]
                dbef,_=score_and_rank_candidates(candidates,[SeedPaper(key(seed),seed.get('title') or '',seed.get('abstract') or '',seed.get('referenceIds') or [])],counts,texts,
                    n_corpus=10000000,unknown_count=statistics.median([counts[ref] for ref in seed.get('referenceIds') or [] if ref in counts]) if any(ref in counts for ref in seed.get('referenceIds') or []) else 1,top_k=len(pool),stage1_k=max(1000,len(pool)))
                maximum=max((row.score for row in dbef),default=0) or 1
                by_id={row.paper.paper_id:row for row in dbef}
                for paper in pool:
                    scored=by_id.get(key(paper))
                    if scored:paper.update(dbef={'score':scored.score,'normalizedScore':scored.score/maximum},networkSimilarity=scored.score/maximum,
                        retrievalEvidence=[{'channel':'dbef','provider':'Frozen reference graph','rank':dbef.index(scored)+1}])
            ranked=merge_and_rank_pipeline_candidates({'controlledPool':pool},[seed],dict(options))
            comparison['on' if enabled else 'off']={**measure(ranked,case['relevant'],case['landmarks']),
                'rankingSeconds':round(time.monotonic()-started,4),'dbefScoredCandidates':sum(bool(p.get('dbef')) for p in pool)}
        rows.append({'name':case['name'],'candidateCount':len(papers),'collectionSeconds':case.get('collectionSeconds'),'missingMetadata':[doi.lower() for doi in case['relevant'] if doi.lower() not in corpus],**comparison})
    metrics=['nDCG@10','KnownRelevantRecall@50','KnownRelevantHits@20','LandmarkHits@50','rankingSeconds']
    return {'cases':rows,'summary':{mode:{metric:round(statistics.mean(row[mode][metric] for row in rows),4) for metric in metrics} for mode in ['off','on']},
      'provenance':document.get('provenance'),'note':'Controlled, incomplete manual judgments on frozen public metadata; curated positives are included. Unknown papers are not labelled irrelevant. No live retrieval-recall or full-search latency claim; collection and ranking time are separate. Neural reranking is disabled to isolate DBEF.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--collect',action='store_true');parser.add_argument('--provider',choices=['auto','crossref'],default='auto');parser.add_argument('--dataset',type=Path,default=ROOT/'benchmarks/dbef-frozen-pool.json');parser.add_argument('--output',type=Path,default=ROOT/'benchmarks/dbef-ablation-report.json')
    args=parser.parse_args()
    if args.collect:
        definitions=json.loads((ROOT/'benchmarks/dbef-known-papers.json').read_text());doc=collect_crossref(definitions,time.monotonic()) if args.provider=='crossref' else collect(definitions);args.dataset.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    else:doc=json.loads(args.dataset.read_text())
    report=evaluate(doc);report['datasetSha256']=hashlib.sha256(args.dataset.read_bytes()).hexdigest();args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report['summary'],indent=2))
