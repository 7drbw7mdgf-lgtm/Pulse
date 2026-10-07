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
    els.clearButton?.addEventListener('click', promptClearLibrary);
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
        renderDetails();
      });
    });

    document.querySelectorAll('.pulse-discovery-ribbon [data-depth]').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.pulse-discovery-ribbon [data-depth]').forEach(p => p.classList.toggle('active', p === pill));
        const depth = pill.dataset.depth;
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
        if (state.libraryFullscreen && ['network', 'trends', 'collections', 'bibliography', 'timeline'].includes(rail)) {
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
          if (els.timelineView) els.timelineView.hidden = true;
          state.mode = 'network';
          render();
        } else if (rail === 'library') {
          toggleLibraryWithSwipe();
        } else if (rail === 'trends') {
          state.mode = 'clusters';
          render();
          showToast('Topic clusters & trends');
        } else if (rail === 'collections' || rail === 'bibliography') {
          if (els.timelineView) els.timelineView.hidden = true;
          state.mode = 'table';
          render();
          showToast('Bibliography view active.');
        } else if (rail === 'timeline') {
          if (els.timelineView) {
            const isShown = !els.timelineView.hidden;
            els.timelineView.hidden = isShown;
            if (!isShown) renderTimeline();
          }
        } else if (rail === 'settings') {
          setSettingsOpen(true);
        }
      });
    });

    function toggleLibraryWithSwipe(forceOpen = null) {
      const col = els.colLibrary || document.getElementById('colLibrary');
      if (!col) return;
      const willOpen = forceOpen !== null ? forceOpen : col.classList.contains('is-swiped-hidden');
      if (!willOpen && state.libraryFullscreen) setLibraryFullscreen(false);
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
        state.libraryPreviousRail = document.querySelector('.pulse-nav-rail .rail-item.active')?.dataset.rail || 'network';
      }
      state.libraryFullscreen = Boolean(expanded);
      state.libraryOpen = true;
      els.app.classList.toggle('library-fullscreen', state.libraryFullscreen);
      els.colLibrary.classList.remove('is-swiped-hidden');
      const label = expanded ? 'Return library to sidebar' : 'Expand library to full screen';
      els.closeLibrarySwipeBtn.textContent = expanded ? 'Exit full screen' : 'Full screen';
      els.closeLibrarySwipeBtn.title = label;
      els.closeLibrarySwipeBtn.setAttribute('aria-label', label);
      els.closeLibrarySwipeBtn.setAttribute('aria-expanded', String(state.libraryFullscreen));
      if (expanded) {
        if (els.timelineView) els.timelineView.hidden = true;
        setAiPanelOpen(false);
        document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(item => item.classList.toggle('active', item.dataset.rail === 'library'));
      } else if (restoreNavigation) {
        const rail = state.libraryPreviousRail === 'library' ? 'network' : state.libraryPreviousRail || 'network';
        document.querySelectorAll('.pulse-nav-rail .rail-item').forEach(item => item.classList.toggle('active', item.dataset.rail === rail));
      }
      renderPapers();
      requestAnimationFrame(() => { if (!state.libraryFullscreen) render(); });
      els.closeLibrarySwipeBtn.focus();
    }

    els.closeLibrarySwipeBtn?.addEventListener('click', () => setLibraryFullscreen(!state.libraryFullscreen));

    els.railCardOpenBtn?.addEventListener('click', () => {
      toggleLibraryWithSwipe(true);
    });

    // Key Parameters Sort Bar on top of Library List
    document.querySelectorAll('.param-sort-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const key = pill.dataset.sort;
        if (state.librarySortKey === key) {
          state.librarySortAsc = !state.librarySortAsc;
        } else {
          state.librarySortKey = key;
          state.librarySortAsc = key === 'title' || key === 'authors';
        }
        renderPapers();
      });
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

    function parsePaperDate(paper) {
      if (!paper) return { sortKey: '9999-99-99', label: '', year: 'Undated' };
      const raw = (paper.date || paper.publicationDate || paper.year || '').toString().trim();
      const match = raw.match(/(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
      if (match) {
        const y = match[1];
        const m = match[2] ? match[2].padStart(2, '0') : '01';
        const d = match[3] ? match[3].padStart(2, '0') : '01';
        return { sortKey: `${y}-${m}-${d}`, label: raw, year: y };
      }
      return { sortKey: '9999-99-99', label: raw || 'Date unknown', year: 'Undated' };
    }

    function chronologicalPapers() {
      return [...state.papers]
        .map(paper => ({ paper, date: parsePaperDate(paper) }))
        .sort((a, b) => a.date.sortKey.localeCompare(b.date.sortKey));
    }

    function renderTimeline() {
      if (!els.timelineView) return;
      const ordered = chronologicalPapers();
      let previousYear = null;
      const count = ordered.length;
      els.timelineView.innerHTML = `<header class="timeline-header"><span class="discovery-source-pill">Chronological Literature View</span><h1>Timeline</h1><p>Oldest to newest · ${count} papers across your research library.</p></header><div class="timeline-track">${ordered.map(({paper, date}) => {
        const year = date?.year || 'Undated';
        const heading = year !== previousYear ? `<div class="timeline-year-heading"><h2 class="timeline-year">${escapeHtml(year)}</h2><span class="timeline-year-badge">${ordered.filter(o => (o.date?.year || 'Undated') === year).length} paper${ordered.filter(o => (o.date?.year || 'Undated') === year).length === 1 ? '' : 's'}</span></div>` : '';
        previousYear = year;
        const citations = Number(paper.citationCount ?? paper.citations ?? 0);
        const citeHtml = citations > 0 ? `<span class="timeline-cite-pill">★ ${citations.toLocaleString()} cites</span>` : '';
        const isSelected = state.selectedId === paper.id ? ' is-selected' : '';
        const isSeminal = (citations > 100 || (paper.tags && paper.tags.includes('seminal')));
        const seminalBadge = isSeminal ? '<span class="timeline-seminal-badge">Seminal</span>' : '';
        return `${heading}<article class="timeline-paper${isSelected}" data-timeline-id="${escapeHtml(paper.id)}"><div class="timeline-date-wrap"><span class="timeline-date">${escapeHtml(date?.label || 'Date unknown')}</span>${citeHtml}</div><div class="timeline-content"><div class="timeline-title-row"><button type="button" class="timeline-paper-title" data-timeline-inspect="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}</button>${seminalBadge}</div><p>${escapeHtml([paperAuthorSummary(paper), paper.journal].filter(Boolean).join(' · '))}</p>${paper.abstract ? `<p class="timeline-abstract">${escapeHtml(paper.abstract.slice(0, 240))}${paper.abstract.length > 240 ? '…' : ''}</p>` : ''}</div><div class="timeline-actions"><button type="button" class="button secondary xs" data-timeline-discover="${escapeHtml(paper.id)}">Discover related</button><button type="button" class="button xs" data-timeline-focus="${escapeHtml(paper.id)}">View in graph</button></div></article>`;
      }).join('') || '<div class="timeline-empty">Add papers to see how the literature develops over time.</div>'}</div>`;
      els.timelineView.querySelectorAll('[data-timeline-inspect]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.timelineInspect;
        render();
        renderDetails();
      }));
      els.timelineView.querySelectorAll('[data-timeline-discover]').forEach(button => button.addEventListener('click', () => {
        if (state.papers.length) runDiscoveryPipeline();
      }));
      els.timelineView.querySelectorAll('[data-timeline-focus]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.timelineFocus;
        state.centerId = button.dataset.timelineFocus;
        state.mode = 'network';
        if (els.timelineView) els.timelineView.hidden = true;
        render();
      }));
    }


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

    function setDiscoveryOptionsOpen(open, returnFocus = false) {
      discoveryOptionsPopup.hidden = !open;
      discoveryOptionsButton.setAttribute('aria-expanded', String(open));
      if (open) {
        setRailAddOpen(false);
        discoveryOptionsPopup.querySelector('button').focus();
      } else if (returnFocus) discoveryOptionsButton.focus();
    }
    function syncDiscoveryOptions() {
      const branchKeys = { citations: 'citationGraph', network: 'citationNetwork', semantic: 'semanticSearch', concepts: 'lexicalSearch' };
      const enabled = [];
      discoveryOptionsPopup.querySelectorAll('[data-method]').forEach(button => {
        const active = Boolean(state.discoveryBranches[branchKeys[button.dataset.method]]);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        if (active) enabled.push(button.querySelector('strong').textContent);
      });
      const depths = [...discoveryOptionsPopup.querySelectorAll('[data-depth]')];
      depths.forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
      const depth = depths.find(button => button.classList.contains('active'))?.dataset.depth || '2';
      const methods = enabled.length === 4 ? 'All methods' : enabled.length === 0 ? 'No methods' : enabled.length === 1 ? enabled[0] : `${enabled.length} methods`;
      document.getElementById('discoveryOptionsSummary').textContent = `${methods} · ${depth === 'iterative' ? 'Iterative' : depth + '-hop'}`;
    }
    discoveryOptionsButton.addEventListener('click', () => setDiscoveryOptionsOpen(discoveryOptionsPopup.hidden));
    document.getElementById('discoveryOptionsClose').addEventListener('click', () => setDiscoveryOptionsOpen(false, true));
    document.getElementById('discoveryOptionsDone').addEventListener('click', () => setDiscoveryOptionsOpen(false, true));
    discoveryOptionsPopup.addEventListener('click', syncDiscoveryOptions);
    syncDiscoveryOptions();

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
      inspectorToggle.checked = visible;
      els.app.classList.toggle('inspector-hidden', !visible);
      els.details.hidden = !visible;
      if (persist) {
        try { localStorage.setItem('pulse.inspectorVisible', String(visible)); } catch (_) {}
      }
      requestAnimationFrame(() => render());
    }
    inspectorToggle.addEventListener('change', () => setInspectorVisible(inspectorToggle.checked));
    let savedInspectorVisible = true;
    try { savedInspectorVisible = localStorage.getItem('pulse.inspectorVisible') !== 'false'; } catch (_) {}
    setInspectorVisible(savedInspectorVisible, false);

    document.addEventListener('click', event => {
      if (!event.target.closest('.discovery-dropdown-wrap')) setDiscoveryOptionsOpen(false);
      if (!event.target.closest('.rail-actions')) setRailAddOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!discoveryOptionsPopup.hidden) setDiscoveryOptionsOpen(false, true);
      if (!railAddPopover.hidden) setRailAddOpen(false, true);
    });
