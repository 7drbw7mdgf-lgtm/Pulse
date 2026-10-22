/* Map presentation and paths use the graph already on screen. */
const PulseMapTools = (() => {
  let focus=false, path=null;
  const names={citation:'Citation',bibliographic:'Shared references',cocitation:'Co-citation',similarity:'Similarity',mixed:'Mixed citation / reference evidence'};
  function fit(ids) {
    const wanted=new Set(ids), papers=activeMapPapers().filter(p=>wanted.has(p.id)&&Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(!papers.length)return;
    const box=els.map.getBoundingClientRect(),pad=65,ratio=Math.max(.2,box.width/Math.max(1,box.height));
    const minX=Math.min(...papers.map(p=>p.x)),maxX=Math.max(...papers.map(p=>p.x)),minY=Math.min(...papers.map(p=>p.y)),maxY=Math.max(...papers.map(p=>p.y));
    let width=Math.max(180,maxX-minX+pad*2),height=Math.max(160,maxY-minY+pad*2);
    if(width/height<ratio)width=height*ratio;else height=width/ratio;
    Object.assign(state.view,{x:(minX+maxX-width)/2,y:(minY+maxY-height)/2,width,height});
    els.map.setAttribute('viewBox',`${state.view.x} ${state.view.y} ${width} ${height}`);
  }
  function toggleFocus(value=!focus) {
    focus=value;els.app.classList.toggle('map-focus',focus);
    const button=document.getElementById('focusMapButton');
    if(button){button.textContent=focus?'Exit focus':'Focus map';button.setAttribute('aria-pressed',String(focus));}
    requestAnimationFrame(()=>{render();requestAnimationFrame(()=>fit(activeMapPapers().map(p=>p.id)));});
  }
  function shortest(start,end,types) {
    const ids=new Set(activeMapPapers().map(p=>p.id)),adj=new Map([...ids].map(id=>[id,[]]));
    // Include only links that the current map actually draws, including its threshold.
    const drawn=new Set([...els.map.querySelectorAll('.edge:not(.is-network-hidden)')].map(el=>el.dataset.link));
    for(const link of state.links){if(!ids.has(link.source)||!ids.has(link.target)||!types.has(link.type||'similarity')||!drawn.has(linkId(link)))continue;
      adj.get(link.source).push([link.target,link]);adj.get(link.target).push([link.source,link]);}
    const previous=new Map([[start,null]]),queue=[start];
    for(let index=0;index<queue.length&&!previous.has(end);index++)for(const [next,link] of adj.get(queue[index])||[]){if(!previous.has(next)){previous.set(next,{id:queue[index],link});queue.push(next);}}
    if(!previous.has(end))return null;
    const nodes=[end],links=[];let at=end;
    while(at!==start){const step=previous.get(at);links.unshift(step.link);at=step.id;nodes.unshift(at);}
    return {nodes,links,mapId:state.activeMapId};
  }
  function refresh() {
    const button=document.getElementById('mapSelectionPath');if(button)button.disabled=[...state.librarySelectedIds||[]].filter(id=>activeMapPapers().some(p=>p.id===id)).length!==2;
    if(!path&&!els.map.classList.contains('has-paper-path'))return;
    const active=new Set(activeMapPapers().map(p=>p.id)),drawn=new Set([...els.map.querySelectorAll('.edge:not(.is-network-hidden)')].map(el=>el.dataset.link));
    if(path&&(path.mapId!==state.activeMapId||path.nodes.some(id=>!active.has(id))||path.links.some(link=>!drawn.has(linkId(link)))))path=null;
    const nodes=new Set(path?.nodes||[]),links=new Set((path?.links||[]).map(linkId));
    els.map.classList.toggle('has-paper-path',Boolean(path));
    els.map.querySelectorAll('.node').forEach(el=>el.classList.toggle('is-path-node',nodes.has(el.dataset.id)));
    els.map.querySelectorAll('.edge,.edge-hit').forEach(el=>el.classList.toggle('is-path-link',links.has(el.dataset.link)));
  }
  function calculateBetweenness(nodeIds, types) {
    const ids = Array.from(nodeIds);
    const cb = new Map(ids.map(id => [id, 0]));
    const drawn = new Set([...els.map.querySelectorAll('.edge:not(.is-network-hidden)')].map(el => el.dataset.link));
    const adj = new Map(ids.map(id => [id, []]));
    for (const link of state.links) {
      if (!cb.has(link.source) || !cb.has(link.target)) continue;
      if (types && !types.has(link.type || 'similarity')) continue;
      if (drawn.size && !drawn.has(linkId(link))) continue;
      adj.get(link.source).push(link.target);
      adj.get(link.target).push(link.source);
    }
    for (const s of ids) {
      const S = [];
      const P = new Map(ids.map(id => [id, []]));
      const sigma = new Map(ids.map(id => [id, 0]));
      sigma.set(s, 1);
      const d = new Map(ids.map(id => [id, -1]));
      d.set(s, 0);
      const Q = [s];
      while (Q.length) {
        const v = Q.shift();
        S.push(v);
        const dv = d.get(v);
        for (const w of adj.get(v) || []) {
          if (d.get(w) < 0) {
            d.set(w, dv + 1);
            Q.push(w);
          }
          if (d.get(w) === dv + 1) {
            sigma.set(w, sigma.get(w) + sigma.get(v));
            P.get(w).push(v);
          }
        }
      }
      const delta = new Map(ids.map(id => [id, 0]));
      while (S.length) {
        const w = S.pop();
        const coeff = (1 + delta.get(w)) / (sigma.get(w) || 1);
        for (const v of P.get(w)) delta.set(v, delta.get(v) + sigma.get(v) * coeff);
        if (w !== s) cb.set(w, cb.get(w) + delta.get(w));
      }
    }
    const n = ids.length, norm = n > 2 ? 2 / ((n - 1) * (n - 2)) : 1;
    const scored = ids.map(id => ({ id, score: (cb.get(id) || 0) / 2, normalized: ((cb.get(id) || 0) / 2) * norm }));
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
  function highlightBridgePaper(id) {
    els.map.querySelectorAll('.node').forEach(el => el.classList.toggle('is-bridge-node', el.dataset.id === id));
    fit([id]);
    const paper = state.papers.find(p => p.id === id);
    if (paper) showToast(`Bridge paper: "${paper.title}" connects subfields on map.`);
  }
  function openPaths() {
    const root = document.getElementById('paperPathDialog'), papers = activeMapPapers();
    if (papers.length < 2) return showToast('Add at least two papers to this map.');
    const selected = [...state.librarySelectedIds || []].filter(id => papers.some(p => p.id === id));
    const options = papers.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`).join('');
    for (const id of ['pathStart', 'pathEnd']) document.getElementById(id).innerHTML = options;
    document.getElementById('pathStart').value = selected[0] || (papers.some(p => p.id === state.selectedId) ? state.selectedId : papers[0].id);
    document.getElementById('pathEnd').value = selected[1] || papers.find(p => p.id !== document.getElementById('pathStart').value).id;
    document.getElementById('paperPathResult').replaceChildren();

    // Render Bridge Papers & Bottlenecks section using betweenness centrality
    const types = new Set([...root.querySelectorAll('[name=pathType]:checked')].map(el => el.value));
    const bridges = calculateBetweenness(papers.map(p => p.id), types).filter(b => b.score > 0).slice(0, 5);
    let bridgeContainer = root.querySelector('.bridge-papers-section');
    if (!bridgeContainer) {
      bridgeContainer = document.createElement('div');
      bridgeContainer.className = 'bridge-papers-section';
      root.append(bridgeContainer);
    }
    if (bridges.length) {
      bridgeContainer.innerHTML = `<h3>Seminal "Bridge" Papers & Bottlenecks</h3><p class="subtle">Identified by betweenness centrality as pivotal connectors across subfields on this map.</p><ul class="bridge-paper-list">${bridges.map(b => {
        const p = state.papers.find(x => x.id === b.id) || {};
        return `<li class="bridge-paper-item"><div><strong>${escapeHtml(p.title || 'Untitled')}</strong> <span class="bridge-score">(Centrality: ${Math.round(b.normalized * 1000) / 10}%)</span></div><button type="button" data-bridge-id="${escapeHtml(b.id)}">Highlight on map</button></li>`;
      }).join('')}</ul>`;
      bridgeContainer.querySelectorAll('[data-bridge-id]').forEach(btn => {
        btn.onclick = () => {
          highlightBridgePaper(btn.dataset.bridgeId);
          root.close();
        };
      });
    } else {
      bridgeContainer.innerHTML = `<h3>Seminal "Bridge" Papers & Bottlenecks</h3><p class="subtle">Add more papers or adjust link threshold to compute betweenness centrality across clusters.</p>`;
    }
    root.showModal();
  }
  function showPath() {
    const start=document.getElementById('pathStart').value,end=document.getElementById('pathEnd').value;
    const root=document.getElementById('paperPathResult');
    if(start===end){root.textContent='Choose two different papers.';return;}
    const types=new Set([...document.querySelectorAll('[name=pathType]:checked')].map(el=>el.value));
    path=shortest(start,end,types);refresh();
    if(!path){root.textContent='No path in the displayed links with these link types. Try more link types or a lower threshold.';return;}
    root.innerHTML=`<p>${path.links.length} connection${path.links.length===1?'':'s'} · shortest undirected path in this map</p><ol class="paper-path-steps">${path.nodes.map((id,i)=>{
      const paper=state.papers.find(p=>p.id===id),link=path.links[i];
      return `<li><strong>${escapeHtml(paper.title)}</strong>${link?`<span class="path-kind" data-kind="${escapeHtml(link.type||'similarity')}">${escapeHtml(names[link.type]||names.similarity)}</span><small>${escapeHtml(link.evidence||'Text similarity; no citation claim.')}</small>`:''}</li>`;
    }).join('')}</ol><button type="button" id="viewPaperPath">View path on map</button>`;
    document.getElementById('viewPaperPath').onclick=()=>{root.closest('dialog').close();fit(path.nodes);};
  }

  /* Chronological Field Progression Heatmap & Citation Cascade Animation */
  let timelineTimer = null;
  function applyTimelineYear(year) {
    const isFiltered = year !== null;
    els.map.classList.toggle('timeline-filtered', isFiltered);
    const yearDisplay = document.getElementById('mapTimelineYear');
    if (yearDisplay) yearDisplay.textContent = isFiltered ? String(year) : 'All';
    const paperYears = new Map(activeMapPapers().map(p => [p.id, Number(p.year) || 0]));
    els.map.querySelectorAll('.node').forEach(el => {
      const y = paperYears.get(el.dataset.id) || 0;
      el.classList.toggle('is-timeline-dimmed', isFiltered && y > 0 && y > year);
      el.classList.toggle('is-cascade-head', isFiltered && y === year);
    });
    els.map.querySelectorAll('.edge, .edge-hit').forEach(el => {
      const linkKey = el.dataset.link;
      const parts = linkKey ? linkKey.split('__') : [];
      const y1 = paperYears.get(parts[0]) || 0;
      const y2 = paperYears.get(parts[1]) || 0;
      const isDimmed = isFiltered && ((y1 > 0 && y1 > year) || (y2 > 0 && y2 > year));
      el.classList.toggle('is-timeline-dimmed', isDimmed);
      const isCascade = isFiltered && !isDimmed && (y1 === year || y2 === year) && (y1 !== y2);
      el.classList.toggle('citation-cascade-active', isCascade);
    });
  }
  function toggleTimelineSlider() {
    const control = document.getElementById('mapTimelineControl');
    if (!control) return;
    const isOpening = control.hidden;
    control.hidden = !isOpening;
    document.getElementById('openTimelineProgression')?.setAttribute('aria-expanded',String(isOpening));
    if (isOpening) {
      const papers = activeMapPapers();
      const years = papers.map(p => Number(p.year)).filter(y => Number.isFinite(y) && y > 1900 && y < 2050);
      const minYear = years.length ? Math.min(...years) : 2000;
      const maxYear = years.length ? Math.max(...years) : new Date().getFullYear();
      const slider = document.getElementById('mapTimelineSlider');
      slider.min = minYear;
      slider.max = maxYear;
      slider.value = maxYear;
      applyTimelineYear(maxYear);
    } else {
      if (timelineTimer) { clearInterval(timelineTimer); timelineTimer = null; }
      applyTimelineYear(null);
    }
  }

  /* Publication-Quality Vector SVG Export */
  function exportMapSvg() {
    const clone = els.map.cloneNode(true);
    clone.removeAttribute('id');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.querySelectorAll('.edge-hit, .is-network-hidden, .node-hit, .workspace-resizer').forEach(el => el.remove());

    const svgStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    svgStyle.textContent = `
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .node text { font-size: 11px; fill: #1e293b; font-weight: 500; }
      .node-main-circle { stroke: #ffffff; stroke-width: 2px; }
      .edge { fill: none; stroke-opacity: 0.75; }
      .edge[data-type=citation] { stroke: #b85f2a; stroke-width: 2px; }
      .edge[data-type=bibliographic] { stroke: #178776; stroke-width: 1.5px; stroke-dasharray: 6 3; }
      .edge[data-type=similarity] { stroke: #7975c7; stroke-width: 1.5px; stroke-dasharray: 2 3; }
      .edge[data-type=cocitation] { stroke: #287cbd; stroke-width: 1.5px; stroke-dasharray: 8 3 2 3; }
      .edge[data-type=mixed] { stroke: #b85f2a; stroke-width: 2px; stroke-dasharray: 6 3 2 3; }
      .svg-legend-title { font-size: 13px; font-weight: 700; fill: #0f172a; }
      .svg-legend-text { font-size: 11px; fill: #475569; }
    `;
    clone.prepend(svgStyle);

    // Embed legend in corner
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `<marker id="svgArrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker>`;
    clone.prepend(defs);

    const legendGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    legendGroup.setAttribute('transform', `translate(${state.view.x + 20}, ${state.view.y + 20})`);
    legendGroup.innerHTML = `
      <rect x="0" y="0" width="190" height="110" rx="8" fill="#ffffff" fill-opacity="0.92" stroke="#cbd5e1" stroke-width="1"/>
      <text x="12" y="20" class="svg-legend-title">Citation Network</text>
      <line x1="12" y1="36" x2="36" y2="36" stroke="#b85f2a" stroke-width="2.5"/>
      <text x="44" y="40" class="svg-legend-text">Citation</text>
      <line x1="12" y1="54" x2="36" y2="54" stroke="#178776" stroke-width="2" stroke-dasharray="5 3"/>
      <text x="44" y="58" class="svg-legend-text">Shared references</text>
      <line x1="12" y1="72" x2="36" y2="72" stroke="#287cbd" stroke-width="2" stroke-dasharray="7 2 2 2"/>
      <text x="44" y="76" class="svg-legend-text">Co-citation</text>
      <line x1="12" y1="90" x2="36" y2="90" stroke="#7975c7" stroke-width="2" stroke-dasharray="2 3"/>
      <text x="44" y="94" class="svg-legend-text">Similarity</text>
    `;
    clone.append(legendGroup);

    const serializer = new XMLSerializer();
    const svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(clone);
    const mapName = (state.activeMapId && state.maps?.find(m => m.id === state.activeMapId)?.name) || 'pulse-network';
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${mapName}-publication.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Exported publication-quality vector SVG.');
  }

  function resizer(panel,side) {
    const bar=document.createElement('div');bar.className='workspace-resizer';bar.dataset.panel=side;bar.tabIndex=0;bar.role='separator';bar.setAttribute('aria-orientation','vertical');bar.setAttribute('aria-label',`Resize ${side==='library'?'Library':'paper details'} panel`);
    bar.setAttribute('aria-valuemin',side==='library'?'220':'260');bar.setAttribute('aria-valuemax','650');
    if(side==='library')panel.after(bar);else panel.before(bar);
    const key='pulse.panelWidth.'+side,property=side==='library'?'--library-width':'--inspector-width';
    function set(value){
      const other=document.getElementById(side==='library'?'details':'colLibrary');
      const hidden=other.hidden||other.classList.contains('is-swiped-hidden');
      const available=document.querySelector('.pulse-workspace-cols').clientWidth-(hidden?0:other.getBoundingClientRect().width)-250;
      const min=side==='library'?220:260,width=Math.max(min,Math.min(650,Math.max(min,available),value));
      els.app.style.setProperty(property,width+'px');bar.setAttribute('aria-valuenow',String(Math.round(width)));return width;
    }
    try{const saved=Number(localStorage.getItem(key));if(saved>=220&&saved<=650)set(saved);}catch(_){}
    bar.setAttribute('aria-valuenow',String(Math.round(parseFloat(els.app.style.getPropertyValue(property))||panel.getBoundingClientRect().width)));
    let drag=null;
    bar.onpointerdown=event=>{if(event.button!==0)return;drag={x:event.clientX,width:panel.getBoundingClientRect().width};bar.setPointerCapture(event.pointerId);els.app.classList.add('panel-resizing');event.preventDefault();};
    bar.onpointermove=event=>{if(drag)set(drag.width+(event.clientX-drag.x)*(side==='library'?1:-1));};
    function finish(){if(!drag)return;drag=null;const width=parseFloat(els.app.style.getPropertyValue(property))||panel.getBoundingClientRect().width;try{localStorage.setItem(key,String(width));}catch(_){}els.app.classList.remove('panel-resizing');render();}
    bar.onpointerup=finish;bar.onpointercancel=finish;bar.onlostpointercapture=finish;
    bar.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();const value=event.key==='Home'?(side==='library'?290:372):panel.getBoundingClientRect().width+(event.key==='ArrowRight'?20:-20)*(side==='library'?1:-1);const width=set(value);try{localStorage.setItem(key,String(width));}catch(_){}render();};
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const controls=document.querySelector('.network-search-options');
    controls.insertAdjacentHTML('beforeend','<button id="openPaperPaths" class="network-action" type="button">Paths</button><button id="focusMapButton" class="network-action" type="button" aria-pressed="false">Focus map</button>');
    document.querySelector('#mapToolsPopup .dock-panel-tools').insertAdjacentHTML('beforebegin','<div class="dock-map-actions" role="group" aria-label="Map actions"><button id="mapFitViewButton" type="button"><span>Fit map to view</span></button><button id="openTimelineProgression" type="button" aria-controls="mapTimelineControl" aria-expanded="false"><span>Timeline progression</span></button><button id="exportMapSvgButton" type="button"><span>Export map as SVG</span></button></div>');
    document.getElementById('mapFitViewButton').onclick=()=>fitCanvasToMap();
    document.getElementById('focusMapButton').onclick=()=>toggleFocus();
    document.getElementById('openPaperPaths').onclick=openPaths;
    document.getElementById('openTimelineProgression').onclick=toggleTimelineSlider;
    document.getElementById('exportMapSvgButton').onclick=exportMapSvg;

    // Create Map Timeline Playback Bar
    const viewport = document.querySelector('.map-viewport') || els.map?.parentElement;
    if (viewport) {
      const timelineBar = document.createElement('div');
      timelineBar.id = 'mapTimelineControl';
      timelineBar.className = 'map-timeline-control';
      timelineBar.hidden = true;
      timelineBar.innerHTML = `
        <button id="mapTimelinePlay" class="timeline-btn" type="button" title="Play progression">▶ Play</button>
        <input id="mapTimelineSlider" type="range" min="1990" max="2026" value="2026" step="1">
        <span id="mapTimelineYear" class="map-timeline-year">2026</span>
        <button id="mapTimelineReset" class="timeline-btn" type="button" title="Show all papers">All</button>
      `;
      viewport.append(timelineBar);

      const slider = document.getElementById('mapTimelineSlider');
      slider.oninput = () => applyTimelineYear(Number(slider.value));

      const playBtn = document.getElementById('mapTimelinePlay');
      playBtn.onclick = () => {
        if (timelineTimer) {
          clearInterval(timelineTimer);
          timelineTimer = null;
          playBtn.textContent = '▶ Play';
        } else {
          playBtn.textContent = '⏸ Pause';
          const max = Number(slider.max);
          if (Number(slider.value) >= max) slider.value = slider.min;
          applyTimelineYear(Number(slider.value));
          timelineTimer = setInterval(() => {
            const next = Number(slider.value) + 1;
            if (next > max) {
              clearInterval(timelineTimer);
              timelineTimer = null;
              playBtn.textContent = '▶ Play';
            } else {
              slider.value = next;
              applyTimelineYear(next);
            }
          }, 600);
        }
      };

      document.getElementById('mapTimelineReset').onclick = () => {
        if (timelineTimer) { clearInterval(timelineTimer); timelineTimer = null; playBtn.textContent = '▶ Play'; }
        slider.value = slider.max;
        applyTimelineYear(null);
      };
    }

    const root=document.createElement('dialog');root.id='paperPathDialog';root.className='pulse-tool-dialog';
    root.innerHTML='<header><h2>Paths between papers</h2><button type="button" data-close-tool aria-label="Close paths">×</button></header><p>Explore connections already loaded in this map. Paths can be followed in either direction; similarity and shared references do not establish a citation.</p><div class="tool-form"><label>From<select id="pathStart"></select></label><label>To<select id="pathEnd"></select></label><fieldset><legend>Link types</legend>'+Object.entries(names).map(([key,label])=>`<label><input type="checkbox" name="pathType" value="${key}" checked>${label}</label>`).join('')+'</fieldset><button id="findPaperPath" type="button">Find shortest path</button><button id="clearPaperPath" type="button">Clear path</button></div><div id="paperPathResult" role="status"></div>';
    document.body.append(root);root.querySelector('[data-close-tool]').onclick=()=>root.close();document.getElementById('findPaperPath').onclick=showPath;document.getElementById('clearPaperPath').onclick=()=>{path=null;refresh();root.close();};
    const button=document.createElement('button');button.id='mapSelectionPath';button.type='button';button.textContent='Show path';button.onclick=openPaths;document.getElementById('mapSelectionClear').before(button);
    resizer(document.getElementById('colLibrary'),'library');resizer(document.getElementById('details'),'inspector');
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&focus&&!document.querySelector('dialog[open]')&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)){event.preventDefault();toggleFocus(false);}});
    document.querySelectorAll('[data-rail]').forEach(button=>button.addEventListener('click',()=>{if(focus)toggleFocus(false);}));
  });
  return {fit,refresh,shortest,toggleFocus,openPaths,calculateBetweenness,exportMapSvg,applyTimelineYear};
})();
