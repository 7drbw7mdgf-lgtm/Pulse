/* Shared exact graph calculations for the UI fallback and graph worker. */
(function(scope) {
  function dedupeList(values) {
    const seen = new Set();
    const result = [];
    values.forEach(value => {
      const key = String(value || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(String(value).trim());
    });
    return result;
  }

  function normalizeOpenAlexId(value) {
    const match = String(value || '').match(/\bW\d+\b/i);
    return match ? match[0].toUpperCase() : '';
  }

  function compactTitle(title) {
    const words = title.replace(/\s+/g, ' ').trim();
    return words.length > 34 ? `${words.slice(0, 31)}...` : words;
  }

  function pairKey(source, target) {
    return [source, target].sort().join('__');
  }

  function cosine(a, b) {
    if (!a || !b) return 0;
    let score = 0;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    small.forEach((weight, term) => { score += weight * (large.get(term) || 0); });
    return score;
  }

  function findClusters(papers, links) {
    const adjacency = new Map(papers.map(paper => [paper.id, new Set()]));
    links.forEach(link => {
      adjacency.get(link.source)?.add(link.target);
      adjacency.get(link.target)?.add(link.source);
    });
    const clusters = [];
    const seen = new Set();
    papers.forEach(paper => {
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

  function createEngine() {
    let vectorKey = null;
    let topologyKey = null;
    let hasAnalysis = false;
    let lastThreshold;
    let clusterKey = null;
    let similarities = [];
    let topology = [];
    let vectors = [];
    let keywords = [];
    let links = [];
    let clusters = [];
    let revision = 0;
    const stats = {vectorBuilds: 0, similarityBuilds: 0, pairScores: 0, topologyBuilds: 0, clusterBuilds: 0};

    function buildVectors(papers, graphSteerKeywords, stopwordValues) {
      const stopwords = new Set(stopwordValues);
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
      const graphSteerTerms = dedupeList(graphSteerKeywords.flatMap(term => tokenize(term))).slice(0, 24);
      const docs = papers.map(paper => ({
        id: paper.id,
        tokens: tokenize(`${paper.title} ${(paper.authors || []).join(' ')} ${paper.year || ''} ${paper.journal || ''} ${paper.abstract || ''} ${(paper.paperKeywords || []).join(' ')} ${paper.text}`)
      }));
      const docFreq = new Map();
      docs.forEach(doc => new Set(doc.tokens).forEach(term => docFreq.set(term, (docFreq.get(term) || 0) + 1)));
      const vectorMap = new Map();
      const keywordMap = new Map();
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
        vectorMap.set(doc.id, normalized);
        keywordMap.set(doc.id, [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([term]) => term));
      });
      similarities = [];
      for (let i = 0; i < papers.length; i += 1) {
        for (let j = i + 1; j < papers.length; j += 1) {
          const source = papers[i].id;
          const target = papers[j].id;
          // Keep zero scores too: changing the threshold never changes scoring.
          similarities.push({source, target, score: cosine(vectorMap.get(source), vectorMap.get(target)), type: 'similarity'});
          stats.pairScores += 1;
        }
      }
      vectors = [...vectorMap].map(([id, vector]) => [id, [...vector]]);
      keywords = [...keywordMap];
      stats.vectorBuilds += 1;
      stats.similarityBuilds += 1;
    }

    function buildTopology(papers) {
      const operations = [];
      const record = (...args) => operations.push(args);
      const byOpenAlex = new Map(papers.map(paper => [normalizeOpenAlexId(paper.openAlexId || paper.openAlexUrl || ''), paper]).filter(([id]) => id));
      const referenceSets = new Map(papers.map(paper => [paper.id, new Set((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean))]));
      const citerSets = new Map(papers.map(paper => [paper.id, new Set((paper.citedByIds || []).map(normalizeOpenAlexId).filter(Boolean))]));
      papers.forEach(paper => {
        referenceSets.get(paper.id).forEach(referenceId => {
          const cited = byOpenAlex.get(referenceId);
          if (cited) record(paper.id, cited.id, 'citation', 0.98, `${compactTitle(paper.title)} cites ${compactTitle(cited.title)}`);
        });
      });
      const overlapCount = (a, b) => {
        const [small, large] = a.size < b.size ? [a, b] : [b, a];
        let count = 0;
        small.forEach(id => { if (large.has(id)) count += 1; });
        return count;
      };
      for (let i = 0; i < papers.length; i += 1) {
        for (let j = i + 1; j < papers.length; j += 1) {
          const left = papers[i];
          const right = papers[j];
          const sharedRefs = overlapCount(referenceSets.get(left.id), referenceSets.get(right.id));
          if (sharedRefs) {
            record(left.id, right.id, 'bibliographic', Math.min(0.9, 0.42 + sharedRefs * 0.08), `${sharedRefs} shared reference${sharedRefs === 1 ? '' : 's'}`);
          }
          const sharedCiters = overlapCount(citerSets.get(left.id), citerSets.get(right.id));
          if (sharedCiters) {
            record(left.id, right.id, 'cocitation', Math.min(0.88, 0.38 + sharedCiters * 0.08), `${sharedCiters} shared citing paper${sharedCiters === 1 ? '' : 's'}`);
          }
        }
      }
      topology = operations;
      stats.topologyBuilds += 1;
    }

    function analyse(payload) {
      const papers = payload.papers || [];
      const graphSteerKeywords = payload.graphSteerKeywords || [];
      const stopwords = [...(payload.stopwords || [])];
      const threshold = payload.threshold ?? 0.05;
      const nextVectorKey = JSON.stringify([papers.map(paper => [paper.id, paper.title, paper.authors, paper.year, paper.journal, paper.abstract, paper.paperKeywords, paper.text]), graphSteerKeywords, stopwords]);
      const nextTopologyKey = JSON.stringify(papers.map(paper => [paper.id, paper.title, paper.openAlexId, paper.openAlexUrl, paper.referenceIds, paper.citedByIds]));
      const vectorsChanged = nextVectorKey !== vectorKey;
      const topologyChanged = nextTopologyKey !== topologyKey;
      if (vectorsChanged) {
        buildVectors(papers, graphSteerKeywords, stopwords);
        vectorKey = nextVectorKey;
      }
      if (topologyChanged) {
        buildTopology(papers);
        topologyKey = nextTopologyKey;
      }
      if (!hasAnalysis || vectorsChanged || topologyChanged || !Object.is(threshold, lastThreshold)) {
        links = similarities.filter(link => link.score >= threshold).map(link => ({...link}));
        const byPair = new Map(links.map(link => [pairKey(link.source, link.target), link]));
        const rank = {similarity: 0, cocitation: 1, bibliographic: 2, citation: 3, mixed: 4};
        topology.forEach(([source, target, type, score, evidence]) => {
          if (!source || !target || source === target) return;
          const key = pairKey(source, target);
          const existing = byPair.get(key);
          if (existing) {
            existing.score = Math.max(existing.score || 0, score);
            existing.evidence = dedupeList([existing.evidence, evidence].filter(Boolean)).join(' | ');
            if (existing.type !== type) existing.type = rank[type] > rank[existing.type] ? type : (rank[type] === rank[existing.type] ? existing.type : 'mixed');
            return;
          }
          // Citation evidence remains visible even below the similarity threshold.
          const link = {source, target, score, type, evidence};
          links.push(link);
          byPair.set(key, link);
        });
        const nextClusterKey = JSON.stringify([papers.map(paper => paper.id), links.map(link => [link.source, link.target])]);
        if (nextClusterKey !== clusterKey) {
          clusters = findClusters(papers, links);
          clusterKey = nextClusterKey;
          stats.clusterBuilds += 1;
        }
        hasAnalysis = true;
        lastThreshold = threshold;
        revision += 1;
      }
      return {
        links: links.map(link => ({...link})),
        clusters: clusters.map(cluster => [...cluster]),
        vectors: vectors.map(([id, vector]) => [id, vector.map(entry => [...entry])]),
        keywords: keywords.map(([id, terms]) => [id, [...terms]]),
        revision,
        stats: {...stats}
      };
    }
    return {analyse};
  }

  // Pure force layout. The caller supplies active papers; other layout modes stay in the UI.
  function layout({papers, links, width, height, spacing = 1}) {
    const nodes = papers.map(paper => ({id: paper.id, x: paper.x, y: paper.y, pinnedPosition: paper.pinnedPosition}));
    if (!nodes.length) return [];
    spacing = spacing || 1;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(80, Math.min(width, height) * 0.34 * spacing);
    nodes.forEach((paper, index) => {
      if (!Number.isFinite(paper.x) || !Number.isFinite(paper.y)) {
        const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1) - Math.PI / 2;
        paper.x = centerX + Math.cos(angle) * radius;
        paper.y = centerY + Math.sin(angle) * radius;
      }
    });
    const byId = new Map(nodes.map(paper => [paper.id, paper]));
    const gravity = 0.0028 / Math.max(1, spacing * 0.75);
    const spanX = (width / 2 - 80) * Math.max(1, spacing);
    const spanY = (height / 2 - 70) * Math.max(1, spacing);
    for (let tick = 0; tick < 58; tick += 1) {
      const forces = new Map(nodes.map(paper => [paper.id, {x: 0, y: 0}]));
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.max(45, Math.hypot(dx, dy));
          const push = (1600 * spacing * spacing) / (distance * distance);
          const forceA = forces.get(a.id);
          const forceB = forces.get(b.id);
          forceA.x += (dx / distance) * push;
          forceA.y += (dy / distance) * push;
          forceB.x -= (dx / distance) * push;
          forceB.y -= (dy / distance) * push;
          const minX = 120 * spacing;
          const minY = 54 * spacing;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx < minX && absDy < minY) {
            const repelX = (minX - absDx) * 0.08 * (dx >= 0 ? 1 : -1);
            const repelY = (minY - absDy) * 0.12 * (dy >= 0 ? 1 : -1);
            forceA.x += repelX;
            forceA.y += repelY;
            forceB.x -= repelX;
            forceB.y -= repelY;
          }
        }
      }
      links.forEach(link => {
        const a = byId.get(link.source);
        const b = byId.get(link.target);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const topologyBoost = link.type && link.type !== 'similarity' ? 0.32 : 0;
        const desired = (270 * spacing) - link.score * 105 - topologyBoost * 46;
        const pull = (distance - desired) * 0.0038 * (0.52 + link.score + topologyBoost);
        const forceA = forces.get(a.id);
        const forceB = forces.get(b.id);
        forceA.x += (dx / distance) * pull;
        forceA.y += (dy / distance) * pull;
        forceB.x -= (dx / distance) * pull;
        forceB.y -= (dy / distance) * pull;
      });
      nodes.forEach(paper => {
        const force = forces.get(paper.id);
        if (!force || paper.pinnedPosition) return;
        force.x += (centerX - paper.x) * gravity;
        force.y += (centerY - paper.y) * gravity;
        paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x + force.x));
        paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y + force.y));
      });
    }
    return nodes.map(({id, x, y}) => ({id, x, y}));
  }

  scope.PulseGraph = {createEngine, layout};
  if (typeof module !== 'undefined') module.exports = scope.PulseGraph;
})(typeof self !== 'undefined' ? self : globalThis);
