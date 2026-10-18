    els.tagFilterSearchInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const val = (els.tagFilterSearchInput.value || '').trim();
        if (val) {
          addFilterTag(val);
          els.tagFilterSearchInput.value = '';
        }
      }
    });
    els.closeTagActionMenuButton?.addEventListener('click', closeTagActionMenu);
    els.tagActionMenu?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'toggle-filter') {
          toggleFilterTag(currentTagActionTerm);
          closeTagActionMenu();
        } else if (action === 'toggle-steer') {
          toggleRecommendationSteer(currentTagActionTerm);
          closeTagActionMenu();
        } else if (action === 'toggle-graph-steer') {
          toggleGraphSteer(currentTagActionTerm);
          closeTagActionMenu();
        } else if (action === 'toggle-exclude') {
          toggleExcludeSteer(currentTagActionTerm);
          closeTagActionMenu();
        }
      });
    });
    document.addEventListener('click', event => {
      if (els.tagActionMenu && !els.tagActionMenu.hidden) {
        if (!els.tagActionMenu.contains(event.target) && !event.target.closest('[data-action="paper-keyword"], [data-action="tag-action-menu"]')) {
          closeTagActionMenu();
        }
      }
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (els.tagActionMenu && !els.tagActionMenu.hidden) {
          closeTagActionMenu();
        } else if (els.discoveryModal && !els.discoveryModal.hidden) {
          closeDiscoveryModal();
        } else if (!els.keywordModal?.hidden) {
          closeKeywordModal();
        } else if (!els.settingsPanel?.hidden) {
          setSettingsOpen(false);
        } else if (state.libraryFullscreen) {
          setLibraryFullscreen(false);
        } else if (state.selectedLinkId) {
          clearLinkageSelection();
        }
      }
    });
    els.ollamaModelSelect?.addEventListener('change', event => {
      if (event.target.value && els.gemmaModelInput) els.gemmaModelInput.value = event.target.value;
    });
    els.aiProviderInput?.addEventListener('change', () => {
      const isLocal = els.aiProviderInput.value === 'local';
      const localCard = document.getElementById('localOllamaSettingsStep');
      const cloudCard = document.getElementById('cloudSettingsStep');
      const cloudGroup = document.getElementById('cloudProviderGroup');
      if (localCard) localCard.hidden = !isLocal;
      if (cloudCard) cloudCard.hidden = isLocal;
      if (cloudGroup) cloudGroup.hidden = isLocal;
      if (els.cloudProviderInput) els.cloudProviderInput.disabled = isLocal;
      if (els.ollamaChatEndpointInput) els.ollamaChatEndpointInput.disabled = !isLocal;
      if (els.ollamaModelSelect) els.ollamaModelSelect.disabled = !isLocal;
      if (els.embeddingModelInput) els.embeddingModelInput.disabled = !isLocal;
      if (els.testBackendButton) els.testBackendButton.disabled = !isLocal;
    });
    document.querySelectorAll('[data-settings-tab]').forEach(button => {
      button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab));
    });
    els.saveSettingsButton?.addEventListener('click', () => saveBackendSettings());
    document.querySelectorAll('[data-save-settings]').forEach(button => {
      button.addEventListener('click', () => saveBackendSettings());
    });
    els.clearDimensionsKeyButton?.addEventListener('click', () => saveBackendSettings({ clearDimensionsApiKey: true }));
    els.clearSemanticScholarKeyButton?.addEventListener('click', () => saveBackendSettings({ clearSemanticScholarApiKey: true }));
    els.clearCoreKeyButton?.addEventListener('click', () => saveBackendSettings({ clearCoreApiKey: true }));
    els.clearOpenAlexKeyButton?.addEventListener('click', () => saveBackendSettings({ clearOpenAlexApiKey: true }));
    els.clearButton?.addEventListener('click', () => {
      const menu = document.getElementById('libraryActionsMenu');
      if (menu) menu.open = false;
      promptClearLibrary();
    });
    document.addEventListener('click', event => {
      const menu = document.getElementById('libraryActionsMenu');
      if (menu?.open && !menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('keydown', event => {
      const menu = document.getElementById('libraryActionsMenu');
      if (event.key === 'Escape' && menu?.open) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    });
    els.sidebarClearButton?.addEventListener('click', promptClearLibrary);
    els.clearAppToDefaultButton?.addEventListener('click', () => clearAppToDefault(false));
    els.clearAppToDefaultQuickButton?.addEventListener('click', () => clearAppToDefault(false));
    els.testBackendButton?.addEventListener('click', testBackend);
    els.aiButton?.addEventListener('click', () => setAiPanelOpen(els.aiPanel?.hidden));
    els.aiCloseButton?.addEventListener('click', () => setAiPanelOpen(false));
    els.aiAnalyzeButton?.addEventListener('click', () => startPaperScan());
    window.addEventListener('resize', () => render());
    window.addEventListener('beforeunload', saveLibrarySync);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveLibrarySync();
    });
    replaceFeatherIcons();

    // Pulse App Header button bindings
    els.headerImportBtn?.addEventListener('click', () => els.importButton?.click());
    els.headerExportBtn?.addEventListener('click', () => els.exportButton?.click());
    els.headerSummaryBtn?.addEventListener('click', () => els.summaryExportButton?.click());
    els.headerSettingsBtn?.addEventListener('click', () => els.settingsButton?.click());
    initFrankTheme();

    // Unified Quick Search Bar (+ Add button)
    els.quickAddBtn?.addEventListener('click', () => {
      if (els.quickSearchInput?.value) {
        addPaperFromInput(els.quickSearchInput.value);
        els.quickSearchInput.value = '';
      }
    });
    els.quickSearchInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (els.quickSearchInput.value) {
          addPaperFromInput(els.quickSearchInput.value);
          els.quickSearchInput.value = '';
        }
      }
    });

    // Map Blow Up & Compress Controls
    els.blowUpButton?.addEventListener('click', () => blowUpMap(1.35));
    els.compressButton?.addEventListener('click', () => compressMap(0.75));
    els.dockBlowUpButton?.addEventListener('click', () => blowUpMap(1.35));
    els.blowUpGraphButton?.addEventListener('click', () => blowUpMap(1.35));
    els.compressGraphButton?.addEventListener('click', () => compressMap(0.75));
    els.fitCanvasButton?.addEventListener('click', () => fitCanvasToMap());
    els.addPaperDropBtn?.addEventListener('click', () => els.fileInput?.click());

    // Subbar dropdown controls & mode tabs
    els.canvasLayoutSelect?.addEventListener('change', event => {
      state.mode = event.target.value;
      document.querySelectorAll('.subbar-tab').forEach(t => t.classList.toggle('is-active', t.dataset.mode === state.mode));
      render();
    });
    els.canvasLinksSelect?.addEventListener('change', event => {
      state.linkTypeFilter = event.target.value;
      render();
    });
    els.showLabelsToggle?.addEventListener('change', event => {
      updateGraphStyle({ labelMode: event.target.checked ? 'short' : 'none' });
    });
    document.querySelectorAll('.subbar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.subbar-tab').forEach(t => t.classList.toggle('is-active', t === tab));
        state.mode = tab.dataset.mode;
        if (els.canvasLayoutSelect) els.canvasLayoutSelect.value = state.mode;
        render();
      });
    });



    // Left Navigation Rail
    document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(item => {
      item.addEventListener('click', () => {
        const rail = item.dataset.rail;
        if (rail === 'settings') { setSettingsOpen(true); return; }
        if (rail === 'library') {
          if (state.libraryFullscreen) { setLibraryFullscreen(false, false); toggleLibraryWithSwipe(true); }
          else toggleLibraryWithSwipe();
          return;
        }
        if (rail === 'bibliography') {
          if (!els.settingsPanel.hidden) setSettingsOpen(false);
          setLibraryFullscreen(!state.libraryFullscreen);
          return;
        }
        if (!els.settingsPanel.hidden) setSettingsOpen(false);
        highlightRail(rail);
        if (state.libraryFullscreen && ['network', 'trends', 'collections', 'timeline'].includes(rail)) {
          setLibraryFullscreen(false, false);
        }
        if (rail === 'discover') {
          if (state.papers.length) {
            runDiscoveryPipeline();
          } else {
            els.quickSearchInput?.focus();
            showToast('Enter a paper title or DOI to start discovery');
          }
        } else if (rail === 'network') {
          if (typeof setTrendsVisible === 'function') setTrendsVisible(false);
          setTimelineVisible(false);
          state.mode = 'network';
          render();
        } else if (rail === 'trends') {
          setTimelineVisible(false);
          if (typeof setTrendsVisible === 'function') setTrendsVisible(true);
        } else if (rail === 'timeline') {
          if (typeof setTrendsVisible === 'function') setTrendsVisible(false);
          setTimelineVisible(true);
        }
      });
    });

    function toggleLibraryWithSwipe(forceOpen = null) {
      const col = els.colLibrary || document.getElementById('colLibrary');
      if (!col) return;
      const willOpen = forceOpen !== null ? forceOpen : col.classList.contains('is-swiped-hidden');
      if (!state.libraryFullscreen && (willOpen || activeRail() !== 'library')) state.libraryPreviousRail = workspaceRail();
      if (!willOpen && state.libraryFullscreen) setLibraryFullscreen(false);
      highlightRail(willOpen ? 'library' : state.libraryPreviousRail || workspaceRail());
      state.libraryOpen = willOpen;
      col.classList.toggle('is-swiped-hidden', !willOpen);
      if (willOpen) {
        showToast('Library swiped in');
        els.paperList?.scrollIntoView({ behavior: 'smooth' });
      } else {
        showToast('Library swiped away');
      }
    }

    function setLibraryFullscreen(expanded, restoreNavigation = true) {
      if (expanded && !state.libraryFullscreen) {
        state.libraryPreviousRail = workspaceRail();
      }
      state.libraryFullscreen = Boolean(expanded);
      state.libraryOpen = true;
      els.app.classList.toggle('library-fullscreen', state.libraryFullscreen);
      els.colLibrary.classList.remove('is-swiped-hidden');
      // The full-width table is the Bibliography view (left rail), replacing the old Full screen button.
      const heading = document.getElementById('libraryHeading');
      if (heading) heading.textContent = state.libraryFullscreen ? 'Bibliography' : 'Library';
      document.getElementById('railBibliographyBtn')?.setAttribute('aria-pressed', String(state.libraryFullscreen));
      if (expanded) {
        if (typeof setTrendsVisible === 'function') setTrendsVisible(false);
        setTimelineVisible(false);
        setAiPanelOpen(false);
        highlightRail('bibliography');
      } else if (restoreNavigation) {
        const rail = state.libraryPreviousRail === 'library' ? 'network' : state.libraryPreviousRail || 'network';
        highlightRail(rail);
        if (rail === 'timeline') setTimelineVisible(true);
        if (rail === 'trends' && typeof setTrendsVisible === 'function') setTrendsVisible(true);
      }
      syncDensityButtons();
      renderPapers();
      // The sidebar list and the Bibliography table share one scroller; start each view at the top.
      if (els.paperList) els.paperList.scrollTop = 0;
      requestAnimationFrame(() => { if (!state.libraryFullscreen) render(); });
    }

    function openTrendsPaperInGraph(id) {
      const paper = state.papers.find(item => item.id === id);
      if (!paper) return;
      setTrendsVisible(false);
      setTimelineVisible(false);
      state.mode = 'network';
      state.centerId = id;
      if (typeof setPaperOnMap === 'function') setPaperOnMap(paper, state.activeMapId, true);
      highlightRail('network');
      inspectPaper(id);
      render();
    }
    if (typeof window !== 'undefined') window.openTrendsPaperInGraph = openTrendsPaperInGraph;

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'i' || e.key === 'o') {
          e.preventDefault();
          els.importButton?.click();
        } else if (e.key === 's') {
          e.preventDefault();
          els.exportButton?.click();
        } else if (e.key === 'e') {
          e.preventDefault();
          els.summaryExportButton?.click();
        } else if (e.key === 'd') {
          e.preventDefault();
          const cur = document.documentElement.getAttribute('data-theme') || 'light';
          applyFrankTheme(cur === 'dark' ? 'light' : 'dark');
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          blowUpMap(1.35);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          compressMap(0.75);
        }
      }
    });

    loadBackendSettings();
    render();
    restoreLibrary().then(restored => {
      state.autosaveReady = restored;
      const conceptPrefill=new URLSearchParams(location.search).get('concept');
      if(conceptPrefill){state.discoveryResearchQuestion=conceptPrefill.slice(0,1000);syncDiscoveryControls();}
      render();
      if (!restored) showToast('Saved papers could not be loaded. Refresh before making changes.');
    });

    // Discovery Hero Dropzone
    const discDrop = document.getElementById('discoveryDropzone');
    const discFileInput = document.getElementById('discoveryFileInput');
    if (discDrop && discFileInput) {
      discDrop.addEventListener('click', () => discFileInput.click());
      discFileInput.addEventListener('change', (e) => {
        if (e.target.files?.length) handleFiles(e.target.files);
      });
      discDrop.addEventListener('dragover', (e) => {
        e.preventDefault();
        discDrop.classList.add('is-dragover');
      });
      discDrop.addEventListener('dragleave', () => discDrop.classList.remove('is-dragover'));
      discDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        discDrop.classList.remove('is-dragover');
        if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
      });
    }

    // Compact discovery controls and navigation-rail paper actions.
    const discoveryOptionsButton = document.getElementById('discoveryOptionsButton');
    const discoveryOptionsPopup = document.getElementById('discoveryOptionsPopup');
    const railAddButton = document.getElementById('railAddButton');
    const railAddPopover = document.getElementById('railAddPopover');
    const inspectorToggle = document.getElementById('inspectorToggle');
    const inspectorReopen = document.getElementById('inspectorReopen');

    initDiscoveryControls();
    if (typeof initMapTabs === 'function') initMapTabs();

    function setRailAddOpen(open, returnFocus = false) {
      railAddPopover.hidden = !open;
      railAddButton.setAttribute('aria-expanded', String(open));
      if (open) {
        setDiscoveryOptionsOpen(false);
        els.quickSearchInput.focus();
      } else if (returnFocus) railAddButton.focus();
    }
    railAddButton.addEventListener('click', () => setRailAddOpen(railAddPopover.hidden));
    document.getElementById('railAddClose').addEventListener('click', () => setRailAddOpen(false, true));

    function setInspectorVisible(visible, persist = true) {
      state.inspectorVisible = visible;
      inspectorToggle.setAttribute('aria-expanded', String(visible));
      inspectorReopen.setAttribute('aria-expanded', String(visible));
      inspectorReopen.hidden = visible;
      els.app.classList.toggle('inspector-hidden', !visible);
      els.details.hidden = !visible;
      if (persist) {
        try { localStorage.setItem('pulse.inspectorVisible', String(visible)); } catch (_) {}
      }
      requestAnimationFrame(() => render());
    }
    inspectorToggle.addEventListener('click', () => {
      setInspectorVisible(false);
      inspectorReopen.focus();
    });
    inspectorReopen.addEventListener('click', () => {
      setInspectorVisible(true);
      inspectorToggle.focus();
    });
    let savedInspectorVisible = true;
    try { savedInspectorVisible = localStorage.getItem('pulse.inspectorVisible') !== 'false'; } catch (_) {}
    setInspectorVisible(savedInspectorVisible, false);

    document.addEventListener('click', event => {
      if (!event.target.closest('.discovery-dropdown-wrap, [data-action="open-discovery-options"]')) setDiscoveryOptionsOpen(false);
      if (!event.target.closest('.rail-actions')) setRailAddOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!discoveryOptionsPopup.hidden) setDiscoveryOptionsOpen(false, true);
      if (!railAddPopover.hidden) setRailAddOpen(false, true);
    });
