/* Settings → Sync & privacy: encrypted between-computer sync controls, and local problem reports. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const sync = { running: false, timer: null, state: null, codeShown: false };

  async function localApi(path, payload) {
    await backendReady;
    const response = await fetch(backendUrl(path), { headers: apiHeaders(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(120000) });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) { const error = new Error(data.error || 'The request failed.'); error.status = response.status; throw error; }
    return data;
  }

  // ---- Sync ---------------------------------------------------------------

  const io = {
    relay: (op, body) => localApi('/api/sync/relay', { op, body }),
    loadState: () => localApi('/api/sync/state'),
    saveState: patch => localApi('/api/sync/state', patch),
    removePapers: async ids => { if (typeof removePapersWithRecovery === 'function') await removePapersWithRecovery(ids); },
    newPaper: view => { const paper = normalizeImportedPaper({ ...view }, view.metadataSource || 'Sync'); state.papers.push(paper); return paper; },
    workspace: () => ({ maps: JSON.parse(JSON.stringify(state.maps || [])) }),
    setWorkspace: value => { if (Array.isArray(value?.maps) && value.maps.length) { state.maps = value.maps; if (typeof renderMapTabs === 'function') renderMapTabs(); } }
  };

  function userIsEditing() {
    const active = document.activeElement;
    return Boolean(active && /^(TEXTAREA|INPUT)$/.test(active.tagName) && active.closest('#details, .inspector, .library-panel, [data-paper]'));
  }

  async function syncLibrary({ manual = false } = {}) {
    if (sync.running || !state.autosaveReady || state.libraryMutation || state.clearingLibrary) return null;
    if (!manual && userIsEditing()) return null;  // never change a note while it is being typed
    sync.running = true; renderSyncStatus('Syncing…');
    let summary = null;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { summary = await runLibrarySync(io, () => state.papers); break; }
        catch (error) { if (error.status !== 409 || attempt) throw error; }  // another computer pushed at the same moment
      }
      if (summary && !summary.skipped && (summary.added || summary.updated || summary.removed)) {
        if (typeof render === 'function') render();
        if (typeof scheduleAutosave === 'function') scheduleAutosave();
        const parts = [summary.added && `${summary.added} added`, summary.updated && `${summary.updated} updated`, summary.removed && `${summary.removed} removed`].filter(Boolean);
        if (manual || parts.length) showToast(`Synced from your other computer: ${parts.join(', ')}.`);
      } else if (manual && summary && !summary.skipped) showToast('Library is up to date on this computer.');
      if (summary && !summary.skipped && typeof scheduleAutosave === 'function') scheduleAutosave();  // new sync IDs are saved
      sync.state = await localApi('/api/sync/state');
    } catch (error) {
      try { await localApi('/api/sync/state', { lastError: error.message }); } catch (_) {}
      if (manual) showToast(`Sync failed: ${error.message}`);
      sync.state = { ...(sync.state || {}), lastError: error.message };
    } finally {
      sync.running = false; renderSyncStatus();
    }
    return summary;
  }

  function renderSyncStatus(busy) {
    const s = sync.state || {}, on = Boolean(s.enabled);
    $('syncOffControls').hidden = on; $('syncOnControls').hidden = !on;
    if (on) { $('syncJoinRow').hidden = true; $('syncJoinActions').hidden = true; }
    const when = s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'not yet';
    $('syncStatusText').textContent = busy || (!s.relayUrl ? 'Sync is not available in this build.' : on
      ? (s.lastError ? `Sync is on. Last attempt failed: ${s.lastError}` : `Sync is on. Last synced ${when}.`)
      : 'Sync is off.');
    $('syncStartButton').disabled = !s.relayUrl; $('syncJoinToggle').disabled = !s.relayUrl;
    $('syncCodeText').hidden = !sync.codeShown; $('syncCopyCodeButton').hidden = !sync.codeShown;
    $('syncShowCodeButton').textContent = sync.codeShown ? 'Hide code' : 'Show code';
    if (sync.codeShown && s.code) $('syncCodeText').textContent = formatSyncCode(s.code);
  }

  async function enableSync(code) {
    await localApi('/api/sync/state', { code: normalizeSyncCode(code), lastSeq: 0, base: {}, lastError: '' });
    sync.state = await localApi('/api/sync/state');
    const summary = await syncLibrary({ manual: true });
    startTimer();
    return summary;
  }

  function startTimer() {
    clearInterval(sync.timer);
    sync.timer = setInterval(() => { if (sync.state?.enabled && !document.hidden) syncLibrary(); }, 60000);
  }

  function bindSync() {
    $('syncStartButton').addEventListener('click', async () => {
      const code = newSyncCode();
      try { await enableSync(code); sync.codeShown = true; renderSyncStatus(); showToast('Sync is on. Enter the code shown on your other computer.'); }
      catch (error) { showToast(error.message); }
    });
    $('syncJoinToggle').addEventListener('click', () => { $('syncJoinRow').hidden = false; $('syncJoinActions').hidden = false; $('syncJoinInput').focus(); });
    $('syncJoinButton').addEventListener('click', async () => {
      const value = $('syncJoinInput').value;
      try { decodeSyncCode(value); } catch (error) { showToast(error.message); return; }
      $('syncJoinButton').disabled = true;
      try { await enableSync(value); $('syncJoinInput').value = ''; }
      catch (error) { showToast(error.message); }
      finally { $('syncJoinButton').disabled = false; }
    });
    $('syncNowButton').addEventListener('click', () => syncLibrary({ manual: true }));
    $('syncShowCodeButton').addEventListener('click', () => { sync.codeShown = !sync.codeShown; renderSyncStatus(); });
    $('syncCopyCodeButton').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(formatSyncCode(sync.state.code)); showToast('Sync code copied.'); } catch (_) { showToast('Select the code and copy it.'); }
    });
    $('syncOffButton').addEventListener('click', async () => {
      await localApi('/api/sync/forget', {}); clearInterval(sync.timer); sync.codeShown = false;
      sync.state = await localApi('/api/sync/state'); renderSyncStatus(); showToast('Sync is off on this computer. Your library here is unchanged.');
    });
    $('syncEraseButton').addEventListener('click', async () => {
      if (!window.confirm('Erase the synced copy from Pulse’s relay? Your other computers keep their libraries but stop syncing until sync is turned on again.')) return;
      try {
        const keys = await deriveSyncKeys(sync.state.code);
        await io.relay('erase', { vault: keys.vault, auth: keys.auth });
        await localApi('/api/sync/forget', {}); clearInterval(sync.timer); sync.codeShown = false;
        sync.state = await localApi('/api/sync/state'); renderSyncStatus(); showToast('The cloud copy is erased and sync is off.');
      } catch (error) { showToast(`Could not erase: ${error.message}`); }
    });
    window.addEventListener('focus', () => { if (sync.state?.enabled) syncLibrary(); });
  }

  // ---- Problem reports ----------------------------------------------------

  const reports = { current: null };
  let reportingError = false;
  function captureError(errorType, message, stack, source) {
    if (reportingError) return;
    reportingError = true;
    localApi('/api/crash-reports/record', { errorType, message: String(message || ''), stack: String(stack || ''), source, view: state.activeView || state.mode || '' })
      .then(refreshReports).catch(() => {}).finally(() => { setTimeout(() => { reportingError = false; }, 2000); });
  }
  window.addEventListener('error', event => {
    if (!event.error && event.target !== window) return;  // a failed image or script load, not a code error
    captureError(event.error?.name || 'Error', event.message, event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`, 'window.onerror');
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    if (reason && (reason.name === 'AbortError' || reason.name === 'TimeoutError')) return;
    captureError(reason?.name || 'UnhandledRejection', reason?.message || reason, reason?.stack || '', 'unhandledrejection');
  });

  async function refreshReports() {
    let data;
    try { data = await localApi('/api/crash-reports'); } catch (_) { return; }
    const list = $('crashReportList');
    list.innerHTML = data.reports.length ? data.reports.map(item => `<li><span>${escapeHtml(new Date(item.createdAt).toLocaleString())} · ${escapeHtml(item.errorType || item.kind)}${item.repeats > 1 ? ` ×${item.repeats}` : ''} · ${item.sent ? 'sent' : 'not sent'}</span><button type="button" class="mac-btn" data-report="${escapeHtml(item.id)}">View</button></li>`).join('')
      : '<li class="subtle">No problems recorded.</li>';
    list.querySelectorAll('[data-report]').forEach(button => button.addEventListener('click', () => openReport(button.dataset.report)));
    const unsent = data.reports.filter(item => !item.sent && !item.dismissed);
    $('crashNotice').hidden = !unsent.length;
    if (unsent.length) {
      $('crashNoticeText').textContent = unsent.length === 1 ? 'Pulse recorded a problem.' : `Pulse recorded ${unsent.length} problems.`;
      $('crashNoticeView').dataset.report = unsent[0].id;
    }
  }

  async function openReport(id) {
    try {
      const { report } = await localApi('/api/crash-reports/get', { id });
      reports.current = report;
      $('crashReportBody').textContent = JSON.stringify(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'sent')), null, 2);
      $('crashReportSend').disabled = Boolean(report.sent);
      $('crashReportSend').textContent = report.sent ? 'Already sent' : 'Send report';
      $('crashReportFeedback').textContent = '';
      $('crashReportDialog').showModal();
    } catch (error) { showToast(error.message); }
  }

  function bindReports() {
    $('crashReportClose').addEventListener('click', () => $('crashReportDialog').close());
    $('crashReportSend').addEventListener('click', async () => {
      $('crashReportSend').disabled = true; $('crashReportFeedback').textContent = 'Sending…';
      try { await localApi('/api/crash-reports/send', { id: reports.current.id }); $('crashReportFeedback').textContent = 'Sent. Thank you.'; $('crashReportSend').textContent = 'Already sent'; }
      catch (error) { $('crashReportFeedback').textContent = error.message; $('crashReportSend').disabled = false; }
      refreshReports();
    });
    $('crashReportDelete').addEventListener('click', async () => {
      try { await localApi('/api/crash-reports/delete', { id: reports.current.id }); $('crashReportDialog').close(); refreshReports(); } catch (error) { showToast(error.message); }
    });
    $('crashReportsDeleteAll').addEventListener('click', async () => { await localApi('/api/crash-reports/delete', { all: true }); refreshReports(); });
    $('crashReportsRefresh').addEventListener('click', refreshReports);
    $('crashNoticeView').addEventListener('click', () => openReport($('crashNoticeView').dataset.report));
    $('crashNoticeDismiss').addEventListener('click', async () => { await localApi('/api/crash-reports/dismiss', {}); refreshReports(); });
  }

  async function init() {
    bindSync(); bindReports();
    try { sync.state = await localApi('/api/sync/state'); } catch (_) { sync.state = {}; }
    renderSyncStatus();
    refreshReports();
    if (sync.state.enabled) { startTimer(); setTimeout(() => syncLibrary(), 4000); }
  }
  window.syncLibrary = syncLibrary;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
