// Local paper-reading agent. Summary output is rendered as text, never model HTML or graph actions.
const paperAgent = { online: false, models: [], job: null, busy: false, refreshing: false, timer: null, rendered: -1 };
const agentUi = Object.fromEntries(['Status','Refresh','Model','Scope','Stop','Export','Progress','ProgressBar','ScanStatus','Fab','FabCount'].map(key => [key, document.getElementById(`aiAgent${key}`)]));
const agentSessionKey = `pulse.paperAgentJob:${window.location.port}`;

async function paperAgentRequest(path, payload) {
  const response = await fetch(backendUrl(path), { headers: apiHeaders(payload ? {'Content-Type':'application/json'} : {}),
    ...(payload ? {method:'POST', body:JSON.stringify(payload)} : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The local reading agent is unavailable.');
  return data;
}

function updateAgentControls() {
  els.aiAnalyzeButton.disabled = paperAgent.busy || !paperAgent.online || !agentUi.Model.value;
  agentUi.Model.disabled = paperAgent.busy || !paperAgent.models.length;
  agentUi.Scope.disabled = paperAgent.busy;
  els.aiPrompt.disabled = paperAgent.busy;
  agentUi.Stop.hidden = !paperAgent.busy;
  agentUi.Stop.disabled = !paperAgent.job?.id || paperAgent.job?.stage === 'Stopping the scan…';
  agentUi.Export.hidden = !(paperAgent.job?.results?.some(result => result.summary));
  agentUi.Fab.classList.toggle('is-scanning', paperAgent.busy);
  agentUi.FabCount.hidden = !paperAgent.busy;
  if (paperAgent.busy && paperAgent.job) agentUi.FabCount.textContent = `${paperAgent.job.completed}/${paperAgent.job.total}`;
  const selected = agentUi.Scope.querySelector('[value="selected"]');
  selected.disabled = !state.papers.some(paper => paper.id === state.selectedId);
  selected.textContent = selected.disabled ? 'Selected paper (select one first)' : 'Selected paper';
  agentUi.Scope.querySelector('[value="all"]').textContent = `Entire library · ${state.papers.length} paper${state.papers.length === 1 ? '' : 's'}`;
}

async function refreshPaperAgent() {
  updateAgentControls();
  if (paperAgent.refreshing) return;
  paperAgent.refreshing = true;
  agentUi.Refresh.disabled = true;
  try {
    const status = await paperAgentRequest('/api/agent/status');
    paperAgent.online = status.online;
    paperAgent.models = status.models || [];
    const previous = agentUi.Model.value || (() => { try { return localStorage.getItem('pulse.paperAgentModel'); } catch (_) { return ''; } })();
    agentUi.Model.replaceChildren();
    for (const model of paperAgent.models) {
      const option = document.createElement('option'); option.value = model; option.textContent = model; agentUi.Model.append(option);
    }
    if (!paperAgent.models.length) { const option = document.createElement('option'); option.value=''; option.textContent='No local model available'; agentUi.Model.append(option); }
    agentUi.Model.value = paperAgent.models.includes(previous) ? previous : status.model || '';
    agentUi.Status.textContent = status.message;
    agentUi.Status.classList.toggle('is-connected', status.online && paperAgent.models.length > 0);
  } catch (error) {
    paperAgent.online = false;
    agentUi.Status.classList.remove('is-connected');
    agentUi.Status.textContent = 'Cannot connect to Pulse. Refresh to try again.';
  } finally {
    paperAgent.refreshing = false;
    agentUi.Refresh.disabled = false;
    updateAgentControls();
  }
}

function renderPaperAgentJob(job) {
  paperAgent.job = job;
  paperAgent.busy = job.status === 'running';
  agentUi.ScanStatus.textContent = job.error || job.stage;
  agentUi.Progress.hidden = false;
  agentUi.ProgressBar.max = job.total || 1;
  agentUi.ProgressBar.value = job.completed || 0;
  if (paperAgent.rendered !== job.results.length || !job.results.length) {
    paperAgent.rendered = job.results.length;
    els.aiResult.replaceChildren();
    if (!job.results.length) {
      const pending = document.createElement('p'); pending.className = 'agent-pending';
      pending.textContent = job.status === 'running' ? 'Reading your papers… Summaries will appear here as each paper finishes.'
        : job.status === 'cancelled' ? 'No summaries finished before the scan was stopped.' : 'No summaries were generated.';
      els.aiResult.append(pending);
    }
    for (const result of job.results) {
      const card = document.createElement('article'); card.className = 'agent-summary';
      const tag = document.createElement('span'); tag.className = 'agent-source'; tag.textContent = result.source;
      const title = document.createElement('h3'); title.textContent = result.title;
      const summary = document.createElement('div'); summary.className = 'agent-summary-text'; summary.textContent = result.error || result.summary;
      if (result.error) summary.classList.add('agent-error');
      card.append(tag, title, summary);
      if (result.charactersRead) {
        const coverage = document.createElement('p'); coverage.className = 'agent-coverage'; coverage.textContent = `${result.charactersRead.toLocaleString()} characters of available text read`; card.append(coverage);
      }
      if (result.doi) {
        const doi = document.createElement('p'); doi.className = 'agent-coverage'; doi.textContent = `DOI: ${result.doi}`; card.append(doi);
      }
      const paper = state.papers.find(p => p.id === result.id);
      if (paper) {
        const inspect = document.createElement('button'); inspect.type='button'; inspect.className='agent-text-button'; inspect.textContent='View paper';
        inspect.addEventListener('click', () => {state.selectedId = paper.id; setInspectorVisible(true); render(); setAiPanelOpen(false);});
        card.append(inspect);
      }
      els.aiResult.append(card);
    }
  }
  updateAgentControls();
}

async function pollPaperAgentJob(id) {
  clearTimeout(paperAgent.timer);
  try {
    const job = await paperAgentRequest(`/api/agent/jobs/${encodeURIComponent(id)}`);
    renderPaperAgentJob(job);
    if (job.status === 'running') paperAgent.timer = setTimeout(() => pollPaperAgentJob(id), 1200);
    else {try {sessionStorage.removeItem(agentSessionKey);} catch (_) {}}
  } catch (error) {
    if (/expired/i.test(error.message)) {
      paperAgent.busy = false; agentUi.ScanStatus.textContent = error.message;
      try {sessionStorage.removeItem(agentSessionKey);} catch (_) {}
      updateAgentControls();
    } else {
      agentUi.ScanStatus.textContent = 'Connection interrupted. Reconnecting to your scan…';
      paperAgent.timer = setTimeout(() => pollPaperAgentJob(id), 3000);
    }
  }
}

async function startPaperScan() {
  if (paperAgent.busy) return;
  const papers = agentUi.Scope.value === 'selected' ? state.papers.filter(p => p.id === state.selectedId) : state.papers;
  if (!papers.length) {agentUi.ScanStatus.textContent = 'Add a paper or select one before starting a scan.'; return;}
  paperAgent.busy = true; updateAgentControls();
  agentUi.ScanStatus.textContent = 'Starting your local scan…';
  try {
    const job = await paperAgentRequest('/api/agent/start', {model:agentUi.Model.value, focus:els.aiPrompt.value,
      papers:papers.map(p => ({id:p.id, name:p.name, title:p.title, authors:p.authors, year:p.year, journal:p.journal,
        doi:p.doi, keywords:mergedKeywords(p), abstract:p.abstract || '', text:p.text || ''}))});
    paperAgent.rendered = -1;
    try {sessionStorage.setItem(agentSessionKey, job.id);} catch (_) {}
    renderPaperAgentJob(job);
    pollPaperAgentJob(job.id);
  } catch (error) {
    paperAgent.busy = false; agentUi.ScanStatus.textContent = error.message; updateAgentControls();
  }
}

agentUi.Fab.addEventListener('click', () => setAiPanelOpen(els.aiPanel.hidden));
agentUi.Refresh.addEventListener('click', refreshPaperAgent);
agentUi.Model.addEventListener('change', () => {try {localStorage.setItem('pulse.paperAgentModel', agentUi.Model.value);} catch (_) {} updateAgentControls();});
agentUi.Scope.addEventListener('change', updateAgentControls);
agentUi.Stop.addEventListener('click', async () => {
  if (!paperAgent.job?.id) return;
  agentUi.Stop.disabled = true;
  try {renderPaperAgentJob(await paperAgentRequest('/api/agent/cancel', {id:paperAgent.job.id}));}
  catch (error) {agentUi.ScanStatus.textContent = error.message; agentUi.Stop.disabled = false;}
});
agentUi.Export.addEventListener('click', () => {
  const job = paperAgent.job;
  if (!job) return;
  const text = `# Pulse paper summaries\n\nLocal model: ${job.model}\n\n` + job.results.map(result =>
    `## ${result.title}\n\nSource: ${result.source}\n${result.doi ? `DOI: ${result.doi}\n` : ''}\n${result.summary || result.error}\n`).join('\n');
  const url = URL.createObjectURL(new Blob([text], {type:'text/markdown;charset=utf-8'}));
  const link = document.createElement('a'); link.href=url; link.download='Pulse-paper-summaries.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
document.addEventListener('keydown', event => {if (event.key === 'Escape' && !els.aiPanel.hidden) setAiPanelOpen(false);});
refreshPaperAgent();
try {const savedJob = sessionStorage.getItem(agentSessionKey); if (savedJob) {paperAgent.busy=true; pollPaperAgentJob(savedJob);}} catch (_) {}
