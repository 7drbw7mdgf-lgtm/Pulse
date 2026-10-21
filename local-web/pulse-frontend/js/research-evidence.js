/* Full text stays on the local comparison route, never in provider query payloads. */
function comparisonPaperPayload(paper) {
  const doi = p => String(p.doi||'').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'').replace(/^doi:\s*/,'');
  const local = (state.papers||[]).find(p => p.id===paper.id || (doi(paper)&&doi(p)===doi(paper)));
  const source = local || paper;
  return {...citationPaperPayload(paper), text:String(source.text||'').slice(0,350000), evidencePassages:source.evidencePassages||[]};
}
const PulseEvidence = (() => {
  let matrix;
  function dialog() {
    let root = document.getElementById('evidenceSourceDialog');
    if (!root) {
      root=document.createElement('dialog');root.id='evidenceSourceDialog';root.className='research-dialog';
      root.innerHTML='<form method="dialog"><button class="mac-btn" aria-label="Close evidence">Close</button></form><h2>Source evidence</h2><p data-evidence-label></p><blockquote data-evidence-quote></blockquote><div data-evidence-context class="evidence-text"></div><a data-evidence-link target="_blank" rel="noreferrer" hidden>Open source article</a><p class="subtle">Check the passage in context. Extracted text can contain OCR errors or describe another study.</p>';
      document.body.append(root);
    }
    return root;
  }
  function show(cell,title='Source evidence') {
    const root=dialog(),p=cell.provenance||{};
    root.querySelector('h2').textContent=title;
    root.querySelector('[data-evidence-label]').textContent=[p.source,p.section,p.page?`Page ${p.page}`:''].filter(Boolean).join(' · ');
    root.querySelector('[data-evidence-quote]').textContent=cell.quote||cell.text||'';
    const context=root.querySelector('[data-evidence-context]'),text=cell.passage||cell.text||cell.quote||'';
    context.textContent='';const at=cell.quote?text.indexOf(cell.quote):-1;
    if(at>=0){context.append(document.createTextNode(text.slice(0,at)));const mark=document.createElement('mark');mark.textContent=cell.quote;context.append(mark,document.createTextNode(text.slice(at+cell.quote.length)));}
    else context.textContent=text;
    const link=root.querySelector('[data-evidence-link]');link.hidden=true;
    root.querySelector('[data-evidence-pdf]')?.remove();
    if(p.pdfId&&typeof PulsePDF!=='undefined'){
      const button=document.createElement('button');button.dataset.evidencePdf='';button.type='button';button.className='mac-btn';button.textContent='Open PDF page '+p.page;
      button.onclick=()=>{const paper=state.papers.find(row=>row.id===p.paperId||(row.pdfAttachments||[]).some(file=>file.id===p.pdfId));if(paper)PulsePDF.open(paper.id,p.page,p.pdfId);else showToast('Attach the original PDF to this paper to open the page.');};root.append(button);
    }
    try {const url=new URL(p.url||'');if(url.protocol==='https:'&&!url.username&&!url.password){if(p.anchor)url.hash=p.anchor;link.href=url.href;link.hidden=false;}}catch(_){}
    if(!root.open)root.showModal();
  }
  async function verify(key,button) {
    const paper=(state.discoveryResults||[]).find(p=>discoveryPaperKey(p)===key);
    const seeds=(discoveryReviewContext().seedPapers||[]).filter(p=>p.doi||p.pmid);
    const target=seeds.length>1?await chooseSeed(seeds):seeds[0];
    if(seeds.length>1&&!target)return;
    if(!paper||!target)return showToast('Select a seed with a DOI or PMID to verify this citation.');
    button.disabled=true;button.textContent='Checking full text…';
    try {
      const response=await fetch(backendUrl('/api/citations/verify-context'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({paper:citationPaperPayload(paper),target:citationPaperPayload(target)})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Citation verification failed.');
      if(!data.verified)return showToast(data.message);
      const contexts=data.contexts||[];
      show({quote:contexts[0].text,passage:contexts.map(p=>p.text).join('\n\n'),provenance:{source:data.source,url:data.url,anchor:contexts[0].anchor,page:contexts[0].page,section:contexts[0].section}},'Citation of '+target.title);
      dialog().querySelector('[data-evidence-label]').append(document.createTextNode(' · '+data.message));
    } catch(error){showToast(error.message);}finally{button.disabled=false;button.textContent='Verify citation passage';}
  }
  function chooseSeed(seeds){
    return new Promise(resolve=>{
      const root=document.createElement('dialog');root.className='research-dialog';
      const title=document.createElement('h2');title.textContent='Which seed citation should be checked?';root.append(title);
      for(const seed of seeds){const button=document.createElement('button');button.className='mac-btn';button.textContent=seed.title||seed.doi||seed.pmid;button.onclick=()=>finish(seed);root.append(button);}
      const cancel=document.createElement('button');cancel.className='mac-btn';cancel.textContent='Cancel';cancel.onclick=()=>finish(null);root.append(cancel);
      function finish(value){root.close();root.remove();resolve(value);}
      root.oncancel=event=>{event.preventDefault();finish(null);};document.body.append(root);root.showModal();
    });
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-evidence-cell],[data-verify-citation]');if(!button)return;
    if(button.dataset.verifyCitation)return verify(button.dataset.verifyCitation,button);
    const row=button.dataset.evidenceCell,column=button.dataset.evidenceColumn;const cell=matrix?.rows?.[Number(row)]?.cells?.[column];
    if(cell)show(cell,matrix.rows[Number(row)].title);
  });
  return {accept:value=>{matrix=value;},show};
})();
