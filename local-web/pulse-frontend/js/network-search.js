/* Presentation-only search: reuse map nodes and links without relaying out the graph. */
const PulseNetworkSearch = (() => {
  const documents = new WeakMap();
  let ui=null, frame=null;

  function normalize(value) {
    return ' '+String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu,' ').trim()+' ';
  }
  function terms(query) {
    if ((query.match(/"/g)||[]).length%2) return {error:'Close the quotation mark around your phrase.',values:[]};
    const values=[...new Set([...query.matchAll(/"([^"]+)"|([^\s,;]+)/gu)]
      .map(match=>normalize(match[1]||match[2])).filter(value=>value.trim()))];
    return values.length>12?{error:'Use up to 12 keywords or quoted phrases.',values:[]}:{error:'',values};
  }
  function fields(paper) {
    const values=[paper.title,paper.abstract,paper.journal,paper.notes];
    for(const key of ['authors','paperKeywords','gemmaKeywords','keywords','userTags','tags']) {
      for(const value of Array.isArray(paper[key])?paper[key]:[]) {
        if(typeof value==='string')values.push(value);
      }
    }
    const previous=documents.get(paper);
    if(previous&&previous.values.length===values.length&&values.every((value,index)=>value===previous.values[index]))return previous.fields;
    const result=values.filter(value=>typeof value==='string'&&value.trim()).map(normalize);
    documents.set(paper,{values,fields:result});
    return result;
  }
  function setStatus(count,links,message='') {
    ui.count.textContent=count;ui.links.textContent=links;
    ui.status.title=message||`${count}; ${links}`;
    ui.status.setAttribute('aria-label',message||`${count}; ${links}`);
  }
  function update() {
    frame=null;
    if(!ui)return;
    const visible=!state.libraryFullscreen&&state.mode!=='table'
      &&(!els.timelineView||els.timelineView.hidden)&&(!els.trendsView||els.trendsView.hidden);
    ui.root.hidden=!visible;
    if(!visible)return;
    const query=ui.input.value.trim(),parsed=terms(query),active=Boolean(parsed.values.length&&!parsed.error);
    ui.clear.disabled=!ui.input.value;
    ui.input.setAttribute('aria-invalid',String(Boolean(parsed.error)));
    const papers=typeof activeMapPapers==='function'?activeMapPapers():state.papers;
    const byId=new Map(papers.map(paper=>[String(paper.id),paper])),matched=new Set();
    const nodes=els.map.querySelectorAll('.node'),edges=els.map.querySelectorAll('.edge');
    els.map.classList.toggle('network-search-active',active);
    for(const node of nodes) {
      const paper=byId.get(node.dataset.id);
      let match=false;
      if(active&&paper) {
        const text=fields(paper),test=term=>text.some(field=>field.includes(term));
        match=ui.mode.value==='all'?parsed.values.every(test):parsed.values.some(test);
        if(match)matched.add(node.dataset.id);
      }
      node.classList.toggle('is-network-match',match);
      node.classList.toggle('is-network-dimmed',active&&!match);
    }
    let links=0;
    for(const edge of edges) {
      const match=active&&matched.has(edge.dataset.source)&&matched.has(edge.dataset.target);
      edge.classList.toggle('is-network-match',match);
      edge.classList.toggle('is-network-dimmed',active&&!match);
      if(match)links++;
    }
    if(parsed.error)setStatus('Check query','Quotes / terms',parsed.error);
    else if(!active)setStatus(`${nodes.length} ${nodes.length===1?'paper':'papers'}`,'on this map');
    else setStatus(matched.size?`${matched.size} ${matched.size===1?'match':'matches'}`:'No matches',`${links} ${links===1?'link':'links'}`,
      `${matched.size} matching papers and ${links} connecting links shown on the active map.`);
  }
  function refresh() {
    if(ui&&frame===null)frame=requestAnimationFrame(update);
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const get=id=>document.getElementById(id);
    if(!get('networkSearch'))return;
    ui={root:get('networkSearch'),input:get('networkSearchInput'),mode:get('networkSearchMatch'),clear:get('networkSearchClear'),
      status:get('networkSearchStatus'),count:get('networkSearchCount'),links:get('networkSearchLinks')};
    const clear=()=>{ui.input.value='';refresh();ui.input.focus();};
    ui.input.addEventListener('input',refresh);
    ui.mode.addEventListener('change',refresh);
    ui.clear.addEventListener('click',clear);
    ui.input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();clear();}
      else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();refresh();}
    });
    refresh();
  });
  return {refresh};
})();
