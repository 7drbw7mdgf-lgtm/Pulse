
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

    function runConceptSearch(query) {
      return runDiscoveryPipeline({searchMode:'concept',query:typeof query==='string'?query:state.discoveryResearchQuestion});
    }

    function repeatDiscoverySearch() {
      const context=state.discoveryRunInfo?.get(state.discoveryResultKey)?.runContext||state.discoveryRunContext;
      return context?.searchMode==='concept'?runConceptSearch(context.researchQuestion):runDiscoveryPipeline();
    }

    async function runDiscoveryPipeline(request={}) {
      if (state.discoveryLoading) return;
      const conceptMode=request.searchMode==='concept';
      const query=String(request.query||'').trim() || (typeof parseSearchQuery==='function'?parseSearchQuery(state.discoveryResearchQuestion).tags.join(', '):'');
      const paperMode=conceptMode&&typeof paperSearchReference==='function'&&Boolean(paperSearchReference(query));
      const queryError=!paperMode&&!request.retryBranches&&typeof parseSearchQuery==='function'?parseSearchQuery(state.discoveryResearchQuestion).error:'';
      if(queryError){showToast(queryError);return;}
      const seeds = conceptMode?[]:(request.seedPapers||selectedPapersForRecommendation());
      if (conceptMode&&!query) {showToast('Enter a concept or key phrase to search.');document.getElementById('discoveryResearchQuestion')?.focus();return;}
      if (!conceptMode&&!seeds.length) {
        showToast('Select a paper first to run literature discovery.');
        return;
      }
      const options = {...discoveryConfiguration(),...(request.configuration||{})};
      if(conceptMode)Object.assign(options,{researchQuestion:query,searchMode:'concept',query,bridgeMode:false,depth:'1',includeIterativeChase:false,
        branches:{citationGraph:false,citationNetwork:false,citationCoCitation:false,semanticSearch:false,lexicalSearch:true}});
      if(options.bridgeMode && seeds.length>8){showToast('Select up to eight seed papers for one bridge search.');return;}
      if(options.bridgeMode && new Set(seeds.map(discoveryPaperKey)).size<2){showToast('Select at least two different seed papers to find bridges.');return;}
      if (!Object.values(options.branches).some(Boolean) && !options.fullTextSearch) { showToast('Choose at least one discovery method.'); return; }
      if (!paperMode && options.branches.lexicalSearch && !Object.values(options.searchSources).some(Boolean) && !options.fullTextSearch && !['citationGraph','citationNetwork','citationCoCitation','semanticSearch'].some(method=>options.branches[method])) { showToast('Choose at least one search source.'); return; }
      const key = request.resultKey || (conceptMode?'concept::'+JSON.stringify(options):recommendationKey(seeds));
      const retryBase=request.retryBranches?{records:[...(state.discoveryResultKey===key?state.discoveryResults:state.recommendations.get(key)||[])],info:state.discoveryRunInfo?.get(key)||{}}:null;
      if(request.retryBranches)options.retryBranches=request.retryBranches;
      const displaySeed=conceptMode?{title:query,isConceptQuery:true,isPaperLookup:paperMode}:seeds[0];
      const runContext={researchQuestion:options.researchQuestion,seedPapers:seeds.map(citationPaperPayload),searchMode:conceptMode?'concept':'related',bridgeMode:Boolean(!conceptMode&&options.bridgeMode&&seeds.length>1),configuration:{...options}};
      delete runContext.configuration.retryBranches;
      state.discoveryLoading = true;
      if(typeof PulseSearch!=='undefined')PulseSearch.render();
      state.recommendationLoadingKey = key;
      state.discoveryJobId=null;state.discoveryCancelRequested=false;state.discoveryStopReview=false;state.discoveryProgressText=paperMode?'Looking up this paper…':conceptMode?'Preparing search keywords…':'Searching your selected sources…';state.discoveryProgressPercent=0;
      state.discoveryRunContext=runContext;
      renderDetails();syncDiscoveryControls();
      // Show progress (and the first results) while the slower sources are still searching.
      if(!retryBase&&typeof openDiscoverySearching==='function')openDiscoverySearching(displaySeed,key,options);
      let partial=null;
      try {
        const response = await fetch(backendUrl(paperMode?'/api/search/paper':'/api/discovery/start'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            seedPapers: seeds.map(citationPaperPayload),
            ...options,
            ...(typeof discoveryFeedbackPayload === 'function' ? discoveryFeedbackPayload(seeds,options) : {})
          })
        });
        let data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Discovery pipeline failed.');
        state.discoveryJobId=data.id||null;
        if(state.discoveryCancelRequested&&data.id)await cancelDiscoverySearch();
        while(data.id&&data.status==='running'){
          state.discoveryProgressText=data.stage==='keywords'?(data.searchMode==='bridge'?'Finding what the selected papers share…':'Preparing search keywords…'):(data.stage==='refining'||data.stage==='ranking')?'Refining…':!data.total?'Preparing searches…':`${data.completed||0} of ${data.total} searches complete · ${(data.recommendations||[]).length} candidates`;
          state.discoveryProgressPercent=(data.stage==='refining'||data.stage==='ranking')?95:Math.min(85,85*(data.completed||0)/Math.max(1,data.total||1));syncDiscoveryControls();
          if((data.recommendations||[]).length)partial=data;
          if(!retryBase&&typeof updateDiscoverySearching==='function')updateDiscoverySearching(data);
          await new Promise(resolve=>setTimeout(resolve,650));
          const poll=await fetch(backendUrl('/api/discovery/jobs/'+encodeURIComponent(data.id)),{headers:apiHeaders()});
          data=await poll.json();if(!poll.ok)throw new Error(data.error||'Could not check discovery progress.');
        }
        if(data.status==='cancelled'||state.discoveryCancelRequested){
          // "Stop and review" keeps the results found so far; a plain cancel discards them.
          const kept=(data.recommendations||[]).length?data:partial;
          if(!state.discoveryStopReview||!kept){state.discoverySearching=null;if(!retryBase&&els.discoveryModal&&!els.discoveryModal.hidden)closeDiscoveryModal();showToast(retryBase?'Source retry cancelled. Previous results retained.':'Discovery cancelled.');return;}
          data={...kept,status:'stopped',stoppedEarly:true};
        }
        if(data.status==='failed')throw new Error(data.error||'Discovery search failed.');
        let recs = typeof recordSavedSearchResults==='function'?recordSavedSearchResults(data.recommendations||[],request,data):(data.recommendations||[]);
        const capturedRecords=recs;
        const capturedInfo={...data};
        if(retryBase){
          const seen=new Set(retryBase.records.map(discoveryPaperKey)),fresh=recs.filter(p=>{const id=discoveryPaperKey(p);if(seen.has(id))return false;seen.add(id);return true;});
          recs=[...retryBase.records,...fresh.map(p=>({...p,score:null}))];
          const errors={...(retryBase.info.errors||{})};for(const name of request.retryBranches)delete errors[name];
          const notices={...(retryBase.info.notices||{})};for(const name of request.retryBranches)delete notices[name];
          data={...retryBase.info,...data,sourceCounts:{...retryBase.info.sourceCounts,...data.sourceCounts},errors:{...errors,...data.errors},
            notices:{...notices,...data.notices},
            providerContributions:{...retryBase.info.providerContributions,...data.providerContributions},
            queriesExecuted:{...retryBase.info.queriesExecuted,...data.queriesExecuted},
            branchesExecuted:[...new Set([...(retryBase.info.branchesExecuted||[]),...(data.branchesExecuted||[])])],
            retryNotice:`Source retry added ${fresh.length} papers. Existing order is preserved; run a full search to rank all papers together.`};
        }
        state.discoverySearchErrors ||= new Map();
        state.discoverySearchErrors.set(key,data.errors || {});
        state.recommendations.set(key, recs);
        state.discoveryRunInfo ||= new Map();state.discoveryRunInfo.set(key,{...data,runContext});
        if(typeof PulseScreening!=='undefined')PulseScreening.afterSearch(capturedRecords,capturedInfo,runContext);
        state.discoveryLastRun={key,recommendations:recs,seed:displaySeed};
        if ((retryBase&&state.discoveryResultKey===key)||conceptMode||recommendationKey(selectedPapersForRecommendation()) === key) {
          state.discoveryResultKey=key;state.discoveryRunContext=runContext;
          if(retryBase){state.discoveryResults=recs;renderDiscoveryModal({preservePosition:true});}
          else openDiscoveryModal(recs, displaySeed,key);
        } else if (state.discoverySearching?.key === key) {
          // The selection changed during the search; results stay under "Review results".
          state.discoverySearching = null;
          if (els.discoveryModal && !els.discoveryModal.hidden) closeDiscoveryModal();
        }
        const unavailable=Object.keys(data.errors || {}).length;
        showToast(`Found ${recs.length} ${conceptMode?'matching':'related'} paper${recs.length === 1 ? '' : 's'}${unavailable ? ` · ${unavailable} search source${unavailable===1?'':'s'} reported a problem` : ` for "${compactTitle(displaySeed.title)}"`}.`);
      } catch (error) {
        showToast(error.message);
        if(state.discoverySearching){state.discoverySearching=null;if(!retryBase&&els.discoveryModal&&!els.discoveryModal.hidden)closeDiscoveryModal();}

      } finally {
        state.discoveryLoading = false;state.discoveryStopReview=false;
        if(typeof PulseSearch!=='undefined')PulseSearch.render();
        state.recommendationLoadingKey = null;state.discoveryJobId=null;state.discoveryCancelRequested=false;
        render();syncDiscoveryControls();
      }
    }

    async function cancelDiscoverySearch() {
      if(!state.discoveryLoading)return;
      state.discoveryCancelRequested=true;state.discoveryProgressText='Cancelling…';syncDiscoveryControls();
      if(!state.discoveryJobId)return;
      try{
        const response=await fetch(backendUrl('/api/discovery/cancel'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({id:state.discoveryJobId})});
        if(!response.ok)throw new Error('Could not cancel the search.');
      }catch(error){state.discoveryCancelRequested=false;showToast(error.message);}
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
          ...discoveryConfiguration(),
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
        els.paperViewToggle.hidden = state.libraryFullscreen;
        els.paperViewToggle.textContent = state.paperView === 'compact' ? 'Expanded' : 'Compact';
        const densityLabel = `Show ${state.paperView === 'compact' ? 'expanded' : 'compact'} library view`;
        els.paperViewToggle.setAttribute('aria-label', densityLabel);
        els.paperViewToggle.title = densityLabel;
        els.paperViewToggle.setAttribute('aria-pressed', String(state.paperView === 'expanded'));
      }
    }

    function updateMetrics() {
      const activePapers = typeof activeMapPapers === 'function' ? activeMapPapers() : state.papers;
      const activeIds = new Set(activePapers.map(paper => paper.id));
      const activeLinks = typeof linksForPaperIds === 'function' ? linksForPaperIds(activeIds)
        : state.links.filter(link => activeIds.has(link.source) && activeIds.has(link.target));
      els.emptyState.style.display = activePapers.length ? 'none' : 'grid';
      if (!activePapers.length && state.papers.length > 0) {
        const currentMap = state.maps?.find(m => m.id === state.activeMapId);
        const mapName = currentMap ? currentMap.name : 'This map';
        const emptyTitle = els.emptyState.querySelector('h2');
        const emptyHint = els.emptyState.querySelector('.empty-hint');
        if (emptyTitle) emptyTitle.textContent = `${mapName} is currently blank`;
        if (emptyHint) emptyHint.innerHTML = 'Add papers from your library using the <strong>On map</strong> checkbox or tab selector, or discover new papers.';
      } else if (!state.papers.length) {
        const emptyTitle = els.emptyState.querySelector('h2');
        const emptyHint = els.emptyState.querySelector('.empty-hint');
        if (emptyTitle) emptyTitle.textContent = 'Your map starts with the first paper';
        if (emptyHint) emptyHint.innerHTML = 'Drop paper files here, use <strong>⌘/Ctrl+I</strong> to import, or search for papers above.';
      }
      els.paperCount.textContent = `${state.papers.length} loaded`;
      els.metricPapers.textContent = activePapers.length;
      els.metricLinks.textContent = activeLinks.length;
      els.metricClusters.textContent = activePapers.length ? state.clusters.length : 0;
      if (els.storagePaperCount) {
        els.storagePaperCount.textContent = state.papers.length;
      }
      if (els.storageLinkCount) {
        els.storageLinkCount.textContent = state.links.length;
      }
      if (els.clearButton) {
        els.clearButton.disabled = state.papers.length === 0 || Boolean(state.clearingLibrary);
      }
      if (els.sidebarClearButton) {
        els.sidebarClearButton.hidden = state.papers.length === 0;
      }
      if (els.exportButton) els.exportButton.disabled = state.papers.length === 0;
      if (els.summaryExportButton) els.summaryExportButton.disabled = state.papers.length === 0;
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
        const topologyCount = typeof relationshipIndex === 'function' ? relationshipIndex().topologyCount
          : state.links.filter(link => link.type && link.type !== 'similarity').length;
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
