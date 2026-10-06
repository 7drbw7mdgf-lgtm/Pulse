/* Shared by the UI and graph worker. Preserve Pulse's scoring and evidence rules. */
(function(scope) {
  function createEngine() {
    const state = {papers: [], links: [], explicitLinks: [], vectors: new Map(), keywords: new Map(), clusters: [], graphSteerKeywords: [], threshold: .01};
    let stopwords = new Set(), contentKey = '', revision = 0;
    let vectorKey='', cachedSimilarities=[], cachedTopology=null;
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
      const nextVectorKey=JSON.stringify([state.papers.map(p=>[p.id,p.title,p.authors,p.year,p.journal,p.abstract,p.paperKeywords,p.text,p.openAlexId,p.openAlexUrl,p.referenceIds,p.citedByIds]),state.graphSteerKeywords]);
      if(nextVectorKey!==vectorKey) {
      vectorKey=nextVectorKey;cachedTopology=null;
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

      cachedSimilarities=[];
      for(let i=0;i<state.papers.length;i++)for(let j=i+1;j<state.papers.length;j++) {
        const source=state.papers[i].id,target=state.papers[j].id,score=cosine(state.vectors.get(source),state.vectors.get(target));
        if(score>=.01)cachedSimilarities.push({source,target,score,type:'similarity'});
      }
      }
      const paperIds = new Set(state.papers.map(paper => paper.id));
      state.explicitLinks = state.explicitLinks.filter(link => paperIds.has(link.source) && paperIds.has(link.target));
      const uniqueLinks = new Map();
      state.explicitLinks.forEach(link => {
        const key = `${pairKey(link.source, link.target)}:${link.type}`;
        const previous = uniqueLinks.get(key);
        if (!previous || link.score > previous.score) uniqueLinks.set(key, link);
      });
      state.explicitLinks = [...uniqueLinks.values()];
      state.links = state.explicitLinks.filter(link => link.score >= state.threshold).map(link => ({ ...link }));
      const existingPairs = new Set(state.links.map(link => pairKey(link.source, link.target)));
      cachedSimilarities.forEach(link=>{
        if(link.score>=state.threshold && !existingPairs.has(pairKey(link.source,link.target)))state.links.push({...link});
      });
      addCitationTopologyEdges();


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
        if (score < state.threshold) return;
        state.links.push(link);
        byPair.set(key, link);
      };

      if(!cachedTopology) {
      const operations=[],record=(...args)=>operations.push(args);
      state.papers.forEach(paper => {
        const references = new Set((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean));
        references.forEach(referenceId => {
          const cited = byOpenAlex.get(referenceId);
          if (cited) record(paper.id, cited.id, 'citation', 0.98, `${compactTitle(paper.title)} cites ${compactTitle(cited.title)}`);
        });
      });

      const referenceSets = new Map(state.papers.map(p=>[p.id,new Set((p.referenceIds||[]).map(normalizeOpenAlexId).filter(Boolean))]));
      const citerSets = new Map(state.papers.map(p=>[p.id,new Set((p.citedByIds||[]).map(normalizeOpenAlexId).filter(Boolean))]));
      const overlap=(a,b)=>{if(!a.size||!b.size)return [];const [small,big]=a.size<b.size?[a,b]:[b,a];return [...small].filter(id=>big.has(id));};
      for (let i = 0; i < state.papers.length; i += 1) {
        for (let j = i + 1; j < state.papers.length; j += 1) {
          const left = state.papers[i];
          const right = state.papers[j];
          const sharedRefs = overlap(referenceSets.get(left.id),referenceSets.get(right.id));
          if (sharedRefs.length) {
            record(left.id, right.id, 'bibliographic', Math.min(0.9, 0.42 + sharedRefs.length * 0.08), `${sharedRefs.length} shared reference${sharedRefs.length === 1 ? '' : 's'}`);
          }
          const sharedCiters = overlap(citerSets.get(left.id),citerSets.get(right.id));
          if (sharedCiters.length) {
            record(left.id, right.id, 'cocitation', Math.min(0.88, 0.38 + sharedCiters.length * 0.08), `${sharedCiters.length} shared citing paper${sharedCiters.length === 1 ? '' : 's'}`);
          }
        }
      }
      cachedTopology=operations;
      }
      cachedTopology.forEach(args=>upsert(...args));
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

    let bouncingNodeId = null;
    let bounceAnimationTimer = null;
    let recenterAnimId = null;
    let isRecenteringAnimation = false;
    let lastNodeClickTime = 0;
    let lastNodeClickId = null;
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
    function analyse(payload) {
      const key = JSON.stringify([payload.papers.map(p => [p.id,p.title,p.authors,p.year,p.journal,p.abstract,p.paperKeywords,p.text,p.openAlexId,p.openAlexUrl,p.referenceIds,p.citedByIds]), payload.explicitLinks, payload.graphSteerKeywords, payload.threshold]);
      state.papers = payload.papers;
      state.explicitLinks = payload.explicitLinks || [];
      state.graphSteerKeywords = payload.graphSteerKeywords || [];
      stopwords = new Set(payload.stopwords);
      if (key !== contentKey) {
        state.threshold = payload.threshold;
        calculateRelatedness();
        contentKey = key;
        revision++;
      }

      return {links: state.links, clusters: findClusters(), vectors: [...state.vectors].map(([id,v]) => [id,[...v]]), keywords: [...state.keywords], explicitLinks: state.explicitLinks, revision};
    }
    return {analyse};
  }
  scope.PulseGraph = {createEngine};
  if (typeof module !== 'undefined') module.exports = scope.PulseGraph;
})(typeof self !== 'undefined' ? self : globalThis);
