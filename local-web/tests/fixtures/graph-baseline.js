/* Original desktop scoring retained for parity. Layout reference corrects the pre-existing vertical-repulsion sign typo. */
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

    let bouncingNodeId = null;
    let bounceAnimationTimer = null;
    let recenterAnimId = null;
    let isRecenteringAnimation = false;
    let lastNodeClickTime = 0;
    let lastNodeClickId = null;

    function layout(width, height) {
      const papers = typeof activeMapPapers === 'function' ? activeMapPapers() : state.papers;
      if (!papers.length) return;
      if (isRecenteringAnimation) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const radius = Math.max(80, Math.min(width, height) * 0.34 * spacing);

      // Ensure every active paper has valid finite coordinates before mode layout
      papers.forEach((paper, index) => {
        if (!Number.isFinite(paper.x) || !Number.isFinite(paper.y)) {
          const angle = (Math.PI * 2 * index) / Math.max(papers.length, 1) - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        }
      });

      if (state.centerId && layoutCenteredPaper(width, height, centerX, centerY)) return;

      if (state.mode === 'radial') {
        papers.forEach((paper, index) => {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        });
        return;
      }

      if (state.mode === 'clusters') {
        const clusterRadius = Math.max(65, Math.min(width, height) * 0.18 * spacing);
        const activePaperMap = new Map(papers.map(p => [p.id, p]));
        state.clusters.forEach((cluster, clusterIndex) => {
          const angle = (Math.PI * 2 * clusterIndex) / Math.max(state.clusters.length, 1) - Math.PI / 2;
          const cx = centerX + Math.cos(angle) * radius * 0.72;
          const cy = centerY + Math.sin(angle) * radius * 0.72;
          const activeClusterPapers = cluster.map(id => activePaperMap.get(id)).filter(Boolean);
          activeClusterPapers.forEach((paper, index) => {
            const localAngle = (Math.PI * 2 * index) / Math.max(activeClusterPapers.length, 1);
            const cDist = Math.min(clusterRadius, 60 + activeClusterPapers.length * 18);
            paper.x = cx + Math.cos(localAngle) * cDist;
            paper.y = cy + Math.sin(localAngle) * cDist;
          });
        });
        return;
      }

      for (let tick = 0; tick < 58; tick += 1) {
        const forces = new Map(papers.map(paper => [paper.id, { x: 0, y: 0 }]));

        for (let i = 0; i < papers.length; i += 1) {
          for (let j = i + 1; j < papers.length; j += 1) {
            const a = papers[i];
            const b = papers[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distance = Math.max(45, Math.hypot(dx, dy));
            const push = (1600 * spacing * spacing) / (distance * distance);
            const forceA = forces.get(a.id);
            const forceB = forces.get(b.id);
            if (forceA) {
              forceA.x += (dx / distance) * push;
              forceA.y += (dy / distance) * push;
            }
            if (forceB) {
              forceB.x -= (dx / distance) * push;
              forceB.y -= (dy / distance) * push;
            }

            // Extra anti-collision repulsion specifically for horizontal text labels
            const minX = 120 * spacing;
            const minY = 54 * spacing;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx < minX && absDy < minY) {
              const repelX = (minX - absDx) * 0.08 * (dx >= 0 ? 1 : -1);
              const repelY = (minY - absDy) * 0.12 * (dy >= 0 ? 1 : -1);
              if (forceA) {
                forceA.x += repelX;
                forceA.y += repelY;
              }
              if (forceB) {
                forceB.x -= repelX;
                forceB.y -= repelY;
              }
            }
          }
        }

        state.links.forEach(link => {
          const a = papers.find(paper => paper.id === link.source);
          const b = papers.find(paper => paper.id === link.target);
          if (!a || !b) return;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const topologyBoost = link.type && link.type !== 'similarity' ? 0.32 : 0;
          const desired = (270 * spacing) - link.score * 105 - topologyBoost * 46;
          const pull = (distance - desired) * 0.0038 * (0.52 + link.score + topologyBoost);
          const forceA = forces.get(a.id);
          const forceB = forces.get(b.id);
          if (forceA) {
            forceA.x += (dx / distance) * pull;
            forceA.y += (dy / distance) * pull;
          }
          if (forceB) {
            forceB.x -= (dx / distance) * pull;
            forceB.y -= (dy / distance) * pull;
          }
        });

        const gravity = 0.0028 / Math.max(1, spacing * 0.75);
        const spanX = (width / 2 - 80) * Math.max(1, spacing);
        const spanY = (height / 2 - 70) * Math.max(1, spacing);
        papers.forEach(paper => {
          const force = forces.get(paper.id);
          if (!force || paper.pinnedPosition) return;
          force.x += (centerX - paper.x) * gravity;
          force.y += (centerY - paper.y) * gravity;
          paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x + force.x));
          paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y + force.y));
        });
      }
    }

    function layoutCenteredPaper(width, height, centerX, centerY) {
      const activePapers = typeof activeMapPapers === 'function' ? activeMapPapers() : state.papers;
      const focus = activePapers.find(paper => paper.id === state.centerId);
      if (!focus) {
        state.centerId = null;
        return false;
      }

      const activeSet = new Set(activePapers.map(p => p.id));
      const linked = state.links
        .filter(link => (link.source === focus.id && activeSet.has(link.target)) || (link.target === focus.id && activeSet.has(link.source)))
        .sort((a, b) => b.score - a.score);
      const neighborIds = linked.map(link => link.source === focus.id ? link.target : link.source);
      const neighborSet = new Set(neighborIds);
      const neighbors = neighborIds
        .map(id => activePapers.find(paper => paper.id === id))
        .filter(Boolean);
      const others = activePapers.filter(paper => paper.id !== focus.id && !neighborSet.has(paper.id));
      const shortestSide = Math.min(width, height);
      const spacing = state.graphStyle.spacing || 1;
      const innerRadius = Math.max(120, Math.min(shortestSide * 0.25, 260)) * spacing;
      const outerRadius = Math.max(innerRadius + 120, Math.min(shortestSide * 0.42, 430) * spacing);

      focus.x = centerX;
      focus.y = centerY;
      // Papers the user placed (dragged or dropped from the Library) keep their position.
      const unpinned = list => list.filter(paper => !paper.pinnedPosition);
      placePaperRing(unpinned(neighbors), centerX, centerY, innerRadius, -Math.PI / 2);
      const looseOthers = unpinned(others);
      placePaperRing(looseOthers, centerX, centerY, outerRadius, -Math.PI / 2 + Math.PI / Math.max(looseOthers.length, 2));
      constrainPapers(width, height);
      return true;
    }

    function placePaperRing(papers, centerX, centerY, radius, offset) {
      papers.forEach((paper, index) => {
        const angle = offset + (Math.PI * 2 * index) / Math.max(papers.length, 1);
        paper.x = centerX + Math.cos(angle) * radius;
        paper.y = centerY + Math.sin(angle) * radius;
      });
    }

    function constrainPapers(width, height) {
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const spanX = (width / 2 - 80) * Math.max(1, spacing);
      const spanY = (height / 2 - 70) * Math.max(1, spacing);
      const activePapers = typeof activeMapPapers === 'function' ? activeMapPapers() : state.papers;
      activePapers.forEach(paper => {
        if (paper.pinnedPosition) return;  // A user-placed paper stays where it was put.
        if (!Number.isFinite(paper.x) || !Number.isFinite(paper.y)) return;
        paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x));
        paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y));
      });
    }
