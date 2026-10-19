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
    let vectorKey = null, topologyKey = null, hasAnalysis = false, lastThreshold, revision = 0;
    let similarities = [], scoredThreshold = Infinity, topology = [], vectors = [], keywords = [], links = [], clusters = [];
    let documentCache = new Map(), oldFrequencies = new Map(), vectorMap = new Map(), keywordMap = new Map();
    let oldCount = -1, oldSteer = null, oldStopwords = null, clusterIds = [], clusterPairs = [];
    const pairCache = new Map();
    const stats = {vectorBuilds:0,similarityBuilds:0,pairScores:0,topologyBuilds:0,clusterBuilds:0,
      tokenizations:0,vectorUpdates:0,candidatePairs:0,pairCacheHits:0};
    const signature = paper => JSON.stringify([paper.id,paper.title,paper.authors,paper.year,paper.journal,paper.abstract,paper.paperKeywords,paper.text]);
    function buildVectors(papers, graphSteerKeywords, stopwordValues) {
      const stopKey = JSON.stringify(stopwordValues), steerKey = JSON.stringify(graphSteerKeywords);
      const stopwords = new Set(stopwordValues);
      function tokenize(text) {
        const tokens = (text || '').toLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^\w\s-]/g,' ')
          .split(/\s+/).map(token=>token.replace(/^-+|-+$/g,''))
          .filter(token=>token.length>2 && token.length<32 && !stopwords.has(token) && !/^\d+$/.test(token));
        const grams=[];
        for(let i=0;i<tokens.length-1;i++) if(!stopwords.has(tokens[i])&&!stopwords.has(tokens[i+1])) grams.push(`${tokens[i]} ${tokens[i+1]}`);
        return tokens.concat(grams.filter(gram=>gram.length<42));
      }
      const steer = dedupeList(graphSteerKeywords.flatMap(term=>tokenize(term))).slice(0,24);
      const docs = new Map(), frequencies = new Map();
      for (const paper of papers) {
        const key = signature(paper), previous = documentCache.get(paper.id);
        let doc = previous;
        if (!previous || previous.key!==key || oldStopwords!==stopKey) {
          const tokens=tokenize(`${paper.title} ${(paper.authors||[]).join(' ')} ${paper.year||''} ${paper.journal||''} ${paper.abstract||''} ${(paper.paperKeywords||[]).join(' ')} ${paper.text}`);
          const counts=new Map();for(const term of tokens) counts.set(term,(counts.get(term)||0)+1);
          doc={key,counts};stats.tokenizations++;
        }
        docs.set(paper.id,doc);
        for(const term of doc.counts.keys()) frequencies.set(term,(frequencies.get(term)||0)+1);
      }
      const changedTerms=new Set();
      for(const [term,n] of frequencies) if(oldFrequencies.get(term)!==n) changedTerms.add(term);
      for(const term of oldFrequencies.keys()) if(!frequencies.has(term)) changedTerms.add(term);
      const globalChange=oldCount!==papers.length || oldSteer!==steerKey || oldStopwords!==stopKey;
      const nextVectors=new Map(), nextKeywords=new Map(), n=Math.max(papers.length,1);
      for(const paper of papers) {
        const doc=docs.get(paper.id);
        const changed=globalChange || documentCache.get(paper.id)!==doc || [...doc.counts.keys()].some(term=>changedTerms.has(term));
        if(!changed && vectorMap.has(paper.id)) {
          nextVectors.set(paper.id,vectorMap.get(paper.id));nextKeywords.set(paper.id,keywordMap.get(paper.id));continue;
        }
        const counts=new Map(doc.counts);
        for(const term of steer) if(counts.has(term)) counts.set(term,counts.get(term)+6);
        const vector=new Map();let norm=0;
        for(const [term,count] of counts) {
          const weight=(1+Math.log(count))*(Math.log((1+n)/(1+(frequencies.get(term)||0)))+1);
          vector.set(term,weight);norm+=weight*weight;
        }
        const normalized=new Map(), divisor=Math.sqrt(norm)||1;
        for(const [term,weight] of vector) normalized.set(term,weight/divisor);
        nextVectors.set(paper.id,normalized);
        nextKeywords.set(paper.id,[...vector.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([term])=>term));
        stats.vectorUpdates++;
      }
      documentCache=docs;oldFrequencies=frequencies;vectorMap=nextVectors;keywordMap=nextKeywords;
      oldCount=papers.length;oldSteer=steerKey;oldStopwords=stopKey;
      // Scores are reused only while both exact normalized vector objects match.
      const liveVectors=new Set(vectorMap.values());
      for(const [key,entry] of pairCache) if(!liveVectors.has(entry.a)||!liveVectors.has(entry.b)) pairCache.delete(key);
      vectors=[...vectorMap].map(([id,vector])=>[id,[...vector]]);keywords=[...keywordMap];
      scoredThreshold=Infinity;stats.vectorBuilds++;
    }
    function buildSimilarities(papers, threshold) {
      const rows=papers.map(()=>[]), postings=new Map(), seen=new Uint32Array(papers.length), maxima=new Map();
      for(const vector of vectorMap.values()) for(const [term,weight] of vector) maxima.set(term,Math.max(maxima.get(term)||0,weight));
      // Exact L2 prefix join: any qualifying unit vector must share an indexed
      // prefix term, because the unindexed suffix has norm strictly below t.
      for(let j=0;j<papers.length;j++) {
        const right=papers[j], b=vectorMap.get(right.id), candidates=[], epoch=j+1;
        if(threshold<=0) for(let i=0;i<j;i++) candidates.push(i);
        else for(const term of b.keys()) for(const i of postings.get(term)||[]) if(seen[i]!==epoch) {seen[i]=epoch;candidates.push(i);}
        stats.candidatePairs+=candidates.length;
        for(const i of candidates) {
          const left=papers[i], a=vectorMap.get(left.id), key=pairKey(left.id,right.id), cached=pairCache.get(key);
          let score;
          if(cached && cached.a===a && cached.b===b) {score=cached.score;stats.pairCacheHits++;}
          else {score=cosine(a,b);if(pairCache.size<1000000 || pairCache.has(key)) pairCache.set(key,{a,b,score});stats.pairScores++;}
          if(score>=threshold) rows[i].push({source:left.id,target:right.id,score,type:'similarity'});
        }
        if(threshold>0) {
          const terms=[...b.entries()].sort((a,b)=>(oldFrequencies.get(a[0])||0)-(oldFrequencies.get(b[0])||0));
          let remainder=[...b.values()].reduce((sum,w)=>sum+w*w,0), maxRemainder=[...b].reduce((sum,[term,w])=>sum+w*maxima.get(term),0);
          for(const [term,weight] of terms) {
            if(remainder < threshold*threshold-1e-12 || maxRemainder < threshold-1e-12) break;
            if(!postings.has(term)) postings.set(term,[]);
            postings.get(term).push(j);remainder-=weight*weight;maxRemainder-=weight*maxima.get(term);
          }
        }
      }
      similarities=rows.flat();scoredThreshold=threshold;stats.similarityBuilds++;
    }
    function buildTopology(papers) {
      const operations=[], byOpenAlex=new Map(papers.map(p=>[normalizeOpenAlexId(p.openAlexId||p.openAlexUrl||''),p]).filter(([id])=>id));
      const refs=papers.map(p=>new Set((p.referenceIds||[]).map(normalizeOpenAlexId).filter(Boolean)));
      const citers=papers.map(p=>new Set((p.citedByIds||[]).map(normalizeOpenAlexId).filter(Boolean)));
      papers.forEach((paper,i)=>refs[i].forEach(id=>{
        const cited=byOpenAlex.get(id);
        if(cited) operations.push([paper.id,cited.id,'citation',.98,`${compactTitle(paper.title)} cites ${compactTitle(cited.title)}`]);
      }));
      function overlapPairs(sets) {
        const index=new Map(), pairs=new Map(), n=papers.length;
        sets.forEach((values,j)=>values.forEach(value=>{
          if(!index.has(value)) index.set(value,[]);
          for(const i of index.get(value)) {const key=i*n+j;pairs.set(key,(pairs.get(key)||0)+1);}
          index.get(value).push(j);
        }));return pairs;
      }
      const sharedRefs=overlapPairs(refs), sharedCiters=overlapPairs(citers), n=papers.length;
      const keys=[...new Set([...sharedRefs.keys(),...sharedCiters.keys()])].sort((a,b)=>a-b);
      for(const key of keys) {
        const left=papers[Math.floor(key/n)],right=papers[key%n], r=sharedRefs.get(key),c=sharedCiters.get(key);
        if(r) operations.push([left.id,right.id,'bibliographic',Math.min(.9,.42+r*.08),`${r} shared reference${r===1?'':'s'}`]);
        if(c) operations.push([left.id,right.id,'cocitation',Math.min(.88,.38+c*.08),`${c} shared citing paper${c===1?'':'s'}`]);
      }
      topology=operations;stats.topologyBuilds++;
    }
    function analyse(payload) {
      const papers=payload.papers||[], steer=payload.graphSteerKeywords||[], words=[...(payload.stopwords||[])], threshold=payload.threshold??.05;
      const nextVectorKey=JSON.stringify([papers.map(signature),steer,words]);
      const nextTopologyKey=JSON.stringify(papers.map(p=>[p.id,p.title,p.openAlexId,p.openAlexUrl,p.referenceIds,p.citedByIds]));
      const vectorsChanged=nextVectorKey!==vectorKey, topologyChanged=nextTopologyKey!==topologyKey;
      if(vectorsChanged) {buildVectors(papers,steer,words);vectorKey=nextVectorKey;}
      if(topologyChanged) {buildTopology(papers);topologyKey=nextTopologyKey;}
      if(vectorsChanged || threshold<scoredThreshold) buildSimilarities(papers,threshold);
      if(!hasAnalysis || vectorsChanged || topologyChanged || !Object.is(threshold,lastThreshold)) {
        const previousPairs=clusterPairs;
        links=similarities.filter(link=>link.score>=threshold).map(link=>({...link}));
        const byPair=new Map(links.map(link=>[pairKey(link.source,link.target),link]));
        const rank={similarity:0,cocitation:1,bibliographic:2,citation:3,mixed:4};
        for(const [source,target,type,score,evidence] of topology) {
          if(!source||!target||source===target) continue;
          const key=pairKey(source,target), existing=byPair.get(key);
          if(existing) {
            existing.score=Math.max(existing.score||0,score);
            existing.evidence=dedupeList([existing.evidence,evidence].filter(Boolean)).join(' | ');
            if(existing.type!==type) existing.type=rank[type]>rank[existing.type]?type:(rank[type]===rank[existing.type]?existing.type:'mixed');
          } else {const link={source,target,score,type,evidence};links.push(link);byPair.set(key,link);}
        }
        const ids=papers.map(p=>p.id);
        if(ids.length!==clusterIds.length || ids.some((id,i)=>id!==clusterIds[i]) || links.length!==previousPairs.length || links.some((l,i)=>l.source!==previousPairs[i][0]||l.target!==previousPairs[i][1])) {
          clusters=findClusters(papers,links);clusterIds=ids;clusterPairs=links.map(l=>[l.source,l.target]);stats.clusterBuilds++;
        }
        hasAnalysis=true;lastThreshold=threshold;revision++;
      }
      return {links:links.map(link=>({...link})),clusters:clusters.map(c=>[...c]),
        vectors:vectors.map(([id,v])=>[id,v.map(entry=>[...entry])]),keywords:keywords.map(([id,t])=>[id,[...t]]),revision,stats:{...stats}};
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
