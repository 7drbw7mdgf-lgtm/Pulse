/* Topic groups for the Trends page: concept communities from the graph analysis, every paper placed, labelled from keywords. */
(scope => {
  const STOPWORDS = `a about above across after again against all almost alone along already also although always among an and another any
    are around as at be because been before being below between both but by can cannot could did do does done due during
    each either enough especially etc for found from further had has have having here how however i if in into is it its
    itself just less may might more most mostly must no nor not of often on only or other our out over paper papers per
    perhaps prior quite rather really regarding same should show showed shown shows since so some such than that the their
    them then there therefore these they this those through to toward under until up upon use used using very was we were
    what when where whether which while who whose will with within without would study studies results result data
    analysis method methods based also however including include includes well new two one three may can found et al`.split(/\s+/);

  function cosine(a, b) {
    let dot = 0;
    for (const [term, weight] of a) dot += weight * (b.get(term) || 0);
    return dot;
  }
  function centroid(vectors) {
    const sum = new Map();
    for (const vector of vectors) for (const [term, weight] of vector) sum.set(term, (sum.get(term) || 0) + weight);
    let norm = 0;
    for (const weight of sum.values()) norm += weight * weight;
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of sum) sum.set(term, weight / norm);
    return sum;
  }

  /* Louvain modularity communities on a weighted graph of `count` nodes and [i, j, w] edges -> community index per node. */
  function louvain(count, edges) {
    let membership = Array.from({ length: count }, (_, i) => i);
    let graph = { count, edges };
    for (let level = 0; level < 6; level++) {
      const neighbours = Array.from({ length: graph.count }, () => new Map()), degree = new Float64Array(graph.count);
      let total = 0;
      for (const [i, j, w] of graph.edges) {
        neighbours[i].set(j, (neighbours[i].get(j) || 0) + w); neighbours[j].set(i, (neighbours[j].get(i) || 0) + w);
        degree[i] += w; degree[j] += w; total += 2 * w;
      }
      if (!total) break;
      const community = Array.from({ length: graph.count }, (_, i) => i), weight = Float64Array.from(degree);
      let moved = true, passes = 0, changed = false;
      while (moved && passes++ < 20) {
        moved = false;
        for (let node = 0; node < graph.count; node++) {
          const current = community[node], links = new Map();
          for (const [other, w] of neighbours[node]) if (other !== node) links.set(community[other], (links.get(community[other]) || 0) + w);
          weight[current] -= degree[node];
          let best = current, gain = (links.get(current) || 0) - weight[current] * degree[node] / total;
          for (const [candidate, w] of links) {
            const value = w - weight[candidate] * degree[node] / total;
            if (value > gain + 1e-12 || (Math.abs(value - gain) <= 1e-12 && candidate < best)) { gain = value; best = candidate; }
          }
          weight[best] += degree[node];
          if (best !== current) { community[node] = best; moved = changed = true; }
        }
      }
      if (!changed) break;
      const ids = new Map(), renumbered = community.map(c => ids.has(c) ? ids.get(c) : (ids.set(c, ids.size), ids.size - 1));
      membership = membership.map(c => renumbered[c]);
      const merged = new Map();
      for (const [i, j, w] of graph.edges) {
        const a = renumbered[i], b = renumbered[j], key = a < b ? a + ':' + b : b + ':' + a;
        merged.set(key, (merged.get(key) || 0) + w);
      }
      graph = { count: ids.size, edges: [...merged].map(([key, w]) => { const [a, b] = key.split(':').map(Number); return [a, b, w]; }) };
    }
    return membership;
  }

  /* Communities of the given papers, using only the links among them. */
  function communitiesOf(members, edges) {
    const local = new Map(members.map((member, i) => [member, i]));
    const inside = edges.filter(([a, b]) => local.has(a) && local.has(b)).map(([a, b, w]) => [local.get(a), local.get(b), w]);
    const groups = new Map();
    louvain(members.length, inside).forEach((community, i) => { if (!groups.has(community)) groups.set(community, []); groups.get(community).push(members[i]); });
    return [...groups.values()];
  }

  const idOf = end => end && typeof end === 'object' ? end.id : end;
  /* Papers with concept vectors, and each paper's strongest links (similarity and citation evidence) as weighted edges. */
  function build(papers, vectorOf, links, keywords, neighbours = 8) {
    const usable = papers.filter(paper => paper && paper.id && vectorOf(paper)?.size);
    const index = new Map(usable.map((paper, i) => [paper.id, i]));
    const strongest = usable.map(() => []);
    for (const link of links || []) {
      const i = index.get(idOf(link.source)), j = index.get(idOf(link.target));
      if (i === undefined || j === undefined || i === j) continue;
      const score = Number(link.score) || 0.01;
      strongest[i].push([j, score]); strongest[j].push([i, score]);
    }
    // Keeping only the strongest links stops one dense topic from swallowing the rest.
    const kept = new Map();
    strongest.forEach((rows, i) => rows.sort((a, b) => b[1] - a[1]).slice(0, neighbours)
      .forEach(([j, w]) => kept.set(i < j ? i + ':' + j : j + ':' + i, w)));
    const edges = [...kept].map(([key, w]) => { const [a, b] = key.split(':').map(Number); return [a, b, w]; });
    return { papers: usable, vectors: usable.map(vectorOf), edges, neighbours: strongest,
      communities: communitiesOf([...usable.keys()], edges), keywords: keywords instanceof Map ? keywords : new Map(keywords || []) };
  }

  /* From the graph analysis Pulse already ran for the map. */
  const fromGraph = (papers, vectors, links, keywords) => build(papers, paper => vectors?.get(paper.id), links, keywords);

  /* A standalone analysis with Pulse's engine, for libraries without a map analysis (and tests). */
  function analyse(papers, options = {}) {
    const usable = papers.filter(paper => paper && paper.id).map(paper => ({ ...paper, text: String(paper.text || '').slice(0, 6000) }));
    const result = (scope.PulseGraph || require('../graph-engine.js')).createEngine()
      .analyse({ papers: usable, stopwords: STOPWORDS, threshold: options.threshold ?? .08 });
    const vectors = new Map(result.vectors.map(([id, entries]) => [id, new Map(entries)]));
    return build(usable, paper => vectors.get(paper.id), result.links, result.keywords, options.neighbours);
  }

  /* Split or merge communities until about `target` remain, then name each by its most distinctive keywords. */
  function partition(analysis, target, termsOf) {
    let clusters = analysis.communities.map(members => ({ members: [...members] }));
    const minimum = Math.max(3, Math.round(analysis.papers.length / (target * 6)));
    const unsplittable = new Set();
    while (clusters.filter(cluster => cluster.members.length >= minimum).length < target) {
      const largest = clusters.filter(cluster => !unsplittable.has(cluster)).sort((a, b) => b.members.length - a.members.length)[0];
      if (!largest || largest.members.length < minimum * 2) break;
      const parts = communitiesOf(largest.members, analysis.edges).sort((a, b) => b.length - a.length);
      if (parts.length < 2 || parts[1].length < minimum) { unsplittable.add(largest); continue; }
      clusters.splice(clusters.indexOf(largest), 1, ...parts.map(members => ({ members })));
    }
    for (const cluster of clusters) cluster.centroid = centroid(cluster.members.map(i => analysis.vectors[i]));
    // Small communities join the group whose concepts they are closest to.
    while (clusters.length > 1 && (clusters.length > target || clusters.some(cluster => cluster.members.length < minimum))) {
      clusters.sort((a, b) => a.members.length - b.members.length);
      const small = clusters.shift();
      let best = clusters[0], score = -1;
      for (const other of clusters) { const value = cosine(small.centroid, other.centroid); if (value > score) { score = value; best = other; } }
      best.members.push(...small.members);
      best.centroid = centroid(best.members.map(i => analysis.vectors[i]));
    }
    const total = analysis.papers.length, used = new Set(), spellings = new Map();
    // Paper keywords name groups; the engine's own top terms only fill in when a group has too few keywords.
    const sources = [paper => termsOf(paper), paper => analysis.keywords.get(paper.id) || []].map(source => {
      const frequency = new Map();
      const terms = analysis.papers.map(paper => {
        const values = [...new Set(source(paper).filter(term => typeof term === 'string').map(term => {
          const original = term.trim(), key = original.toLowerCase();
          // Display keeps the library's most common spelling of a term (NADPH, not nadph).
          if (!spellings.has(key)) spellings.set(key, new Map());
          spellings.get(key).set(original, (spellings.get(key).get(original) || 0) + 1);
          return key;
        }).filter(term => term.length > 2))];
        for (const term of values) frequency.set(term, (frequency.get(term) || 0) + 1);
        return values;
      });
      return { terms, frequency };
    });
    return clusters.sort((a, b) => b.members.length - a.members.length).map((cluster, index) => {
      const size = cluster.members.length, label = [], ranked = [];
      for (const { terms, frequency } of sources) {
        const counts = new Map();
        for (const i of cluster.members) for (const term of terms[i]) counts.set(term, (counts.get(term) || 0) + 1);
        // Distinctive terms: a clear share of the group that is much more common here than across the library.
        ranked.push(...[...counts].filter(([, n]) => n >= 2 && n / size >= .08)
          .map(([term, n]) => { const lift = (n / size) / (frequency.get(term) / total); return [term, lift > 1.2 ? n / size * Math.log(lift) * (term.includes(' ') ? 1.3 : 1) : 0]; })
          .filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).map(([term]) => term));
        for (const term of ranked) {
          if (label.length === 2) break;
          if (used.has(term) || label.some(chosen => chosen.includes(term) || term.includes(chosen))) continue;
          label.push(term);
        }
        if (label.length === 2) break;
      }
      // Last resort: the heaviest terms of the group's concept centroid, which is what grouped these papers.
      if (label.length < 2) for (const [term] of [...cluster.centroid].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
        if (label.length === 2) break;
        if (term.length < 5 || used.has(term) || label.some(chosen => chosen.includes(term) || term.includes(chosen))) continue;
        label.push(term);
      }
      label.forEach(term => used.add(term));
      const display = term => { const forms = spellings.get(term); return forms ? [...forms].sort((a, b) => b[1] - a[1])[0][0] : term; };
      const name = label.map(display).join(' · ');
      return { id: 'group-' + index, label: name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Other papers', papers: cluster.members.map(i => analysis.papers[i]), members: cluster.members };
    });
  }

  /* Every paper in exactly one group; papers without enough text to compare get a group of their own. */
  function groupLibrary(papers, analysis, target, termsOf) {
    const groups = analysis.papers.length ? partition(analysis, target, termsOf) : [];
    const placed = new Set(analysis.papers.map(paper => paper.id));
    const rest = papers.filter(paper => paper && paper.id && !placed.has(paper.id));
    if (rest.length) groups.push({ id: 'group-ungrouped', label: 'Not enough text to group', papers: rest, members: [], ungrouped: true });
    // Each paper also points to the other groups its strongest links reach, for "also linked to".
    const groupOf = new Map();
    groups.forEach(group => group.papers.forEach(paper => groupOf.set(paper.id, group.id)));
    const reach = new Map();
    analysis.papers.forEach((paper, i) => {
      const own = groupOf.get(paper.id);
      const others = [...new Set((analysis.neighbours[i] || []).map(([j]) => groupOf.get(analysis.papers[j].id)))].filter(id => id && id !== own);
      if (others.length) reach.set(paper.id, others.slice(0, 3));
    });
    return { groups, groupOf, reach };
  }

  const api = { analyse, fromGraph, partition, groupLibrary, louvain, communitiesOf };
  scope.TrendsGroups = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
