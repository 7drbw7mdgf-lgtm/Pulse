/* Table selection is independent of the paper currently inspected and map visibility. */
function libraryBulkPapers() {
  return state.papers.filter(paper => state.librarySelectedIds.has(paper.id));
}
function renderLibraryBulkActions(visiblePapers = state.papers.filter(paperMatchesFilters)) {
  const available = new Set(state.papers.map(paper => paper.id));
  for (const id of state.librarySelectedIds) if (!available.has(id)) state.librarySelectedIds.delete(id);
  const count = libraryBulkPapers().length;
  const shown = visiblePapers.filter(paper => state.librarySelectedIds.has(paper.id)).length;
  const bar = document.getElementById('libraryBulkBar');
  bar.hidden = !state.libraryFullscreen;
  document.getElementById('libraryBulkCount').textContent = `${count} selected${count > shown ? ` · ${count - shown} outside this filter` : ''}`;
  for (const id of ['libraryBulkDeselect','libraryBulkExport','libraryBulkTag','libraryBulkTransfer','libraryBulkRemove']) document.getElementById(id).disabled = !count || state.libraryMutation;
  document.getElementById('libraryUndo').disabled = !state.libraryUndoId || state.libraryMutation;
  const selectAll = document.getElementById('librarySelectVisible');
  if (selectAll) {
    selectAll.checked = visiblePapers.length > 0 && shown === visiblePapers.length;
    selectAll.indeterminate = shown > 0 && shown < visiblePapers.length;
    selectAll.addEventListener('change', () => {
      for (const paper of visiblePapers) {
        if (selectAll.checked) state.librarySelectedIds.add(paper.id);
        else state.librarySelectedIds.delete(paper.id);
      }
      renderPapers();
    });
  }
  els.paperList.querySelectorAll('[data-action="select-library-row"]').forEach(input => {
    const row = input.closest('[data-paper]');
    row.classList.toggle('is-bulk-selected', input.checked);
    input.addEventListener('change', () => {
      if (input.checked) state.librarySelectedIds.add(row.dataset.paper);
      else state.librarySelectedIds.delete(row.dataset.paper);
      renderPapers();
      document.querySelector(`[data-paper="${CSS.escape(row.dataset.paper)}"] [data-action="select-library-row"]`)?.focus();
    });
  });
}
async function libraryMutationRequest(path, payload) {
  if (state.libraryMutation) throw new Error('Please wait for the current library change.');
  const wasReady = state.autosaveReady;
  state.syncEpoch = (state.syncEpoch || 0) + 1;
  state.libraryMutation = true;
  state.autosaveReady = false;
  clearTimeout(state.autosaveTimer);
  els.app.inert = true;
  try {
    await Promise.allSettled([...(state.pendingLibraryWrites || [])]);
    const response = await fetch(backendUrl(path), {
      method:'POST', headers:apiHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({...payload,_saveSession:state.librarySaveSession ||= uid(),_saveRevision:state.librarySaveRevision=(state.librarySaveRevision || 0)+1}), signal:AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Your library was not changed.');
    state.libraryUndoId = result.recoveryId;
    refreshLibraryRecovery().catch(() => {});
    return result;
  } finally {
    state.libraryMutation = false;
    state.autosaveReady = wasReady;
    els.app.inert = false;
    renderLibraryBulkActions();
  }
}
function applyRecoveredWorkspace(workspace) {
  state.vectors.clear(); state.keywords.clear();
  state.selectedLinkId = null;
  state.recommendations = new Map();
  state.librarySelectedIds.clear();
  applyMapPayload({...workspace, reset:workspace.papers.length === 0}, 'Autosaved library');
  state.papers = workspace.papers;
  const restored = new Set(state.papers.filter(p => p.mendeleySource).flatMap(p => [mendeleyRemoteKey(p.mendeleySource.account,p.mendeleySource.id),mendeleyRemoteKey(p.mendeleySource.account,'identity:'+paperIdentityKey(p))]));
  state.mendeleyIgnored = (state.mendeleyIgnored || []).filter(k => !restored.has(k));
  state.allowEmptySave = state.papers.length === 0;
  render();
  try { localStorage.setItem('pulse-autosave-library', JSON.stringify(serializeMap())); } catch (_) {}
}
async function removePapersWithRecovery(ids) {
  if (state.libraryMutation || state.clearingLibrary) return;
  const ignoredBefore = state.mendeleyIgnored;
  try {
    rememberMendeleyRemovals(state.papers.filter(p => ids.includes(p.id)));
    const result = await libraryMutationRequest('/api/library/change', {action:'remove', ids, workspace:serializeMap()});
    applyRecoveredWorkspace(result.workspace);
    showToast(`Removed ${ids.length} paper${ids.length === 1 ? '' : 's'}. Use Undo or Recovery to restore them.`);
  } catch (error) { state.mendeleyIgnored = ignoredBefore; showToast(`Could not remove papers: ${error.message}`); }
}
async function restoreLibraryRecovery(id) {
  if (state.libraryMutation || state.clearingLibrary) return;
  try {
    const result = await libraryMutationRequest('/api/library/recovery/restore', {id, workspace:serializeMap()});
    applyRecoveredWorkspace(result.workspace);
    await refreshLibraryRecovery();
    showToast('Restored. Your previous workspace is also available in Recovery.');
  } catch (error) { showToast(`Could not restore: ${error.message}`); }
}
async function refreshLibraryRecovery() {
  await backendReady;
  const result = await pulseRecordsRequest('/api/library/recovery');
  state.libraryUndoId = result.items.find(item => !item.restoredAt)?.id || null;
  document.getElementById('libraryUndo').disabled = !state.libraryUndoId || state.libraryMutation;
  const list = document.getElementById('libraryRecoveryList');
  list.innerHTML = result.items.length ? result.items.map(item => {
    const label = item.reason === 'remove' ? 'Removed papers' : item.reason === 'clear' ? 'Cleared workspace' : 'Before workspace restore';
    return `<div class="library-recovery-item"><div><strong>${label}</strong><small>${item.count} paper${item.count === 1 ? '' : 's'} · ${escapeHtml(new Date(item.createdAt).toLocaleString())}</small></div><button class="button small secondary" type="button" data-recovery-id="${escapeHtml(item.id)}" ${item.restoredAt ? 'disabled' : ''}>${item.restoredAt ? 'Restored' : item.reason === 'remove' ? 'Restore papers' : 'Restore workspace'}</button></div>`;
  }).join('') : '<p>No recovery points yet. Removed papers and cleared workspaces will appear here.</p>';
  list.querySelectorAll('[data-recovery-id]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    await restoreLibraryRecovery(button.dataset.recoveryId);
    await refreshLibraryRecovery();
  }));
}
async function exportLibrarySelection(format) {
  const papers = libraryBulkPapers();
  if (!papers.length) return;
  await preparePaperExport(papers);
  if (format === 'ris') downloadRecordFile('pulse-selected-papers.ris', recordRis(papers), 'text/plain');
  else if (format === 'csv') {
    const columns = ['title','authors','year','date','journal','doi','pmid','volume','issue','pages','articleNumber','publisher','issn','isbn','url','language','abstract','paperKeywords','metadataSource'];
    downloadRecordFile('pulse-selected-papers.csv', [columns.map(csvCell).join(','), ...papers.map(p => columns.map(key => csvCell(p[key])).join(','))].join('\n'), 'text/csv');
  } else {
    const ids = new Set(papers.map(p => p.id));
    const payload = serializeMap();
    payload.papers = payload.papers.filter(p => ids.has(p.id));
    payload.links = payload.links.filter(link => ids.has(link.source) && ids.has(link.target));
    payload.clusters = payload.clusters.map(cluster => cluster.filter(id => ids.has(id))).filter(cluster => cluster.length);
    payload.selectedId = ids.has(payload.selectedId) ? payload.selectedId : null;
    payload.centerId = ids.has(payload.centerId) ? payload.centerId : null;
    downloadRecordFile('pulse-selected-papers.json', JSON.stringify(payload, null, 2), 'application/json');
  }
}
function tagLibrarySelection(value) {
  const tags = splitKeywords(value);
  if (!tags.length) return false;
  for (const paper of libraryBulkPapers()) paper.paperKeywords = [...new Set([...(paper.paperKeywords || []), ...tags])];
  render();
  return true;
}
document.getElementById('libraryBulkDeselect').addEventListener('click', () => {state.librarySelectedIds.clear(); renderPapers();});
document.getElementById('libraryBulkExport').addEventListener('click', () => exportLibrarySelection(document.getElementById('libraryBulkFormat').value));
document.getElementById('libraryBulkTransfer').addEventListener('click', () => {document.getElementById('managerScope').value = 'bulk'; openManagers();});
document.getElementById('libraryBulkTag').addEventListener('click', () => {document.getElementById('libraryBulkTags').value=''; document.getElementById('libraryTagDialog').showModal(); document.getElementById('libraryBulkTags').focus();});
document.getElementById('libraryTagCancel').addEventListener('click', () => document.getElementById('libraryTagDialog').close());
document.getElementById('libraryTagForm').addEventListener('submit', event => {event.preventDefault(); if(tagLibrarySelection(document.getElementById('libraryBulkTags').value)) {document.getElementById('libraryTagDialog').close(); showToast('Tags added to selected papers.');}});
document.getElementById('libraryBulkRemove').addEventListener('click', () => {document.getElementById('libraryRemoveTitle').textContent=`Remove ${libraryBulkPapers().length} selected papers?`; document.getElementById('libraryRemoveDialog').showModal();});
document.getElementById('libraryRemoveCancel').addEventListener('click', () => document.getElementById('libraryRemoveDialog').close());
document.getElementById('libraryRemoveConfirm').addEventListener('click', () => {document.getElementById('libraryRemoveDialog').close(); removePapersWithRecovery(libraryBulkPapers().map(p => p.id));});
document.getElementById('libraryUndo').addEventListener('click', () => restoreLibraryRecovery(state.libraryUndoId));
document.getElementById('libraryRecovery').addEventListener('click', async () => {document.getElementById('libraryRecoveryDialog').showModal(); try {await refreshLibraryRecovery();} catch (error) {document.getElementById('libraryRecoveryList').textContent=error.message;}});
document.getElementById('libraryRecoveryClose').addEventListener('click', () => document.getElementById('libraryRecoveryDialog').close());
backendReady.then(() => refreshLibraryRecovery()).catch(() => {});
