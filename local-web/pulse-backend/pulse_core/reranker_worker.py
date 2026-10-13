"""JSON-only subprocess worker. Never downloads weights or executes model code."""
import json
import os
from pathlib import Path
import sys
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


_CACHED_MODEL = None
_CACHED_MODEL_PATH = None


def _get_model(model_path):
    global _CACHED_MODEL, _CACHED_MODEL_PATH
    root_str = str(Path(model_path).resolve()) if os.path.exists(str(model_path)) else str(model_path)
    if _CACHED_MODEL is not None and _CACHED_MODEL_PATH == root_str:
        return _CACHED_MODEL
    import torch
    from sentence_transformers import CrossEncoder
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model = CrossEncoder(model_path, local_files_only=True, trust_remote_code=False,
                         device='cpu', max_length=512, activation_fn=torch.nn.Identity(),
                         model_kwargs={'use_safetensors': True})
    try:
        import torch.backends.quantized
        if 'qnnpack' in torch.backends.quantized.supported_engines:
            torch.backends.quantized.engine = 'qnnpack'
        elif 'fbgemm' in torch.backends.quantized.supported_engines:
            torch.backends.quantized.engine = 'fbgemm'
        base_model = getattr(model.model, getattr(model.model, 'base_model_prefix', 'bert'), getattr(model.model, 'bert', None))
        if base_model is not None and hasattr(torch.ao, 'quantization'):
            quantized_base = torch.ao.quantization.quantize_dynamic(base_model, {torch.nn.Linear}, dtype=torch.qint8)
            setattr(model.model, getattr(model.model, 'base_model_prefix', 'bert'), quantized_base)
    except Exception:
        pass
    _CACHED_MODEL = model
    _CACHED_MODEL_PATH = root_str
    return model


def run(payload):
    import torch
    model = _get_model(payload['model'])
    tokenizer = model.tokenizer
    queries = [str(q) for q in payload['queries'][:2]]
    # Preserve the tail of abstracts with overlapping token windows. Title is
    # present in every passage; pooling avoids treating missing text as a zero.
    pairs, owners = [], []
    for index, paper in enumerate(payload['records']):
        abstract = (str(paper.get('abstract') or '')+'\n'+' '.join(p['text'] for p in paper.get('matchedPassages') or []))[:16000]
        tokens = tokenizer.encode(abstract, add_special_tokens=False)
        offsets = list(range(0,len(tokens),280))
        max_windows = int(payload.get('maxWindows') or 2)
        if len(offsets) > max_windows: offsets = offsets[:max_windows]
        passages = [tokenizer.decode(tokens[offset:offset+320]) for offset in offsets] or ['']
        for query in queries:
            for passage in passages:
                pairs.append((query, str(paper.get('title') or '')+'\n'+passage)); owners.append(index)
    scores = model.predict(pairs, batch_size=24, show_progress_bar=False, convert_to_numpy=True)
    pooled = [0.0]*len(payload['records'])
    for owner, logit in zip(owners, scores):
        probability = float(torch.sigmoid(torch.tensor(float(logit))))
        pooled[owner] = max(pooled[owner], probability)
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
