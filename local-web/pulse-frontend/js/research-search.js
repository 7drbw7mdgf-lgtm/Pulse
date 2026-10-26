/* Search completeness, targeted retries and opt-in ranking experiments. */
const PulseSearch = (() => {
  let preferencesReady=false;
  async function post(path,payload={}){
    const response=await fetch(backendUrl(path),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Search settings could not be updated.');return data;
  }
  function retry(){
    const info=discoveryRunInfoForModal(),context=info.runContext||discoveryReviewContext();
    const branches=discoverySourceRows().filter(row=>['fail','warn'].includes(row.status)&&info.errors?.[row.key]).map(row=>row.key);
    if(!branches.length)return;
    if(!context.configuration)return showToast('Run this retained search once to enable retries with its original options.');
    return runDiscoveryPipeline({searchMode:context.searchMode,query:context.researchQuestion,seedPapers:context.seedPapers,
      configuration:context.configuration,resultKey:state.discoveryResultKey,retryBranches:branches});
  }
  function render(){
    const button=document.getElementById('retryIncompleteSources');if(!button)return;
    const info=state.discoverySearching?.job||discoveryRunInfoForModal(),rows=discoverySourceRows(),problems=rows.filter(r=>['warn','fail'].includes(r.status));
    button.hidden=!problems.some(r=>info.errors?.[r.key]);button.disabled=!!state.discoveryLoading||!!state.discoverySearching;
    const label=document.getElementById('searchCompleteness');
    label.textContent=state.discoveryLoading?'Search in progress. Source coverage is still being checked.':info.searchMode==='paper'?'Paper located from the DOI or article link.':info.retryNotice||(!rows.length?'':problems.length?`Limited coverage: ${problems.map(r=>r.name).join(', ')}. Returned results are retained.`:'Selected sources completed. Indexed coverage and result limits still apply.');
    const detail=document.getElementById('discoverySearchDetailsContent');
    detail?.querySelectorAll('[data-ranking-detail]').forEach(node=>node.remove());
    if(detail&&info.structuralPolicy?.mode==='adaptive-experimental'){
      const p=info.structuralPolicy;const line=document.createElement('div');line.dataset.rankingDetail='';line.textContent=`Experimental citation weighting: ${p.intent} · up to ${(p.weight*100).toFixed(1)} points · ${Math.round(p.seedReferenceCoverage*100)}% of seeds have indexed references`;detail.append(line);
    }
    if(detail&&info.pairwiseRankingNotice){const line=document.createElement('div');line.dataset.rankingDetail='';line.textContent=info.pairwiseRankingNotice;detail.append(line);}
  }
  async function settings(){
    const status=document.getElementById('rankingExperimentStatus');if(!status)return;
    try {
      const data=await post('/api/search/ranking');
      document.getElementById('adaptiveCitationToggle').checked=data.adaptiveStructure;
      document.getElementById('adaptiveCitationIntent').value=data.structuralIntent;
      document.getElementById('biomedicalRouterToggle').checked=data.biomedicalRouter;
      document.getElementById('biomedicalModelFolder').value=data.biomedicalModelPath;
      preferencesReady=true;
      status.textContent=data.biomedicalModelAvailable?'Biomedical model verified. Routing remains experimental.':'MiniLM is available by default. Add the optional biomedical model to activate routing.';
    } catch(error){status.textContent=error.message;}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const anchor=document.getElementById('discoverySourceNotice');
    if(anchor){const root=document.createElement('div');root.className='research-tools search-completeness';root.innerHTML='<span id="searchCompleteness" role="status"></span><button id="retryIncompleteSources" class="dv-btn small" type="button" hidden>Retry unavailable sources</button>';anchor.after(root);document.getElementById('retryIncompleteSources').onclick=retry;}
    const pane=document.querySelector('[data-settings-pane="search"]');if(!pane)return;
    const root=document.createElement('div');root.className='mac-group-card research-settings';
    root.innerHTML='<div class="mac-group-title">Ranking experiments</div><p>Experimental settings can change relevance and search time. Standard ranking stays available when a model or topic classification is missing.</p><label><input id="adaptiveCitationToggle" type="checkbox"> Adaptive citation weighting</label><label>Citation emphasis <select id="adaptiveCitationIntent"><option value="auto">Automatic</option><option value="bibliography">Explore a seed bibliography</option><option value="focused">Focused topical question</option></select></label><label><input id="biomedicalRouterToggle" type="checkbox"> Optional biomedical reranking</label><label>Biomedical model folder <input id="biomedicalModelFolder" class="mac-input" type="text" spellcheck="false" placeholder="Folder containing the optional MedCPT model"></label><p id="rankingExperimentStatus" role="status"></p><button id="saveRankingExperiments" class="mac-btn" type="button">Save ranking settings</button><div class="mac-group-title">Search cache</div><p>Topic searches expire after 15 minutes. Identifier and citation responses refresh after seven days. Maintenance runs while search is idle.</p><button id="cleanSearchCache" class="mac-btn" type="button">Clean expired search cache</button><p id="searchCacheStatus" role="status"></p>';
    pane.append(root);
    document.getElementById('saveRankingExperiments').onclick=async()=>{
      const button=document.getElementById('saveRankingExperiments');button.disabled=true;
      try{await post('/api/settings',{searchAdaptiveStructure:document.getElementById('adaptiveCitationToggle').checked,
        searchStructuralIntent:document.getElementById('adaptiveCitationIntent').value,searchBiomedicalRouter:document.getElementById('biomedicalRouterToggle').checked,
        searchBiomedicalModelPath:document.getElementById('biomedicalModelFolder').value});await settings();showToast('Ranking settings saved. They apply to the next search.');}
      catch(error){document.getElementById('rankingExperimentStatus').textContent=error.message;}finally{button.disabled=false;}
    };
    document.getElementById('cleanSearchCache').onclick=async()=>{try{const data=await post('/api/search/cache',{action:'clean'});document.getElementById('searchCacheStatus').textContent=`${data.entries} cached responses · ${(data.bytes/1048576).toFixed(1)} MB · ${data.removed} expired or excess responses removed`;}catch(error){document.getElementById('searchCacheStatus').textContent=error.message;}};
    settings();
  });
  function preferencePayload(){
    const adaptive=document.getElementById('adaptiveCitationToggle');
    if(!adaptive||!preferencesReady)return {};
    return {searchAdaptiveStructure:adaptive.checked,searchStructuralIntent:document.getElementById('adaptiveCitationIntent').value,
      searchBiomedicalRouter:document.getElementById('biomedicalRouterToggle').checked,searchBiomedicalModelPath:document.getElementById('biomedicalModelFolder').value};
  }
  return {render,retry,preferencePayload};
})();
