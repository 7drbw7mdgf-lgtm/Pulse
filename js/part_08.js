
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
        if (!title) return null;
        return normalizeImportedPaper({
          name: `${name} row ${index + 2}`,
          title,
          authors: splitAuthors(get(['authors', 'author', 'creators'])),
          date: get(['date', 'publication date', 'year']),
          year: (get(['year', 'date']).match(/\b(19|20)\d{2}\b/) || [''])[0],
          journal: get(['journal', 'publication', 'source', 'container-title']),
          doi: normalizeDoi(get(['doi', 'DOI'])),
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
        doi: normalizeDoi(paper.doi || ''),
        pmid: String(paper.pmid || ''),
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
        citedByCount: Number(paper.citedByCount || 0),
        influentialCitationCount: paper.influentialCitationCount,
        text: String(paper.text || paper.abstract || '').slice(0, 120000),
        size: Number(paper.size || 0),
        x: Number(paper.x || 0),
        y: Number(paper.y || 0),
        color: paper.color || '',
        areaId: paper.areaId || '',
        s2PaperId: paper.s2PaperId || '',
        url: paper.url || '',
        openAccessPdf: paper.openAccessPdf || '',
        metadataNote: paper.metadataNote || '',
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
        if (!ok && before === after && !paper.doi) paper.doi = doi;
      }
    }

    async function enrichPaperFromDoi(paper, doiOverride = '') {
      const doi = normalizeDoi(doiOverride || paper.doi || '');
      if (!doi) return false;
      try {
        const response = await fetch(backendUrl('/api/metadata/doi'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ doi, expectedTitle: paper.title || paper.name || '' })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'DOI lookup failed.');
        paper.doi = result.doi || doi;
        mergeDoiMetadata(paper, result.metadata || {});
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
      if (metadata.doi) paper.doi = metadata.doi;
      for (const key of ['pmid','s2PaperId','url','openAccessPdf','influentialCitationCount']) { if (metadata[key] !== undefined) paper[key] = metadata[key]; }
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
      if (metadata.citedByCount) paper.citedByCount = Number(metadata.citedByCount || 0);
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

    let relatednessKey = '';
    let relatednessRevision = 0;
    const paperAnalysisKeys = new WeakMap();
    function analysisKey() {
      const records = state.papers.map(paper => {
        const values = [paper.id,paper.title,(paper.authors||[]).join('|'),paper.year,paper.journal,paper.abstract,(paper.paperKeywords||[]).join('|'),paper.text,paper.doi,paper.openAlexId,JSON.stringify(paper.referenceIds||[]),JSON.stringify(paper.citedByIds||[])];
        const cached = paperAnalysisKeys.get(paper);
        if (cached && cached.values.every((value,index)=>value===values[index])) return cached.key;
        const key = JSON.stringify(values);paperAnalysisKeys.set(paper,{values,key});return key;
      });
      return JSON.stringify([records,state.threshold,state.graphSteerKeywords,state.explicitLinks]);
    }
    function calculateRelatedness() {
      const key = analysisKey();
      if (key === relatednessKey) return;
      relatednessRevision += 1;
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
      relatednessKey = analysisKey();
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
