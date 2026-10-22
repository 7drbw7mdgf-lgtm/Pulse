/* Library autosave: snapshots, save loop, status and clearing papers. */
    function scheduleAutosave() {
      if (!state.autosaveReady) return;
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = setTimeout(saveLibrary, 800);
    }

    let librarySaveLoop = null, librarySaveRequested = false, librarySaveStatusTimer = null;
    let libraryRemoteSnapshot = null, libraryRemoteToken = '', libraryRemoteRevision = 0;
    let libraryFailedSnapshot = null, libraryBeaconRevision = 0, libraryConflictRevision = null;
    let libraryLocalSnapshot = null, libraryLatestSnapshot = null;
    const libraryPaperJsonCache = new Map();
    function resetLibrarySaveBaseline() {
      libraryRemoteSnapshot = null; libraryRemoteToken = ''; libraryRemoteRevision = 0;
      libraryFailedSnapshot = null; libraryConflictRevision = null;
    }
    function libraryPaperSnapshot(paper) {
      const values = Object.entries(paper).flatMap(([key,value]) => [key,
        value && typeof value === 'object' ? JSON.stringify(value) : value]);
      const previous = libraryPaperJsonCache.get(paper.id);
      if (previous && values.length === previous.values.length && values.every((value,index) => Object.is(value,previous.values[index]))) return previous;
      const json = JSON.stringify(paper);
      if (previous && previous.json === json) { previous.values = values; return previous; }
      const entry = {id:paper.id, values, json}; libraryPaperJsonCache.set(paper.id,entry); return entry;
    }
    function librarySaveSnapshot() {
      if (state.papers.length) state.allowEmptySave = false;
      const payload = {...serializeMap(), paperView:state.paperView, centerId:state.centerId,
        selectedId:state.selectedId, selectedAreaId:state.selectedAreaId, allowEmpty:state.allowEmptySave === true};
      // Timestamps and transport revisions do not make unchanged content dirty.
      for (const key of ['generatedAt','savedAt','_saveSession','_saveRevision','_storageRevision']) delete payload[key];
      const papers = payload.papers.map(libraryPaperSnapshot), ids = new Set(papers.map(paper => paper.id));
      for (const id of libraryPaperJsonCache.keys()) if (!ids.has(id)) libraryPaperJsonCache.delete(id);
      delete payload.papers;
      const fields = new Map();
      for (const [key,value] of Object.entries(payload)) {
        const json = JSON.stringify(value); if (json !== undefined) fields.set(key,json);
      }
      const rootJson = [...fields].map(([key,json]) => `${JSON.stringify(key)}:${json}`).join(',');
      return libraryLatestSnapshot = {papers, fields, rootJson, byId:new Map(papers.map(paper => [paper.id,paper])),
        validIds:ids.size === papers.length && papers.every(paper => typeof paper.id === 'string' && paper.id.length > 0)};
    }
    function sameLibrarySnapshot(left, right) {
      return Boolean(left && right && left.rootJson === right.rootJson && left.papers.length === right.papers.length
        && left.papers.every((paper,index) => paper === right.papers[index]));
    }
    function librarySaveItem(snapshot) {
      const session = state.librarySaveSession ||= uid();
      const previousRevision = state.librarySaveRevision || 0;
      // Clear/remove/recovery writes increment this counter outside the save loop.
      if (previousRevision !== libraryRemoteRevision) libraryRemoteToken = '';
      if (libraryConflictRevision !== null && previousRevision > libraryConflictRevision) resetLibrarySaveBaseline();
      const revision = state.librarySaveRevision = previousRevision + 1;
      const prefix = `"_saveSession":${JSON.stringify(session)},"_saveRevision":${revision},`;
      const body = `{${prefix}${snapshot.rootJson},"papers":[${snapshot.papers.map(paper => paper.json).join(',')}]}`;
      let requestBody = body, delta = false;
      if (libraryRemoteToken && libraryRemoteSnapshot && snapshot.validIds && libraryRemoteSnapshot.validIds) {
        const changed = snapshot.papers.filter(paper => libraryRemoteSnapshot.byId.get(paper.id) !== paper);
        const removed = libraryRemoteSnapshot.papers.filter(paper => !snapshot.byId.has(paper.id)).map(paper => paper.id);
        const fields = [...snapshot.fields].filter(([key,json]) => libraryRemoteSnapshot.fields.get(key) !== json)
          .map(([key,json]) => `${JSON.stringify(key)}:${json}`).join(',');
        const missing = [...libraryRemoteSnapshot.fields.keys()].filter(key => !snapshot.fields.has(key));
        const patch = `{${prefix}"_saveMode":"paper-delta-v1","_baseStorageRevision":${JSON.stringify(libraryRemoteToken)},`
          + `"upsertPapers":[${changed.map(paper => paper.json).join(',')}],"removePaperIds":${JSON.stringify(removed)},`
          + `"paperOrder":${JSON.stringify(snapshot.papers.map(paper => paper.id))},"workspaceChanges":{${fields}},"removeWorkspaceKeys":${JSON.stringify(missing)}}`;
        if (patch.length < body.length * .8) { requestBody = patch; delta = true; }
      }
      return {snapshot, revision, body, requestBody, delta};
    }
    function librarySaveStatus(label) {
      if (!state.clearingLibrary && !state.libraryMutation) updateSaveStatePill(label);
    }
    function cacheLibrarySave(item) {
      if (item.snapshot && sameLibrarySnapshot(item.snapshot,libraryLocalSnapshot)) return true;
      try { localStorage.setItem('pulse-autosave-library',item.body); libraryLocalSnapshot = item.snapshot; return true; } catch (_) { return false; }
    }
    function saveLibrary() {
      if (!state.autosaveReady) return Promise.resolve(false);
      librarySaveRequested = true; clearTimeout(librarySaveStatusTimer);
      if (librarySaveLoop) return librarySaveLoop;
      const previous = state.libraryWriteQueue || Promise.resolve();
      const drain = async () => {
        let saved = false, local = false, conflict = false;
        while (librarySaveRequested) {
          librarySaveRequested = false;
          const snapshot = librarySaveSnapshot();
          if (sameLibrarySnapshot(snapshot,libraryRemoteSnapshot) && !sameLibrarySnapshot(snapshot,libraryFailedSnapshot)
            && libraryConflictRevision === null && (state.librarySaveRevision || 0) === libraryRemoteRevision) { saved = true; continue; }
          if (libraryConflictRevision !== null && (state.librarySaveRevision || 0) <= libraryConflictRevision) {
            const body = `{${snapshot.rootJson},"papers":[${snapshot.papers.map(paper => paper.json).join(',')}]}`;
            local = cacheLibrarySave({body,snapshot}); conflict = true; saved = false; continue;
          }
          const item = librarySaveItem(snapshot);
          local = cacheLibrarySave(item); librarySaveStatus('Saving...');
          try {
            const response = await fetch(backendUrl('/api/library'), {
              method:'POST', headers:apiHeaders({'Content-Type':'application/json'}),
              body:item.requestBody, signal:AbortSignal.timeout(15000)
            });
            const result = typeof response.json === 'function' ? await response.json() : {};
            if (!response.ok || result.ok === false) {
              if (item.delta && response.status === 409) { libraryConflictRevision = item.revision; conflict = true; }
              throw new Error(result.error || 'The library could not be saved.');
            }
            saved = item.revision > libraryBeaconRevision && result.superseded !== true;
            if (saved) {
              libraryRemoteSnapshot = snapshot; libraryRemoteRevision = item.revision; libraryFailedSnapshot = null;
              libraryRemoteToken = result.deltaSupported === true && typeof result.storageRevision === 'string'
                && /^[a-f0-9]{32}$/.test(result.storageRevision) ? result.storageRevision : '';
            }
          } catch (_) { libraryFailedSnapshot = snapshot; saved = false; libraryRemoteToken = ''; }
        }
        return {saved,local,conflict};
      };
      const loop = previous.catch(() => {}).then(drain).catch(() => ({saved:false,local:false,conflict:false})).then(async outcome => {
        // Requests arriving at the completion boundary still join this batch.
        while (librarySaveRequested) {
          try { outcome = await drain(); } catch (_) { librarySaveRequested = false; outcome = {saved:false,local:false,conflict:false}; }
        }
        librarySaveLoop = null; state.pendingLibraryWrites.delete(loop);
        outcome.local = sameLibrarySnapshot(libraryLatestSnapshot,libraryLocalSnapshot);
        librarySaveStatus(outcome.conflict ? (outcome.local ? 'Save conflict · saved locally' : 'Save conflict · save failed')
          : outcome.saved ? 'Saved' : outcome.local ? 'Saved locally' : 'Save failed');
        if (outcome.saved) librarySaveStatusTimer = setTimeout(() => {
          if (!librarySaveLoop && !librarySaveRequested) librarySaveStatus('Ready');
        },1800);
        return outcome.saved;
      });
      librarySaveLoop = loop; state.libraryWriteQueue = loop;
      state.pendingLibraryWrites ||= new Set(); state.pendingLibraryWrites.add(loop);
      return loop;
    }

    function saveLibrarySync() {
      if (!state.autosaveReady) return;
      const snapshot = librarySaveSnapshot();
      if (!librarySaveLoop && sameLibrarySnapshot(snapshot,libraryRemoteSnapshot) && !sameLibrarySnapshot(snapshot,libraryFailedSnapshot)
        && (state.librarySaveRevision || 0) === libraryRemoteRevision) return;
      librarySaveRequested = false;
      if (libraryConflictRevision !== null && (state.librarySaveRevision || 0) <= libraryConflictRevision) {
        cacheLibrarySave({body:`{${snapshot.rootJson},"papers":[${snapshot.papers.map(paper => paper.json).join(',')}]}`,snapshot}); return;
      }
      const item = librarySaveItem(snapshot); libraryBeaconRevision = item.revision;
      const local = cacheLibrarySave(item);
      // A confirmed idle baseline permits a small final delta. An active write
      // could invalidate that baseline, so overlapping unloads stay self-contained.
      let sent = false;
      try { sent = navigator.sendBeacon?.(backendUrl('/api/library'),new Blob([librarySaveLoop ? item.body : item.requestBody],{type:'application/json'})) === true; } catch (_) {}
      if (!sent) libraryFailedSnapshot = snapshot;
      librarySaveStatus(local ? 'Saved locally' : sent ? 'Saving...' : 'Save failed');
    }

    async function promptClearLibrary() {
      const count = state.papers.length;
      if (!count) {
        showToast('Library is already empty.');
        return;
      }
      const confirmed = await confirmClearPapers(count);
      if (!confirmed) return;
      await clearAppToDefault(true);
    }

    function confirmClearPapers(count) {
      const dialog = document.getElementById('clearPapersDialog');
      if (dialog.open) return Promise.resolve(false);
      document.getElementById('clearPapersTitle').textContent = `Clear all ${count} paper${count === 1 ? '' : 's'}?`;
      const cancel = document.getElementById('clearPapersCancel');
      const confirm = document.getElementById('clearPapersConfirm');
      return new Promise(resolve => {
        const finish = value => {
          dialog.close();
          cancel.removeEventListener('click', onCancel);
          confirm.removeEventListener('click', onConfirm);
          dialog.removeEventListener('cancel', onEscape);
          const menu = document.getElementById('libraryActionsMenu');
          if (menu) menu.querySelector('summary')?.focus();
          else els.clearButton?.focus();
          resolve(value);
        };
        const onCancel = () => finish(false);
        const onConfirm = () => finish(true);
        const onEscape = event => { event.preventDefault(); finish(false); };
        cancel.addEventListener('click', onCancel);
        confirm.addEventListener('click', onConfirm);
        dialog.addEventListener('cancel', onEscape);
        dialog.showModal();
        cancel.focus();
      });
    }
