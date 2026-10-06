
    // Pulse App Header button bindings
    els.headerImportBtn?.addEventListener('click', () => els.importButton?.click());
    els.headerExportBtn?.addEventListener('click', () => els.exportButton?.click());
    els.headerSummaryBtn?.addEventListener('click', () => els.summaryExportButton?.click());
    els.headerSettingsBtn?.addEventListener('click', () => els.settingsButton?.click());
    initFrankTheme();

    // Unified Quick Search Bar (+ Add button)
    async function submitQuickAdd() {
      const input = els.quickSearchInput.value.trim();
      if (!input || els.quickAddBtn.disabled) return;
      els.quickAddBtn.disabled = true;
      try {
        await addPaperFromInput(input);
        if (els.quickSearchInput.value.trim() === input) els.quickSearchInput.value = '';
      } catch (error) {
        showToast(error.message);
      } finally {
        els.quickAddBtn.disabled = false;
      }
    }
    els.quickAddBtn?.addEventListener('click', submitQuickAdd);
    els.quickSearchInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuickAdd();
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
      state.workspaceView = 'network';
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

    // Discovery Ribbon: Methods, Depth, Specialised
    document.querySelectorAll('.pulse-discovery-ribbon .ribbon-card').forEach(card => {
      card.addEventListener('click', () => {
        const method = card.dataset.method;
        if (method === 'citations') {
          state.discoveryBranches.citationGraph = !state.discoveryBranches.citationGraph;
          card.classList.toggle('active', state.discoveryBranches.citationGraph);
          showToast(`Citations branch ${state.discoveryBranches.citationGraph ? 'enabled' : 'disabled'}`);
        } else if (method === 'network') {
          state.discoveryBranches.citationNetwork = !state.discoveryBranches.citationNetwork;
          card.classList.toggle('active', state.discoveryBranches.citationNetwork);
          showToast(`Network branch ${state.discoveryBranches.citationNetwork ? 'enabled' : 'disabled'}`);
        } else if (method === 'semantic') {
          state.discoveryBranches.semanticSearch = !state.discoveryBranches.semanticSearch;
          card.classList.toggle('active', state.discoveryBranches.semanticSearch);
          showToast(`SPECTER2 semantic branch ${state.discoveryBranches.semanticSearch ? 'enabled' : 'disabled'}`);
        } else if (method === 'concepts') {
          state.discoveryBranches.lexicalSearch = !state.discoveryBranches.lexicalSearch;
          card.classList.toggle('active', state.discoveryBranches.lexicalSearch);
          showToast(`Concepts branch ${state.discoveryBranches.lexicalSearch ? 'enabled' : 'disabled'}`);
        }
        render();
      });
    });

    document.querySelectorAll('.pulse-discovery-ribbon [data-depth]').forEach(pill => {
      pill.addEventListener('click', () => {
        const depth = pill.dataset.depth;
        state.explorationDepth = depth;
        render();
        showToast('Exploration depth updated. Use Find related papers to search.');
      });
    });

    document.querySelectorAll('.pulse-discovery-ribbon [data-special]').forEach(pill => {
      pill.addEventListener('click', () => {
        const special = pill.dataset.special;
        if (special === 'seminal') {
          findMissingSeminal();
        } else if (special === 'recent') {
          state.recommendationRecencyTilt = 2;
          runDiscoveryPipeline();
          showToast('Finding recent publications');
        }
      });
    });

    // Navigation changes workspaces; searching is an explicit action.
    document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.rail;
        if (view === 'settings') { setSettingsOpen(true); return; }
        if (view === 'trends') { state.mode = 'clusters'; setWorkspaceView('network'); return; }
        if (view === 'network') state.mode = 'network';
        setWorkspaceView(view);
      });
    });
    els.discoveryRunButton.addEventListener('click', () => {
      setDiscoverySeed(els.discoverySeedSelect.value);
      runDiscoveryPipeline();
    });
    els.discoverySeedSelect.addEventListener('change', event => {
      setDiscoverySeed(event.target.value);
      render();
    });
    document.getElementById('discoveryAddSeedButton').addEventListener('click', () => {
      els.quickSearchInput.focus();
      showToast('Enter a paper title, DOI or PMID above, or use Import for a PDF.');
    });
    document.getElementById('networkDiscoverButton').addEventListener('click', () => {
      setDiscoverySeed(state.selectedId || state.papers[0]?.id || null);
      setWorkspaceView('discover');
    });
    document.getElementById('networkFullscreenButton').addEventListener('click', () => toggleNetworkFullscreen());
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && els.app.classList.contains('network-fullscreen')) toggleNetworkFullscreen(false);
    });

    els.railRecentList?.addEventListener('click', event => {
        const query = event.target.closest('[data-session-query]')?.dataset.sessionQuery;
        if (query && els.quickSearchInput) {
          els.quickSearchInput.value = query;
          els.quickSearchInput.focus();
        }
    });

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
    restoreLibrary().finally(() => {
      state.autosaveReady = true;
      render();
    });
