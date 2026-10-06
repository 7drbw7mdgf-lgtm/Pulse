          authors: paper.authors || [],
          date: paper.date || '',
          year: paper.year || '',
          journal: paper.journal || '',
          doi: paper.doi || '',
          s2PaperId: paper.s2PaperId || '',
          url: paper.url || '',
          openAccessPdf: paper.openAccessPdf || '',
          pmid: paper.pmid || '',
          openAlexId: paper.openAlexId || '',
          openAlexUrl: paper.openAlexUrl || '',
          referenceIds: paper.referenceIds || [],
          citedByIds: paper.citedByIds || [],
          citedByCount: paper.citedByCount || 0,
          influentialCitationCount: paper.influentialCitationCount,
          abstract: paper.abstract || '',
          paperKeywords: paper.paperKeywords || [],
          gemmaKeywords: paper.gemmaKeywords || [],
          keyFindings: paper.keyFindings || [],
          organisms: paper.organisms || [],
          techniques: paper.techniques || [],
          discoveryTerms: paper.discoveryTerms || [],
          keywords: mergedKeywords(paper),
          color: paper.color || '',
          areaId: paper.areaId || '',
          text: paper.text || '',
          size: paper.size || 0,
          x: paper.x || 0,
          y: paper.y || 0,
          metadataSource: paper.metadataSource || '',
          metadataNote: paper.metadataNote || ''
        })),
        links: includeDerived ? state.links.map(link => ({ ...link, score: Number(link.score.toFixed(4)) })) : [],
        clusters: includeDerived ? state.clusters : []
      };
    }

    function exportMap() {
      const payload = serializeMap();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'paper-linkage-map.json';
      anchor.click();
      URL.revokeObjectURL(url);
    }

    function listText(value) {
      return Array.isArray(value) ? value.join('; ') : String(value || '');
    }

    function applyMapPayload(data, source = 'saved library') {
      if (!data || !Array.isArray(data.papers)) return false;
      if (!data.papers.length && !(Array.isArray(data.areas) && data.areas.length) && !data.reset && source !== 'Autosaved library') return false;
      state.threshold = Math.min(0.75, Math.max(0.01, Number(data.threshold || 0.05)));
      els.threshold.value = Math.round(state.threshold * 100);
      state.mode = ['network', 'clusters', 'radial', 'table', 'timeline'].includes(data.mode) ? data.mode : 'network';
      state.workspaceView = ['discover', 'network', 'library', 'timeline'].includes(data.workspaceView) ? data.workspaceView : state.mode === 'table' ? 'library' : state.mode === 'timeline' ? 'timeline' : 'discover';
      state.linkTypeFilter = ['all', 'similarity', 'citation', 'bibliographic', 'cocitation'].includes(data.linkTypeFilter) ? data.linkTypeFilter : 'all';
      if (data.discoveryBranches) state.discoveryBranches = { ...state.discoveryBranches, ...data.discoveryBranches };
      state.explorationDepth = ['1', '2', '3', 'iterative'].includes(String(data.explorationDepth)) ? String(data.explorationDepth) : '2';
      state.pinnedSeedId = data.pinnedSeedId || null;
      state.explicitLinks = (data.explicitLinks || data.links || []).filter(link => link.source && link.target && Number.isFinite(Number(link.score))).map(link => ({ ...link, score: Number(link.score) }));
      state.paperView = data.paperView || state.paperView || 'compact';
      state.filterTags = Array.isArray(data.filterTags) ? data.filterTags : [];
      state.filterMode = data.filterMode || 'all';
      state.recommendationSteerKeywords = parseSteerKeywords(listText(data.recommendationSteerKeywords));
      state.recommendationExcludeKeywords = parseSteerList(listText(data.recommendationExcludeKeywords), 16);
      state.recommendationAuthors = parseSteerList(listText(data.recommendationAuthors), 10);
      state.recommendationJournals = parseSteerList(listText(data.recommendationJournals), 10);
      state.graphSteerKeywords = parseSteerList(listText(data.graphSteerKeywords), 12);
      state.recommendationRecencyTilt = Number(data.recommendationRecencyTilt || 0);
      state.recommendationImpactTilt = Number(data.recommendationImpactTilt || 0);
      if (data.graphStyle && typeof data.graphStyle === 'object') {
        state.graphStyle = {
          ...state.graphStyle,
          nodeSize: Math.max(14, Math.min(42, Number(data.graphStyle.nodeSize || state.graphStyle.nodeSize))),
          edgeScale: Math.max(0.25, Math.min(1.8, Number(data.graphStyle.edgeScale || state.graphStyle.edgeScale))),
          spacing: Math.max(0.35, Math.min(4, Number(data.graphStyle.spacing || state.graphStyle.spacing))),
          labelMode: ['short', 'full', 'keywords', 'none'].includes(data.graphStyle.labelMode) ? data.graphStyle.labelMode : state.graphStyle.labelMode,
          showGrid: data.graphStyle.showGrid !== false,
          showAreas: data.graphStyle.showAreas !== false
        };
      }
      state.centerId = data.centerId || null;
      state.selectedId = data.selectedId || null;
      state.selectedAreaId = data.selectedAreaId || null;
      if (data.view && typeof data.view.x === 'number' && typeof data.view.y === 'number') {
        state.view = {
          x: data.view.x,
          y: data.view.y,
          width: Number(data.view.width || state.view.width),
          height: Number(data.view.height || state.view.height)
        };
      }
      state.areas = Array.isArray(data.areas) ? data.areas.map((area, index) => ({
        id: area.id || uid(),
        name: cleanField(area.name || `Area ${index + 1}`),
        color: area.color || palette[index % palette.length],
        x: Number(area.x || 80 + index * 28),
        y: Number(area.y || 80 + index * 22),
        width: Number(area.width || 260),
        height: Number(area.height || 170)
      })) : [];
      state.papers = data.papers.map(paper => normalizeImportedPaper({
        ...paper,
        paperKeywords: paper.paperKeywords || paper.keywords || [],
        text: paper.text || paper.fullText || paper.abstract || ''
      }, source));
      document.querySelectorAll('[data-mode]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.mode === state.mode);
      });
      syncDensityButtons();
      return true;
    }

    async function restoreLibrary() {
      let backendResponded = false;
      try {
        const response = await fetch(backendUrl('/api/library'), { headers: apiHeaders() });
        if (response.ok) {
          const data = await response.json();
          if (data && Array.isArray(data.papers)) {
            backendResponded = true;
            if (data.papers.length > 0) {
              if (applyMapPayload(data, 'Autosaved library')) {
                showToast(`Restored ${state.papers.length} saved paper${state.papers.length === 1 ? '' : 's'}.`);
                return true;
              }
            } else {
              // The library is explicitly empty on disk (reset or fresh workspace)
              state.papers = [];
              state.links = [];
              state.clusters = [];
              state.areas = [];
              try {
                localStorage.removeItem('pulse-autosave-library');
                localStorage.removeItem('iratxe-autosave-library');
              } catch (e) {}
              render();
              updateMetrics();
              return true;
            }
          }
        }
      } catch (e) {}

      // Fallback to localStorage ONLY if backend was completely unreachable
      if (!backendResponded) {
        try {
          const raw = localStorage.getItem('pulse-autosave-library') || localStorage.getItem('iratxe-autosave-library');
          if (raw) {
            const data = JSON.parse(raw);
            if (Array.isArray(data.papers) && data.papers.length > 0) {
              if (applyMapPayload(data, 'Autosaved library')) {
                showToast(`Restored ${state.papers.length} paper${state.papers.length === 1 ? '' : 's'} from local storage.`);
                saveLibrary();
                return true;
              }
            }
          }
        } catch (e) {}
      }
      return false;
    }

    function scheduleAutosave() {
      if (!state.autosaveReady) return;
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = setTimeout(saveLibrary, 800);
    }

    const saveSession=window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    let saveRevision=0, saveLoop=null, pendingSave=null, lastRemoteSave='', saveStatusTimer=null;
    function libraryPayload() {
      const payload={...serializeMap({includeDerived:false}),paperView:state.paperView,centerId:state.centerId,selectedId:state.selectedId,selectedAreaId:state.selectedAreaId};
      delete payload.generatedAt;
      return payload;
    }
    function saveLibrary() {
      if(!state.autosaveReady)return Promise.resolve();
      const payload=libraryPayload(), signature=JSON.stringify(payload);
      if(signature===lastRemoteSave && !pendingSave && !saveLoop)return Promise.resolve();
      pendingSave={payload,signature,revision:++saveRevision};
      if(saveLoop)return saveLoop;
      saveLoop=(async()=>{
        while(pendingSave) {
          const item=pendingSave;pendingSave=null;
          const body=JSON.stringify({...item.payload,_saveSession:saveSession,_saveRevision:item.revision});
          let localSaved=false;
          try{localStorage.setItem('pulse-autosave-library',body);localSaved=true;}catch(_){}
          clearTimeout(saveStatusTimer);updateSaveStatePill('Saving…');
          try {
            const response=await fetch(backendUrl('/api/library'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body});
            if(!response.ok)throw new Error('Library save failed');
            lastRemoteSave=item.signature;updateSaveStatePill('Saved');
            saveStatusTimer=setTimeout(()=>updateSaveStatePill('Ready'),1800);
          } catch(_) {
            updateSaveStatePill(localSaved?'Saved locally · backend unavailable':'Save failed · export a backup');
            if(!localSaved)showToast('Your changes could not be saved. Export a backup before closing Pulse.');
          }
        }
      })().finally(()=>{saveLoop=null;});
      return saveLoop;
    }

    function saveLibrarySync() {
      if(!state.autosaveReady)return;
      const payload={...libraryPayload(),_saveSession:saveSession,_saveRevision:++saveRevision};
      pendingSave=null; // A queued older snapshot must not follow the final unload snapshot.
      const body=JSON.stringify(payload);
      try{localStorage.setItem('pulse-autosave-library',body);}catch(_){}
      try{navigator.sendBeacon?.(backendNavigationUrl('/api/library'),new Blob([body],{type:'application/json'}));}catch(_){}
    }

    async function promptClearLibrary() {
      const count = state.papers.length;
      if (!count) {
        showToast('Library is already empty.');
        return;
      }
      const confirmed = window.confirm(
        `Clear all ${count} paper${count === 1 ? '' : 's'} from the library?\n\nThis will remove all papers, extracted findings, custom tags, and graph linkages.`
      );
      if (!confirmed) return;
      await clearAppToDefault(true);
      showToast('Workspace reset to empty default.');
    }

    async function clearAppToDefault(skipConfirm = false) {
      if (!skipConfirm) {
        const confirmed = window.confirm(
          'Are you sure you want to clear the app to default?\n\nThis will remove all loaded papers, bibliography entries, tags, and graph linkages.'
        );
        if (!confirmed) return;
      }

      if(state.discoveryLoading)cancelDiscovery();
      state.discoveryStatus='';state.discoveryWarnings=[];
      pendingSave=null;lastRemoteSave='';
      // 1. Immediately cancel any scheduled autosave
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;

      // 2. Clear all in-memory workspace data
      state.papers = [];
      state.links = [];
      state.explicitLinks = [];
      state.librarySearch = '';
      if (els.tagFilterSearchInput) els.tagFilterSearchInput.value = '';
      state.clusters = [];
      state.areas = [];
      state.selectedId = null;
      state.centerId = null;
      state.selectedAreaId = null;
      state.selectedLinkId = null;
      state.filterTags = [];
      state.filterMode = 'all';
      state.tableFilters = {};
      state.recommendations = new Map();
      state.seminalSuggestions = [];
      state.recommendationLoadingKey = null;
      state.citationLoading = false;
      state.discoveryLoading = false;
      state.discoveryResults = [];
      state.discoveryHasRun = false;
      state.discoveryError = '';
      state.workspaceView = 'discover';
      state.mode = 'network';
      state.inspectorOpen = false;
      state.discoverySeed = null;
      state.pinnedSeedId = null;
      state.discoverySelectedKeys = new Set();
      state.recommendationSteerKeywords = [];
      state.librarySearch = '';
      state.recommendationExcludeKeywords = [];
      state.recommendationAuthors = [];
      state.recommendationJournals = [];
      state.graphSteerKeywords = [];

      // 3. Reset browser local storage
      let resetLocalSaved=false,resetRemoteSaved=false;
      try {
        localStorage.removeItem('pulse-autosave-library');
        localStorage.removeItem('iratxe-autosave-library');
        localStorage.setItem('pulse-autosave-library', JSON.stringify({
          format: 'pulse-map',
          version: '1.3.0',
          papers: [],
          areas: []
        }));
        resetLocalSaved=true;
      } catch (e) {}

      // 4. Reset backend storage & remove old snapshots
      updateSaveStatePill('Resetting...');
      try {
        const resetResponse=await fetch(backendUrl('/api/library'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            reset: true,
            _saveSession:saveSession,
            _saveRevision:++saveRevision,
            papers: [],
            areas: [],
            format: 'pulse-map',
            version: '1.3.0',
            savedAt: new Date().toISOString()
          })
        });
        if(!resetResponse.ok)throw new Error('Reset could not be saved');
        resetRemoteSaved=true;
      } catch (e) {
        console.error('Failed to notify backend of library reset:', e);
      }
      updateSaveStatePill(resetRemoteSaved?'Ready':resetLocalSaved?'Reset saved locally · backend unavailable':'Reset could not be saved');

      // 5. Hide all popups & inspector panels
      if (els.settingsPanel) els.settingsPanel.hidden = true;
      if (els.keywordModal) els.keywordModal.hidden = true;
      if (els.tagActionMenu) els.tagActionMenu.hidden = true;
      if (els.tagFilterDropdown) els.tagFilterDropdown.hidden = true;
      if (els.details) els.details.hidden = true;

      // 6. Rerender all views to clean state
      render();
      renderPapers();
      renderDetails();
      renderAreasPanel();
      renderLinkages();
      if (state.mode === 'table') {
        renderTableView();
      }
      updateMetrics();
      showToast('Workspace reset to empty default.');
    }

    async function addPaperFromInput(input) {
      const trimmed = (input || '').trim();
      if (!trimmed) return;
      const duplicate = state.papers.find(paper => paperIdentityKey(paper) === paperIdentityKey({ title: trimmed, doi: normalizeDoi(trimmed) }));
      if (duplicate) {
        state.selectedId = duplicate.id;
        render();
        showToast('That paper is already in your library.');
        return;
      }
      const doi = normalizeDoi(trimmed);
