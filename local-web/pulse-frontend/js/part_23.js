// Citation provenance and library-manager connections.
const metricRequests = new Map();
const relationUi = {paper:null, kind:'citations', source:null, items:[], next:0, unresolved:0, complete:false, busy:false, generation:0, limit:100};
const managerUi = {status:null, busy:false, connecting:false, timer:null};
const relationDialog = document.getElementById('paperRelationsDialog');
const managerDialog = document.getElementById('libraryManagersDialog');

function metricValue(value) { return Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—'; }
function metricsForPaper(paper) {
  const metrics=paper.citationMetrics;
  if(!metrics) return null;
  if(paper.doi && normalizeDoi(paper.doi).toLowerCase()!==normalizeDoi(metrics.doi || '').toLowerCase()) return null;
  if(!paper.doi && String(metrics.matchedTitle || '').trim().toLowerCase()!==String(paper.title || '').trim().toLowerCase()) return null;
  return metrics;
}
function paperCitationCount(paper) { const value=metricsForPaper(paper)?.citationCount; return Number.isFinite(value) ? value : null; }
function metricKey(paper) {return JSON.stringify([paper.id,paper.doi,paper.title,paper.year,paper.authors]);}
function metricsStatusText(paper) {
  const current=metricRequests.get(metricKey(paper));
  const metrics=metricsForPaper(paper);
  const note=current?.error ? `<span>${escapeHtml(current.error)}</span>` : current?.busy ? '<span>Checking the paper record…</span>' : '';
  if (!metrics) return note || 'Citation data has not been checked. Missing values are shown as —.';
  const date=new Date(metrics.checkedAt);
  return `<a href="${escapeHtml(safePaperUrl(metrics.sourceUrl))}" target="_blank" rel="noreferrer">${escapeHtml(metrics.source)}</a> · ${Number.isNaN(date.valueOf()) ? 'Previously checked' : 'Checked ' + escapeHtml(date.toLocaleString())}<br><span>Provider counts; coverage differs between indexes. Average per year is calculated from publication year.</span>${note}`;
}
function safePaperUrl(url) {
  try {const parsed=new URL(url); return ['https:','http:'].includes(parsed.protocol) ? parsed.href : '#';} catch (_) {return '#';}
}
async function pulseRecordsRequest(path, payload, signal) {
  await backendReady;
  const response=await fetch(backendUrl(path), {headers:apiHeaders(payload ? {'Content-Type':'application/json'} : {}),
    ...(payload ? {method:'POST',body:JSON.stringify(payload)} : {}), signal:signal || AbortSignal.timeout(120000)});
  const data=await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}
async function refreshPaperMetrics(paper, force=false) {
  const key=metricKey(paper);
  if (metricRequests.get(key)?.busy || (!force && metricRequests.has(key))) return;
  if (!force && metricsForPaper(paper) && Date.now()-Date.parse(paper.citationMetrics.checkedAt)<300000) return;
  const request={busy:true,error:''}; metricRequests.set(key,request);
  try {
    const result=await pulseRecordsRequest('/api/papers/metrics', {paper:citationPaperPayloadWithAuthors(paper), refresh:force});
    if (!state.papers.includes(paper) || key!==metricKey(paper)) return;
    paper.citationMetrics=result.metrics;
    paper.citedByCount=result.metrics.citationCount;
    if (result.metrics.source==='Semantic Scholar') paper.s2PaperId=result.metrics.identifier;
    scheduleAutosave();
  } catch(error) {request.error=error.message;}
  finally {
    request.busy=false;
    if (state.selectedId===paper.id) renderDetails();
    renderPapers();
  }
}
function citationPaperPayloadWithAuthors(paper) {
  return {...citationPaperPayload(paper), authors:paperAuthors(paper), year:paper.year || '', journal:paper.journal || ''};
}

function updateRelations() {
  const q=document.getElementById('relationFilter').value.trim().toLowerCase();
  const visible=relationUi.items.map((paper,index)=>({paper,index})).filter(({paper})=>(paper.title+' '+paper.authors.join(' ')+' '+paper.year+' '+paper.doi).toLowerCase().includes(q));
  const differentTotal=Number.isFinite(relationUi.reportedTotal) && Number.isFinite(relationUi.total) && relationUi.reportedTotal!==relationUi.total;
  document.getElementById('relationCoverage').textContent=`${relationUi.source || 'Checking source'} · ${relationUi.items.length.toLocaleString()} listed${Number.isFinite(relationUi.total) ? ' / '+relationUi.total.toLocaleString()+(differentTotal ? ' in list index' : ' indexed') : ''}${differentTotal ? ' · Paper record reports '+relationUi.reportedTotal.toLocaleString()+' '+relationUi.kind : ''} · ${relationUi.complete ? 'All available pages loaded' : 'Partial list'}${relationUi.unresolved ? ' · '+relationUi.unresolved+' unresolved records' : ''}`;
  document.getElementById('relationNote').textContent='Citations are papers that cite this work. References are papers this work cites. A provider’s paper counter can differ from its list index and retrievable records; coverage is reported separately and missing records are not invented.';
  document.getElementById('relationList').innerHTML=visible.slice(0,relationUi.limit).map(({paper,index})=>`<li><div><a href="${escapeHtml((typeof paperOpenUrl === 'function' ? paperOpenUrl(paper) : '') || safePaperUrl(paper.url || (paper.doi ? 'https://doi.org/'+paper.doi : '#')))}" target="_blank" rel="noreferrer">${escapeHtml(paper.title)}</a><p>${escapeHtml(paper.authors.join(', '))} · ${escapeHtml(paper.year || 'No year')}${paper.journal ? ' · '+escapeHtml(paper.journal) : ''}</p>${paper.doi ? '<small>DOI '+escapeHtml(paper.doi)+'</small>' : ''}${paper.isInfluential ? '<small> · Influential citation (Semantic Scholar)</small>' : ''}</div><button data-relation-add="${index}" class="inspector-btn secondary" type="button">Add to Pulse</button></li>`).join('') || '<li>No matching records loaded.</li>';
  document.getElementById('relationList').querySelectorAll('[data-relation-add]').forEach(button=>button.addEventListener('click',()=>{
    const paper=relationUi.items[Number(button.dataset.relationAdd)];
    const result=addParsedPapers([normalizeImportedPaper(paper,relationUi.source)]); render(); showToast(result.added ? 'Added paper to Pulse.' : 'Paper already in Pulse.');
  }));
  document.getElementById('relationMoreVisible').hidden=visible.length<=relationUi.limit;
  for (const id of ['relationLoadNext','relationLoadAll']) {const button=document.getElementById(id);button.disabled=relationUi.busy || relationUi.complete;}
  document.getElementById('relationStop').hidden=!relationUi.busy;
  document.getElementById('relationExport').disabled=!relationUi.items.length;
}
async function openPaperRelations(paper,kind,source=null) {
  relationUi.controller?.abort();
  Object.assign(relationUi,{paper,kind,source:source || paper.citationMetrics?.source || null,items:[],next:0,cursorPaging:false,unresolved:0,complete:false,busy:false,total:null,reportedTotal:null,limit:100,generation:relationUi.generation+1});
  document.getElementById('relationProvider').value=relationUi.source || '';
  document.getElementById('relationFilter').value='';
  document.getElementById('relationError').textContent='';
  document.getElementById('relationTitle').textContent=(kind==='citations' ? 'Citing papers' : 'References')+' — '+paper.title;
  if (!relationDialog.open) relationDialog.showModal();
  updateRelations(); await loadRelations(false);
}
async function loadRelations(all=false) {
  if (relationUi.busy || relationUi.complete) return;
  const generation=relationUi.generation;
  relationUi.busy=true;relationUi.controller=new AbortController();
  const signal=relationUi.controller.signal;
  document.getElementById('relationError').textContent=''; updateRelations();
  try {
    do {
      const payload={paper:citationPaperPayloadWithAuthors(relationUi.paper),kind:relationUi.kind,source:relationUi.source};
      if (relationUi.cursorPaging) payload.cursor=relationUi.next; else payload.offset=relationUi.next;
      const page=await pulseRecordsRequest('/api/papers/relations',payload,signal);
      if (generation!==relationUi.generation || signal.aborted) return;
      const seen=new Set(relationUi.items.map(p=>p.s2PaperId || p.openAlexId || p.doi || p.title));
      for (const item of page.items) {const key=item.s2PaperId || item.openAlexId || item.doi || item.title; if (!seen.has(key)) {seen.add(key);relationUi.items.push(item);}}
      Object.assign(relationUi,{source:page.source,next:page.next,cursorPaging:page.cursorPaging,total:page.total,reportedTotal:page.reportedTotal,complete:page.complete});
      relationUi.unresolved+=page.unresolved;
      updateRelations();
      if (all && !page.complete) await new Promise(resolve=>setTimeout(resolve,1100));
    } while(all && !relationUi.complete && !signal.aborted);
  } catch(error) {if (generation===relationUi.generation && !signal.aborted) document.getElementById('relationError').textContent=error.message;}
  finally {if(generation===relationUi.generation) {relationUi.busy=false;updateRelations();}}
}
function downloadRecordFile(name,text,type) {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function recordRis(records) {
  const clean=v=>String(v || '').replace(/[\r\n]+/g,' ');
  return records.map(p=>['TY  - '+({book:'BOOK','proceedings-article':'CONF',dissertation:'THES'}[p.publicationType] || 'JOUR'),'TI  - '+clean(p.title),...paperAuthors(p).map(a=>'AU  - '+clean(a)),
    ...[['PY','year'],['DA','date'],['JO','journal'],['DO','doi'],['VL','volume'],['IS','issue'],['PB','publisher'],['LA','language']].filter(([_,key])=>p[key]).map(([tag,key])=>tag+'  - '+clean(p[key])),...(p.pages ? ['SP  - '+clean(p.pages.split(/[-–—]+/)[0]), ...(p.pages.split(/[-–—]+/)[1] ? ['EP  - '+clean(p.pages.split(/[-–—]+/)[1])] : [])] : p.articleNumber ? ['SP  - '+clean(p.articleNumber)] : []), ...[...String(p.issn || p.isbn || '').split(/;\s*/)].filter(Boolean).map(v=>'SN  - '+clean(v)), ...(p.url || p.doi ? ['UR  - '+clean(p.url || 'https://doi.org/'+p.doi)] : []), ...(p.pmid ? ['AN  - PMID:'+clean(p.pmid)] : []), ...(p.abstract ? ['AB  - '+clean(p.abstract)] : []),...(p.paperKeywords || []).map(k=>'KW  - '+clean(k)),'ER  - '].join('\n')).join('\n\n')+'\n';
}
document.getElementById('relationClose').addEventListener('click',()=>relationDialog.close());
relationDialog.addEventListener('close',()=>relationUi.controller?.abort());
document.getElementById('relationFilter').addEventListener('input',()=>{relationUi.limit=100;updateRelations();});
document.getElementById('relationLoadNext').addEventListener('click',()=>loadRelations());
document.getElementById('relationLoadAll').addEventListener('click',()=>loadRelations(true));
document.getElementById('relationProvider').addEventListener('change',event=>openPaperRelations(relationUi.paper,relationUi.kind,event.target.value));
document.getElementById('relationStop').addEventListener('click',()=>relationUi.controller?.abort());
document.getElementById('relationMoreVisible').addEventListener('click',()=>{relationUi.limit+=100;updateRelations();});
document.getElementById('relationExport').addEventListener('click',async()=>{
  await preparePaperExport(relationUi.items);
  const format=document.getElementById('relationExportFormat').value;
  const name=`pulse-${relationUi.kind}-${relationUi.complete ? 'available' : 'partial'}`;
  if(format==='ris') downloadRecordFile(name+'.ris',recordRis(relationUi.items),'text/plain');
  else if(format==='csv') {const fields=['title','authors','year','date','journal','doi','volume','issue','pages','articleNumber','publisher','issn','isbn','url','abstract'];const quote=v=>'"'+String(v ?? '').replaceAll('"','""')+'"';
    downloadRecordFile(name+'.csv',[fields.join(','),...relationUi.items.map(p=>fields.map(k=>quote(k==='authors' ? p.authors.join('; ') : p[k])).join(','))].join('\n'),'text/csv');}
  else downloadRecordFile(name+'.json',JSON.stringify({paper:relationUi.paper.title,kind:relationUi.kind,source:relationUi.source,indexedTotal:relationUi.total,reportedPaperTotal:relationUi.reportedTotal,complete:relationUi.complete,unresolved:relationUi.unresolved,papers:relationUi.items},null,2),'application/json');
});

function managerSelectedPapers() {
  const scope=document.getElementById('managerScope').value;
  if(scope==='bulk') return libraryBulkPapers();
  if(scope==='all') return state.papers;
  if(scope==='relations') return relationUi.items;
  if(scope==='discoveries') return selectedDiscoveryPapers().map(p=>p.paper || p);
  return state.papers.filter(p=>p.id===state.selectedId);
}
function updateManagers() {
  for(const provider of ['zotero','mendeley']) {
    const info=managerUi.status?.[provider];
    const label=provider==='zotero' ? 'Zotero' : 'Mendeley';
    const pillStatus=info?.connected ? 'Connected' : provider==='mendeley' && !info?.configured ? 'Export citations' : info?.label || 'Check connection';
    document.getElementById(provider+'PillStatus').textContent=pillStatus;
    const pill=document.getElementById(provider+'Pill');
    pill.title=`${label} · ${pillStatus}`;
    pill.classList.toggle('is-connected',Boolean(info?.connected));
    document.getElementById(provider+'PillStatus').classList.toggle('is-connected',Boolean(info?.connected));
    document.getElementById(provider+'ConnectionNote').textContent=info?.connected ? label+' · '+info.destination : info?.message || (provider==='zotero' ? 'Open Zotero Desktop to connect locally.' : info?.pending ? 'Finish signing in with Mendeley, then return here.' : info?.configured ? 'Sign in to connect your Mendeley library.' : 'Direct sign-in is awaiting Pulse service activation. You can export citations for Mendeley now.');
    document.getElementById(provider+'Send').disabled=managerUi.busy || (provider==='zotero' && !info?.connected) || !managerSelectedPapers().length;
  }
  const count=managerSelectedPapers().length;
  document.getElementById('managerSelectionCount').textContent=count+' paper'+(count===1 ? '' : 's')+' chosen';
  const mendeley=managerUi.status?.mendeley;
  document.getElementById('mendeleySend').textContent=mendeley?.connected ? 'Send to Mendeley' : 'Export for Mendeley';
  document.getElementById('mendeleyHowTo').textContent=mendeley?.connected ? 'Send your chosen citations directly to your Mendeley library.' : mendeley?.configured ? 'Sign in to send citations directly, or export a file for Mendeley.' : 'Export your chosen citations, then import the file into Mendeley.';
  document.getElementById('mendeleyImportHelp').hidden=Boolean(mendeley?.connected);
  document.getElementById('mendeleyConnect').textContent='Connect Mendeley';
  document.getElementById('mendeleyDeveloperSettings').hidden=Boolean(mendeley?.sharedRegistration && mendeley?.configured && !mendeley?.developerSettingsAvailable);
  document.getElementById('mendeleyConnect').disabled=!mendeley?.configured || managerUi.connecting || Boolean(managerUi.status?.mendeley?.pending);
  document.getElementById('mendeleyConnect').hidden=Boolean(managerUi.status?.mendeley?.connected);
  const restart=document.getElementById('mendeleyRestartSignIn');
  if(restart) {restart.hidden=!mendeley?.pending;restart.disabled=Boolean(managerUi.connecting);}
  const usePulse=document.getElementById('mendeleyUsePulseSignIn');
  if(usePulse) {usePulse.hidden=Boolean(mendeley?.connected || !mendeley?.defaultSignInAvailable || mendeley?.sharedRegistration);usePulse.disabled=Boolean(managerUi.connecting);}
  const method=document.getElementById('mendeleyConnectionMethod');
  if(method) method.textContent=mendeley?.sharedRegistration ? 'Connection method: Pulse sign-in. No developer credentials are needed on this Mac.' : mendeley?.configured ? 'Connection method: your custom Mendeley application. If Mendeley reports an invalid third-party app, use Pulse sign-in instead.' : '';
  document.getElementById('mendeleyDisconnect').hidden=!managerUi.status?.mendeley?.connected;
  document.getElementById('mendeleySyncBox').hidden=!mendeley?.connected;
  document.getElementById('mendeleyAutomaticSync').checked=mendeley?.automaticSync !== false && !state.mendeleySyncPaused;
  document.getElementById('mendeleySyncNow').disabled=Boolean(managerUi.syncing) || !mendeley?.connected;
  document.getElementById('mendeleySyncStatus').textContent=managerUi.syncMessage || (state.mendeleySyncPaused ? 'Automatic sync paused after clearing. Choose Sync now or enable sync.' : mendeley?.lastSyncedAt ? 'Last synced '+new Date(mendeley.lastSyncedAt).toLocaleString() : 'Ready to import your Mendeley library.');
  document.getElementById('mendeleyAuthorizationNote').textContent=managerUi.status?.mendeley?.authorizationMessage || '';
}
function syncMendeleyConfigInputs(config) {
  if (!config) return;
  const clientId = config.clientId || '';
  const redirectUri = config.redirectUri || 'http://127.0.0.1:8765/mendeley/callback';
  const secretPlaceholder = config.hasClientSecret ? 'Saved securely; leave blank to keep' : 'Your registered client secret';
  for (const id of ['mendeleyClientId', 'settingsMendeleyClientId']) {
    const el = document.getElementById(id);
    if (el) el.value = clientId;
  }
  for (const id of ['mendeleyRedirect', 'settingsMendeleyRedirect']) {
    const el = document.getElementById(id);
    if (el) el.value = redirectUri;
  }
  for (const id of ['mendeleyClientSecret', 'settingsMendeleyClientSecret']) {
    const el = document.getElementById(id);
    if (el) el.placeholder = secretPlaceholder;
  }
}
function beginMendeleySignInFlow() {
  const generation=managerUi.signInGeneration=(managerUi.signInGeneration || 0)+1;
  clearInterval(managerUi.timer);managerUi.timer=null;
  document.getElementById('managerRefresh').disabled=false;
  return generation;
}
async function refreshManagers() {
  const generation=managerUi.signInGeneration || 0;
  const request=managerUi.statusRequest=(managerUi.statusRequest || 0)+1;
  const current=()=>generation===(managerUi.signInGeneration || 0) && request===managerUi.statusRequest;
  document.getElementById('managerRefresh').disabled=true;
  try {
    const status=await pulseRecordsRequest('/api/managers/status');
    if(!current()) return null;
    managerUi.status=status;updateManagers();return status;
  } catch(error) {if(current())document.getElementById('managerFeedback').textContent=error.message;return null;}
  finally {if(current())document.getElementById('managerRefresh').disabled=false;}
}
async function openManagers() {
  if(!managerDialog.open) managerDialog.showModal();
  updateManagers();
  try {const config=await pulseRecordsRequest('/api/managers/config');
    syncMendeleyConfigInputs(config);
  } catch(error) {document.getElementById('managerFeedback').textContent=error.message;}
  await refreshManagers();
}
document.getElementById('zoteroPill').addEventListener('click',openManagers);
document.getElementById('mendeleyPill').addEventListener('click',()=>{
  const connect=managerUi.status?.mendeley?.configured && !managerUi.status.mendeley.connected && !managerUi.status.mendeley.pending;
  if(connect) connectMendeley();
  openManagers();
});
document.getElementById('managerClose').addEventListener('click',()=>managerDialog.close());
document.getElementById('managerRefresh').addEventListener('click',refreshManagers);
document.getElementById('managerScope').addEventListener('change',updateManagers);
document.getElementById('mendeleySettingsForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=document.getElementById('mendeleySaveSettings');button.disabled=true;
  try {await pulseRecordsRequest('/api/managers/config',{clientId:document.getElementById('mendeleyClientId').value,
    clientSecret:document.getElementById('mendeleyClientSecret').value,redirectUri:document.getElementById('mendeleyRedirect').value});
    document.getElementById('mendeleyClientSecret').value='';document.getElementById('managerFeedback').textContent='Application settings saved. Connect your Mendeley account next.';
    const config=await pulseRecordsRequest('/api/managers/config');syncMendeleyConfigInputs(config);
    await refreshManagers();
  } catch(error) {document.getElementById('managerFeedback').textContent=error.message;} finally {button.disabled=false;}
});
async function connectMendeley() {
  if(managerUi.connecting) return;
  if(!managerUi.status?.mendeley?.configured) {
    document.getElementById('managerFeedback').textContent='Direct sign-in is awaiting Pulse service activation. Export for Mendeley is available now.';
    return;
  }
  managerUi.connecting=true;
  const generation=beginMendeleySignInFlow();
  const link=document.getElementById('mendeleyAuthorizeLink');link.hidden=true;link.removeAttribute?.('href');
  const button=document.getElementById('mendeleyConnect');button.disabled=true;
  try {const result=await pulseRecordsRequest('/api/managers/mendeley/connect',{});
    if(generation!==managerUi.signInGeneration) return;
    link.href=result.authorizationUrl;link.hidden=false;
    // Desktop navigation is intercepted by Tauri and opened in the system browser.
    // A same-window target avoids WebKit's async popup/user-gesture restrictions.
    link.target=typeof window!=='undefined' && window.__TAURI__ ? '_self' : '_blank';
    document.getElementById('managerFeedback').textContent='Mendeley will open for sign-in or account creation. Approve access there, then return here to send your citations.';
    link.textContent='Continue with Mendeley';link.click();
    let polling=false;
    const timer=setInterval(async()=>{
      if(polling || generation!==managerUi.signInGeneration) return;
      polling=true;
      try {
        const status=await refreshManagers();
        if(generation!==managerUi.signInGeneration || !status || managerUi.timer!==timer) return;
        if(!status.mendeley?.pending) {
          clearInterval(timer);managerUi.timer=null;
          if(status.mendeley?.connected) {link.hidden=true;document.getElementById('managerFeedback').textContent='Mendeley connected. Your library can now sync here.';}
        }
      } finally {polling=false;}
    },4000);
    managerUi.timer=timer;
    await refreshManagers();
  } catch(error) {if(generation===managerUi.signInGeneration)document.getElementById('managerFeedback').textContent=error.message;}
  finally {if(generation===managerUi.signInGeneration){managerUi.connecting=false;updateManagers();}}
}
document.getElementById('mendeleyConnect').addEventListener('click',connectMendeley);
document.getElementById('mendeleyRestartSignIn')?.addEventListener('click',connectMendeley);
async function usePulseMendeleySignIn() {
  if(managerUi.connecting || managerUi.syncing) return;
  managerUi.connecting=true;const generation=beginMendeleySignInFlow();updateManagers();
  try {
    await pulseRecordsRequest('/api/managers/config',{usePulseSignIn:true});
    if(generation!==managerUi.signInGeneration) return;
    state.syncEpoch=(state.syncEpoch || 0)+1;
    managerUi.syncMessage='';
    const link=document.getElementById('mendeleyAuthorizeLink');link.hidden=true;link.removeAttribute?.('href');
    const config=await pulseRecordsRequest('/api/managers/config');
    if(generation!==managerUi.signInGeneration) return;
    syncMendeleyConfigInputs(config);
    for(const id of ['mendeleyClientSecret','settingsMendeleyClientSecret']) {const input=document.getElementById(id);if(input)input.value='';}
    await refreshManagers();
    if(generation!==managerUi.signInGeneration) return;
  } catch(error) {if(generation===managerUi.signInGeneration)document.getElementById('managerFeedback').textContent=error.message;return;}
  finally {if(generation===managerUi.signInGeneration){managerUi.connecting=false;updateManagers();}}
  await connectMendeley();
}
document.getElementById('mendeleyUsePulseSignIn')?.addEventListener('click',usePulseMendeleySignIn);
document.getElementById('mendeleyDisconnect').addEventListener('click',async()=>{
  try {const result=await pulseRecordsRequest('/api/managers/mendeley/disconnect',{});document.getElementById('managerFeedback').textContent=result.message || 'Mendeley disconnected.';state.syncEpoch=(state.syncEpoch || 0)+1;document.getElementById('mendeleyAuthorizeLink').hidden=true;await refreshManagers();}
  catch(error) {document.getElementById('managerFeedback').textContent=error.message;}
});
async function exportMendeleyCitations() {
  const papers=managerSelectedPapers();
  if(!papers.length) return;
  await preparePaperExport(papers);
  downloadRecordFile('pulse-mendeley-citations.ris',recordRis(papers),'application/x-research-info-systems');
  document.getElementById('managerFeedback').textContent=`Exported ${papers.length} citation${papers.length===1 ? '' : 's'}. Drag the downloaded RIS file into Mendeley, or use Add New → Import Library → RIS.`;
}
for (const provider of ['zotero','mendeley']) document.getElementById(provider+'Send').addEventListener('click',async()=>{
  if(managerUi.busy) return;
  const papers=managerSelectedPapers();
  if(!papers.length) return;
  managerUi.busy=true;updateManagers();let saved=0,skipped=0;
  try {
    if(provider==='mendeley' && !managerUi.status?.mendeley?.connected) {await exportMendeleyCitations();return;}
    await preparePaperExport(papers);
    const records=papers.map(p=>({...Object.fromEntries(bibliographicFields.map(k=>[k,p[k]])),authors:paperAuthors(p),keywords:p.paperKeywords || [],metadataCheckedAt:p.metadataCheckedAt}));
    for(let offset=0;offset<records.length;offset+=10) {
      document.getElementById('managerFeedback').textContent=`Sending ${offset+1}–${Math.min(offset+10,records.length)} of ${records.length} papers to ${provider==='zotero' ? 'Zotero' : 'Mendeley'}…`;
      const result=await pulseRecordsRequest('/api/managers/save',{provider,papers:records.slice(offset,offset+10)});
      saved+=result.saved.length;skipped+=result.skipped.length;
      if(result.errors.length) throw new Error(result.errors.map(x=>x.title+': '+x.error).join('; '));
    }
    document.getElementById('managerFeedback').textContent=`Saved ${saved} papers. ${skipped} were already sent by Pulse.`;
  } catch(error) {document.getElementById('managerFeedback').textContent=`Saved ${saved} papers before stopping. ${error.message}`;}
  finally {managerUi.busy=false;updateManagers();}
});
managerDialog.addEventListener('close',()=>{if(!managerUi.status?.mendeley?.pending) clearInterval(managerUi.timer);});
document.getElementById('mendeleyConfigureBtn')?.addEventListener?.('click', () => {
  const details = document.getElementById('mendeleyDeveloperSettings');
  if (details) {
    details.hidden = false;
    details.open = !details.open;
    if (details.open) {
      document.getElementById('mendeleyClientId')?.focus?.();
      details.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
  }
});
document.getElementById('settingsSaveMendeleyButton')?.addEventListener?.('click', async () => {
  const btn = document.getElementById('settingsSaveMendeleyButton');
  const feedback = document.getElementById('settingsMendeleyFeedback');
  if (btn) btn.disabled = true;
  if (feedback) feedback.textContent = 'Saving settings…';
  try {
    const clientId = document.getElementById('settingsMendeleyClientId')?.value?.trim();
    const clientSecret = document.getElementById('settingsMendeleyClientSecret')?.value?.trim();
    const redirectUri = document.getElementById('settingsMendeleyRedirect')?.value?.trim();
    await pulseRecordsRequest('/api/managers/config', { clientId, clientSecret, redirectUri });
    const config = await pulseRecordsRequest('/api/managers/config');
    syncMendeleyConfigInputs(config);
    if (document.getElementById('settingsMendeleyClientSecret')) document.getElementById('settingsMendeleyClientSecret').value = '';
    if (feedback) feedback.textContent = 'Application settings saved. Connect your Mendeley account next.';
    await refreshManagers();
    if (typeof showToast === 'function') showToast('Mendeley application settings saved.');
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
  } finally {
    if (btn) btn.disabled = false;
  }
});
document.getElementById('settingsOpenMendeleyDialogButton')?.addEventListener?.('click', () => {
  const panel = document.getElementById('settingsPanel');
  if (panel) panel.hidden = true;
  openManagers();
});
document.getElementById('settingsOpenZoteroDialogButton')?.addEventListener?.('click', () => {
  const panel = document.getElementById('settingsPanel');
  if (panel) panel.hidden = true;
  openManagers();
});
document.addEventListener?.('DOMContentLoaded', () => {
  refreshManagers();
  pulseRecordsRequest('/api/managers/config').then(syncMendeleyConfigInputs).catch(() => {});
});

