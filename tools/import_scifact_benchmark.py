#!/usr/bin/env python3
"""Create a reproducible real-paper retrieval benchmark from official SciFact."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tarfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local-web/pulse-backend'))
from pulse_core.pipeline_ranking import bm25_scores

SOURCE = 'https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz'
SHA256 = '11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be'


def build(archive, maximum=30, candidate_count=300):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise ValueError('The official dataset changed; inspect and update its provenance before importing.')
    with tarfile.open(archive) as handle:
        raw_corpus = [json.loads(line) for line in handle.extractfile('data/corpus.jsonl')]
        claims = [json.loads(line) for line in handle.extractfile('data/claims_dev.jsonl')]
    corpus = [{'benchmarkId': str(p['doc_id']), 'title': p['title'], 'abstract': ' '.join(p['abstract']),
               'source': 'SciFact / Semantic Scholar', 'sourceIdentifiers': {'SciFact': str(p['doc_id'])}} for p in raw_corpus]
    selected, cases = set(), []
    # Selection is by original claim id, not by how well Pulse scores a claim.
    # Do not insert gold papers into the candidate pool: retrieval misses matter.
    seen_questions = set()
    for claim in sorted(claims, key=lambda r: int(r['id'])):
        if not claim['evidence'] or claim['claim'] in seen_questions: continue
        seen_questions.add(claim['claim'])
        scores = bm25_scores(corpus, [claim['claim']])
        indices = sorted(range(len(corpus)), key=lambda i: (-scores[i], corpus[i]['benchmarkId']))[:candidate_count]
        ids = [corpus[i]['benchmarkId'] for i in indices]
        selected.update(ids)
        cases.append({'name': 'SciFact dev claim '+str(claim['id']), 'question': claim['claim'], 'seeds': [],
                      'candidateIds': ids, 'qrels': {str(key): 1 for key in claim['evidence']},
                      'judgedOnly': True, 'knownRelevantComplete': False, 'retrievalMeasured': True})
        if len(cases) >= maximum: break
    return {'formatVersion': 2, 'scope': 'Official SciFact development claims and human-annotated evidence papers',
            'provenance': {'source': SOURCE, 'sha256': SHA256, 'project': 'https://github.com/allenai/scifact',
                           'claimsLicense': 'CC BY 4.0', 'abstractsLicense': 'ODC-By 1.0',
                           'authors': 'David Wadden, Shanchuan Lin, Kyle Lo, Lucy Lu Wang, Madeleine van Zuylen, Arman Cohan, Hannaneh Hajishirzi',
                           'corpusSize': len(corpus), 'candidateCount': candidate_count, 'selection': 'First distinct annotated dev claims ordered by claim id'},
            'corpus': [p for p in corpus if p['benchmarkId'] in selected], 'cases': cases}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--cases', type=int, default=30)
    parser.add_argument('--output', type=Path, default=Path('benchmarks/data/discovery-scifact.json'))
    args = parser.parse_args()
    doc = build(args.archive, args.cases)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':'))+'\n')
    print('Imported', len(doc['cases']), 'real claims and', len(doc['corpus']), 'candidate papers into', args.output)
