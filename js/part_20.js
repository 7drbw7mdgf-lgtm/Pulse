      const pmid = trimmed.match(/^(?:PMID\s*:\s*)?(\d{1,10})$/i) || trimmed.match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
      if (pmid) {
        const response = await fetch(backendUrl('/api/metadata/pmid'), {
          method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}),
          body: JSON.stringify({pmid:pmid[1]})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'PMID lookup failed');
        const paper = normalizeImportedPaper(data.metadata, 'PubMed');
        addParsedPapers([paper]);
        state.selectedId = state.papers.find(item => item.pmid === paper.pmid)?.id || paper.id;
        render();
        showToast(`Added: ${compactTitle(paper.title)}`);
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

    els.fileInput.addEventListener('change', event => {
      handleFiles(event.target.files);
      event.target.value = '';
    });

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
        state.workspaceView = 'network';
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
      state.librarySearch = els.tagFilterSearchInput.value;
      render();
    });
    els.tagFilterSearchInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        render();
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
      syncProviderControls();
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
