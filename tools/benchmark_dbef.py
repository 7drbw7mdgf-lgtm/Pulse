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
sys.path.insert(0,str(ROOT/'tools'))
from dbef_metrics import metrics,rank_deltas
from pulse_core.external_apis import fetch_json
from pulse_core.metadata_resolution import title_similarity
from pulse_core.metadata_utils import openalex_to_metadata,crossref_to_metadata
from pulse_core.doi_utils import normalize_doi
from pulse_core.dbef_content import SeedPaper,CandidatePaper,score_and_rank_candidates,saturate_score
from pulse_core.dbef_discovery import recent_velocity,work_id
from pulse_core.pipeline_ranking import merge_and_rank_pipeline_candidates
from pulse_source_health import cooldowns


def key(paper):
    ident=work_id(str(paper.get('openAlexId') or paper.get('openalexId') or paper.get('openalex') or '').upper())
    return str(paper.get('benchmarkId') or normalize_doi(paper.get('doi')) or ident or paper.get('title')).lower()


def reference_fallback(corpus,issues,seed_ids=()):
    """Benchmark-only batched DOI/ID fallback, with seed reference metadata."""
    groups={'doi':{},'openalex_id':{}};resolved={}
    for ident,paper in corpus.items():
        if paper.get('referenceIds'):continue
        oa=work_id(paper.get('openAlexId') or paper.get('openalexId') or paper.get('openalex'))
        value=oa or normalize_doi(paper.get('doi')).lower()
        if value:groups['openalex_id' if oa else 'doi'].setdefault(value,[]).append(ident)
    for field,entries in groups.items():
        values=sorted(entries)
        for start in range(0,len(values),100):
            try:
                query=urllib.parse.urlencode({'filter':field+':'+'|'.join(values[start:start+100]),'per-page':100})
                works=fetch_json('https://api.openalex.org/works?'+query).get('results') or []
                for work in works:
                    value=work_id(work.get('id')) if field=='openalex_id' else normalize_doi(work.get('doi')).lower()
                    for ident in entries.get(value,[]):
                        paper=corpus[ident];metadata=openalex_to_metadata(work)
                        # Keep the frozen pool identity, not an upstream alias.
                        for name,value in metadata.items():
                            if value and not paper.get(name):paper[name]=value
                        paper['abstract']=abstract_features(paper.get('abstract'))
                        paper['referenceIds']=[work_id(ref) for ref in work.get('referenced_works') or [] if work_id(ref)]
                        paper['referenceCount']=work.get('referenced_works_count') if work.get('referenced_works_count') is not None else len(paper['referenceIds'])
                        paper['referenceDataSource']='OpenAlex fallback';paper['citationCountsByYear']=work.get('counts_by_year') or []
            except Exception:issues.append('OpenAlex reference fallback unavailable for a '+field+' batch')
    priority=list(dict.fromkeys(ref for ident in seed_ids for ref in corpus.get(ident,{}).get('referenceIds') or []))
    ids=list(dict.fromkeys(priority+[ref for paper in corpus.values() for ref in paper.get('referenceIds') or [] if work_id(ref)]))[:1200]
    aliases={}
    for start in range(0,len(ids),100):
        group=[ident for ident in ids[start:start+100] if work_id(ident)]
        if not group:continue
        try:
            rows=fetch_json('https://api.openalex.org/works?'+urllib.parse.urlencode({'filter':'openalex_id:'+'|'.join(group),'per-page':100})).get('results') or []
            for work in rows:
                ident=work_id(work.get('id'));canonical=normalize_doi(work.get('doi')).lower() or ident
                aliases[ident]=canonical;resolved[canonical]={'title':work.get('title') or '', 'count':work.get('cited_by_count')}
        except Exception:issues.append('OpenAlex reference metadata unavailable for a batch')
    for paper in corpus.values():paper['referenceIds']=list(dict.fromkeys(aliases.get(ref,ref) for ref in paper.get('referenceIds') or []))
    return resolved


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
    references.update(reference_fallback(corpus,issues,[case['seed'].lower() for case in cases]))
    return {'formatVersion':1,'scope':definitions['scope'],'labelProvenance':definitions['labelProvenance'],'cases':cases,'corpus':list(corpus.values()),'references':references,
        'provenance':{'provider':'Crossref and DataCite public metadata; OpenAlex rate-limited','knownPaperCount':sum(doi.lower() in corpus for doi in definitions['papers']),'curatedKnownPapers':len(definitions['papers']),
          'collectionSeconds':round(time.monotonic()-started,3),'issues':issues,'sourceCooldowns':cooldowns(),'positiveInjection':True,'retrievalRecallMeasured':False,'neuralModels':False,'abstractRepresentation':'Unordered unigram features; raw abstract narrative omitted','corpusSizeAssumption':10000000,
          'unassessedReferencePapers':sum(not p.get('referenceIds') and not p.get('referenceCount') for p in corpus.values()),
          'referenceFallback':'OpenAlex DOI/openalex_id batches of at most 100; unknown reference identifiers remain explicit.',
          'limitations':'Some abstracts and bibliographies remain unavailable. Missing annual citation data is neutral; no candidate-specific fallbacks are used by the live app.'}}


