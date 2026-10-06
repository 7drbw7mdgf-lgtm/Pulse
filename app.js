const state = {
      papers: [],
      vectors: new Map(),
      keywords: new Map(),
      links: [],
      explicitLinks: [],
      linkTypeFilter: 'all',
      librarySearch: '',
      explorationDepth: '2',
      workspaceView: 'discover',
      inspectorOpen: false,
      discoveryHasRun: false,
      discoveryError: '',
      discoveryJob: null,
      discoveryStatus: '',
      discoveryWarnings: [],
      clusters: [],
      selectedId: null,
      selectedLinkId: null,
      centerId: null,
      areas: [],
      selectedAreaId: null,
      recommendations: new Map(),
      recommendationLoadingKey: null,
      citationLoading: false,
      seminalSuggestions: [],
      tableFilters: {},
      tableSort: { key: 'paper', direction: 'asc' },
      tableColumns: ['paper', 'authors', 'year', 'venue', 'keywords', 'findings', 'links'],
      recommendationSteerKeywords: [],
      recommendationExcludeKeywords: [],
      recommendationAuthors: [],
      recommendationJournals: [],
      graphSteerKeywords: [],
      recommendationRecencyTilt: 0,
      recommendationImpactTilt: 0,
      recommendationSteerOpen: false,
      discoveryBranches: {
        citationGraph: true,
        citationNetwork: true,
        semanticSearch: true,
        lexicalSearch: true,
      },
      discoveryLoading: false,
      discoveryResults: [],
      discoverySeed: null,
      pinnedSeedId: null,
      discoveryFilterText: '',
      discoveryFilterAuthor: '',
      discoveryFilterYear: 'all',
      discoveryFilterBranch: 'all',
      discoverySortBy: 'score',
      discoverySelectedKeys: new Set(),
      discoveryExpandedAbstracts: new Set(),
      discoveryQuickTag: '',
      filterTags: [],
      filterMode: 'all',
      mode: 'network',
      paperView: 'compact',
      threshold: 0.05,
      graphStyle: {
        nodeSize: 22,
        edgeScale: 0.65,
        spacing: 1,
        labelMode: 'short',
        showGrid: true,
        showAreas: true
      },
      view: { x: 0, y: 0, width: 640, height: 520 },
      drag: null,
      panDrag: null,
      localInferenceEnabled: false,
      autosaveReady: false,
      autosaveTimer: null,
      activeKeywordPaperId: null,
      detailsAbstractExpanded: false
    };

    const launchParams = new URLSearchParams(window.location.search);
    const apiToken = launchParams.get('token') || launchParams.get('pulseToken') || launchParams.get('iratxeToken') || window.__PULSE_API_TOKEN__ || window.__IRATXE_API_TOKEN__ || '';
    const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';

    const stopwords = new Set(`
      a about above across after again against all almost alone along already also although always among an and another any
      are around as at be because been before being below between both but by can cannot could did do does done due during
      each either enough especially etc for found from further had has have having here how however i if in into is it its
      itself just less may might more most mostly must no nor not of often on only or other our out over paper papers per
      perhaps prior quite rather really regarding same should show showed shown shows since so some such than that the their
      them then there therefore these they this those through to toward under until up upon use used using very was we were
      what when where whether which while who whose will with within without would
    `.split(/\s+/).filter(Boolean));

    const palette = ['#0f7c74', '#d05a33', '#2f77b4', '#7a9b35', '#b66a8f', '#7b6bb5', '#b98522', '#4d7888'];

    const els = {
      app: document.getElementById('app'),
      dropzone: document.getElementById('dropzone'),
      fileInput: document.getElementById('fileInput'),
      threshold: document.getElementById('threshold'),
      thresholdValue: document.getElementById('thresholdValue'),
      paperList: document.getElementById('paperList'),
      paperCount: document.getElementById('paperCount'),
      paperViewToggle: document.getElementById('paperViewToggle'),
      map: document.getElementById('map'),
      tableView: document.getElementById('tableView'),
      emptyState: document.getElementById('emptyState'),
      details: document.getElementById('details'),
      timelineView: document.getElementById('timelineView'),
      discoveryRunButton: document.getElementById('discoveryRunButton'),
      discoverySeedSelect: document.getElementById('discoverySeedSelect'),
      discoveryProgress: document.getElementById('discoveryProgress'),
      discoveryCancelButton: document.getElementById('discoveryCancelButton'),
      quickSearchInput: document.getElementById('quickSearchInput'),
      quickAddBtn: document.getElementById('quickAddBtn'),
      railLibraryBadge: document.getElementById('railLibraryBadge'),
      railRecentList: document.getElementById('railRecentList'),
      railSettingsBtn: document.getElementById('railSettingsBtn'),
      canvasLayoutSelect: document.getElementById('canvasLayoutSelect'),
      canvasLinksSelect: document.getElementById('canvasLinksSelect'),
      showLabelsToggle: document.getElementById('showLabelsToggle'),
      blowUpButton: document.getElementById('blowUpButton'),
      compressButton: document.getElementById('compressButton'),
      dockBlowUpButton: document.getElementById('dockBlowUpButton'),
      blowUpGraphButton: document.getElementById('blowUpGraphButton'),
      compressGraphButton: document.getElementById('compressGraphButton'),
      fitCanvasButton: document.getElementById('fitCanvasButton'),
      addPaperDropBtn: document.getElementById('addPaperDropBtn'),
      graphLegend: document.getElementById('graphLegend'),
      linkageButton: document.getElementById('linkageButton'),
      linkagePanel: document.getElementById('linkagePanel'),
      linkageCloseButton: document.getElementById('linkageCloseButton'),
      linkageSummary: document.getElementById('linkageSummary'),
      linkageList: document.getElementById('linkageList'),
      clearLinkageButton: document.getElementById('clearLinkageButton'),
      graphButton: document.getElementById('graphButton'),
      graphPanel: document.getElementById('graphPanel'),
      graphCloseButton: document.getElementById('graphCloseButton'),
      nodeSizeInput: document.getElementById('nodeSizeInput'),
      nodeSizeValue: document.getElementById('nodeSizeValue'),
      edgeScaleInput: document.getElementById('edgeScaleInput'),
      edgeScaleValue: document.getElementById('edgeScaleValue'),
      spacingInput: document.getElementById('spacingInput'),
      spacingValue: document.getElementById('spacingValue'),
      labelModeInput: document.getElementById('labelModeInput'),
      gridToggleInput: document.getElementById('gridToggleInput'),
      areasToggleInput: document.getElementById('areasToggleInput'),
      resetGraphStyleButton: document.getElementById('resetGraphStyleButton'),
      areaButton: document.getElementById('areaButton'),
      areaPanel: document.getElementById('areaPanel'),
      areaCloseButton: document.getElementById('areaCloseButton'),
      addAreaButton: document.getElementById('addAreaButton'),
      areaList: document.getElementById('areaList'),
      statusText: document.getElementById('statusText'),
      metricPapers: document.getElementById('metricPapers'),
      metricLinks: document.getElementById('metricLinks'),
      metricClusters: document.getElementById('metricClusters'),
      exportButton: document.getElementById('exportButton'),
      summaryExportButton: document.getElementById('summaryExportButton'),
      importButton: document.getElementById('importButton'),
      geminiKeyInput: document.getElementById('geminiKeyInput'),
      cloudModelInput: document.getElementById('cloudModelInput'),
      headerSampleBtn: document.getElementById('headerSampleBtn'),
      headerImportBtn: document.getElementById('headerImportBtn'),
      headerExportBtn: document.getElementById('headerExportBtn'),
      headerSummaryBtn: document.getElementById('headerSummaryBtn'),
      headerSettingsBtn: document.getElementById('headerSettingsBtn'),
      saveStatePill: document.getElementById('save-state-pill'),
      themeLight: document.getElementById('theme-light'),
      themeDark: document.getElementById('theme-dark'),
      importInput: document.getElementById('importInput'),
      sampleButton: document.getElementById('sampleButton'),
      panelToggleButton: document.getElementById('panelToggleButton'),
      showPanelButton: document.getElementById('showPanelButton'),
      settingsButton: document.getElementById('settingsButton'),
      settingsPanel: document.getElementById('settingsPanel'),
      settingsCloseButton: document.getElementById('settingsCloseButton'),
      backendStatus: document.getElementById('backendStatus'),
      gemmaStatus: document.getElementById('gemmaStatus'),
      embeddingStatus: document.getElementById('embeddingStatus'),
      vectorStatus: document.getElementById('vectorStatus'),
      dimensionsStatus: document.getElementById('dimensionsStatus'),
      backendUrlInput: document.getElementById('backendUrlInput'),
      aiProviderInput: document.getElementById('aiProviderInput'),
      cloudProviderInput: document.getElementById('cloudProviderInput'),
      ollamaChatEndpointInput: document.getElementById('ollamaChatEndpointInput'),
      gemmaModelInput: document.getElementById('gemmaModelInput'),
      ollamaModelSelect: document.getElementById('ollamaModelSelect'),
      embeddingModelInput: document.getElementById('embeddingModelInput'),
      vectorDbInput: document.getElementById('vectorDbInput'),
      dimensionsKeyInput: document.getElementById('dimensionsKeyInput'),
      semanticScholarKeyInput: document.getElementById('semanticScholarKeyInput'),
      autoGemmaExtractionInput: document.getElementById('autoGemmaInput'),
      backendDiagnostics: document.getElementById('backendDiagnostics'),
      saveSettingsButton: document.getElementById('saveSettingsButton'),
      testBackendButton: document.getElementById('testBackendButton'),
      clearDimensionsKeyButton: document.getElementById('clearDimensionsKeyButton'),
      clearSemanticScholarKeyButton: document.getElementById('clearSemanticScholarKeyButton'),
      aiButton: document.getElementById('aiButton'),
      aiPanel: document.getElementById('aiPanel'),
      aiCloseButton: document.getElementById('aiCloseButton'),
      aiPrompt: document.getElementById('aiPrompt'),
      aiAnalyzeButton: document.getElementById('aiAnalyzeButton'),
      aiResult: document.getElementById('aiResult'),
      loadProgress: document.getElementById('loadProgress'),
      loadProgressBar: document.getElementById('loadProgressBar'),
      loadProgressText: document.getElementById('loadProgressText'),
      toast: document.getElementById('toast'),
      discoveryModal: document.getElementById('discoveryModal'),
      discoveryModalCloseButton: document.getElementById('discoveryModalCloseButton'),
      discoveryModalTitle: document.getElementById('discoveryModalTitle'),
      discoveryModalSubtitle: document.getElementById('discoveryModalSubtitle'),
      discoveryFilterText: document.getElementById('discoveryFilterText'),
      discoveryClearTextBtn: document.getElementById('discoveryClearTextBtn'),
      discoveryFilterAuthor: document.getElementById('discoveryFilterAuthor'),
      discoveryFilterYear: document.getElementById('discoveryFilterYear'),
      discoverySortBy: document.getElementById('discoverySortBy'),
      branchCountAll: document.getElementById('branchCountAll'),
      branchCountSpecter: document.getElementById('branchCountSpecter'),
      branchCountNetwork: document.getElementById('branchCountNetwork'),
      branchCountCitation: document.getElementById('branchCountCitation'),
      branchCountLexical: document.getElementById('branchCountLexical'),
      discoverySelectAllBtn: document.getElementById('discoverySelectAllBtn'),
      discoveryDeselectAllBtn: document.getElementById('discoveryDeselectAllBtn'),
      discoverySelectTopBtn: document.getElementById('discoverySelectTopBtn'),
      discoveryKeywordChipsRow: document.getElementById('discoveryKeywordChipsRow'),
      discoveryKeywordChipsList: document.getElementById('discoveryKeywordChipsList'),
      discoveryCountSummary: document.getElementById('discoveryCountSummary'),
      discoverySelectedCount: document.getElementById('discoverySelectedCount'),
      discoveryPaperList: document.getElementById('discoveryPaperList'),
      discoveryModalCancelBtn: document.getElementById('discoveryModalCancelBtn'),
      discoveryAddSelectedLibraryBtn: document.getElementById('discoveryAddSelectedLibraryBtn'),
      discoveryAddSelectedMapBtn: document.getElementById('discoveryAddSelectedMapBtn'),
      keywordModal: document.getElementById('keywordModal'),
      keywordModalCloseButton: document.getElementById('keywordModalCloseButton'),
      keywordModalDoneButton: document.getElementById('keywordModalDoneButton'),
      keywordModalSubtitle: document.getElementById('keywordModalSubtitle'),
      keywordTagList: document.getElementById('keywordTagList'),
      keywordTagCount: document.getElementById('keywordTagCount'),
      newKeywordInput: document.getElementById('newKeywordInput'),
      addKeywordButton: document.getElementById('addKeywordButton'),
      keywordSuggestionsSection: document.getElementById('keywordSuggestionsSection'),
      keywordSuggestionsList: document.getElementById('keywordSuggestionsList'),
      tagFilterBar: document.getElementById('tagFilterBar'),
      activeFilterBadge: document.getElementById('activeFilterBadge'),
      clearTagFiltersButton: document.getElementById('clearTagFiltersButton'),
      activeTagFiltersList: document.getElementById('activeTagFiltersList'),
      tagFilterSearchInput: document.getElementById('tagFilterSearchInput'),
      toggleTagFilterDropdown: document.getElementById('toggleTagFilterDropdown'),
      tagFilterDropdown: document.getElementById('tagFilterDropdown'),
      libraryTagCloud: document.getElementById('libraryTagCloud'),
      canvasFilterBar: document.getElementById('canvasFilterBar'),
      canvasFilterTags: document.getElementById('canvasFilterTags'),
      canvasClearFilterButton: document.getElementById('canvasClearFilterButton'),
      tagActionMenu: document.getElementById('tagActionMenu'),
      tagActionMenuTitle: document.getElementById('tagActionMenuTitle'),
      closeTagActionMenuButton: document.getElementById('closeTagActionMenuButton'),
      tagActionFilterLabel: document.getElementById('tagActionFilterLabel'),
      tagActionSteerLabel: document.getElementById('tagActionSteerLabel'),
      tagActionGraphLabel: document.getElementById('tagActionGraphLabel'),
      tagActionExcludeLabel: document.getElementById('tagActionExcludeLabel'),
      canvasTitle: document.querySelector('.canvas-title'),
      clearButton: document.getElementById('clearButton'),
      sidebarClearButton: document.getElementById('sidebarClearButton'),
      clearAppToDefaultButton: document.getElementById('clearAppToDefaultButton'),
      clearAppToDefaultQuickButton: document.getElementById('clearAppToDefaultQuickButton'),
      storagePaperCount: document.getElementById('storagePaperCount'),
      storageLinkCount: document.getElementById('storageLinkCount')
    };

    const featherPaths = {
      'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>',
      settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.15.58.6 1.03 1.18 1.18H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"></path>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M17 8l-5-5-5 5"></path><path d="M12 3v12"></path>',
      'trash-2': '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>',
      grid: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
      cpu: '<rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><path d="M9 1v3"></path><path d="M15 1v3"></path><path d="M9 20v3"></path><path d="M15 20v3"></path><path d="M20 9h3"></path><path d="M20 14h3"></path><path d="M1 9h3"></path><path d="M1 14h3"></path>',
      sliders: '<path d="M4 21v-7"></path><path d="M4 10V3"></path><path d="M12 21v-9"></path><path d="M12 8V3"></path><path d="M20 21v-5"></path><path d="M20 12V3"></path><path d="M1 14h6"></path><path d="M9 8h6"></path><path d="M17 16h6"></path>',
      square: '<rect x="3" y="3" width="18" height="18" rx="2"></rect>',
      'share-2': '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="M8.59 13.51l6.83 3.98"></path><path d="M15.41 6.51L8.59 10.49"></path>',
      compass: '<circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>',
      'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline>',
      folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
      search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
      star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
      clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
      'maximize-2': '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>',
      'minimize-2': '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line>'
    };

    function featherSvg(name) {
      const paths = featherPaths[name] || featherPaths.square;
      return `<svg class="feather-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    }

    function replaceFeatherIcons(root = document) {
      root.querySelectorAll('[data-feather]').forEach(icon => {
        icon.innerHTML = featherSvg(icon.dataset.feather);
      });
    }

    function uid() {
      return Math.random().toString(36).slice(2, 10);
    }

    function bottomDockSpace() {
      const el = document.querySelector('.pulse-workspace-cols') || document.querySelector('.workspace') || document.body;
      const value = el ? Number.parseFloat(getComputedStyle(el).getPropertyValue('--bottom-dock-space')) : 84;
      return Number.isFinite(value) ? value : 84;
    }

    function showToast(message) {
      els.toast.textContent = message;
      els.toast.classList.add('is-visible');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => els.toast.classList.remove('is-visible'), 2600);
    }

    function setLoadProgress(current, total, label = '') {
      if (!els.loadProgress) return;
      if (!total) {
        els.loadProgress.hidden = true;
        els.loadProgressBar.style.width = '0%';
        els.loadProgressText.textContent = 'Loading papers...';
        return;
      }
      const percent = Math.max(4, Math.min(100, Math.round((current / total) * 100)));
      els.loadProgress.hidden = false;
      els.loadProgressBar.style.width = `${percent}%`;
      els.loadProgressText.textContent = label || `Loading ${current} of ${total} paper file${total === 1 ? '' : 's'}...`;
    }

    function setAiPanelOpen(open) {
      els.aiPanel.hidden = !open;
      els.aiButton.setAttribute('aria-expanded', String(open));
    }

    function setLinkagePanelOpen(open) {
      els.linkagePanel.hidden = !open;
      els.linkageButton.setAttribute('aria-expanded', String(open));
      if (open) renderLinkages();
    }

    function setAreaPanelOpen(open) {
      els.areaPanel.hidden = !open;
      els.areaButton.setAttribute('aria-expanded', String(open));
      if (open) renderAreasPanel();
    }

    function setGraphPanelOpen(open) {
      els.graphPanel.hidden = !open;
      els.graphButton.setAttribute('aria-expanded', String(open));
      if (open) syncGraphControls();
    }

    function setSettingsOpen(open) {
      els.settingsPanel.hidden = !open;
      els.settingsButton.setAttribute('aria-expanded', String(open));
      if (open) loadBackendSettings();
    }

    function discoveryPaperKey(item) {
      if (!item) return '';
      const doi = (item.doi || '').trim().toLowerCase();
      if (doi) return `doi:${doi}`;
      if (item.s2PaperId) return `s2:${item.s2PaperId}`;
      if (item.openAlexId) return `oa:${item.openAlexId}`;
      return `t:${cleanField(item.title || '').toLowerCase()}`;
    }

    function openDiscoveryModal(results, seedPaper) {
      state.discoveryResults = results || [];
      state.discoverySeed = seedPaper || state.papers.find(p => p.id === state.selectedId) || state.papers[0];
      state.discoveryFilterText = '';
      state.discoveryFilterAuthor = '';
      state.discoveryFilterYear = 'all';
      state.discoveryFilterBranch = 'all';
      state.discoverySortBy = 'score';
      state.discoveryQuickTag = '';
      state.discoveryExpandedAbstracts = new Set();

      state.discoverySelectedKeys = new Set();
      state.discoveryHasRun = true;

      if (els.discoveryFilterText) els.discoveryFilterText.value = '';
      if (els.discoveryClearTextBtn) els.discoveryClearTextBtn.hidden = true;
      if (els.discoveryFilterAuthor) els.discoveryFilterAuthor.value = '';
      if (els.discoveryFilterYear) els.discoveryFilterYear.value = 'all';
      if (els.discoverySortBy) els.discoverySortBy.value = 'score';

      setWorkspaceView('discover');
      renderDiscoveryModal();
      if (els.discoveryFilterText) els.discoveryFilterText.focus();
    }

    function closeDiscoveryModal() {
      setWorkspaceView('network');
    }

    function getFilteredDiscoveryPapers() {
      const items = state.discoveryResults || [];
      const query = (state.discoveryFilterText || '').trim().toLowerCase();
      const authorQuery = (state.discoveryFilterAuthor || '').trim().toLowerCase();
      const yearFilter = state.discoveryFilterYear || 'all';
      const branchFilter = state.discoveryFilterBranch || 'all';
      const quickTag = (state.discoveryQuickTag || '').trim().toLowerCase();

      return items.filter(item => {
        if (quickTag) {
          const tags = [...(item.paperKeywords || []), ...(item.discoveryBadges || []), ...(item.matchedConcepts || [])].map(t => t.toLowerCase());
          const matchQuick = tags.some(t => t.includes(quickTag)) ||
            (item.title || '').toLowerCase().includes(quickTag) ||
            (item.abstract || '').toLowerCase().includes(quickTag);
          if (!matchQuick) return false;
        }

        if (query) {
          const haystack = [
            item.title || '',
            item.abstract || '',
            item.journal || '',
            item.doi || '',
            ...(item.paperKeywords || []),
            ...(item.discoveryBadges || []),
            ...(item.matchedConcepts || []),
            item.reason || ''
          ].join(' ').toLowerCase();
          if (!haystack.includes(query)) return false;
        }

        if (authorQuery) {
          const authorHaystack = (Array.isArray(item.authors) ? item.authors.join(' ') : String(item.authors || '')).toLowerCase();
          if (!authorHaystack.includes(authorQuery)) return false;
        }

        if (yearFilter !== 'all') {
          const yMatch = String(item.year || item.date || '').match(/\b(19|20)\d{2}\b/);
          const y = yMatch ? parseInt(yMatch[0], 10) : 0;
          if (yearFilter === 'older') {
            if (y >= 2015) return false;
          } else {
            const minYear = parseInt(yearFilter, 10);
            if (isNaN(minYear) || y < minYear) return false;
          }
        }

        if (branchFilter !== 'all') {
          if (branchFilter === 'semanticSearch') {
            const isSpecter = item.branch === 'semanticSearch' ||
              Boolean(item.branchHits?.semanticSearch) ||
              (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
            if (!isSpecter) return false;
          } else if (branchFilter === 'citationNetwork') {
            const isNetwork = item.branch === 'citationNetwork' ||
              Boolean(item.branchHits?.citationNetwork) ||
              (item.discoveryBadges || []).some(b => b.includes('Co-citation') || b.includes('Bib Coupling'));
            if (!isNetwork) return false;
          } else if (branchFilter === 'citationGraph') {
            const isGraph = item.branch === 'citationGraph' ||
              Boolean(item.branchHits?.citationGraph) ||
              (item.discoveryBadges || []).some(b => b.includes('Backward') || b.includes('Forward') || b.includes('2-Hop') || b.includes('Cite'));
            if (!isGraph) return false;
          } else if (branchFilter === 'lexicalConceptual') {
            const isLexical = item.branch === 'lexicalConceptual' ||
              Boolean(item.branchHits?.lexicalConceptual) ||
              (item.discoveryBadges || []).some(b => b.includes('Concept') || b.includes('Search'));
            if (!isLexical) return false;
          }
        }

        return true;
      }).sort((a, b) => {
        const sortBy = state.discoverySortBy || 'score';
        if (sortBy === 'citations') {
          return (b.citedByCount || 0) - (a.citedByCount || 0);
        }
        if (sortBy === 'year-desc') {
          const yA = parseInt(String(a.year || a.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          const yB = parseInt(String(b.year || b.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          return yB - yA;
        }
        if (sortBy === 'year-asc') {
          const yA = parseInt(String(a.year || a.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          const yB = parseInt(String(b.year || b.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          return yA - yB;
        }
        if (sortBy === 'title') {
          return (a.title || '').localeCompare(b.title || '');
        }
        return (b.score || 0) - (a.score || 0);
      });
    }

    function renderDiscoveryModal() {
      if (!els.discoveryModal || els.discoveryModal.hidden) return;

      const totalItems = state.discoveryResults || [];
      const filtered = getFilteredDiscoveryPapers();

      if (els.discoveryModalSubtitle) {
        const seedTitle = state.discoverySeed?.title || '';
        els.discoveryModalSubtitle.textContent = totalItems.length ? `${totalItems.length} candidates found from “${seedTitle}”. Review them before adding them to your map.` : 'Start with a paper, choose your search methods, then review related work.';
      }

      const countSpecter = totalItems.filter(item => item.branch === 'semanticSearch' || item.branchHits?.semanticSearch || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'))).length;
      const countNetwork = totalItems.filter(item => item.branch === 'citationNetwork' || item.branchHits?.citationNetwork || (item.discoveryBadges || []).some(b => b.includes('Co-citation') || b.includes('Bib Coupling'))).length;
      const countCitation = totalItems.filter(item => item.branch === 'citationGraph' || item.branchHits?.citationGraph || (item.discoveryBadges || []).some(b => b.includes('Backward') || b.includes('Forward') || b.includes('2-Hop') || b.includes('Cite'))).length;
      const countLexical = totalItems.filter(item => item.branch === 'lexicalConceptual' || item.branchHits?.lexicalConceptual || (item.discoveryBadges || []).some(b => b.includes('Concept') || b.includes('Search'))).length;

      if (els.branchCountAll) els.branchCountAll.textContent = String(totalItems.length);
      if (els.branchCountSpecter) els.branchCountSpecter.textContent = String(countSpecter);
      if (els.branchCountNetwork) els.branchCountNetwork.textContent = String(countNetwork);
      if (els.branchCountCitation) els.branchCountCitation.textContent = String(countCitation);
      if (els.branchCountLexical) els.branchCountLexical.textContent = String(countLexical);

      els.discoveryModal.querySelectorAll('.branch-filter-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.branch === (state.discoveryFilterBranch || 'all'));
      });

      const tagFreq = new Map();
      totalItems.forEach(item => {
        (item.paperKeywords || []).concat(item.matchedConcepts || []).forEach(term => {
          const t = cleanField(term).trim();
          if (t && t.length > 2 && !stopwords.has(t.toLowerCase())) {
            const key = t.toLowerCase();
            tagFreq.set(key, { term: t, count: (tagFreq.get(key)?.count || 0) + 1 });
          }
        });
      });
      const topTags = Array.from(tagFreq.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      if (els.discoveryKeywordChipsRow && els.discoveryKeywordChipsList) {
        if (topTags.length > 0) {
          els.discoveryKeywordChipsRow.hidden = false;
          els.discoveryKeywordChipsList.innerHTML = topTags.map(tag => {
            const isActive = state.discoveryQuickTag?.toLowerCase() === tag.term.toLowerCase();
            return `<button class="discovery-filter-chip ${isActive ? 'is-active' : ''}" type="button" data-tag="${escapeHtml(tag.term)}">${escapeHtml(tag.term)} (${tag.count})</button>`;
          }).join('');
        } else {
          els.discoveryKeywordChipsRow.hidden = true;
        }
      }

      const selectedCount = state.discoverySelectedKeys.size;
      if (els.discoveryCountSummary) {
        els.discoveryCountSummary.textContent = `Showing ${filtered.length} of ${totalItems.length} papers`;
      }
      if (els.discoverySelectedCount) {
        els.discoverySelectedCount.textContent = `${selectedCount} selected`;
      }
      if (els.discoveryAddSelectedMapBtn) {
        els.discoveryAddSelectedMapBtn.textContent = `Add selected & open network (${selectedCount})`;
        els.discoveryAddSelectedMapBtn.disabled = selectedCount === 0 || state.discoveryLoading;
      }
      if (els.discoveryAddSelectedLibraryBtn) {
        els.discoveryAddSelectedLibraryBtn.textContent = `+ Add to Library (${selectedCount})`;
        els.discoveryAddSelectedLibraryBtn.disabled = selectedCount === 0 || state.discoveryLoading;
      }

      if (!els.discoveryPaperList) return;
      if (!filtered.length) {
        els.discoveryPaperList.innerHTML = `
          <div class="discovery-empty-state">
            <span class="discovery-empty-icon">${state.discoveryLoading ? '◌' : '↗'}</span>
            <div class="discovery-empty-text">${state.discoveryLoading ? 'Finding related work…' : totalItems.length ? 'No papers match these filters' : state.discoveryError ? 'This search could not finish' : state.discoveryHasRun ? 'No related papers found' : 'One paper is enough to begin'}</div>
            <div class="discovery-empty-subtext">${escapeHtml(state.discoveryError || (totalItems.length ? 'Clear a filter to see more results.' : state.discoveryHasRun ? 'Try another starting paper or enable another search method.' : 'Add a title, DOI, PMID or PDF above. Choose your starting paper, then find related work.'))}</div>
          </div>
        `;
        return;
      }

      els.discoveryPaperList.innerHTML = filtered.map(item => {
        const key = discoveryPaperKey(item);
        const isSelected = state.discoverySelectedKeys.has(key);
        const inLibrary = recommendationAlreadyOnMap(item);
        const isExpanded = state.discoveryExpandedAbstracts.has(key);

        const authorList = Array.isArray(item.authors) ? item.authors : (item.authors ? [item.authors] : []);
        const authorStr = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';

        const metaParts = [
          authorStr,
          item.year || item.date || '',
          item.journal || item.venue || '',
          item.doi ? `DOI ${item.doi}` : '',
          item.citedByCount ? `${item.citedByCount} citations` : '',
          item.influentialCitationCount ? `⭐ ${item.influentialCitationCount} influential` : ''
        ].filter(Boolean);

        const badgesHtml = (item.discoveryBadges || []).map(b => {
          let cls = 'badge-general';
          if (b.includes('SPECTER2')) cls = 'badge-specter';
          else if (b.includes('Co-citation')) cls = 'badge-cocitation';
          else if (b.includes('Bib Coupling')) cls = 'badge-bibcoupling';
          else if (b.includes('2-Hop')) cls = 'badge-chase';
          else if (b.includes('Influential')) cls = 'badge-influential';
          else if (b.includes('Backward') || b.includes('Forward') || b.includes('Cite')) cls = 'badge-citation';
          else cls = 'badge-concept';
          return `<span class="discovery-badge ${cls}">${escapeHtml(b)}</span>`;
        }).join('');

        const scorePill = item.score !== undefined ? `
          <span class="discovery-score-pill-modal" title="Total Score: ${item.score} | Relevance: ${item.scoreBreakdown?.relevance || 0} | Proximity: ${item.scoreBreakdown?.citationProximity || 0} | Semantic: ${item.scoreBreakdown?.semanticSimilarity || 0} | Convergence: +${item.scoreBreakdown?.convergenceBonus || 0}">
            Score ${Math.round(item.score)}
          </span>
        ` : '';

        const abstractText = item.abstract || item.reason || '';
        const href = item.url || (item.doi ? `https://doi.org/${item.doi}` : '');

        return `
          <article class="discovery-paper-item ${isSelected ? 'is-selected' : ''}" data-paper-key="${escapeHtml(key)}">
            <div class="discovery-checkbox-col">
              <input type="checkbox" class="discovery-item-checkbox" data-paper-key="${escapeHtml(key)}" ${isSelected ? 'checked' : ''} aria-label="Select paper">
            </div>
            <div class="discovery-paper-content">
              <div class="discovery-paper-top">
                <h3 class="discovery-paper-title">
                  ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">${escapeHtml(item.title || 'Untitled')}</a>` : escapeHtml(item.title || 'Untitled')}
                </h3>
                <div class="discovery-item-actions-top">
                  ${inLibrary ? '<span class="already-added-pill">✓ In Library</span>' : ''}
                  ${scorePill}
                </div>
              </div>

              <div class="discovery-paper-meta">
                ${metaParts.map(part => `<span>${escapeHtml(part)}</span>`).join('<span class="separator">•</span>')}
              </div>

              ${badgesHtml ? `<div class="discovery-paper-badges">${badgesHtml}</div>` : ''}

              ${abstractText ? `
                <div class="discovery-abstract-drawer" onclick="event.stopPropagation()">
                  <div class="discovery-abstract-text ${isExpanded ? '' : 'is-clamped'}">
                    ${escapeHtml(abstractText)}
                  </div>
                  ${abstractText.length > 140 ? `
                    <button class="discovery-abstract-expand-btn" type="button" data-toggle-abstract="${escapeHtml(key)}">
                      ${isExpanded ? '▲ Show less' : '▼ Show more abstract'}
                    </button>
                  ` : ''}
                </div>
              ` : ''}
            </div>
          </article>
        `;
      }).join('');

      els.discoveryPaperList.querySelectorAll('.discovery-paper-item').forEach(card => {
        card.addEventListener('click', event => {
          if (event.target.closest('a') || event.target.closest('.discovery-abstract-expand-btn')) return;
          const key = card.dataset.paperKey;
          if (!key) return;
          if (state.discoverySelectedKeys.has(key)) {
            state.discoverySelectedKeys.delete(key);
          } else {
            state.discoverySelectedKeys.add(key);
          }
          renderDiscoveryModal();
        });
      });

      els.discoveryPaperList.querySelectorAll('.discovery-item-checkbox').forEach(cb => {
        cb.addEventListener('click', event => {
          event.stopPropagation();
          const key = cb.dataset.paperKey;
          if (!key) return;
          if (cb.checked) {
            state.discoverySelectedKeys.add(key);
          } else {
            state.discoverySelectedKeys.delete(key);
          }
          renderDiscoveryModal();
        });
      });

      els.discoveryPaperList.querySelectorAll('[data-toggle-abstract]').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          const key = btn.dataset.toggleAbstract;
          if (state.discoveryExpandedAbstracts.has(key)) {
            state.discoveryExpandedAbstracts.delete(key);
          } else {
            state.discoveryExpandedAbstracts.add(key);
          }
          renderDiscoveryModal();
        });
      });

      if (els.discoveryKeywordChipsList) {
        els.discoveryKeywordChipsList.querySelectorAll('.discovery-filter-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const tag = btn.dataset.tag;
            if (state.discoveryQuickTag === tag) {
              state.discoveryQuickTag = '';
            } else {
              state.discoveryQuickTag = tag;
            }
            renderDiscoveryModal();
          });
        });
      }
    }

    function addSelectedDiscoveredToMap() {
      if (!state.discoveryResults?.length) return;
      const seed = state.discoverySeed || state.papers.find(p => p.id === state.selectedId) || state.papers[0];
      const selectedItems = state.discoveryResults.filter(item => state.discoverySelectedKeys.has(discoveryPaperKey(item)));
      if (!selectedItems.length) {
        showToast('Please select at least one paper using the tick boxes.');
        return;
      }

      let addedCount = 0;
      const totalToAdd = selectedItems.length;
      selectedItems.forEach((item, index) => {
        if (recommendationAlreadyOnMap(item)) return;
        const paper = paperFromRecommendation(item);
        const orbitIndex = Math.floor(index / 8);
        const posInOrbit = index % 8;
        const orbitRadius = 200 + orbitIndex * 120;
        const angle = (-Math.PI / 2) + posInOrbit * ((Math.PI * 2) / Math.min(8, Math.max(totalToAdd - orbitIndex * 8, 1)));
        paper.x = (seed?.x || state.view.x + state.view.width / 2) + Math.cos(angle) * orbitRadius;
        paper.y = (seed?.y || state.view.y + state.view.height / 2) + Math.sin(angle) * (orbitRadius * 0.85);
        paper.areaId = seed?.areaId || '';
        state.papers.push(paper);
        addedCount++;

        if (seed && seed.id !== paper.id) {
          const isBib = item.subType === 'Bibliographic coupling' || (item.discoveryBadges || []).some(b => b.includes('Bib Coupling'));
          const isCoCite = item.subType === 'Co-citation' || (item.discoveryBadges || []).some(b => b.includes('Co-citation'));
          const isSpecter = item.subType === 'SPECTER2' || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
          const ltype = isBib ? 'bibliographic' : (isCoCite ? 'cocitation' : (isSpecter ? 'similarity' : 'mixed'));
          state.explicitLinks.push({
            source: seed.id,
            target: paper.id,
            score: item.score ? Math.min(0.95, Math.max(0.4, item.score / 100)) : 0.82,
            type: ltype,
            evidence: item.reason || 'S2AG Literature Discovery recommendation'
          });
        }
      });

      closeDiscoveryModal();
      render();
      if (addedCount > 0) {
        showToast(`Added ${addedCount} discovered paper${addedCount === 1 ? '' : 's'} to map & library.`);
      } else {
        showToast('Selected papers were already on the map.');
      }
    }

    function addSelectedDiscoveredToLibrary() {
      if (!state.discoveryResults?.length) return;
      const selectedItems = state.discoveryResults.filter(item => state.discoverySelectedKeys.has(discoveryPaperKey(item)));
      if (!selectedItems.length) {
        showToast('Please select at least one paper using the tick boxes.');
        return;
      }

      let addedCount = 0;
      selectedItems.forEach(item => {
        if (recommendationAlreadyOnMap(item)) return;
        const paper = paperFromRecommendation(item);
        paper.x = state.view.x + state.view.width / 2 + (Math.random() - 0.5) * 200;
        paper.y = state.view.y + state.view.height / 2 + (Math.random() - 0.5) * 200;
        state.papers.push(paper);
        addedCount++;
      });

      setWorkspaceView('library');
      render();
      if (addedCount > 0) {
        showToast(`Added ${addedCount} discovered paper${addedCount === 1 ? '' : 's'} to library.`);
      } else {
        showToast('Selected papers were already in your library.');
      }
    }

    function openKeywordModal(paperId) {
      const paper = state.papers.find(item => item.id === paperId);
      if (!paper) return;
      state.activeKeywordPaperId = paperId;
      if (!Array.isArray(paper.paperKeywords) || !paper.paperKeywords.length) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      if (els.keywordModalSubtitle) {
        els.keywordModalSubtitle.textContent = paper.title || 'Untitled paper';
      }
      renderKeywordModalTags();
      if (els.keywordModal) els.keywordModal.hidden = false;
      if (els.newKeywordInput) {
        els.newKeywordInput.value = '';
        els.newKeywordInput.focus();
      }
    }

    function closeKeywordModal() {
      state.activeKeywordPaperId = null;
      if (els.keywordModal) els.keywordModal.hidden = true;
    }

    function renderKeywordModalTags() {
      if (!state.activeKeywordPaperId) return;
      const paper = state.papers.find(item => item.id === state.activeKeywordPaperId);
      if (!paper) {
        closeKeywordModal();
        return;
      }
      if (!Array.isArray(paper.paperKeywords)) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      const keywords = paper.paperKeywords;
      if (els.keywordTagCount) {
        els.keywordTagCount.textContent = `${keywords.length} tag${keywords.length === 1 ? '' : 's'}`;
      }

      if (!keywords.length) {
        els.keywordTagList.innerHTML = '<div class="keyword-empty-msg">No keyword tags yet. Add tags using the input above or suggestions below.</div>';
      } else {
        els.keywordTagList.innerHTML = keywords.map((term, index) => `
          <div class="keyword-tag-chip" draggable="true" data-index="${index}" data-keyword="${escapeHtml(term)}" title="Drag to reorder (#${index + 1} importance)">
            <span class="keyword-drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
            <span class="keyword-rank-badge" title="Importance rank #${index + 1}">#${index + 1}</span>
            <span class="keyword-tag-text">${escapeHtml(term)}</span>
            <div class="keyword-tag-actions">
              <button class="keyword-move-btn" type="button" data-action="move-tag-up" data-index="${index}" title="Increase importance (move left)" ${index === 0 ? 'disabled' : ''}>◀</button>
              <button class="keyword-move-btn" type="button" data-action="move-tag-down" data-index="${index}" title="Decrease importance (move right)" ${index === keywords.length - 1 ? 'disabled' : ''}>▶</button>
              <button class="keyword-remove-btn" type="button" data-action="remove-tag" data-index="${index}" title="Remove tag">×</button>
            </div>
          </div>
        `).join('');
      }

      // Move buttons
      els.keywordTagList.querySelectorAll('[data-action="move-tag-up"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          if (idx > 0) reorderPaperKeywords(paper.id, idx, idx - 1);
        });
      });
      els.keywordTagList.querySelectorAll('[data-action="move-tag-down"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          if (idx < keywords.length - 1) reorderPaperKeywords(paper.id, idx, idx + 1);
        });
      });
      els.keywordTagList.querySelectorAll('[data-action="remove-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          removePaperKeywordByIndex(paper.id, idx);
        });
      });

      // HTML5 Drag and Drop reordering
      els.keywordTagList.querySelectorAll('.keyword-tag-chip').forEach(chip => {
        chip.addEventListener('dragstart', event => {
          event.dataTransfer.setData('text/plain', chip.dataset.index);
          event.dataTransfer.effectAllowed = 'move';
          chip.classList.add('is-dragging');
        });
        chip.addEventListener('dragover', event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          chip.classList.add('is-dragover');
        });
        chip.addEventListener('dragleave', () => {
          chip.classList.remove('is-dragover');
        });
        chip.addEventListener('drop', event => {
          event.preventDefault();
          chip.classList.remove('is-dragover');
          const fromIdx = Number(event.dataTransfer.getData('text/plain'));
          const toIdx = Number(chip.dataset.index);
          if (!isNaN(fromIdx) && !isNaN(toIdx) && fromIdx !== toIdx) {
            reorderPaperKeywords(paper.id, fromIdx, toIdx);
          }
        });
        chip.addEventListener('dragend', () => {
          chip.classList.remove('is-dragging');
          els.keywordTagList.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
        });
      });

      // Suggestions from extracted terms, Gemma, discovery terms
      if (els.keywordSuggestionsSection && els.keywordSuggestionsList) {
        const activeSet = new Set(keywords.map(k => k.trim().toLowerCase()));
        const candidates = dedupeList([
          ...(paper.gemmaKeywords || []),
          ...(paper.discoveryTerms || []),
          ...(state.keywords.get(paper.id) || []),
          ...(paper.techniques || []),
          ...(paper.organisms || [])
        ].map(cleanField).filter(term => term.length >= 2 && term.length <= 48));

        const suggestions = candidates.filter(term => !activeSet.has(term.toLowerCase())).slice(0, 14);
        if (suggestions.length > 0) {
          els.keywordSuggestionsSection.hidden = false;
          els.keywordSuggestionsList.innerHTML = suggestions.map(term => `
            <button class="keyword-suggest-chip" type="button" data-term="${escapeHtml(term)}" title="Click to add as keyword tag">+ ${escapeHtml(term)}</button>
          `).join('');
          els.keywordSuggestionsList.querySelectorAll('.keyword-suggest-chip').forEach(btn => {
            btn.addEventListener('click', () => {
              addKeywordToPaper(paper.id, btn.dataset.term);
            });
          });
        } else {
          els.keywordSuggestionsSection.hidden = true;
        }
      }
    }

    function reorderPaperKeywords(paperId, fromIdx, toIdx) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper || !Array.isArray(paper.paperKeywords)) return;
      if (fromIdx < 0 || fromIdx >= paper.paperKeywords.length || toIdx < 0 || toIdx >= paper.paperKeywords.length) return;
      const [moved] = paper.paperKeywords.splice(fromIdx, 1);
      paper.paperKeywords.splice(toIdx, 0, moved);
      paper.keywords = [...paper.paperKeywords];
      renderKeywordModalTags();
      calculateRelatedness();
      render();
      scheduleAutosave();
    }

    function removePaperKeywordByIndex(paperId, index) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper || !Array.isArray(paper.paperKeywords)) return;
      const [removed] = paper.paperKeywords.splice(index, 1);
      if (removed) {
        const removedLower = removed.trim().toLowerCase();
        if (Array.isArray(paper.gemmaKeywords)) {
          paper.gemmaKeywords = paper.gemmaKeywords.filter(k => k.trim().toLowerCase() !== removedLower);
        }
        if (state.keywords.has(paper.id)) {
          state.keywords.set(paper.id, state.keywords.get(paper.id).filter(k => k.trim().toLowerCase() !== removedLower));
        }
        showToast(`Removed tag "${removed}".`);
      }
      paper.keywords = [...paper.paperKeywords];
      renderKeywordModalTags();
      calculateRelatedness();
      render();
      scheduleAutosave();
    }

    function addKeywordToPaper(paperId, newTerm) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper) return;
      const clean = cleanField(newTerm);
      if (!clean) return;
      if (!Array.isArray(paper.paperKeywords)) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      const lower = clean.toLowerCase();
      if (!paper.paperKeywords.some(k => k.trim().toLowerCase() === lower)) {
        paper.paperKeywords.push(clean);
        paper.keywords = [...paper.paperKeywords];
        showToast(`Added tag "${clean}".`);
        renderKeywordModalTags();
        calculateRelatedness();
        render();
        scheduleAutosave();
      }
    }

    function addKeywordsFromInput() {
      if (!state.activeKeywordPaperId || !els.newKeywordInput) return;
      const val = els.newKeywordInput.value.trim();
      if (!val) return;
      const terms = splitKeywords(val);
      const toAdd = terms.length ? terms : [val];
      toAdd.forEach(term => addKeywordToPaper(state.activeKeywordPaperId, term));
      els.newKeywordInput.value = '';
    }

    function paperMatchesFilters(paper) {
      const query = state.librarySearch.trim().toLowerCase();
      if (query && !`${paper.title} ${(paper.authors || []).join(' ')} ${paper.doi || ''} ${paper.abstract || ''} ${mergedKeywords(paper).join(' ')}`.toLowerCase().includes(query)) return false;
      if (!state.filterTags || !state.filterTags.length) return true;
      const paperTags = mergedKeywords(paper).map(k => k.toLowerCase().trim());
      if (state.filterMode === 'any') {
        return state.filterTags.some(tag => {
          const t = tag.toLowerCase().trim();
          return paperTags.some(k => k === t || k.includes(t) || t.includes(k));
        });
      }
      return state.filterTags.every(tag => {
        const t = tag.toLowerCase().trim();
        return paperTags.some(k => k === t || k.includes(t) || t.includes(k));
      });
    }

    function getLibraryAllTags() {
      const counts = new Map();
      state.papers.forEach(paper => {
        const kws = mergedKeywords(paper);
        kws.forEach(kw => {
          const cleaned = cleanField(kw);
          if (!cleaned) return;
          counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
        });
      });
      return Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    function renderTagFilterBar() {
      if (!els.tagFilterBar) return;
      const activeCount = state.filterTags.length;
      if (els.activeFilterBadge) {
        els.activeFilterBadge.hidden = activeCount === 0;
        els.activeFilterBadge.textContent = String(activeCount);
      }
      if (els.clearTagFiltersButton) {
        els.clearTagFiltersButton.hidden = activeCount === 0;
      }
      if (els.activeTagFiltersList) {
        els.activeTagFiltersList.innerHTML = state.filterTags.map(tag => `
          <span class="filter-tag-chip">
            <span>${escapeHtml(tag)}</span>
            <button class="remove-filter-btn" type="button" data-action="remove-filter-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove filter ${escapeHtml(tag)}">×</button>
          </span>
        `).join('');

        els.activeTagFiltersList.querySelectorAll('[data-action="remove-filter-tag"]').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            removeFilterTag(btn.dataset.tag);
          });
        });
      }

      renderLibraryTagCloud();

      if (els.canvasFilterBar && els.canvasFilterTags) {
        els.canvasFilterBar.hidden = activeCount === 0;
        if (activeCount > 0) {
          els.canvasFilterTags.innerHTML = state.filterTags.map(tag => `
            <span class="canvas-filter-pill">
              ${escapeHtml(tag)}
              <button type="button" data-action="remove-canvas-filter-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove filter ${escapeHtml(tag)}">×</button>
            </span>
          `).join('');

          els.canvasFilterTags.querySelectorAll('[data-action="remove-canvas-filter-tag"]').forEach(btn => {
            btn.addEventListener('click', e => {
              e.stopPropagation();
              removeFilterTag(btn.dataset.tag);
            });
          });
        }
      }
    }

    function renderLibraryTagCloud() {
      if (!els.libraryTagCloud) return;
      const allTags = getLibraryAllTags();
      const query = (els.tagFilterSearchInput?.value || '').trim().toLowerCase();
      const filtered = query
        ? allTags.filter(item => item.tag.toLowerCase().includes(query))
        : allTags;

      if (!filtered.length) {
        els.libraryTagCloud.innerHTML = allTags.length === 0
          ? '<div class="subtle-empty">No tags in library yet. Add tags or sample papers.</div>'
          : '<div class="subtle-empty">No matching tags found.</div>';
        return;
      }

      els.libraryTagCloud.innerHTML = filtered.slice(0, 48).map(item => {
        const isActive = state.filterTags.some(t => t.toLowerCase() === item.tag.toLowerCase());
        return `<button class="cloud-tag-chip${isActive ? ' is-active' : ''}" type="button" data-action="toggle-cloud-tag" data-tag="${escapeHtml(item.tag)}" title="Filter library by &quot;${escapeHtml(item.tag)}&quot;">
          ${escapeHtml(item.tag)} <span class="cloud-tag-count">${item.count}</span>
        </button>`;
      }).join('');

      els.libraryTagCloud.querySelectorAll('[data-action="toggle-cloud-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          toggleFilterTag(btn.dataset.tag);
        });
      });
    }

    function toggleFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      const idx = state.filterTags.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.filterTags.splice(idx, 1);
        showToast(`Removed tag filter: "${cleaned}"`);
      } else {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
      }
      renderTagFilterBar();
      render();
    }

    function addFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      if (!state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase())) {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
        renderTagFilterBar();
        render();
      }
    }

    function removeFilterTag(tag) {
      const cleaned = cleanField(tag);
      state.filterTags = state.filterTags.filter(t => t.toLowerCase() !== cleaned.toLowerCase());
      showToast(`Removed tag filter: "${cleaned}"`);
      renderTagFilterBar();
      render();
    }

    function clearFilterTags() {
      state.filterTags = [];
      state.librarySearch = '';
      if (els.tagFilterSearchInput) els.tagFilterSearchInput.value = '';
      showToast('Cleared all tag filters.');
      renderTagFilterBar();
      render();
    }

    function toggleRecommendationSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from recommendation steering.`);
      } else {
        state.recommendationSteerKeywords = dedupeList([cleaned, ...state.recommendationSteerKeywords]).slice(0, 12);
        state.recommendationSteerOpen = true;
        showToast(`Steering recommendations toward "${cleaned}".`);
      }
      renderDetails();
    }

    function toggleGraphSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.graphSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.graphSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from map focus.`);
      } else {
        state.graphSteerKeywords = dedupeList([cleaned, ...state.graphSteerKeywords]).slice(0, 12);
        showToast(`Refocusing map around "${cleaned}".`);
      }
      render();
    }

    function toggleExcludeSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationExcludeKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationExcludeKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from exclusions.`);
      } else {
        state.recommendationExcludeKeywords = dedupeList([cleaned, ...state.recommendationExcludeKeywords]).slice(0, 16);
        showToast(`Excluding recommendations with "${cleaned}".`);
      }
      renderDetails();
    }

    let currentTagActionTerm = '';

    function openTagActionMenu(term, anchorEl) {
      const cleaned = cleanField(term);
      if (!cleaned || !els.tagActionMenu || !anchorEl) return;
      currentTagActionTerm = cleaned;

      if (els.tagActionMenuTitle) els.tagActionMenuTitle.textContent = cleaned;

      const isFiltered = state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isSteered = state.recommendationSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isGraphSteered = state.graphSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isExcluded = state.recommendationExcludeKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());

      if (els.tagActionFilterLabel) {
        els.tagActionFilterLabel.textContent = isFiltered
          ? `Remove "${cleaned}" from library filter`
          : `Filter library by "${cleaned}"`;
      }
      if (els.tagActionSteerLabel) {
        els.tagActionSteerLabel.textContent = isSteered
          ? `Remove "${cleaned}" from recommendation steering`
          : `Steer recommendations toward "${cleaned}"`;
      }
      if (els.tagActionGraphLabel) {
        els.tagActionGraphLabel.textContent = isGraphSteered
          ? `Remove "${cleaned}" from map focus`
          : `Focus map graph around "${cleaned}"`;
      }
      if (els.tagActionExcludeLabel) {
        els.tagActionExcludeLabel.textContent = isExcluded
          ? `Remove "${cleaned}" from exclusions`
          : `Exclude recommendations with "${cleaned}"`;
      }

      const rect = anchorEl.getBoundingClientRect();
      const menuWidth = 260;
      const menuHeight = 220;
      let left = rect.left;
      let top = rect.bottom + 6;

      if (left + menuWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - menuWidth - 12);
      }
      if (top + menuHeight > window.innerHeight - 12) {
        top = Math.max(12, rect.top - menuHeight - 6);
      }

      els.tagActionMenu.style.left = `${Math.round(left)}px`;
      els.tagActionMenu.style.top = `${Math.round(top)}px`;
      els.tagActionMenu.hidden = false;
    }

    function closeTagActionMenu() {
      if (els.tagActionMenu) els.tagActionMenu.hidden = true;
      currentTagActionTerm = '';
    }

    function setPaperPanelHidden(hidden) {
      if (els.app) els.app.classList.toggle('panel-hidden', hidden);
      if (els.panelToggleButton) {
        els.panelToggleButton.textContent = hidden ? '>' : '<';
        els.panelToggleButton.title = hidden ? 'Show paper panel' : 'Hide paper panel';
        els.panelToggleButton.setAttribute('aria-label', hidden ? 'Show paper panel' : 'Hide paper panel');
        els.panelToggleButton.setAttribute('aria-expanded', String(!hidden));
      }
      if (els.showPanelButton) els.showPanelButton.setAttribute('aria-expanded', String(!hidden));
      window.requestAnimationFrame(() => render());
    }

    function backendUrl(path) {
      return `${apiBase}${path}`;
    }

    function backendNavigationUrl(path) {
      const url = new URL(backendUrl(path), window.location.href);
      if (apiToken) url.searchParams.set('token', apiToken);
      return url.toString();
    }

    function apiHeaders(extra = {}) {
      const headers = { ...extra };
      if (apiToken) {
        headers['X-Pulse-Token'] = apiToken;
        headers['X-Iratxe-Token'] = apiToken;
      }
      return headers;
    }

    function syncProviderControls() {
      const local = els.aiProviderInput.value === 'local';
      document.getElementById('cloudProviderGroup').hidden = local;
      document.getElementById('cloudSettingsStep').hidden = local;
      document.getElementById('localOllamaSettingsStep').hidden = !local;
      els.cloudProviderInput.disabled = local;
      els.ollamaChatEndpointInput.disabled = !local;
      els.ollamaModelSelect.disabled = !local;
      els.embeddingModelInput.disabled = !local;
      els.testBackendButton.disabled = false;
    }

    function visibleLinks() {
      return state.links.filter(link => state.linkTypeFilter === 'all' || link.type === state.linkTypeFilter);
    }

    function setWorkspaceView(view) {
      els.app.classList.remove('network-fullscreen');
      const fullButton = document.getElementById('networkFullscreenButton');
      fullButton.textContent = 'Full screen';
      fullButton.setAttribute('aria-pressed', 'false');
      state.workspaceView = view;
      state.inspectorOpen = false;
      if (view === 'timeline') state.mode = 'timeline';
      else if (view === 'library') state.mode = 'table';
      else if (view === 'network' && !['network', 'clusters', 'radial'].includes(state.mode)) state.mode = 'network';
      render();
    }

    function toggleNetworkFullscreen(force) {
      const full = typeof force === 'boolean' ? force : !els.app.classList.contains('network-fullscreen');
      els.app.classList.toggle('network-fullscreen', full);
      const button = document.getElementById('networkFullscreenButton');
      button.textContent = full ? 'Exit full screen' : 'Full screen';
      button.setAttribute('aria-pressed', String(full));
      render();
    }

    function setDiscoverySeed(id) {
      if(state.discoveryLoading && state.pinnedSeedId!==id)cancelDiscovery();
      state.selectedId = id;
      state.pinnedSeedId = id;
      state.selectedLinkId = null;
      if (state.discoverySeed?.id !== id) {
        state.discoveryStatus='';state.discoveryWarnings=[];
        state.discoveryResults = [];
        state.discoverySelectedKeys = new Set();
        state.discoveryHasRun = false;
        state.discoveryError = '';
      }
    }

    function renderDiscoveryWorkspace() {
      const seedId = state.pinnedSeedId || state.selectedId || state.papers[0]?.id || '';
      const seed = state.papers.find(paper => paper.id === seedId) || state.papers[0];
      els.discoverySeedSelect.innerHTML = state.papers.length ? state.papers.map(paper => `<option value="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}${paper.year ? ` (${escapeHtml(paper.year)})` : ''}</option>`).join('') : '<option value="">Add a paper above to begin</option>';
      els.discoverySeedSelect.value = seed?.id || '';
      const busy = state.discoveryLoading || state.citationLoading;
      els.discoverySeedSelect.disabled = !state.papers.length || busy;
      els.discoveryRunButton.disabled = !seed || busy || !Object.values(state.discoveryBranches).some(Boolean);
      els.discoveryRunButton.textContent = busy ? 'Finding papers…' : 'Find related papers';
      els.discoveryCancelButton.hidden = !state.discoveryLoading;
      els.discoveryProgress.hidden = !busy && !state.discoveryStatus && !state.discoveryWarnings.length;
      els.discoveryProgress.textContent = state.discoveryStatus || (busy ? `Searching from “${seed?.title || 'your paper'}”. Results will appear below.` : '');
      if(state.discoveryWarnings.length)els.discoveryProgress.textContent += ` ${state.discoveryWarnings.join(' ')}`;
      const hasResults = state.discoveryResults.length > 0;
      els.discoveryModal.querySelector('.discovery-modal-toolbar').hidden = !hasResults;
      els.discoveryModal.querySelector('.discovery-status-bar').hidden = !hasResults;
      els.discoveryModal.querySelector('.discovery-modal-footer').hidden = !hasResults;
      document.querySelectorAll('[data-depth], [data-method], [data-special]').forEach(button => button.disabled = busy || (!seed && Boolean(button.dataset.special)));
      renderDiscoveryModal();
    }

    function publicationDate(paper) {
      const raw = String(paper.date || '').trim();
      const iso = raw.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
      if (iso && Number(iso[1]) >= 1000) {
        return {time: Date.UTC(Number(iso[1]), Number(iso[2] || 1) - 1, Number(iso[3] || 1)), year: iso[1], label: raw};
      }
      const parsed = raw ? Date.parse(raw) : NaN;
      if (Number.isFinite(parsed)) return {time: parsed, year: String(new Date(parsed).getUTCFullYear()), label: raw};
      const year = String(paper.year || '').match(/\b([12]\d{3})\b/)?.[1];
      return year ? {time: Date.UTC(Number(year), 0, 1), year, label: year} : null;
    }

    function chronologicalPapers() {
      return state.papers.map(paper => ({paper, date: publicationDate(paper)})).sort((left, right) => {
        if (!left.date && right.date) return 1;
        if (left.date && !right.date) return -1;
        return (left.date?.time || 0) - (right.date?.time || 0) || left.paper.title.localeCompare(right.paper.title);
      });
    }

    function renderTimeline() {
      const ordered = chronologicalPapers();
      let previousYear = null;
      els.timelineView.innerHTML = `<header class="timeline-header"><span class="discovery-source-pill">Your research over time</span><h1>Timeline</h1><p>Oldest to newest · ${ordered.length} papers. Papers without a publication date appear at the end.</p></header><div class="timeline-track">${ordered.map(({paper, date}) => {
        const year = date?.year || 'Undated';
        const heading = year !== previousYear ? `<h2 class="timeline-year">${escapeHtml(year)}</h2>` : '';
        previousYear = year;
        return `${heading}<article class="timeline-paper" data-timeline-id="${escapeHtml(paper.id)}"><span class="timeline-date">${escapeHtml(date?.label || 'Date unknown')}</span><div><button type="button" class="timeline-paper-title" data-timeline-inspect="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}</button><p>${escapeHtml([paperAuthorSummary(paper), paper.journal].filter(Boolean).join(' · '))}</p>${paper.abstract ? `<p class="timeline-abstract">${escapeHtml(paper.abstract.slice(0, 180))}${paper.abstract.length > 180 ? '…' : ''}</p>` : ''}</div><button type="button" class="button secondary" data-timeline-discover="${escapeHtml(paper.id)}">Discover related</button></article>`;
      }).join('') || '<div class="timeline-empty">Add papers to see how the literature develops over time.</div>'}</div>`;
      els.timelineView.querySelectorAll('[data-timeline-inspect]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.timelineInspect;
        state.inspectorOpen = true;
        renderDetails();
      }));
      els.timelineView.querySelectorAll('[data-timeline-discover]').forEach(button => button.addEventListener('click', () => {
        setDiscoverySeed(button.dataset.timelineDiscover);
        setWorkspaceView('discover');
      }));
    }

    function syncWorkspaceControls() {
      els.app.dataset.workspace = state.workspaceView;
      els.discoveryModal.hidden = state.workspaceView !== 'discover';
      document.querySelector('.pulse-workspace-cols').hidden = state.workspaceView === 'discover';
      document.querySelectorAll('[data-rail]').forEach(button => {
        const active = button.dataset.rail === state.workspaceView;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      document.querySelectorAll('[data-mode]').forEach(button => {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      });
      els.canvasLayoutSelect.value = state.mode;
      els.canvasLinksSelect.value = state.linkTypeFilter;
      els.labelModeInput.value = state.graphStyle.labelMode;
      els.showLabelsToggle.checked = state.graphStyle.labelMode !== 'none';
      const branches = {citations:'citationGraph',network:'citationNetwork',semantic:'semanticSearch',concepts:'lexicalSearch'};
      document.querySelectorAll('[data-method]').forEach(button => {
        const active = Boolean(state.discoveryBranches[branches[button.dataset.method]]);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      document.querySelectorAll('[data-depth]').forEach(button => {
        const active = button.dataset.depth === state.explorationDepth;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      if (els.graphLegend) {
        els.graphLegend.innerHTML = state.clusters.map((cluster, index) => {
          const paper = state.papers.find(item => item.id === cluster[0]);
          const label = mergedKeywords(paper || {}).slice(0, 1)[0] || `Cluster ${index + 1}`;
          return `<div class="legend-row"><span class="legend-dot" style="background:${palette[index % palette.length]}"></span><span class="legend-label">${escapeHtml(label)} (${cluster.length})</span></div>`;
        }).join('');
      }
      if (els.railRecentList) {
        els.railRecentList.innerHTML = state.papers.slice(-4).reverse().map(paper => `<button type="button" class="recent-session-item" data-session-query="${escapeHtml(paper.doi || paper.pmid || paper.title)}"><span class="session-dot"></span><span class="session-info"><strong class="session-name">${escapeHtml(compactTitle(paper.title))}</strong><small class="session-time">${escapeHtml(paper.year || 'In library')}</small></span></button>`).join('') || '<p class="rail-empty">Recent papers will appear here.</p>';
      }
      if(state.workspaceView==='discover')renderDiscoveryWorkspace();
    }

    function renderBackendStatus(settings, message) {
      const url = apiBase || window.location.origin;
      els.backendUrlInput.value = url;
      els.backendStatus.classList.remove('is-ready', 'is-error');
      if (!settings) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = message || 'The app backend is offline. Reopen Pulse and try the connection check again.';
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = `${els.backendStatus.textContent}\nBackend URL: ${url}`;
        return;
      }

      const defaults = settings.defaults || {};
      els.aiProviderInput.value = settings.aiProvider || defaults.aiProvider || 'local';
      els.cloudProviderInput.value = 'gemini';
      els.ollamaChatEndpointInput.value = settings.ollamaChatEndpoint || defaults.ollamaChatEndpoint || 'http://127.0.0.1:11434/api/chat';
      els.gemmaModelInput.value = settings.gemmaModel || defaults.chatModel || 'gemma3:4b';
      els.embeddingModelInput.value = settings.embeddingModel || defaults.embeddingModel || 'nomic-embed-text';
      if (els.autoGemmaExtractionInput) els.autoGemmaExtractionInput.checked = settings.autoGemmaExtraction !== false;
      const isLocalProvider = els.aiProviderInput.value === 'local';
      els.cloudProviderInput.disabled = isLocalProvider;
      els.ollamaChatEndpointInput.disabled = !isLocalProvider;
      els.ollamaModelSelect.disabled = !isLocalProvider;
      els.embeddingModelInput.disabled = !isLocalProvider;
      els.testBackendButton.disabled = false;
      syncProviderControls();
      const providers = settings.providers || {};
      const gemma = providers.gemma || {};
      const embeddings = providers.embeddings || {};
      const vectorDb = providers.vectorDb || {};
      const dimensions = providers.dimensions || {};
      const semanticScholar = providers.semanticScholar || {};
      const ollama = providers.ollama || {};
      const bundled = ollama.bundled || {};
      const bundledBoot = bundled.boot || {};
      populateOllamaModels(ollama.models || [], settings.gemmaModel || defaults.chatModel || 'gemma3:4b');
      const gemmaStatus = ollama.online
        ? (gemma.configured ? `Ready (${gemma.model || settings.gemmaModel})` : 'Model missing')
        : 'Ollama offline';
      const embeddingStatus = ollama.online
        ? (embeddings.available ? embeddings.active : 'Embedding missing')
        : 'Ollama offline';
      const vectorStatus = vectorDb.available ? vectorDb.active : 'sklearn cosine fallback';
      const dimensionsStatus = dimensions.configured ? `Configured (${dimensions.preview})` : 'Optional';
      const s2Status = semanticScholar.configured ? `Configured (${semanticScholar.preview})` : 'Active (Free S2AG public graph)';
      if (els.gemmaStatus) els.gemmaStatus.textContent = gemmaStatus;
      if (els.embeddingStatus) els.embeddingStatus.textContent = embeddingStatus;
      if (els.vectorStatus) els.vectorStatus.textContent = vectorStatus;
      if (els.dimensionsStatus) els.dimensionsStatus.textContent = dimensionsStatus;
      const runtimeWarning = settings.runtimeWarning || (!settings.localInferenceEnabled ? 'Local AI runtime not detected. Start Ollama or choose a cloud provider.' : '');
      const warnings = [...new Set([runtimeWarning, ollama.error, gemma.warning, embeddings.warning].filter(Boolean))];
      const localDisabled = (settings.aiProvider || 'local') === 'local' && !settings.localInferenceEnabled;
      state.localInferenceEnabled = !localDisabled;
      els.aiAnalyzeButton.disabled = localDisabled;
      els.aiAnalyzeButton.dataset.localInferenceEnabled = String(!localDisabled);
      if (ollama.online && gemma.configured) {
        els.backendStatus.classList.add('is-ready');
        els.backendStatus.textContent = `Local AI is ready. Imported PDFs will be scanned with ${gemma.model || settings.gemmaModel}.`;
      } else if (ollama.online) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = gemma.warning || `The selected chat model is not installed. Run: ollama pull ${settings.gemmaModel || 'gemma3:4b'}`;
      } else {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = runtimeWarning || 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
      }
      const diagnostics = [
        `Backend: online`,
        `AI provider: ${(settings.aiProvider || 'local') === 'cloud' ? 'Cloud provider' : 'Local (Ollama)'}`,
        `Ollama chat endpoint: ${settings.ollamaChatEndpoint || 'http://127.0.0.1:11434/api/chat'}`,
        `Ollama tags endpoint: ${settings.ollamaTagsEndpoint || 'http://127.0.0.1:11434/api/tags'}`,
        `Ollama embeddings endpoint: ${settings.ollamaEmbeddingsEndpoint || 'http://127.0.0.1:11434/api/embeddings'}`,
        `Bundled Ollama: ${bundled.available ? (bundled.processRunning ? 'running from app bundle' : 'available') : 'not bundled'}`,
        `Bundled runtime status: ${bundledBoot.reason || 'unknown'}`,
        `Ollama model storage: ${bundled.modelsDir || '~/Library/Application Support/pulse/models'}`,
        `PDF extraction: ${settings.workflow?.pdfExtraction || 'byte scan fallback'}`,
        `Section detection: ${settings.workflow?.sectionDetection || 'heading heuristics'}`,
        `Metadata extraction: local parser + local chat model`,
        `Chunking: paragraphs`,
        `Embedding model: ${embeddingStatus}`,
        `Vector database: ${vectorStatus}`,
        `Chat model: ${gemmaStatus}`,
        `Fallback embeddings: ${embeddings.fallback || 'hashed-local-fallback'} only if Ollama embeddings fail`,
        `Semantic Scholar (S2AG): ${s2Status}`,
        `Dimensions recommender: ${dimensionsStatus}`,
        `Literature Discovery: S2AG (SPECTER2) + OpenAlex + Crossref${dimensions.configured ? ' + Dimensions' : ''}`,
        warnings.length ? `Warnings:\n${warnings.map(item => `- ${item}`).join('\n')}` : '',
        `Config: ${settings.configPath || 'local backend'}`
      ].filter(Boolean).join('\n');
      if (els.backendDiagnostics) els.backendDiagnostics.textContent = diagnostics;
    }

    function populateOllamaModels(models, selectedModel) {
      const uniqueModels = [...new Set((models || []).filter(Boolean))];
      els.ollamaModelSelect.innerHTML = uniqueModels.length
        ? uniqueModels.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')
        : '<option value="">Test Connection to load installed models</option>';
      if (uniqueModels.includes(selectedModel)) {
        els.ollamaModelSelect.value = selectedModel;
      } else if (uniqueModels.length) {
        els.ollamaModelSelect.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(selectedModel)}">Selected: ${escapeHtml(selectedModel)} (not installed)</option>`);
        els.ollamaModelSelect.value = selectedModel;
      }
    }


    function initFrankTheme() {
      const saved = localStorage.getItem('pulse-theme') || localStorage.getItem('iratxe-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyFrankTheme(saved);
      els.themeLight?.addEventListener('click', () => applyFrankTheme('light'));
      els.themeDark?.addEventListener('click', () => applyFrankTheme('dark'));
    }

    function applyFrankTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('pulse-theme', theme);
      els.themeLight?.classList.toggle('active', theme === 'light');
      els.themeDark?.classList.toggle('active', theme === 'dark');
    }

    function updateSaveStatePill(status) {
      if (!els.saveStatePill) return;
      els.saveStatePill.textContent = status;
      els.saveStatePill.className = 'save-state-pill ' + status.toLowerCase().replace(/[^a-z]/g, '');
    }

    async function loadBackendSettings() {
      try {
        const response = await fetch(backendUrl('/api/settings'), { headers: apiHeaders() });
        const settings = await response.json();
        if (!response.ok) throw new Error(settings.error || 'Could not read backend settings.');
        if (settings.hasApiKey && els.geminiKeyInput) {
          els.geminiKeyInput.placeholder = settings.apiKeyPreview ? ('Configured (' + settings.apiKeyPreview + ')') : 'Configured';
        }
        if (settings.cloudModel && els.cloudModelInput) {
          els.cloudModelInput.value = settings.cloudModel;
        }
        if (settings.aiProvider && els.aiProviderInput) {
          els.aiProviderInput.value = settings.aiProvider;
        }
        if (settings.cloudProvider && els.cloudProviderInput) {
          els.cloudProviderInput.value = settings.cloudProvider;
        }
        renderBackendStatus(settings);
      } catch (error) {
        renderBackendStatus(null, `${error.message}\n\nBackend URL: ${apiBase || window.location.origin}`);
      }
    }

    async function saveBackendSettings(options = {}) {
      const clearDimensionsApiKey = Boolean(options.clearDimensionsApiKey);
      const clearSemanticScholarApiKey = Boolean(options.clearSemanticScholarApiKey);
      els.saveSettingsButton.disabled = true;
      if (els.clearDimensionsKeyButton) els.clearDimensionsKeyButton.disabled = true;
      if (els.clearSemanticScholarKeyButton) els.clearSemanticScholarKeyButton.disabled = true;
      try {
        const response = await fetch(backendUrl('/api/settings'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            aiProvider: els.aiProviderInput.value,
            cloudProvider: els.cloudProviderInput.value,
            cloudModel: els.cloudModelInput ? els.cloudModelInput.value.trim() : 'gemini-2.5-flash',
            apiKey: els.geminiKeyInput ? els.geminiKeyInput.value.trim() : undefined,
            ollamaChatEndpoint: els.ollamaChatEndpointInput.value.trim() || 'http://127.0.0.1:11434/api/chat',
            dimensionsApiKey: clearDimensionsApiKey ? '' : (els.dimensionsKeyInput ? els.dimensionsKeyInput.value.trim() : ''),
            clearDimensionsApiKey,
            semanticScholarApiKey: clearSemanticScholarApiKey ? '' : (els.semanticScholarKeyInput ? els.semanticScholarKeyInput.value.trim() : ''),
            clearSemanticScholarApiKey,
            gemmaModel: els.gemmaModelInput.value.trim() || 'gemma3:4b',
            embeddingModel: els.embeddingModelInput.value.trim() || 'nomic-embed-text',
            autoGemmaExtraction: els.autoGemmaExtractionInput?.checked !== false
          })
        });
        const settings = await response.json();
        if (!response.ok) throw new Error(settings.error || 'Could not save backend settings.');
        if (els.dimensionsKeyInput) els.dimensionsKeyInput.value = '';
        if (els.semanticScholarKeyInput) els.semanticScholarKeyInput.value = '';
        renderBackendStatus(settings, 'Settings saved.');
        if (clearSemanticScholarApiKey) showToast('Semantic Scholar key cleared.');
        else if (clearDimensionsApiKey) showToast('Dimensions key cleared.');
        else showToast('Backend settings saved.');
      } catch (error) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = error.message;
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = error.message;
      } finally {
        els.saveSettingsButton.disabled = false;
        if (els.clearDimensionsKeyButton) els.clearDimensionsKeyButton.disabled = false;
        if (els.clearSemanticScholarKeyButton) els.clearSemanticScholarKeyButton.disabled = false;
      }
    }

    async function testBackend() {
      els.testBackendButton.disabled = true;
      els.backendStatus.textContent = 'Testing Ollama chat and embeddings...';
      try {
        const response = await fetch(backendUrl('/api/test'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({})
        });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || result.message || 'Connection test failed.');
        populateOllamaModels(result.models || [], result.model);
        await loadBackendSettings();
        showToast(result.message || 'Connection detected.');
      } catch (error) {
        const model = els.gemmaModelInput.value.trim() || 'gemma3:4b';
        const embedModel = els.embeddingModelInput.value.trim() || 'nomic-embed-text';
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = error.message;
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = `${error.message}\n\nIf Ollama is offline, run: ollama serve\nIf the chat model is missing, run: ollama pull ${model}\nIf the embedding model is missing, run: ollama pull ${embedModel}`;
      } finally {
        els.testBackendButton.disabled = false;
      }
    }

    function aiPayload() {
      return {
        prompt: els.aiPrompt.value.trim(),
        threshold: state.threshold,
        mode: state.mode,
        graphStyle: { ...state.graphStyle },
        areas: state.areas.map(area => ({ ...area })),
        papers: state.papers.map(paper => ({
          id: paper.id,
          title: paper.title,
          authors: paper.authors || [],
          date: paper.date || '',
          year: paper.year || '',
          journal: paper.journal || '',
          doi: paper.doi || '',
          openAlexId: paper.openAlexId || '',
          openAlexUrl: paper.openAlexUrl || '',
          referenceIds: paper.referenceIds || [],
          citedByIds: paper.citedByIds || [],
          citedByCount: paper.citedByCount || 0,
          influentialCitationCount: paper.influentialCitationCount,
          abstract: paper.abstract || '',
          text: paper.text.slice(0, 12000),
          keywords: mergedKeywords(paper),
        })),
        links: state.links.slice().sort((a,b)=>b.score-a.score).slice(0,2500).map(link => {
          const source = papersById.get(link.source);
          const target = papersById.get(link.target);
          return {
            source: source?.title || link.source,
            target: target?.title || link.target,
            score: Number(link.score.toFixed(4)),
            type: link.type || 'similarity',
            evidence: link.evidence || ''
          };
        })
      };
    }

    async function analyzeWithGemma() {
      if (!state.papers.length) {
        setAiPanelOpen(true);
        els.aiResult.classList.add('is-muted');
        els.aiResult.textContent = 'Load at least one paper before asking the local chat model to analyze the map.';
        return;
      }
      if (els.aiProviderInput?.value === 'local' && els.aiAnalyzeButton.dataset.localInferenceEnabled === 'false') {
        setAiPanelOpen(true);
        els.aiResult.classList.add('is-muted');
        els.aiResult.textContent = 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
        return;
      }

      setAiPanelOpen(true);
      els.aiAnalyzeButton.disabled = true;
      els.aiResult.classList.add('is-muted');
      els.aiResult.textContent = 'Running the local Ollama chat model over the nearest paper chunks...';

      try {
        const response = await fetch(backendUrl('/api/analyze'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(aiPayload())
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Local chat analysis failed.');
        }

        els.aiResult.classList.remove('is-muted');
        const parsed = parseChatControlResponse(data.analysis || '');
        const applied = applyChatActions(parsed.actions);
        els.aiResult.textContent = [
          parsed.analysis || 'The local chat model returned an empty response.',
          applied.length ? `\n\nApplied to graph:\n${applied.map(item => `- ${item}`).join('\n')}` : ''
        ].filter(Boolean).join('');
      } catch (error) {
        els.aiResult.classList.add('is-muted');
        const model = els.gemmaModelInput.value.trim() || 'gemma3:4b';
        const embedModel = els.embeddingModelInput.value.trim() || 'nomic-embed-text';
        els.aiResult.textContent = `${error.message}\n\nCheck Settings, then run: ollama serve\nIf needed: ollama pull ${model}\nFor embeddings: ollama pull ${embedModel}`;
      } finally {
        els.aiAnalyzeButton.disabled = false;
      }
    }

    function parseChatControlResponse(text) {
      const raw = String(text || '');
      const match = raw.match(/(?:PULSE_ACTIONS_START|IRATXE_ACTIONS_START)\s*([\s\S]*?)\s*(?:PULSE_ACTIONS_END|IRATXE_ACTIONS_END)/i);
      if (!match) return { analysis: raw.trim(), actions: [] };
      let actions = [];
      try {
        const parsed = JSON.parse(match[1].trim());
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      } catch {
        actions = [];
      }
      return {
        analysis: raw.replace(match[0], '').trim(),
        actions
      };
    }

    function setMapMode(mode) {
      if (!['network', 'clusters', 'radial', 'table', 'timeline'].includes(mode)) return false;
      state.workspaceView = mode === 'table' ? 'library' : mode === 'timeline' ? 'timeline' : 'network';
      state.mode = mode;
      state.centerId = null;
      document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('is-active', item.dataset.mode === mode));
      return true;
    }

    function hexColor(value, fallback = '#0d837b') {
      const text = String(value || '').trim();
      return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
    }

    function findAreaByName(name) {
      const key = String(name || '').trim().toLowerCase();
      return state.areas.find(area => area.name.toLowerCase() === key);
    }

    function createNamedArea(action = {}) {
      const index = state.areas.length;
      const area = {
        id: uid(),
        name: cleanField(action.name || `Area ${index + 1}`),
        color: hexColor(action.color, palette[index % palette.length]),
        x: Math.max(40, Math.min(1600, Number(action.x || state.view.x + 110 + index * 34))),
        y: Math.max(40, Math.min(1400, Number(action.y || state.view.y + 110 + index * 28))),
        width: Math.max(120, Math.min(520, Number(action.width || 260))),
        height: Math.max(90, Math.min(380, Number(action.height || 170)))
      };
      state.areas.push(area);
      state.selectedAreaId = area.id;
      return area;
    }

    function applyChatActions(actions = []) {
      const applied = [];
      const safeActions = Array.isArray(actions) ? actions.slice(0, 16) : [];
      for (const action of safeActions) {
        if (!action || typeof action !== 'object') continue;
        const type = String(action.type || '').trim();
        if (type === 'set_threshold') {
          const value = Math.max(0.01, Math.min(0.75, Number(action.value)));
          if (Number.isFinite(value)) {
            state.threshold = value;
            els.threshold.value = Math.round(value * 100);
            applied.push(`set threshold to ${Math.round(value * 100)}%`);
          }
        } else if (type === 'set_mode') {
          if (setMapMode(String(action.mode || ''))) applied.push(`switched to ${state.mode} mode`);
        } else if (type === 'set_graph_style') {
          const updates = {};
          if (Number.isFinite(Number(action.nodeSize))) updates.nodeSize = Math.max(14, Math.min(42, Number(action.nodeSize)));
          if (Number.isFinite(Number(action.edgeScale))) updates.edgeScale = Math.max(0.25, Math.min(1.8, Number(action.edgeScale)));
          if (Number.isFinite(Number(action.spacing))) updates.spacing = Math.max(0.7, Math.min(1.65, Number(action.spacing)));
          if (['short', 'full', 'keywords', 'none'].includes(action.labelMode)) updates.labelMode = action.labelMode;
          if (typeof action.showGrid === 'boolean') updates.showGrid = action.showGrid;
          if (typeof action.showAreas === 'boolean') updates.showAreas = action.showAreas;
          if (Object.keys(updates).length) {
            state.graphStyle = { ...state.graphStyle, ...updates };
            syncGraphControls();
            applied.push('updated graph style');
          }
        } else if (type === 'center_paper') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            state.centerId = paper.id;
            applied.push(`centered ${compactTitle(paper.title)}`);
          }
        } else if (type === 'color_paper') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            paper.color = hexColor(action.color, paper.color || '#0d837b');
            applied.push(`colored ${compactTitle(paper.title)}`);
          }
        } else if (type === 'create_area') {
          const area = createNamedArea(action);
          applied.push(`created area ${area.name}`);
        } else if (type === 'rename_area') {
          const area = findAreaByName(action.from);
          const nextName = cleanField(action.to || '');
          if (area && nextName) {
            area.name = nextName;
            applied.push(`renamed area to ${area.name}`);
          }
        } else if (type === 'assign_area') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            let area = findAreaByName(action.areaName);
            if (!area) area = createNamedArea({ name: action.areaName || 'Chat area', color: action.color });
            paper.areaId = area.id;
            if (action.color) paper.color = hexColor(action.color, paper.color || area.color);
            applied.push(`assigned ${compactTitle(paper.title)} to ${area.name}`);
          }
        } else if (type === 'open_panel') {
          const panel = String(action.panel || '');
          if (panel === 'graph') setGraphPanelOpen(true);
          if (panel === 'areas') setAreaPanelOpen(true);
          if (panel === 'links') setLinkagePanelOpen(true);
          if (panel === 'settings') setSettingsOpen(true);
          if (['graph', 'areas', 'links', 'settings'].includes(panel)) applied.push(`opened ${panel} panel`);
        }
      }
      if (applied.length) {
        render();
        scheduleAutosave();
        showToast(`Chat applied ${applied.length} graph change${applied.length === 1 ? '' : 's'}.`);
      }
      return applied;
    }

    function normalizeTitle(name, text) {
      const cleanName = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const titleLine = lines.find(line => line.length > 18 && line.length < 160 && !/[{}@]/.test(line));
      return titleLine || cleanName || 'Untitled paper';
    }

    function extractTitle(raw, cleanedText, fileName) {
      const title = fieldMatch(raw, ['title', 'TI', 'T1'], 1200)
        || fieldMatch(cleanedText, ['title'], 400);
      if (title) return cleanField(title).replace(/\.$/, '');
      return normalizeTitle(fileName, cleanedText);
    }

    function firstMatch(text, patterns) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim();
      }
      return '';
    }

    function cleanField(value) {
      return stripMarkup(value || '')
        .replace(/\r/g, '\n')
        .replace(/-\n(?=[a-z])/g, '')
        .replace(/\n(?=[a-z])/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[{["']+|[}\]"']+$/g, '')
        .trim();
    }

    function stripMarkup(value) {
      const text = String(value || '');
      const abstractMatch = text.match(/<jats:sec[^>]*>\s*<jats:title>\s*Abstract\s*<\/jats:title>([\s\S]*?)(?=<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*<\/jats:title>|<\/jats:sec>\s*$)/i);
      const scoped = abstractMatch ? abstractMatch[1] : text;
      const withoutKeyPoints = scoped.replace(/<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*<\/jats:title>[\s\S]*?<\/jats:sec>/gi, ' ');
      const textarea = document.createElement('textarea');
      textarea.innerHTML = withoutKeyPoints
        .replace(/<\/?(?:jats:)?title[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      return textarea.value.replace(/\u00a0/g, ' ').replace(/\s+([,.;:])/g, '$1');
    }

    function splitKeywords(value) {
      return cleanField(value)
        .replace(/\bkeywords?\b\s*[:.\-]*/i, '')
        .split(/\s*(?:;|,|\||\n|•|·)\s*/)
        .map(item => item.trim())
        .filter(item => item.length > 1 && item.length < 80 && !/^(keywords?|index terms?)$/i.test(item))
        .slice(0, 24);
    }

    function cleanAuthorName(str) {
      if (!str) return '';
      let s = String(str)
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\s*\[[^\]]*\]/g, '')
        .trim();
      s = s.replace(/^[\s\d*†‡§#.,;:"'([\]{}<>/\\-]+/, '').trim();
      s = s.replace(/[\s*†‡§#,:;"'([\]{}<>/\\-]+$/, '').trim();
      if (/[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]{2,}\.$/.test(s)) {
        s = s.slice(0, -1).trim();
      }
      return s;
    }

    function extractLastName(raw) {
      const cleaned = cleanAuthorName(raw);
      if (!cleaned) return '';
      if (cleaned.includes(',')) {
        const beforeComma = cleanAuthorName(cleaned.split(',')[0]);
        if (beforeComma && !/^(?:dr|prof|mr|ms|mrs)\.?$/i.test(beforeComma)) {
          return beforeComma;
        }
      }
      const tokens = cleaned.split(/\s+/).filter(Boolean);
      if (!tokens.length) return '';
      const len = tokens.length;
      if (len >= 3 && /^(?:van\s+der|von\s+der)$/i.test(tokens[len - 3] + ' ' + tokens[len - 2])) {
        return cleanAuthorName(tokens.slice(len - 3).join(' '));
      }
      if (len >= 2 && /^(?:van|von|de|del|da|der|ten|di|le|la|du)$/i.test(tokens[len - 2])) {
        return cleanAuthorName(tokens.slice(len - 2).join(' '));
      }
      return cleanAuthorName(tokens[len - 1].replace(/[0-9*†‡§#]+/g, ''));
    }

    function paperAuthors(paper) {
      if (!paper) return [];
      let list = [];
      if (Array.isArray(paper.authors) && paper.authors.length > 0) {
        list = paper.authors;
      } else if (typeof paper.author === 'string' && paper.author.trim()) {
        list = splitAuthors(paper.author);
      } else if (Array.isArray(paper.author) && paper.author.length > 0) {
        list = paper.author;
      } else if (typeof paper.authors === 'string' && paper.authors.trim()) {
        list = splitAuthors(paper.authors);
      }
      const seen = new Set();
      const cleaned = [];
      for (const item of list) {
        const c = cleanAuthorName(item);
        if (c.length > 1 && c.length < 120 && !/^(?:authors?|editors?|by|unknown|none)$/i.test(c)) {
          const key = c.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            cleaned.push(c);
          }
        }
      }
      return cleaned;
    }

    function splitAuthors(value) {
      const text = cleanField(value)
        .replace(/\b(?:edited|published|reviewed|translated)\s+by\s*[:.\-]?\s*/gi, '')
        .trim();
      if (!text) return [];

      let rawList = [];
      if (/[;\n|]/.test(text)) {
        rawList = text.split(/\s*(?:;|\n|\|)\s*/);
      } else if (/\s+\band\b\s+/i.test(text)) {
        const withSemi = text.replace(/\s+\band\b\s+/gi, '; ');
        rawList = withSemi.split(/\s*(?:;|,)\s*/);
      } else if (text.includes(',')) {
        const parts = text.split(/\s*,\s*/);
        if (parts.length === 2 && !/\s+/.test(parts[0]) && /^[A-Z\u00C0-\u024F\u1E00-\u1EFF]/.test(parts[0])) {
          rawList = [text];
        } else {
          rawList = parts;
        }
      } else {
        rawList = [text];
      }

      return rawList
        .map(cleanAuthorName)
        .filter(author => author.length > 1 && author.length < 120 && !/^(?:authors?|editors?|by)$/i.test(author))
        .slice(0, 24);
    }

    function fieldMatch(raw, labels, limit = 1600) {
      const labelGroup = labels.join('|');
      return firstMatch(raw, [
        new RegExp(`\\b(?:${labelGroup})\\s*=\\s*[{"]([\\s\\S]{1,${limit}}?)[}"],?\\s*(?:\\n\\s*\\w+\\s*=|$)`, 'i'),
        new RegExp(`^\\s*(?:${labelGroup})\\s*-\\s*([\\s\\S]{1,${limit}}?)(?=\\n\\s*(?:[A-Z][A-Z0-9]\\s*-|ER\\s*-)|$)`, 'im'),
        new RegExp(`\\b(?:${labelGroup})\\b\\s*[:.\\-]\\s*([^\\n]{1,${Math.min(limit, 900)}})`, 'i')
      ]);
    }

    function looksLikePersonName(token) {
      const cleaned = cleanAuthorName(token);
      if (!cleaned || cleaned.length < 2 || cleaned.length > 60) return false;
      if (/[:/=?#@$%&]/.test(cleaned)) return false;
      const words = cleaned.split(/\s+/);
      if (words.length > 4) return false;
      const nonNames = /\b(?:factors|role|sensing|adapting|competing|mechanisms|analysis|journal|review|study|effect|evidence|university|department|faculty|hospital|institute|school|laboratory|press|springer|elsevier|wiley|nature|frontiers|plos)\b/i;
      if (nonNames.test(cleaned)) return false;
      return words.every(w => /^[A-Z\u00C0-\u024F\u1E00-\u1EFF]/.test(w) || /^(?:van|von|de|del|da|der|ten|di|le|la|du)$/i.test(w));
    }

    function extractAuthors(raw, cleanedText) {
      const authorField = fieldMatch(raw, ['author', 'authors', 'AU', 'A1', 'FAU', 'creator', 'creators', 'byline'], 2400)
        || fieldMatch(cleanedText, ['author', 'authors', 'byline'], 900);
      if (authorField) return splitAuthors(authorField);

      const lines = cleanedText.split(/\n+/).map(line => cleanField(line)).filter(Boolean);
      const titleIndex = lines.findIndex(line => line.length > 18 && line.length < 180);
      const windowStart = Math.max(0, titleIndex + 1);
      const candidates = lines.slice(windowStart, windowStart + 6);

      let bestCandidate = null;
      let bestScore = 0;
      for (const line of candidates) {
        if (!/(?:,| and |;|&)/i.test(line) || line.length > 280) continue;
        if (/^(?:edited by|published by|reviewed by|translated by|abstract|keywords?|introduction|faculty|department)\b/i.test(line)) continue;
        const parts = line.replace(/\s+\band\b\s+/gi, ', ').split(/\s*,\s*/).map(cleanAuthorName).filter(Boolean);
        if (parts.length < 2) continue;
        const validNames = parts.filter(looksLikePersonName).length;
        const ratio = validNames / parts.length;
        if (ratio >= 0.7 && validNames > bestScore) {
          bestScore = validNames;
          bestCandidate = line;
        }
      }
      return bestCandidate ? splitAuthors(bestCandidate) : [];
    }

    function extractDate(raw, cleanedText) {
      const dateField = fieldMatch(raw, ['date', 'year', 'PY', 'Y1', 'DA', 'publication date', 'published', 'issued'], 300)
        || fieldMatch(cleanedText, ['date', 'year', 'publication date', 'published'], 300);
      const source = dateField || raw;
      const iso = source.match(/\b(19|20)\d{2}[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
      if (iso) return iso[0].replace(/\//g, '-');
      const monthDate = source.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(19|20)\d{2}\b/i);
      if (monthDate) return cleanField(monthDate[0]);
      const year = source.match(/\b(19|20)\d{2}\b/);
      return year ? year[0] : '';
    }

    function extractJournal(raw, cleanedText) {
      const journal = fieldMatch(raw, ['journal', 'journaltitle', 'booktitle', 'JF', 'JO', 'T2', 'source', 'publication', 'container-title'], 900)
        || fieldMatch(cleanedText, ['journal', 'source', 'publication', 'published in'], 500);
      return cleanField(journal).replace(/\.$/, '');
    }

    function extractDoi(raw, cleanedText) {
      const doiField = fieldMatch(raw, ['doi', 'DO'], 400);
      const source = doiField || raw || cleanedText;
      return findBestDoi(source);
    }

    // DOI parsing mirrors pulse_backend.py (prepare_doi_text / doi_matches).
    // No regex lookbehind: older macOS WebKit cannot parse it.
    const DOI_PREFIX = '10\\.\\d{4,9}(?:\\.\\d+)*';
    const DOI_CHARS = '[-._;()/:A-Za-z0-9<>+]';
    const DOI_NEW_ITEM_GUARD = '(?![Dd][Oo][Ii]\\b|[Hh][Tt][Tt][Pp][Ss]?:|[Ww][Ww][Ww]\\.|\\S*?10\\.\\d{4,9}/)';
    const DOI_NON_PAPER_PREFIXES = ['10.13039/'];
    const DOI_GLUED_TAIL = /([0-9a-z)])(?:Received|Accepted|Published|Available|Copyright|Citation|Cite|Keywords|Abstract|Downloaded|Supplementary|Correspondence|Article|ORCID|PMID|PMCID|ISSN|Email|E-mail|https?:|www\.)[\s\S]*$/;
    const DOI_URL_SUFFIX = /(?:\/(?:full|abstract|pdf|epdf|pdfdirect|fulltext|summary|references|meta|html)|\.(?:full|abstract|supplementary)(?:\.pdf(?:\+html)?|\.html)?|\.pdf)+$/i;
    const DOI_MARKER = /(?:\bdoi\b|doi\.org\/|prism:doi|dc:identifier|identifier)[\s:=>"'(/]*(?:(?:abs|full|pdf|epdf|pdfdirect)\/)?$/i;
    const DOI_REFERENCES = /\n[ \t]*(?:\d+\.?[ \t]*)?(?:References(?: and Notes)?|REFERENCES|Bibliography|BIBLIOGRAPHY|Literature Cited|LITERATURE CITED|Works Cited|Reference List)[ \t:]*\n/g;

    function prepareDoiText(value) {
      let text = String(value || '')
        .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
        .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
        .replace(/\uff0f/g, '/')
        .replace(/\\\//g, '/');
      if (text.includes('&')) {
        text = text
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
          .replace(/&#x2f;|&#47;/gi, '/').replace(/&amp;/gi, '&');
      }
      text = text.replace(/(^|\s)([^\s%]*%(?:2F|3C|3E|28|29|3A|3B)\S*)/gi, (all, lead, token) => {
        try { return lead + decodeURIComponent(token); } catch { return lead + token.replace(/%2F/gi, '/'); }
      });
      // Letter-spaced extraction ("1 0 . 1 0 3 8 / n a t u r e") from tracked fonts.
      text = text.replace(/(^|\s)((?:\S{1,2} ){5,}\S{1,2})(?=\s|$)/g, (all, lead, run) => {
        const joined = run.replace(/ /g, '');
        return lead + (/10\.\d{4}/.test(joined) ? joined : run);
      });
      return text.replace(new RegExp(`(${DOI_PREFIX})[ \\t]*/[ \\t]*`, 'g'), '$1/');
    }

    function joinWrappedDois(text) {
      const always = text.replace(
        new RegExp(`(${DOI_PREFIX}/(?:${DOI_CHARS}*[-/])?)[ \\t]*\\r?\\n[ \\t]*${DOI_NEW_ITEM_GUARD}(?=[A-Za-z0-9(])`, 'g'),
        '$1'
      );
      return always.replace(
        new RegExp(`(${DOI_PREFIX}/${DOI_CHARS}*[._])[ \\t]*\\r?\\n[ \\t]*(?!\\d{1,3}[.)][ \\t])${DOI_NEW_ITEM_GUARD}(?=[a-z0-9])`, 'g'),
        '$1'
      );
    }

    function balanceDoiBrackets(doi) {
      let depth = 0;
      let openAt = -1;
      for (let index = 0; index < doi.length; index++) {
        const char = doi[index];
        if (char === '<') {
          if (depth === 0) openAt = index;
          depth++;
        } else if (char === '>') {
          if (depth === 0) return doi.slice(0, index);
          depth--;
        }
      }
      return depth ? doi.slice(0, openAt) : doi;
    }

    function cleanDoiCandidate(value) {
      let clean = prepareDoiText(value).trim()
        .replace(/^\s*(?:https?:\/\/)?(?:www\.|dx\.)?doi\.org\//i, '')
        .replace(/^\s*doi\s*[:=]?\s*/i, '')
        .replace(/\s+/g, '')
        .replace(/^["'{}[\]]+|["'{}[\]]+$/g, '');
      clean = clean.split(/<(?=[/!?A-Za-z])/)[0];
      clean = clean.split(/\)?(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)\b/)[0];
      // PDF link annotations: "/URI (https://doi.org/10.x/y)/S/URI".
      clean = clean.split(/\)\/(?:S|URI|Type|Subtype|Rect|Border|BS|A|F|H|C|D|Dest|Next|NM|M|P|StructParent)\b/)[0];
      clean = clean.split(/(?:>>|<<|endobj|\bobj\b|\bstream\b)/i)[0];
      clean = balanceDoiBrackets(clean).replace(DOI_GLUED_TAIL, '$1');
      const count = (text, char) => text.split(char).length - 1;
      for (let pass = 0; pass < 3; pass++) {
        const before = clean;
        clean = clean.replace(/[.,;:'"]+$/, '');
        while (clean.endsWith(')') && count(clean, '(') < count(clean, ')')) {
          clean = clean.slice(0, -1).replace(/[.,;:]+$/, '');
        }
        clean = clean.replace(DOI_URL_SUFFIX, '')
          .replace(/^(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,})v\d+$/, '$1');
        if (clean === before) break;
      }
      return clean;
    }

    function validDoiCandidate(doi) {
      if (!doi || !/^10\.\d{4,9}(?:\.\d+)*\//i.test(doi)) return false;
      if (DOI_NON_PAPER_PREFIXES.some(prefix => doi.toLowerCase().startsWith(prefix))) return false;
      const suffix = doi.split('/').slice(1).join('/');
      if (suffix.length < 2 || doi.length > 200) return false;
      if (/[^\x20-\x7E]/.test(doi) || /[\\{}[\]|^`\s]/.test(doi)) return false;
      if (balanceDoiBrackets(doi) !== doi) return false;
      if (/^10\.\d+\/(?:obj|stream|length|filter|type|height|width|xobject|smask|bitspercomponent)\b/i.test(doi)) return false;
      if (/(?:\/Length|\/Filter|\/FlateDecode|\/Type|\/XObject|\/Width|\/Height|>>|<<|stream)/i.test(doi)) return false;
      return true;
    }

    // Every cleaned DOI as { doi, position, text, sourceIndex } in document order.
    function doiMatches(...values) {
      const found = [];
      const seen = new Set();
      for (const value of values) {
        const prepared = prepareDoiText(value);
        const joined = joinWrappedDois(prepared);
        const texts = joined === prepared ? [joined] : [joined, prepared];
        texts.forEach((text, sourceIndex) => {
          const pattern = new RegExp(`(^|[^0-9.])(${DOI_PREFIX}/${DOI_CHARS}+)`, 'g');
          for (const match of text.matchAll(pattern)) {
            const doi = cleanDoiCandidate(match[2]);
            const key = doi.toLowerCase();
            if (seen.has(key) || !validDoiCandidate(doi)) continue;
            if (sourceIndex && found.some(other => other.doi.toLowerCase().startsWith(key))) continue;
            seen.add(key);
            found.push({ doi, position: match.index + match[1].length, text, sourceIndex });
          }
        });
      }
      return found;
    }

    function normalizeDoi(value) {
      return doiMatches(value)[0]?.doi || '';
    }

    function sameDoi(left, right) {
      const a = normalizeDoi(left);
      return Boolean(a) && a.toLowerCase() === normalizeDoi(right).toLowerCase();
    }

    function findDoiCandidates(...values) {
      return doiMatches(...values).map(item => item.doi);
    }

    function findBestDoi(...values) {
      const refsByText = new Map();
      const ranked = doiMatches(...values).map(item => {
        if (!refsByText.has(item.text)) refsByText.set(item.text, [...item.text.matchAll(DOI_REFERENCES)].map(match => match.index));
        const refs = refsByText.get(item.text);
        let score = 0;
        if (DOI_MARKER.test(item.text.slice(Math.max(0, item.position - 40), item.position))) score += 4;
        if (refs.length && item.position > refs[refs.length - 1]) score -= 5;
        if (item.position < 4000) score += 1;
        if (item.sourceIndex) score -= 1;
        return { ...item, score };
      });
      ranked.sort((a, b) => (b.score - a.score) || (a.sourceIndex - b.sourceIndex) || (a.position - b.position));
      return ranked[0]?.doi || '';
    }

    function controlFindDoi(raw, cleanedText, buffer) {
      const candidates = [raw, cleanedText];
      if (buffer) {
        const bytes = new Uint8Array(buffer);
        const ascii = [];
        let current = '';
        for (const byte of bytes.subarray(0, Math.min(bytes.length, 8000000))) {
          if (byte >= 32 && byte <= 126) {
            current += String.fromCharCode(byte);
          } else if (current.length) {
            if (current.length >= 8) ascii.push(current);
            current = '';
          }
        }
        if (current.length >= 8) ascii.push(current);
        candidates.push(ascii.join('\n\n'));
      }
      return findBestDoi(...candidates);
    }

    function extractMetadata(raw, cleanedText) {
      const date = extractDate(raw, cleanedText);
      return {
        authors: extractAuthors(raw, cleanedText),
        date,
        year: (date.match(/\b(19|20)\d{2}\b/) || [''])[0],
        journal: extractJournal(raw, cleanedText),
        doi: extractDoi(raw, cleanedText)
      };
    }

    function extractAbstract(raw, cleanedText) {
      if (looksBinary(cleanedText)) return '';
      const labelled = firstMatch(raw, [
        /abstract\s*=\s*[{"]([\s\S]{80,5000}?)[}"],?\s*(?:\n\s*\w+\s*=|$)/i,
        /^\s*(?:AB|N2)\s*-\s*([\s\S]{80,5000}?)(?=\n\s*(?:[A-Z][A-Z0-9]\s*-|ER\s*-)|$)/im,
        /\babstract\b\s*[:.\-]?\s*([\s\S]{80,5000}?)(?=\n\s*(?:keywords?|key words|index terms|introduction|background|1\.?\s+introduction|i\.?\s+introduction|references)\b|$)/i,
        /^\s*summary\s*[:.\-]?\s*([\s\S]{80,3500}?)(?=\n\s*(?:keywords?|introduction|references)\b|$)/im
      ]);
      if (labelled) {
        const clean = cleanAbstract(labelled);
        return looksBinary(clean) ? '' : clean;
      }

      const paragraphs = cleanedText
        .split(/\n\s*\n|(?<=\.)\s{3,}/)
        .map(cleanAbstract)
        .filter(paragraph => paragraph.length > 120 && paragraph.length < 2200)
        .filter(paragraph => !/^(references|bibliography|acknowledg(e)?ments)\b/i.test(paragraph));
      const abstract = paragraphs.find(paragraph => abstractishScore(paragraph) >= 2) || paragraphs[0] || '';
      return looksBinary(abstract) ? '' : abstract;
    }

    function extractPaperKeywords(raw, cleanedText) {
      const labelled = firstMatch(raw, [
        /keywords?\s*=\s*[{"]([\s\S]{3,1000}?)[}"],?\s*(?:\n\s*\w+\s*=|$)/i,
        /^\s*(?:KW|DE)\s*-\s*([\s\S]{3,1000}?)(?=\n\s*(?:[A-Z][A-Z0-9]\s*-|ER\s*-)|$)/im,
        /\b(?:keywords?|key words|index terms)\b\s*[:.\-]\s*([\s\S]{3,1000}?)(?=\n\s*(?:abstract|introduction|background|1\.?\s+introduction|references)\b|$)/i
      ]);
      if (labelled) return splitKeywords(labelled);

      const candidate = cleanedText.match(/\b(?:keywords?|key words|index terms)\b\s*[:.\-]\s*([^\n]{3,500})/i);
      return candidate ? splitKeywords(candidate[1]) : [];
    }

    function cleanAbstract(value) {
      return cleanField(value)
        .replace(/^abstract\s*[:.\-]?\s*/i, '')
        .replace(/^summary\s*[:.\-]?\s*/i, '')
        .replace(/\b(?:keywords?|key words|index terms)\b\s*[:.\-][\s\S]*$/i, '')
        .replace(/\b(?:introduction|references)\b\s*$/i, '')
        .trim();
    }

    function abstractishScore(paragraph) {
      const signals = [
        /\b(this paper|this study|we propose|we present|we examine|we investigate|we evaluate)\b/i,
        /\b(method|methods|approach|model|framework|experiment|analysis|dataset|data)\b/i,
        /\b(result|results|finding|findings|show|shows|demonstrate|conclude)\b/i,
        /\b(research|study|paper|article|literature)\b/i
      ];
      return signals.reduce((score, pattern) => score + (pattern.test(paragraph) ? 1 : 0), 0);
    }

    function looksBinary(value) {
      const text = String(value || '');
      if (!text.trim()) return false;
      const sample = text.slice(0, 1200);
      const replacementCount = (sample.match(/\uFFFD|�/g) || []).length;
      const pdfObjectCount = (sample.match(/\/(?:Length|Filter|FlateDecode|XObject|SMask|Width|Height|BitsPerComponent|stream|endstream)\b/g) || []).length;
      const controlCount = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      const readable = (sample.match(/[A-Za-z]{3,}/g) || []).join('').length;
      return replacementCount > 5 || pdfObjectCount > 3 || controlCount > 8 || readable / Math.max(sample.length, 1) < 0.18;
    }

    function isPdfOrBinary(file, decodedText) {
      const name = (file.name || '').toLowerCase();
      return name.endsWith('.pdf') || decodedText.startsWith('%PDF') || looksBinary(decodedText);
    }

    function paperIdentityKey(paper) {
      const doi = normalizeDoi(paper.doi || '');
      if (doi) return `doi:${doi.toLowerCase()}`;
      const title = cleanField(paper.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return title ? `title:${title}` : '';
    }

    function mergePaperIntoExisting(existing, incoming) {
      mergeDoiMetadata(existing, incoming);
      if (!existing.name && incoming.name) existing.name = incoming.name;
      if (!existing.size && incoming.size) existing.size = incoming.size;
      if (!existing.text && incoming.text) existing.text = incoming.text;
      if (incoming.text && incoming.text.length > (existing.text || '').length && !looksBinary(incoming.text)) {
        existing.text = incoming.text;
      }
      if (incoming.metadataSource) existing.metadataSource = incoming.metadataSource;
      if (incoming.metadataNote) existing.metadataNote = incoming.metadataNote;
    }

    function addParsedPapers(papers) {
      let added = 0;
      let merged = 0;
      const idMap = new Map();
      for (const paper of papers) {
        const key = paperIdentityKey(paper);
        const existing = key ? state.papers.find(item => paperIdentityKey(item) === key) : null;
        if (existing) {
          idMap.set(paper.id, existing.id);
          mergePaperIntoExisting(existing, paper);
          merged += 1;
        } else {
          idMap.set(paper.id, paper.id);
          state.papers.push(paper);
          added += 1;
        }
      }
      (state.pendingImportLinks || []).forEach(link => state.explicitLinks.push({
        ...link, source: idMap.get(link.source) || link.source, target: idMap.get(link.target) || link.target
      }));
      state.pendingImportLinks = [];
      return { added, merged };
    }

    function mergedKeywords(paper) {
      return [...new Set([...(paper.paperKeywords || []), ...(paper.gemmaKeywords || []), ...(state.keywords.get(paper.id) || [])])].slice(0, 16);
    }

    function extractCitationText(raw) {
      return raw
        .replace(/\u0000/g, ' ')
        .replace(/%PDF-[\s\S]{0,240}/, ' ')
        .replace(/@\w+\s*{[^,]+,/g, ' ')
        .replace(/^\s*(TI|T1|AB|N2|KW|AU|PY|DE)\s*-\s*/gm, ' ')
        .replace(/[{}\\]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    async function scanFileMetadata(file, buffer) {
      try {
        const response = await fetch(backendUrl('/api/metadata/scan'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            name: file.name,
            contentBase64: arrayBufferToBase64(buffer)
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Python DOI scan failed.');
        return result;
      } catch (error) {
        return { ok: false, found: false, metadata: {}, error: error.message };
      }
    }

    async function extractWithGemmaLayer(paper, options = {}) {
      if (!state.localInferenceEnabled && els.aiProviderInput?.value === 'local') {
        paper.metadataNote = paper.metadataNote || 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
        return null;
      }
      const excerpt = [
        options.usableText || '',
        paper.abstract || '',
        paper.text || ''
      ].filter(Boolean).join('\n\n').slice(0, 18000);
      if (!excerpt && !(options.doiCandidates || []).length) return null;
      try {
        const response = await fetch(backendUrl('/api/metadata/gemma'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            name: paper.name || '',
            title: paper.title || '',
            abstract: paper.abstract || '',
            keywords: paper.paperKeywords || [],
            doiCandidates: options.doiCandidates || [],
            text: excerpt
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Gemma extraction failed.');
        if (result.metadata && Object.keys(result.metadata).length) {
          mergeDoiMetadata(paper, result.metadata);
          paper.gemmaKeywords = result.metadata.paperKeywords || paper.gemmaKeywords || [];
          paper.metadataSource = result.source || 'Local chat abstraction';
          paper.metadataNote = '';
        }
        if ((result.keyFindings || []).length) paper.keyFindings = result.keyFindings.slice(0, 5);
        if ((result.organisms || []).length) paper.organisms = dedupeList([...(paper.organisms || []), ...result.organisms]).slice(0, 16);
        if ((result.techniques || []).length) paper.techniques = dedupeList([...(paper.techniques || []), ...result.techniques]).slice(0, 16);
        if ((result.discoveryTerms || []).length) paper.discoveryTerms = dedupeList([...(paper.discoveryTerms || []), ...result.discoveryTerms]).slice(0, 24);
        return result;
      } catch (error) {
        paper.metadataNote = paper.metadataNote || `Local chat extraction unavailable: ${error.message}`;
        return null;
      }
    }

    async function readFile(file) {
      const buffer = await file.arrayBuffer();
      const scanned = await scanFileMetadata(file, buffer);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      const browserTextIsUnsafe = isPdfOrBinary(file, text);
      const backendText = scanned?.text && !looksBinary(scanned.text) ? scanned.text : '';
      const safeRaw = backendText || (browserTextIsUnsafe ? '' : text);
      const usableText = backendText ? extractCitationText(backendText) : (browserTextIsUnsafe ? '' : extractCitationText(text));
      const abstract = usableText ? extractAbstract(safeRaw, usableText) : '';
      const paperKeywords = usableText ? extractPaperKeywords(safeRaw, usableText) : [];
      const metadata = usableText ? extractMetadata(safeRaw, usableText) : { authors: [], date: '', year: '', journal: '', doi: '' };
      const foundDoi = controlFindDoi(text, usableText, buffer);
      const doiCandidates = uniqueDoiCandidates([
        scanned?.doi,
        metadata.doi,
        foundDoi,
        ...(scanned?.candidates || [])
      ]);
      if (scanned?.doi) metadata.doi = scanned.doi;
      else if (foundDoi) metadata.doi = foundDoi;
      const paper = {
        id: uid(),
        name: file.name,
        title: usableText ? extractTitle(safeRaw, usableText, file.name) : normalizeTitle(file.name, ''),
        abstract,
        paperKeywords,
        ...metadata,
        text: usableText.slice(0, 120000),
        size: file.size,
        x: 0,
        y: 0
      };
      if (scanned?.metadata && Object.keys(scanned.metadata).length) {
        mergeDoiMetadata(paper, scanned.metadata);
        paper.metadataSource = `${scanned.source || 'DOI'} via Python scan`;
      }
      const backendHandledGemma = Object.prototype.hasOwnProperty.call(scanned || {}, 'gemmaProcessed');
      const gemmaResult = backendHandledGemma
        ? (scanned.gemma || null)
        : await extractWithGemmaLayer(paper, { usableText, doiCandidates });
      const gemmaCandidates = uniqueDoiCandidates([gemmaResult?.doi, ...(gemmaResult?.candidates || [])]);
      await fillMetadataFromDoiLoop(paper, doiCandidates);
      await fillMetadataFromDoiLoop(paper, gemmaCandidates);
      if (!metadataLooksFilled(paper) && scanned?.error) {
        paper.metadataNote = `Python DOI scan unavailable: ${scanned.error}`;
      } else if (backendText) {
        paper.metadataNote = `Text extracted locally with ${scanned.extractionSource || 'the backend workflow'}; local chat terms feed discovery.`;
      } else if (browserTextIsUnsafe) {
        paper.metadataNote = 'PDF text looked binary and no local PDF extractor was available. Add PyMuPDF or pdfplumber for full-text extraction.';
      }
      return paper;
    }

    async function readImportFile(file) {
      const lowerName = (file.name || '').toLowerCase();
      if (lowerName.endsWith('.pdf')) return [await readFile(file)];
      const text = await file.text();
      if (lowerName.endsWith('.json')) {
        const imported = parsePulseJson(text);
        if (imported) return imported;
      }
      if (lowerName.endsWith('.xml') || /<\?xml|<xml|<record[\s>]|<records[\s>]/i.test(text.slice(0, 2000))) {
        const papers = parseEndnoteXml(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.bib') || /@\w+\s*{/.test(text)) {
        const papers = parseBibtexRecords(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.ris') || lowerName.endsWith('.enw') || /^\s*TY\s*-/im.test(text)) {
        const papers = parseRisRecords(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.csv')) {
        const papers = parseCsvRecords(text, file.name);
        if (papers.length) return papers;
      }
      return [await readFile(file)];
    }

    function parsePulseJson(text) {
      try {
        const data = JSON.parse(text);
        const papers = Array.isArray(data.papers) ? data.papers : (Array.isArray(data) ? data : []);
        if (!papers.length) return null;
        state.pendingImportLinks = [...(state.pendingImportLinks || []), ...(data.explicitLinks || data.links || [])];
        if (typeof data.threshold === 'number') {
          state.threshold = Math.min(0.75, Math.max(0.01, data.threshold));
          els.threshold.value = Math.round(state.threshold * 100);
        }
        if (data.view && typeof data.view.x === 'number' && typeof data.view.y === 'number') {
          state.view.x = data.view.x;
          state.view.y = data.view.y;
        }
        if (Array.isArray(data.areas)) {
          state.areas = data.areas.map((area, index) => ({
            id: area.id || uid(),
            name: cleanField(area.name || `Area ${index + 1}`),
            color: area.color || palette[index % palette.length],
            x: Number(area.x || 80 + index * 28),
            y: Number(area.y || 80 + index * 22),
            width: Number(area.width || 260),
            height: Number(area.height || 170)
          }));
        }
        return papers.map(paper => normalizeImportedPaper({
          ...paper,
          paperKeywords: paper.paperKeywords || paper.keywords || [],
          text: paper.text || paper.fullText || paper.abstract || ''
        }, 'Imported JSON map'));
      } catch {
        return null;
      }
    }
    const parseIratxeJson = parsePulseJson;

    function parseEndnoteXml(text, name) {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return [];
      return [...doc.querySelectorAll('record')].map((record, index) => {
        const authors = [...record.querySelectorAll('contributors authors author, authors author, author')]
          .map(node => cleanField(node.textContent))
          .filter(Boolean);
        const keywords = [...record.querySelectorAll('keywords keyword, keyword')]
          .map(node => cleanField(node.textContent))
          .filter(Boolean);
        const year = textFrom(record, 'dates year, year');
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: textFrom(record, 'titles title, title') || `Untitled EndNote record ${index + 1}`,
          authors,
          date: textFrom(record, 'dates date, pub-dates date, date') || year,
          year,
          journal: textFrom(record, 'periodical full-title, periodical abbrev-1, secondary-title, journal'),
          doi: normalizeDoi(textFrom(record, 'electronic-resource-num, doi')),
          abstract: textFrom(record, 'abstract, notes style'),
          paperKeywords: keywords,
          text: cleanField(record.textContent)
        }, 'EndNote XML');
      }).filter(paper => paper.title && !/^Untitled EndNote record/i.test(paper.title) || paper.doi);
    }

    function textFrom(root, selectors) {
      for (const selector of selectors.split(',')) {
        const node = root.querySelector(selector.trim());
        if (node?.textContent) return cleanField(node.textContent);
      }
      return '';
    }

    function parseBibtexRecords(text, name) {
      const records = text.split(/(?=@\w+\s*{)/g).filter(record => /^@\w+\s*{/.test(record.trim()));
      return records.map((record, index) => {
        const metadata = extractMetadata(record, extractCitationText(record));
        const abstract = extractAbstract(record, extractCitationText(record));
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: extractTitle(record, extractCitationText(record), `${name} record ${index + 1}`),
          abstract,
          paperKeywords: extractPaperKeywords(record, record),
          ...metadata,
          text: extractCitationText(record)
        }, 'BibTeX');
      });
    }

    function parseRisRecords(text, name) {
      const records = text.split(/(?=^\s*TY\s*-)/gim).filter(record => /^\s*TY\s*-/im.test(record));
      return records.map((record, index) => {
        const cleaned = extractCitationText(record);
        const metadata = extractMetadata(record, cleaned);
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: extractTitle(record, cleaned, `${name} record ${index + 1}`),
          abstract: extractAbstract(record, cleaned),
          paperKeywords: extractPaperKeywords(record, cleaned),
          ...metadata,
          text: cleaned
        }, 'RIS/EndNote');
      });
    }

    function parseCsvRecords(text, name) {
      const rows = parseCsv(text);
      if (rows.length < 2) return [];
      const headers = rows[0].map(header => header.toLowerCase().trim());
      return rows.slice(1).map((row, index) => {
        const get = names => {
          const found = names.map(item => headers.indexOf(item)).find(i => i >= 0);
          return found >= 0 ? row[found] || '' : '';
        };
        const title = get(['title', 'paper title', 'article title']);
        if (!title) return null;
        return normalizeImportedPaper({
          name: `${name} row ${index + 2}`,
          title,
          authors: splitAuthors(get(['authors', 'author', 'creators'])),
          date: get(['date', 'publication date', 'year']),
          year: (get(['year', 'date']).match(/\b(19|20)\d{2}\b/) || [''])[0],
          journal: get(['journal', 'publication', 'source', 'container-title']),
          doi: normalizeDoi(get(['doi', 'DOI'])),
          abstract: get(['abstract', 'summary']),
          paperKeywords: splitKeywords(get(['keywords', 'keyword', 'tags'])),
          text: row.join(' ')
        }, 'CSV');
      }).filter(Boolean);
    }

    function parseCsv(text) {
      const rows = [];
      let row = [];
      let value = '';
      let quoted = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '"' && quoted && next === '"') {
          value += '"';
          index += 1;
        } else if (char === '"') {
          quoted = !quoted;
        } else if (char === ',' && !quoted) {
          row.push(value.trim());
          value = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
          if (value || row.length) rows.push([...row, value.trim()]);
          row = [];
          value = '';
          if (char === '\r' && next === '\n') index += 1;
        } else {
          value += char;
        }
      }
      if (value || row.length) rows.push([...row, value.trim()]);
      return rows;
    }

    function normalizeImportedPaper(paper, source) {
      return {
        id: paper.id || uid(),
        name: paper.name || source,
        title: cleanField(paper.title || paper.name || 'Untitled paper'),
        authors: paperAuthors(paper),
        date: cleanField(paper.date || ''),
        year: cleanField(paper.year || (String(paper.date || '').match(/\b(19|20)\d{2}\b/) || [''])[0]),
        journal: cleanField(paper.journal || ''),
        doi: normalizeDoi(paper.doi || ''),
        pmid: String(paper.pmid || ''),
        abstract: cleanAbstract(paper.abstract || ''),
        paperKeywords: Array.isArray(paper.paperKeywords) ? paper.paperKeywords : splitKeywords(paper.paperKeywords || paper.keywords || ''),
        gemmaKeywords: Array.isArray(paper.gemmaKeywords) ? paper.gemmaKeywords : splitKeywords(paper.gemmaKeywords || ''),
        keyFindings: Array.isArray(paper.keyFindings) ? paper.keyFindings.slice(0, 5) : [],
        organisms: Array.isArray(paper.organisms) ? paper.organisms.slice(0, 16) : splitKeywords(paper.organisms || ''),
        techniques: Array.isArray(paper.techniques) ? paper.techniques.slice(0, 16) : splitKeywords(paper.techniques || ''),
        discoveryTerms: Array.isArray(paper.discoveryTerms) ? paper.discoveryTerms.slice(0, 24) : splitKeywords(paper.discoveryTerms || ''),
        openAlexId: normalizeOpenAlexId(paper.openAlexId || paper.openAlexUrl || ''),
        openAlexUrl: paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${normalizeOpenAlexId(paper.openAlexId)}` : ''),
        referenceIds: dedupeList((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByIds: dedupeList((paper.citedByIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByCount: Number(paper.citedByCount || 0),
        influentialCitationCount: paper.influentialCitationCount,
        text: String(paper.text || paper.abstract || '').slice(0, 120000),
        size: Number(paper.size || 0),
        x: Number(paper.x || 0),
        y: Number(paper.y || 0),
        color: paper.color || '',
        areaId: paper.areaId || '',
        s2PaperId: paper.s2PaperId || '',
        url: paper.url || '',
        openAccessPdf: paper.openAccessPdf || '',
        metadataNote: paper.metadataNote || '',
        metadataSource: paper.metadataSource || source
      };
    }

    function normalizeOpenAlexId(value) {
      const match = String(value || '').match(/\bW\d+\b/i);
      return match ? match[0].toUpperCase() : '';
    }

    function uniqueDoiCandidates(values) {
      const seen = new Set();
      const result = [];
      values.forEach(value => {
        const doi = normalizeDoi(value || '');
        if (!doi || seen.has(doi.toLowerCase())) return;
        seen.add(doi.toLowerCase());
        result.push(doi);
      });
      return result;
    }

    function metadataCompletionScore(paper) {
      let score = 0;
      if (paper.doi) score += 3;
      if (paper.title && !/^untitled/i.test(paper.title)) score += 3;
      if ((paper.authors || []).length) score += 2;
      if (paper.date || paper.year) score += 1;
      if (paper.journal) score += 1;
      if ((paper.abstract || '').length >= 120 && !looksBinary(paper.abstract)) score += 2;
      if ((paper.paperKeywords || []).length) score += 1;
      return score;
    }

    function metadataLooksFilled(paper) {
      return Boolean(
        paper.doi
        && paper.title
        && (paper.authors || []).length
        && (paper.date || paper.year)
        && paper.journal
        && (((paper.abstract || '').length >= 120 && !looksBinary(paper.abstract)) || (paper.paperKeywords || []).length)
      );
    }

    async function fillMetadataFromDoiLoop(paper, candidates) {
      const dois = uniqueDoiCandidates([paper.doi, ...(candidates || [])]).slice(0, 8);
      let bestScore = metadataCompletionScore(paper);
      for (const doi of dois) {
        if (metadataLooksFilled(paper)) break;
        const before = metadataCompletionScore(paper);
        const ok = await enrichPaperFromDoi(paper, doi);
        const after = metadataCompletionScore(paper);
        if (ok && after > bestScore) bestScore = after;
        if (!ok && before === after && !paper.doi) paper.doi = doi;
      }
    }

    async function enrichPaperFromDoi(paper, doiOverride = '') {
      const doi = normalizeDoi(doiOverride || paper.doi || '');
      if (!doi) return false;
      try {
        const response = await fetch(backendUrl('/api/metadata/doi'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ doi, expectedTitle: paper.title || paper.name || '' })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'DOI lookup failed.');
        paper.doi = result.doi || doi;
        mergeDoiMetadata(paper, result.metadata || {});
        paper.metadataSource = result.source || 'DOI';
        return true;
      } catch (error) {
        paper.metadataNote = `DOI lookup unavailable: ${error.message}`;
        return false;
      }
    }

    function mergeDoiMetadata(paper, metadata) {
      if (metadata.title) paper.title = metadata.title;
      if ((metadata.authors || []).length) paper.authors = paperAuthors(metadata);
      if (metadata.date) paper.date = metadata.date;
      if (metadata.year) paper.year = metadata.year;
      if (metadata.journal) paper.journal = metadata.journal;
      if (metadata.doi) paper.doi = metadata.doi;
      if (metadata.abstract && (!paper.abstract || paper.abstract.length < 120 || looksBinary(paper.abstract))) paper.abstract = metadata.abstract;
      if ((metadata.paperKeywords || []).length) {
        paper.paperKeywords = [...new Set([...(metadata.paperKeywords || []), ...(paper.paperKeywords || [])])].slice(0, 24);
      }
      if ((metadata.gemmaKeywords || []).length) {
        paper.gemmaKeywords = [...new Set([...(metadata.gemmaKeywords || []), ...(paper.gemmaKeywords || [])])].slice(0, 24);
      }
      if ((metadata.keyFindings || []).length) paper.keyFindings = metadata.keyFindings.slice(0, 5);
      if ((metadata.organisms || []).length) paper.organisms = dedupeList([...(paper.organisms || []), ...metadata.organisms]).slice(0, 16);
      if ((metadata.techniques || []).length) paper.techniques = dedupeList([...(paper.techniques || []), ...metadata.techniques]).slice(0, 16);
      if ((metadata.discoveryTerms || []).length) paper.discoveryTerms = dedupeList([...(paper.discoveryTerms || []), ...metadata.discoveryTerms]).slice(0, 24);
      if (metadata.openAlexId || metadata.openAlexUrl) paper.openAlexId = normalizeOpenAlexId(metadata.openAlexId || metadata.openAlexUrl);
      if (metadata.openAlexUrl) paper.openAlexUrl = metadata.openAlexUrl;
      if ((metadata.referenceIds || []).length) {
        paper.referenceIds = dedupeList([...(paper.referenceIds || []), ...metadata.referenceIds].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      }
      if ((metadata.citedByIds || []).length) {
        paper.citedByIds = dedupeList([...(paper.citedByIds || []), ...metadata.citedByIds].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      }
      if (metadata.citedByCount) paper.citedByCount = Number(metadata.citedByCount || 0);
    }

    function tokenize(text) {
      const tokens = (text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .map(token => token.replace(/^-+|-+$/g, ''))
        .filter(token => token.length > 2 && token.length < 32 && !stopwords.has(token) && !/^\d+$/.test(token));

      const grams = [];
      for (let index = 0; index < tokens.length - 1; index += 1) {
        if (!stopwords.has(tokens[index]) && !stopwords.has(tokens[index + 1])) {
          grams.push(`${tokens[index]} ${tokens[index + 1]}`);
        }
      }

      return tokens.concat(grams.filter(gram => gram.length < 42));
    }

    const graphEngine = PulseGraph.createEngine();
    let analysisKey = '', requestedAnalysisKey = '', graphRevision = 0, analysisGeneration = 0;
    let layoutKey = '', graphMarkupKey = '', workerSerial = 0;
    let paintedSelectedLinkId=null, edgeElementsById=new Map(), linksById=new Map();
    let graphWorker = null, activeAnalysis = null, activeLayout = null;
    const graphTasks = new Map();
    const graphStats = {analyses:0, layouts:0, paints:0, workerFailures:0};
    let papersById = new Map(), linksByPaper = new Map();
    try {
      graphWorker = new Worker('graph-worker.js');
      graphWorker.onmessage = ({data}) => {
        const task = graphTasks.get(data.id);
        if (!task) return;
        graphTasks.delete(data.id);
        if (data.error){graphStats.workerFailures++;task.reject(new Error(data.error));} else task.resolve(data);
      };
      graphWorker.onerror = () => {
        graphStats.workerFailures++;
        graphWorker.terminate(); graphWorker = null;
        for (const task of graphTasks.values()) task.reject(new Error('Background graph calculation unavailable.'));
        graphTasks.clear();
      };
    } catch (_) {}
    function graphTask(action, payload) {
      return new Promise((resolve,reject) => {
        const id=++workerSerial;graphTasks.set(id,{resolve,reject});graphWorker.postMessage({id,action,payload});
      });
    }
    async function waitForGraphIdle() {
      while(activeAnalysis || activeLayout) await Promise.all([activeAnalysis,activeLayout].filter(Boolean));
    }
    function applyGraphAnalysis(result, key) {
      analysisKey=key; graphRevision++;
      state.links=result.links;state.clusters=result.clusters;state.explicitLinks=result.explicitLinks;
      linksById=new Map();state.links.forEach(link=>{if(!linksById.has(linkId(link)))linksById.set(linkId(link),link);});
      state.vectors=new Map(result.vectors.map(([id,v])=>[id,new Map(v)]));state.keywords=new Map(result.keywords);
      linksByPaper=new Map(state.papers.map(p=>[p.id,[]]));
      state.links.forEach(link=>{linksByPaper.get(link.source)?.push(link);linksByPaper.get(link.target)?.push(link);});
      graphStats.analyses++;
    }
    const paperAnalysisCache=new WeakMap();let paperAnalysisRevision=0;
    function analysisPaper(p) {
      const fields=[p.id,p.title,p.year,p.journal,p.abstract,p.text,p.openAlexId,p.openAlexUrl,(p.authors||[]).join('\0'),(p.paperKeywords||[]).join('\0'),(p.referenceIds||[]).join('\0'),(p.citedByIds||[]).join('\0')];
      let cached=paperAnalysisCache.get(p);
      if(!cached || fields.some((value,index)=>value!==cached.fields[index])) {
        cached={fields,revision:++paperAnalysisRevision,paper:{id:p.id,title:p.title,authors:[...(p.authors||[])],year:p.year,journal:p.journal,abstract:p.abstract,paperKeywords:[...(p.paperKeywords||[])],text:p.text,openAlexId:p.openAlexId,openAlexUrl:p.openAlexUrl,referenceIds:[...(p.referenceIds||[])],citedByIds:[...(p.citedByIds||[])]}};
        paperAnalysisCache.set(p,cached);
      }
      return cached;
    }
    function calculateRelatedness() {
      state.papers.forEach(p=>{p.x=Number.isFinite(Number(p.x))?Number(p.x):0;p.y=Number.isFinite(Number(p.y))?Number(p.y):0;});
      papersById=new Map(state.papers.map(p=>[p.id,p]));
      const records=state.papers.map(analysisPaper),papers=records.map(record=>record.paper);
      const payload={papers,explicitLinks:state.explicitLinks,threshold:state.threshold,graphSteerKeywords:state.graphSteerKeywords,stopwords:[...stopwords]};
      const key=JSON.stringify([records.map(record=>[record.paper.id,record.revision]),payload.explicitLinks,payload.threshold,payload.graphSteerKeywords]);
      if(key===analysisKey){if(requestedAnalysisKey && requestedAnalysisKey!==key){++analysisGeneration;requestedAnalysisKey='';}return;}
      if(key===requestedAnalysisKey)return;
      const generation=++analysisGeneration;
      if(graphWorker && papers.length>100) {
        requestedAnalysisKey=key;
        state.links=state.links.filter(link=>papersById.has(link.source)&&papersById.has(link.target));
        if(activeAnalysis)return; // Coalesce rapid slider/data changes into the latest snapshot.
        const job=graphTask('analyse',payload).then(({result})=>{
          if(generation===analysisGeneration){if(activeAnalysis===job)activeAnalysis=null;applyGraphAnalysis(result,key);render();}
        }).catch(()=>{if(generation===analysisGeneration){if(activeAnalysis===job)activeAnalysis=null;applyGraphAnalysis(graphEngine.analyse(payload),key);render();}}).finally(()=>{
          if(activeAnalysis===job){activeAnalysis=null;requestedAnalysisKey='';render();}
          else if(generation===analysisGeneration)requestedAnalysisKey='';
        });
        activeAnalysis=job;
      } else { requestedAnalysisKey='';applyGraphAnalysis(graphEngine.analyse(payload),key); }
    }
    function paperLinks(id) { return linksByPaper.get(id) || []; }

    function pairKey(source, target) {
      return [source, target].sort().join('__');
    }

    function intersectIds(left = [], right = []) {
      const rightSet = new Set((right || []).map(normalizeOpenAlexId).filter(Boolean));
      return dedupeList((left || []).map(normalizeOpenAlexId).filter(id => id && rightSet.has(id)));
    }

    function cosine(a, b) {
      if (!a || !b) return 0;
      let score = 0;
      const [small, large] = a.size < b.size ? [a, b] : [b, a];
      small.forEach((weight, term) => { score += weight * (large.get(term) || 0); });
      return score;
    }

    let bouncingNodeId = null;
    let bounceAnimationTimer = null;
    let recenterAnimId = null;
    let isRecenteringAnimation = false;
    let lastNodeClickTime = 0;
    let lastNodeClickId = null;

    function layout(width, height) {
      if (activeAnalysis || isRecenteringAnimation) return;
      const key=JSON.stringify([graphRevision,width,height,state.mode,state.centerId,state.graphStyle.spacing,state.papers.map(p=>[p.id,!!p.pinnedPosition])]);
      if (key===layoutKey) return;
      layoutKey=key;graphStats.layouts++;
      if(graphWorker && state.papers.length>100 && state.mode==='network' && !state.centerId) {
        const payload={papers:state.papers.map(p=>({id:p.id,x:p.x,y:p.y,pinnedPosition:p.pinnedPosition})),links:state.links,width,height,spacing:state.graphStyle.spacing||1};
        const job=graphTask('layout',payload).then(({positions})=>{
          if(layoutKey!==key)return;
          if(activeLayout===job)activeLayout=null;
          positions.forEach(pos=>{const paper=papersById.get(pos.id);if(paper&&!paper.pinnedPosition){paper.x=pos.x;paper.y=pos.y;}});
          graphMarkupKey='';render();
        }).catch(()=>{if(layoutKey!==key)return;if(activeLayout===job)activeLayout=null;layoutSmallGraph(width,height);graphMarkupKey='';render();}).finally(()=>{if(activeLayout===job)activeLayout=null;});
        activeLayout=job;return;
      }
      layoutSmallGraph(width,height);
    }
    function layoutSmallGraph(width, height) {
      const papers = state.papers;
      if (!papers.length) return;
      if (isRecenteringAnimation) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const radius = Math.max(80, Math.min(width, height) * 0.34 * spacing);

      if (state.centerId && layoutCenteredPaper(width, height, centerX, centerY)) return;

      if (state.mode === 'radial') {
        papers.forEach((paper, index) => {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        });
        return;
      }

      if (state.mode === 'clusters') {
        const clusterRadius = Math.max(65, Math.min(width, height) * 0.18 * spacing);
        state.clusters.forEach((cluster, clusterIndex) => {
          const angle = (Math.PI * 2 * clusterIndex) / Math.max(state.clusters.length, 1) - Math.PI / 2;
          const cx = centerX + Math.cos(angle) * radius * 0.72;
          const cy = centerY + Math.sin(angle) * radius * 0.72;
          cluster.forEach((id, index) => {
            const paper = papers.find(item => item.id === id);
            const localAngle = (Math.PI * 2 * index) / Math.max(cluster.length, 1);
            const cDist = Math.min(clusterRadius, 60 + cluster.length * 18);
            paper.x = cx + Math.cos(localAngle) * cDist;
            paper.y = cy + Math.sin(localAngle) * cDist;
          });
        });
        return;
      }

      papers.forEach((paper, index) => {
        if (!paper.x || !paper.y) {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        }
      });

      if(papers.length>100)return; // A usable static layout if worker loading fails.
      for (let tick = 0; tick < 58; tick += 1) {
        const forces = new Map(papers.map(paper => [paper.id, { x: 0, y: 0 }]));

        for (let i = 0; i < papers.length; i += 1) {
          for (let j = i + 1; j < papers.length; j += 1) {
            const a = papers[i];
            const b = papers[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distance = Math.max(45, Math.hypot(dx, dy));
            const push = (1600 * spacing * spacing) / (distance * distance);
            forces.get(a.id).x += (dx / distance) * push;
            forces.get(a.id).y += (dy / distance) * push;
            forces.get(b.id).x -= (dx / distance) * push;
            forces.get(b.id).y -= (dy / distance) * push;

            // Extra anti-collision repulsion specifically for horizontal text labels
            const minX = 120 * spacing;
            const minY = 54 * spacing;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx < minX && absDy < minY) {
              const repelX = (minX - absDx) * 0.08 * (dx >= 0 ? 1 : -1);
              const repelY = (minY - absDy) * 0.12 * (dy >= 0 ? 1 : -1);
              forces.get(a.id).x += repelX;
              forces.get(a.id).y += repelY;
              forces.get(b.id).x -= repelX;
              forces.get(b.id).y -= repelY;
            }
          }
        }

        state.links.forEach(link => {
          const a = papersById.get(link.source);
          const b = papersById.get(link.target);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const topologyBoost = link.type && link.type !== 'similarity' ? 0.32 : 0;
          const desired = (270 * spacing) - link.score * 105 - topologyBoost * 46;
          const pull = (distance - desired) * 0.0038 * (0.52 + link.score + topologyBoost);
          forces.get(a.id).x += (dx / distance) * pull;
          forces.get(a.id).y += (dy / distance) * pull;
          forces.get(b.id).x -= (dx / distance) * pull;
          forces.get(b.id).y -= (dy / distance) * pull;
        });

        const gravity = 0.0028 / Math.max(1, spacing * 0.75);
        const spanX = (width / 2 - 80) * Math.max(1, spacing);
        const spanY = (height / 2 - 70) * Math.max(1, spacing);
        papers.forEach(paper => {
          const force = forces.get(paper.id);
          if (paper.pinnedPosition) return;
          force.x += (centerX - paper.x) * gravity;
          force.y += (centerY - paper.y) * gravity;
          paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x + force.x));
          paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y + force.y));
        });
      }
    }

    function layoutCenteredPaper(width, height, centerX, centerY) {
      const focus = state.papers.find(paper => paper.id === state.centerId);
      if (!focus) {
        state.centerId = null;
        return false;
      }

      const linked = state.links
        .filter(link => link.source === focus.id || link.target === focus.id)
        .sort((a, b) => b.score - a.score);
      const neighborIds = linked.map(link => link.source === focus.id ? link.target : link.source);
      const neighborSet = new Set(neighborIds);
      const neighbors = neighborIds
        .map(id => state.papers.find(paper => paper.id === id))
        .filter(Boolean);
      const others = state.papers.filter(paper => paper.id !== focus.id && !neighborSet.has(paper.id));
      const shortestSide = Math.min(width, height);
      const spacing = state.graphStyle.spacing || 1;
      const innerRadius = Math.max(120, Math.min(shortestSide * 0.25, 260)) * spacing;
      const outerRadius = Math.max(innerRadius + 120, Math.min(shortestSide * 0.42, 430) * spacing);

      focus.x = centerX;
      focus.y = centerY;
      placePaperRing(neighbors, centerX, centerY, innerRadius, -Math.PI / 2);
      placePaperRing(others, centerX, centerY, outerRadius, -Math.PI / 2 + Math.PI / Math.max(others.length, 2));
      constrainPapers(width, height);
      return true;
    }

    function placePaperRing(papers, centerX, centerY, radius, offset) {
      papers.forEach((paper, index) => {
        const angle = offset + (Math.PI * 2 * index) / Math.max(papers.length, 1);
        paper.x = centerX + Math.cos(angle) * radius;
        paper.y = centerY + Math.sin(angle) * radius;
      });
    }

    function applyAreaContainment() {
      if (isRecenteringAnimation) return;
      const spacing = state.graphStyle.spacing || 1;
      state.areas.forEach(area => {
        const members = state.papers.filter(paper => paper.areaId === area.id);
        members.forEach((paper, index) => {
          if (pointInArea(paper.x, paper.y, area)) return;
          const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
          const rows = Math.max(1, Math.ceil(members.length / cols));
          const row = Math.floor(index / cols);
          const col = index % cols;
          const gapX = Math.max(58, Math.min(110 * spacing, area.width / Math.max(cols + 1, 2)));
          const gapY = Math.max(58, Math.min(96 * spacing, area.height / Math.max(rows + 1, 2)));
          paper.x = area.x + Math.min(area.width - 42, Math.max(42, (col + 1) * gapX));
          paper.y = area.y + Math.min(area.height - 42, Math.max(42, (row + 1) * gapY + 18));
        });
      });
    }

    function constrainPapers(width, height) {
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const spanX = (width / 2 - 80) * Math.max(1, spacing);
      const spanY = (height / 2 - 70) * Math.max(1, spacing);
      state.papers.forEach(paper => {
        paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x));
        paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y));
      });
    }

    function blowUpMap(factor = 1.35) {
      if (!state.papers.length) {
        showToast('Add papers to expand the map');
        return;
      }
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.min(4.0, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Maximum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startAreas = state.areas.map(a => ({ id: a.id, x: a.x, y: a.y, width: a.width, height: a.height }));
      const startTime = performance.now();
      const duration = 280;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        state.areas.forEach(a => {
          const orig = startAreas.find(sa => sa.id === a.id);
          if (orig) {
            a.x = cx + (orig.x - cx) * currentFactor;
            a.y = cy + (orig.y - cy) * currentFactor;
            a.width = orig.width * Math.sqrt(currentFactor);
            a.height = orig.height * Math.sqrt(currentFactor);
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map blown up (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function compressMap(factor = 0.75) {
      if (!state.papers.length) return;
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.max(0.35, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Minimum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startTime = performance.now();
      const duration = 240;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map condensed (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function areaForPoint(x, y) {
      return [...state.areas].reverse().find(area => pointInArea(x, y, area));
    }

    function pointInArea(x, y, area) {
      return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
    }

    function resizeArea(area, field, value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      area[field] = Math.max(field === 'width' ? 160 : 110, Math.min(1200, next));
      applyAreaContainment();
    }

    function setAreaSize(area, width, height) {
      area.width = Math.max(160, Math.min(1200, width));
      area.height = Math.max(110, Math.min(1200, height));
      applyAreaContainment();
    }

    function createArea() {
      const index = state.areas.length;
      const width = Math.max(230, state.view.width * 0.28);
      const height = Math.max(150, state.view.height * 0.24);
      const area = {
        id: uid(),
        name: `Area ${index + 1}`,
        color: palette[index % palette.length],
        x: state.view.x + 92 + index * 34,
        y: state.view.y + 96 + index * 28,
        width,
        height
      };
      state.areas.push(area);
      state.selectedAreaId = area.id;
      setAreaPanelOpen(true);
      render();
      showToast(`Created ${area.name}.`);
    }

    function removeArea(id) {
      const area = state.areas.find(item => item.id === id);
      state.areas = state.areas.filter(item => item.id !== id);
      state.papers.forEach(paper => {
        if (paper.areaId === id) paper.areaId = '';
      });
      if (state.selectedAreaId === id) state.selectedAreaId = null;
      render();
      showToast(`${area?.name || 'Area'} removed.`);
    }

    function paperColor(paper, clusterByPaper) {
      if (paper.color) return paper.color;
      const area = state.areas.find(item => item.id === paper.areaId);
      if (area?.color) return area.color;
      return palette[(clusterByPaper.get(paper.id) || 0) % palette.length];
    }

    function render() {
      calculateRelatedness();
      syncWorkspaceControls();
      if (state.selectedLinkId && !state.links.some(link => linkId(link) === state.selectedLinkId)) {
        state.selectedLinkId = null;
      }
      const isTableMode = state.mode === 'table';
      const isTimelineMode = state.workspaceView === 'timeline';
      els.timelineView.hidden = !isTimelineMode;
      if (isTimelineMode) renderTimeline();
      els.map.hidden = isTableMode || isTimelineMode;
      els.map.style.display = isTableMode || isTimelineMode ? 'none' : '';
      els.tableView.hidden = !isTableMode;
      const titleHeading = (els.canvasTitle || document.querySelector('.canvas-title'))?.querySelector('h1');
      if (titleHeading) {
        titleHeading.textContent = isTableMode ? 'Bibliography' : (state.mode === 'radial' ? 'Radial hierarchy' : (state.mode === 'clusters' ? 'Topic clusters' : 'Relatedness graph'));
      }
      if (isTableMode) {
        renderTableView();
      }
      if (state.workspaceView !== 'network') {
        renderTagFilterBar(); if(state.workspaceView==='library')renderTableView();
        renderPapers();renderDetails();updateMetrics();scheduleAutosave();return;
      }
      const rect = els.map.getBoundingClientRect();
      const width = Math.max(rect.width, 640);
      const height = Math.max(rect.height, 520);
      const safeHeight = Math.max(360, height - bottomDockSpace());
      updateViewSize(width, height);
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
      els.map.classList.toggle('no-grid', !state.graphStyle.showGrid);
      if (state.workspaceView === 'network') {
        layout(width, safeHeight);
        applyAreaContainment();
      }

      const paintKey=JSON.stringify([graphRevision,state.linkTypeFilter,state.librarySearch,state.filterTags,state.filterMode,state.graphStyle,state.areas,bouncingNodeId,state.papers.map(p=>[p.id,p.title,p.authors,p.year,p.journal,p.x,p.y,p.color,p.areaId,p.gemmaKeywords])]);
      if(paintKey===graphMarkupKey) {
        renderDetails();renderSelection();syncWorkspaceControls();updateMetrics();scheduleAutosave();return;
      }
      graphMarkupKey=paintKey;graphStats.paints++;
      const clusterByPaper = new Map();
      state.clusters.forEach((cluster, index) => cluster.forEach(id => clusterByPaper.set(id, index)));

      const areaMarkup = state.graphStyle.showAreas ? state.areas.map(area => {
        const selected = state.selectedAreaId === area.id ? ' is-selected' : '';
        return `<g class="area-region${selected}" data-area="${area.id}">
          <rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" rx="18" fill="${area.color}" stroke="${area.color}"></rect>
          <text x="${area.x + 16}" y="${area.y + 28}">${escapeHtml(area.name)}</text>
          <rect class="area-resize-handle" x="${area.x + area.width - 15}" y="${area.y + area.height - 15}" width="22" height="22" rx="7"></rect>
        </g>`;
      }).join('') : '';

      const hasFilter = Boolean(state.librarySearch || (state.filterTags && state.filterTags.length > 0));
      const availableLinks = visibleLinks();
      const sortedLinks = availableLinks.length > 2500 ? availableLinks.slice().sort((a,b)=>b.score-a.score).slice(0,2500).sort((a,b)=>a.score-b.score) : availableLinks.sort((a,b)=>a.score-b.score);
      const linkMarkup = sortedLinks.map(link => {
        const source = papersById.get(link.source);
        const target = papersById.get(link.target);
        const sourceMatches = !hasFilter || (source && paperMatchesFilters(source));
        const targetMatches = !hasFilter || (target && paperMatchesFilters(target));
        const filterDimmed = hasFilter && (!sourceMatches || !targetMatches) ? ' is-filter-dimmed' : '';
        const opacity = Math.min(0.72, 0.18 + link.score * 0.48);
        const width = (0.55 + link.score * 3.15) * (state.graphStyle.edgeScale || 0.65);
        const id = linkId(link);
        const selected = state.selectedLinkId === id ? ' is-selected' : '';
        const label = linkLabel(link);
        return `<line class="edge${selected}${filterDimmed}" data-type="${escapeHtml(link.type || 'similarity')}" data-link="${id}" data-source="${link.source}" data-target="${link.target}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke-width="${selected ? (width + 2.4).toFixed(2) : width.toFixed(2)}" opacity="${selected ? '1' : opacity.toFixed(2)}"><title>${escapeHtml(label)}</title></line>
          <line class="edge-hit" data-link="${id}" data-source="${link.source}" data-target="${link.target}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke-width="20" stroke="transparent" stroke-linecap="round"><title>${escapeHtml(label)}</title></line>`;
      }).join('');

      const nodeMarkup = state.papers.map((paper, idx) => {
        const color = paperColor(paper, clusterByPaper);
        const radius = state.graphStyle.nodeSize || 22;
        const linked = selectedLinkEndpoints().has(paper.id) ? ' is-linked' : '';
        const selected = state.selectedId === paper.id ? ' is-selected' : '';
        const centered = state.centerId === paper.id ? ' is-centered' : '';
        const matchesFilter = !hasFilter || paperMatchesFilters(paper);
        const filterClass = hasFilter ? (matchesFilter ? ' is-filter-match' : ' is-filter-dimmed') : '';

        // Check neighboring nodes within proximity to avoid label collisions
        let labelPos = 'bottom';
        let neighborBelow = false;
        let neighborAbove = false;
        for (let j = 0; state.papers.length <= 100 && j < state.papers.length; j++) {
          if (j === idx) continue;
          const other = state.papers[j];
          const dist = Math.hypot(paper.x - other.x, paper.y - other.y);
          if (dist < radius * 2.6 + 36) {
            if (other.y > paper.y) neighborBelow = true;
            if (other.y < paper.y) neighborAbove = true;
          }
        }
        if (neighborBelow && !neighborAbove) {
          labelPos = 'top';
        }

        const labelData = formatSmartLabel(paper, state.graphStyle.labelMode || 'short');
        let labelSvg = '';
        if (labelData.lines && labelData.lines.length > 0) {
          const fontSize = Math.max(10, Math.min(13, radius * 0.52));
          const lineHeight = fontSize + 3;
          const startY = labelPos === 'top'
            ? -(radius + 8 + (labelData.lines.length - 1) * lineHeight)
            : (radius + 15);

          const tspans = labelData.lines.map((line, lIdx) =>
            `<tspan x="0" y="${(startY + lIdx * lineHeight).toFixed(1)}">${escapeHtml(line)}</tspan>`
          ).join('');

          labelSvg = `<text class="node-label pos-${labelPos}" text-anchor="middle" font-size="${fontSize}">${tspans}</text>`;
        }

        const isBouncing = bouncingNodeId === paper.id;
        const bouncingClass = isBouncing ? ' is-bouncing' : '';
        const rippleSvg = isBouncing ? `
          <circle class="bounce-ripple" r="${radius}" fill="none" stroke="${color}" stroke-width="3.5"></circle>
          <circle class="bounce-ripple bounce-ripple-2" r="${radius}" fill="none" stroke="var(--accent)" stroke-width="2.5"></circle>
        ` : '';

        return `<g class="node${selected}${linked}${centered}${filterClass}${bouncingClass}" data-id="${paper.id}" transform="translate(${paper.x.toFixed(1)},${paper.y.toFixed(1)})">
          ${rippleSvg}
          <circle class="node-main-circle" r="${radius}" fill="${color}"></circle>
          ${labelSvg}
          <title>${escapeHtml(paper.title || '')}</title>
        </g>`;
      }).join('');

      els.map.innerHTML = `<g>${areaMarkup}</g><g>${linkMarkup}</g><g>${nodeMarkup}</g>`;
      paintedSelectedLinkId=state.selectedLinkId;edgeElementsById=new Map();
      els.map.querySelectorAll('.edge').forEach(edge=>{const id=edge.dataset.link;if(!edgeElementsById.has(id))edgeElementsById.set(id,[]);edgeElementsById.get(id).push(edge);});
      bindAreaEvents();
      bindEdgeEvents();
      bindNodeEvents();
      renderTagFilterBar();
      renderPapers();
      renderDetails();
      if(!els.linkagePanel.hidden)renderLinkages();
      if(!els.areaPanel.hidden)renderAreasPanel();
      updateMetrics();
      scheduleAutosave();
    }

    function renderTableView(focusColumn = '') {
      if (!els.tableView) return;
      if (!state.papers.length) {
        els.tableView.innerHTML = '<div class="table-empty">Drop papers to build an extracted Bibliography table.</div>';
        return;
      }
      const rows = filteredTablePapers();
      const columns = activeTableColumns();
      const isCompact = state.paperView === 'compact';
      els.tableView.innerHTML = `
        <table class="findings-table${isCompact ? ' is-compact' : ''}" aria-label="Extracted Bibliography findings">
          <thead>
            <tr>
              ${columns.map(column => `
                <th draggable="true" data-column="${column.key}">
                  <div class="table-heading">
                    <button type="button" data-action="sort-table" data-column="${column.key}">
                      ${escapeHtml(column.label)}${state.tableSort.key === column.key ? (state.tableSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                    <input data-table-filter="${column.key}" value="${escapeHtml(state.tableFilters[column.key] || '')}" placeholder="Filter">
                  </div>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(paper => {
              return `<tr data-table-paper="${paper.id}">
                ${columns.map(column => `<td class="${column.key === 'findings' ? 'findings-cell' : ''}">${column.cell(paper)}</td>`).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${rows.length ? '' : '<div class="table-empty">No papers match those Bibliography filters.</div>'}
      `;
      bindTableFilters();
      bindTableHeaders();
      if (focusColumn) {
        const input = els.tableView.querySelector(`[data-table-filter="${focusColumn}"]`);
        if (input) {
          input.focus();
          const end = input.value.length;
          input.setSelectionRange?.(end, end);
        }
      }
      els.tableView.querySelectorAll('[data-table-paper]').forEach(row => {
        row.addEventListener('click', () => {
          state.selectedId = row.dataset.tablePaper;
          state.inspectorOpen = true;
          renderDetails();
          showToast('Selected paper from Bibliography.');
        });
      });
      els.tableView.querySelectorAll('[data-action="table-edit-tags"]').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          openKeywordModal(btn.dataset.paper);
        });
      });
    }

    function tableColumnDefinitions() {
      const isCompact = state.paperView === 'compact';
      return [
        {
          key: 'paper',
          label: 'Paper',
          text: paper => `${paper.title || ''} ${paper.doi || ''} ${paper.name || ''}`,
          sort: paper => paper.title || '',
          cell: paper => {
            const title = escapeHtml(paper.title || 'Untitled paper');
            const meta = escapeHtml(paper.doi ? `DOI ${paper.doi}` : (paper.name || ''));
            const abstractSnippet = (!isCompact && paper.abstract)
              ? `<div class="table-abstract-snippet" title="${escapeHtml(paper.abstract)}">${escapeHtml(paper.abstract.length > 220 ? paper.abstract.slice(0, 217) + '...' : paper.abstract)}</div>`
              : '';
            return `<div class="table-paper-cell">
              <div class="table-paper-title">${title}</div>
              ${meta ? `<div class="metadata-line">${meta}</div>` : ''}
              ${abstractSnippet}
            </div>`;
          }
        },
        {
          key: 'authors',
          label: 'Authors',
          text: paper => paperAuthors(paper).join(' '),
          sort: paper => paperAuthors(paper).join(' '),
          cell: paper => {
            const list = paperAuthors(paper);
            if (!list.length) return '<span class="subtle">Unknown</span>';
            if (isCompact) {
              return escapeHtml(list.slice(0, 3).join('; ') + (list.length > 3 ? ` (+${list.length - 3})` : ''));
            }
            return `<div class="table-authors-expanded">${escapeHtml(list.join('; '))}</div>`;
          }
        },
        {
          key: 'year',
          label: 'Year',
          text: paper => `${paper.year || ''} ${paper.date || ''}`,
          sort: paper => paper.year || paper.date || '',
          cell: paper => escapeHtml(paper.year || paper.date || '')
        },
        {
          key: 'venue',
          label: 'Venue',
          text: paper => paper.journal || '',
          sort: paper => paper.journal || '',
          cell: paper => escapeHtml(paper.journal || '')
        },
        {
          key: 'keywords',
          label: 'Keywords',
          text: paper => mergedKeywords(paper).join(' '),
          sort: paper => mergedKeywords(paper).join(' '),
          cell: paper => {
            const terms = mergedKeywords(paper);
            const count = isCompact ? 4 : terms.length;
            const chips = terms.slice(0, count).map((term, i) => `<span class="term"><span class="term-rank">#${i + 1}</span>${escapeHtml(term)}</span>`).join('');
            const extra = isCompact && terms.length > count ? `<span class="table-extra-chips subtle">+${terms.length - count}</span>` : '';
            return `<div class="table-keywords-cell">${chips}${extra}<button class="compact-chip tag-edit-chip" type="button" data-action="table-edit-tags" data-paper="${paper.id}" title="Manage &amp; reorder keyword tags">🏷️</button></div>`;
          }
        },
        {
          key: 'findings',
          label: 'Key findings',
          text: paper => keyFindings(paper).join(' '),
          sort: paper => keyFindings(paper).join(' '),
          cell: paper => {
            const findings = keyFindings(paper);
            if (!findings.length) return '<span class="subtle">No clear finding extracted yet.</span>';
            if (isCompact) {
              const top = findings.slice(0, 2);
              return `<div class="table-findings-compact">${top.map(item => `<div>${escapeHtml(item)}</div>`).join('')}${findings.length > 2 ? `<div class="subtle" style="font-size:10px;">+${findings.length - 2} more</div>` : ''}</div>`;
            }
            return `<div class="table-findings-expanded">${findings.map(item => `<div class="finding-bullet">• ${escapeHtml(item)}</div>`).join('')}</div>`;
          }
        },
        {
          key: 'links',
          label: 'Links',
          text: paper => String(tableLinkCount(paper)),
          sort: paper => tableLinkCount(paper),
          cell: paper => {
            const count = tableLinkCount(paper);
            return `<span class="table-link-badge ${count ? 'has-links' : 'no-links'}">${count} link${count === 1 ? '' : 's'}</span>`;
          }
        }
      ];
    }

    function activeTableColumns() {
      const definitions = tableColumnDefinitions();
      const byKey = new Map(definitions.map(column => [column.key, column]));
      const ordered = state.tableColumns.map(key => byKey.get(key)).filter(Boolean);
      definitions.forEach(column => {
        if (!ordered.some(item => item.key === column.key)) ordered.push(column);
      });
      return ordered;
    }

    function tableLinkCount(paper) {
      return paperLinks(paper.id).length;
    }

    function filteredTablePapers() {
      const columns = tableColumnDefinitions();
      const filters = Object.entries(state.tableFilters || {})
        .map(([key, value]) => [key, String(value || '').trim().toLowerCase()])
        .filter(([, value]) => value);
      const filtered = state.papers.filter(paper => {
        if (!paperMatchesFilters(paper)) return false;
        return filters.every(([key, value]) => {
          const column = columns.find(item => item.key === key);
          return column ? String(column.text(paper) || '').toLowerCase().includes(value) : true;
        });
      });
      const sortColumn = columns.find(column => column.key === state.tableSort.key) || columns[0];
      return filtered.sort((a, b) => {
        const left = sortColumn.sort(a);
        const right = sortColumn.sort(b);
        const direction = state.tableSort.direction === 'desc' ? -1 : 1;
        if (typeof left === 'number' || typeof right === 'number') return ((Number(left) || 0) - (Number(right) || 0)) * direction;
        return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' }) * direction;
      });
    }

    function bindTableFilters() {
      els.tableView.querySelectorAll('[data-table-filter]').forEach(input => {
        input?.addEventListener('input', event => {
          state.tableFilters[event.target.dataset.tableFilter] = event.target.value;
          renderTableView(event.target.dataset.tableFilter);
        });
      });
    }

    function bindTableHeaders() {
      els.tableView.querySelectorAll('[data-action="sort-table"]').forEach(button => {
        button.addEventListener('click', () => {
          const key = button.dataset.column;
          state.tableSort = {
            key,
            direction: state.tableSort.key === key && state.tableSort.direction === 'asc' ? 'desc' : 'asc'
          };
          renderTableView();
        });
      });
      els.tableView.querySelectorAll('th[data-column]').forEach(header => {
        header.addEventListener('dragstart', event => {
          event.dataTransfer.setData('text/plain', header.dataset.column);
          event.dataTransfer.effectAllowed = 'move';
        });
        header.addEventListener('dragover', event => {
          event.preventDefault();
          header.classList.add('is-drag-over');
        });
        header.addEventListener('dragleave', () => header.classList.remove('is-drag-over'));
        header.addEventListener('drop', event => {
          event.preventDefault();
          header.classList.remove('is-drag-over');
          moveTableColumn(event.dataTransfer.getData('text/plain'), header.dataset.column);
        });
      });
    }

    function moveTableColumn(sourceKey, targetKey) {
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const columns = [...state.tableColumns];
      const from = columns.indexOf(sourceKey);
      const to = columns.indexOf(targetKey);
      if (from < 0 || to < 0) return;
      const [moved] = columns.splice(from, 1);
      columns.splice(to, 0, moved);
      state.tableColumns = columns;
      renderTableView();
    }

    function updateViewSize(width, height) {
      state.view.width = width;
      state.view.height = height;
    }

    function panCanvas(direction) {
      const stepX = state.view.width * 0.16;
      const stepY = state.view.height * 0.16;
      if (direction === 'left') state.view.x -= stepX;
      if (direction === 'right') state.view.x += stepX;
      if (direction === 'up') state.view.y -= stepY;
      if (direction === 'down') state.view.y += stepY;
      if (direction === 'reset') {
        state.view.x = 0;
        state.view.y = 0;
      }
      if (direction === 'fit') fitCanvasToMap();
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
    }

    function fitCanvasToMap() {
      if (!state.papers.length) {
        state.view.x = 0;
        state.view.y = 0;
        return;
      }
      const xs = state.papers.map(paper => paper.x || 0);
      const ys = state.papers.map(paper => paper.y || 0);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const mapCenterX = (minX + maxX) / 2;
      const mapCenterY = (minY + maxY) / 2;
      state.view.x = mapCenterX - state.view.width / 2;
      state.view.y = mapCenterY - state.view.height / 2;
    }

    function linkId(link) {
      return [link.source, link.target].sort().join('__');
    }

    function selectedLinkEndpoints() {
      const link = linksById.get(state.selectedLinkId);
      return new Set(link ? [link.source, link.target] : []);
    }

    function compactTitle(title) {
      const words = title.replace(/\s+/g, ' ').trim();
      return words.length > 34 ? `${words.slice(0, 31)}...` : words;
    }

    function formatSmartLabel(paper, mode) {
      if (mode === 'none') return { lines: [] };
      if (mode === 'keywords') {
        const kws = mergedKeywords(paper).slice(0, 2);
        if (kws.length) return { lines: [kws.join(' / ').slice(0, 24)] };
      }
      if (mode === 'full') {
        const title = String(paper.title || 'Untitled').replace(/\s+/g, ' ').trim();
        if (title.length <= 24) return { lines: [title] };
        const words = title.split(' ');
        let l1 = '', l2 = '';
        let onFirst = true;
        for (const w of words) {
          if (onFirst) {
            const cand = l1 ? l1 + ' ' + w : w;
            if (cand.length <= 22) {
              l1 = cand;
            } else {
              onFirst = false;
              l2 = w;
            }
          } else {
            const cand = l2 ? l2 + ' ' + w : w;
            if (cand.length <= 22) {
              l2 = cand;
            } else {
              l2 += '...';
              break;
            }
          }
        }
        return { lines: l2 ? [l1, l2] : [l1 || title.slice(0, 22) + '...'] };
      }
      // 'short' mode: Standard academic citation label: Author et al. (Year)
      const authors = paperAuthors(paper);
      const year = paper.year || (paper.date && String(paper.date).match(/\b(19|20)\d{2}\b/) ? String(paper.date).match(/\b(19|20)\d{2}\b/)[0] : '');
      const yStr = year ? `(${year})` : '';
      if (authors.length > 0) {
        let authorStr = '';
        if (authors.length === 1) {
          authorStr = extractLastName(authors[0]) || 'Author';
        } else if (authors.length === 2) {
          const l1 = extractLastName(authors[0]) || 'Author';
          const l2 = extractLastName(authors[1]) || 'Author';
          authorStr = `${l1} & ${l2}`;
        } else {
          const l1 = extractLastName(authors[0]) || 'Author';
          authorStr = `${l1} et al.`;
        }
        const fullCitation = yStr ? `${authorStr} ${yStr}` : authorStr;
        if (fullCitation.length <= 24) {
          return { lines: [fullCitation] };
        }
        if (yStr) {
          const line1 = authorStr.length <= 24 ? authorStr : (authorStr.slice(0, 21) + '...');
          return { lines: [line1, yStr] };
        }
        return { lines: [authorStr.length <= 24 ? authorStr : (authorStr.slice(0, 21) + '...')] };
      }
      const t = String(paper.title || 'Untitled').replace(/\s+/g, ' ').trim();
      return { lines: [t.length > 22 ? t.slice(0, 19) + '...' : t] };
    }

    function graphLabel(paper) {
      const data = formatSmartLabel(paper, state.graphStyle.labelMode || 'short');
      return data.lines.join(' ');
    }

    function syncGraphControls() {
      const style = state.graphStyle;
      els.nodeSizeInput.value = Math.round(style.nodeSize || 22);
      els.nodeSizeValue.textContent = Math.round(style.nodeSize || 22);
      els.edgeScaleInput.value = Math.round((style.edgeScale || 1) * 100);
      els.edgeScaleValue.textContent = `${Math.round((style.edgeScale || 1) * 100)}%`;
      els.spacingInput.value = Math.round((style.spacing || 1) * 100);
      els.spacingValue.textContent = `${Math.round((style.spacing || 1) * 100)}%`;
      els.labelModeInput.value = style.labelMode || 'short';
      els.gridToggleInput.checked = style.showGrid !== false;
      els.areasToggleInput.checked = style.showAreas !== false;
    }

    function updateGraphStyle(updates) {
      state.graphStyle = { ...state.graphStyle, ...updates };
      syncGraphControls();
      render();
    }

    function resetGraphStyle() {
      state.graphStyle = {
        nodeSize: 22,
        edgeScale: 0.65,
        spacing: 1,
        labelMode: 'short',
        showGrid: true,
        showAreas: true
      };
      syncGraphControls();
      render();
      showToast('Graph style reset.');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function bindNodeEvents() {
      els.map.querySelectorAll('.node').forEach(node => {
        const id = node.dataset.id;

        node.addEventListener('dblclick', event => {
          event.stopPropagation();
          centerGraphOnPaper(id, true);
        });

        node.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const paper = papersById.get(id);
          if (!paper) return;
          node.parentNode.appendChild(node);
          node.classList.add('is-dragging');
          const point = svgPoint(event);
          state.drag = {
            id,
            offsetX: point.x - paper.x,
            offsetY: point.y - paper.y,
            startX: point.x,
            startY: point.y,
            moved: false
          };
          node.setPointerCapture(event.pointerId);
          els.map.classList.add('is-panning');
          state.selectedId = id;
          state.selectedLinkId = null;
          state.inspectorOpen = true;
          renderDetails();
          renderSelection();scheduleAutosave();
        });

        node.addEventListener('pointermove', event => {
          if (!state.drag || state.drag.id !== id) return;
          const paper = state.papers.find(item => item.id === state.drag.id);
          if (!paper) return;
          const point = svgPoint(event);
          if (!state.drag.moved && Math.hypot(point.x - state.drag.startX, point.y - state.drag.startY) > 4) {
            state.drag.moved = true;
          }
          if (state.drag.moved) {
            paper.x = point.x - state.drag.offsetX;
            paper.y = point.y - state.drag.offsetY;
            node.setAttribute('transform', `translate(${paper.x.toFixed(1)},${paper.y.toFixed(1)})`);
            renderEdgesOnly();
          }
        });

        node.addEventListener('pointerup', () => {
          if (state.drag && state.drag.id === id) {
            const paper = state.papers.find(item => item.id === state.drag.id);
            const wasDragged = state.drag.moved;
            state.drag = null;
            node.classList.remove('is-dragging');
            els.map.classList.remove('is-panning');

            if (wasDragged) {
              const area = paper ? areaForPoint(paper.x, paper.y) : null;
              if (paper) {
                paper.areaId = area?.id || paper.areaId || '';
                paper.pinnedPosition = true;
              }
              if (area) showToast(`Placed "${compactTitle(paper.title)}" in ${area.name}.`);
              render();
            } else {
              // Rapid tap / click double-click detection
              const now = Date.now();
              if (lastNodeClickTime && (now - lastNodeClickTime < 380) && lastNodeClickId === id) {
                lastNodeClickTime = 0;
                lastNodeClickId = null;
                centerGraphOnPaper(id, true);
              } else {
                lastNodeClickTime = now;
                lastNodeClickId = id;
              }
            }
          }
        });

        node.addEventListener('pointercancel', () => {
          state.drag = null;
          node.classList.remove('is-dragging');
          els.map.classList.remove('is-panning');
        });
      });
    }

    function bindAreaEvents() {
      els.map.querySelectorAll('.area-region').forEach(region => {
        region.addEventListener('pointerdown', event => {
          if (event.target.closest?.('.area-resize-handle')) return;
          if (event.target.closest?.('.node')) return;
          event.stopPropagation();
          const area = state.areas.find(item => item.id === region.dataset.area);
          if (!area) return;
          const point = svgPoint(event);
          state.selectedAreaId = area.id;
          state.areaDrag = { id: area.id, offsetX: point.x - area.x, offsetY: point.y - area.y };
          region.setPointerCapture(event.pointerId);
          renderAreasPanel();
          renderSelection();
        });

        region.addEventListener('pointermove', event => {
          if (!state.areaDrag || state.areaDrag.id !== region.dataset.area) return;
          const area = state.areas.find(item => item.id === state.areaDrag.id);
          const point = svgPoint(event);
          const oldX = area.x;
          const oldY = area.y;
          area.x = point.x - state.areaDrag.offsetX;
          area.y = point.y - state.areaDrag.offsetY;
          const dx = area.x - oldX;
          const dy = area.y - oldY;
          state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
            paper.x += dx;
            paper.y += dy;
          });
          region.querySelector('rect')?.setAttribute('x', area.x);
          region.querySelector('rect')?.setAttribute('y', area.y);
          const label = region.querySelector('text');
          label?.setAttribute('x', area.x + 16);
          label?.setAttribute('y', area.y + 28);
          state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
            els.map.querySelector(`.node[data-id="${paper.id}"]`)?.setAttribute('transform', `translate(${paper.x},${paper.y})`);
          });
          renderEdgesOnly();
        });

        region.addEventListener('pointerup', () => {
          state.areaDrag = null;
          render();
        });
        region.addEventListener('pointercancel', () => { state.areaDrag = null; });
      });

      els.map.querySelectorAll('.area-resize-handle').forEach(handle => {
        handle.addEventListener('pointerdown', event => {
          event.stopPropagation();
          const region = event.target.closest('.area-region');
          const area = state.areas.find(item => item.id === region.dataset.area);
          if (!area) return;
          const point = svgPoint(event);
          state.selectedAreaId = area.id;
          state.areaResize = {
            id: area.id,
            pointerId: event.pointerId,
            startX: point.x,
            startY: point.y,
            width: area.width,
            height: area.height
          };
          handle.setPointerCapture(event.pointerId);
          els.map.setPointerCapture?.(event.pointerId);
          renderAreasPanel();
          renderSelection();
        });

        handle.addEventListener('pointermove', event => {
          updateAreaResize(event);
        });

        handle.addEventListener('pointerup', () => {
          state.areaResize = null;
          render();
        });
        handle.addEventListener('pointercancel', () => { state.areaResize = null; });
      });
    }

    function updateAreaResize(event) {
      if (!state.areaResize || state.areaResize.pointerId !== event.pointerId) return;
      const area = state.areas.find(item => item.id === state.areaResize.id);
      if (!area) return;
      const point = svgPoint(event);
      setAreaSize(area, state.areaResize.width + point.x - state.areaResize.startX, state.areaResize.height + point.y - state.areaResize.startY);
      const region = els.map.querySelector(`.area-region[data-area="${area.id}"]`);
      const rect = region?.querySelector('rect:not(.area-resize-handle)');
      const handle = region?.querySelector('.area-resize-handle');
      rect?.setAttribute('width', area.width);
      rect?.setAttribute('height', area.height);
      handle?.setAttribute('x', area.x + area.width - 15);
      handle?.setAttribute('y', area.y + area.height - 15);
      state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
        els.map.querySelector(`.node[data-id="${paper.id}"]`)?.setAttribute('transform', `translate(${paper.x},${paper.y})`);
      });
      renderEdgesOnly();
    }

    function bindCanvasPanEvents() {
      els.map.addEventListener('wheel', event => {
        event.preventDefault();
        zoomCanvasAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.12 : 0.88);
      }, { passive: false });

      els.map.addEventListener('pointerdown', event => {
        if (event.target.closest?.('.node') || event.target.closest?.('.edge') || event.target.closest?.('.edge-hit') || event.target.closest?.('.area-region')) return;
        state.panDrag = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          startX: state.view.x,
          startY: state.view.y
        };
        els.map.classList.add('is-panning');
        els.map.setPointerCapture(event.pointerId);
      });

      els.map.addEventListener('pointermove', event => {
        if (state.areaResize) {
          updateAreaResize(event);
          return;
        }
        if (!state.panDrag || state.panDrag.pointerId !== event.pointerId) return;
        const rect = els.map.getBoundingClientRect();
        const scaleX = state.view.width / Math.max(rect.width, 1);
        const scaleY = state.view.height / Math.max(rect.height, 1);
        state.view.x = state.panDrag.startX - (event.clientX - state.panDrag.clientX) * scaleX;
        state.view.y = state.panDrag.startY - (event.clientY - state.panDrag.clientY) * scaleY;
        els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
      });

      const endPan = event => {
        if (state.areaResize && state.areaResize.pointerId === event.pointerId) {
          state.areaResize = null;
          render();
          return;
        }
        if (!state.panDrag || state.panDrag.pointerId !== event.pointerId) return;
        state.panDrag = null;
        els.map.classList.remove('is-panning');scheduleAutosave();
      };
      els.map.addEventListener('pointerup', endPan);
      els.map.addEventListener('pointercancel', endPan);
    }

    function zoomCanvasAt(clientX, clientY, factor) {
      const rect = els.map.getBoundingClientRect();
      const anchorX = state.view.x + ((clientX - rect.left) / Math.max(rect.width, 1)) * state.view.width;
      const anchorY = state.view.y + ((clientY - rect.top) / Math.max(rect.height, 1)) * state.view.height;
      const nextWidth = Math.max(220, Math.min(4200, state.view.width * factor));
      const nextHeight = Math.max(180, Math.min(3600, state.view.height * factor));
      const ratioX = (anchorX - state.view.x) / state.view.width;
      const ratioY = (anchorY - state.view.y) / state.view.height;
      state.view.width = nextWidth;
      state.view.height = nextHeight;
      state.view.x = anchorX - ratioX * state.view.width;
      state.view.y = anchorY - ratioY * state.view.height;
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);scheduleAutosave();
    }

    function centerGraphOnPaper(id, withBounce = true) {
      const paper = papersById.get(id);
      if (!paper) return;

      if (recenterAnimId) {
        cancelAnimationFrame(recenterAnimId);
        recenterAnimId = null;
      }
      if (bounceAnimationTimer) {
        clearTimeout(bounceAnimationTimer);
        bounceAnimationTimer = null;
      }

      layoutKey=''; // Discard a layout result that started before this centering action.
      state.centerId = id;
      state.selectedId = id;

      const rect = els.map.getBoundingClientRect();
      const width = Math.max(rect.width, 640);
      const height = Math.max(rect.height, 520);
      const safeHeight = Math.max(360, height - bottomDockSpace());
      const centerX = width / 2;
      const centerY = safeHeight / 2;

      // 1. Snapshot start positions and camera view
      const startPositions = new Map();
      state.papers.forEach(p => {
        startPositions.set(p.id, { x: Number(p.x) || centerX, y: Number(p.y) || centerY });
      });
      const startViewX = Number(state.view.x) || 0;
      const startViewY = Number(state.view.y) || 0;

      // 2. Compute target positions using centered concentric layout
      layoutCenteredPaper(width, safeHeight, centerX, centerY);
      const targetPositions = new Map();
      state.papers.forEach(p => {
        targetPositions.set(p.id, { x: p.x, y: p.y });
      });

      // Target camera view is centered (0, 0)
      const targetViewX = 0;
      const targetViewY = 0;

      // Restore starting positions on paper objects so they start from current positions
      state.papers.forEach(p => {
        const s = startPositions.get(p.id);
        if (s) {
          p.x = s.x;
          p.y = s.y;
        }
      });

      // Set bouncing node ID for CSS animation & ripples
      bouncingNodeId = id;
      bounceAnimationTimer = setTimeout(() => {
        bouncingNodeId = null;
        els.map.querySelectorAll('.node.is-bouncing').forEach(el => el.classList.remove('is-bouncing'));
        els.map.querySelectorAll('.bounce-ripple, .bounce-ripple-2').forEach(el => el.remove());
      }, 1000);

      // Render DOM structure without altering start positions
      isRecenteringAnimation = true;
      render();

      if (!withBounce) {
        isRecenteringAnimation = false;
        return;
      }

      // 3. Elastic Spring / Bounce Animation
      const duration = 750;
      const startTime = performance.now();

      function easeOutBack(t) {
        const c1 = 1.9; // Spring overshoot factor
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }

      function animateBounce(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = progress >= 1 ? 1 : easeOutBack(progress);

        // Interpolate camera view
        state.view.x = startViewX + (targetViewX - startViewX) * ease;
        state.view.y = startViewY + (targetViewY - startViewY) * ease;
        els.map.setAttribute('viewBox', `${state.view.x.toFixed(1)} ${state.view.y.toFixed(1)} ${state.view.width} ${state.view.height}`);

        // Interpolate paper positions
        state.papers.forEach(p => {
          const start = startPositions.get(p.id);
          const target = targetPositions.get(p.id);
          if (start && target) {
            p.x = start.x + (target.x - start.x) * ease;
            p.y = start.y + (target.y - start.y) * ease;
          }
        });

        // Update DOM node translations
        els.map.querySelectorAll('.node').forEach(nodeEl => {
          const p = state.papers.find(item => item.id === nodeEl.dataset.id);
          if (p) {
            nodeEl.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
          }
        });

        // Update SVG edge line endpoints
        renderEdgesOnly();

        if (progress < 1) {
          recenterAnimId = requestAnimationFrame(animateBounce);
        } else {
          recenterAnimId = null;
          isRecenteringAnimation = false;
          // Finalize at exact target positions
          state.view.x = targetViewX;
          state.view.y = targetViewY;
          els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
          state.papers.forEach(p => {
            const target = targetPositions.get(p.id);
            if (target) {
              p.x = target.x;
              p.y = target.y;
            }
          });
          els.map.querySelectorAll('.node').forEach(nodeEl => {
            const p = state.papers.find(item => item.id === nodeEl.dataset.id);
            if (p) {
              nodeEl.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
            }
          });
          renderEdgesOnly();
          renderSelection();
          renderDetails();
        }
      }

      recenterAnimId = requestAnimationFrame(animateBounce);
      showToast(`Centered graph on "${compactTitle(paper.title)}".`);
    }

    function clearCenteredPaper() {
      if (!state.centerId) return;
      state.centerId = null;
      render();
      showToast('Centered graph cleared.');
    }

    function bindEdgeEvents() {
      els.map.querySelectorAll('.edge, .edge-hit').forEach(edge => {
        edge.addEventListener('click', event => {
          event.stopPropagation();
          selectLinkage(edge.dataset.link);
        });
        edge.addEventListener('mouseenter', () => {
          const id = edge.dataset.link;
          const vEdge = els.map.querySelector(`.edge[data-link="${id}"]`);
          if (vEdge) vEdge.classList.add('is-hovered');
        });
        edge.addEventListener('mouseleave', () => {
          const id = edge.dataset.link;
          const vEdge = els.map.querySelector(`.edge[data-link="${id}"]`);
          if (vEdge) vEdge.classList.remove('is-hovered');
        });
      });
    }

    function selectLinkage(id) {
      state.inspectorOpen = true;
      state.selectedLinkId = id;
      state.selectedId = null;
      render();
      if (els.details) {
        els.details.hidden = false;
        els.details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    function clearLinkageSelection() {
      state.selectedLinkId = null;
      render();
    }

    function selectedPapersForRecommendation() {
      const selectedLink = state.links.find(item => linkId(item) === state.selectedLinkId);
      if (selectedLink) {
        return [selectedLink.source, selectedLink.target]
          .map(id => state.papers.find(paper => paper.id === id))
          .filter(Boolean);
      }
      const selected = state.papers.find(item => item.id === state.selectedId);
      const pinned = state.papers.find(item => item.id === state.pinnedSeedId);
      return pinned ? [pinned] : (selected ? [selected] : []);
    }

    function recommendationKey(papers) {
      const steering = [
        state.recommendationSteerKeywords,
        state.recommendationExcludeKeywords,
        state.recommendationAuthors,
        state.recommendationJournals
      ].map(values => values.map(term => term.toLowerCase()).sort().join('__')).join('::');
      return [
        papers.map(paper => paper.id).sort().join('__'),
        steering,
        state.recommendationRecencyTilt,
        state.recommendationImpactTilt
      ].join('::steer:');
    }

    function parseSteerList(value, limit = 12) {
      return dedupeList(String(value || '')
        .split(/\s*(?:,|;|\n|\|)\s*/)
        .map(cleanField)
        .filter(term => term.length >= 2 && term.length <= 80))
        .slice(0, limit);
    }

    function parseSteerKeywords(value) {
      return parseSteerList(value, 12);
    }

    function dedupeList(values) {
      const seen = new Set();
      const result = [];
      values.forEach(value => {
        const key = String(value || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push(String(value).trim());
      });
      return result;
    }

    function setRecommendationSteerOpen(open) {
      state.recommendationSteerOpen = open;
      renderDetails();
    }

    function svgPoint(event) {
      const point = els.map.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      return point.matrixTransform(els.map.getScreenCTM().inverse());
    }

    function renderEdgesOnly() {
      els.map.querySelectorAll('.edge, .edge-hit').forEach(edge => {
        const source = papersById.get(edge.dataset.source);
        const target = papersById.get(edge.dataset.target);
        if (source && target) {
          edge.setAttribute('x1', source.x);
          edge.setAttribute('y1', source.y);
          edge.setAttribute('x2', target.x);
          edge.setAttribute('y2', target.y);
        }
      });
    }

    function renderSelection() {
      if(paintedSelectedLinkId!==state.selectedLinkId) {
        for(const id of new Set([paintedSelectedLinkId,state.selectedLinkId].filter(Boolean))) {
          const link=linksById.get(id);if(!link)continue;
          const selected=id===state.selectedLinkId;
          const width=(.55+link.score*3.15)*(state.graphStyle.edgeScale||.65);
          for(const edge of edgeElementsById.get(id)||[]) {
            edge.classList.toggle('is-selected',selected);
            edge.setAttribute('stroke-width',(selected?width+2.4:width).toFixed(2));
            edge.setAttribute('opacity',selected?'1':Math.min(.72,.18+link.score*.48).toFixed(2));
          }
        }
        paintedSelectedLinkId=state.selectedLinkId;
      }
      const linked=selectedLinkEndpoints();
      els.map.querySelectorAll('.node').forEach(node => {
        node.classList.toggle('is-linked',linked.has(node.dataset.id));
        node.classList.toggle('is-selected', node.dataset.id === state.selectedId);
        node.classList.toggle('is-centered', node.dataset.id === state.centerId);
      });
      els.map.querySelectorAll('.area-region').forEach(region => {
        region.classList.toggle('is-selected', region.dataset.area === state.selectedAreaId);
      });
    }

    function metadataSummary(paper) {
      const parts = [];
      const authors = paperAuthors(paper);
      if (authors.length) parts.push(authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''));
      if (paper.year || paper.date) parts.push(paper.year || paper.date);
      if (paper.journal) parts.push(paper.journal);
      if (paper.doi) parts.push(`DOI ${paper.doi}`);
      return parts.length ? parts.join(' | ') : 'Metadata not found yet. Add authors, date, journal, or DOI here.';
    }

    function keyFindings(paper) {
      if ((paper.keyFindings || []).length) return paper.keyFindings.slice(0, 5);
      const source = cleanField(`${paper.abstract || ''} ${paper.text || ''}`).slice(0, 9000);
      const sentences = source
        .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
        .map(sentence => cleanField(sentence))
        .filter(sentence => sentence.length >= 45 && sentence.length <= 360)
        .filter(sentence => !/^(abstract|introduction|references|keywords?)\b/i.test(sentence));
      const signals = [
        /\b(result|results|finding|findings|found|show|shows|showed|demonstrate|demonstrates|reveals?|suggests?)\b/i,
        /\b(conclude|concludes|conclusion|indicate|indicates|evidence|associated|improves?|reduces?|increases?)\b/i,
        /\b(significant|novel|important|key|major|robust|effective|efficient|higher|lower)\b/i,
        /\b(we|this study|this paper|our)\b/i
      ];
      const scored = sentences.map((sentence, index) => ({
        sentence,
        score: signals.reduce((score, pattern) => score + (pattern.test(sentence) ? 1 : 0), 0) + (index < 3 ? 0.4 : 0)
      }));
      const findings = scored
        .filter(item => item.score >= 1.4)
        .sort((a, b) => b.score - a.score)
        .map(item => item.sentence)
        .slice(0, 3);
      if (findings.length) return findings;
      if (paper.abstract) return [cleanField(paper.abstract).slice(0, 260)];
      return mergedKeywords(paper).length ? [`Themes: ${mergedKeywords(paper).slice(0, 6).join(', ')}.`] : [];
    }

    function evidenceSummary(paper) {
      const bits = [];
      if (paper.metadataSource) bits.push(paper.metadataSource);
      if ((paper.referenceIds || []).length) bits.push(`${paper.referenceIds.length} refs`);
      if ((paper.citedByIds || []).length) bits.push(`${paper.citedByIds.length} citing samples`);
      if (paper.citedByCount) bits.push(`${paper.citedByCount} citations`);
      if ((paper.text || '').length) bits.push(`${Math.round((paper.text || '').length / 100) / 10}k chars`);
      return bits.join(' | ') || 'Metadata only';
    }

    function renderLinkages() {
      if (!els.linkageList) return;
      const sorted = [...state.links].sort((a, b) => b.score - a.score).slice(0,2500);
      els.linkageSummary.textContent = sorted.length
        ? `${sorted.length} link${sorted.length === 1 ? '' : 's'} at ${Math.round(state.threshold * 100)}% threshold.`
        : (state.papers.length < 2 ? 'Add at least two papers to create links.' : 'No links above the current threshold.');

      els.linkageList.innerHTML = sorted.length ? sorted.map(link => {
        const source = papersById.get(link.source);
        const target = papersById.get(link.target);
        const id = linkId(link);
        const selected = state.selectedLinkId === id ? ' is-selected' : '';
        const sharedTerms = sharedKeywords(source, target).slice(0, 5);
        return `<button class="linkage-item${selected}" data-link="${id}" type="button">
          <span class="linkage-score">${escapeHtml(linkTypeName(link))} · ${Math.round(link.score * 100)}%</span>
          <span class="linkage-title">${escapeHtml(source.title)} ↔ ${escapeHtml(target.title)}</span>
          <span class="linkage-meta">${escapeHtml(link.evidence || (sharedTerms.length ? `Shared terms: ${sharedTerms.join(', ')}` : 'Related through document text and metadata.'))}</span>
        </button>`;
      }).join('') : '<div class="settings-status">No linkages selected. Load papers or lower the similarity threshold to reveal weaker relationships.</div>';

      els.linkageList.querySelectorAll('[data-link]').forEach(button => {
        button.addEventListener('click', () => selectLinkage(button.dataset.link));
      });
    }

    function renderAreasPanel() {
      if (!els.areaList) return;
      els.areaList.innerHTML = state.areas.length ? state.areas.map(area => {
        const count = state.papers.filter(paper => paper.areaId === area.id).length;
        const selected = state.selectedAreaId === area.id ? ' is-selected' : '';
        return `<div class="area-row${selected}" data-area="${area.id}">
          <input type="color" value="${escapeHtml(area.color)}" data-area-field="color" aria-label="Area color">
          <input type="text" value="${escapeHtml(area.name)}" data-area-field="name" aria-label="Area name">
          <button class="icon-button danger" type="button" data-action="remove-area" aria-label="Remove area">×</button>
          <div class="metadata-line">${count} paper${count === 1 ? '' : 's'} inside. Drag the map region to move its papers, or drag the corner handle to resize.</div>
          <div class="area-size-presets" aria-label="Area size presets">
            <button type="button" data-area-preset="small">Small</button>
            <button type="button" data-area-preset="medium">Medium</button>
            <button type="button" data-area-preset="wide">Wide</button>
          </div>
          <div class="area-size-row">
            <label>Width
              <input type="number" min="160" max="1200" step="10" value="${Math.round(area.width)}" data-area-size="width">
            </label>
            <label>Height
              <input type="number" min="110" max="1200" step="10" value="${Math.round(area.height)}" data-area-size="height">
            </label>
          </div>
        </div>`;
      }).join('') : '<div class="settings-status">No areas yet. Press + Area to create a named region on the map.</div>';

      els.areaList.querySelectorAll('.area-row').forEach(row => {
        row.addEventListener('click', event => {
          if (event.target.closest('button, input')) return;
          state.selectedAreaId = row.dataset.area;
          renderSelection();
          renderAreasPanel();
        });
      });

      els.areaList.querySelectorAll('[data-area-field]').forEach(input => {
        input.addEventListener('input', event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          area[event.target.dataset.areaField] = event.target.value;
          state.selectedAreaId = area.id;
        });
        input.addEventListener('change', () => render());
      });
      els.areaList.querySelectorAll('[data-area-size]').forEach(input => {
        const updateSize = event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          resizeArea(area, event.target.dataset.areaSize, event.target.value);
          state.selectedAreaId = area.id;
          render();
        };
        input.addEventListener('input', updateSize);
        input.addEventListener('change', updateSize);
      });
      els.areaList.querySelectorAll('[data-area-preset]').forEach(button => {
        button.addEventListener('click', event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          const preset = event.target.dataset.areaPreset;
          const sizes = {
            small: [220, 150],
            medium: [320, 220],
            wide: [460, 240]
          };
          const [width, height] = sizes[preset] || sizes.medium;
          setAreaSize(area, width, height);
          state.selectedAreaId = area.id;
          render();
        });
      });
      els.areaList.querySelectorAll('[data-action="remove-area"]').forEach(button => {
        button.addEventListener('click', event => removeArea(event.target.closest('[data-area]').dataset.area));
      });
    }

    function sharedKeywords(source, target) {
      if (!source || !target) return [];
      const left = new Set(mergedKeywords(source).map(term => term.toLowerCase()));
      return mergedKeywords(target).filter(term => left.has(term.toLowerCase()));
    }

    function linkTypeName(link) {
      const labels = {
        citation: 'Direct citation',
        bibliographic: 'Bibliographic coupling',
        cocitation: 'Co-citation',
        mixed: 'Mixed literature link',
        similarity: 'Text similarity'
      };
      return labels[link?.type || 'similarity'] || 'Link';
    }

    function linkLabel(link) {
      const score = `${Math.round((link.score || 0) * 100)}%`;
      return `${linkTypeName(link)} (${score}). ${link.evidence || 'Related through title, abstract, keywords, or metadata.'}`;
    }

    function paperMatchScore(paper) {
      const strongest = state.links
        .filter(link => link.source === paper.id || link.target === paper.id)
        .reduce((best, link) => Math.max(best, Number(link.score || 0)), 0);
      return Math.max(0, Math.min(99, Math.round(strongest * 100)));
    }

    function paperStudyType(paper) {
      const text = `${paper.title || ''} ${paper.abstract || ''} ${(paper.paperKeywords || []).join(' ')}`.toLowerCase();
      if (/\breview|systematic review|meta-analysis\b/.test(text)) return 'Review';
      if (/\btrial|randomi[sz]ed|cohort|case-control|participant|patients?\b/.test(text)) return 'Clinical study';
      if (/\bexperiment|assay|culture|sequenc|rna-seq|transcriptomic|proteomic|genomic\b/.test(text)) return 'Experimental study';
      if (/\bmodel|algorithm|embedding|transformer|network|machine learning\b/.test(text)) return 'Computational study';
      return 'Research article';
    }

    function paperDomainLabel(paper) {
      const keywords = mergedKeywords(paper).join(' ').toLowerCase();
      const title = `${paper.title || ''} ${paper.journal || ''}`.toLowerCase();
      if (/\btranscript|rna|gene expression|sequenc|genomic\b/.test(`${keywords} ${title}`)) return 'Transcriptomics';
      if (/\bmicrobi|bacteria|campylobacter|biofilm|infection|immune\b/.test(`${keywords} ${title}`)) return 'Microbiology';
      if (/\bmachine learning|embedding|graph|network|transformer|retrieval\b/.test(`${keywords} ${title}`)) return 'AI literature discovery';
      if (/\bclinical|patient|therapy|therapeutic|disease\b/.test(`${keywords} ${title}`)) return 'Clinical biology';
      return 'Literature mapping';
    }

    function paperAuthorSummary(paper) {
      const authors = paperAuthors(paper);
      if (!authors.length) return 'Unknown authors';
      return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ` +${authors.length - 3}` : '');
    }

    function renderPapers() {
      const areaOptions = paper => [
        `<option value="">No area</option>`,
        ...state.areas.map(area => `<option value="${area.id}" ${paper.areaId === area.id ? 'selected' : ''}>${escapeHtml(area.name)}</option>`)
      ].join('');
      const paperMetaChips = paper => {
        const keywords = mergedKeywords(paper).slice(0, 3);
        const extra = Math.max(0, mergedKeywords(paper).length - keywords.length);
        const chips = [
          ...keywords.map((value, idx) => ({ value, action: 'paper-keyword', title: `Keyword #${idx + 1}: ${value}` })),
          ...(extra ? [{ value: `+${extra}`, action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }] : [{ value: '🏷️ tags', action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }])
        ];
        return chips.map(item => `<button class="compact-chip${item.action === 'open-paper-keywords' ? ' tag-edit-chip' : ''}" type="button" data-action="${item.action}" data-keyword="${escapeHtml(item.value)}" data-paper="${paper.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.value)}</button>`).join('');
      };
      const clusterByPaper = new Map();
      state.clusters.forEach((cluster, index) => cluster.forEach(id => clusterByPaper.set(id, index)));
      const paperOrganizeMarkup = paper => `
        <div class="paper-organize">
          <label class="paper-control paper-color" title="Node colour">
            <input type="color" value="${escapeHtml(paper.color || paperColor(paper, clusterByPaper))}" data-field="color" aria-label="Node colour">
          </label>
          <label class="paper-control paper-area" title="Map area">
            <select data-field="areaId" aria-label="Map area">${areaOptions(paper)}</select>
          </label>
          <div class="paper-actions-row">
            <button class="icon-button" title="Focus paper on graph" aria-label="Focus paper on graph" data-action="focus" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></button>
            <button class="icon-button danger" title="Remove paper" aria-label="Remove paper" data-action="remove" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg></button>
          </div>
        </div>
      `;
      const paperHeaderMarkup = paper => {
        const match = paperMatchScore(paper);
        const publication = [paper.journal, paper.year || paper.date].filter(Boolean).join(' · ');
        return `
          <div class="paper-card-top">
            <span class="paper-swatch" style="background:${escapeHtml(paperColor(paper, clusterByPaper))}"></span>
            <span class="paper-publication">${escapeHtml(publication || paperDomainLabel(paper))}</span>
            ${match ? `<span class="paper-badge match" title="Strongest link to another paper">${match}%</span>` : ''}
          </div>
        `;
      };
      const paperFactsMarkup = paper => {
        const authorCount = paperAuthors(paper).length;
        const facts = [
          paperStudyType(paper),
          `${authorCount || 'No'} author${authorCount === 1 ? '' : 's'}`,
          paper.citedByCount ? `${paper.citedByCount} citations` : ''
        ].filter(Boolean);
        return `<div class="paper-facts">${facts.map(fact => `<span class="paper-fact">${escapeHtml(fact)}</span>`).join('')}</div>`;
      };
      const renderCompactPaper = paper => `
        <article class="pulse-paper-card${state.selectedId === paper.id ? ' is-selected' : ''}" data-paper="${paper.id}">
          <input type="checkbox" class="paper-chk" ${paper.selected !== false ? 'checked' : ''} data-action="toggle-paper-active" title="Toggle paper on map">
          <div class="pulse-paper-card-body">
            <div class="pulse-paper-title">${escapeHtml(paper.title || 'Untitled paper')}</div>
            <div class="pulse-paper-meta">
              <span>${escapeHtml(paperAuthorSummary(paper))}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${paper.journal ? `<span class="pulse-paper-journal">· ${escapeHtml(paper.journal.length > 22 ? paper.journal.slice(0, 20) + '...' : paper.journal)}</span>` : ''}
            </div>
          </div>
        </article>
      `;
      const renderExpandedPaper = paper => `
        <article class="paper-card${state.selectedId === paper.id ? ' is-selected' : ''}" data-paper="${paper.id}">
          ${paperHeaderMarkup(paper)}
          <div class="paper-title">${escapeHtml(paper.title || 'Untitled paper')}</div>
          <div class="paper-authors">${escapeHtml(paperAuthorSummary(paper))}</div>
          <div class="compact-meta">${paperMetaChips(paper)}</div>
          ${paperFactsMarkup(paper)}
          ${paper.metadataSource || paper.metadataNote ? `<div class="metadata-line">${escapeHtml(paper.metadataSource ? `Metadata filled from ${paper.metadataSource}.` : paper.metadataNote)}</div>` : ''}
          <div class="paper-edit-grid">
            <label>
              Title
              <input value="${escapeHtml(paper.title)}" data-field="title">
            </label>
            <div class="metadata-grid">
              <label>
                Authors
                <input value="${escapeHtml(paperAuthors(paper).join('; '))}" data-field="authors">
              </label>
              <label>
                Date
                <input value="${escapeHtml(paper.date || paper.year || '')}" data-field="date">
              </label>
              <label>
                Journal
                <input value="${escapeHtml(paper.journal || '')}" data-field="journal">
              </label>
              <label>
                DOI
                <input value="${escapeHtml(paper.doi || '')}" data-field="doi">
              </label>
            </div>
            <label>
              Abstract
              <textarea data-field="abstract">${escapeHtml(paper.abstract || '')}</textarea>
            </label>
            <label>
              <div class="terms-header-row">
                <span>Keywords</span>
                <button class="button small secondary tag-edit-chip" type="button" data-action="open-paper-keywords" data-paper="${paper.id}">🏷️ Manage tags</button>
              </div>
              <input value="${escapeHtml((paper.paperKeywords || []).join('; '))}" data-field="paperKeywords">
            </label>
          </div>
          ${paperOrganizeMarkup(paper)}
        </article>
      `;
      const hasFilter = Boolean(state.librarySearch || (state.filterTags && state.filterTags.length > 0));
      const displayPapers = state.papers.filter(paperMatchesFilters);

      if (els.paperCount) {
        els.paperCount.textContent = hasFilter
          ? `Showing ${displayPapers.length} of ${state.papers.length} (filtered)`
          : `${state.papers.length} paper${state.papers.length === 1 ? '' : 's'}`;
      }
      if (els.railLibraryBadge) {
        els.railLibraryBadge.textContent = state.papers.length;
      }

      if (!displayPapers.length) {
        els.paperList.innerHTML = hasFilter
          ? `<div class="empty-filter-state" style="padding: 24px 16px; text-align: center; color: var(--muted);">
              <p style="margin: 0 0 10px 0; font-size: 13px;">No papers match the active tag filter${state.filterTags.length > 1 ? 's' : ''}.</p>
              <button class="button small secondary" data-action="clear-filters-from-list" type="button">Clear tag filters</button>
            </div>`
          : '<div class="empty-filter-state" style="padding: 24px 16px; text-align: center; color: var(--muted); font-size: 13px;">No papers in library yet.</div>';

        els.paperList.querySelector('[data-action="clear-filters-from-list"]')?.addEventListener('click', clearFilterTags);
      } else {
        els.paperList.innerHTML = displayPapers.map(paper => (
          state.paperView === 'compact' ? renderCompactPaper(paper) : renderExpandedPaper(paper)
        )).join('');
      }

      els.paperList.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('change', event => {
          const card = event.target.closest('[data-paper]');
          const paper = state.papers.find(item => item.id === card.dataset.paper);
          if (event.target.dataset.field === 'paperKeywords') {
            paper.paperKeywords = splitKeywords(event.target.value);
          } else if (event.target.dataset.field === 'authors') {
            paper.authors = splitAuthors(event.target.value);
          } else if (event.target.dataset.field === 'date') {
            paper.date = event.target.value;
            paper.year = (event.target.value.match(/\b(19|20)\d{2}\b/) || [''])[0];
          } else if (event.target.dataset.field === 'doi') {
            paper.doi = normalizeDoi(event.target.value) || event.target.value.trim();
            enrichPaperFromDoi(paper).then(() => render());
            return;
          } else if (event.target.dataset.field === 'areaId') {
            paper.areaId = event.target.value;
          } else if (event.target.dataset.field === 'color') {
            paper.color = event.target.value;
          } else {
            paper[event.target.dataset.field] = event.target.value;
          }
          render();
        });
      });

      els.paperList.querySelectorAll('[data-action="remove"]').forEach(button => {
        button.addEventListener('click', event => {
          const id = event.target.closest('[data-paper]').dataset.paper;
          state.papers = state.papers.filter(paper => paper.id !== id);
          if (state.selectedId === id) state.selectedId = null;
          if (state.selectedLinkId?.includes(id)) state.selectedLinkId = null;
          if (state.centerId === id) state.centerId = null;
          render();
        });
      });

      els.paperList.querySelectorAll('[data-action="focus"]').forEach(button => {
        button.addEventListener('click', event => {
          state.selectedId = event.target.closest('[data-paper]').dataset.paper;
          renderDetails();
          renderSelection();
        });
      });

      els.paperList.querySelectorAll('[data-action="paper-keyword"]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const term = cleanField(event.currentTarget.dataset.keyword || '');
          const card = event.currentTarget.closest('[data-paper]');
          const paper = state.papers.find(item => item.id === card?.dataset.paper);
          if (!term) return;
          if (paper) state.selectedId = paper.id;
          openTagActionMenu(term, event.currentTarget, paper?.id);
        });
      });

      els.paperList.querySelectorAll('[data-action="show-all-keywords"], [data-action="open-paper-keywords"]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const card = event.currentTarget.closest('[data-paper]');
          const paperId = button.dataset.paper || card?.dataset.paper;
          if (paperId) openKeywordModal(paperId);
        });
      });

      els.paperList.querySelectorAll('.pulse-paper-card, .paper-card').forEach(card => {
        card.addEventListener('click', event => {
          if (event.target.closest('button, input, select, textarea, .compact-chip')) return;
          state.selectedId = card.dataset.paper;
          renderSelection();
          renderDetails();
        });
      });

      els.paperList.querySelectorAll('[data-action="toggle-paper-active"]').forEach(chk => {
        chk.addEventListener('change', event => {
          event.stopPropagation();
          const card = event.target.closest('[data-paper]');
          const paper = state.papers.find(p => p.id === card?.dataset.paper);
          if (paper) {
            paper.selected = event.target.checked;
            render();
          }
        });
      });
    }

    function connectionStrengthLabel(score) {
      if (score >= 0.85) return 'Very Strong Connection';
      if (score >= 0.65) return 'Strong Connection';
      if (score >= 0.45) return 'Moderate Relationship';
      return 'Emerging / Weak Connection';
    }

    function focusPairOnMap(source, target) {
      if (!source || !target) return;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const dist = Math.max(80, Math.hypot(source.x - target.x, source.y - target.y));
      const targetWidth = Math.max(380, Math.min(1800, dist * 2.8));
      const targetHeight = targetWidth * 0.75;
      state.view.width = targetWidth;
      state.view.height = targetHeight;
      state.view.x = midX - targetWidth / 2;
      state.view.y = midY - targetHeight / 2;
      render();
      showToast(`Focused on ${compactTitle(source.title)} ↔ ${compactTitle(target.title)}.`);
    }

    function renderLinkageDetails() {
      const link = state.links.find(item => linkId(item) === state.selectedLinkId);
      if (!link) {
        state.selectedLinkId = null;
        els.details.hidden = true;
        return;
      }
      const source = state.papers.find(item => item.id === link.source);
      const target = state.papers.find(item => item.id === link.target);
      if (!source || !target) {
        state.selectedLinkId = null;
        els.details.hidden = true;
        return;
      }

      const scorePct = Math.round(link.score * 100);
      const sharedKws = sharedKeywords(source, target);
      const sourceOrgs = (source.organisms || []).map(o => o.trim());
      const targetOrgs = (target.organisms || []).map(o => o.trim());
      const sharedOrgs = dedupeList(sourceOrgs.filter(so => targetOrgs.some(to => to.toLowerCase() === so.toLowerCase())));

      const sourceTechs = (source.techniques || []).map(t => t.trim());
      const targetTechs = (target.techniques || []).map(t => t.trim());
      const sharedTechs = dedupeList(sourceTechs.filter(st => targetTechs.some(tt => tt.toLowerCase() === st.toLowerCase())));

      const sourceAlex = normalizeOpenAlexId(source.openAlexId || source.openAlexUrl || '');
      const targetAlex = normalizeOpenAlexId(target.openAlexId || target.openAlexUrl || '');
      const sourceCitesTarget = targetAlex && (source.referenceIds || []).some(id => normalizeOpenAlexId(id) === targetAlex);
      const targetCitesSource = sourceAlex && (target.referenceIds || []).some(id => normalizeOpenAlexId(id) === sourceAlex);
      const sharedRefs = intersectIds(source.referenceIds, target.referenceIds);
      const sharedCiters = intersectIds(source.citedByIds, target.citedByIds);

      const citationFacts = [];
      if (sourceCitesTarget) {
        citationFacts.push(`<strong>${escapeHtml(compactTitle(source.title))}</strong> directly cites <strong>${escapeHtml(compactTitle(target.title))}</strong>.`);
      }
      if (targetCitesSource) {
        citationFacts.push(`<strong>${escapeHtml(compactTitle(target.title))}</strong> directly cites <strong>${escapeHtml(compactTitle(source.title))}</strong>.`);
      }
      if (sharedRefs.length > 0) {
        citationFacts.push(`Share <strong>${sharedRefs.length}</strong> common referenced paper${sharedRefs.length === 1 ? '' : 's'} in their bibliographies.`);
      }
      if (sharedCiters.length > 0) {
        citationFacts.push(`Co-cited together by <strong>${sharedCiters.length}</strong> external literature paper${sharedCiters.length === 1 ? '' : 's'}.`);
      }
      if (!citationFacts.length) {
        citationFacts.push('Connected through semantic embedding and full-text keyword proximity in the literature map.');
      }

      els.details.hidden = false;
      els.details.innerHTML = `
        <div class="linkage-details-card">
          <div class="details-header linkage-details-header">
            <div class="linkage-header-title">
              <span class="link-type-badge ${escapeHtml(link.type || 'similarity')}">${escapeHtml(linkTypeName(link))}</span>
              <h2>Paper Similarities</h2>
            </div>
            <button class="ai-close" data-action="close-linkage" type="button" aria-label="Close paper similarities">×</button>
          </div>

          <div class="linkage-score-banner">
            <div class="score-dial">
              <span class="score-dial-number">${scorePct}%</span>
              <span class="score-dial-label">Match</span>
            </div>
            <div class="score-dial-meta">
              <strong>${escapeHtml(connectionStrengthLabel(link.score))}</strong>
              <p class="subtle">${escapeHtml(link.evidence || 'Strong semantic and literature relationship.')}</p>
            </div>
          </div>

          <div class="linkage-pair-nodes">
            <div class="linkage-node-card">
              <span class="linkage-node-role">Paper 1</span>
              <h3 class="linkage-node-title">${escapeHtml(source.title)}</h3>
              <p class="metadata-line">${escapeHtml(metadataSummary(source))}</p>
              <button class="button small secondary" type="button" data-action="inspect-paper" data-paper="${source.id}">Inspect Paper 1</button>
            </div>

            <div class="linkage-connector-icon" aria-hidden="true">↔</div>

            <div class="linkage-node-card">
              <span class="linkage-node-role">Paper 2</span>
              <h3 class="linkage-node-title">${escapeHtml(target.title)}</h3>
              <p class="metadata-line">${escapeHtml(metadataSummary(target))}</p>
              <button class="button small secondary" type="button" data-action="inspect-paper" data-paper="${target.id}">Inspect Paper 2</button>
            </div>
          </div>

          <div class="linkage-breakdown-section">
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🏷️</span>
                <strong>Shared Keywords &amp; Themes</strong>
                <span class="badge-count">${sharedKws.length}</span>
              </div>
              <div class="terms">
                ${sharedKws.length
                  ? sharedKws.map(term => `<button class="term shared-term-btn" type="button" data-action="steer-shared-term" data-term="${escapeHtml(term)}" title="Click to steer recommendations toward &quot;${escapeHtml(term)}&quot;">${escapeHtml(term)}</button>`).join('')
                  : '<span class="subtle">No exact keyword overlap. Related via document body text and abstract semantics.</span>'}
              </div>
            </div>

            ${sharedOrgs.length ? `
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🧬</span>
                <strong>Shared Organisms &amp; Models</strong>
                <span class="badge-count">${sharedOrgs.length}</span>
              </div>
              <div class="terms">
                ${sharedOrgs.map(org => `<span class="term org-term">${escapeHtml(org)}</span>`).join('')}
              </div>
            </div>` : ''}

            ${sharedTechs.length ? `
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🔬</span>
                <strong>Shared Techniques &amp; Assays</strong>
                <span class="badge-count">${sharedTechs.length}</span>
              </div>
              <div class="terms">
                ${sharedTechs.map(tech => `<span class="term tech-term">${escapeHtml(tech)}</span>`).join('')}
              </div>
            </div>` : ''}

            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🔗</span>
                <strong>Citation &amp; Bibliographic Overlap</strong>
              </div>
              <ul class="similarity-fact-list">
                ${citationFacts.map(fact => `<li>${fact}</li>`).join('')}
              </ul>
            </div>
          </div>

          <div class="details-actions">
            <button class="button primary" data-action="recommend-pair" type="button">
              Find papers connecting both
            </button>
            <div class="recommend-steer-grid">
              <button class="button" data-action="focus-pair" type="button">Focus pair on map</button>
              <button class="button" data-action="deselect-linkage" type="button">Deselect linkage</button>
            </div>
          </div>
        </div>
      `;

      els.details.querySelector('[data-action="close-linkage"]')?.addEventListener('click', clearLinkageSelection);
      els.details.querySelector('[data-action="deselect-linkage"]')?.addEventListener('click', clearLinkageSelection);
      els.details.querySelector('[data-action="focus-pair"]')?.addEventListener('click', () => focusPairOnMap(source, target));
      els.details.querySelector('[data-action="recommend-pair"]')?.addEventListener('click', recommendSelectedPapers);

      els.details.querySelectorAll('[data-action="inspect-paper"]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.selectedId = btn.dataset.paper;
          state.selectedLinkId = null;
          render();
        });
      });

      els.details.querySelectorAll('[data-action="steer-shared-term"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const term = cleanField(btn.dataset.term || '');
          if (!term) return;
          state.recommendationSteerKeywords = dedupeList([term, ...state.recommendationSteerKeywords]).slice(0, 12);
          state.graphSteerKeywords = dedupeList([term, ...state.graphSteerKeywords]).slice(0, 12);
          showToast(`Steering recommendations toward "${term}".`);
          recommendSelectedPapers();
        });
      });
    }

    function renderDetails() {
      if (!state.inspectorOpen || state.workspaceView === 'discover') {
        els.details.hidden = true;
        return;
      }
      if (state.selectedLinkId) {
        renderLinkageDetails();
        return;
      }

      let paper = state.papers.find(item => item.id === state.selectedId);
      if (!paper && state.papers.length > 0) {
        paper = state.papers[0];
        state.selectedId = paper.id;
      }
      if (!paper) {
        els.details.hidden = false;
        els.details.innerHTML = `
          <div class="inspector-placeholder">
            <div class="inspector-placeholder-icon">📄</div>
            <h3>Paper Inspector</h3>
            <p>Select any paper from the library or click a node on the map to inspect relevance scores, citation metrics, and foundational evidence.</p>
          </div>
        `;
        return;
      }

      const related = state.links
        .filter(link => link.source === paper.id || link.target === paper.id)
        .map(link => ({
          score: link.score,
          type: link.type,
          paper: state.papers.find(item => item.id === (link.source === paper.id ? link.target : link.source))
        }))
        .filter(item => item.paper)
        .sort((a, b) => b.score - a.score);
      const recommendationSeeds = selectedPapersForRecommendation();
      const recKey = recommendationKey(recommendationSeeds);
      const recommendations = state.recommendations.get(recKey) || [];
      const isLoadingRecommendations = state.recommendationLoadingKey === recKey;
      const steerText = state.recommendationSteerKeywords.join('; ');
      const excludeText = state.recommendationExcludeKeywords.join('; ');
      const authorText = state.recommendationAuthors.join('; ');
      const journalText = state.recommendationJournals.join('; ');
      const graphText = state.graphSteerKeywords.join('; ');
      const activeSteerChips = [
        ...state.recommendationSteerKeywords.map(t => renderMiniSteerChip(t, 'steer', '🎯 ')),
        ...state.graphSteerKeywords.map(t => renderMiniSteerChip(t, 'graph', '🌐 ')),
        ...state.recommendationExcludeKeywords.map(t => renderMiniSteerChip(t, 'exclude', '⛔ ')),
      ].join('');

      const rawAbstract = (paper.abstract || paper.text || '').trim();
      const isAbstractLong = rawAbstract.length > 300;
      const displayAbstract = (isAbstractLong && !state.detailsAbstractExpanded)
        ? rawAbstract.slice(0, 297) + '...'
        : rawAbstract;

      // 1. Relevance scores
      const strongestLink = related[0]?.score || 0;
      const semScore = Math.round(Math.max(0, ...related.map(r => cosine(state.vectors.get(paper.id), state.vectors.get(r.paper.id)))) * 100);
      const citScore = Math.round(Math.max(0, ...related.filter(r => r.type === 'citation').map(r => r.score)) * 100);
      const cocScore = Math.round(Math.max(0, ...related.filter(r => r.type === 'cocitation').map(r => r.score)) * 100);
      const concepts = new Set(mergedKeywords(paper).map(term => term.toLowerCase()));
      const conScore = Math.round(Math.max(0, ...related.map(r => {
        const other = new Set(mergedKeywords(r.paper).map(term => term.toLowerCase()));
        const common = [...concepts].filter(term => other.has(term)).length;
        return common / Math.max(1, new Set([...concepts, ...other]).size);
      })) * 100);

      // 2. Metrics (4-box row)
      const metricCitations = paper.citedByCount ? String(paper.citedByCount) : '—';
      const metricReferences = paper.referenceIds?.length ? String(paper.referenceIds.length) : (paper.references?.length ? String(paper.references.length) : '—');
      const metricInfluential = Number.isFinite(paper.influentialCitationCount) ? String(paper.influentialCitationCount) : '—';
      const yearNum = parseInt(paper.year || (String(paper.date || '').match(/\b(19|20)\d{2}\b/) || [''])[0]);
      const yearsActive = yearNum ? Math.max(1, new Date().getFullYear() - yearNum) : 1;
      const metricVelocity = (paper.citedByCount && yearNum) ? (paper.citedByCount / yearsActive).toFixed(1) : '—';

      // 3. Key concepts
      const topConcepts = mergedKeywords(paper).slice(0, 8);

      // 4. Why this paper evidence
      const whyList = [];
      if (related.length) {
        whyList.push({ icon: '🔗', text: `Strong linkage with <strong>${escapeHtml(compactTitle(related[0].paper.title))}</strong> (${Math.round(related[0].score * 100)}% match)` });
      }
      if (paper.citedByCount && paper.citedByCount > 50) {
        whyList.push({ icon: '⭐', text: `Cornerstone publication with <strong>${paper.citedByCount}</strong> verified citations` });
      }
      if (topConcepts.length) {
        whyList.push({ icon: '🎯', text: `Shares key concepts: <em>${escapeHtml(topConcepts.slice(0, 3).join(', '))}</em>` });
      }

      els.details.hidden = false;
      els.details.innerHTML = `
        <div class="inspector-card-header">
          <div class="inspector-title-area">
            <h2 class="inspector-title">${escapeHtml(paper.title || 'Untitled paper')}</h2>
            <div class="inspector-authors-line">
              <span>${escapeHtml(paperAuthors(paper).slice(0, 3).join(', '))}${paperAuthors(paper).length > 3 ? ' et al.' : ''}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${paper.journal ? `<span class="inspector-journal">· ${escapeHtml(paper.journal)}</span>` : ''}
            </div>
          </div>
          <button class="ai-close details-close-btn" data-action="close-details" type="button" title="Close inspector" aria-label="Close inspector">×</button>
        </div>

        <div class="inspector-quick-actions">
          ${paper.doi ? `
            <a class="inspector-btn primary" href="https://doi.org/${escapeHtml(paper.doi)}" target="_blank" rel="noreferrer">
              <span>Open paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          ` : `
            <a class="inspector-btn primary" href="https://scholar.google.com/scholar?q=${encodeURIComponent(paper.title)}" target="_blank" rel="noreferrer">
              <span>Find paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          `}
          <button class="inspector-btn secondary" type="button" data-action="toggle-paper-seed">
            <span>${state.pinnedSeedId === paper.id ? 'Core seed ⭐' : 'Use as seed'}</span>
          </button>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Link evidence in your map</div>
          <div class="relevance-bars-list">
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Text similarity</span>
              <div class="relevance-track"><div class="relevance-fill fill-sem" style="width:${semScore}%"></div></div>
              <span class="relevance-score">${semScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Citation proximity</span>
              <div class="relevance-track"><div class="relevance-fill fill-cit" style="width:${citScore}%"></div></div>
              <span class="relevance-score">${citScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Co-citation strength</span>
              <div class="relevance-track"><div class="relevance-fill fill-coc" style="width:${cocScore}%"></div></div>
              <span class="relevance-score">${cocScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Concept overlap</span>
              <div class="relevance-track"><div class="relevance-fill fill-con" style="width:${conScore}%"></div></div>
              <span class="relevance-score">${conScore}%</span>
            </div>
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>Key concepts</span>
            <button class="button small secondary tag-edit-chip" data-action="open-paper-keywords" data-paper="${paper.id}" type="button">Manage tags</button>
          </div>
          <div class="concept-chips-wrap">
            ${topConcepts.map((term, i) => `
              <button class="concept-chip" data-action="tag-action-menu" data-term="${escapeHtml(term)}" type="button" title="Click for tag options">
                <span style="opacity:0.6; margin-right:3px;">#${i + 1}</span>
                ${escapeHtml(term)}
              </button>
            `).join('')}
            ${!topConcepts.length ? '<span class="subtle" style="font-size:11px;">No concept tags extracted yet.</span>' : ''}
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Citation metrics</div>
          <div class="metrics-quad-grid">
            <div class="metric-quad-box">
              <div class="metric-quad-label">Citations</div>
              <div class="metric-quad-val">${escapeHtml(metricCitations)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">References</div>
              <div class="metric-quad-val">${escapeHtml(metricReferences)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">Influential</div>
              <div class="metric-quad-val">${escapeHtml(metricInfluential)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">Rate / yr</div>
              <div class="metric-quad-val">${escapeHtml(metricVelocity)}</div>
            </div>
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Why this paper?</div>
          <div class="why-paper-list">
            ${whyList.map(item => `
              <div class="why-paper-item">
                <span class="why-paper-icon">${item.icon}</span>
                <span>${item.text}</span>
              </div>
            `).join('')}
          </div>
        </div>

        ${rawAbstract ? `
          <div class="inspector-section">
            <div class="inspector-section-title">Abstract</div>
            <p class="details-abstract-text" style="font-size:11px; line-height:1.45; color:var(--ink-2);">${escapeHtml(displayAbstract)}</p>
            ${isAbstractLong ? `<button class="details-abstract-toggle" data-action="toggle-abstract" type="button" style="margin-top:4px;">${state.detailsAbstractExpanded ? 'Show less' : 'Read full text'}</button>` : ''}
          </div>
        ` : ''}

        <div class="inspector-section">
          <div class="inspector-section-title">Connected in workspace (${related.length})</div>
          <div class="related-list">
            ${related.length ? related.map(item => `
              <div class="related-item clickable-linkage" data-action="view-related-link" data-link="${linkId({ source: paper.id, target: item.paper.id })}" role="button" tabindex="0" title="Click to view linkage">
                <div class="score">${Math.round(item.score * 100)}%</div>
                <div class="related-title">${escapeHtml(item.paper.title)}</div>
              </div>
            `).join('') : '<p class="subtle" style="font-size:11px;">No links above threshold.</p>'}
          </div>
        </div>

        <div class="discovery-hub" style="margin-top:12px;">
          <div class="discovery-hub-head">
            <div>
              <span class="discovery-hub-tag">S2AG Exploration</span>
              <h3>Literature Discovery</h3>
            </div>
            <button class="button small primary discovery-run-btn" data-action="run-discovery-pipeline" type="button" ${state.discoveryLoading ? 'disabled' : ''}>
              ${state.discoveryLoading ? '⏳ Discovering...' : '⚡ Discover Related'}
            </button>
          </div>

          <div class="quick-tools-row">
            <button class="qtool-btn" data-action="snowball-backward" type="button" title="Fetch references cited by this paper" ${state.citationLoading ? 'disabled' : ''}>← Refs</button>
            <button class="qtool-btn" data-action="snowball-forward" type="button" title="Fetch papers citing this work" ${state.citationLoading ? 'disabled' : ''}>Cites →</button>
            <button class="qtool-btn" data-action="chase-2hop" type="button" title="Iterative 2-Hop Chase" ${state.citationLoading ? 'disabled' : ''}>2-Hop ⟳</button>
            <button class="qtool-btn" data-action="network-triangulate" type="button" title="Co-citation & Bibliographic Coupling" ${state.citationLoading ? 'disabled' : ''}>Co-cite ⋈</button>
            <button class="qtool-btn" data-action="find-seminal" type="button" title="Foundational seminal papers" ${state.citationLoading ? 'disabled' : ''}>Seminal ⭐</button>
          </div>

          ${state.discoveryResults?.length ? `
            <button class="discovery-view-results-btn" data-action="open-discovery-results-modal" type="button">
              🔍 View Discovered Papers (${state.discoveryResults.length})
            </button>
          ` : ''}

          <div class="discovery-steer-toggle-row">
            <button class="button xs secondary steer-toggle-btn" data-action="toggle-recommend-steer" type="button">
              <span>🎯 Steer &amp; Ranking options</span>
              <span class="steer-toggle-arrow">${state.recommendationSteerOpen ? '▲' : '▼'}</span>
            </button>
          </div>

          <div class="recommend-steer-panel" ${state.recommendationSteerOpen ? '' : 'hidden'}>
            <div class="steer-compact-head">
              <h3>🎯 Steer &amp; Filter</h3>
              <span class="subtle">${state.recommendationSteerKeywords.length + state.graphSteerKeywords.length + state.recommendationExcludeKeywords.length} active</span>
            </div>
            <div class="steer-chips-unified">
              ${activeSteerChips || '<span class="subtle-empty">No active steer tags. Use buttons below or click tags.</span>'}
            </div>
            <div class="steer-input-compact-bar">
              <input id="newSteerTagInput" placeholder="Add tag..." autocomplete="off">
              <div class="steer-action-btn-group">
                <button class="button xs primary" id="addSteerTagBtn" type="button">+ Steer</button>
                <button class="button xs" id="addGraphTagBtn" type="button">🌐 Map</button>
                <button class="button xs danger" id="addExcludeTagBtn" type="button">⛔ Not</button>
              </div>
            </div>
          </div>

          ${state.seminalSuggestions?.length ? `
            <div id="seminalResults" class="recommendation-list">${renderSeminalMarkup()}</div>
          ` : ''}

          <div id="recommendationResults" class="recommendation-list">
            ${renderRecommendationMarkup(recommendations, isLoadingRecommendations)}
          </div>
        </div>

        <div class="inspector-footer-btns">
          <button class="inspector-action-large primary" data-action="add-as-new-seed" type="button">
            🌱 Add as new seed
          </button>
          <button class="inspector-action-large secondary" data-action="find-similar-work" type="button">
            🔍 Find similar
          </button>
        </div>
      `;

      els.details.querySelector('[data-action="close-details"]')?.addEventListener('click', closePaperPopup);
      els.details.querySelector('[data-action="toggle-abstract"]')?.addEventListener('click', () => {
        state.detailsAbstractExpanded = !state.detailsAbstractExpanded;
        renderDetails();
      });
      els.details.querySelector('[data-action="toggle-paper-seed"]')?.addEventListener('click', () => {
        state.pinnedSeedId = state.pinnedSeedId === paper.id ? null : paper.id;
        renderDetails();
        scheduleAutosave();
        showToast(state.pinnedSeedId ? `Set "${compactTitle(paper.title)}" as discovery seed` : 'Cleared discovery seed');
      });
      els.details.querySelector('[data-action="add-as-new-seed"]')?.addEventListener('click', () => {
        state.pinnedSeedId = paper.id;
        state.discoverySeed = paper;
        runDiscoveryPipeline();
      });
      els.details.querySelector('[data-action="find-similar-work"]')?.addEventListener('click', () => {
        state.pinnedSeedId = paper.id;
        state.discoverySeed = paper;
        recommendSelectedPapers();
      });
      els.details.querySelector('[data-action="map-citations"]')?.addEventListener('click', mapCitationTopology);
      els.details.querySelector('[data-action="find-seminal"]')?.addEventListener('click', findMissingSeminal);
      els.details.querySelector('[data-action="snowball-backward"]')?.addEventListener('click', () => snowballSelectedPaper('backward'));
      els.details.querySelector('[data-action="snowball-forward"]')?.addEventListener('click', () => snowballSelectedPaper('forward'));
      els.details.querySelector('[data-action="chase-2hop"]')?.addEventListener('click', chase2HopSelectedPaper);
      els.details.querySelector('[data-action="network-triangulate"]')?.addEventListener('click', triangulateNetworkSelectedPaper);
      els.details.querySelector('[data-action="run-discovery-pipeline"]')?.addEventListener('click', runDiscoveryPipeline);
      els.details.querySelector('[data-action="open-discovery-results-modal"]')?.addEventListener('click', () => {
        if (state.discoveryResults?.length) openDiscoveryModal(state.discoveryResults, state.discoverySeed || paper);
      });
      els.details.querySelectorAll('[data-action="toggle-branch"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const branch = btn.dataset.branch;
          if (branch && state.discoveryBranches[branch] !== undefined) {
            state.discoveryBranches[branch] = !state.discoveryBranches[branch];
            render();
          }
        });
      });
      els.details.querySelector('[data-action="recommend"]')?.addEventListener('click', recommendSelectedPapers);
      els.details.querySelector('[data-action="toggle-recommend-steer"]')?.addEventListener('click', () => setRecommendationSteerOpen(!state.recommendationSteerOpen));
      els.details.querySelectorAll('[data-action="open-paper-keywords"]').forEach(btn => {
        btn.addEventListener('click', () => openKeywordModal(btn.dataset.paper || paper.id));
      });
      els.details.querySelectorAll('[data-action="tag-action-menu"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          openTagActionMenu(btn.dataset.term, btn, paper.id);
        });
      });
      els.details.querySelectorAll('[data-action="quick-steer-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          toggleRecommendationSteer(btn.dataset.tag);
        });
      });
      const steerInput = els.details.querySelector('#newSteerTagInput');
      const steerAddBtn = els.details.querySelector('#addSteerTagBtn');
      steerAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleRecommendationSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      steerInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (steerInput.value) {
            toggleRecommendationSteer(steerInput.value);
            steerInput.value = '';
          }
        }
      });
      const graphAddBtn = els.details.querySelector('#addGraphTagBtn');
      graphAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleGraphSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      const excludeAddBtn = els.details.querySelector('#addExcludeTagBtn');
      excludeAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleExcludeSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      els.details.querySelectorAll('[data-action="view-related-link"]').forEach(item => {
        item.addEventListener('click', () => {
          if (item.dataset.link) selectLinkage(item.dataset.link);
        });
      });
      bindRecommendationSteerInputs();
      bindSteerChipButtons();
      els.details.querySelectorAll('[data-action="add-recommendation"]').forEach(button => {
        button.addEventListener('click', () => addRecommendedPaperToMap(Number(button.dataset.recIndex)));
      });
      els.details.querySelectorAll('[data-action="add-seminal"]').forEach(button => {
        button.addEventListener('click', () => addSeminalPaperToMap(Number(button.dataset.seminalIndex)));
      });
      els.details.querySelectorAll('[data-action="recommend-more-like"]').forEach(button => {
        button.addEventListener('click', () => steerFromRecommendation(Number(button.dataset.recIndex), 'more'));
      });
      els.details.querySelectorAll('[data-action="recommend-less-like"]').forEach(button => {
        button.addEventListener('click', () => steerFromRecommendation(Number(button.dataset.recIndex), 'less'));
      });
    }

    function closePaperPopup() {
      state.inspectorOpen = false;
      state.selectedId = null;
      state.selectedLinkId = null;
      els.details.hidden = true;
      renderSelection();
    }

    function renderMiniSteerChip(term, group, prefix = '') {
      return `
        <span class="steer-mini-chip chip-${group}">
          <button class="chip-label" type="button" data-action="tag-action-menu" data-term="${escapeHtml(term)}" title="Click for tag options">
            ${escapeHtml(prefix + term)}
          </button>
          <button class="chip-remove-btn" type="button" data-action="remove-steer-chip" data-chip-group="${group}" data-chip-value="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(prefix + term)}">×</button>
        </span>
      `;
    }

    function renderSteerChips(values, group, prefix = '') {
      return values.map(term => renderMiniSteerChip(term, group, prefix)).join('');
    }

    function bindRecommendationSteerInputs() {
      const bindings = [
        { selector: '#recommendAuthorInput', kind: 'list', group: 'authors', limit: 10, assign: value => { state.recommendationAuthors = parseSteerList(value, 10); } },
        { selector: '#recommendJournalInput', kind: 'list', group: 'journals', limit: 10, assign: value => { state.recommendationJournals = parseSteerList(value, 10); } },
        { selector: '#recommendRecencyTilt', assign: value => { state.recommendationRecencyTilt = Number(value) || 0; } },
        { selector: '#recommendImpactTilt', assign: value => { state.recommendationImpactTilt = Number(value) || 0; } }
      ];
      bindings.forEach(binding => {
        const input = els.details.querySelector(binding.selector);
        input?.addEventListener('input', event => binding.assign(event.target.value));
        if (binding.kind === 'list') {
          input?.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitSteerInput(input, binding.group, binding.limit);
            showToast('Keyword added.');
            if (binding.group === 'graph') render();
            else renderDetails();
          });
        }
        input?.addEventListener('change', event => {
          binding.assign(event.target.value);
          if (binding.kind === 'list') event.target.value = steerValuesForGroup(binding.group).join('; ');
          showToast('Recommendation steering updated.');
          if (binding.selector === '#graphSteerInput') {
            render();
          } else {
            renderDetails();
          }
        });
      });
    }

    function commitSteerInput(input, group, limit) {
      const values = parseSteerList(input.value, limit);
      setSteerValuesForGroup(group, values);
      input.value = values.join('; ');
    }

    function bindSteerChipButtons() {
      els.details.querySelectorAll('[data-action="remove-steer-chip"]').forEach(button => {
        button.addEventListener('click', () => {
          removeSteerChip(button.dataset.chipGroup, button.dataset.chipValue);
        });
      });
    }

    function steerValuesForGroup(group) {
      if (group === 'steer') return state.recommendationSteerKeywords;
      if (group === 'exclude') return state.recommendationExcludeKeywords;
      if (group === 'authors') return state.recommendationAuthors;
      if (group === 'journals') return state.recommendationJournals;
      if (group === 'graph') return state.graphSteerKeywords;
      return [];
    }

    function setSteerValuesForGroup(group, values) {
      if (group === 'steer') state.recommendationSteerKeywords = values;
      if (group === 'exclude') state.recommendationExcludeKeywords = values;
      if (group === 'authors') state.recommendationAuthors = values;
      if (group === 'journals') state.recommendationJournals = values;
      if (group === 'graph') state.graphSteerKeywords = values;
    }

    function removeSteerChip(group, value) {
      const normalized = String(value || '').toLowerCase();
      setSteerValuesForGroup(group, steerValuesForGroup(group).filter(term => term.toLowerCase() !== normalized));
      showToast('Keyword removed.');
      if (group === 'graph') render();
      else renderDetails();
    }

    function renderRecommendationMarkup(recommendations, loading) {
      if (loading) {
        const steerBits = [
          state.recommendationSteerKeywords.length ? `toward ${state.recommendationSteerKeywords.join(', ')}` : '',
          state.recommendationExcludeKeywords.length ? `away from ${state.recommendationExcludeKeywords.join(', ')}` : '',
          state.recommendationAuthors.length ? `authors ${state.recommendationAuthors.join(', ')}` : '',
          state.recommendationJournals.length ? `venues ${state.recommendationJournals.join(', ')}` : ''
        ].filter(Boolean).join('; ');
        const steer = steerBits ? ` steered ${steerBits}` : '';
        return `<div class="settings-status">Searching Semantic Scholar (S2AG), OpenAlex, and Crossref${escapeHtml(steer)} for literature...</div>`;
      }
      if (!recommendations.length) {
        return '<div class="settings-status">No literature suggestions yet. Select a paper and click ⚡ Run Pipeline or Find related papers.</div>';
      }
      return recommendations.map((item, index) => {
        const href = item.doi ? `https://doi.org/${item.doi}` : (item.url || (item.s2PaperId ? `https://www.semanticscholar.org/paper/${item.s2PaperId}` : '') || item.openAlexId || '#');
        const authorList = paperAuthors(item);
        const authors = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';
        const meta = [item.source || '', authors, item.year || item.date, item.journal, item.doi ? `DOI ${item.doi}` : '', item.citedByCount ? `${item.citedByCount} citations` : '', item.influentialCitationCount ? `⭐ ${item.influentialCitationCount} influential` : '']
          .filter(Boolean)
          .join(' | ');

        const badges = (item.discoveryBadges || []).map(b => {
          let cls = 'badge-general';
          if (b.includes('SPECTER2')) cls = 'badge-specter';
          else if (b.includes('Co-citation')) cls = 'badge-cocitation';
          else if (b.includes('Bib Coupling')) cls = 'badge-bibcoupling';
          else if (b.includes('2-Hop')) cls = 'badge-chase';
          else if (b.includes('Influential')) cls = 'badge-influential';
          else if (b.includes('Backward') || b.includes('Forward')) cls = 'badge-citation';
          else cls = 'badge-concept';
          return `<span class="discovery-badge ${cls}">${escapeHtml(b)}</span>`;
        }).join('');

        const scorePill = item.score !== undefined ? `
          <span class="discovery-score-pill" title="Relevance: ${item.scoreBreakdown?.relevance || 0} | Proximity: ${item.scoreBreakdown?.citationProximity || 0} | Semantic: ${item.scoreBreakdown?.semanticSimilarity || 0} | Convergence Bonus: +${item.scoreBreakdown?.convergenceBonus || 0}">
            Score ${Math.round(item.score)}
          </span>
        ` : '';

        return `<article class="recommendation-item">
          <div class="recommendation-title-row">
            <a class="recommendation-title" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || 'Untitled recommendation')}</a>
            ${scorePill}
          </div>
          <div class="recommendation-meta">${escapeHtml(meta || item.source || 'Recommended paper')}</div>
          ${badges ? `<div class="recommendation-badges-row">${badges}</div>` : ''}
          <div class="recommendation-reason">${escapeHtml(item.reason || 'Recommended from selected-paper title, abstract, and citation topology.')}</div>
          ${item.title === 'Recommendation search failed' || item.title === 'Discovery search failed' ? '' : `
            <div class="recommend-feedback">
              <button class="button xs" data-action="recommend-more-like" data-rec-index="${index}" type="button">More like this</button>
              <button class="button xs" data-action="recommend-less-like" data-rec-index="${index}" type="button">Less like this</button>
            </div>
            <button class="button small" data-action="add-recommendation" data-rec-index="${index}" type="button">Add to map</button>
          `}
        </article>`;
      }).join('');
    }

    function renderSeminalMarkup() {
      if (!state.seminalSuggestions.length) return '';
      return state.seminalSuggestions.map((item, index) => {
        const href = item.doi ? `https://doi.org/${item.doi}` : (item.url || item.openAlexId || '#');
        const authorList = paperAuthors(item);
        const authors = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';
        const meta = [authors, item.year || item.date, item.journal, item.doi ? `DOI ${item.doi}` : '', item.citedByLoadedCount ? `${item.citedByLoadedCount} map citations` : ''].filter(Boolean).join(' | ');
        return `<article class="recommendation-item">
          <a class="recommendation-title" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || 'Untitled foundational paper')}</a>
          <div class="recommendation-meta">${escapeHtml(meta || 'Missing foundational paper')}</div>
          <div class="recommendation-reason">${escapeHtml(item.reason || 'Frequently referenced by papers already on this map.')}</div>
          <button class="button" data-action="add-seminal" data-seminal-index="${index}" type="button">Add seminal paper</button>
        </article>`;
      }).join('');
    }

    function recommendationAlreadyOnMap(item) {
      const doi = normalizeDoi(item?.doi || '');
      const titleKey = cleanField(item?.title || '').toLowerCase();
      return state.papers.some(paper =>
        (doi && sameDoi(paper.doi || '', doi))
        || (titleKey && cleanField(paper.title || '').toLowerCase() === titleKey)
      );
    }

    function paperFromRecommendation(item) {
      return normalizeImportedPaper({
        ...item,
        paperKeywords: item.paperKeywords || item.keywords || [],
        text: `${item.title || ''}\n\n${item.abstract || ''}\n\n${(item.paperKeywords || item.keywords || []).join('; ')}`,
        name: item.source ? `${item.source} recommendation` : 'Recommended paper'
      }, item.source ? `${item.source} recommendation` : 'Recommendation');
    }

    function addRecommendationTrailToMap(seed, recommendations, count = 3) {
      const fresh = (recommendations || [])
        .filter(item => item.title !== 'Recommendation search failed' && item.title !== 'Discovery search failed' && !recommendationAlreadyOnMap(item))
        .slice(0, count);
      fresh.forEach((item, index) => {
        const paper = paperFromRecommendation(item);
        const angle = (-Math.PI / 2) + index * ((Math.PI * 2) / Math.max(fresh.length, 3));
        paper.x = (seed?.x || 0) + Math.cos(angle) * 180;
        paper.y = (seed?.y || 0) + Math.sin(angle) * 150;
        paper.areaId = seed?.areaId || '';
        state.papers.push(paper);
        if (seed && seed.id !== paper.id) {
          const isBib = item.subType === 'Bibliographic coupling' || (item.discoveryBadges || []).some(b => b.includes('Bib Coupling'));
          const isCoCite = item.subType === 'Co-citation' || (item.discoveryBadges || []).some(b => b.includes('Co-citation'));
          const isSpecter = item.subType === 'SPECTER2' || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
          const ltype = isBib ? 'bibliographic' : (isCoCite ? 'cocitation' : (isSpecter ? 'similarity' : 'mixed'));
          state.explicitLinks.push({
            source: seed.id,
            target: paper.id,
            score: item.score ? Math.min(0.95, item.score / 100) : 0.82,
            type: ltype,
            evidence: item.reason || 'S2AG Literature Discovery recommendation'
          });
        }
      });
      return fresh.length;
    }

    function recommendationFeedbackTerms(item) {
      const terms = [
        ...(item?.paperKeywords || item?.keywords || []),
        ...tokenize(`${item?.title || ''} ${item?.abstract || ''}`).filter(term => !term.includes(' '))
      ];
      return dedupeList(terms.map(cleanField).filter(term => term.length >= 4 && term.length <= 48)).slice(0, 5);
    }

    function steerFromRecommendation(index, direction) {
      const seeds = selectedPapersForRecommendation();
      const key = recommendationKey(seeds);
      const item = (state.recommendations.get(key) || [])[index];
      if (!item) return;
      const terms = recommendationFeedbackTerms(item);
      if (!terms.length) {
        showToast('No useful feedback terms found for that recommendation.');
        return;
      }
      if (direction === 'less') {
        state.recommendationExcludeKeywords = dedupeList([...terms, ...state.recommendationExcludeKeywords]).slice(0, 16);
        showToast('Added terms to steer away from.');
      } else {
        state.recommendationSteerKeywords = dedupeList([...terms, ...state.recommendationSteerKeywords]).slice(0, 12);
        state.graphSteerKeywords = dedupeList([...terms.slice(0, 3), ...state.graphSteerKeywords]).slice(0, 12);
        showToast('Added terms to steer toward and refocus the map.');
      }
      state.recommendationSteerOpen = true;
      render();
    }

    function citationPaperPayload(paper) {
      return {
        id: paper.id,
        title: paper.title || '',
        doi: paper.doi || '',
        s2PaperId: paper.s2PaperId || '',
        pmid: paper.pmid || '',
        abstract: paper.abstract || '',
        authors: paper.authors || [],
        openAlexId: paper.openAlexId || '',
        openAlexUrl: paper.openAlexUrl || '',
        techniques: paper.techniques || [],
        organisms: paper.organisms || [],
        paperKeywords: paper.paperKeywords || paper.keywords || [],
        referenceIds: paper.referenceIds || [],
        citedByIds: paper.citedByIds || []
      };
    }

    function applyCitationMetadata(paper, metadata = {}) {
      mergeDoiMetadata(paper, metadata);
      if (metadata.s2PaperId) paper.s2PaperId = metadata.s2PaperId;
      if (metadata.influentialCitationCount) paper.influentialCitationCount = metadata.influentialCitationCount;
      paper.openAlexId = normalizeOpenAlexId(metadata.openAlexId || metadata.openAlexUrl || paper.openAlexId || '');
      paper.openAlexUrl = metadata.openAlexUrl || paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${paper.openAlexId}` : '');
      paper.referenceIds = dedupeList([...(paper.referenceIds || []), ...(metadata.referenceIds || [])].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      paper.citedByIds = dedupeList([...(paper.citedByIds || []), ...(metadata.citedByIds || [])].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      paper.citedByCount = Number(metadata.citedByCount || paper.citedByCount || 0);
    }

    async function mapCitationTopology() {
      if (!state.papers.length) {
        showToast('Load papers before mapping citations.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/enrich'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ papers: state.papers.map(citationPaperPayload) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not map citations.');
        (data.papers || []).forEach(item => {
          const paper = state.papers.find(candidate => candidate.id === item.id)
            || state.papers.find(candidate => sameDoi(candidate.doi || '', item.doi || ''));
          if (paper) applyCitationMetadata(paper, item.metadata || {});
        });
        showToast(`Mapped citation topology for ${(data.papers || []).length} paper${(data.papers || []).length === 1 ? '' : 's'}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    async function findMissingSeminal() {
      if (state.citationLoading || state.discoveryLoading || !state.papers.length) return;
      state.discoveryError = '';
      if (!state.papers.some(paper => (paper.referenceIds || []).length)) {
        await mapCitationTopology();
      }
      state.citationLoading = true;
      render();
      try {
        const response = await fetch(backendUrl('/api/citations/seminal'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ papers: state.papers.map(citationPaperPayload), threshold: Math.max(2, Math.ceil(state.papers.length * 0.35)) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not find missing seminal papers.');
        state.seminalSuggestions = data.recommendations || [];
        openDiscoveryModal(state.seminalSuggestions, selectedPapersForRecommendation()[0] || state.papers[0]);
        showToast(state.seminalSuggestions.length ? `Found ${state.seminalSuggestions.length} missing foundational paper${state.seminalSuggestions.length === 1 ? '' : 's'}.` : 'No common missing reference found yet.');
      } catch (error) {
        state.discoveryError = error.message;
        state.discoveryHasRun = true;
        state.discoveryResults = [];
        setWorkspaceView('discover');
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    async function snowballSelectedPaper(direction) {
      const seed = state.papers.find(item => item.id === state.selectedId);
      if (!seed) {
        showToast('Select a paper first.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/snowball'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ paper: citationPaperPayload(seed), direction, limit: 25 })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not snowball from this paper.');
        const added = addCitationPapersToMap(seed, data.recommendations || [], direction);
        showToast(`Citation chase found ${(data.recommendations || []).length} papers and added ${added}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    function addCitationPapersToMap(seed, items, direction) {
      const fresh = (items || []).filter(item => item.title && !recommendationAlreadyOnMap(item));
      fresh.forEach((item, index) => {
        const paper = paperFromRecommendation(item);
        const orbitIndex = Math.floor(index / 8);
        const posInOrbit = index % 8;
        const radius = (direction === 'backward' ? 210 : 270) + orbitIndex * 110;
        const angle = (-Math.PI / 2) + posInOrbit * ((Math.PI * 2) / Math.min(8, Math.max(fresh.length - orbitIndex * 8, 1)));
        paper.x = (seed?.x || 0) + Math.cos(angle) * radius;
        paper.y = (seed?.y || 0) + Math.sin(angle) * radius;
        paper.areaId = seed?.areaId || '';
        if (direction === 'backward') {
          seed.referenceIds = dedupeList([...(seed.referenceIds || []), paper.openAlexId].filter(Boolean));
        } else if (direction === 'forward') {
          paper.referenceIds = dedupeList([...(paper.referenceIds || []), seed.openAlexId].filter(Boolean));
          seed.citedByIds = dedupeList([...(seed.citedByIds || []), paper.openAlexId].filter(Boolean));
        } else if (direction === 'network') {
          state.explicitLinks.push({
            source: seed.id,
            target: paper.id,
            score: 0.88,
            type: item.subType === 'Bibliographic coupling' ? 'bibliographic' : 'cocitation',
            evidence: item.reason || 'Citation network triangulation'
          });
        } else if (direction === 'chase') {
          state.explicitLinks.push({
            source: seed.id,
            target: paper.id,
            score: 0.82,
            type: 'citation',
            evidence: item.reason || 'Iterative 2-hop citation chase'
          });
        }
        state.papers.push(paper);
      });
      if (fresh.length) {
        state.centerId = seed.id;
        state.selectedId = seed.id;
      }
      return fresh.length;
    }

    async function chase2HopSelectedPaper() {
      const seed = state.papers.find(item => item.id === state.selectedId);
      if (!seed) {
        showToast('Select a paper first.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/chase'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ paper: citationPaperPayload(seed), limit: 25 })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not run 2-hop chase.');
        const added = addCitationPapersToMap(seed, data.recommendations || [], 'chase');
        showToast(`2-Hop chase found ${(data.recommendations || []).length} papers and added ${added}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    async function triangulateNetworkSelectedPaper() {
      const seed = state.papers.find(item => item.id === state.selectedId);
      if (!seed) {
        showToast('Select a paper first.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/network'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ paper: citationPaperPayload(seed), limit: 25 })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not triangulate citation network.');
        const added = addCitationPapersToMap(seed, data.recommendations || [], 'network');
        showToast(`Citation network triangulation found ${(data.recommendations || []).length} papers and added ${added}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    let discoveryGeneration = 0, discoveryController = null;
    function discoveryPause(signal) {
      return new Promise((resolve,reject)=>{
        if(signal.aborted){reject(new DOMException('Cancelled','AbortError'));return;}
        const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},500);
        signal.addEventListener('abort',abort,{once:true});
      });
    }
    function applyDiscoveryProgress(data) {
      state.discoveryResults=data.recommendations||[];
      state.discoveryWarnings=Object.entries(data.errors||{}).map(([name,message])=>`${name}: ${message}`);
      const completed=data.completed||0,total=data.total||0;
      state.discoveryStatus=data.status==='complete' ? `Search complete · ${state.discoveryResults.length} candidates.` : `${completed} of ${total} discovery methods finished · ${state.discoveryResults.length} candidates so far.`;
      renderDiscoveryWorkspace();
    }
    function cancelDiscovery() {
      ++discoveryGeneration;discoveryController?.abort();
      if(state.discoveryJob)fetch(backendUrl('/api/discovery/cancel'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({id:state.discoveryJob})}).catch(()=>{});
      state.discoveryLoading=false;state.discoveryJob=null;state.recommendationLoadingKey=null;
      state.discoveryHasRun=true;state.discoveryStatus='Search cancelled. Completed candidates are available to review.';
      renderDiscoveryWorkspace();
    }
    els.discoveryCancelButton.addEventListener('click',cancelDiscovery);

    async function runDiscoveryPipeline() {
      if (state.discoveryLoading) return;
      if (!Object.values(state.discoveryBranches).some(Boolean)) {
        showToast('Enable at least one discovery method.');
        return;
      }
      if (state.workspaceView === 'discover') setDiscoverySeed(els.discoverySeedSelect.value);
      else if (state.workspaceView === 'network' && state.selectedId && !state.selectedLinkId) setDiscoverySeed(state.selectedId);
      const seeds = selectedPapersForRecommendation();
      if (!seeds.length) {
        showToast('Select a paper first to run literature discovery.');
        return;
      }
      const key = recommendationKey(seeds);
      const generation=++discoveryGeneration;
      discoveryController = new AbortController();
      state.discoveryJob = null;state.discoveryStatus='Starting search…';state.discoveryWarnings=[];
      state.discoveryLoading = true;
      state.discoveryError = '';
      state.discoveryResults = [];
      state.discoverySelectedKeys = new Set();
      setWorkspaceView('discover');
      state.recommendationLoadingKey = key;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/discovery/start'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            seedPapers: seeds.map(citationPaperPayload),
            branches: state.discoveryBranches,
            steerKeywords: state.recommendationSteerKeywords,
            excludeKeywords: state.recommendationExcludeKeywords,
            recencyTilt: state.recommendationRecencyTilt,
            impactTilt: state.recommendationImpactTilt,
            iterativeChase: state.explorationDepth !== '1',
            depth: state.explorationDepth,
            limit: 50
          })
        });
        let data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Discovery pipeline failed.');
        if(generation!==discoveryGeneration) {
          if(data.id)fetch(backendUrl('/api/discovery/cancel'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({id:data.id})}).catch(()=>{});
          return;
        }
        state.discoveryJob=data.id;
        while(data.status==='running') {
          applyDiscoveryProgress(data);
          await discoveryPause(discoveryController.signal);
          const poll=await fetch(backendUrl('/api/discovery/jobs/'+data.id),{headers:apiHeaders(),signal:discoveryController.signal});
          data=await poll.json();
          if(!poll.ok)throw new Error(data.error || 'Could not read discovery progress.');
          if(generation!==discoveryGeneration)return;
        }
        if(data.status==='failed')throw new Error(data.error || 'Discovery search failed.');
        if(data.status==='cancelled'){state.discoveryStatus='Search cancelled. Completed candidates are available to review.';return;}
        applyDiscoveryProgress(data);
        const recs = data.recommendations || [];
        state.recommendations.set(key, recs);
        state.discoveryResults = recs;
        state.discoverySeed = seeds[0];
        openDiscoveryModal(recs, seeds[0]);
        showToast(`Literature discovery surfaced ${recs.length} papers. Review and choose papers to add in Discover.`);
      } catch (error) {
        if(generation!==discoveryGeneration || error.name==='AbortError')return;
        state.discoveryStatus='Search could not finish.';
        state.discoveryError = error.message;
        state.discoveryHasRun = true;
        showToast(error.message);
        state.recommendations.set(key, [{ title: 'Discovery search failed', reason: error.message }]);
      } finally {
        if(generation===discoveryGeneration){state.discoveryLoading=false;state.discoveryJob=null;state.recommendationLoadingKey=null;render();}
      }
    }

    function addSeminalPaperToMap(index) {
      const item = state.seminalSuggestions[index];
      if (!item) return;
      if (recommendationAlreadyOnMap(item)) {
        showToast('That seminal paper is already on the map.');
        return;
      }
      const seed = state.papers.find(paper => paper.id === state.selectedId) || state.papers[0];
      const paper = paperFromRecommendation(item);
      paper.x = (seed?.x || state.view.x + state.view.width / 2) + 170;
      paper.y = seed?.y || state.view.y + state.view.height / 2;
      state.papers.push(paper);
      state.selectedId = paper.id;
      render();
      showToast('Added missing seminal paper to the map.');
    }

    function addRecommendedPaperToMap(index) {
      const seeds = selectedPapersForRecommendation();
      const key = recommendationKey(seeds);
      const item = (state.recommendations.get(key) || [])[index];
      if (!item) return;
      if (recommendationAlreadyOnMap(item)) {
        showToast('That recommended paper is already on the map.');
        return;
      }
      const paper = paperFromRecommendation(item);
      const seed = seeds[0] || state.papers[0];
      if (seed && seed.id !== paper.id) {
        const isBib = item.subType === 'Bibliographic coupling' || (item.discoveryBadges || []).some(b => b.includes('Bib Coupling'));
        const isCoCite = item.subType === 'Co-citation' || (item.discoveryBadges || []).some(b => b.includes('Co-citation'));
        const isSpecter = item.subType === 'SPECTER2' || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
        const ltype = isBib ? 'bibliographic' : (isCoCite ? 'cocitation' : (isSpecter ? 'similarity' : 'mixed'));
        state.explicitLinks.push({
          source: seed.id,
          target: paper.id,
          score: item.score ? Math.min(0.95, item.score / 100) : 0.82,
          type: ltype,
          evidence: item.reason || 'S2AG Literature Discovery recommendation'
        });
      }
      state.papers.push(paper);
      state.selectedId = paper.id;
      state.centerId = null;
      render();
      showToast('Added recommended paper to the map.');
    }

    async function fetchRecommendationsForSeeds(seeds, limit = 8) {
      for (const paper of seeds) {
        if (!paper.gemmaKeywords?.length && (paper.text || paper.abstract || paper.doi)) {
          await extractWithGemmaLayer(paper, {
            usableText: `${paper.title || ''}\n${paper.abstract || ''}\n${paper.text || ''}`,
            doiCandidates: uniqueDoiCandidates([paper.doi])
          });
        }
      }
      const response = await fetch(backendUrl('/api/recommendations'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          limit,
          papers: seeds.map(paper => ({
            title: paper.title || '',
            authors: paper.authors || [],
            date: paper.date || '',
            year: paper.year || '',
            journal: paper.journal || '',
            doi: paper.doi || '',
            abstract: paper.abstract || '',
            keywords: mergedKeywords(paper),
            gemmaKeywords: paper.gemmaKeywords || [],
            keyFindings: paper.keyFindings || [],
            organisms: paper.organisms || [],
            techniques: paper.techniques || [],
            discoveryTerms: paper.discoveryTerms || [],
            color: paper.color || '',
            area: state.areas.find(area => area.id === paper.areaId)?.name || ''
          })),
          steerKeywords: state.recommendationSteerKeywords,
          excludeKeywords: state.recommendationExcludeKeywords,
          steerAuthors: state.recommendationAuthors,
          steerJournals: state.recommendationJournals,
          recencyTilt: state.recommendationRecencyTilt,
          impactTilt: state.recommendationImpactTilt,
          excludeDois: state.papers.map(paper => paper.doi).filter(Boolean),
          excludeTitles: state.papers.map(paper => paper.title).filter(Boolean)
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not recommend papers.');
      return data;
    }

    async function recommendSelectedPapers() {
      const seeds = selectedPapersForRecommendation();
      if (!seeds.length) {
        showToast('Select a paper first.');
        return;
      }
      const key = recommendationKey(seeds);
      state.recommendationLoadingKey = key;
      renderDetails();
      try {
        const data = await fetchRecommendationsForSeeds(seeds, 8);
        const recommendations = data.recommendations || [];
        state.recommendations.set(key, recommendations);
        const added = addRecommendationTrailToMap(seeds[0], recommendations, 3);
        if (added) {
          state.centerId = seeds[0].id;
          state.selectedId = seeds[0].id;
          showToast(`Found ${(data.recommendations || []).length} recommendations and added ${added} to the map.`);
        } else {
          showToast(`Found ${(data.recommendations || []).length} recommendations. The top matches are already on the map.`);
        }
      } catch (error) {
        state.recommendations.set(key, [{ title: 'Recommendation search failed', reason: error.message }]);
      } finally {
        state.recommendationLoadingKey = null;
        render();
      }
    }

    function setPaperViewDensity(density) {
      state.paperView = density === 'expanded' ? 'expanded' : 'compact';
      syncDensityButtons();
      renderPapers();
      if (state.mode === 'table') {
        renderTableView();
      } else {
        render();
      }
      updateMetrics();
      scheduleAutosave();
    }

    function syncDensityButtons() {
      document.querySelectorAll('[data-density]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.density === state.paperView);
      });
      if (els.paperViewToggle) {
        els.paperViewToggle.textContent = state.paperView === 'compact' ? 'Expanded' : 'Compact';
        els.paperViewToggle.setAttribute('aria-pressed', String(state.paperView === 'compact'));
      }
    }

    function updateMetrics() {
      if (els.railLibraryBadge) els.railLibraryBadge.textContent = state.papers.length;
      els.emptyState.style.display = state.papers.length ? 'none' : 'grid';
      els.paperCount.textContent = state.librarySearch || state.filterTags.length ? `${state.papers.filter(paperMatchesFilters).length} of ${state.papers.length}` : `${state.papers.length} loaded`;
      els.metricPapers.textContent = state.papers.length;
      els.metricLinks.textContent = visibleLinks().length;
      els.metricClusters.textContent = state.papers.length ? state.clusters.length : 0;
      if (els.storagePaperCount) {
        els.storagePaperCount.textContent = state.papers.length;
      }
      if (els.storageLinkCount) {
        els.storageLinkCount.textContent = state.links.length;
      }
      if (els.clearButton) {
        els.clearButton.disabled = state.papers.length === 0;
      }
      if (els.sidebarClearButton) {
        els.sidebarClearButton.hidden = state.papers.length === 0;
      }
      els.exportButton.disabled = state.papers.length === 0;
      els.summaryExportButton.disabled = state.papers.length === 0;
      syncDensityButtons();
      const thresholdPercent = Math.round(state.threshold * 100);
      els.thresholdValue.textContent = `${thresholdPercent}%`;
      const centeredPaper = state.papers.find(paper => paper.id === state.centerId);

      if (state.mode === 'table') {
        const viewLabel = state.paperView === 'compact' ? 'Compact' : 'Expanded';
        els.statusText.textContent = `Extracted literature findings and references for ${state.papers.length} paper${state.papers.length === 1 ? '' : 's'} (${viewLabel} view).`;
      } else if (centeredPaper) {
        els.statusText.textContent = `Centered on ${compactTitle(centeredPaper.title)}. Double-click empty graph space to reset.`;
      } else if (state.papers.length < 2) {
        els.statusText.textContent = 'Add at least two papers to create links.';
      } else if (!state.links.length) {
        els.statusText.textContent = 'No links above the current threshold. Lower the threshold to reveal weaker relationships.';
      } else {
        const topologyCount = state.links.filter(link => link.type && link.type !== 'similarity').length;
        els.statusText.textContent = `Showing ${state.links.length} links at ${thresholdPercent}% threshold${topologyCount ? `, including ${topologyCount} citation-topology links` : ''}.`;
      }
    }

    async function handleFiles(files) {
      const incoming = [...files];
      if (!incoming.length) return;
      showToast(`Reading ${incoming.length} file${incoming.length === 1 ? '' : 's'}...`);
      const parsed = [];
      setLoadProgress(0, incoming.length, `Preparing ${incoming.length} file${incoming.length === 1 ? '' : 's'}...`);
      try {
        for (let index = 0; index < incoming.length; index += 1) {
          const file = incoming[index];
          setLoadProgress(index, incoming.length, `Reading ${file.name || `file ${index + 1}`}...`);
          parsed.push(...await readImportFile(file));
          setLoadProgress(index + 1, incoming.length, `Loaded ${file.name || `file ${index + 1}`}.`);
        }
        const result = addParsedPapers(parsed);
        render();
        const mergedText = result.merged ? `, merged ${result.merged} duplicate${result.merged === 1 ? '' : 's'}` : '';
        showToast(`Added ${result.added} paper${result.added === 1 ? '' : 's'}${mergedText} to the map.`);
      } catch (error) {
        showToast(`Import failed: ${error.message}`);
      } finally {
        window.setTimeout(() => setLoadProgress(0, 0), 700);
      }
      if(state.workspaceView==='network') {
        if(activeAnalysis || activeLayout)els.statusText.textContent='Updating network in the background… You can keep using Pulse.';
        else if(visibleLinks().length>2500)els.statusText.textContent += ' Network shows the 2,500 strongest visible links; all evidence remains available in the library and export.';
      }
    }

    function loadSample() {
      state.papers = [
        {
          id: uid(),
          title: 'Transformer Attention for Scientific Document Retrieval',
          authors: ['A. Chen', 'M. Patel'],
          date: '2024',
          year: '2024',
          journal: 'Journal of Scientific Information Retrieval',
          doi: '10.1234/jsir.2024.001',
          abstract: 'This paper evaluates transformer attention representations for scientific document retrieval and citation recommendation across arXiv abstracts, focusing on dense embeddings and semantic search.',
          paperKeywords: ['transformers', 'scientific retrieval', 'citation recommendation', 'semantic search'],
          color: '#176c72',
          text: 'We evaluate transformer attention representations for scientific paper retrieval, citation recommendation, semantic search, dense embeddings, and document ranking across arXiv abstracts.'
        },
        {
          id: uid(),
          title: 'Graph Neural Networks for Citation Link Prediction',
          authors: ['L. Garcia', 'S. Okafor'],
          date: '2023',
          year: '2023',
          journal: 'Proceedings of Scholarly Graph Mining',
          doi: '10.1234/sgm.2023.014',
          abstract: 'This paper models citation networks with graph neural networks for link prediction, community detection, and scholarly recommendation using message passing over paper nodes.',
          paperKeywords: ['graph neural networks', 'citation networks', 'link prediction', 'community detection'],
          color: '#c7552c',
          text: 'This paper models citation networks with graph neural networks, message passing, node embeddings, link prediction, scholarly recommendation, and community detection.'
        },
        {
          id: uid(),
          title: 'Contrastive Learning of Biomedical Abstract Embeddings',
          authors: ['R. Singh', 'E. Novak'],
          date: '2025',
          year: '2025',
          journal: 'Biomedical NLP Review',
          doi: '10.1234/bnlp.2025.027',
          abstract: 'Biomedical abstracts are encoded with contrastive learning and domain-specific language models to improve literature discovery, retrieval, clustering, and semantic relatedness.',
          paperKeywords: ['biomedical abstracts', 'contrastive learning', 'embeddings', 'literature discovery'],
          color: '#6f5bc4',
          text: 'Biomedical abstracts are encoded with contrastive learning and domain-specific language models to improve literature discovery, retrieval, clustering, and semantic relatedness.'
        },
        {
          id: uid(),
          title: 'Energy-Efficient Scheduling in Edge Computing Systems',
          authors: ['T. Williams', 'N. Ibrahim'],
          date: '2022',
          year: '2022',
          journal: 'Edge Systems Letters',
          doi: '10.1234/esl.2022.009',
          abstract: 'This study examines energy-aware task allocation for edge computing systems under latency constraints, mobile workloads, resource management, and distributed optimization.',
          paperKeywords: ['edge computing', 'energy-aware scheduling', 'latency', 'distributed optimization'],
          color: '#2478b7',
          text: 'We study edge computing schedulers, energy-aware task allocation, latency constraints, mobile workloads, resource management, and distributed optimization.'
        },
        {
          id: uid(),
          title: 'Survey of Semantic Scholar Recommendation Methods',
          authors: ['H. Brown', 'Y. Sato'],
          date: '2024',
          year: '2024',
          journal: 'ACM Computing Surveys',
          doi: '10.1234/csur.2024.042',
          abstract: 'This survey compares paper recommendation methods that combine citation graphs, co-citation features, content similarity, bibliographic coupling, transformer embeddings, and hybrid ranking.',
          paperKeywords: ['paper recommendation', 'citation graphs', 'content similarity', 'hybrid ranking'],
          color: '#0d7f55',
          text: 'A survey of paper recommendation methods including citation graphs, co-citation features, content similarity, bibliographic coupling, transformer embeddings, and hybrid ranking.'
        }
      ];
      state.selectedId = state.papers[0].id;
      render();
      showToast('Loaded sample papers.');
    }

    function serializeMap({includeDerived = true} = {}) {
      return {
        format: 'pulse-map',
        version: '1.3.0',
        generatedAt: new Date().toISOString(),
        threshold: state.threshold,
        mode: state.mode,
        workspaceView: state.workspaceView,
        linkTypeFilter: state.linkTypeFilter,
        discoveryBranches: { ...state.discoveryBranches },
        explorationDepth: state.explorationDepth,
        pinnedSeedId: state.pinnedSeedId,
        explicitLinks: state.explicitLinks.map(link => ({ ...link })),
        paperView: state.paperView,
        filterTags: state.filterTags || [],
        filterMode: state.filterMode || 'all',
        recommendationSteerKeywords: state.recommendationSteerKeywords,
        recommendationExcludeKeywords: state.recommendationExcludeKeywords,
        recommendationAuthors: state.recommendationAuthors,
        recommendationJournals: state.recommendationJournals,
        graphSteerKeywords: state.graphSteerKeywords,
        recommendationRecencyTilt: state.recommendationRecencyTilt,
        recommendationImpactTilt: state.recommendationImpactTilt,
        graphStyle: { ...state.graphStyle },
        view: { ...state.view },
        areas: state.areas.map(area => ({ ...area })),
        papers: state.papers.map(paper => ({
          id: paper.id,
          title: paper.title,
          name: paper.name,
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
