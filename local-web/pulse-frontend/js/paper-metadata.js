/* Paper import normalisation, CSV parsing and DOI metadata enrichment. */
/* bioRxiv/medRxiv details kept with a paper: server, posted version, category and licence. */
function preprintDetails(value){
  if(!value||typeof value!=='object'||!['bioRxiv','medRxiv'].includes(value.server))return null;
  const text=(item,limit)=>String(item||'').slice(0,limit);
  return {server:value.server,version:text(value.version,6).replace(/\D/g,''),versions:Math.max(0,Math.min(999,Number(value.versions)||0)),category:text(value.category,80),license:text(value.license,40),postedDate:text(value.postedDate,10)};
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
        if (!title && !get(['doi','url','link','pmid','authors','author'])) return null;
        return normalizeImportedPaper({
          name: `${name} row ${index + 2}`,
          title,
          authors: splitAuthors(get(['authors', 'author', 'creators'])),
          date: get(['date', 'publication date', 'year']),
          year: (get(['year', 'date']).match(/\b(19|20)\d{2}\b/) || [''])[0],
          journal: get(['journal', 'publication', 'source', 'container-title']),
          doi: normalizeDoi(get(['doi', 'DOI', 'url', 'link'])),
          pmid: get(['pmid', 'pubmed id']), volume: get(['volume']), issue: get(['issue', 'number']),
          pages: get(['pages', 'page']), issn: get(['issn']), publisher: get(['publisher']), url: get(['url','link']), articleNumber: get(['articlenumber','article number']), isbn: get(['isbn']), language: get(['language']),
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

    function normalizeImportedPaper(paper, source, { existing = false } = {}) {
      const added = paper.addedAt || paper.dateAdded || paper.importedAt;
      const addedTime = typeof added === 'string' ? Date.parse(added) : NaN;
      return {
        id: paper.id || uid(),
        addedAt: Number.isFinite(addedTime) ? new Date(addedTime).toISOString() : (existing ? '' : new Date().toISOString()),
        selected: paper.selected !== false,
        name: paper.name || source,
        title: cleanField(paper.title || paper.name || 'Untitled paper'),
        authors: paperAuthors(paper),
        date: cleanField(paper.date || ''),
        year: cleanField(paper.year || (String(paper.date || '').match(/\b(19|20)\d{2}\b/) || [''])[0]),
        journal: cleanField(paper.journal || ''),
        doi: normalizeDoi(paper.doi || paper.DOI || '') || findPrimaryDoi(paper.url || '', paper.text || ''),
        doiVerified: Boolean(paper.doiVerified),
        pmid: String(paper.pmid || ''),
        pmcid: String(paper.pmcid || ''), coreId: String(paper.coreId || ''), europePmcId: String(paper.europePmcId || ''),
        fullTextUrl: safeHref(paper.fullTextUrl || ''),
        fullTextLinks: (Array.isArray(paper.fullTextLinks) ? paper.fullTextLinks : []).filter(link=>link && safeHref(link.url)).map(link=>({...link,url:safeHref(link.url)})),
        sourceList: Array.isArray(paper.sourceList) ? paper.sourceList : [], sourceIdentifiers: paper.sourceIdentifiers || {},
        citationCountsBySource: paper.citationCountsBySource || {}, citationCountSource: paper.citationCountSource || '',
        volume: String(paper.volume || ''), issue: String(paper.issue || ''), pages: String(paper.pages || ''), issn: String(paper.issn || ''),
        publisher: String(paper.publisher || ''), url: String(paper.url || ''), articleNumber: String(paper.articleNumber || ''), isbn: String(paper.isbn || ''), language: String(paper.language || ''), publicationType: String(paper.publicationType || ''),
        metadataCheckedAt: paper.metadataCheckedAt || '', metadataSnapshot: paper.metadataSnapshot || null, mendeleySource: paper.mendeleySource || null,
        metadataNote: paper.metadataNote || '',
        metadataMatch: paper.metadataMatch || null,
        abstract: cleanAbstract(paper.abstract || ''),
        paperKeywords: Array.isArray(paper.paperKeywords) ? paper.paperKeywords : splitKeywords(paper.paperKeywords || paper.keywords || ''),
        gemmaKeywords: Array.isArray(paper.gemmaKeywords) ? paper.gemmaKeywords : splitKeywords(paper.gemmaKeywords || ''),
        keyFindings: Array.isArray(paper.keyFindings) ? paper.keyFindings.slice(0, 5) : [],
        organisms: Array.isArray(paper.organisms) ? paper.organisms.slice(0, 16) : splitKeywords(paper.organisms || ''),
        techniques: Array.isArray(paper.techniques) ? paper.techniques.slice(0, 16) : splitKeywords(paper.techniques || ''),
        discoveryTerms: Array.isArray(paper.discoveryTerms) ? paper.discoveryTerms.slice(0, 24) : splitKeywords(paper.discoveryTerms || ''),
        openAlexId: normalizeOpenAlexId(paper.openAlexId || paper.openAlexUrl || ''),
        field: paper.field || '', primaryTopic: paper.primaryTopic || null,
        openAlexUrl: paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${normalizeOpenAlexId(paper.openAlexId)}` : ''),
        referenceIds: dedupeList((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByIds: dedupeList((paper.citedByIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByCount: Number.isFinite(paper.citedByCount ?? paper.citationCount) ? (paper.citedByCount ?? paper.citationCount) : null,
        s2PaperId: paper.s2PaperId || '',
        citationMetrics: paper.citationMetrics || null,
        citationContexts: Array.isArray(paper.citationContexts) ? paper.citationContexts.map(s => String(s || '').trim().slice(0, 300)).filter(Boolean).slice(0, 3) : [],
        citationIntents: Array.isArray(paper.citationIntents) ? paper.citationIntents.map(s => String(s || '').trim()).filter(Boolean).slice(0, 3) : [],
        isInfluentialCitation: Boolean(paper.isInfluentialCitation),
        discoveryMethod: paper.rankingMethod || paper.discoveryMethod || '',
        dbef: paper.dbef && typeof paper.dbef === 'object' ? paper.dbef : null,
        authorRole: ['first', 'last'].includes(paper.authorRole) ? paper.authorRole : '',
        authorTrajectoryLabel: ['Same senior author', 'Same first author'].includes(paper.authorTrajectoryLabel) ? paper.authorTrajectoryLabel : '',
        authorTrajectoryName: cleanField(paper.authorTrajectoryName || ''),
        text: String(paper.text || paper.abstract || '').slice(0, 120000),
        evidencePassages: Array.isArray(paper.evidencePassages) ? paper.evidencePassages.slice(0,2000) : [],
        bibliographyText: String(paper.bibliographyText || (typeof extractBibliographyText==='function'?extractBibliographyText(paper.text || ''):'')).slice(0,120000),
        referenceText: String(paper.referenceText || '').slice(0,12000), citationMatch: paper.citationMatch || null, bibliographyParent: paper.bibliographyParent || null,
        metadataVerification: paper.metadataVerification || null, publicationDates: paper.publicationDates || {},
        publicationStatus:paper.publicationStatus||null,preprint:typeof preprintDetails==='function'?preprintDetails(paper.preprint):paper.preprint||null,publicationRelations:paper.publicationRelations||[],publicationNotices:paper.publicationNotices||[],publicationRole:paper.publicationRole||'',isRetracted:paper.isRetracted===true,
        authorDetails: paper.authorDetails || [], referenceAuthorDetails:paper.referenceAuthorDetails || [], referenceEntries:paper.referenceEntries || [], bibliographyProvenance:paper.bibliographyProvenance || null,
        size: Number(paper.size || 0),
        x: Number(paper.x || 0),
        y: Number(paper.y || 0),
        color: paper.color || '',
        areaId: paper.areaId || '',
        readingStatus: ['to-read', 'reading', 'read'].includes(paper.readingStatus) ? paper.readingStatus : '',
        relevance: ['relevant', 'not-relevant'].includes(paper.relevance) ? paper.relevance : '',
        notes: String(paper.notes || ''),
        userTags: (Array.isArray(paper.userTags) ? paper.userTags : splitKeywords(paper.userTags || '')).map(tag => cleanField(String(tag)).slice(0, 60)).filter(Boolean),
        tags:Array.isArray(paper.tags)?paper.tags:[],mergedAliases:Array.isArray(paper.mergedAliases)?paper.mergedAliases:[],
        pdfAttachments:Array.isArray(paper.pdfAttachments)?paper.pdfAttachments:[],pdfAnnotations:Array.isArray(paper.pdfAnnotations)?paper.pdfAnnotations:[],pdfQuotes:Array.isArray(paper.pdfQuotes)?paper.pdfQuotes:[],
        mapIds: Array.isArray(paper.mapIds) ? [...paper.mapIds] : (paper.mapId ? [paper.mapId] : (paper.selected !== false ? [state.maps?.[0]?.id || 'map-1'] : [])),
        mapId: paper.mapId || '',
        metadataSource: paper.metadataSource || source,
        // Links copies of this paper on the user's other Macs (library sync).
        syncId: /^[0-9a-f]{32}$/.test(paper.syncId || '') ? paper.syncId : ''
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
        // Failed candidates must never become a paper's identifier.
      }
    }

    async function enrichPaperFromDoi(paper, doiOverride = '') {
      const doi = normalizeDoi(doiOverride || paper.doi || '');
      if (!doi) return false;
      try {
        const titleCand = (paper.title || '').trim();
        const isPlaceholder = !titleCand || titleCand.toLowerCase().endsWith('.pdf') || titleCand === (paper.name || '') || titleCand.toLowerCase().startsWith('untitled') || titleCand.split(/\s+/).length < 3;
        const expectedTitle = isPlaceholder ? '' : titleCand;
        const response = await fetch(backendUrl('/api/metadata/doi'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ doi, expectedTitle })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'DOI lookup failed.');
        paper.doi = result.doi || doi;
        paper.doiVerified = true;
        applyVerifiedMetadata(paper, result.metadata || {});
        if(result.metadata?.metadataVerification)paper.metadataVerification=result.metadata.metadataVerification;
        if(result.metadata?.publicationDates)paper.publicationDates=result.metadata.publicationDates;
        if (result.matched) paper.metadataCheckedAt = new Date().toISOString();
        paper.metadataSource = result.source || 'DOI';
        return true;
      } catch (error) {
        paper.metadataNote = `DOI lookup unavailable: ${error.message}`;
        return false;
      }
    }

    function mergeDoiMetadata(paper, metadata) {
      for(const field of ['publicationStatus','publicationRelations','publicationNotices','publicationRole','authorDetails'])if(metadata[field]!==undefined)paper[field]=metadata[field];
      if(metadata.isRetracted===true)paper.isRetracted=true;
      if(metadata.preprint)paper.preprint=preprintDetails(metadata.preprint);
      if (metadata.title) paper.title = metadata.title;
      if ((metadata.authors || []).length) paper.authors = paperAuthors(metadata);
      if (metadata.date) paper.date = metadata.date;
      if (metadata.year) paper.year = metadata.year;
      if (metadata.journal) paper.journal = metadata.journal;
      if (metadata.doi) paper.doi = normalizeDoi(metadata.doi);
      if (metadata.doiVerified !== undefined) paper.doiVerified = Boolean(metadata.doiVerified);
      for (const field of ['pmid', 'pmcid', 'coreId', 'europePmcId', 'volume', 'issue', 'pages', 'issn', 'publisher', 'url', 'articleNumber', 'isbn', 'language', 'publicationType']) {
        if (metadata[field]) paper[field] = String(metadata[field]);
      }
      if(safeHref(metadata.fullTextUrl || ''))paper.fullTextUrl=safeHref(metadata.fullTextUrl);
      if(Array.isArray(metadata.fullTextLinks))paper.fullTextLinks=metadata.fullTextLinks.filter(link=>link && safeHref(link.url)).map(link=>({...link,url:safeHref(link.url)}));
      if(metadata.sourceList)paper.sourceList=[...new Set([...(paper.sourceList || []),...metadata.sourceList])];
      if(metadata.sourceIdentifiers)paper.sourceIdentifiers={...(paper.sourceIdentifiers || {}),...metadata.sourceIdentifiers};
      if(metadata.citationCountsBySource)paper.citationCountsBySource={...(paper.citationCountsBySource || {}),...metadata.citationCountsBySource};
      if(metadata.citationCountSource)paper.citationCountSource=metadata.citationCountSource;
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
      if (Number.isFinite(metadata.citedByCount)) paper.citedByCount = metadata.citedByCount;
      if (metadata.s2PaperId) paper.s2PaperId = metadata.s2PaperId;
    }
