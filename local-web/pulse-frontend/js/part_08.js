
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

    function normalizeImportedPaper(paper, source) {
      return {
        id: paper.id || uid(),
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
        openAlexUrl: paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${normalizeOpenAlexId(paper.openAlexId)}` : ''),
        referenceIds: dedupeList((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByIds: dedupeList((paper.citedByIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByCount: Number.isFinite(paper.citedByCount) ? paper.citedByCount : null,
        s2PaperId: paper.s2PaperId || '',
        citationMetrics: paper.citationMetrics || null,
        text: String(paper.text || paper.abstract || '').slice(0, 120000),
        size: Number(paper.size || 0),
        x: Number(paper.x || 0),
        y: Number(paper.y || 0),
        color: paper.color || '',
        areaId: paper.areaId || '',
        metadataSource: paper.metadataSource || source
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
        if (result.matched) paper.metadataCheckedAt = new Date().toISOString();
        paper.metadataSource = result.source || 'DOI';
        return true;
      } catch (error) {
        paper.metadataNote = `DOI lookup unavailable: ${error.message}`;
        return false;
      }
    }

    function mergeDoiMetadata(paper, metadata) {
      if (metadata.title) paper.title = metadata.title;
      if ((metadata.authors || []).length) paper.authors = paperAuthors(metadata);
      if (metadata.date) paper.date = metadata.date;
      if (metadata.year) paper.year = metadata.year;
      if (metadata.journal) paper.journal = metadata.journal;
      if (metadata.doi) paper.doi = normalizeDoi(metadata.doi);
      if (metadata.doiVerified !== undefined) paper.doiVerified = Boolean(metadata.doiVerified);
      for (const field of ['pmid', 'volume', 'issue', 'pages', 'issn', 'publisher', 'url', 'articleNumber', 'isbn', 'language', 'publicationType']) {
        if (metadata[field]) paper[field] = String(metadata[field]);
      }
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

    function tokenize(text) {
      const tokens = (text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .map(token => token.replace(/^-+|-+$/g, ''))
        .filter(token => token.length > 2 && token.length < 32 && !stopwords.has(token) && !/^\d+$/.test(token));

      const grams = [];
      for (let index = 0; index < tokens.length - 1; index += 1) {
        if (!stopwords.has(tokens[index]) && !stopwords.has(tokens[index + 1])) {
          grams.push(`${tokens[index]} ${tokens[index + 1]}`);
        }
      }

      return tokens.concat(grams.filter(gram => gram.length < 42));
    }

    function calculateRelatedness() {
      const graphSteerTerms = dedupeList(state.graphSteerKeywords.flatMap(term => tokenize(term))).slice(0, 24);
      const docs = state.papers.map(paper => ({
        id: paper.id,
        tokens: tokenize(`${paper.title} ${(paper.authors || []).join(' ')} ${paper.year || ''} ${paper.journal || ''} ${paper.abstract || ''} ${(paper.paperKeywords || []).join(' ')} ${paper.text}`)
      }));
      const docFreq = new Map();
      docs.forEach(doc => new Set(doc.tokens).forEach(term => docFreq.set(term, (docFreq.get(term) || 0) + 1)));

      state.vectors.clear();
      state.keywords.clear();
      const documentCount = Math.max(docs.length, 1);

      docs.forEach(doc => {
        const counts = new Map();
        doc.tokens.forEach(term => counts.set(term, (counts.get(term) || 0) + 1));
        graphSteerTerms.forEach(term => {
          if (counts.has(term)) counts.set(term, counts.get(term) + 6);
        });
        const vector = new Map();
        let norm = 0;
        counts.forEach((count, term) => {
          const tf = 1 + Math.log(count);
          const idf = Math.log((1 + documentCount) / (1 + (docFreq.get(term) || 0))) + 1;
          const weight = tf * idf;
          vector.set(term, weight);
          norm += weight * weight;
        });

        const normalized = new Map();
        const divisor = Math.sqrt(norm) || 1;
        vector.forEach((weight, term) => normalized.set(term, weight / divisor));
        state.vectors.set(doc.id, normalized);
        state.keywords.set(doc.id, [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([term]) => term));
      });

      state.links = [];
      for (let i = 0; i < state.papers.length; i += 1) {
        for (let j = i + 1; j < state.papers.length; j += 1) {
          const source = state.papers[i].id;
          const target = state.papers[j].id;
          const score = cosine(state.vectors.get(source), state.vectors.get(target));
          if (score >= state.threshold) state.links.push({ source, target, score, type: 'similarity' });
        }
      }
      addCitationTopologyEdges();

      state.clusters = findClusters();
    }

    function addCitationTopologyEdges() {
      const byOpenAlex = new Map(state.papers.map(paper => [normalizeOpenAlexId(paper.openAlexId || paper.openAlexUrl || ''), paper]).filter(([id]) => id));
      const byPair = new Map(state.links.map(link => [pairKey(link.source, link.target), link]));
      const upsert = (source, target, type, score, evidence = '') => {
        if (!source || !target || source === target) return;
        const key = pairKey(source, target);
        const existing = byPair.get(key);
        const rank = { similarity: 0, cocitation: 1, bibliographic: 2, citation: 3, mixed: 4 };
        if (existing) {
          existing.score = Math.max(existing.score || 0, score);
          existing.evidence = dedupeList([existing.evidence, evidence].filter(Boolean)).join(' | ');
          if (existing.type !== type) existing.type = rank[type] > rank[existing.type] ? type : (rank[type] === rank[existing.type] ? existing.type : 'mixed');
          return;
        }
        const link = { source, target, score, type, evidence };
        state.links.push(link);
        byPair.set(key, link);
      };

      state.papers.forEach(paper => {
        const references = new Set((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean));
        references.forEach(referenceId => {
          const cited = byOpenAlex.get(referenceId);
          if (cited) upsert(paper.id, cited.id, 'citation', 0.98, `${compactTitle(paper.title)} cites ${compactTitle(cited.title)}`);
        });
      });

      for (let i = 0; i < state.papers.length; i += 1) {
        for (let j = i + 1; j < state.papers.length; j += 1) {
          const left = state.papers[i];
          const right = state.papers[j];
          const sharedRefs = intersectIds(left.referenceIds, right.referenceIds);
          if (sharedRefs.length) {
            upsert(left.id, right.id, 'bibliographic', Math.min(0.9, 0.42 + sharedRefs.length * 0.08), `${sharedRefs.length} shared reference${sharedRefs.length === 1 ? '' : 's'}`);
          }
          const sharedCiters = intersectIds(left.citedByIds, right.citedByIds);
          if (sharedCiters.length) {
            upsert(left.id, right.id, 'cocitation', Math.min(0.88, 0.38 + sharedCiters.length * 0.08), `${sharedCiters.length} shared citing paper${sharedCiters.length === 1 ? '' : 's'}`);
          }
        }
      }
    }

    function pairKey(source, target) {
      return [source, target].sort().join('__');
    }

    function intersectIds(left = [], right = []) {
      const rightSet = new Set((right || []).map(normalizeOpenAlexId).filter(Boolean));
      return dedupeList((left || []).map(normalizeOpenAlexId).filter(id => id && rightSet.has(id)));
    }

    function cosine(a, b) {
      if (!a || !b) return 0;
      let score = 0;
      const [small, large] = a.size < b.size ? [a, b] : [b, a];
      small.forEach((weight, term) => { score += weight * (large.get(term) || 0); });
      return score;
    }

    function findClusters() {
      const adjacency = new Map(state.papers.map(paper => [paper.id, new Set()]));
      state.links.forEach(link => {
        adjacency.get(link.source)?.add(link.target);
        adjacency.get(link.target)?.add(link.source);
      });

      const clusters = [];
      const seen = new Set();
      state.papers.forEach(paper => {
        if (seen.has(paper.id)) return;
        const stack = [paper.id];
        const group = [];
        seen.add(paper.id);
        while (stack.length) {
          const id = stack.pop();
          group.push(id);
          adjacency.get(id)?.forEach(next => {
            if (!seen.has(next)) {
              seen.add(next);
              stack.push(next);
            }
          });
        }
        clusters.push(group);
      });
      return clusters;
    }
    const metadataResolutionCache = new Map();
    async function resolvePaperMetadata(paper, options = {}) {
      if (!options.force && paper.metadataMatch?.matched && Date.now() - Date.parse(paper.metadataCheckedAt || '') < 7 * 86400000) return true;
      const payload = {
        name: paper.name, title: paper.title === paper.name && /\.pdf$/i.test(paper.name || '') ? '' : paper.title, authors: paperAuthors(paper), doi: paper.doi || '',
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
        while (next < papers.length) await lookupPaperOnce(papers[next++]);
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
