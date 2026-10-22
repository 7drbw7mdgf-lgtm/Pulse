/* Relatedness scoring between papers, citation topology edges and clusters. */
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

    let relatednessRevision = 0;
    let relatednessFallbackKey = '';
    function calculateRelatedness(options = {}) {
      if (typeof ensureGraphAnalysis === 'function') return ensureGraphAnalysis(options);
      // Standalone/minimal-script hosts retain the same synchronous behavior.
      const key = JSON.stringify([state.papers.map(paper => [paper.id,paper.title,paper.authors,paper.year,paper.journal,paper.abstract,paper.paperKeywords,paper.text,paper.openAlexId,paper.openAlexUrl,paper.referenceIds,paper.citedByIds]),state.graphSteerKeywords,state.threshold,[...stopwords]]);
      if (key === relatednessFallbackKey) return;
      calculateRelatednessLegacy();
      relatednessFallbackKey = key;
      relatednessRevision += 1;
      state.graphAnalysisRevision = relatednessRevision;
    }

    function calculateRelatednessLegacy() {
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
