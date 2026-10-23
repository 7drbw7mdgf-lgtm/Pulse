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
  function openPaths() {
    const root=document.getElementById('paperPathDialog'),papers=activeMapPapers();
    if(papers.length<2)return showToast('Add at least two papers to this map.');
    const selected=[...state.librarySelectedIds||[]].filter(id=>papers.some(p=>p.id===id));
    const options=papers.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)}</option>`).join('');
    for(const id of ['pathStart','pathEnd'])document.getElementById(id).innerHTML=options;
    document.getElementById('pathStart').value=selected[0]||(papers.some(p=>p.id===state.selectedId)?state.selectedId:papers[0].id);
    document.getElementById('pathEnd').value=selected[1]||papers.find(p=>p.id!==document.getElementById('pathStart').value).id;
    document.getElementById('paperPathResult').replaceChildren();root.showModal();
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
    document.getElementById('focusMapButton').onclick=()=>toggleFocus();document.getElementById('openPaperPaths').onclick=openPaths;
    const root=document.createElement('dialog');root.id='paperPathDialog';root.className='pulse-tool-dialog';
    root.innerHTML='<header><h2>Paths between papers</h2><button type="button" data-close-tool aria-label="Close paths">×</button></header><p>Explore connections already loaded in this map. Paths can be followed in either direction; similarity and shared references do not establish a citation.</p><div class="tool-form"><label>From<select id="pathStart"></select></label><label>To<select id="pathEnd"></select></label><fieldset><legend>Link types</legend>'+Object.entries(names).map(([key,label])=>`<label><input type="checkbox" name="pathType" value="${key}" checked>${label}</label>`).join('')+'</fieldset><button id="findPaperPath" type="button">Find shortest path</button><button id="clearPaperPath" type="button">Clear path</button></div><div id="paperPathResult" role="status"></div>';
    document.body.append(root);root.querySelector('[data-close-tool]').onclick=()=>root.close();document.getElementById('findPaperPath').onclick=showPath;document.getElementById('clearPaperPath').onclick=()=>{path=null;refresh();root.close();};
    const button=document.createElement('button');button.id='mapSelectionPath';button.type='button';button.textContent='Show path';button.onclick=openPaths;document.getElementById('mapSelectionClear').before(button);
    resizer(document.getElementById('colLibrary'),'library');resizer(document.getElementById('details'),'inspector');
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&focus&&!document.querySelector('dialog[open]')&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)){event.preventDefault();toggleFocus(false);}});
    document.querySelectorAll('[data-rail]').forEach(button=>button.addEventListener('click',()=>{if(focus)toggleFocus(false);}));
  });
  return {fit,refresh,shortest,toggleFocus,openPaths};
})();
