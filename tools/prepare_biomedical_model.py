#!/usr/bin/env python3
"""Prepare the optional MedCPT ONNX component in a separate build environment.

Install scripts/requirements-biomedical-build.txt first. This explicit tool
downloads the pinned NCBI checkpoint; normal Pulse searches never download it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

MODEL='ncbi/MedCPT-Cross-Encoder'
REVISION='71caf65d4927987813984f54c284405a13fcca49'


def build(output,precision='auto'):
    import numpy as np
    import torch
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import onnx
    from onnxruntime.quantization import quantize_dynamic,QuantType
    from transformers import AutoTokenizer,AutoModelForSequenceClassification
    from huggingface_hub import hf_hub_download
    if tuple(int(p) for p in torch.__version__.split('.')[:2])<(2,6):
        raise ValueError('Use PyTorch 2.6 or newer for weights-only loading of the official checkpoint.')
    output=output.resolve()
    if output.exists():raise ValueError('Choose a new output folder; existing models are never overwritten.')
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pulse-medcpt-',dir=output.parent) as temp:
        root=Path(temp)
        tokenizer=AutoTokenizer.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False,token=False)
        model=AutoModelForSequenceClassification.from_pretrained(MODEL,revision=REVISION,trust_remote_code=False,weights_only=True,token=False)
        for name in ('LICENSE','README.md'):
            source=hf_hub_download(MODEL,name,revision=REVISION,token=False)
            shutil.copyfile(source,root/name)
        model.eval();torch.set_num_threads(4)
        class Logits(torch.nn.Module):
            def __init__(self,model):super().__init__();self.model=model
            def forward(self,input_ids,attention_mask,token_type_ids):return self.model(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids).logits
        pairs=[('diabetes treatment','We compared therapies in adult patients with diabetes.'),
               ('bacterial infection','We measured immune responses following bacterial infection.'),
               ('diabetes treatment','A transport simulation assessed bicycle lanes.')]
        tokens=tokenizer(pairs,padding=True,truncation=True,max_length=512,return_tensors='pt')
        args=tuple(tokens[key] for key in ('input_ids','attention_mask','token_type_ids'))
        wrapper=Logits(model).eval()
        torch.onnx.export(wrapper,args,str(root/'float.onnx'),input_names=['input_ids','attention_mask','token_type_ids'],
            output_names=['logits'],opset_version=17,dynamo=False,
            dynamic_axes={key:{0:'batch',1:'sequence'} for key in ('input_ids','attention_mask','token_type_ids')}|{'logits':{0:'batch'}})
        with torch.no_grad(): original=model(**tokens).logits.numpy()
        if not original[0,0]>original[2,0]:raise ValueError('The official model failed the related/unrelated conversion probe.')
        float_session=ort.InferenceSession(str(root/'float.onnx'),providers=['CPUExecutionProvider'])
        float_scores=float_session.run(None,{key:value.numpy() for key,value in tokens.items()})[0]
        float_error=float(np.max(np.abs(float_scores-original)))
        if float_error>.01:raise ValueError(f'ONNX export changed probe logits ({float_error:.3f}).')
        del float_session
        graph=onnx.load(str(root/'float.onnx'),load_external_data=False)
        # Keep attention and the classifier in float32. Quantizing every matrix
        # shifted scores beyond the conversion tolerance on the official model.
        nodes=[node.name for node in graph.graph.node if node.op_type=='MatMul' and
            '/attention/' not in node.name and any(part in node.name for part in ('/intermediate/dense/','/output/dense/'))]
        if len(nodes)!=24:raise ValueError('The pinned BERT feed-forward graph has changed; inspect the conversion.')
        del graph
        quantize_dynamic(str(root/'float.onnx'),str(root/'model.onnx'),weight_type=QuantType.QInt8,per_channel=True,nodes_to_quantize=nodes,op_types_to_quantize=['MatMul'])
        tokenizer.backend_tokenizer.save(str(root/'tokenizer.json'))
        session=ort.InferenceSession(str(root/'model.onnx'),providers=['CPUExecutionProvider'])
        scores=session.run(None,{key:value.numpy() for key,value in tokens.items()})[0]
        if scores.shape!=(len(pairs),1) or not np.isfinite(scores).all():raise ValueError('Converted model failed the offline output-shape check.')
        max_error=float(np.max(np.abs(scores-original)))
        probability=lambda logits:1/(1+np.exp(-np.clip(logits,-60,60)))
        score_error=float(np.max(np.abs(probability(scores)-probability(original))))
        print(json.dumps({'floatMaxLogitError':float_error,'int8MaxLogitError':max_error,'maxScoreError':score_error,
            'originalLogits':original.ravel().tolist(),'int8Logits':scores.ravel().tolist()}),flush=True)
        quantization='int8 feed-forward / float32 attention and classifier'
        failed=max_error>.5 or score_error>.05 or not (scores[0,0]>scores[2,0] and original[0,0]>original[2,0])
        if failed and precision=='int8':raise ValueError('Quantization failed the score-tolerance or related/unrelated probe check.')
        del session
        if precision=='float32' or failed:
            shutil.copyfile(root/'float.onnx',root/'model.onnx')
            quantization='float32; int8 conversion exceeded score tolerance' if failed else 'float32'
            print('Using the verified float32 export. Int8 is not enabled for this component.',flush=True)
        (root/'float.onnx').unlink()
        manifest={'format':'pulse-medcpt-onnx-v1','model':MODEL,'revision':REVISION,'quantization':quantization,
            'probeMaxLogitError':max_error,'probeMaxScoreError':score_error,'floatMaxLogitError':float_error,
            'int8Accepted':not failed and precision!='float32',
            'activeMaxLogitError':float_error if failed or precision=='float32' else max_error,
            'qualityValidation':'Three conversion probes only, not a relevance evaluation. Enable only as an experiment.',
            'source':'https://github.com/ncbi/MedCPT','sha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ('model.onnx','tokenizer.json')}}
        (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        shutil.copytree(root,output)
    print(f'Optional model prepared: {output}. Select this folder in Pulse Search settings.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--precision',choices=('auto','int8','float32'),default='auto',help='Auto retains float32 if int8 fails numerical checks.')
    args=parser.parse_args();build(args.output,args.precision)
