/* Search phrases, library tags, saved searches and a persistent reading queue. */
Object.assign(state, {discoverySearchTags:[], discoveryQueryMatch:'all', discoveryRankingMode:'fast', discoverySearchScope:'online',
  savedSearches:[], librarySearchTerms:null, readingQueueOnly:false});

function parseSearchQuery(query, tags=state.discoverySearchTags||[], match=state.discoveryQueryMatch||'all') {
  const clean=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim();
  const unique=values=>{const seen=new Set();return values.map(clean).filter(value=>{const key=value.toLowerCase();if(!value||seen.has(key))return false;seen.add(key);return true;});};
  let found=[], text=String(query||''), parts=[], buffer='', quoted=false, operators=new Set();
  text=text.replace(/(^|[^\p{L}\p{N}_])(?:#|tag:)(?:"([^"]+)"|([\p{L}\p{N}_][\p{L}\p{N}_.-]*))/giu,(_,prefix,phrase,word)=>{found.push(phrase||word);return prefix+' ';});
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){buffer+='"';i++;}else quoted=!quoted;continue;}
    const operator=!quoted&&[' AND ',' OR '].find(word=>text.startsWith(word,i));
    if(!quoted&&(',;\n'.includes(c)||operator)){parts.push(buffer);buffer='';if(operator){operators.add(operator.trim());i+=operator.length-1;}continue;}
    buffer+=c;
  }
  parts.push(buffer);
  const structured=Boolean(tags.length||found.length||/[,;\n"]/.test(query)||operators.size);
  const keywords=structured?unique(parts):[], selectedTags=unique([...tags,...found]);
  const error=quoted?'Close the quotation mark around your search phrase.':operators.size>1?'Choose All or Any instead of mixing AND and OR.':
    keywords.length+selectedTags.length>12?'Use up to 12 keyword phrases and tags.':
    [...keywords,...selectedTags].some(value=>value.length>120)?'Keep each search phrase or tag to 120 characters.':'';
  return {keywords,tags:selectedTags,match:operators.has('OR')?'any':match,structured,error};
}
function searchRequestOptions() {
  const terms=parseSearchQuery(state.discoveryResearchQuestion);
  return {rankingMode:state.discoveryRankingMode==='enhanced'?'enhanced':'fast',
    ...(terms.structured?{queryKeywords:terms.keywords,queryTags:terms.tags,queryMatch:terms.match}:{})};
}
function localSearchMatches(paper,terms) {
  if(!terms)return true;
  const normalize=value=>' '+(String(value||'').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]).join(' ')+' ';
  const haystack=normalize([paper.title,paper.abstract,paper.notes,...(paper.authors||[]),...(paper.paperKeywords||[]),...(paper.gemmaKeywords||[])].filter(Boolean).join(' '));
  const words=terms.keywords.length?terms.keywords:terms.plain?[terms.plain]:[];
  const tags=new Set([...(paper.userTags||[]),...(paper.tags||[]),...(paper.paperKeywords||[]),...(paper.gemmaKeywords||[])].map(value=>String(value).normalize('NFKC').toLocaleLowerCase().trim()));
  const tests=[...words.map(word=>haystack.includes(normalize(word))),...terms.tags.map(tag=>tags.has(tag.toLocaleLowerCase()))];
  return !tests.length|| (terms.match==='any'?tests.some(Boolean):tests.every(Boolean));
}
function researchLibraryFilter(paper) {
  return (!state.readingQueueOnly||paper.readingStatus==='to-read')&&localSearchMatches(paper,state.librarySearchTerms)&&(typeof PulseLibraryTools==='undefined'||PulseLibraryTools.matchesActive(paper));
}
function clearLibrarySearch() {
  state.librarySearchTerms=null;state.readingQueueOnly=false;
  if(state.libraryFeatures)state.libraryFeatures.activeCollectionId=null;
  renderPapers();renderResearchWorkflow();scheduleAutosave();
}
function runUnifiedSearch() {
  const input=document.getElementById('discoveryResearchQuestion');
  if(input)state.discoveryResearchQuestion=input.value.slice(0,1000);
  const terms=parseSearchQuery(state.discoveryResearchQuestion);
  if(terms.error){showToast(terms.error);return;}
  state.discoveryQueryMatch=terms.match;renderResearchWorkflow();
  if(state.discoverySearchScope==='library') {
    state.librarySearchTerms={...terms,plain:terms.structured?'':state.discoveryResearchQuestion.trim()};
    if(typeof setLibraryFullscreen==='function')setLibraryFullscreen(true);
    renderPapers();renderResearchWorkflow();scheduleAutosave();return;
  }
  return runConceptSearch();
}
function savedSearchConfig() {
  return {query:state.discoveryResearchQuestion.trim(),tags:[...(state.discoverySearchTags||[])],match:state.discoveryQueryMatch,
    rankingMode:state.discoveryRankingMode,scope:state.discoverySearchScope,sources:{...discoveryConfiguration().searchSources},limit:state.discoveryLimit};
}
function saveCurrentSearch() {
  const config=savedSearchConfig(), terms=parseSearchQuery(config.query,config.tags,config.match);
  if(terms.error){showToast(terms.error);return;}
  if(!config.query&&!config.tags.length){showToast('Enter keywords or choose tags first.');return;}
  if(state.savedSearches.filter(item=>!item.archived).length>=30){showToast('Keep up to 30 saved searches. Remove one to save another.');return;}
  const name=(document.getElementById('savedSearchName')?.value||config.query||config.tags.join(', ')).trim().slice(0,80);
  state.savedSearches.push({id:uid(),name,config,watching:false,seenKeys:[],baseline:false,createdAt:new Date().toISOString()});
  document.getElementById('savedSearchName').value='';scheduleAutosave();renderResearchWorkflow();showToast('Search saved.');
}
function loadSavedSearch(item) {
  const c=item.config;
  state.discoveryResearchQuestion=c.query||'';state.discoverySearchTags=[...(c.tags||[])];state.discoveryQueryMatch=c.match==='any'?'any':'all';
  state.discoveryRankingMode=c.rankingMode==='enhanced'?'enhanced':'fast';state.discoverySearchScope=c.scope==='library'?'library':'online';
  if(c.sources)state.discoverySearchSources={...c.sources};if(c.limit)state.discoveryLimit=c.limit;
  const input=document.getElementById('discoveryResearchQuestion');if(input)input.value=state.discoveryResearchQuestion;
  syncDiscoveryControls();renderResearchWorkflow();
}
function runSavedSearch(id,onlyNew=false) {
  const item=state.savedSearches.find(row=>row.id===id&&!row.archived);if(!item||state.discoveryLoading)return;
  loadSavedSearch(item);
  if(state.discoverySearchScope==='library')return runUnifiedSearch();
  return runDiscoveryPipeline({searchMode:'concept',query:state.discoveryResearchQuestion,savedSearchId:id,onlyNew});
}
function recordSavedSearchResults(records,request,data) {
  if(!request.savedSearchId)return records;
  const item=state.savedSearches.find(row=>row.id===request.savedSearchId&&!row.archived);if(!item||data.stoppedEarly)return records;
  if(!records.length&&Object.keys(data.errors||{}).length){item.checkError='Search sources unavailable; try again.';renderResearchWorkflow();return records;}
  const key=paper=>typeof discoveryPaperKey==='function'?discoveryPaperKey(paper):String(paper.doi||paper.paperId||paper.title||'').toLowerCase();
  const seen=new Set(item.seenKeys||[]), hadBaseline=item.baseline, fresh=records.filter(paper=>!seen.has(key(paper)));
  records.forEach(paper=>seen.add(key(paper)));
  item.seenKeys=[...seen].slice(-20000);item.baseline=true;item.lastChecked=new Date().toISOString();item.newCount=hadBaseline?fresh.length:0;item.checkError='';
  if(item.watching&&hadBaseline&&typeof PulseWatchlists!=='undefined')PulseWatchlists.capture(item,fresh);
  scheduleAutosave();renderResearchWorkflow();
  return request.onlyNew&&hadBaseline?fresh:records;
}
function restoreResearchWorkflow(data) {
  state.discoverySearchTags=Array.isArray(data.discoverySearchTags)?data.discoverySearchTags.filter(x=>typeof x==='string').slice(0,12):[];
  state.discoveryQueryMatch=data.discoveryQueryMatch==='any'?'any':'all';state.discoveryRankingMode=data.discoveryRankingMode==='enhanced'?'enhanced':'fast';
  state.discoverySearchScope=data.discoverySearchScope==='library'?'library':'online';state.readingQueueOnly=Boolean(data.readingQueueOnly);
  state.librarySearchTerms=data.librarySearchTerms&&typeof data.librarySearchTerms==='object'?{
    keywords:Array.isArray(data.librarySearchTerms.keywords)?data.librarySearchTerms.keywords.filter(x=>typeof x==='string').slice(0,12):[],
    tags:Array.isArray(data.librarySearchTerms.tags)?data.librarySearchTerms.tags.filter(x=>typeof x==='string').slice(0,12):[],
    plain:String(data.librarySearchTerms.plain||'').slice(0,1000),match:data.librarySearchTerms.match==='any'?'any':'all'}:null;
  state.savedSearches=(Array.isArray(data.savedSearches)?data.savedSearches:[]).filter(item=>item&&typeof item.id==='string'&&item.config&&typeof item.config==='object').slice(0,50).map(item=>({
    id:item.id.slice(0,80),name:String(item.name||'Saved search').slice(0,80),createdAt:item.createdAt,lastChecked:item.lastChecked,
    watching:Boolean(item.watching),archived:Boolean(item.archived),baseline:Boolean(item.baseline),newCount:Number(item.newCount)||0,
    frequency:['daily','weekly'].includes(item.frequency)?item.frequency:'manual',nextCheck:Number(item.nextCheck)||0,checkError:String(item.checkError||'').slice(0,300),
    seenKeys:(Array.isArray(item.seenKeys)?item.seenKeys:[]).filter(x=>typeof x==='string').slice(-20000),config:{
      query:String(item.config.query||'').slice(0,1000),tags:(Array.isArray(item.config.tags)?item.config.tags:[]).filter(x=>typeof x==='string').slice(0,12),
      match:item.config.match==='any'?'any':'all',rankingMode:item.config.rankingMode==='enhanced'?'enhanced':'fast',scope:item.config.scope==='library'?'library':'online',
      sources:Object.fromEntries(['semanticScholar','europePmc','core','arxiv'].map(k=>[k,item.config.sources?.[k]!==false])),limit:[50,100,200,500,1000,2000].includes(item.config.limit)?item.config.limit:200}}));
  renderResearchWorkflow();
}
function renderSearchTags() {
  const list=document.getElementById('searchTagChoices');if(!list)return;
  const filter=(document.getElementById('searchTagsFilter')?.value||'').trim().toLocaleLowerCase();
  const selected=new Set((state.discoverySearchTags||[]).map(x=>x.toLocaleLowerCase()));
  const known=typeof getLibraryAllTags==='function'?getLibraryAllTags():[];
  for(const tag of state.discoverySearchTags||[])if(!known.some(row=>row.tag.toLocaleLowerCase()===tag.toLocaleLowerCase()))known.unshift({tag,count:0});
  const visible=known.filter(row=>!filter||row.tag.toLocaleLowerCase().includes(filter)).slice(0,40);
  list.innerHTML=visible.map(({tag,count})=>`<label><input type="checkbox" data-search-tag="${escapeHtml(tag)}" ${selected.has(tag.toLocaleLowerCase())?'checked':''}><span>${escapeHtml(tag)}</span><small>${count}</small></label>`).join('')||'<p>No matching tags. Type #tag in the search box to use a new tag.</p>';
}
function renderResearchWorkflow() {
  const values={searchScopeSelect:state.discoverySearchScope,searchMatchSelect:state.discoveryQueryMatch,rankingModeSelect:state.discoveryRankingMode};
  for(const [id,value] of Object.entries(values)){const el=document.getElementById(id);if(el&&document.activeElement!==el)el.value=value;}
  const tags=document.getElementById('searchTagsLabel');if(tags)tags.textContent=state.discoverySearchTags.length?`Tags (${state.discoverySearchTags.length})`:'Tags';
  const selected=document.getElementById('searchSelectedTags');if(selected)selected.textContent=state.discoverySearchTags.join(' · ');
  const queue=document.getElementById('readingQueueToggle');if(queue){queue.setAttribute('aria-pressed',String(state.readingQueueOnly));queue.textContent=`To read (${state.papers.filter(paper=>paper.readingStatus==='to-read').length})`;}
  const clear=document.getElementById('clearResearchFilter');if(clear)clear.hidden=!state.librarySearchTerms&&!state.readingQueueOnly;
  const filterStatus=document.getElementById('researchFilterStatus');if(filterStatus)filterStatus.textContent=state.librarySearchTerms?'Search: '+[...(state.librarySearchTerms.keywords||[]),...(state.librarySearchTerms.tags||[]).map(t=>'#'+t),state.librarySearchTerms.plain||''].filter(Boolean).join(state.librarySearchTerms.match==='any'?' OR ':' + '):'';
  const list=document.getElementById('savedSearchList');if(!list)return;
  const active=state.savedSearches.filter(item=>!item.archived), archived=state.savedSearches.filter(item=>item.archived).slice(-5);
  list.innerHTML=active.map(item=>`<div class="saved-search-row"><button type="button" data-saved-load="${escapeHtml(item.id)}" title="Load search">${escapeHtml(item.name)}</button><small>${escapeHtml(item.checkError||(!item.baseline?'Not checked yet':item.newCount?`${item.newCount} new matches`:'No new matches'))}</small><div class="saved-search-actions"><label><input type="checkbox" data-saved-watch="${escapeHtml(item.id)}" ${item.watching?'checked':''}> Watch</label><button type="button" data-saved-run="${escapeHtml(item.id)}" ${state.discoveryLoading?'disabled':''}>${item.watching?'Check new':'Run'}</button><button type="button" data-saved-remove="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button></div></div>`).join('')||'<p>Save searches to return to the same keywords, tags and sources.</p>';
  list.innerHTML+=archived.map(item=>`<button type="button" data-saved-restore="${escapeHtml(item.id)}">Restore ${escapeHtml(item.name)}</button>`).join('');
  const status=document.getElementById('savedSearchCount');if(status)status.textContent=active.length?` (${active.length})`:'';
  if(typeof PulseWatchlists!=='undefined')PulseWatchlists.decorate();
}
function startTrendsTopicSearch(topic) {
  state.discoveryResearchQuestion='"'+String(topic).replace(/"/g,'""')+'"';state.discoverySearchTags=[];state.discoverySearchScope='online';
  if(typeof setTrendsVisible==='function')setTrendsVisible(false);
  const input=document.getElementById('discoveryResearchQuestion');if(input){input.value=state.discoveryResearchQuestion;input.focus();}
  renderResearchWorkflow();syncDiscoveryControls();showToast('Topic loaded. Search now, or save it as a watchlist.');
}
function initResearchWorkflow() {
  const root=document.getElementById('searchBuilder');if(!root)return;
  for(const [id,key] of [['searchScopeSelect','discoverySearchScope'],['searchMatchSelect','discoveryQueryMatch'],['rankingModeSelect','discoveryRankingMode']])
    document.getElementById(id).addEventListener('change',event=>{state[key]=event.target.value;syncDiscoveryControls();scheduleAutosave();renderResearchWorkflow();});
  document.getElementById('unifiedSearchButton').addEventListener('click',runUnifiedSearch);
  document.getElementById('searchTagsMenu').addEventListener('toggle',event=>{if(event.target.open)renderSearchTags();});
  document.getElementById('searchTagsFilter').addEventListener('input',renderSearchTags);
  document.getElementById('searchTagChoices').addEventListener('change',event=>{
    const tag=event.target.dataset.searchTag;if(!tag)return;
    if(event.target.checked&&state.discoverySearchTags.length>=12){event.target.checked=false;showToast('Choose up to 12 tags.');return;}
    state.discoverySearchTags=state.discoverySearchTags.filter(x=>x.toLocaleLowerCase()!==tag.toLocaleLowerCase());if(event.target.checked)state.discoverySearchTags.push(tag);
    renderResearchWorkflow();scheduleAutosave();
  });
  document.getElementById('saveCurrentSearch').addEventListener('click',saveCurrentSearch);
  document.getElementById('savedSearchList').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    const row=state.savedSearches.find(item=>item.id===Object.values(button.dataset)[0]);if(!row)return;
    if(button.dataset.savedLoad){loadSavedSearch(row);document.getElementById('discoveryResearchQuestion').focus();}
    if(button.dataset.savedRun)runSavedSearch(row.id,row.watching);
    if(button.dataset.savedRemove)row.archived=true;
    if(button.dataset.savedRestore)row.archived=false;
    renderResearchWorkflow();scheduleAutosave();
  });
  document.getElementById('savedSearchList').addEventListener('change',event=>{
    const row=state.savedSearches.find(item=>item.id===event.target.dataset.savedWatch);if(row){row.watching=event.target.checked;renderResearchWorkflow();scheduleAutosave();}
  });
  const bar=document.createElement('div');bar.className='research-library-tools';
  bar.innerHTML='<button id="readingQueueToggle" type="button" aria-pressed="false">To read</button><button id="clearResearchFilter" type="button" hidden>Clear filters</button><span id="researchFilterStatus" role="status"></span>';
  document.querySelector('.col-library-header')?.after(bar);
  document.getElementById('readingQueueToggle')?.addEventListener('click',()=>{state.readingQueueOnly=!state.readingQueueOnly;renderPapers();renderResearchWorkflow();scheduleAutosave();});
  document.getElementById('clearResearchFilter')?.addEventListener('click',clearLibrarySearch);
  renderResearchWorkflow();
}
document.addEventListener('DOMContentLoaded',initResearchWorkflow);
