"""JSON-only subprocess worker. Never downloads weights or executes model code."""
import json
import os
import sys
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def run(payload):
    import torch
    from sentence_transformers import CrossEncoder
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model = CrossEncoder(payload['model'], local_files_only=True, trust_remote_code=False,
                         device='cpu', max_length=512, activation_fn=torch.nn.Identity(),
                         model_kwargs={'use_safetensors': True})
    tokenizer = model.tokenizer
    queries = [str(q) for q in payload['queries'][:2]]
    # Preserve the tail of abstracts with overlapping token windows. Title is
    # present in every passage; pooling avoids treating missing text as a zero.
    pairs, owners = [], []
    for index, paper in enumerate(payload['records']):
        abstract = (str(paper.get('abstract') or '')+'\n'+' '.join(p['text'] for p in paper.get('matchedPassages') or []))[:16000]
        tokens = tokenizer.encode(abstract, add_special_tokens=False)
        offsets = list(range(0,len(tokens),280))
        if payload.get('maxWindows')==1:offsets=offsets[:1]
        if len(offsets) > 4: offsets = [offsets[0],offsets[len(offsets)//3],offsets[2*len(offsets)//3],offsets[-1]]
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
    print(json.dumps(run(json.load(sys.stdin))))
