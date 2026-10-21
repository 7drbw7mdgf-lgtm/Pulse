/* Presentation-only search: reuse map nodes and links without relaying out the graph. */
const PulseNetworkSearch = (() => {
  const documents = new WeakMap();
  const explanations = new WeakMap();
  let ui=null, frame=null, currentId=null, lastResultKey='', currentMatches=[];

  function explanation(paper,parsed) {
    const fieldsRef=fields(paper),query=parsed.values.join('\u0000'),cached=explanations.get(paper);
    if(cached?.fields===fieldsRef&&cached.query===query)return cached.value;
    const entries=[['Title',paper.title],['Abstract',paper.abstract],['Notes',paper.notes],['Journal',paper.journal],
      ['Authors',(paper.authors||[]).join(' ')],['Keywords',[...(paper.paperKeywords||[]),...(paper.gemmaKeywords||[]),...(paper.keywords||[])].join(' ')],['Tags',[...(paper.userTags||[]),...(paper.tags||[])].join(' ')]].map(([label,text])=>[label,text,normalize(text)]);
    const hits=parsed.values.map(term=>({term:term.trim(),entry:entries.find(([,value,normalized])=>normalized.includes(term))})).filter(hit=>hit.entry);
    const first=hits[0], text=String(first?.entry[1]||'');
    const at=first?normalize(text).indexOf(' '+first.term+' '):0,start=Math.max(0,at-55);
    const value={why:hits.map(hit=>`${hit.term} (${hit.entry[0].toLowerCase()})`).join(' · '),snippet:(start?'…':'')+text.slice(start,start+200)+(text.length>start+200?'…':'')};
    explanations.set(paper,{fields:fieldsRef,query,value});return value;
  }
  function selectMatch(id) {
    if(!currentMatches.includes(id))return;
    currentId=id;state.selectedId=id;renderDetails();
    if(typeof updateGraphSelectionClasses==='function')updateGraphSelectionClasses();
    if(typeof PulseMapTools!=='undefined')PulseMapTools.fit([id]);
    refresh();
  }

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
    currentMatches=[...matched];
    if(!matched.has(currentId))currentId=null;
    const only=active&&ui.only.checked;
    for(const node of nodes){node.classList.toggle('is-network-hidden',only&&!matched.has(node.dataset.id));node.classList.toggle('is-network-current',node.dataset.id===currentId);}
    els.map.querySelectorAll('.edge,.edge-hit').forEach(edge=>edge.classList.toggle('is-network-hidden',only&&!(matched.has(edge.dataset.source)&&matched.has(edge.dataset.target))));
    if(typeof PulseMapTools!=='undefined')PulseMapTools.refresh();
    ui.actions.hidden=!active;ui.results.hidden=!active;
    for(const button of [ui.previous,ui.next,ui.fit])button.disabled=!matched.size;
    ui.position.textContent=currentId?`${currentMatches.indexOf(currentId)+1} of ${matched.size}`:`${matched.size} matches`;
    const resultKey=JSON.stringify(currentMatches.map(id=>[id,byId.get(id)?.title,explanation(byId.get(id),parsed)]));
    if(resultKey!==lastResultKey){
      lastResultKey=resultKey;
      ui.list.innerHTML=currentMatches.slice(0,100).map(id=>{const paper=byId.get(id),why=explanation(paper,parsed);return `<li><button type="button" data-network-result="${escapeHtml(id)}">${escapeHtml(paper.title)}</button><small>Matched: ${escapeHtml(why.why)}</small><small>${escapeHtml(why.snippet)}</small></li>`;}).join('')+(matched.size>100?'<li>Showing the first 100 snippets. Next/previous visits every match.</li>':'');
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
    ui.root.insertAdjacentHTML('beforeend','<div id="networkSearchActions" class="network-search-actions" hidden><button id="networkSearchPrev" type="button" aria-label="Previous network match">←</button><span id="networkSearchPosition" role="status"></span><button id="networkSearchNext" type="button" aria-label="Next network match">→</button><button id="networkSearchFit" type="button">Fit all matches</button><label><input id="networkSearchOnly" type="checkbox">Show matches only</label></div><details id="networkSearchResults" class="network-search-results" hidden><summary>Matched papers &amp; snippets</summary><ol></ol></details>');
    Object.assign(ui,{actions:get('networkSearchActions'),previous:get('networkSearchPrev'),next:get('networkSearchNext'),position:get('networkSearchPosition'),fit:get('networkSearchFit'),only:get('networkSearchOnly'),results:get('networkSearchResults'),list:get('networkSearchResults').querySelector('ol')});
    ui.previous.onclick=()=>{const index=currentMatches.indexOf(currentId);selectMatch(currentMatches[index<0?currentMatches.length-1:(index-1+currentMatches.length)%currentMatches.length]);};
    ui.next.onclick=()=>selectMatch(currentMatches[(currentMatches.indexOf(currentId)+1)%currentMatches.length]);
    ui.fit.onclick=()=>PulseMapTools.fit(currentMatches);ui.only.onchange=refresh;
    ui.list.onclick=event=>{const button=event.target.closest('[data-network-result]');if(button)selectMatch(button.dataset.networkResult);};
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
