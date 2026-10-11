// Local relevance labels can be exported to a repeatable search benchmark.
function discoveryReviewContext() {
  return state.discoveryRunContext || {researchQuestion:discoveryConfiguration().researchQuestion,seedPapers:state.discoverySeed?[citationPaperPayload(state.discoverySeed)]:[]};
}
function discoveryRating(item) {
  const context=discoveryReviewContext();
  return (state.discoveryJudgements||[]).find(row=>row.paperKey===discoveryPaperKey(item)&&row.contextKey===JSON.stringify(context))?.grade;
}
function labelDiscoveryPaper(item,grade) {
  const context=discoveryReviewContext(),contextKey=JSON.stringify(context),paperKey=discoveryPaperKey(item);
  state.discoveryJudgements=(state.discoveryJudgements||[]).filter(row=>!(row.paperKey===paperKey&&row.contextKey===contextKey));
  if(grade===0||grade===1||grade===2)state.discoveryJudgements.push({paperKey,contextKey,context,grade,paper:{...item},labelledAt:new Date().toISOString()});
  state.discoveryJudgements=state.discoveryJudgements.slice(-1000);
  scheduleAutosave();renderDiscoveryModal();
}
function exportDiscoveryBenchmark() {
  const groups=new Map();
  for(const row of state.discoveryJudgements||[]){
    if(!groups.has(row.contextKey))groups.set(row.contextKey,{question:row.context.researchQuestion||'',seeds:row.context.seedPapers,candidates:{reviewed:[]},qrels:{},judgedOnly:true});
    const group=groups.get(row.contextKey);group.candidates.reviewed.push(row.paper);group.qrels[row.paper.doi||row.paper.title]=row.grade;
  }
  if(!groups.size){showToast('Mark a few results as relevant or not relevant first.');return;}
  const file=new Blob([JSON.stringify({formatVersion:1,cases:[...groups.values()]},null,2)],{type:'application/json'}),url=URL.createObjectURL(file);
  const link=document.createElement('a');link.href=url;link.download='Pulse-search-relevance.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast('Exported your local relevance labels.');
}
function initDiscoveryReview(){
  document.getElementById('discoveryFullTextOnly')?.addEventListener('change',event=>{state.discoveryFullTextOnly=event.currentTarget.checked;renderDiscoveryModal();});
  document.getElementById('discoveryResetFilters')?.addEventListener('click',()=>{
    state.discoveryFilterText='';state.discoveryFilterAuthor='';state.discoveryFilterYear='all';state.discoveryFilterBranch='all';state.discoveryQuickTag='';state.discoveryFullTextOnly=false;
    for(const id of ['discoveryFilterText','discoveryFilterAuthor'])document.getElementById(id).value='';
    document.getElementById('discoveryFilterYear').value='all';document.getElementById('discoveryFullTextOnly').checked=false;renderDiscoveryModal();
  });
  document.getElementById('discoveryExportLabels')?.addEventListener('click',exportDiscoveryBenchmark);
  els.discoveryPaperList?.addEventListener('click',event=>{
    const button=event.target.closest('[data-relevance-grade]');if(!button)return;
    event.stopPropagation();const item=state.discoveryResults.find(p=>discoveryPaperKey(p)===button.dataset.paperKey);if(item)labelDiscoveryPaper(item,Number(button.dataset.relevanceGrade));
  });
}
