// Pulse Domain Module Manifest & Loader
// Maps numbered slices (part_01..part_24) and feature modules to explicit domain boundaries.
(function() {
  const DOMAIN_MANIFEST = [
    { domain: "core-state", src: "js/part_01.js", owns: ["state", "els", "featherPaths", "navigation"] },
    { domain: "map-tabs", src: "js/map-tabs.js", owns: ["mapTabs"] },
    { domain: "paper-links", src: "js/paper-links.js", owns: ["paperExternalLinks"] },
    { domain: "discovery-cards", src: "js/part_02.js", owns: ["discoveryCardRendering", "relevanceReview"] },
    { domain: "collection-filters", src: "js/part_03.js", owns: ["tagFilters", "discoveredSelection"] },
    { domain: "theme-and-status", src: "js/part_04.js", owns: ["theme", "saveStatus", "providerStatus"] },
    { domain: "settings-persistence", src: "js/part_05.js", owns: ["settingsModal", "apiKeys"] },
    { domain: "paper-parser", src: "js/part_06.js", owns: ["risBibtexCsvParser", "doiExtraction"] },
    { domain: "citation-extraction", src: "js/part_07.js", owns: ["keywords", "inTextCitationExtraction"] },
    { domain: "graph-engine-core", src: "graph-engine.js", owns: ["PulseGraphEngine"] },
    { domain: "graph-similarity-scoring", src: "js/part_08.js", owns: ["tokenize", "paperNormalization", "similarityEdges"] },
    { domain: "graph-layout-state", src: "js/part_09.js", owns: ["graphNodes", "clusters", "forceSimulation"] },
    { domain: "graph-runtime", src: "js/graph-runtime.js", owns: ["graphCanvasLoop", "workerBridge"] },
    { domain: "graph-canvas-renderer", src: "js/part_10.js", owns: ["drawGraph", "nodeColors", "edgeRendering"] },
    { domain: "graph-viewport-controls", src: "js/part_11.js", owns: ["zoomFit", "pan", "exportSvgPng"] },
    { domain: "recommendation-seeds", src: "js/part_12.js", owns: ["selectedPapersForRecommendation", "edgeDetails"] },
    { domain: "selection-and-steering", src: "js/part_13.js", owns: ["paperSelection", "recommendationSteering"] },
    { domain: "library-list-renderer", src: "js/part_14.js", owns: ["renderPapers", "shortAuthorList", "bibliographyColumns"] },
    { domain: "map-interactions", src: "js/map-interactions.js", owns: ["lassoSelect", "canvasContextActions"] },
    { domain: "keyboard-and-dialogs", src: "js/part_15.js", owns: ["shortcuts", "keywordModal", "tagContextMenu"] },
    { domain: "reference-managers", src: "js/part_23.js", owns: ["zoteroMendeley", "relationsDialog", "recordExport"] },
    { domain: "mendeley-sync", src: "js/mendeley-sync.js", owns: ["mendeleyAutoSync"] },
    { domain: "library-bulk-mutations", src: "js/part_24.js", owns: ["bulkActions", "libraryMutationRequest"] },
    { domain: "library-sync", src: "js/library-sync.js", owns: ["encryptedVaultSync"] },
    { domain: "sync-and-reports", src: "js/sync-and-reports.js", owns: ["syncUi", "crashReportUi"] },
    { domain: "discovery-controls", src: "js/discovery-controls.js", owns: ["ribbonControls", "methodToggles"] },
    { domain: "publication-status", src: "js/publication-status.js", owns: ["retractionPreprintChecks"] },
    { domain: "inspector-shell", src: "js/inspector.js", owns: ["inspectorTabs", "pdfPreview"] },
    { domain: "inspector-details", src: "js/part_16.js", owns: ["renderDetails", "inspectorSections"] },
    { domain: "citation-enrichment", src: "js/part_17.js", owns: ["citationPaperPayload", "metadataEnrichment"] },
    { domain: "discovery-pipeline", src: "js/part_18.js", owns: ["runDiscoveryPipeline", "updateMetrics"] },
    { domain: "discovery-review", src: "js/discovery-review.js", owns: ["discoveryFeedback"] },
    { domain: "library-persistence", src: "js/part_19.js", owns: ["saveLibrary", "loadLibrary", "clearLibrary", "exportImport"] },
    { domain: "citation-lookup", src: "js/citation-lookup.js", owns: ["citationLookupDialog"] },
    { domain: "paper-intake", src: "js/part_20.js", owns: ["addPaperFromInput", "fileDropImport"] },
    { domain: "timeline", src: "js/timeline.js", owns: ["timelineView"] },
    { domain: "trends-core", src: "js/trends.js", owns: ["trendsAnalysis"] },
    { domain: "trends-groups", src: "js/trends-groups.js", owns: ["trendsGrouping"] },
    { domain: "trends-map", src: "js/trends-map.js", owns: ["trendsMapOverlay"] },
    { domain: "trends-view", src: "js/trends-view.js", owns: ["trendsCharts"] },
    { domain: "trends-page", src: "js/trends-page.js", owns: ["trendsPageController"] },
    { domain: "connection-diagnostics", src: "js/connection-diagnostics.js", owns: ["connectionChecks"] },
    { domain: "search-workflow", src: "js/search-workflow.js", owns: ["guidedSearch"] },
    { domain: "research-evidence", src: "js/research-evidence.js", owns: ["passageRetrieval", "citationVerification"] },
    { domain: "screening", src: "js/screening.js", owns: ["prismaScreening"] },
    { domain: "research-search", src: "js/research-search.js", owns: ["booleanSearch", "savedSearches"] },
    { domain: "app-updates", src: "js/app-updates.js", owns: ["desktopUpdater"] },
    { domain: "settings-options", src: "js/settings-options.js", owns: ["settingsTabs"] },
    { domain: "network-search", src: "js/network-search.js", owns: ["citationChase", "networkTriangulation"] },
    { domain: "workspace-tools", src: "js/workspace-tools.js", owns: ["workspaceBackupRestore"] },
    { domain: "library-tools", src: "js/library-tools.js", owns: ["duplicateDetection", "batchTagging"] },
    { domain: "pdf-reader", src: "js/pdf-reader.js", owns: ["pdfViewer"] },
    { domain: "pdf-editor-ui", src: "js/pdf-editor-ui.js", owns: ["pdfAnnotations"] },
    { domain: "map-toolbar", src: "js/map-toolbar.js", owns: ["canvasToolbar"] },
    { domain: "compact-workspace", src: "js/compact-workspace.js", owns: ["compactMode"] },
    { domain: "workspace-bootstrap", src: "js/part_21.js", owns: ["eventBindings", "appInit"] },
    { domain: "selected-report", src: "js/part_22.js", owns: ["selectedPapersSynthesisReport"] },
  ];

  if (typeof window !== "undefined") {
    window.PulseDomainManifest = DOMAIN_MANIFEST;
  }

  if (typeof document !== "undefined" && !document.querySelector('script[src^="js/part_01.js"]')) {
    for (const entry of DOMAIN_MANIFEST) {
      const s = document.createElement("script");
      s.src = entry.src;
      s.async = false;
      s.dataset.pulseDomain = entry.domain;
      document.head.appendChild(s);
    }
  }
})();
