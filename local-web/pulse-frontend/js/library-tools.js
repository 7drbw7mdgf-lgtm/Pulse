/* Rules, explicit duplicate review and the watchlist inbox are saved with the workspace. */
const PulseLibraryTools = (() => {
  state.libraryFeatures={collections:[],activeCollectionId:null,inbox:[],ignoredDuplicates:[]};
  let tab='collections',pair=null,editing=null,inboxLimit=50,inboxShowReviewed=false;
  const fields=['title','authors','year','date','journal','doi','pmid','pmcid','abstract','volume','issue','pages','publisher','url','fullTextUrl','readingStatus','relevance','language','publicationType'];
  const norm=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const keyFor=(a,b)=>[a,b].sort().join('|');
  function restore(value) {
    const data=value&&typeof value==='object'?value:{};
    state.libraryFeatures={collections:(Array.isArray(data.collections)?data.collections:[]).filter(c=>c&&typeof c.id==='string'&&c.terms&&Array.isArray(c.terms.keywords)&&Array.isArray(c.terms.tags)).slice(0,100),
      activeCollectionId:typeof data.activeCollectionId==='string'?data.activeCollectionId:null,
      inbox:(Array.isArray(data.inbox)?data.inbox:[]).filter(row=>row&&typeof row.id==='string'&&row.paper&&typeof row.paper.title==='string').slice(0,10000),
      ignoredDuplicates:(Array.isArray(data.ignoredDuplicates)?data.ignoredDuplicates:[]).filter(x=>typeof x==='string').slice(-10000)};
  }
  function collectionMatches(paper,rule) {
    if(!localSearchMatches(paper,rule.terms))return false;
    if(rule.status==='unread'&&paper.readingStatus==='read')return false;
    if(rule.status&&rule.status!=='unread'&&paper.readingStatus!==rule.status)return false;
    const year=Number(paper.year);
    return (!rule.yearFrom||year>=rule.yearFrom)&&(!rule.yearTo||year<=rule.yearTo);
  }
  function matchesActive(paper) {const rule=state.libraryFeatures.collections.find(c=>c.id===state.libraryFeatures.activeCollectionId);return !rule||collectionMatches(paper,rule);}
  function activate(id) {
    state.libraryFeatures.activeCollectionId=id||null;state.librarySearchTerms=null;state.readingQueueOnly=false;
    renderPapers();renderResearchWorkflow();refresh();scheduleAutosave();
  }
  function duplicatePairs() {
    const buckets=new Map(),out=[],seen=new Set(),ignored=new Set(state.libraryFeatures.ignoredDuplicates);
    for(const p of state.papers){
      const doi=normalizeDoi(p.doi||'').toLowerCase(),title=norm(p.title);
      const keys=[doi&&'doi:'+doi,p.pmid&&'pmid:'+p.pmid,title.length>15&&'title:'+title].filter(Boolean);
      for(const key of keys){const rows=buckets.get(key)||[];
        for(const other of rows.slice(0,30)){
          const identity=keyFor(other.id,p.id);if(seen.has(identity)||ignored.has(identity))continue;
          if(key.startsWith('title:')&&other.year&&p.year&&Math.abs(Number(other.year)-Number(p.year))>1)continue;
          seen.add(identity);out.push({a:other.id,b:p.id,reason:key.startsWith('doi:')?'Same DOI':key.startsWith('pmid:')?'Same PMID':'Same title; check versions and metadata'});
        }rows.push(p);buckets.set(key,rows);
      }
    }return out;
  }
  function refresh() {
    const select=document.getElementById('activeSmartCollection');
    if(select&&document.activeElement!==select){const key=JSON.stringify(state.libraryFeatures.collections.map(c=>[c.id,c.name]));if(select.dataset.options!==key){select.dataset.options=key;select.innerHTML='<option value="">All papers</option>'+state.libraryFeatures.collections.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');}select.value=state.libraryFeatures.activeCollectionId||'';}
    const inbox=document.getElementById('openWatchInbox');if(inbox)inbox.textContent=`New papers (${state.libraryFeatures.inbox.filter(row=>!row.reviewed).length})`;
  }
  function open(which='collections') {tab=which;pair=null;editing=null;const root=document.getElementById('libraryToolsDialog');root.showModal();renderDialog();}
  function renderDialog() {
    const root=document.getElementById('libraryToolsBody');if(!root)return;
    document.querySelectorAll('[data-library-tool-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.libraryToolTab===tab)));
    if(tab==='collections')renderCollections(root);else if(tab==='duplicates')renderDuplicates(root);else renderInbox(root);
  }
  function renderCollections(root) {
    const rule=state.libraryFeatures.collections.find(c=>c.id===editing);
    root.innerHTML=`<p>Collections update automatically as you import papers or change their tags, notes or reading status.</p><div class="collection-list">${state.libraryFeatures.collections.map(c=>`<div><button data-collection-use="${escapeHtml(c.id)}" type="button">${escapeHtml(c.name)} <small>${state.papers.filter(p=>collectionMatches(p,c)).length} papers</small></button><button data-collection-edit="${escapeHtml(c.id)}" type="button">Edit</button><button data-collection-remove="${escapeHtml(c.id)}" type="button">Remove rule</button></div>`).join('')||'<p>No smart collections yet.</p>'}</div>
      <h3>${rule?'Edit collection':'New collection'}</h3><form id="smartCollectionForm" class="tool-form"><label>Name<input id="collectionName" required maxlength="80" value="${escapeHtml(rule?.name||'')}"></label><label>Keywords or phrases, separated by commas<input id="collectionQuery" maxlength="1000" placeholder="Campylobacter, oxidative stress" value="${escapeHtml(rule?.query||'')}"></label><label>Tags, separated by commas<input id="collectionTags" value="${escapeHtml((rule?.terms.tags||[]).join(', '))}"></label><label>Match<select id="collectionMatch"><option value="all">All rules</option><option value="any">Any keyword or tag</option></select></label><label>Reading status<select id="collectionStatus"><option value="">Any status</option><option value="unread">Not read</option><option value="to-read">To read</option><option value="reading">Reading</option><option value="read">Read</option></select></label><label>Published from<input id="collectionYearFrom" type="number" min="1500" max="2200" value="${rule?.yearFrom||''}"></label><label>Published through<input id="collectionYearTo" type="number" min="1500" max="2200" value="${rule?.yearTo||''}"></label><p id="collectionFormError" role="alert"></p><button type="submit">${rule?'Save rule':'Create collection'}</button>${rule?'<button id="collectionCancelEdit" type="button">Cancel edit</button>':''}</form>`;
    document.getElementById('collectionMatch').value=rule?.terms.match||'all';document.getElementById('collectionStatus').value=rule?.status||'';
    document.getElementById('smartCollectionForm').onsubmit=event=>{
      event.preventDefault();const get=id=>document.getElementById(id).value;
      const query=get('collectionQuery'),tags=get('collectionTags').split(/[,;]+/).map(x=>x.trim()).filter(Boolean),terms=parseSearchQuery(query.replace(/\s+\+\s+/g,','),tags,get('collectionMatch'));
      if(!terms.structured)terms.plain=query.trim();
      const yearFrom=Number(get('collectionYearFrom'))||null,yearTo=Number(get('collectionYearTo'))||null;
      if(terms.error||(yearFrom&&yearTo&&yearFrom>yearTo)){document.getElementById('collectionFormError').textContent=terms.error||'The first year must be before the last year.';return;}
      const value={id:rule?.id||uid(),name:get('collectionName').trim(),query,terms,status:get('collectionStatus'),yearFrom,yearTo};
      if(!value.name)return;
      if(rule)Object.assign(rule,value);else state.libraryFeatures.collections.push(value);
      editing=null;scheduleAutosave();refresh();renderCollections(root);renderPapers();
    };
    root.querySelectorAll('[data-collection-use]').forEach(button=>button.onclick=()=>{activate(button.dataset.collectionUse);document.getElementById('libraryToolsDialog').close();if(els.colLibrary.classList.contains('is-swiped-hidden'))document.getElementById('railLibraryBtn').click();});
    root.querySelectorAll('[data-collection-edit]').forEach(button=>button.onclick=()=>{editing=button.dataset.collectionEdit;renderCollections(root);});
    root.querySelectorAll('[data-collection-remove]').forEach(button=>button.onclick=()=>{const id=button.dataset.collectionRemove;state.libraryFeatures.collections=state.libraryFeatures.collections.filter(c=>c.id!==id);if(state.libraryFeatures.activeCollectionId===id)activate(null);scheduleAutosave();refresh();renderCollections(root);});
    document.getElementById('collectionCancelEdit')?.addEventListener('click',()=>{editing=null;renderCollections(root);});
  }
  function renderDuplicates(root) {
    const pairs=duplicatePairs();
    if(pair&&!pairs.some(p=>p.a===pair.a&&p.b===pair.b))pair=null;
    pair ||= pairs[0];
    root.innerHTML=`<p>Review suspected duplicates before merging. Notes, tags, PDF annotations and map membership are combined. Recovery preserves both original records.</p><div class="duplicate-layout"><div class="duplicate-pairs">${pairs.slice(0,100).map((p,i)=>`<button type="button" data-duplicate-pair="${i}" aria-pressed="${pair?.a===p.a&&pair?.b===p.b}">${escapeHtml(state.papers.find(row=>row.id===p.a)?.title)}<small>${escapeHtml(p.reason)}</small></button>`).join('')||'<p>No suspected duplicates.</p>'}</div><div id="duplicateComparison"></div></div><p id="duplicateResult" role="status"></p><button id="undoDuplicateMerge" type="button" ${state.libraryUndoId?'':'disabled'}>Undo last library change</button>`;
    root.querySelectorAll('[data-duplicate-pair]').forEach(button=>button.onclick=()=>{pair=pairs[Number(button.dataset.duplicatePair)];renderDuplicates(root);});
    document.getElementById('undoDuplicateMerge').onclick=async()=>{await restoreLibraryRecovery(state.libraryUndoId);pair=null;renderDuplicates(root);};
    if(!pair)return;
    const a=state.papers.find(p=>p.id===pair.a),b=state.papers.find(p=>p.id===pair.b),table=document.getElementById('duplicateComparison');
    table.innerHTML=`<p class="duplicate-warning">${a.doi&&b.doi&&normalizeDoi(a.doi).toLowerCase()!==normalizeDoi(b.doi).toLowerCase()?'These records have different DOIs. They may be different versions or different papers.':''}</p><form id="duplicateMergeForm"><table class="duplicate-table"><thead><tr><th>Keep</th>${[a,b].map((p,i)=>`<th><label><input type="radio" name="mergeMaster" value="${escapeHtml(p.id)}" ${i===0?'checked':''}>Record ${i+1}</label></th>`).join('')}</tr></thead><tbody>${fields.filter(field=>a[field]||b[field]).map(field=>`<tr><th>${escapeHtml(({title:'Title',authors:'Authors',year:'Year',date:'Publication date',journal:'Journal',doi:'DOI',pmid:'PMID',pmcid:'PMCID',abstract:'Abstract',volume:'Volume',issue:'Issue',pages:'Pages',publisher:'Publisher',url:'Paper link',fullTextUrl:'Full text',readingStatus:'Reading status',relevance:'Relevance',language:'Language',publicationType:'Publication type'})[field]||field)}</th>${[a,b].map((p,i)=>`<td><label><input type="radio" name="merge-${field}" value="${escapeHtml(p.id)}" ${(a[field]?i===0:i===1)?'checked':''}><span>${escapeHtml(Array.isArray(p[field])?p[field].join('; '):String(p[field]||'—'))}</span></label></td>`).join('')}</tr>`).join('')}<tr><th>Notes (combined)</th><td>${escapeHtml(a.notes||'—')}</td><td>${escapeHtml(b.notes||'—')}</td></tr><tr><th>Tags / maps (combined)</th><td>${escapeHtml([...(a.userTags||[]),...(a.mapIds||[])].join(', '))}</td><td>${escapeHtml([...(b.userTags||[]),...(b.mapIds||[])].join(', '))}</td></tr></tbody></table><div class="tool-form"><button id="confirmDuplicateMerge" type="submit">Merge these records</button><button id="dismissDuplicatePair" type="button">Keep separate</button></div></form>`;
    document.getElementById('dismissDuplicatePair').onclick=()=>{state.libraryFeatures.ignoredDuplicates.push(keyFor(a.id,b.id));pair=null;scheduleAutosave();renderDuplicates(root);};
    document.getElementById('duplicateMergeForm').onsubmit=async event=>{
      event.preventDefault();const form=new FormData(event.target),keepId=form.get('mergeMaster'),choices=Object.fromEntries(fields.filter(field=>form.has('merge-'+field)).map(field=>[field,form.get('merge-'+field)]));
      const button=document.getElementById('confirmDuplicateMerge');button.disabled=true;
      try{const result=await libraryMutationRequest('/api/library/merge',{keepId,otherId:keepId===a.id?b.id:a.id,choices,workspace:serializeMap()});applyRecoveredWorkspace(result.workspace);pair=null;renderDuplicates(root);document.getElementById('duplicateResult').textContent='Merged. Use Undo to restore the original records.';}
      catch(error){document.getElementById('duplicateResult').textContent=error.message;button.disabled=false;}
    };
  }
  function renderInbox(root) {
    const rows=state.libraryFeatures.inbox.filter(row=>inboxShowReviewed||!row.reviewed);
    root.innerHTML=`<p>New candidates from your saved watchlists. Add a candidate to your library or dismiss it. Daily and weekly checks run only while Pulse is open; configure them in Saved searches.</p><p>${state.libraryFeatures.inbox.filter(row=>!row.reviewed).length} awaiting review</p><div class="watch-inbox">${rows.slice(0,inboxLimit).map(row=>`<article><h3>${escapeHtml(row.paper.title)}</h3><small>${escapeHtml(row.searchName)} · ${escapeHtml(row.paper.year||'')} · ${escapeHtml(new Date(row.foundAt).toLocaleDateString())}</small><details><summary>Abstract</summary><p>${escapeHtml(row.paper.abstract||'No abstract supplied.')}</p></details><button type="button" data-inbox-add="${escapeHtml(row.id)}">Add to Library</button><button type="button" data-inbox-dismiss="${escapeHtml(row.id)}">Dismiss</button></article>`).join('')||'<p>Your inbox is clear.</p>'}</div>${rows.length>inboxLimit?'<button id="inboxShowMore" type="button">Show more</button>':''}`;
    const history=document.createElement('label');history.className='watch-history-toggle';history.innerHTML='<input type="checkbox"> Include reviewed candidates';history.querySelector('input').checked=inboxShowReviewed;history.querySelector('input').onchange=event=>{inboxShowReviewed=event.target.checked;renderInbox(root);};root.prepend(history);
    root.querySelectorAll('[data-inbox-add]').forEach(button=>button.onclick=()=>{
      const row=state.libraryFeatures.inbox.find(r=>r.id===button.dataset.inboxAdd);
      if(!row)return;
      if(!state.papers.some(p=>paperIdentityKey(p)===paperIdentityKey(row.paper))){const paper=normalizeImportedPaper({...row.paper,id:uid(),mapIds:[],mapId:'',selected:false,readingStatus:'to-read'},'Watchlist');state.papers.push(paper);}
      row.reviewed=true;row.action='added';scheduleAutosave();render();renderInbox(root);
    });
    root.querySelectorAll('[data-inbox-dismiss]').forEach(button=>button.onclick=()=>{const row=state.libraryFeatures.inbox.find(r=>r.id===button.dataset.inboxDismiss);if(row){row.reviewed=true;row.action='dismissed';scheduleAutosave();refresh();renderInbox(root);}});
    if(inboxShowReviewed)root.querySelectorAll('[data-inbox-dismiss]').forEach(button=>{const row=state.libraryFeatures.inbox.find(r=>r.id===button.dataset.inboxDismiss);if(row?.reviewed){button.textContent='Return to inbox';button.onclick=()=>{row.reviewed=false;row.action='';scheduleAutosave();refresh();renderInbox(root);};}});
    document.getElementById('inboxShowMore')?.addEventListener('click',()=>{inboxLimit+=50;renderInbox(root);});
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const tools=document.createElement('div');tools.className='library-organise-tools';tools.innerHTML='<select id="activeSmartCollection" aria-label="Smart collection"><option value="">All papers</option></select><button id="openSmartCollections" type="button">Collections</button><button id="openDuplicateReview" type="button">Duplicates</button><button id="openWatchInbox" type="button">New papers (0)</button>';
    document.querySelector('.library-search-filter').before(tools);
    document.getElementById('activeSmartCollection').onchange=event=>activate(event.target.value);
    document.getElementById('openSmartCollections').onclick=()=>open('collections');document.getElementById('openDuplicateReview').onclick=()=>open('duplicates');document.getElementById('openWatchInbox').onclick=()=>open('inbox');
    const root=document.createElement('dialog');root.id='libraryToolsDialog';root.className='pulse-tool-dialog library-tools-dialog';
    root.innerHTML='<header><h2>Library tools</h2><button id="closeLibraryTools" type="button" aria-label="Close library tools">×</button></header><nav class="library-tool-tabs" aria-label="Library tools"><button type="button" data-library-tool-tab="collections">Smart collections</button><button type="button" data-library-tool-tab="duplicates">Duplicate review</button><button type="button" data-library-tool-tab="inbox">New papers</button></nav><div id="libraryToolsBody"></div>';
    document.body.append(root);document.getElementById('closeLibraryTools').onclick=()=>root.close();root.querySelectorAll('[data-library-tool-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.libraryToolTab;renderDialog();});refresh();
  });
  return {restore,matchesActive,collectionMatches,duplicatePairs,refresh,open};
})();

const PulseWatchlists = (() => {
  let busy=false;
  const periods={daily:86400000,weekly:604800000};
  function capture(item,records) {
    const inbox=state.libraryFeatures.inbox,keys=new Set(inbox.map(row=>row.key)),missed=new Set();
    for(const paper of records){const key=discoveryPaperKey(paper);if(keys.has(key)||state.papers.some(p=>paperIdentityKey(p)===paperIdentityKey(paper)))continue;
      if(inbox.length>=10000){const old=inbox.findIndex(row=>row.reviewed);if(old>=0)inbox.splice(old,1);else{item.frequency='manual';item.checkError='Inbox has 10,000 unreviewed candidates. Review some before resuming automatic checks.';missed.add(key);continue;}}
      const candidate=Object.fromEntries(['title','doi','pmid','pmcid','s2PaperId','openAlexId','year','journal','url','fullTextUrl','citationCount','citedByCount','source'].filter(field=>paper[field]!==undefined).map(field=>[field,paper[field]]));
      candidate.abstract=String(paper.abstract||'').slice(0,12000);candidate.authors=(paper.authors||[]).slice(0,100);candidate.paperKeywords=(paper.paperKeywords||paper.keywords||[]).slice(0,50);
      inbox.push({id:uid(),key,paper:candidate,searchId:item.id,searchName:item.name,foundAt:new Date().toISOString(),reviewed:false});keys.add(key);
    }
    scheduleAutosave();PulseLibraryTools.refresh();
    if(missed.size)item.seenKeys=(item.seenKeys||[]).filter(key=>!missed.has(key));
    return missed;
  }
  async function request(path,body,signal) {const response=await fetch(backendUrl(path),{method:body?'POST':'GET',headers:apiHeaders(body?{'Content-Type':'application/json'}:{}),...(body?{body:JSON.stringify(body)}:{}),signal});const data=await response.json();if(!response.ok)throw Error(data.error||'Watchlist request failed.');return data;}
  async function check(item,now=Date.now()) {
    if(busy||state.discoveryLoading||state.libraryMutation||!state.autosaveReady||item.archived)return false;
    busy=true;let jobId=null;const epoch=state.syncEpoch||0;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);item.checkError='';
    try{
      const config=item.config,terms=parseSearchQuery(config.query,config.tags,config.match);
      if(terms.error)throw Error(terms.error);
      if(!Object.values(config.sources||{}).some(Boolean))throw Error('Choose at least one search source for this watchlist.');
      let data=await request('/api/discovery/start',{searchMode:'concept',query:config.query,seedPapers:[],limit:Math.min(200,config.limit||200),rankingMode:'fast',...(terms.structured?{queryKeywords:terms.keywords,queryTags:terms.tags,queryMatch:terms.match}:{}),
        branches:{citationGraph:false,citationNetwork:false,citationCoCitation:false,semanticSearch:false,lexicalSearch:true},searchSources:config.sources,fastEmbed:true},controller.signal);
      jobId=data.id;
      while(data.status==='running'&&jobId){await new Promise(resolve=>setTimeout(resolve,1000));data=await request('/api/discovery/jobs/'+encodeURIComponent(jobId),null,controller.signal);}
      if(data.status==='failed'||data.status==='cancelled'||(!data.recommendations?.length&&Object.keys(data.errors||{}).length))throw Error(data.error||'Search sources were unavailable. The previous baseline is retained.');
      if(item.archived||!item.watching||state.libraryMutation||(state.syncEpoch||0)!==epoch||!state.savedSearches.includes(item))return false;
      const seen=new Set(item.seenKeys||[]),fresh=(data.recommendations||[]).filter(p=>!seen.has(discoveryPaperKey(p)));
      const missed=capture(item,fresh);for(const paper of data.recommendations||[])if(!missed.has(discoveryPaperKey(paper)))seen.add(discoveryPaperKey(paper));
      item.seenKeys=[...seen].slice(-20000);item.baseline=true;item.newCount=fresh.length;item.lastChecked=new Date(now).toISOString();
      if(Object.keys(data.errors||{}).length)item.checkError='Partial check: '+Object.keys(data.errors).join(', ')+'. Available results were kept.';
      item.nextCheck=now+(periods[item.frequency]||periods.daily);
    }catch(error){item.checkError=error.name==='AbortError'?'Check timed out; previous results retained.':error.message;item.nextCheck=now+3600000;
      if(jobId)request('/api/discovery/cancel',{id:jobId}).catch(()=>{});
    }finally{clearTimeout(timer);busy=false;scheduleAutosave();renderResearchWorkflow();PulseLibraryTools.refresh();}
    return true;
  }
  function tick(now=Date.now()) {
    if(busy||navigator.onLine===false)return;
    const item=state.savedSearches.find(row=>row.watching&&!row.archived&&row.config.scope!=='library'&&periods[row.frequency]&&(row.nextCheck||0)<=now);
    if(item)return check(item,now);
  }
  function decorate() {
    const list=document.getElementById('savedSearchList');if(!list)return;
    for(const row of state.savedSearches.filter(item=>!item.archived)){
      const card=[...list.querySelectorAll('[data-saved-load]')].find(el=>el.dataset.savedLoad===row.id)?.closest('.saved-search-row');if(!card)continue;
      const label=document.createElement('label');label.className='watch-frequency';label.innerHTML='Check <select aria-label="Watchlist schedule"><option value="manual">Manually</option><option value="daily">Daily while open</option><option value="weekly">Weekly while open</option></select>';
      const select=label.querySelector('select');select.value=row.frequency||'manual';select.disabled=!row.watching||row.config.scope==='library';select.onchange=()=>{row.frequency=select.value;row.nextCheck=Date.now();scheduleAutosave();};card.append(label);
      const status=document.createElement('small');status.textContent=row.frequency&&row.frequency!=='manual'?`Next check: ${row.nextCheck?new Date(row.nextCheck).toLocaleString():'when Pulse is idle'} · candidates go to New papers`:'';card.append(status);
    }
  }
  document.addEventListener('DOMContentLoaded',()=>{setTimeout(()=>tick(),30000);setInterval(()=>tick(),60000);});
  return {capture,check,tick,decorate};
})();
