// One configuration shared by the toolbar, inspector and discovery request.
const discoveryMethodKeys = {citations:'citationGraph',network:'citationNetwork',semantic:'semanticSearch',concepts:'lexicalSearch'};
let discoveryOptionsReturnFocusId = 'discoveryOptionsButton';
let activeRibbonTab = 'discovery';
let ribbonCollapsed = false;
function discoveryConfiguration() {
  const branches = Object.fromEntries(Object.values(discoveryMethodKeys).map(key => [key,state.discoveryBranches?.[key] !== false]));
  const depth = ['1','2','3','iterative'].includes(String(state.discoveryDepth)) ? String(state.discoveryDepth) : '1';
  const searchSources=Object.fromEntries(['semanticScholar','europePmc','core'].map(key=>[key,state.discoverySearchSources?.[key] !== false]));
  const limit=[50,100,200,500].includes(Number(state.discoveryLimit))?Number(state.discoveryLimit):200;
  return {branches,searchSources,depth,limit,bridgeMode:Boolean(state.discoveryBridgeMode),aiTriage:Boolean(state.discoveryAiTriage),fastEmbed:Boolean(state.discoveryFastEmbed),fullTextSearch:Boolean(state.discoveryFullTextSearch),researchQuestion:String(state.discoveryResearchQuestion||'').trim(),strictExcludeKeywords:[...(state.discoveryStrictExclusions||[])],diversify:state.discoveryDiversify!==false,includeIterativeChase:depth !== '1',
    steerKeywords:[...(state.recommendationSteerKeywords || [])],excludeKeywords:[...(state.recommendationExcludeKeywords || [])],
    recencyTilt:Number(state.recommendationRecencyTilt) || 0,impactTilt:Number(state.recommendationImpactTilt) || 0};
}
function discoveryConfigurationKey() {
  const options=discoveryConfiguration();
  return 'ranking-178::'+Object.values(options.branches).map(Boolean).join('_')+'::'+options.depth+'::'+options.limit+'::'+Object.values(options.searchSources).map(Boolean).join('_')+'::'+JSON.stringify([options.researchQuestion,options.strictExcludeKeywords,options.diversify,options.bridgeMode,options.aiTriage,options.fastEmbed,options.fullTextSearch]);
}
function discoveryOptionsLabel() {
  const options=discoveryConfiguration(),enabled=Object.keys(discoveryMethodKeys).filter(method=>options.branches[discoveryMethodKeys[method]]);
  const names={citations:'Citations',network:'Network',semantic:'Semantic',concepts:'Concepts'};
  const methods=enabled.length===4?'All methods':enabled.length===0?'No methods':enabled.length===1?names[enabled[0]]:`${enabled.length} methods`;
  const parts=[methods,options.depth==='iterative'?'Iterative':options.depth+'-hop'];
  if(options.impactTilt>0)parts.push('Foundational');
  if(options.recencyTilt>0)parts.push('Recent');
  return parts.join(' · ');
}
function syncDiscoveryControls() {
  const popup=document.getElementById('discoveryOptionsPopup');if(!popup)return;
  const options=discoveryConfiguration();
  const limitInput=document.getElementById('discoveryResultLimit');if(limitInput)limitInput.value=String(options.limit);
  const review=document.getElementById('discoveryViewResults');if(review){review.hidden=!state.discoveryLastRun;review.textContent='Review '+(state.discoveryLastRun?.recommendations?.length||0)+' results';}
  const question=document.getElementById('discoveryResearchQuestion');if(question&&document.activeElement!==question)question.value=options.researchQuestion;
  const strict=document.getElementById('discoveryStrictExcludeInput');if(strict&&document.activeElement!==strict)strict.value=options.strictExcludeKeywords.join('; ');
  const diversity=document.getElementById('discoveryDiversify');if(diversity)diversity.checked=options.diversify;
  for(const [id,key] of [['discoveryBridgeMode','discoveryBridgeMode'],['discoveryAiTriage','discoveryAiTriage'],['discoveryFastEmbed','discoveryFastEmbed'],['discoveryFullTextSearch','discoveryFullTextSearch']]){const input=document.getElementById(id);if(input)input.checked=Boolean(state[key]);}
  const progress=document.getElementById('discoveryRunProgress');if(progress)progress.hidden=!state.discoveryLoading;
  const progressText=document.getElementById('discoveryProgressText');if(progressText)progressText.textContent=state.discoveryProgressText||'Searching your selected sources…';
  const progressBar=document.getElementById('discoveryProgressBar');if(progressBar)progressBar.value=state.discoveryProgressPercent||0;
  const discoverButton=document.getElementById('ribbonDiscoverButton');if(discoverButton){discoverButton.disabled=Boolean(state.discoveryLoading);discoverButton.textContent=state.discoveryLoading?'Searching…':'Discover related';}
  popup.querySelectorAll('[data-method]').forEach(button=>{
    const active=options.branches[discoveryMethodKeys[button.dataset.method]];
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  popup.querySelectorAll('[data-depth]').forEach(button=>{
    const active=button.dataset.depth===options.depth;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  popup.querySelectorAll('[data-search-source]').forEach(button=>{
    const active=options.searchSources[button.dataset.searchSource];button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    button.disabled=!options.branches.lexicalSearch;
  });
  popup.querySelectorAll('[data-special]').forEach(button=>{
    const active=button.dataset.special==='recent'?options.recencyTilt>0:options.impactTilt>0;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  document.querySelectorAll('[data-discovery-summary]').forEach(node=>node.textContent=discoveryOptionsLabel());
  document.getElementById('discoveryOptionsSummary').textContent=discoveryOptionsLabel();
  const fields={discoverySteerInput:'recommendationSteerKeywords',discoveryExcludeInput:'recommendationExcludeKeywords',discoveryGraphFocusInput:'graphSteerKeywords'};
  Object.entries(fields).forEach(([id,key])=>{const input=document.getElementById(id);if(input&&document.activeElement!==input)input.value=(state[key]||[]).join('; ');});
  const advanced=document.getElementById('discoveryKeywordOptions');if(advanced)advanced.open=Boolean(state.recommendationSteerOpen);
  document.getElementById('inspectorDiscoveryOptions')?.setAttribute('aria-expanded',String(!popup.hidden));
}
function setDiscoveryOptionsOpen(open,returnFocus=false,triggerId='discoveryOptionsButton') {
  const popup=document.getElementById('discoveryOptionsPopup'),button=document.getElementById('discoveryOptionsButton');
  if(open){setRibbonTab('discovery');discoveryOptionsReturnFocusId=triggerId;setRailAddOpen(false);syncDiscoveryControls();}
  popup.hidden=!open;button.setAttribute('aria-expanded',String(open));
  document.getElementById('inspectorDiscoveryOptions')?.setAttribute('aria-expanded',String(open));
  if(open)popup.querySelector('[data-method]')?.focus();
  else if(returnFocus)(document.getElementById(discoveryOptionsReturnFocusId)||button).focus();
}
function discoveryOptionsChanged(mapFocus=false) {
  if(mapFocus)render();else{renderDetails();syncDiscoveryControls();scheduleAutosave();}
}
function setRibbonTab(name,focus=false,collapsed=false) {
  const active=name==='references'?'references':'discovery';
  activeRibbonTab=active;ribbonCollapsed=Boolean(collapsed);
  document.getElementById('workspaceRibbon')?.classList.toggle('is-collapsed',ribbonCollapsed);
  for(const [key,suffix] of [['discovery','Discovery'],['references','References']]){
    const button=document.getElementById('ribbon'+suffix+'Tab'),panel=document.getElementById('ribbon'+suffix+'Panel');
    if(!button||!panel)continue;
    const selected=key===active,expanded=selected&&!ribbonCollapsed;
    button.setAttribute('aria-selected',String(selected));button.setAttribute('aria-expanded',String(expanded));button.setAttribute('tabindex',selected?'0':'-1');panel.hidden=!expanded;
    if(focus&&key===active)button.focus();
  }
  if(ribbonCollapsed||active==='references')setDiscoveryOptionsOpen(false);
}
function initDiscoveryControls() {
  const popup=document.getElementById('discoveryOptionsPopup');
  for(const [key,suffix] of [['discovery','Discovery'],['references','References']]){
    const button=document.getElementById('ribbon'+suffix+'Tab');
    button?.addEventListener('click',()=>setRibbonTab(key,false,key===activeRibbonTab&&!ribbonCollapsed));
    button?.addEventListener('dblclick',()=>setRibbonTab(key,false,true));
    button?.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();setRibbonTab(event.key==='Home'?'discovery':event.key==='End'?'references':key==='discovery'?'references':'discovery',true);
    });
  }
  setRibbonTab(activeRibbonTab);
  document.getElementById('discoveryResultLimit')?.addEventListener('change',event=>{state.discoveryLimit=Number(event.currentTarget.value);discoveryOptionsChanged();});
  document.getElementById('discoveryResearchQuestion')?.addEventListener('input',event=>{state.discoveryResearchQuestion=event.currentTarget.value.slice(0,1000);scheduleAutosave();});
  document.getElementById('discoveryResearchQuestion')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();runDiscoveryPipeline();}});
  document.getElementById('discoveryStrictExcludeInput')?.addEventListener('change',event=>{state.discoveryStrictExclusions=parseSteerList(event.currentTarget.value,16);discoveryOptionsChanged();});
  for(const key of ['discoveryBridgeMode','discoveryAiTriage','discoveryFastEmbed','discoveryFullTextSearch'])document.getElementById(key)?.addEventListener('change',event=>{state[key]=event.currentTarget.checked;discoveryOptionsChanged();});
  document.getElementById('discoveryDiversify')?.addEventListener('change',event=>{state.discoveryDiversify=event.currentTarget.checked;discoveryOptionsChanged();});
  document.getElementById('discoveryViewResults')?.addEventListener('click',()=>{const run=state.discoveryLastRun;if(run)openDiscoveryModal(run.recommendations,run.seed,run.key);});
  document.getElementById('discoveryCancelSearch')?.addEventListener('click',()=>cancelDiscoverySearch());
  if(typeof initDiscoveryReview==='function')initDiscoveryReview();
  document.getElementById('ribbonDiscoverButton')?.addEventListener('click',()=>runDiscoveryPipeline());
  document.getElementById('discoveryOptionsButton').addEventListener('click',()=>setDiscoveryOptionsOpen(popup.hidden));
  for(const id of ['discoveryOptionsClose','discoveryOptionsDone'])document.getElementById(id).addEventListener('click',()=>setDiscoveryOptionsOpen(false,true));
  popup.querySelectorAll('[data-method]').forEach(button=>button.addEventListener('click',()=>{
    const key=discoveryMethodKeys[button.dataset.method];state.discoveryBranches={...discoveryConfiguration().branches,[key]:!discoveryConfiguration().branches[key]};discoveryOptionsChanged();
  }));
  popup.querySelectorAll('[data-depth]').forEach(button=>button.addEventListener('click',()=>{state.discoveryDepth=button.dataset.depth;discoveryOptionsChanged();}));
  popup.querySelectorAll('[data-search-source]').forEach(button=>button.addEventListener('click',()=>{
    const key=button.dataset.searchSource;state.discoverySearchSources={...discoveryConfiguration().searchSources,[key]:!discoveryConfiguration().searchSources[key]};discoveryOptionsChanged();
  }));
  popup.querySelectorAll('[data-special]').forEach(button=>button.addEventListener('click',()=>{
    const key=button.dataset.special==='recent'?'recommendationRecencyTilt':'recommendationImpactTilt';state[key]=state[key]>0?0:2;discoveryOptionsChanged();
  }));
  const fields={discoverySteerInput:'recommendationSteerKeywords',discoveryExcludeInput:'recommendationExcludeKeywords',discoveryGraphFocusInput:'graphSteerKeywords'};
  Object.entries(fields).forEach(([id,key])=>{
    const input=document.getElementById(id),commit=()=>{state[key]=parseSteerList(input.value,key==='recommendationExcludeKeywords'?16:12);input.value=state[key].join('; ');discoveryOptionsChanged(key==='graphSteerKeywords');};
    input.addEventListener('change',commit);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commit();}});
  });
  document.getElementById('discoveryKeywordOptions').addEventListener('toggle',event=>{state.recommendationSteerOpen=event.currentTarget.open;});
  syncDiscoveryControls();
}
