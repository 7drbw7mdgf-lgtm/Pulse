// Selected-paper reports. Source and summary are text, never model HTML or actions.
const paperAgent = { online:false, model:'', job:null, activeId:null, busy:false, refreshing:false, cancelling:false, timer:null, rendered:'', reports:new Map() };
const agentUi = Object.fromEntries(['Status','Refresh','Setup','Stop','Export','Progress','ProgressBar','ScanStatus','Fab','FabCount','Context','ResultsHeading','ResultCount'].map(key => [key, document.getElementById(`aiAgent${key}`)]));
const agentSessionKey = `pulse.selectedPaperReport:${window.location.port}`;

async function paperAgentRequest(path, payload) {
  await backendReady;
  const response = await fetch(backendUrl(path), {headers:apiHeaders(payload ? {'Content-Type':'application/json'} : {}),
    ...(payload ? {method:'POST', body:JSON.stringify(payload)} : {}), signal:AbortSignal.timeout(15000)});
  const data = await response.json();
  if (!response.ok) {
    const error = new Error('The report could not be completed. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderSelectedPaperReport() {
  const selectedPaper = state.papers.find(p => p.id === state.selectedId);
  const result = selectedPaper && paperAgent.reports.get(selectedPaper.id);
  const reading = paperAgent.busy && paperAgent.activeId === selectedPaper?.id;
  const key = JSON.stringify([selectedPaper?.id, result, reading]);
  agentUi.ResultsHeading.hidden = !result;
  agentUi.ResultCount.textContent = '';
  agentUi.Export.hidden = !result?.summary;
  if (paperAgent.rendered === key) return;
  paperAgent.rendered = key;
  els.aiResult.replaceChildren();
  if (!result) {
    const empty = document.createElement('div'); empty.className = 'agent-empty';
    const icon = document.createElement('span'); icon.textContent = '✦'; icon.setAttribute('aria-hidden','true');
    const title = document.createElement('strong'); title.textContent = reading ? 'Reading your paper' : selectedPaper ? 'Ready for a closer look' : 'Select a paper';
    const note = document.createElement('p'); note.textContent = reading ? 'Your report will appear here when it is ready.' : selectedPaper ? 'Create a report on this paper’s aim, methods, findings and limitations.' : 'Choose a paper in the library or on the map to begin.';
    empty.append(icon,title,note); els.aiResult.append(empty);
    return;
  }
  const card = document.createElement('article'); card.className = 'agent-summary';
  const tag = document.createElement('span'); tag.className = 'agent-source'; tag.textContent = result.source;
  const title = document.createElement('h3'); title.textContent = result.title;
  const summary = document.createElement('div'); summary.className = 'agent-summary-text';
  summary.textContent = result.error ? 'The report could not be completed. Please try again.' : result.summary;
  if (result.error) summary.classList.add('agent-error');
  card.append(tag,title,summary);
  if (result.doi) {const doi=document.createElement('p');doi.className='agent-coverage';doi.textContent=`DOI: ${result.doi}`;card.append(doi);}
  els.aiResult.append(card);
}

function updateAgentControls() {
  const selectedPaper = state.papers.find(paper => paper.id === state.selectedId);
  els.aiAnalyzeButton.disabled = paperAgent.busy || !paperAgent.online || !paperAgent.model || !selectedPaper;
  els.aiAnalyzeButton.hidden = paperAgent.busy;
  els.aiPrompt.disabled = paperAgent.busy;
  agentUi.Stop.hidden = !paperAgent.busy;
  agentUi.Stop.disabled = !paperAgent.job?.id || paperAgent.cancelling;
  agentUi.Fab.classList.toggle('is-scanning', paperAgent.busy);
  agentUi.FabCount.hidden = true;
  agentUi.Context.textContent = selectedPaper?.title || 'Select a paper in your library or on the map.';
  agentUi.Context.title = agentUi.Context.textContent;
  const readingSelected = paperAgent.busy && paperAgent.activeId === selectedPaper?.id;
  agentUi.Progress.hidden = !readingSelected;
  if (paperAgent.busy && !readingSelected) {
    agentUi.ScanStatus.textContent = 'Stopping the previous report…';
    if (paperAgent.job?.id && !paperAgent.cancelling) stopPaperReport();
  } else if (readingSelected) {
    agentUi.ScanStatus.textContent = paperAgent.cancelling ? 'Stopping report…' : /Writing|summary/i.test(paperAgent.job?.stage || '') ? 'Writing your report…' : 'Reading selected paper…';
  } else {
    const result = selectedPaper && paperAgent.reports.get(selectedPaper.id);
    agentUi.ScanStatus.textContent = result?.error ? 'Please try again to create this report.' : result ? 'Report ready.' : '';
  }
  renderSelectedPaperReport();
}

async function refreshPaperAgent() {
  updateAgentControls();
  if (paperAgent.refreshing) return;
  paperAgent.refreshing = true; agentUi.Refresh.disabled = true;
  try {
    const status = await paperAgentRequest('/api/agent/status');
    // Use the configured available local model without exposing infrastructure in the report panel.
    const models = status.models || [];
    paperAgent.model = models.includes(status.model) ? status.model : models[0] || '';
    paperAgent.online = Boolean(status.online && paperAgent.model);
    agentUi.Status.textContent = paperAgent.online ? 'Ready' : 'Assistant needs setup. Check Settings, then try again.';
    agentUi.Status.classList.toggle('is-connected',paperAgent.online);
  } catch (_) {
    paperAgent.online = false; agentUi.Status.classList.remove('is-connected');
    agentUi.Status.textContent = 'Assistant unavailable. Try again in a moment.';
  } finally {
    paperAgent.refreshing = false; agentUi.Refresh.disabled = false;
    agentUi.Setup.hidden = paperAgent.online;
    updateAgentControls();
  }
}

function renderPaperAgentJob(job) {
  // Ignore legacy multi-paper scans; reports are always tied to exactly one paper.
  if (job.total !== 1) {
    paperAgent.busy = false; paperAgent.job = null; paperAgent.activeId = null;
    try {sessionStorage.removeItem(agentSessionKey);} catch (_) {}
    updateAgentControls(); return false;
  }
  paperAgent.job = job;
  paperAgent.activeId = job.paperId || job.results?.[0]?.id || paperAgent.activeId;
  paperAgent.busy = job.status === 'running';
  agentUi.ProgressBar.max = 1; agentUi.ProgressBar.value = job.completed || 0;
  for (const result of job.results || []) {
    if (result.id === paperAgent.activeId) paperAgent.reports.set(result.id,result);
  }
  if (!paperAgent.busy) paperAgent.cancelling = false;
  updateAgentControls(); return true;
}

async function pollPaperAgentJob(id) {
  clearTimeout(paperAgent.timer);
  try {
    const job = await paperAgentRequest(`/api/agent/jobs/${encodeURIComponent(id)}`);
    if (!renderPaperAgentJob(job)) return;
    if (job.status === 'running') paperAgent.timer = setTimeout(() => pollPaperAgentJob(id),1200);
    else {try {sessionStorage.removeItem(agentSessionKey);} catch (_) {}}
  } catch (error) {
    if (error.status === 404) {
      paperAgent.busy = false; paperAgent.cancelling = false;
      try {sessionStorage.removeItem(agentSessionKey);} catch (_) {}
      updateAgentControls(); agentUi.ScanStatus.textContent = 'This report has expired. Create a new one.';
    } else {
      agentUi.ScanStatus.textContent = 'Reconnecting to your report…';
      paperAgent.timer = setTimeout(() => pollPaperAgentJob(id),3000);
    }
  }
}

async function startPaperScan() {
  if (paperAgent.busy) return;
  const paper = state.papers.find(p => p.id === state.selectedId);
  if (!paper) {agentUi.ScanStatus.textContent='Select a paper before creating a report.'; return;}
  paperAgent.activeId = paper.id; paperAgent.job = null; paperAgent.busy = true; paperAgent.cancelling = false;
  paperAgent.reports.delete(paper.id); updateAgentControls();
  try {
    const job = await paperAgentRequest('/api/agent/start',{model:paperAgent.model, focus:els.aiPrompt.value,
      papers:[{id:paper.id,name:paper.name,title:paper.title,authors:paper.authors,year:paper.year,journal:paper.journal,
        doi:paper.doi,keywords:mergedKeywords(paper),abstract:paper.abstract || '',text:paper.text || ''}]});
    try {sessionStorage.setItem(agentSessionKey,job.id);} catch (_) {}
    renderPaperAgentJob(job); pollPaperAgentJob(job.id);
  } catch (error) {
    paperAgent.busy=false; updateAgentControls();
    agentUi.ScanStatus.textContent = error.status === 409 ? 'A report is still finishing. Please try again shortly.' : 'Could not create the report. Try again or check Settings.';
  }
}

async function stopPaperReport() {
  if (!paperAgent.job?.id || paperAgent.cancelling) return;
  paperAgent.cancelling=true; agentUi.Stop.disabled=true;
  try {renderPaperAgentJob(await paperAgentRequest('/api/agent/cancel',{id:paperAgent.job.id}));}
  catch (_) {paperAgent.cancelling=false;agentUi.Stop.disabled=false;agentUi.ScanStatus.textContent='Could not stop the report. Please try again.';}
}

agentUi.Fab.addEventListener('click',()=>setAiPanelOpen(els.aiPanel.hidden));
agentUi.Refresh.addEventListener('click',refreshPaperAgent);
agentUi.Setup.addEventListener('click',()=>{setAiPanelOpen(false);setSettingsOpen(true);});
agentUi.Stop.addEventListener('click',stopPaperReport);
agentUi.Export.addEventListener('click',()=>{
  const result=paperAgent.reports.get(state.selectedId);
  if (!result?.summary) return;
  const text=`# ${result.title}\n\nSource: ${result.source}\n${result.doi ? `DOI: ${result.doi}\n` : ''}\n${result.summary}\n`;
  const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='Pulse-paper-report.md';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && !els.aiPanel.hidden)setAiPanelOpen(false);});
refreshPaperAgent();
try {const savedJob=sessionStorage.getItem(agentSessionKey);if(savedJob){paperAgent.busy=true;pollPaperAgentJob(savedJob);}} catch (_) {}
