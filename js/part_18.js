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
