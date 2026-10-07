
    async function clearAppToDefault(skipConfirm = false) {
      if (!skipConfirm) {
        const confirmed = window.confirm(
          'Are you sure you want to clear the app to default?\n\nThis will remove all loaded papers, bibliography entries, tags, and graph linkages.'
        );
        if (!confirmed) return;
      }

      // 1. Immediately cancel any scheduled autosave
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
      pendingSave = null;
      const resetRevision = ++saveRevision;

      // 2. Clear all in-memory workspace data
      state.papers = [];
      state.links = [];
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
      state.discoverySeed = null;
      state.discoverySelectedKeys = new Set();
      state.recommendationSteerKeywords = [];
      state.recommendationExcludeKeywords = [];
      state.recommendationAuthors = [];
      state.recommendationJournals = [];
      state.graphSteerKeywords = [];

      let localReset = false;
      let backendReset = false;
      // 3. Reset browser local storage
      try {
        localStorage.removeItem('pulse-autosave-library');
        localStorage.removeItem('iratxe-autosave-library');
        localStorage.setItem('pulse-autosave-library', JSON.stringify({
          format: 'pulse-map',
          version: '1.0',
          papers: [],
          areas: []
        }));
        localReset = true;
      } catch (error) { console.warn('Local reset unavailable:', error.name); }

      // 4. Reset backend storage & remove old snapshots
      updateSaveStatePill('Resetting...');
      try {
        const response = await fetch(backendUrl('/api/library'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            reset: true,
            _saveSession: saveSession,
            _saveRevision: resetRevision,
            papers: [],
            areas: [],
            format: 'pulse-map',
            version: '1.0',
            savedAt: new Date().toISOString()
          })
        });
        if (!response.ok) throw new Error('Library reset failed');
        lastRemoteSave = '';
        backendReset = true;
      } catch (e) {
        updateSaveStatePill('Reset saved locally · backend unavailable');
        console.error('Failed to notify backend of library reset:', e);
      }
      updateSaveStatePill(backendReset ? 'Ready' : localReset ? 'Reset saved locally · backend unavailable' : 'Reset not saved');

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
      showToast(backendReset ? 'Workspace reset to empty default.' : localReset ? 'Workspace cleared locally. Backend reset failed; retry before closing.' : 'Reset could not be saved. Retry before closing.');
    }

    async function addPaperFromInput(input) {
      const trimmed = (input || '').trim();
      if (!trimmed) return;
      const doi = normalizeDoi(trimmed);
      const existing = state.papers.find(paper => doi ? sameDoi(paper.doi,doi) : cleanField(paper.title).toLowerCase() === trimmed.toLowerCase());
      if (existing) {state.selectedId=existing.id;render();showToast('This paper is already in your library.');return;}
      const pmid = trimmed.match(/^(?:PMID\s*:\s*)?(\d{1,10})$/i) || trimmed.match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
      if (pmid) {
        const duplicate=state.papers.find(paper=>String(paper.pmid || '')===pmid[1]);
        if (duplicate) {state.selectedId=duplicate.id;render();showToast('This paper is already in your library.');return;}
        try {
          const response=await fetch(backendUrl('/api/metadata/pmid'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({pmid:pmid[1]})});
          const result=await response.json();
          if (!response.ok) throw new Error(result.error || 'PubMed lookup failed');
          const paper=normalizeImportedPaper(result.metadata,'PubMed');
          addParsedPapers([paper]);state.selectedId=state.papers.find(item=>item.pmid===paper.pmid)?.id || paper.id;render();showToast(`Added: ${compactTitle(paper.title)}`);
        } catch(error) {console.warn('PubMed lookup failed:',error.name);showToast(error.message);}
        return;
      }
      if (doi) {
        showToast(`Looking up DOI ${doi}...`);
        const paper = normalizeImportedPaper({
          name: `DOI ${doi}`,
          title: `Paper (${doi})`,
          doi: doi
        }, 'DOI');
        state.papers.push(paper);
        state.selectedId = paper.id;
        render();
        const ok = await enrichPaperFromDoi(paper, doi);
        if (ok) {
          showToast(`Added: ${compactTitle(paper.title)}`);
        } else {
          showToast(`Added DOI ${doi}`);
        }
        render();
      } else {
        const paper = normalizeImportedPaper({
          name: trimmed,
          title: trimmed,
          text: trimmed,
          paperKeywords: splitKeywords(trimmed)
        }, 'Manual');
        state.papers.push(paper);
        state.selectedId = paper.id;
        showToast(`Added: ${compactTitle(paper.title)}`);
        render();
      }
    }

    function csvCell(value) {
      const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
      return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    }

    function exportSummaryTable() {
      const headers = [
        'Title',
        'Authors',
        'Year',
        'Date',
        'Journal',
        'DOI',
        'Abstract',
        'Key findings',
        'Keywords',
        'Colour',
        'Area',
        'Links',
        'Strongest linked papers',
        'Metadata source',
        'File'
      ];
      const rows = state.papers.map(paper => {
        const related = state.links
          .filter(link => link.source === paper.id || link.target === paper.id)
          .sort((a, b) => b.score - a.score);
        const strongest = related.slice(0, 5).map(link => {
          const otherId = link.source === paper.id ? link.target : link.source;
          const other = state.papers.find(item => item.id === otherId);
          return `${linkTypeName(link)} ${Math.round(link.score * 100)}% ${other?.title || otherId}`;
        });
        return [
          paper.title || '',
          paper.authors || [],
          paper.year || '',
          paper.date || '',
          paper.journal || '',
          paper.doi || '',
          paper.abstract || '',
          keyFindings(paper),
          mergedKeywords(paper),
          paper.color || '',
          state.areas.find(area => area.id === paper.areaId)?.name || '',
          related.length,
          strongest,
          paper.metadataSource || paper.metadataNote || '',
          paper.name || ''
        ].map(csvCell).join(',');
      });
      const csv = [headers.map(csvCell).join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'pulse-summary-table.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function setSettingsTab(tab) {
      document.querySelectorAll('[data-settings-tab]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.settingsTab === tab);
      });
      document.querySelectorAll('[data-settings-pane]').forEach(pane => {
        pane.hidden = pane.dataset.settingsPane !== tab;
      });
    }

    els.fileInput.addEventListener('change', event => handleFiles(event.target.files));

    ['dragenter', 'dragover'].forEach(type => {
      els.dropzone.addEventListener(type, event => {
        event.preventDefault();
        els.dropzone.classList.add('is-dragging');
      });
    });

    ['dragleave', 'drop'].forEach(type => {
      els.dropzone.addEventListener(type, event => {
        event.preventDefault();
        els.dropzone.classList.remove('is-dragging');
      });
    });

    els.dropzone.addEventListener('drop', event => handleFiles(event.dataTransfer.files));

    els.threshold.addEventListener('input', event => {
      state.threshold = Number(event.target.value) / 100;
      render();
    });

    document.querySelectorAll('[data-mode]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('is-active', item === button));
        state.mode = button.dataset.mode;
        state.centerId = null;
        render();
        showToast(`Map mode: ${button.textContent.trim()}.`);
      });
    });

    els.sampleButton?.addEventListener('click', loadSample);
    els.importButton.addEventListener('click', () => els.importInput.click());
    els.importInput.addEventListener('change', event => {
      handleFiles(event.target.files);
      event.target.value = '';
    });
    els.exportButton?.addEventListener('click', exportMap);
    els.summaryExportButton?.addEventListener('click', exportSummaryTable);
    document.querySelectorAll('[data-density]').forEach(button => {
      button.addEventListener('click', () => {
        setPaperViewDensity(button.dataset.density);
      });
    });
    els.paperViewToggle?.addEventListener('click', () => {
      setPaperViewDensity(state.paperView === 'compact' ? 'expanded' : 'compact');
    });
    els.panelToggleButton?.addEventListener('click', () => setPaperPanelHidden(!els.app?.classList.contains('panel-hidden')));
    els.showPanelButton?.addEventListener('click', () => setPaperPanelHidden(false));
    els.linkageButton?.addEventListener('click', () => setLinkagePanelOpen(els.linkagePanel?.hidden));
    els.linkageCloseButton?.addEventListener('click', () => setLinkagePanelOpen(false));
    els.clearLinkageButton?.addEventListener('click', clearLinkageSelection);
    els.graphButton?.addEventListener('click', () => setGraphPanelOpen(els.graphPanel?.hidden));
    els.graphCloseButton?.addEventListener('click', () => setGraphPanelOpen(false));
    els.nodeSizeInput?.addEventListener('input', event => updateGraphStyle({ nodeSize: Number(event.target.value) }));
    els.edgeScaleInput?.addEventListener('input', event => updateGraphStyle({ edgeScale: Number(event.target.value) / 100 }));
    els.spacingInput?.addEventListener('input', event => updateGraphStyle({ spacing: Number(event.target.value) / 100 }));
    els.labelModeInput?.addEventListener('change', event => updateGraphStyle({ labelMode: event.target.value }));
    els.gridToggleInput?.addEventListener('change', event => updateGraphStyle({ showGrid: event.target.checked }));
    els.areasToggleInput?.addEventListener('change', event => updateGraphStyle({ showAreas: event.target.checked }));
    els.resetGraphStyleButton?.addEventListener('click', resetGraphStyle);
    els.areaButton?.addEventListener('click', () => setAreaPanelOpen(els.areaPanel?.hidden));
    els.areaCloseButton?.addEventListener('click', () => setAreaPanelOpen(false));
    els.addAreaButton?.addEventListener('click', createArea);
    els.map?.addEventListener('dblclick', event => {
      if (!event.target.closest?.('.node') && !event.target.closest?.('.area-region')) clearCenteredPaper();
    });
    els.map?.addEventListener('click', event => {
      if (event.target === els.map || event.target.tagName === 'svg') {
        state.selectedId = null;
        state.selectedLinkId = null;
        render();
        renderDetails();
      }
    });
    bindCanvasPanEvents();
    els.settingsButton?.addEventListener('click', () => setSettingsOpen(true));
    els.settingsCloseButton?.addEventListener('click', () => setSettingsOpen(false));
    els.settingsPanel?.addEventListener('click', event => {
      if (event.target === els.settingsPanel) setSettingsOpen(false);
    });
    els.discoveryModalCloseButton?.addEventListener('click', closeDiscoveryModal);
    els.discoveryModalCancelBtn?.addEventListener('click', closeDiscoveryModal);
    els.discoveryModal?.addEventListener('click', event => {
      if (event.target === els.discoveryModal) closeDiscoveryModal();
    });
    els.discoveryFilterText?.addEventListener('input', () => {
      state.discoveryFilterText = els.discoveryFilterText.value;
      if (els.discoveryClearTextBtn) els.discoveryClearTextBtn.hidden = !els.discoveryFilterText.value;
      renderDiscoveryModal();
    });
    els.discoveryClearTextBtn?.addEventListener('click', () => {
      els.discoveryFilterText.value = '';
      state.discoveryFilterText = '';
      els.discoveryClearTextBtn.hidden = true;
      renderDiscoveryModal();
    });
    els.discoveryFilterAuthor?.addEventListener('input', () => {
      state.discoveryFilterAuthor = els.discoveryFilterAuthor.value;
      renderDiscoveryModal();
    });
    els.discoveryFilterYear?.addEventListener('change', () => {
      state.discoveryFilterYear = els.discoveryFilterYear.value;
      renderDiscoveryModal();
    });
    els.discoverySortBy?.addEventListener('change', () => {
      state.discoverySortBy = els.discoverySortBy.value;
      renderDiscoveryModal();
    });
    els.discoveryModal?.querySelectorAll('.branch-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.discoveryFilterBranch = btn.dataset.branch || 'all';
        renderDiscoveryModal();
      });
    });
    els.discoverySelectAllBtn?.addEventListener('click', () => {
      const filtered = getFilteredDiscoveryPapers();
      filtered.forEach(item => state.discoverySelectedKeys.add(discoveryPaperKey(item)));
      renderDiscoveryModal();
    });
    els.discoveryDeselectAllBtn?.addEventListener('click', () => {
      state.discoverySelectedKeys.clear();
      renderDiscoveryModal();
    });
    els.discoverySelectTopBtn?.addEventListener('click', () => {
      state.discoverySelectedKeys.clear();
      const filtered = getFilteredDiscoveryPapers();
      filtered.slice(0, 10).forEach(item => state.discoverySelectedKeys.add(discoveryPaperKey(item)));
      renderDiscoveryModal();
    });
    els.discoveryAddSelectedMapBtn?.addEventListener('click', addSelectedDiscoveredToMap);
    els.discoveryAddSelectedLibraryBtn?.addEventListener('click', addSelectedDiscoveredToLibrary);

    els.keywordModalCloseButton?.addEventListener('click', closeKeywordModal);
    els.keywordModalDoneButton?.addEventListener('click', closeKeywordModal);
    els.addKeywordButton?.addEventListener('click', addKeywordsFromInput);
    els.newKeywordInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addKeywordsFromInput();
      }
    });
    els.keywordModal?.addEventListener('click', event => {
      if (event.target === els.keywordModal) closeKeywordModal();
    });
    els.clearTagFiltersButton?.addEventListener('click', clearFilterTags);
    els.canvasClearFilterButton?.addEventListener('click', clearFilterTags);
    els.toggleTagFilterDropdown?.addEventListener('click', () => {
      if (els.tagFilterDropdown) els.tagFilterDropdown.hidden = !els.tagFilterDropdown.hidden;
    });
    els.tagFilterSearchInput?.addEventListener('input', () => {
      if (els.tagFilterDropdown) els.tagFilterDropdown.hidden = false;
      renderLibraryTagCloud();
    });
