/* Metadata resolution and automatic library enrichment, with lookup caching. */
    const metadataResolutionCache = new Map();
    async function resolvePaperMetadata(paper, options = {}) {
      if (!options.force && (!options.forExport || !paper.doi || paper.metadataVerification?.verified) && paper.metadataMatch?.matched && Date.now() - Date.parse(paper.metadataCheckedAt || '') < 7 * 86400000) return true;
      const payload = {
        name: paper.name, title: paper.title === paper.name && /\.pdf$/i.test(paper.name || '') ? '' : paper.title, authors: paperAuthors(paper), doi: paper.doi || '',
        verifyIdentity: Boolean(options.forExport && paper.doi), citationMatch: paper.citationMatch || null,
        authorDetails:paper.authorDetails || [],referenceAuthorDetails:paper.referenceAuthorDetails || [],
        pmid: paper.pmid || '', year: paper.year || '', date: paper.date || '', journal: paper.journal || '',
        volume: paper.volume || '', issue: paper.issue || '', pages: paper.pages || '', issn: paper.issn || '',
        abstract: paper.abstract || '', keywords: (paper.paperKeywords || []).join('; '),
        text: (options.text || (paper.doi && !options.parseInput ? '' : paper.text || '')).slice(0,12000), parseInput: Boolean(options.parseInput)
      };
      const cacheKey = JSON.stringify(payload);
      if (options.force) metadataResolutionCache.delete(cacheKey);
      try {
        if (!metadataResolutionCache.has(cacheKey)) {
          if (metadataResolutionCache.size >= 128) metadataResolutionCache.delete(metadataResolutionCache.keys().next().value);
          metadataResolutionCache.set(cacheKey, (async () => {
            const response = await fetch(backendUrl('/api/metadata/resolve'), {
              method: 'POST', headers: apiHeaders({'Content-Type':'application/json'}), body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Paper lookup failed.');
            return result;
          })());
        }
        const result = await metadataResolutionCache.get(cacheKey);
        if (!result.matched) metadataResolutionCache.delete(cacheKey);
        applyVerifiedMetadata(paper, result.metadata || {});
        if(result.metadata?.metadataVerification)paper.metadataVerification=result.metadata.metadataVerification;
        if(result.metadata?.publicationDates)paper.publicationDates=result.metadata.publicationDates;
        if (result.matched) paper.metadataCheckedAt = new Date().toISOString();
        paper.metadataSource = result.source || paper.metadataSource;
        paper.metadataMatch = { matched: result.matched, strategy: result.strategy, ambiguous: result.ambiguous,
          score: result.match?.score, candidates: result.candidates || [] };
        paper.metadataNote = result.matched
          ? `Matched using ${result.strategy === 'doi' ? 'DOI' : result.strategy === 'pmid' ? 'PubMed ID' : 'available metadata'} (${result.source}).`
          : result.ambiguous ? 'Several papers match this metadata. Original details kept; add a DOI to identify the paper.'
          : (result.errors || []).length ? 'Online lookup was unavailable. Extracted details kept; retry when the service is available.'
          : 'No confident match found. Extracted details kept; add more metadata or a DOI.';
        return Boolean(result.matched);
      } catch (error) {
        metadataResolutionCache.delete(cacheKey);
        paper.metadataNote = `Lookup unavailable. Extracted details kept: ${error.message}`;
        return false;
      }
    }

    const bibliographicFields = ['title','authors','year','date','journal','doi','pmid','volume','issue','pages','issn','publisher','url','articleNumber','isbn','language','publicationType','abstract'];
    function applyVerifiedMetadata(paper, metadata) {
      const previous = paper.metadataSnapshot;
      const edits = {};
      if (previous) for (const key of bibliographicFields) {
        if (Object.prototype.hasOwnProperty.call(previous, key) && JSON.stringify(paper[key] || '') !== JSON.stringify(previous[key] || '')) edits[key] = paper[key];
      }
      mergeDoiMetadata(paper, metadata);
      const baseline = Object.fromEntries(bibliographicFields.map(key => [key, paper[key] || '']));
      Object.assign(paper, edits);
      const keywords = metadata.paperKeywords || splitKeywords(metadata.keywords || '');
      if (keywords.length) paper.paperKeywords = [...new Set([...(paper.paperKeywords || []), ...keywords])];
      paper.metadataSnapshot = baseline;
    }
    const paperLookupJobs = new WeakMap();
    function lookupPaperOnce(paper, options = {}) {
      if (!paperLookupJobs.has(paper)) {
        const job = resolvePaperMetadata(paper, options).finally(() => paperLookupJobs.delete(paper));
        paperLookupJobs.set(paper, job);
      }
      return paperLookupJobs.get(paper);
    }
    let automaticMetadataRunning = false;
    const automaticMetadataAttempts = new WeakMap();
    async function enrichLibraryAutomatically() {
      if (automaticMetadataRunning || !state.autosaveReady || state.libraryMutation || state.clearingLibrary) return;
      automaticMetadataRunning = true;
      try {
        for (const paper of [...state.papers]) {
          if (state.libraryMutation || state.clearingLibrary) break;
          if (!state.papers.includes(paper)) continue;
          if (paper.metadataMatch?.matched && Date.now() - Date.parse(paper.metadataCheckedAt || '') < 7 * 86400000) continue;
          if (Date.now() - (automaticMetadataAttempts.get(paper) || 0) < 300000) continue;
          automaticMetadataAttempts.set(paper, Date.now());
          await lookupPaperOnce(paper);
          if (state.papers.includes(paper)) render();
        }
      } finally { automaticMetadataRunning = false; }
    }
    async function preparePaperExport(papers) {
      showToast('Checking citation details…');
      let next = 0;
      await Promise.all(Array.from({length: Math.min(2, papers.length)}, async () => {
        while (next < papers.length) await lookupPaperOnce(papers[next++],{forExport:true});
      }));
      if (papers.some(p => state.papers.includes(p))) render();
      const missing = papers.filter(p => !paperAuthors(p).length || !p.year || !p.journal || (!p.pages && !p.articleNumber));
      if (missing.length) showToast(`Citation details checked. ${missing.length} paper${missing.length === 1 ? ' has' : 's have'} details the source did not supply; available metadata will be exported.`);
      return papers;
    }

    function paperMetadataSearchText(paper) {
      return [paper.title, ...paperAuthors(paper), paper.journal, paper.year,
        paper.volume, paper.issue, paper.pages, paper.issn, ...(paper.paperKeywords || []),
        !paper.title ? paper.abstract : ''].filter(Boolean).join(' ').slice(0, 1800);
    }
