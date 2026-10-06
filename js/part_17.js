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
