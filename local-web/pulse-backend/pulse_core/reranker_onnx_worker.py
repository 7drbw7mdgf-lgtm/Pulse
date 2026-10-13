"""Offline ONNX cross-encoder worker; also frozen as a portable executable."""
import json
import math
import os
from pathlib import Path
import sys

os.environ['TOKENIZERS_PARALLELISM'] = 'false'


_CACHED_SESSION = None
_CACHED_TOKENIZER = None
_CACHED_INPUTS = None
_CACHED_MODEL_ROOT = None


def _get_resources(model_path):
    global _CACHED_SESSION, _CACHED_TOKENIZER, _CACHED_INPUTS, _CACHED_MODEL_ROOT
    root_str = str(Path(model_path).resolve())
    if _CACHED_SESSION is not None and _CACHED_MODEL_ROOT == root_str:
        return _CACHED_SESSION, _CACHED_TOKENIZER, _CACHED_INPUTS
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    root = Path(model_path)
    tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(4, os.cpu_count() or 1)
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(root / 'model.onnx'), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    inputs = {item.name for item in session.get_inputs()}
    _CACHED_SESSION = session
    _CACHED_TOKENIZER = tokenizer
    _CACHED_INPUTS = inputs
    _CACHED_MODEL_ROOT = root_str
    return session, tokenizer, inputs


def run(payload):
    import numpy as np
    session, tokenizer, inputs = _get_resources(payload['model'])
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
        max_windows = int(payload.get('maxWindows') or 2)
        if len(offsets) > max_windows: offsets = offsets[:max_windows]
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
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception as e:
            print(json.dumps({'error': f'Invalid JSON: {e}'}), flush=True)
            continue
        req_id = payload.get('id')
        try:
            res = run(payload)
            if req_id is not None:
                res['id'] = req_id
                print(json.dumps(res), flush=True)
            else:
                print(json.dumps(res), flush=True)
                break
        except Exception as error:
            if req_id is not None:
                print(json.dumps({'id': req_id, 'error': str(error)}), flush=True)
            else:
                raise
