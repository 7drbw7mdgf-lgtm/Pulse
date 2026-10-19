const assert=require('node:assert/strict'),Graph=require('../pulse-frontend/graph-engine.js');
let random=20261019;const next=()=>((random=(Math.imul(random,1664525)+1013904223)>>>0)/4294967296);
for(let run=0;run<16;run++) {
 const papers=Array.from({length:25},(_,i)=>({id:'p'+i,title:'Shared study '+i,authors:[],text:Array.from({length:35},()=>['common','transport','vesicles','biofilm','neural','immune','tissue','detection','genomic','bacterial'][Math.floor(next()*10)]).join(' ')}));
 const engine=Graph.createEngine();
 for(const threshold of [0,.05,.25,.5,.75,.95]) {
  const result=engine.analyse({papers,threshold}),vectors=new Map(result.vectors.map(([id,entries])=>[id,new Map(entries)])),expected=[];
  for(let i=0;i<papers.length;i++)for(let j=i+1;j<papers.length;j++) {
   const a=vectors.get(papers[i].id),b=vectors.get(papers[j].id),[small,large]=a.size<b.size?[a,b]:[b,a];let score=0;
   for(const [term,w] of small)score+=w*(large.get(term)||0);
   if(score>=threshold)expected.push({source:papers[i].id,target:papers[j].id,score,type:'similarity'});
  }
  assert.deepEqual(result.links,expected,'Exact candidate bounds must preserve every qualifying pair');
 }
 const before=engine.analyse({papers,threshold:.5});papers[3].text+=' novelterm';
 const after=engine.analyse({papers,threshold:.5}),fresh=Graph.createEngine().analyse({papers,threshold:.5});
 assert.deepEqual(after.links,fresh.links);assert.deepEqual(after.vectors,fresh.vectors);assert.deepEqual(after.clusters,fresh.clusters);
 assert.equal(after.stats.tokenizations,before.stats.tokenizations+1,'A single edited paper is the only document tokenized again');
 papers[3].referenceIds=['W999'];const citation=engine.analyse({papers,threshold:.5});assert.equal(citation.stats.vectorBuilds,after.stats.vectorBuilds);
}
console.log('PASS: exact sparse cosine joins versus brute force across 96 randomized cases, lower/higher thresholds, one-paper tokenization and incremental/fresh parity.');
