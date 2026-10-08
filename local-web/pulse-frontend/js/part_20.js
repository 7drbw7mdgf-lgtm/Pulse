
    async function clearAppToDefault(skipConfirm = false) {
      if (state.clearingLibrary || state.libraryMutation) return false;
      if (!skipConfirm && !await confirmClearPapers(state.papers.length)) return false;

      const autosaveWasReady = state.autosaveReady;
      const ignoredBefore = state.mendeleyIgnored;
      const syncPausedBefore = state.mendeleySyncPaused;
      rememberMendeleyRemovals(state.papers);
      state.mendeleySyncPaused = true;
      state.syncEpoch = (state.syncEpoch || 0) + 1;
      state.clearingLibrary = true;
      state.autosaveReady = false;
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
      updateMetrics();
      updateSaveStatePill('Clearing...');
      try {
        // Complete older saves before resetting, so they cannot restore cleared papers.
        await Promise.allSettled([...(state.pendingLibraryWrites || [])]);
        const result = await libraryMutationRequest('/api/library/change', {action:'clear', workspace:serializeMap()});
        state.librarySelectedIds?.clear();

        // Clear the browser only after the backend has saved the empty workspace.
        state.papers = [];
        state.links = [];
        state.clusters = [];
        state.areas = [];
        state.vectors.clear();
        state.keywords.clear();
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
        if (els.tagFilterSearchInput) els.tagFilterSearchInput.value = '';
        try {
          localStorage.removeItem('pulse-autosave-library');
          localStorage.removeItem('iratxe-autosave-library');
          localStorage.setItem('pulse-autosave-library', JSON.stringify({format:'pulse-map', version:'1.0', papers:[], areas:[]}));
        } catch (_) {}
        if (els.settingsPanel) els.settingsPanel.hidden = true;
        if (els.keywordModal) els.keywordModal.hidden = true;
        if (els.tagActionMenu) els.tagActionMenu.hidden = true;
        if (els.tagFilterDropdown) els.tagFilterDropdown.hidden = true;
        if (els.discoveryModal) els.discoveryModal.hidden = true;
        render();
        renderPapers();
        renderDetails();
        renderAreasPanel();
        renderLinkages();
        showToast('All papers cleared. Use Undo or Recovery to restore them.');
        return true;
      } catch (error) {
        state.mendeleyIgnored = ignoredBefore; state.mendeleySyncPaused = syncPausedBefore;
        showToast(`Could not clear papers: ${error.message}`);
        return false;
      } finally {
        state.clearingLibrary = false;
        state.autosaveReady = autosaveWasReady;
        updateMetrics();
        updateSaveStatePill('Ready');
        if (autosaveWasReady) scheduleAutosave();
      }
    }

    async function addPaperFromInput(input) {
      const trimmed = String(input || '').trim();
      if (!trimmed) return;
      let papers;
      if (/^@\w+\s*[{(]/.test(trimmed)) papers = parseBibtexRecords(trimmed, 'Pasted BibTeX');
      else if (/^\s*TY\s+-/im.test(trimmed)) papers = parseRisRecords(trimmed, 'Pasted citation');
      else {
        const cleaned = extractCitationText(trimmed);
        const metadata = extractMetadata(trimmed, cleaned);
        const pmid = trimmed.match(/^(?:PMID\s*[:=]?\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)?(\d{1,10})\/?$/i)?.[1] || '';
        const title = fieldMatch(trimmed, ['title','TI','T1'], 1200)
          || (metadata.doi && trimmed.replace(/(?:doi|https?|www|org|dx)[:/.\s]*/gi, '').includes(metadata.doi) && trimmed.split(/\s+/).length < 3 ? '' : trimmed.split(/\r?\n/)[0]);
        papers = [normalizeImportedPaper({name: 'Pasted paper', title: title || 'Untitled paper', pmid,
          ...metadata, abstract: extractAbstract(trimmed, cleaned), paperKeywords: extractPaperKeywords(trimmed, cleaned), text: trimmed}, 'Manual')];
      }
      showToast('Looking up paper details…');
      for (const paper of papers) await resolvePaperMetadata(paper, {parseInput: !/^@|^\s*TY\s+-/im.test(trimmed)});
      const result = addParsedPapers(papers);
      if (papers.length) state.selectedId = state.papers.find(paper => paperIdentityKey(paper) === paperIdentityKey(papers[0]))?.id || papers[0].id;
      render();
      const matched = papers.filter(paper => paper.metadataMatch?.matched).length;
      showToast(matched ? `Found ${matched} paper${matched === 1 ? '' : 's'}; added ${result.added} to the map.`
        : 'Added extracted details. No confident online match found.');
    }

    function csvCell(value) {
      const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
      return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    }

    async function exportSummaryTable() {
      await preparePaperExport([...state.papers]);
      const headers = [
        'Title',
        'Authors',
        'Year',
        'Date',
        'Journal',
        'DOI', 'Volume', 'Issue', 'Pages', 'Article number', 'Publisher', 'ISSN', 'ISBN', 'URL', 'Language',
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
          paper.doi || '', ...['volume','issue','pages','articleNumber','publisher','issn','isbn','url','language'].map(k => paper[k] || ''),
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
      anchor.click();
      URL.revokeObjectURL(url);
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

    // One drop listener on the viewport prevents SVG events importing twice.
    const mapDropTarget = document.querySelector('.map-viewport');
    const mapDropOverlay = document.getElementById('mapDropOverlay');
    let mapDragDepth = 0;
    function setMapDropActive(active) {
      mapDropTarget.classList.toggle('is-dragging', active);
      mapDropOverlay.hidden = !active;
    }
    function isPaperFileDrag(event) {
      return Array.from(event.dataTransfer?.types || []).includes('Files');
    }
    mapDropTarget.addEventListener('dragenter', event => {
      if (!isPaperFileDrag(event)) return;
      event.preventDefault();
      mapDragDepth += 1;
      setMapDropActive(true);
    });
    mapDropTarget.addEventListener('dragover', event => {
      if (!isPaperFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setMapDropActive(true);
    });
    mapDropTarget.addEventListener('dragleave', event => {
      if (!isPaperFileDrag(event)) return;
      mapDragDepth = Math.max(0, mapDragDepth - 1);
      if (!mapDragDepth) setMapDropActive(false);
    });
    mapDropTarget.addEventListener('drop', async event => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      event.stopPropagation();
      mapDragDepth = 0;
      setMapDropActive(false);
      try {
        await handleFiles(event.dataTransfer.files);
      } catch (error) {
        showToast(`Could not import papers: ${error.message}`);
      }
    });
    window.addEventListener('dragend', () => {
      mapDragDepth = 0;
      setMapDropActive(false);
    });

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
    function handleGraphBackgroundClick(event) {
      if (event.target.closest?.('.node, .edge, .edge-hit, .area-region')) return;
      state.selectedId = null;
      state.selectedLinkId = null;
      setInspectorVisible(false, false);
      render();
      renderDetails();
    }
    els.map?.addEventListener('click', handleGraphBackgroundClick);
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
