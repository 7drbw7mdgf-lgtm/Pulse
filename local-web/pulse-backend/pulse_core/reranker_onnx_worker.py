"""Offline ONNX cross-encoder worker; also frozen as a portable executable."""
import json
import math
import os
from pathlib import Path
import sys

os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def run(payload):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    root = Path(payload['model'])
    tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(4, os.cpu_count() or 1)
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(root / 'model.onnx'), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    inputs = {item.name for item in session.get_inputs()}
    queries = []
    for query in payload['queries'][:2]:
        ids = tokenizer.encode(str(query), add_special_tokens=False).ids[:192]
        queries.append(tokenizer.decode(ids))
    pairs, owners = [], []
    for index, paper in enumerate(payload['records']):
        abstract = (str(paper.get('abstract') or '') + '\n' + ' '.join(
            str(p.get('text') or '') for p in paper.get('matchedPassages') or []))[:16000]
        tokens = tokenizer.encode(abstract, add_special_tokens=False).ids
        offsets = list(range(0, len(tokens), 280))
        if payload.get('maxWindows')==1:offsets=offsets[:1]
        if len(offsets) > 4:
            offsets = [offsets[0], offsets[len(offsets)//3], offsets[2*len(offsets)//3], offsets[-1]]
        passages = [tokenizer.decode(tokens[offset:offset+320]) for offset in offsets] or ['']
        title = str(paper.get('title') or '')[:1600]
        for query in queries:
            for passage in passages:
                pairs.append((query, title + '\n' + passage))
                owners.append(index)
    pooled = [0.0] * len(payload['records'])
    tokenizer.enable_truncation(max_length=512, strategy='only_second')
    tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
    for start in range(0, len(pairs), 24):
        encoded = tokenizer.encode_batch(pairs[start:start+24])
        feed = {'input_ids': np.array([p.ids for p in encoded], dtype=np.int64),
                'attention_mask': np.array([p.attention_mask for p in encoded], dtype=np.int64),
                'token_type_ids': np.array([p.type_ids for p in encoded], dtype=np.int64)}
        logits = session.run(None, {name: value for name, value in feed.items() if name in inputs})[0]
        for owner, logit in zip(owners[start:start+24], logits.reshape(-1)):
            value = float(logit)
            if not math.isfinite(value): raise ValueError('Invalid pairwise score')
            pooled[owner] = max(pooled[owner], 1 / (1 + math.exp(-max(-60, min(60, value)))))
    return {'scores': pooled}


if __name__ == '__main__':
    print(json.dumps(run(json.load(sys.stdin))))
