      if ((metadata.authors || []).length) paper.authors = paperAuthors(metadata);
      if (metadata.date) paper.date = metadata.date;
      if (metadata.year) paper.year = metadata.year;
      if (metadata.journal) paper.journal = metadata.journal;
      if (metadata.doi) paper.doi = metadata.doi;
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

    const graphEngine = PulseGraph.createEngine();
    let analysisKey = '', requestedAnalysisKey = '', graphRevision = 0, analysisGeneration = 0;
    let layoutKey = '', graphMarkupKey = '', workerSerial = 0;
    let paintedSelectedLinkId=null, edgeElementsById=new Map(), linksById=new Map();
    let graphWorker = null, activeAnalysis = null, activeLayout = null;
    const graphTasks = new Map();
    const graphStats = {analyses:0, layouts:0, paints:0, workerFailures:0};
    let papersById = new Map(), linksByPaper = new Map();
    try {
      graphWorker = new Worker('graph-worker.js');
      graphWorker.onmessage = ({data}) => {
        const task = graphTasks.get(data.id);
        if (!task) return;
        graphTasks.delete(data.id);
        if (data.error){graphStats.workerFailures++;task.reject(new Error(data.error));} else task.resolve(data);
      };
      graphWorker.onerror = () => {
        graphStats.workerFailures++;
        graphWorker.terminate(); graphWorker = null;
        for (const task of graphTasks.values()) task.reject(new Error('Background graph calculation unavailable.'));
        graphTasks.clear();
      };
    } catch (_) {}
    function graphTask(action, payload) {
      return new Promise((resolve,reject) => {
        const id=++workerSerial;graphTasks.set(id,{resolve,reject});graphWorker.postMessage({id,action,payload});
      });
    }
    async function waitForGraphIdle() {
      while(activeAnalysis || activeLayout) await Promise.all([activeAnalysis,activeLayout].filter(Boolean));
    }
    function applyGraphAnalysis(result, key) {
      analysisKey=key; graphRevision++;
      state.links=result.links;state.clusters=result.clusters;state.explicitLinks=result.explicitLinks;
      linksById=new Map();state.links.forEach(link=>{if(!linksById.has(linkId(link)))linksById.set(linkId(link),link);});
      state.vectors=new Map(result.vectors.map(([id,v])=>[id,new Map(v)]));state.keywords=new Map(result.keywords);
      linksByPaper=new Map(state.papers.map(p=>[p.id,[]]));
      state.links.forEach(link=>{linksByPaper.get(link.source)?.push(link);linksByPaper.get(link.target)?.push(link);});
      graphStats.analyses++;
    }
    const paperAnalysisCache=new WeakMap();let paperAnalysisRevision=0;
    function analysisPaper(p) {
      const fields=[p.id,p.title,p.year,p.journal,p.abstract,p.text,p.openAlexId,p.openAlexUrl,(p.authors||[]).join('\0'),(p.paperKeywords||[]).join('\0'),(p.referenceIds||[]).join('\0'),(p.citedByIds||[]).join('\0')];
      let cached=paperAnalysisCache.get(p);
      if(!cached || fields.some((value,index)=>value!==cached.fields[index])) {
        cached={fields,revision:++paperAnalysisRevision,paper:{id:p.id,title:p.title,authors:[...(p.authors||[])],year:p.year,journal:p.journal,abstract:p.abstract,paperKeywords:[...(p.paperKeywords||[])],text:p.text,openAlexId:p.openAlexId,openAlexUrl:p.openAlexUrl,referenceIds:[...(p.referenceIds||[])],citedByIds:[...(p.citedByIds||[])]}};
        paperAnalysisCache.set(p,cached);
      }
      return cached;
    }
    function calculateRelatedness() {
      state.papers.forEach(p=>{p.x=Number.isFinite(Number(p.x))?Number(p.x):0;p.y=Number.isFinite(Number(p.y))?Number(p.y):0;});
      papersById=new Map(state.papers.map(p=>[p.id,p]));
      const records=state.papers.map(analysisPaper),papers=records.map(record=>record.paper);
      const payload={papers,explicitLinks:state.explicitLinks,threshold:state.threshold,graphSteerKeywords:state.graphSteerKeywords,stopwords:[...stopwords]};
      const key=JSON.stringify([records.map(record=>[record.paper.id,record.revision]),payload.explicitLinks,payload.threshold,payload.graphSteerKeywords]);
      if(key===analysisKey){if(requestedAnalysisKey && requestedAnalysisKey!==key){++analysisGeneration;requestedAnalysisKey='';}return;}
      if(key===requestedAnalysisKey)return;
      const generation=++analysisGeneration;
      if(graphWorker && papers.length>100) {
        requestedAnalysisKey=key;
        state.links=state.links.filter(link=>papersById.has(link.source)&&papersById.has(link.target));
        if(activeAnalysis)return; // Coalesce rapid slider/data changes into the latest snapshot.
        const job=graphTask('analyse',payload).then(({result})=>{
          if(generation===analysisGeneration){if(activeAnalysis===job)activeAnalysis=null;applyGraphAnalysis(result,key);render();}
        }).catch(()=>{if(generation===analysisGeneration){if(activeAnalysis===job)activeAnalysis=null;applyGraphAnalysis(graphEngine.analyse(payload),key);render();}}).finally(()=>{
          if(activeAnalysis===job){activeAnalysis=null;requestedAnalysisKey='';render();}
          else if(generation===analysisGeneration)requestedAnalysisKey='';
        });
        activeAnalysis=job;
      } else { requestedAnalysisKey='';applyGraphAnalysis(graphEngine.analyse(payload),key); }
    }
    function paperLinks(id) { return linksByPaper.get(id) || []; }

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

    let bouncingNodeId = null;
    let bounceAnimationTimer = null;
    let recenterAnimId = null;
    let isRecenteringAnimation = false;
    let lastNodeClickTime = 0;
    let lastNodeClickId = null;

    function layout(width, height) {
      if (activeAnalysis || isRecenteringAnimation) return;
      const key=JSON.stringify([graphRevision,width,height,state.mode,state.centerId,state.graphStyle.spacing,state.papers.map(p=>[p.id,!!p.pinnedPosition])]);
      if (key===layoutKey) return;
      layoutKey=key;graphStats.layouts++;
      if(graphWorker && state.papers.length>100 && state.mode==='network' && !state.centerId) {
        const payload={papers:state.papers.map(p=>({id:p.id,x:p.x,y:p.y,pinnedPosition:p.pinnedPosition})),links:state.links,width,height,spacing:state.graphStyle.spacing||1};
        const job=graphTask('layout',payload).then(({positions})=>{
          if(layoutKey!==key)return;
          if(activeLayout===job)activeLayout=null;
          positions.forEach(pos=>{const paper=papersById.get(pos.id);if(paper&&!paper.pinnedPosition){paper.x=pos.x;paper.y=pos.y;}});
          graphMarkupKey='';render();
        }).catch(()=>{if(layoutKey!==key)return;if(activeLayout===job)activeLayout=null;layoutSmallGraph(width,height);graphMarkupKey='';render();}).finally(()=>{if(activeLayout===job)activeLayout=null;});
        activeLayout=job;return;
      }
      layoutSmallGraph(width,height);
    }
    function layoutSmallGraph(width, height) {
      const papers = state.papers;
      if (!papers.length) return;
      if (isRecenteringAnimation) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const radius = Math.max(80, Math.min(width, height) * 0.34 * spacing);

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
        state.clusters.forEach((cluster, clusterIndex) => {
          const angle = (Math.PI * 2 * clusterIndex) / Math.max(state.clusters.length, 1) - Math.PI / 2;
          const cx = centerX + Math.cos(angle) * radius * 0.72;
          const cy = centerY + Math.sin(angle) * radius * 0.72;
          cluster.forEach((id, index) => {
            const paper = papers.find(item => item.id === id);
            const localAngle = (Math.PI * 2 * index) / Math.max(cluster.length, 1);
            const cDist = Math.min(clusterRadius, 60 + cluster.length * 18);
            paper.x = cx + Math.cos(localAngle) * cDist;
            paper.y = cy + Math.sin(localAngle) * cDist;
          });
        });
        return;
      }

      papers.forEach((paper, index) => {
        if (!paper.x || !paper.y) {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        }
      });

      if(papers.length>100)return; // A usable static layout if worker loading fails.
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
            forces.get(a.id).x += (dx / distance) * push;
            forces.get(a.id).y += (dy / distance) * push;
            forces.get(b.id).x -= (dx / distance) * push;
            forces.get(b.id).y -= (dy / distance) * push;

            // Extra anti-collision repulsion specifically for horizontal text labels
            const minX = 120 * spacing;
            const minY = 54 * spacing;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx < minX && absDy < minY) {
              const repelX = (minX - absDx) * 0.08 * (dx >= 0 ? 1 : -1);
              const repelY = (minY - absDy) * 0.12 * (dy >= 0 ? 1 : -1);
              forces.get(a.id).x += repelX;
              forces.get(a.id).y += repelY;
              forces.get(b.id).x -= repelX;
              forces.get(b.id).y -= repelY;
            }
          }
        }

        state.links.forEach(link => {
          const a = papersById.get(link.source);
          const b = papersById.get(link.target);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const topologyBoost = link.type && link.type !== 'similarity' ? 0.32 : 0;
          const desired = (270 * spacing) - link.score * 105 - topologyBoost * 46;
          const pull = (distance - desired) * 0.0038 * (0.52 + link.score + topologyBoost);
          forces.get(a.id).x += (dx / distance) * pull;
          forces.get(a.id).y += (dy / distance) * pull;
          forces.get(b.id).x -= (dx / distance) * pull;
          forces.get(b.id).y -= (dy / distance) * pull;
        });

        const gravity = 0.0028 / Math.max(1, spacing * 0.75);
        const spanX = (width / 2 - 80) * Math.max(1, spacing);
        const spanY = (height / 2 - 70) * Math.max(1, spacing);
        papers.forEach(paper => {
          const force = forces.get(paper.id);
          if (paper.pinnedPosition) return;
          force.x += (centerX - paper.x) * gravity;
          force.y += (centerY - paper.y) * gravity;
          paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x + force.x));
          paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y + force.y));
        });
      }
    }

    function layoutCenteredPaper(width, height, centerX, centerY) {
      const focus = state.papers.find(paper => paper.id === state.centerId);
      if (!focus) {
        state.centerId = null;
        return false;
      }

      const linked = state.links
        .filter(link => link.source === focus.id || link.target === focus.id)
        .sort((a, b) => b.score - a.score);
      const neighborIds = linked.map(link => link.source === focus.id ? link.target : link.source);
      const neighborSet = new Set(neighborIds);
      const neighbors = neighborIds
        .map(id => state.papers.find(paper => paper.id === id))
        .filter(Boolean);
      const others = state.papers.filter(paper => paper.id !== focus.id && !neighborSet.has(paper.id));
      const shortestSide = Math.min(width, height);
      const spacing = state.graphStyle.spacing || 1;
      const innerRadius = Math.max(120, Math.min(shortestSide * 0.25, 260)) * spacing;
      const outerRadius = Math.max(innerRadius + 120, Math.min(shortestSide * 0.42, 430) * spacing);

      focus.x = centerX;
      focus.y = centerY;
      placePaperRing(neighbors, centerX, centerY, innerRadius, -Math.PI / 2);
      placePaperRing(others, centerX, centerY, outerRadius, -Math.PI / 2 + Math.PI / Math.max(others.length, 2));
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

    function applyAreaContainment() {
      if (isRecenteringAnimation) return;
      const spacing = state.graphStyle.spacing || 1;
      state.areas.forEach(area => {
        const members = state.papers.filter(paper => paper.areaId === area.id);
        members.forEach((paper, index) => {
          if (pointInArea(paper.x, paper.y, area)) return;
          const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
          const rows = Math.max(1, Math.ceil(members.length / cols));
          const row = Math.floor(index / cols);
          const col = index % cols;
          const gapX = Math.max(58, Math.min(110 * spacing, area.width / Math.max(cols + 1, 2)));
          const gapY = Math.max(58, Math.min(96 * spacing, area.height / Math.max(rows + 1, 2)));
          paper.x = area.x + Math.min(area.width - 42, Math.max(42, (col + 1) * gapX));
          paper.y = area.y + Math.min(area.height - 42, Math.max(42, (row + 1) * gapY + 18));
        });
      });
    }

    function constrainPapers(width, height) {
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const spanX = (width / 2 - 80) * Math.max(1, spacing);
      const spanY = (height / 2 - 70) * Math.max(1, spacing);
      state.papers.forEach(paper => {
        paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x));
        paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y));
      });
    }

    function blowUpMap(factor = 1.35) {
      if (!state.papers.length) {
        showToast('Add papers to expand the map');
        return;
      }
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.min(4.0, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Maximum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
