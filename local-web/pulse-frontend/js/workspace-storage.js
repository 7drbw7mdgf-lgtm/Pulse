/* Workspace serialisation, map export/import and library restore. */
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

    const libraryBibliographyCache = new WeakMap();
    function libraryBibliographyText(paper) {
      const text = paper.text || '', supplied = paper.bibliographyText || '';
      const previous = libraryBibliographyCache.get(paper);
      if (previous && previous.text === text && previous.supplied === supplied) return previous.value;
      const value = supplied || extractBibliographyText(text);
      libraryBibliographyCache.set(paper, {text, supplied, value});
      return value;
    }

    function serializeMap() {
      return {
        selectedId: state.selectedId, centerId: state.centerId, selectedAreaId: state.selectedAreaId,
        format: 'pulse-map',
        version: '1.0',
        mendeleyIgnored: state.mendeleyIgnored || [], mendeleySyncPaused: Boolean(state.mendeleySyncPaused),
        generatedAt: new Date().toISOString(),
        threshold: state.threshold,
        mode: state.mode,
        paperView: state.paperView,
        librarySortKey: state.librarySortKey, librarySortAsc: Boolean(state.librarySortAsc),
        filterTags: state.filterTags || [],
        filterMode: state.filterMode || 'all',
        recommendationSteerKeywords: state.recommendationSteerKeywords,
        recommendationExcludeKeywords: state.recommendationExcludeKeywords,
        recommendationAuthors: state.recommendationAuthors,
        recommendationJournals: state.recommendationJournals,
        graphSteerKeywords: state.graphSteerKeywords,
        discoveryBranches: { ...state.discoveryBranches },
        discoverySearchSources: { ...state.discoverySearchSources },
        discoveryDepth: state.discoveryDepth || '1',
        discoveryLimit: state.discoveryLimit || 200,
        discoveryResearchQuestion: state.discoveryResearchQuestion || '',
        savedSearches: state.savedSearches || [], discoverySearchTags: state.discoverySearchTags || [],
        libraryFeatures: state.libraryFeatures || {},
        discoveryQueryMatch: state.discoveryQueryMatch || 'all', discoveryRankingMode: state.discoveryRankingMode || 'fast',
        discoverySearchScope: state.discoverySearchScope || 'online', librarySearchTerms: state.librarySearchTerms || null, readingQueueOnly: Boolean(state.readingQueueOnly),
        discoveryStrictExclusions: state.discoveryStrictExclusions || [],
        discoveryDiversify: state.discoveryDiversify !== false,
        discoveryBridgeMode: Boolean(state.discoveryBridgeMode), discoveryAiTriage: Boolean(state.discoveryAiTriage), discoveryFastEmbed: Boolean(state.discoveryFastEmbed), discoveryFullTextSearch: Boolean(state.discoveryFullTextSearch),
        discoveryJudgements: state.discoveryJudgements || [],
        recommendationRecencyTilt: state.recommendationRecencyTilt,
        recommendationImpactTilt: state.recommendationImpactTilt,
        graphStyle: { ...state.graphStyle },
        view: { ...state.view },
        areas: state.areas.map(area => ({ ...area })),
        papers: state.papers.map(paper => ({
          id: paper.id,
          addedAt: paper.addedAt || '',
          syncId: paper.syncId || '',
          selected: paper.selected !== false,
          title: paper.title,
          name: paper.name,
          bibliographyText: libraryBibliographyText(paper),
          evidencePassages: paper.evidencePassages || [],
          field:paper.field||'',primaryTopic:paper.primaryTopic||null,
          referenceText: String(paper.referenceText || '').slice(0,12000), citationMatch: paper.citationMatch || null, bibliographyParent: paper.bibliographyParent || null,
          metadataVerification: paper.metadataVerification || null, publicationDates: paper.publicationDates || {},
          publicationStatus:paper.publicationStatus||null,preprint:paper.preprint||null,publicationRelations:paper.publicationRelations||[],publicationNotices:paper.publicationNotices||[],publicationRole:paper.publicationRole||'',isRetracted:paper.isRetracted===true,
          authorDetails:paper.authorDetails || [],referenceAuthorDetails:paper.referenceAuthorDetails || [], referenceEntries:paper.referenceEntries || [], bibliographyProvenance:paper.bibliographyProvenance || null,
          authors: paper.authors || [],
          date: paper.date || '',
          year: paper.year || '',
          journal: paper.journal || '',
          doi: paper.doi || '',
          doiVerified: Boolean(paper.doiVerified), pmid: paper.pmid || '',
          pmcid: paper.pmcid || '', coreId: paper.coreId || '', europePmcId: paper.europePmcId || '',
          fullTextUrl: paper.fullTextUrl || '', fullTextLinks: paper.fullTextLinks || [],
          sourceList: paper.sourceList || [], sourceIdentifiers: paper.sourceIdentifiers || {},
          citationCountSource: paper.citationCountSource || '', citationCountsBySource: paper.citationCountsBySource || {},
          discoveryMethod: paper.discoveryMethod || '', dbef: paper.dbef || null,
          authorRole: paper.authorRole || '', authorTrajectoryLabel: paper.authorTrajectoryLabel || '', authorTrajectoryName: paper.authorTrajectoryName || '',
          volume: paper.volume || '', issue: paper.issue || '', pages: paper.pages || '', issn: paper.issn || '',
          publisher: String(paper.publisher || ''), url: String(paper.url || ''), articleNumber: String(paper.articleNumber || ''), isbn: String(paper.isbn || ''), language: String(paper.language || ''), publicationType: String(paper.publicationType || ''),
        metadataCheckedAt: paper.metadataCheckedAt || '', metadataSnapshot: paper.metadataSnapshot || null, mendeleySource: paper.mendeleySource || null,
          metadataMatch: paper.metadataMatch || null,
          openAlexId: paper.openAlexId || '',
          openAlexUrl: paper.openAlexUrl || '',
          referenceIds: paper.referenceIds || [],
          citedByIds: paper.citedByIds || [],
          citedByCount: paper.citedByCount ?? null,
          s2PaperId: paper.s2PaperId || '',
          citationMetrics: paper.citationMetrics || null,
          citationContexts: Array.isArray(paper.citationContexts) ? paper.citationContexts.slice(0, 3) : [],
          citationIntents: Array.isArray(paper.citationIntents) ? paper.citationIntents.slice(0, 3) : [],
          isInfluentialCitation: Boolean(paper.isInfluentialCitation),
          abstract: paper.abstract || '',
          paperKeywords: paper.paperKeywords || [],
          gemmaKeywords: paper.gemmaKeywords || [],
          keyFindings: paper.keyFindings || [],
          organisms: paper.organisms || [],
          techniques: paper.techniques || [],
          discoveryTerms: paper.discoveryTerms || [],
          keywords: displayKeywords(paper),
          color: paper.color || '',
          areaId: paper.areaId || '',
          mapIds: Array.isArray(paper.mapIds) ? paper.mapIds : (paper.mapId ? [paper.mapId] : []),
          mapId: paper.mapId || '',
          readingStatus: paper.readingStatus || '', relevance: paper.relevance || '',
          notes: paper.notes || '', userTags: paper.userTags || [],
          tags:paper.tags||[],mergedAliases:paper.mergedAliases||[],pdfAttachments:paper.pdfAttachments||[],pdfAnnotations:paper.pdfAnnotations||[],pdfQuotes:paper.pdfQuotes||[],
          text: paper.text || '',
          size: paper.size || 0,
          x: paper.x || 0,
          y: paper.y || 0,
          metadataSource: paper.metadataSource || '',
          metadataNote: paper.metadataNote || ''
        })),
        maps: state.maps || [{ id: 'map-1', name: 'Map 1' }],
        activeMapId: state.activeMapId || 'map-1',
        links: state.links.map(link => ({ ...link, score: Number(link.score.toFixed(4)) })),
        clusters: state.clusters
      };
    }

    async function exportMap() {
      await preparePaperExport([...state.papers]);
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
      resetLibrarySaveBaseline();
      state.mendeleyIgnored = Array.isArray(data.mendeleyIgnored) ? data.mendeleyIgnored : [];
      state.mendeleySyncPaused = Boolean(data.mendeleySyncPaused);
      state.syncEpoch = (state.syncEpoch || 0) + 1;
      state.threshold = Math.min(0.75, Math.max(0.01, Number(data.threshold || 0.05)));
      els.threshold.value = Math.round(state.threshold * 100);
      state.mode = data.mode || 'network';
      state.paperView = data.paperView || state.paperView || 'compact';
      if (['title','group','authors','year','addedAt','journal','citations'].includes(data.librarySortKey)) state.librarySortKey=data.librarySortKey;
      if (typeof data.librarySortAsc==='boolean') state.librarySortAsc=data.librarySortAsc;
      state.mapCameraCheck=true;
      state.filterTags = Array.isArray(data.filterTags) ? data.filterTags : [];
      state.filterMode = data.filterMode || 'all';
      state.recommendationSteerKeywords = parseSteerKeywords(listText(data.recommendationSteerKeywords));
      state.recommendationExcludeKeywords = parseSteerList(listText(data.recommendationExcludeKeywords), 16);
      state.recommendationAuthors = parseSteerList(listText(data.recommendationAuthors), 10);
      state.recommendationJournals = parseSteerList(listText(data.recommendationJournals), 10);
      state.graphSteerKeywords = parseSteerList(listText(data.graphSteerKeywords), 12);
      state.discoveryBranches = Object.fromEntries(['citationGraph','citationNetwork','citationCoCitation','semanticSearch','lexicalSearch'].map(key => [key,data.discoveryBranches?.[key] !== false]));
      state.discoverySearchSources = Object.fromEntries(['semanticScholar','europePmc','core','arxiv'].map(key => [key,data.discoverySearchSources?.[key] !== false]));
      state.discoveryDepth = ['1','2','3','iterative'].includes(String(data.discoveryDepth)) ? String(data.discoveryDepth) : '1';
      state.discoveryLimit = [50,100,200,500,1000,2000].includes(Number(data.discoveryLimit)) ? Number(data.discoveryLimit) : 200;
      state.discoveryResearchQuestion = String(data.discoveryResearchQuestion || '').slice(0,1000);
      if(typeof restoreResearchWorkflow==='function')restoreResearchWorkflow(data);
      if(typeof PulseLibraryTools!=='undefined')PulseLibraryTools.restore(data.libraryFeatures);
      state.discoveryStrictExclusions = Array.isArray(data.discoveryStrictExclusions) ? data.discoveryStrictExclusions.slice(0,16) : [];
      state.discoveryDiversify = data.discoveryDiversify !== false;
      state.discoveryBridgeMode = Boolean(data.discoveryBridgeMode);state.discoveryAiTriage = data.discoveryAiTriage !== undefined ? Boolean(data.discoveryAiTriage) : false;state.discoveryFastEmbed = data.discoveryFastEmbed !== undefined ? Boolean(data.discoveryFastEmbed) : true;state.discoveryFullTextSearch = Boolean(data.discoveryFullTextSearch);
      state.discoveryJudgements = Array.isArray(data.discoveryJudgements) ? data.discoveryJudgements.slice(-1000) : [];
      state.recommendationRecencyTilt = Number(data.recommendationRecencyTilt || 0);
      state.recommendationImpactTilt = Number(data.recommendationImpactTilt || 0);
      if (data.graphStyle && typeof data.graphStyle === 'object') {
        state.graphStyle = {
          ...state.graphStyle,
          nodeSize: Math.max(14, Math.min(42, Number(data.graphStyle.nodeSize || state.graphStyle.nodeSize))),
          edgeScale: Math.max(0.25, Math.min(1.8, Number(data.graphStyle.edgeScale || state.graphStyle.edgeScale))),
          spacing: Math.max(0.7, Math.min(1.65, Number(data.graphStyle.spacing || state.graphStyle.spacing))),
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
      }, source, { existing: true }));
      if (Array.isArray(data.maps) && data.maps.length > 0) {
        state.maps = data.maps.map((m, i) => ({ id: m.id || `map-${i+1}`, name: m.name || `Map ${i+1}` }));
        state.activeMapId = data.activeMapId && state.maps.some(m => m.id === data.activeMapId) ? data.activeMapId : state.maps[0].id;
      } else {
        state.maps = [{ id: 'map-1', name: 'Map 1' }];
        state.activeMapId = 'map-1';
      }
      if (typeof renderMapTabs === 'function') renderMapTabs();
      state.allowEmptySave = false;
      document.querySelectorAll('[data-mode]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.mode === state.mode);
      });
      syncDensityButtons();
      return true;
    }

    async function restoreLibrary() {
      await backendReady;
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
              state.mendeleyIgnored = data.mendeleyIgnored || [];
              state.mendeleySyncPaused = Boolean(data.mendeleySyncPaused);
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
