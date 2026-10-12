// Explicit local labels steer only searches with the same question and seeds.
function discoveryContextKey(context) {
  const key = paper => String(paper.doi || paper.s2PaperId || paper.title || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return JSON.stringify([String(context.researchQuestion || '').trim(), (context.seedPapers || []).map(key).sort()]);
}
function discoveryFeedbackPayload(seeds, options) {
  const feedbackContext = {researchQuestion: options.researchQuestion, seedPapers: seeds.map(citationPaperPayload)};
  const key = discoveryContextKey(feedbackContext);
  const relevanceFeedback = (state.discoveryJudgements || []).filter(row => discoveryContextKey(row.context) === key).slice(-40).map(row => ({grade: row.grade, paper: citationPaperPayload(row.paper)}));
  return {feedbackContext, relevanceFeedback};
}
function discoveryReviewContext() {
  return state.discoveryRunContext || {researchQuestion:discoveryConfiguration().researchQuestion,seedPapers:state.discoverySeed?[citationPaperPayload(state.discoverySeed)]:[]};
}
function discoveryRating(item) {
  const context=discoveryReviewContext();
  return (state.discoveryJudgements||[]).find(row=>row.paperKey===discoveryPaperKey(item)&&discoveryContextKey(row.context)===discoveryContextKey(context))?.grade;
}
function labelDiscoveryPaper(item,grade) {
  const context=discoveryReviewContext(),contextKey=discoveryContextKey(context),paperKey=discoveryPaperKey(item);
  state.discoveryJudgements=(state.discoveryJudgements||[]).filter(row=>!(row.paperKey===paperKey&&discoveryContextKey(row.context)===contextKey));
  if(grade===0||grade===1||grade===2)state.discoveryJudgements.push({paperKey,contextKey,context,grade,paper:{...item},labelledAt:new Date().toISOString()});
  state.discoveryJudgements=state.discoveryJudgements.slice(-1000);
  scheduleAutosave();renderDiscoveryModal();
}
function exportDiscoveryBenchmark() {
  const groups=new Map();
  for(const row of state.discoveryJudgements||[]){
    if(!groups.has(discoveryContextKey(row.context)))groups.set(discoveryContextKey(row.context),{question:row.context.researchQuestion||'',seeds:row.context.seedPapers,candidates:{reviewed:[]},qrels:{},judgedOnly:true});
    const group=groups.get(discoveryContextKey(row.context));group.candidates.reviewed.push(row.paper);group.qrels[row.paper.doi||row.paper.title]=row.grade;
  }
  // Include the complete retrieved pool when its research context is available.
  // Unlabelled papers remain unjudged; they are not invented negative examples.
  const run = state.discoveryRunInfo?.get(state.discoveryResultKey);
  const context = discoveryReviewContext(), current = groups.get(discoveryContextKey(context));
  if(current && state.discoveryResults?.length) {
    current.candidates = {retrieved: state.discoveryResults.map(p => ({...p}))};
    current.retrievalMeasured = Boolean(run?.status === 'complete');
    current.timings = run?.timings || {};
    current.sourceCounts = run?.sourceCounts || {};
    current.sourceErrors = run?.errors || {};
    current.knownRelevantComplete = false;
  }
  if(!groups.size){showToast('Mark a few results as relevant or not relevant first.');return;}
  const file=new Blob([JSON.stringify({formatVersion:1,cases:[...groups.values()]},null,2)],{type:'application/json'}),url=URL.createObjectURL(file);
  const link=document.createElement('a');link.href=url;link.download='Pulse-search-relevance.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast('Exported your local relevance labels.');
}
function initDiscoveryReview(){
  document.getElementById('s2orcFileInput')?.addEventListener('change',async event=>{
    const input=event.currentTarget,file=input.files[0],status=document.getElementById('s2orcImportStatus');
    if(!file)return;
    if(file.size>20*1024*1024){status.textContent='Choose an excerpt up to 20 MB; larger shards can be split with the command-line importer.';return;}
    status.textContent='Indexing your full-text excerpt…';input.disabled=true;
    try{
      await backendReady;
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
      const response=await fetch(backendUrl('/api/corpus/s2orc/import'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({base64:data}),signal:AbortSignal.timeout(120000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Import failed');
      status.textContent=`${result.imported} full-text records indexed · ${result.skipped} records without usable text or identifiers.`;
    }catch(error){status.textContent=error.message||'The file could not be imported.';}finally{input.disabled=false;}
  });
  document.getElementById('discoveryFullTextOnly')?.addEventListener('change',event=>{state.discoveryFullTextOnly=event.currentTarget.checked;renderDiscoveryModal();});
  document.getElementById('discoveryResetFilters')?.addEventListener('click',()=>{
    state.discoveryFilterText='';state.discoveryFilterAuthor='';state.discoveryFilterYear='all';state.discoveryFilterBranch='all';state.discoveryQuickTag='';state.discoveryFullTextOnly=false;
    state.discoveryWhyKinds=new Set();state.discoveryHiddenStrengths=new Set();
    if(els.discoveryClearTextBtn)els.discoveryClearTextBtn.hidden=true;
    for(const id of ['discoveryFilterText','discoveryFilterAuthor'])document.getElementById(id).value='';
    document.getElementById('discoveryFilterYear').value='all';document.getElementById('discoveryFullTextOnly').checked=false;renderDiscoveryModal();
  });
  document.getElementById('discoveryRefineFeedback')?.addEventListener('click',()=>{closeDiscoveryModal();runDiscoveryPipeline();});
  document.getElementById('discoveryExportLabels')?.addEventListener('click',exportDiscoveryBenchmark);
  els.discoveryPaperList?.addEventListener('click',event=>{
    const button=event.target.closest('[data-relevance-grade]');if(!button)return;
    event.stopPropagation();const item=state.discoveryResults.find(p=>discoveryPaperKey(p)===button.dataset.paperKey);if(item)labelDiscoveryPaper(item,Number(button.dataset.relevanceGrade));
  });
}

const discoveryPassageCache = new Map();
function discoveryPassageCacheKey(item){return discoveryPaperKey(item)+'::'+String(discoveryReviewContext().researchQuestion||'');}
function discoveryPassageMarkup(item){
  const entry=discoveryPassageCache.get(discoveryPassageCacheKey(item));
  if(!entry)return '';
  if(entry.loading)return '<p role="status">Looking for available full text…</p>';
  if(!entry.available)return `<p class="dv-muted" role="status">${escapeHtml(entry.message||'Full text is unavailable.')}</p>`;
  const href=safeHref(entry.url||'');
  return `<p class="dv-muted">${escapeHtml(entry.source)} · ${escapeHtml(entry.message)}</p>${entry.passages.map(p=>`<details><summary>${escapeHtml(p.section)} · ${escapeHtml(p.id)}</summary><p>${escapeHtml(p.text)}</p></details>`).join('')}<p class="dv-muted">${escapeHtml(entry.license||'')}${href?` · <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Article source ↗</a>`:''}</p>`;
}
async function readDiscoveryPassages(item){
  const key=discoveryPassageCacheKey(item);if(discoveryPassageCache.get(key)?.loading)return;
  discoveryPassageCache.set(key,{loading:true});renderDiscoveryModal();
  try{
    await backendReady;
    const response=await fetch(backendUrl('/api/papers/passages'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({paper:citationPaperPayload(item),question:discoveryReviewContext().researchQuestion,limit:8}),signal:AbortSignal.timeout(45000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Full text could not be read.');
    discoveryPassageCache.set(key,result);
  }catch(error){discoveryPassageCache.set(key,{available:false,message:error.message});}
  if(discoveryPassageCache.size>40)discoveryPassageCache.delete(discoveryPassageCache.keys().next().value);
  renderDiscoveryModal();
}