def measure(ranked,relevant,landmarks,nonrelevant=(),tags=None):
    grades={ident.lower():2 if ident.lower() in {v.lower() for v in landmarks} else 1 for ident in relevant}
    grades.update({ident.lower():0 for ident in nonrelevant})
    channels={name:set() for name in ('citationGraph','citationCoCitation','dbef')}
    for paper in ranked:
        for evidence in paper.get('retrievalEvidence') or []:
            channel=evidence.get('channel') or 'unknown'
            if channel.startswith('citations:'):
                channels['citationGraph'].add(key(paper));channel='citationGraph:'+channel.rsplit(':',1)[-1]
            elif channel.startswith('concepts:'):channel='concepts'
            elif channel.startswith('dbef'):channel='dbef'
            channels.setdefault(channel,set()).add(key(paper))
    return metrics([key(paper) for paper in ranked],grades,[value.lower() for value in landmarks],tags,channels)


def baseline_module(name):
    import importlib.util
    path=ROOT/'benchmarks/baseline'/name
    spec=importlib.util.spec_from_file_location('pulse_before_'+path.stem,path)
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    return module


def _evaluate(document):
    legacy=baseline_module('dbef_content.py');legacy_rank=baseline_module('pipeline_ranking.py').merge_and_rank_pipeline_candidates
    corpus={key(p):p for p in document['corpus']};rows=[]
    references=document.get('references') or {};counts={ident:entry['count'] for ident,entry in references.items() if isinstance(entry.get('count'),int)}
    texts={ident:(entry.get('title') or '','') for ident,entry in references.items()}
    for case in document['cases']:
        seed=corpus.get(case['seed'].lower())
        if not seed:raise ValueError('Missing benchmark seed: '+case['seed'])
        papers=[copy.deepcopy(corpus[ident]) for ident in case['candidateIds'] if ident in corpus]
        tags={ident:tag for ident,tag in (case.get('tags') or {}).items()}
        for ident in case['relevant']:
            a,b=str(corpus.get(ident,{}).get('year') or '')[:4],str(seed.get('year') or '')[:4]
            if ident not in tags and a.isdigit() and b.isdigit():tags[ident]='ancestor' if int(a)<int(b) else 'contemporary'
        for paper in papers:paper.update(copy.deepcopy((case.get('candidateEvidence') or {}).get(key(paper),{})))
        options={'researchQuestion':case['question'],'limit':2000,'diversify':True,
                 'impute_missing_graph':document.get('impute_missing_graph','median'),'graph_imputation_shrink':document.get('graph_imputation_shrink',.5)}
        comparisons={};network_counts={};scale=None
        for phase in ('before','after'):
            comparisons[phase]={}
            for enabled in (False,True):
                pool=copy.deepcopy(papers)
                for paper in pool:
                    if 'retrievalEvidence' in paper:
                        evidence=[ev for ev in paper['retrievalEvidence'] if not str(ev.get('channel') or '').startswith('dbef')]
                        if evidence:paper['retrievalEvidence']=evidence
                        else:paper.pop('retrievalEvidence')
                if enabled:
                    engine=legacy if phase=='before' else sys.modules[score_and_rank_candidates.__module__]
                    candidates=[engine.CandidatePaper(key(p),p.get('title') or '',p.get('abstract') or '',p.get('referenceIds') or [],
                        recent_velocity({'publication_year':p.get('year'),'counts_by_year':p.get('citationCountsByYear')}),p.get('referenceCount')) for p in pool]
                    seed_record=engine.SeedPaper(key(seed),seed.get('title') or '',seed.get('abstract') or '',seed.get('referenceIds') or [])
                    if phase=='after':seed_record.reference_count=seed.get('referenceCount')
                    unknown=statistics.median([counts[ref] for ref in seed.get('referenceIds') or [] if ref in counts]) if any(ref in counts for ref in seed.get('referenceIds') or []) else 1
                    found,diag=engine.score_and_rank_candidates(candidates,[seed_record],counts,texts,
                        n_corpus=10000000,unknown_count=unknown,top_k=max(1,len(pool)),stage1_k=max(1000,len(pool)),
                        **({'stable_seed_calibration':True} if phase=='after' else {}))
                    by_id={row.paper.paper_id:(index,row) for index,row in enumerate(found,1)}
                    if phase=='before':
                        # Frozen legacy scaling is used only for the before table.
                        baseline_peak=max((row.score for row in found),default=0) or 1
                    else:
                        scale=diag['scale'];network_counts={status:len(ids) for status,ids in diag['network_status_ids'].items()}
                    for paper in pool:
                        entry=by_id.get(key(paper))
                        if entry:
                            index,row=entry
                            normalized=row.score/baseline_peak if phase=='before' else saturate_score(row.score,scale)
                            data={'score':row.score,'normalizedScore':normalized}
                            from pulse_core.ranking_evidence import reference_coverage
                            data.update(sharedReferenceIds=row.shared_refs,contentFactor=row.content_factor,velocityFactor=row.velocity_factor,
                                candidateReferenceCoverage=reference_coverage(len(row.paper.references),row.paper.reference_count),
                                seedReferenceCoverage=reference_coverage(len(seed_record.references),seed.get('referenceCount')),
                                referenceMetadataCoverage=sum(.5*bool((texts.get(ref) or ('',''))[0])+.5*(ref in counts) for ref in row.shared_refs)/len(row.shared_refs))
                            paper.update(dbef=data,networkSimilarity=normalized,networkStatus='assessed_overlap',
                                retrievalEvidence=[*(paper.get('retrievalEvidence') or []),{'channel':'dbef','provider':'Frozen reference graph','rank':index,'subType':'Bibliographic coupling'}])
                        elif phase=='after':
                            zero=key(paper) in diag['network_status_ids']['assessed_zero']
                            paper.update(networkStatus='assessed_zero' if zero else 'unassessed',networkSimilarity=0. if zero else None)
                ranker=legacy_rank if phase=='before' else merge_and_rank_pipeline_candidates
                branches={}
                for paper in pool:
                    for branch in paper.get('retrievalBranches') or ['controlledPool']:
                        if branch=='citationNetwork' and not enabled:branch='controlledPool'
                        branches.setdefault(branch,[]).append(paper)
                ranked=ranker(branches,[seed],dict(options))
                comparisons[phase]['on' if enabled else 'off']={**measure(ranked,case['relevant'],case['landmarks'],case.get('nonrelevant') or [],tags),
                    'dbefScoredCandidates':sum(bool(p.get('dbef')) for p in pool)}
        rows.append({'name':case['name'],'candidateCount':len(papers),'collectionSeconds':case.get('collectionSeconds'),
            'missingMetadata':[doi.lower() for doi in case['relevant'] if doi.lower() not in corpus],
            'networkStatusCounts':network_counts,'dbefScale':scale,'tags':tags,**comparisons,**comparisons['after'],
            'rankDeltas':{'dbefOffToOn':rank_deltas(comparisons['after']['off']['ranks'],comparisons['after']['on']['ranks']),
                          'beforeToAfter':rank_deltas(comparisons['before']['on']['ranks'],comparisons['after']['on']['ranks'])}})
    names=['nDCG@10','nDCG@20','condensedNDCG@10','condensedNDCG@20','bpref','KnownRelevantRecall@20','KnownRelevantRecall@50','LandmarkRecall@50','KnownRelevantHits@20','LandmarkHits@50']
    def average(phase,mode,name):
        values=[row[phase][mode][name] for row in rows if row[phase][mode][name] is not None]
        return round(statistics.mean(values),4) if values else None
    summaries={phase:{mode:{name:average(phase,mode,name) for name in names} for mode in ('off','on')} for phase in ('before','after')}
    for phase in ('before','after'):
        for mode in ('off','on'):
            for field in ('recallByTag@50','recallByChannel@50'):
                keys=sorted({key for row in rows for key in row[phase][mode][field]})
                summaries[phase][mode][field]={key:round(statistics.mean(values),4) if (values:=[row[phase][mode][field].get(key) for row in rows if row[phase][mode][field].get(key) is not None]) else None for key in keys}
    return {'formatVersion':2,'cases':rows,'summary':summaries['after'],'beforeSummary':summaries['before'],
        'provenance':document.get('provenance'),'baseline':json.loads((ROOT/'benchmarks/baseline/provenance.json').read_text()),
        'note':'Incomplete judgments on fixed pools. Conventional nDCG treats unjudged gains as zero; condensed nDCG drops unjudged documents. bpref is null without judged negatives. Recall is known-paper coverage, not exhaustive relevance. Retrieval-channel coverage uses the global top 50. These 3 + 5 cases cannot establish statistical significance. No gold labels determine scores. Neural reranking is disabled; no live latency claim.',
        'deterministic':True}


