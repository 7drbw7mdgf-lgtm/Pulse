
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
          state.links.push({
            source: seed.id,
            target: paper.id,
            score: 0.88,
            type: item.subType === 'Bibliographic coupling' ? 'bibliographic' : 'cocitation',
            evidence: item.reason || 'Citation network triangulation'
          });
        } else if (direction === 'chase') {
          state.links.push({
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

    async function runDiscoveryPipeline() {
      const seeds = selectedPapersForRecommendation();
      if (!seeds.length) {
        showToast('Select a paper first to run literature discovery.');
        return;
      }
      const key = recommendationKey(seeds);
      state.discoveryLoading = true;
      state.recommendationLoadingKey = key;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/discovery/pipeline'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            seedPapers: seeds.map(citationPaperPayload),
            branches: state.discoveryBranches,
            depth: state.explorationDepth,
            steerKeywords: state.recommendationSteerKeywords,
            excludeKeywords: state.recommendationExcludeKeywords,
            recencyTilt: state.recommendationRecencyTilt,
            impactTilt: state.recommendationImpactTilt,
            iterativeChase: true,
            limit: 50
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Discovery pipeline failed.');
        const recs = data.recommendations || [];
        state.recommendations.set(key, recs);
        state.discoveryResults = recs;
        state.discoverySeed = seeds[0];
        openDiscoveryModal(recs, seeds[0]);
        showToast(`Literature discovery surfaced ${recs.length} papers. Review and choose papers to add in the popup.`);
      } catch (error) {
        showToast(error.message);
        state.recommendations.set(key, [{ title: 'Discovery search failed', reason: error.message }]);
      } finally {
        state.discoveryLoading = false;
        state.recommendationLoadingKey = null;
        render();
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
        state.links.push({
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

      els.emptyState.style.display = state.papers.length ? 'none' : 'grid';
      els.paperCount.textContent = `${state.papers.length} loaded`;
      els.metricPapers.textContent = state.papers.length;
      els.metricLinks.textContent = state.links.length;
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
      } finally {
        window.setTimeout(() => setLoadProgress(0, 0), 700);
      }
    }
