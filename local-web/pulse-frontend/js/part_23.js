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
  document.getElementById('relationList').innerHTML=visible.slice(0,relationUi.limit).map(({paper,index})=>`<li><div><a href="${escapeHtml(safePaperUrl(paper.url || (paper.doi ? 'https://doi.org/'+paper.doi : '#')))}" target="_blank" rel="noreferrer">${escapeHtml(paper.title)}</a><p>${escapeHtml(paper.authors.join(', '))} · ${escapeHtml(paper.year || 'No year')}${paper.journal ? ' · '+escapeHtml(paper.journal) : ''}</p>${paper.doi ? '<small>DOI '+escapeHtml(paper.doi)+'</small>' : ''}${paper.isInfluential ? '<small> · Influential citation (Semantic Scholar)</small>' : ''}</div><button data-relation-add="${index}" class="inspector-btn secondary" type="button">Add to Pulse</button></li>`).join('') || '<li>No matching records loaded.</li>';
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
  return records.map(p=>['TY  - JOUR','TI  - '+clean(p.title),...paperAuthors(p).map(a=>'AU  - '+clean(a)),
    ...[['PY','year'],['JO','journal'],['DO','doi']].filter(([_,key])=>p[key]).map(([tag,key])=>tag+'  - '+clean(p[key])),...(p.abstract ? ['AB  - '+clean(p.abstract)] : []),...(p.paperKeywords || []).map(k=>'KW  - '+clean(k)),'ER  - '].join('\n')).join('\n\n')+'\n';
}
document.getElementById('relationClose').addEventListener('click',()=>relationDialog.close());
relationDialog.addEventListener('close',()=>relationUi.controller?.abort());
document.getElementById('relationFilter').addEventListener('input',()=>{relationUi.limit=100;updateRelations();});
document.getElementById('relationLoadNext').addEventListener('click',()=>loadRelations());
document.getElementById('relationLoadAll').addEventListener('click',()=>loadRelations(true));
document.getElementById('relationProvider').addEventListener('change',event=>openPaperRelations(relationUi.paper,relationUi.kind,event.target.value));
document.getElementById('relationStop').addEventListener('click',()=>relationUi.controller?.abort());
document.getElementById('relationMoreVisible').addEventListener('click',()=>{relationUi.limit+=100;updateRelations();});
document.getElementById('relationExport').addEventListener('click',()=>{
  const format=document.getElementById('relationExportFormat').value;
  const name=`pulse-${relationUi.kind}-${relationUi.complete ? 'available' : 'partial'}`;
  if(format==='ris') downloadRecordFile(name+'.ris',recordRis(relationUi.items),'text/plain');
  else if(format==='csv') {const fields=['title','authors','year','journal','doi'];const quote=v=>'"'+String(v ?? '').replaceAll('"','""')+'"';
    downloadRecordFile(name+'.csv',[fields.join(','),...relationUi.items.map(p=>fields.map(k=>quote(k==='authors' ? p.authors.join('; ') : p[k])).join(','))].join('\n'),'text/csv');}
  else downloadRecordFile(name+'.json',JSON.stringify({paper:relationUi.paper.title,kind:relationUi.kind,source:relationUi.source,indexedTotal:relationUi.total,reportedPaperTotal:relationUi.reportedTotal,complete:relationUi.complete,unresolved:relationUi.unresolved,papers:relationUi.items},null,2),'application/json');
});