def evaluate(document):
    import datetime
    from unittest.mock import patch
    actual_date=datetime.date
    frozen=actual_date.fromisoformat(document.get('asOfDate','2026-10-12'))
    class FrozenDate(actual_date):
        @classmethod
        def today(cls):return frozen
    with patch.object(datetime,'date',FrozenDate):return _evaluate(document)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--collect',action='store_true');parser.add_argument('--enrich',action='store_true');parser.add_argument('--impute-missing-graph',choices=['median','renormalize','zero']);parser.add_argument('--provider',choices=['auto','crossref'],default='auto');parser.add_argument('--dataset',type=Path,default=ROOT/'benchmarks/dbef-frozen-pool.json');parser.add_argument('--output',type=Path,default=ROOT/'benchmarks/dbef-ablation-report.json')
    args=parser.parse_args()
    if args.collect:
        definitions=json.loads((ROOT/'benchmarks/dbef-known-papers.json').read_text());doc=collect_crossref(definitions,time.monotonic()) if args.provider=='crossref' else collect(definitions);args.dataset.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    else:doc=json.loads(args.dataset.read_text())
    if args.enrich:
        corpus={key(p):p for p in doc['corpus']};issues=[];doc['references'].update(reference_fallback(corpus,issues,[case['seed'].lower() for case in doc['cases']]))
        doc['provenance']['referenceFallbackIssues']=sorted(set(issues));args.dataset.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    if args.impute_missing_graph:doc['impute_missing_graph']=args.impute_missing_graph
    report=evaluate(doc);report['datasetSha256']=hashlib.sha256(args.dataset.read_bytes()).hexdigest();args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report['summary'],indent=2))
