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
    els.clearButton?.addEventListener('click', promptClearLibrary);
    els.sidebarClearButton?.addEventListener('click', promptClearLibrary);
    els.clearAppToDefaultButton?.addEventListener('click', () => clearAppToDefault(false));
    els.clearAppToDefaultQuickButton?.addEventListener('click', () => clearAppToDefault(false));
    els.testBackendButton?.addEventListener('click', testBackend);
    els.aiButton?.addEventListener('click', () => setAiPanelOpen(els.aiPanel?.hidden));
    els.aiCloseButton?.addEventListener('click', () => setAiPanelOpen(false));
    els.aiAnalyzeButton?.addEventListener('click', analyzeWithGemma);
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
          showToast(`Semantic search branch ${state.discoveryBranches.semanticSearch ? 'enabled' : 'disabled'}`);
        } else if (method === 'concepts') {
          state.discoveryBranches.lexicalSearch = !state.discoveryBranches.lexicalSearch;
          card.classList.toggle('active', state.discoveryBranches.lexicalSearch);
          showToast(`Concepts branch ${state.discoveryBranches.lexicalSearch ? 'enabled' : 'disabled'}`);
        }
        renderDetails();
      });
    });

    document.querySelectorAll('.pulse-discovery-ribbon [data-depth]').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pulse-discovery-ribbon [data-depth]').forEach(p => p.classList.toggle('active', p === pill));
        const depth = pill.dataset.depth;
        state.explorationDepth = depth;
        showToast(`Exploration depth set to ${depth === 'iterative' ? 'Iterative' : depth + '-hop'}`);
        if (depth === '2') {
          chase2HopSelectedPaper();
        }
      });
    });

    document.querySelectorAll('.pulse-discovery-ribbon [data-special]').forEach(pill => {
      pill.addEventListener('click', () => {
        const special = pill.dataset.special;
        if (special === 'seminal') {
          findMissingSeminal();
        } else if (special === 'recent') {
          state.recommendationRecencyTilt = 2;
          recommendSelectedPapers();
          showToast('Finding recent publications');
        }
      });
    });

    // Left Navigation Rail
    document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(i => i.classList.toggle('active', i === item));
        const rail = item.dataset.rail;
        if (rail === 'discover') {
          if (state.papers.length) {
            runDiscoveryPipeline();
          } else {
            els.quickSearchInput?.focus();
            showToast('Enter a paper title or DOI to start discovery');
          }
        } else if (rail === 'network') {
          state.mode = 'network';
          render();
        } else if (rail === 'library') {
          els.paperList?.scrollIntoView({ behavior: 'smooth' });
        } else if (rail === 'trends') {
          state.mode = 'clusters';
          render();
          showToast('Topic clusters & trends');
        } else if (rail === 'timeline') {
          state.mode = 'timeline';
          render();
        } else if (rail === 'settings') {
          setSettingsOpen(true);
        }
      });
    });

    els.railRecentList?.addEventListener('click', event => {
      const paper = state.papers.find(item => [item.doi, item.pmid, item.title].includes(event.target.closest('[data-session-query]')?.dataset.sessionQuery));
      if (paper) { state.selectedId=paper.id; render(); }
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

    window.addEventListener('DOMContentLoaded', () => {
      loadBackendSettings();
      render();
      restoreLibrary().finally(() => {
        state.autosaveReady = true;
        render();
      });
    }, {once: true});
