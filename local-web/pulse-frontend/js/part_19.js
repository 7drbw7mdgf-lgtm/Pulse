
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

    function serializeMap() {
      return {
        selectedId: state.selectedId, centerId: state.centerId, selectedAreaId: state.selectedAreaId,
        format: 'pulse-map',
        version: '1.0',
        generatedAt: new Date().toISOString(),
        threshold: state.threshold,
        mode: state.mode,
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
          selected: paper.selected !== false,
          title: paper.title,
          name: paper.name,
          authors: paper.authors || [],
          date: paper.date || '',
          year: paper.year || '',
          journal: paper.journal || '',
          doi: paper.doi || '',
          doiVerified: Boolean(paper.doiVerified), pmid: paper.pmid || '',
          volume: paper.volume || '', issue: paper.issue || '', pages: paper.pages || '', issn: paper.issn || '',
          metadataMatch: paper.metadataMatch || null,
          openAlexId: paper.openAlexId || '',
          openAlexUrl: paper.openAlexUrl || '',
          referenceIds: paper.referenceIds || [],
          citedByIds: paper.citedByIds || [],
          citedByCount: paper.citedByCount ?? null,
          s2PaperId: paper.s2PaperId || '',
          citationMetrics: paper.citationMetrics || null,
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
        links: state.links.map(link => ({ ...link, score: Number(link.score.toFixed(4)) })),
        clusters: state.clusters
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
      state.mode = data.mode || 'network';
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
      }, source));
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

    async function saveLibrary() {
      if (!state.autosaveReady) return;
      if (state.papers.length) state.allowEmptySave = false;
      const payload = {
        ...serializeMap(),
        paperView: state.paperView,
        centerId: state.centerId,
        selectedId: state.selectedId,
        selectedAreaId: state.selectedAreaId,
        allowEmpty: state.allowEmptySave === true
      };
      try {
        localStorage.setItem('pulse-autosave-library', JSON.stringify(payload));
      } catch (e) {}
      updateSaveStatePill('Saving...');
      try {
        const write = fetch(backendUrl('/api/library'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000)
        });
        state.pendingLibraryWrites ||= new Set();
        state.pendingLibraryWrites.add(write);
        try {
          const response = await write;
          if (!response.ok) throw new Error('The library could not be saved.');
        } finally { state.pendingLibraryWrites.delete(write); }
        updateSaveStatePill('Saved');
        setTimeout(() => updateSaveStatePill('Ready'), 1800);
      } catch {
        updateSaveStatePill('Not saved');
      }
    }

    function saveLibrarySync() {
      if (!state.autosaveReady) return;
      if (state.papers.length) state.allowEmptySave = false;
      const payload = {
        ...serializeMap(),
        paperView: state.paperView,
        centerId: state.centerId,
        selectedId: state.selectedId,
        selectedAreaId: state.selectedAreaId,
        allowEmpty: state.allowEmptySave === true
      };
      try {
        localStorage.setItem('pulse-autosave-library', JSON.stringify(payload));
      } catch (e) {}
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          navigator.sendBeacon(backendUrl('/api/library'), blob);
        }
      } catch (e) {}
    }

    async function promptClearLibrary() {
      const count = state.papers.length;
      if (!count) {
        showToast('Library is already empty.');
        return;
      }
      const confirmed = await confirmClearPapers(count);
      if (!confirmed) return;
      await clearAppToDefault(true);
    }

    function confirmClearPapers(count) {
      const dialog = document.getElementById('clearPapersDialog');
      if (dialog.open) return Promise.resolve(false);
      document.getElementById('clearPapersTitle').textContent = `Clear all ${count} paper${count === 1 ? '' : 's'}?`;
      const cancel = document.getElementById('clearPapersCancel');
      const confirm = document.getElementById('clearPapersConfirm');
      return new Promise(resolve => {
        const finish = value => {
          dialog.close();
          cancel.removeEventListener('click', onCancel);
          confirm.removeEventListener('click', onConfirm);
          dialog.removeEventListener('cancel', onEscape);
          els.clearButton?.focus();
          resolve(value);
        };
        const onCancel = () => finish(false);
        const onConfirm = () => finish(true);
        const onEscape = event => { event.preventDefault(); finish(false); };
        cancel.addEventListener('click', onCancel);
        confirm.addEventListener('click', onConfirm);
        dialog.addEventListener('cancel', onEscape);
        dialog.showModal();
        cancel.focus();
      });
    }
