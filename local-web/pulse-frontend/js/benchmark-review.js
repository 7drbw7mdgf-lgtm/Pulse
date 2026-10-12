let benchmarkDoc,benchmarkCase=0;
const benchmarkReviewKey='pulse.researchBenchmark.review.v1';
let reviewed={};try{reviewed=JSON.parse(localStorage.getItem(benchmarkReviewKey)||'{}');}catch{}
function reviewElement(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function rememberBenchmark(){try{localStorage.setItem(benchmarkReviewKey,JSON.stringify(reviewed));}catch{}updateBenchmarkCount();}
function updateBenchmarkCount(){document.getElementById('reviewCount').textContent=Object.keys(reviewed).filter(key=>key!=='reviewer'&&!key.startsWith('seed:')).length+' paper judgments reviewed';}
function benchmarkSeed(entry,value){
  const doi=String(value||'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi\s*:\s*/i,'').toLowerCase();
  if(!doi)return {doi:''};
  if(!/^10\.\d{4,9}\/\S+$/.test(doi))return {error:'Enter a complete seed DOI.'};
  if(entry.targets.some(target=>String(target.paper.doi||'').toLowerCase()===doi))return {error:'Choose a related seed distinct from every judged target.'};
  return {doi};
}
function showBenchmarkCase(index){
  benchmarkCase=index;const entry=benchmarkDoc.cases[index],root=document.getElementById('case');root.replaceChildren();
  document.querySelectorAll('#questions button').forEach((button,i)=>button.setAttribute('aria-current',String(i===index)));
  root.append(reviewElement('div',entry.domain+' · '+entry.split+' split','case-meta'),reviewElement('h2',entry.question));
  const search=reviewElement('a','Open question in Pulse →');search.href='/?concept='+encodeURIComponent(entry.question);root.append(search);
  const seedLabel=reviewElement('label','Optional seed DOI for DBEF evaluation '),seed=reviewElement('input');
  seed.value=reviewed['seed:'+entry.id]||entry.seeds?.[0]?.doi||'';seed.placeholder='A related paper, distinct from the target';
  seed.addEventListener('change',()=>{const result=benchmarkSeed(entry,seed.value);seed.setCustomValidity(result.error||'');if(result.error){seed.reportValidity();return;}reviewed['seed:'+entry.id]=result.doi;rememberBenchmark();});seedLabel.append(seed);root.append(seedLabel);
  for(const [i,target] of entry.targets.entries()){
    const key=entry.id+':'+i,rating=reviewed[key];
    const article=reviewElement('article');article.append(reviewElement('h3',target.paper.title));
    article.append(reviewElement('p',target.judgmentSource+' · '+(rating?'Reviewed':target.reviewState),'case-meta'));
    if(target.rationale)article.append(reviewElement('p',target.rationale));
    const link=reviewElement('a',target.paper.doi?'Read DOI record ↗':'Find the paper ↗');
    link.href=target.paper.doi?'https://doi.org/'+encodeURIComponent(target.paper.doi):'https://scholar.google.com/scholar?q='+encodeURIComponent(target.paper.title);link.target='_blank';link.rel='noreferrer';article.append(link);
    const row=reviewElement('div',undefined,'rating'),label=reviewElement('label','Relevance '),select=reviewElement('select');
    for(const [value,text] of [['','Unreviewed'],['0','Not relevant'],['1','Relevant'],['2','Highly relevant']]){const option=reviewElement('option',text);option.value=value;select.append(option);}
    select.value=rating?String(rating.grade):target.reviewState==='human-annotated'?String(target.grade):'';
    select.setAttribute('aria-label','Relevance for '+target.paper.title);label.append(select);
    const landmark=reviewElement('input');landmark.type='checkbox';landmark.checked=Boolean(rating?.landmark);const landmarkLabel=reviewElement('label','Landmark paper ');landmarkLabel.prepend(landmark);
    const changed=()=>{if(select.value===''){delete reviewed[key];landmark.checked=false;}else reviewed[key]={grade:Number(select.value),landmark:landmark.checked&&Number(select.value)>0,reviewedAt:new Date().toISOString()};article.querySelector('.case-meta').textContent=target.judgmentSource+' · '+(reviewed[key]?'Reviewed':target.reviewState);rememberBenchmark();};
    select.addEventListener('change',changed);landmark.addEventListener('change',changed);row.append(label,landmarkLabel);article.append(row);root.append(article);
  }
}
document.getElementById('reviewer').value=reviewed.reviewer||'';
document.getElementById('reviewer').addEventListener('input',event=>{reviewed.reviewer=event.target.value.slice(0,80);rememberBenchmark();});
document.getElementById('exportReview').addEventListener('click',()=>{
  if(!String(reviewed.reviewer||'').trim()){document.getElementById('reviewer').focus();document.getElementById('reviewCount').textContent='Enter a reviewer alias before exporting.';return;}
  const doc=JSON.parse(JSON.stringify(benchmarkDoc));doc.provenance.review={reviewer:reviewed.reviewer,exportedAt:new Date().toISOString()};
  for(const entry of doc.cases)if(reviewed['seed:'+entry.id]){const result=benchmarkSeed(entry,reviewed['seed:'+entry.id]);if(result.error){document.getElementById('reviewCount').textContent=entry.id.toUpperCase()+': '+result.error;return;}entry.seeds=[{doi:result.doi}];}
  for(const entry of doc.cases)for(const [i,target] of entry.targets.entries()){
    const row=reviewed[entry.id+':'+i];if(!row)continue;
    Object.assign(target,row,{reviewState:'reviewed',landmarkReviewState:'reviewed',judgmentSource:'Manual review by '+reviewed.reviewer});
  }
  const href=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}));const link=reviewElement('a');link.href=href;link.download='pulse-research-benchmark-reviewed.json';link.click();setTimeout(()=>URL.revokeObjectURL(href),1000);
});
fetch('data/research-benchmark.json').then(response=>{if(!response.ok)throw Error('Benchmark unavailable');return response.json();}).then(doc=>{
  benchmarkDoc=doc;const root=document.getElementById('questions');for(const [index,entry] of doc.cases.entries()){
    const button=reviewElement('button',entry.id.toUpperCase()+' · '+entry.question);button.type='button';button.addEventListener('click',()=>showBenchmarkCase(index));root.append(button);
  }showBenchmarkCase(0);updateBenchmarkCount();
}).catch(()=>{document.getElementById('case').textContent='The benchmark could not be loaded.';});