function managerSelectedPapers() {
  const scope=document.getElementById('managerScope').value;
  if(scope==='bulk') return libraryBulkPapers();
  if(scope==='all') return state.papers;
  if(scope==='relations') return relationUi.items;
  if(scope==='discoveries') return (state.discoveryResults || []).filter(p=>state.discoverySelectedKeys.has(discoveryPaperKey(p))).map(p=>p.paper || p);
  return state.papers.filter(p=>p.id===state.selectedId);
}
function updateManagers() {
  for(const provider of ['zotero','mendeley']) {
    const info=managerUi.status?.[provider];
    const label=provider==='zotero' ? 'Zotero' : 'Mendeley';
    document.getElementById(provider+'PillStatus').textContent=info?.connected ? 'Connected' : provider==='mendeley' && !info?.configured ? 'Export citations' : info?.label || 'Check connection';
    document.getElementById(provider+'PillStatus').classList.toggle('is-connected',Boolean(info?.connected));
    document.getElementById(provider+'ConnectionNote').textContent=info?.connected ? label+' · '+info.destination : info?.message || (provider==='zotero' ? 'Open Zotero Desktop to connect locally.' : info?.pending ? 'Finish signing in with Mendeley, then return here.' : info?.configured ? 'Sign in to connect your Mendeley library.' : 'Export citations for Mendeley, or set up a direct connection.');
    document.getElementById(provider+'Send').disabled=managerUi.busy || (provider==='zotero' && !info?.connected) || !managerSelectedPapers().length;
  }
  const count=managerSelectedPapers().length;
  document.getElementById('managerSelectionCount').textContent=count+' paper'+(count===1 ? '' : 's')+' chosen';
  const mendeley=managerUi.status?.mendeley;
  document.getElementById('mendeleySend').textContent=mendeley?.connected ? 'Send to Mendeley' : 'Export for Mendeley';
  document.getElementById('mendeleyHowTo').textContent=mendeley?.connected ? 'Send your chosen citations directly to your Mendeley library.' : mendeley?.configured ? 'Sign in to send citations directly, or export a file for Mendeley.' : 'Export your chosen citations, then import the file into Mendeley.';
  document.getElementById('mendeleyImportHelp').hidden=Boolean(mendeley?.connected);
  document.getElementById('mendeleyConnect').textContent=mendeley?.configured ? 'Connect Mendeley' : 'Set up direct transfer';
  document.getElementById('mendeleyDeveloperSettings').hidden=Boolean(mendeley?.sharedRegistration && mendeley?.configured);
  document.getElementById('mendeleyConnect').disabled=managerUi.connecting || Boolean(managerUi.status?.mendeley?.pending);
  document.getElementById('mendeleyConnect').hidden=Boolean(managerUi.status?.mendeley?.connected);
  document.getElementById('mendeleyDisconnect').hidden=!managerUi.status?.mendeley?.connected;
  document.getElementById('mendeleyAuthorizationNote').textContent=managerUi.status?.mendeley?.authorizationMessage || '';
}
async function refreshManagers() {
  document.getElementById('managerRefresh').disabled=true;
  try {managerUi.status=await pulseRecordsRequest('/api/managers/status'); updateManagers();}
  catch(error) {document.getElementById('managerFeedback').textContent=error.message;}
  finally {document.getElementById('managerRefresh').disabled=false;}
}
async function openManagers() {
  if(!managerDialog.open) managerDialog.showModal();
  updateManagers();
  try {const config=await pulseRecordsRequest('/api/managers/config');
    document.getElementById('mendeleyClientId').value=config.clientId;
    document.getElementById('mendeleyRedirect').value=config.redirectUri;
    document.getElementById('mendeleyClientSecret').placeholder=config.hasClientSecret ? 'Saved securely; leave blank to keep' : 'Your registered client secret';
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
    document.getElementById('mendeleyClientSecret').value='';document.getElementById('managerFeedback').textContent='Application settings saved. Connect your Mendeley account next.';await refreshManagers();
  } catch(error) {document.getElementById('managerFeedback').textContent=error.message;} finally {button.disabled=false;}
});
async function connectMendeley() {
  if(managerUi.connecting) return;
  if(!managerUi.status?.mendeley?.configured) {
    const settings=document.getElementById('mendeleyDeveloperSettings'); settings.hidden=false; settings.open=true;
    document.getElementById('managerFeedback').textContent='For direct transfer, register a Mendeley application and save its settings below. Export for Mendeley is available now.';
    document.getElementById('mendeleyClientId').focus();
    return;
  }
  managerUi.connecting=true;
  const button=document.getElementById('mendeleyConnect');button.disabled=true;
  try {const result=await pulseRecordsRequest('/api/managers/mendeley/connect',{});
    const link=document.getElementById('mendeleyAuthorizeLink');link.href=result.authorizationUrl;link.hidden=false;
    document.getElementById('managerFeedback').textContent='Mendeley will open for sign-in or account creation. Approve access there, then return here to send your citations.';
    link.textContent='Continue with Mendeley';link.click();
    clearInterval(managerUi.timer);managerUi.timer=setInterval(async()=>{await refreshManagers();if(!managerUi.status?.mendeley?.pending) {clearInterval(managerUi.timer);if(managerUi.status?.mendeley?.connected){document.getElementById('mendeleyAuthorizeLink').hidden=true;document.getElementById('managerFeedback').textContent='Mendeley connected. Choose your citations and click Send to Mendeley.';}}},4000);
    await refreshManagers();
  } catch(error) {document.getElementById('managerFeedback').textContent=error.message;} finally {managerUi.connecting=false;updateManagers();}
}
document.getElementById('mendeleyConnect').addEventListener('click',connectMendeley);
document.getElementById('mendeleyDisconnect').addEventListener('click',async()=>{
  try {await pulseRecordsRequest('/api/managers/mendeley/disconnect',{});document.getElementById('mendeleyAuthorizeLink').hidden=true;await refreshManagers();}
  catch(error) {document.getElementById('managerFeedback').textContent=error.message;}
});
function exportMendeleyCitations() {
  const papers=managerSelectedPapers();
  if(!papers.length) return;
  downloadRecordFile('pulse-mendeley-citations.ris',recordRis(papers),'application/x-research-info-systems');
  document.getElementById('managerFeedback').textContent=`Exported ${papers.length} citation${papers.length===1 ? '' : 's'}. Drag the downloaded RIS file into Mendeley, or use Add New → Import Library → RIS.`;
}
for (const provider of ['zotero','mendeley']) document.getElementById(provider+'Send').addEventListener('click',async()=>{
  if(managerUi.busy) return;
  if(provider==='mendeley' && !managerUi.status?.mendeley?.connected) {exportMendeleyCitations();return;}
  const records=managerSelectedPapers().map(p=>({title:p.title,authors:paperAuthors(p),year:p.year,journal:p.journal,doi:p.doi,pmid:p.pmid,abstract:p.abstract}));
  if(!records.length) return;
  managerUi.busy=true;updateManagers();let saved=0,skipped=0;
  try {
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
document.addEventListener('DOMContentLoaded',()=>refreshManagers());
