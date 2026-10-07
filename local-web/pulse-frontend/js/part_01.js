const state = {
      papers: [],
      vectors: new Map(),
      keywords: new Map(),
      links: [],
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
      detailsAbstractExpanded: false,
      libraryOpen: true,
      inspectorVisible: true,
      librarySortKey: 'year',
      librarySortAsc: false
    };

    const launchParams = new URLSearchParams(window.location.search);
    let apiToken = launchParams.get('token') || launchParams.get('pulseToken') || launchParams.get('iratxeToken') || window.__PULSE_API_TOKEN__ || window.__IRATXE_API_TOKEN__ || '';
    let apiBase = window.location.protocol === 'file:' || window.location.protocol === 'tauri:' || window.location.protocol === 'asset:' ? 'http://127.0.0.1:8000' : '';
    async function initTauriBackend() {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try { const port = await window.__TAURI__.core.invoke('get_backend_port'); if (port) apiBase = 'http://127.0.0.1:' + port; } catch (_) {}
      }
      if (!apiToken && apiBase) {
        try {
          const res = await fetch(apiBase + '/api/session');
          if (res.ok) { const data = await res.json(); if (data.token) { apiToken = data.token; window.__PULSE_API_TOKEN__ = data.token; } }
        } catch (_) {}
      }
    }
    initTauriBackend();

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
      timelineView: document.getElementById('timelineView'),
      emptyState: document.getElementById('emptyState'),
      details: document.getElementById('details'),
      quickSearchInput: document.getElementById('quickSearchInput'),
      quickAddBtn: document.getElementById('quickAddBtn'),
      railLibraryBadge: document.getElementById('railLibraryBadge'),
      railLibraryBtn: document.getElementById('railLibraryBtn'),
      railPapersCard: document.getElementById('railPapersCard'),
      railCardList: document.getElementById('railCardList'),
      railCardCount: document.getElementById('railCardCount'),
      railCardOpenBtn: document.getElementById('railCardOpenBtn'),
      colLibrary: document.getElementById('colLibrary'),
      closeLibrarySwipeBtn: document.getElementById('closeLibrarySwipeBtn'),
      libraryParamsBar: document.getElementById('libraryParamsBar'),
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
      autoGemmaExtractionInput: document.getElementById('autoGemmaExtractionInput'),
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
      tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line>',
      list: '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
      search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
      star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
      clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
      'maximize-2': '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>',
      'minimize-2': '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line>',
      'chevron-left': '<polyline points="15 18 9 12 15 6"></polyline>',
      'chevron-right': '<polyline points="9 18 15 12 9 6"></polyline>',
      'arrow-up': '<line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>',
      'arrow-down': '<line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline>'
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
      document.getElementById('aiAgentFab')?.setAttribute('aria-expanded', String(open));
      if (open && typeof refreshPaperAgent === 'function') refreshPaperAgent();
      if (!open) document.getElementById('aiAgentFab')?.focus();
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
