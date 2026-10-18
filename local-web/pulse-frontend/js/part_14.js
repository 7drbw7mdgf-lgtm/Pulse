// Keyed, measured Library rows. Scroll work uses this model without sorting or
// generating markup for the rest of the saved library.
const libraryRowsUi = {root:null, mode:'', rows:new Map(), heights:new Map(), spacers:[], model:null, frame:null, measureFrame:null, observer:null};

function libraryRowIndex(prefix, offset) {
  let low=0, high=Math.max(0,prefix.length-2);
  while(low<high) { const middle=Math.ceil((low+high)/2); if(prefix[middle]<=offset) low=middle; else high=middle-1; }
  return low;
}

function libraryRowPrefix(ui) {
  const estimate=ui.mode==='expanded'?640:ui.mode==='table'?96:64;
  const prefix=[0];
  for(const paper of ui.model.papers) prefix.push(prefix.at(-1)+(ui.heights.get(paper.id)||estimate));
  ui.model.prefix=prefix;
}

function libraryRowElement(markup) {
  const template=document.createElement('template'); template.innerHTML=markup.trim();
  return template.content.firstElementChild;
}

function librarySyncRow(node,paper,index,total,mode) {
  node.classList.toggle('is-selected',state.selectedId===paper.id);
  node.classList.toggle('is-bulk-selected',Boolean(state.librarySelectedIds?.has(paper.id)));
  node.classList.toggle('is-multi-selected',Boolean(state.librarySelectedIds?.has(paper.id)));
  const bulk=node.querySelector('[data-action="select-library-row"]');
  if(bulk) bulk.checked=Boolean(state.librarySelectedIds?.has(paper.id));
  if(mode==='table') node.setAttribute('aria-rowindex',String(index+2));
  else { node.setAttribute('role','listitem'); node.setAttribute('aria-posinset',String(index+1)); node.setAttribute('aria-setsize',String(total)); }
}

function librarySpacer(ui,number,height) {
  let spacer=ui.spacers[number];
  if(!spacer) {
    spacer=document.createElement(ui.mode==='table'?'tr':'div');
    spacer.setAttribute('aria-hidden','true'); spacer.setAttribute('role','presentation'); spacer.dataset.librarySpacer='true';
    if(ui.mode==='table') { const cell=document.createElement('td'); cell.colSpan=10+(state.maps?.length>1?1:0); cell.style.cssText='padding:0;border:0;line-height:0'; spacer.appendChild(cell); }
    else spacer.style.cssText='flex:0 0 auto;padding:0;margin:0;border:0';
    ui.spacers[number]=spacer;
  }
  (ui.mode==='table'?spacer.firstElementChild:spacer).style.height=`${Math.max(0,height)}px`;
  return spacer;
}

function libraryMeasureRows(ui) {
  ui.measureFrame=null;
  if(ui!==libraryRowsUi || !ui.model || !ui.root.clientHeight) return;
  const model=ui.model, offset=Math.max(0,ui.root.scrollTop-model.offset);
  const anchor=libraryRowIndex(model.prefix,offset), fraction=offset-model.prefix[anchor];
  let changed=false;
  for(const node of ui.container.children) {
    const id=node.dataset.paper;
    if(!id) continue;
    const height=node.getBoundingClientRect().height+(ui.mode==='table'?0:3);
    if(height>0 && Math.abs((ui.heights.get(id)||0)-height)>.5) { ui.heights.set(id,height); changed=true; }
  }
  if(changed) {
    libraryRowPrefix(ui);
    // Preserve the paper at the viewport edge while estimates become measured
    // sizes. Only rows before that anchor can change its native scroll offset.
    const next=model.prefix[anchor]+fraction+model.offset;
    if(Math.abs(next-ui.root.scrollTop)>.5) ui.root.scrollTop=next;
    renderLibraryWindow(ui,false);
  }
}

function renderLibraryWindow(ui=libraryRowsUi,measure=true) {
  if(!ui.model || !ui.container) return;
  const model=ui.model, root=ui.root, papers=model.papers, count=papers.length;
  const offset=Math.max(0,root.scrollTop-model.offset), viewport=root.clientHeight||600;
  const first=libraryRowIndex(model.prefix,offset), last=libraryRowIndex(model.prefix,offset+viewport);
  const start=Math.max(0,first-6), end=Math.min(count,Math.max(start+1,Math.min(start+64,last+7)));
  const positions=new Set(); for(let index=start;index<end;index++) positions.add(index);
  const active=document.activeElement;
  const caret=typeof active?.selectionStart==='number'?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
  const focused=active?.closest?.('[data-paper]');
  const focusedIndex=focused && root.contains(focused)?model.byId.get(focused.dataset.paper):undefined;
  if(focusedIndex!==undefined) positions.add(focusedIndex);
  const ordered=[...positions].sort((a,b)=>a-b), desired=[];
  let focusReplacement=null;
  let previous=0,spacer=0;
  for(const index of ordered) {
    if(index>previous) desired.push(librarySpacer(ui,spacer++,model.prefix[index]-model.prefix[previous]));
    const paper=papers[index], markup=model.renderRow(paper);
    let cached=ui.rows.get(paper.id);
    // Never discard an editor while its uncommitted value or caret is active.
    const editing=cached?.node.contains(active) && active!==cached.node && Boolean(active?.matches?.('input,textarea,select'));
    if(!cached || (cached.markup!==markup && !editing)) {
      const node=libraryRowElement(markup);
      node.style.flexShrink='0'; if(ui.mode!=='table') node.style.marginBottom='3px';
      if(cached?.node.contains(active)) focusReplacement=active===cached.node?node:
        [...node.querySelectorAll('button,a,input,select,textarea')].find(control=>control.dataset.action&&control.dataset.action===active.dataset.action)||node;
      cached={node,markup}; ui.rows.set(paper.id,cached);
    }
    librarySyncRow(cached.node,paper,index,count,ui.mode);
    desired.push(cached.node); previous=index+1;
  }
  if(previous<count) desired.push(librarySpacer(ui,spacer++,model.prefix[count]-model.prefix[previous]));
  const keep=new Set(desired);
  for(const child of [...ui.container.children]) if(!keep.has(child)) child.remove();
  let cursor=ui.container.firstElementChild;
  for(const child of desired) {
    if(child===cursor) cursor=cursor.nextElementSibling;
    else ui.container.insertBefore(child,cursor);
  }
  if(focusReplacement) focusReplacement.focus?.({preventScroll:true});
  else if(active && root.contains(active) && document.activeElement!==active) {
    active.focus?.({preventScroll:true});
    if(caret) active.setSelectionRange?.(...caret);
  }
  // Detached cache entries make reverse scrolling cheap, without retaining a
  // thousand fully expanded editor trees after browsing the whole library.
  if(ui.rows.size>128) for(const [id,entry] of ui.rows) {
    if(ui.rows.size<=128) break;
    if(!keep.has(entry.node)) ui.rows.delete(id);
  }
  if(measure && ui.measureFrame===null && typeof requestAnimationFrame==='function') ui.measureFrame=requestAnimationFrame(()=>libraryMeasureRows(ui));
}

function renderLibraryRows(papers,options) {
  const root=els.paperList, ui=libraryRowsUi;
  bindLibraryRowEvents(root);
  if(typeof document.createElement!=='function' || typeof root.insertBefore!=='function') {
    root.innerHTML=!papers.length?options.emptyMarkup:options.mode==='table'?options.tableMarkup.replace('<tbody></tbody>',`<tbody>${papers.map(options.renderRow).join('')}</tbody>`):papers.map(options.renderRow).join('');
    return;
  }
  const width=Math.round((root.clientWidth||320)/8)*8;
  const structure=`${options.mode}:${Boolean(state.maps?.length>1)}`;
  const controls=JSON.stringify([structure,state.librarySortKey,state.librarySortAsc,state.filterMode,state.filterTags||[]]);
  const reset=ui.root!==root || ui.structure!==structure;
  const prior=ui.model;
  const priorOffset=prior?Math.max(0,root.scrollTop-prior.offset):0;
  let anchorIndex=prior?libraryRowIndex(prior.prefix,priorOffset):0;
  const focused=document.activeElement?.closest?.('[data-paper]');
  const focusedIndex=focused&&prior?prior.byId.get(focused.dataset.paper):undefined;
  if(focusedIndex!==undefined && prior.prefix[focusedIndex]>=priorOffset && prior.prefix[focusedIndex]<priorOffset+(root.clientHeight||600)) anchorIndex=focusedIndex;
  const anchorId=prior?.papers[anchorIndex]?.id;
  const anchorDelta=prior?priorOffset-prior.prefix[anchorIndex]:0;
  if(reset) {
    ui.observer?.disconnect();
    ui.root=root;ui.mode=options.mode;ui.structure=structure;ui.rows.clear();ui.heights.clear();ui.spacers=[];
    root.style.gap='0';root.style.overflowAnchor='none';
    root.innerHTML=options.mode==='table'?options.tableMarkup:'';
    ui.container=options.mode==='table'?root.querySelector('tbody'):root;
    ui.header=options.mode==='table'?root.querySelector('thead'):null;ui.headerMarkup=options.tableMarkup;
    if(typeof ResizeObserver!=='undefined') { ui.observer=new ResizeObserver(()=>{if(ui.model&&Math.round(root.clientWidth/8)*8!==ui.model.width)renderPapers();});ui.observer.observe(root); }
  } else if(options.mode==='table' && ui.headerMarkup!==options.tableMarkup) {
    const sorted=document.activeElement?.dataset.tableSort;
    const head=options.tableMarkup.match(/<thead>([\s\S]*?)<\/thead>/)?.[1]||'';
    ui.header.innerHTML=head;ui.headerMarkup=options.tableMarkup;
    if(sorted) root.querySelector(`[data-table-sort="${sorted}"]`)?.focus({preventScroll:true});
  }
  if(!papers.length) {
    root.innerHTML=options.emptyMarkup;ui.structure='';ui.model=null;ui.rows.clear();return;
  }
  if(prior?.width!==width) ui.heights.clear();
  ui.model={papers,renderRow:options.renderRow,clusterByPaper:options.clusterByPaper,byId:new Map(papers.map((paper,index)=>[paper.id,index])),controls,width,offset:options.mode==='table'?(ui.header?.getBoundingClientRect().height||44):4};
  libraryRowPrefix(ui);
  if(prior && prior.controls!==controls) root.scrollTop=0;
  else if(prior && anchorId && ui.model.byId.has(anchorId)) {
    const nextIndex=ui.model.byId.get(anchorId);
    if(nextIndex!==anchorIndex || prior.width!==width) root.scrollTop=Math.max(0,ui.model.prefix[nextIndex]+anchorDelta+ui.model.offset);
  }
  renderLibraryWindow(ui);
  if(options.mode==='table') root.querySelector('table')?.setAttribute('aria-rowcount',String(papers.length+1));
}

function bindLibraryRowEvents(root) {
  if(root.__pulseRowsBound || typeof root.addEventListener!=='function') return;
  root.__pulseRowsBound=true;
  root.addEventListener('scroll',()=>{if(libraryRowsUi.root!==root||libraryRowsUi.frame!==null)return;libraryRowsUi.frame=requestAnimationFrame(()=>{libraryRowsUi.frame=null;renderLibraryWindow();});},{passive:true});
  root.addEventListener('focusout',()=>{if(libraryRowsUi.model)requestAnimationFrame(()=>renderLibraryWindow());});
  root.addEventListener('keydown',event=>{
    const card=event.target.closest?.('[data-paper]');
    if(card && event.target===card && (event.key==='Enter'||event.key===' ')) {event.preventDefault();inspectPaper(card.dataset.paper);}
  });
  root.addEventListener('click',event=>{
    const target=event.target.closest?.('[data-action],[data-table-sort]');
    const card=event.target.closest?.('[data-paper]');
    if(target?.dataset.tableSort) {
      const key=target.dataset.tableSort;state.librarySortAsc=state.librarySortKey===key?!state.librarySortAsc:['title','authors','journal','group'].includes(key);state.librarySortKey=key;renderPapers();return;
    }
    const action=target?.dataset.action, paper=card?state.papers.find(item=>item.id===card.dataset.paper):null;
    if(action==='clear-filters-from-list'){clearFilterTags();return;}
    if(action==='remove'&&paper){removePapersWithRecovery([paper.id]);return;}
    if(action==='focus'&&paper){inspectPaper(paper.id);return;}
    if(action==='paper-keyword') {event.stopPropagation();const term=cleanField(target.dataset.keyword||'');if(term){if(paper)state.selectedId=paper.id;openTagActionMenu(term,target,paper?.id);}return;}
    if(action==='show-all-keywords'||action==='open-paper-keywords'){event.stopPropagation();const id=target.dataset.paper||paper?.id;if(id)openKeywordModal(id);return;}
    if(action==='color-group'&&paper){
      event.stopPropagation();const lookup=libraryRowsUi.model?.clusterByPaper||new Map();const color=paper.color||(typeof paperColor==='function'?paperColor(paper,lookup):'#4f46e5');const group=lookup.get(paper.id);let count=0;
      if(paper.areaId){const area=state.areas.find(item=>item.id===paper.areaId);if(area)area.color=color;}
      for(const item of state.papers)if(paper.areaId?item.areaId===paper.areaId:group!==undefined?lookup.get(item.id)===group:item.id===paper.id){item.color=color;count++;}
      render();showToast(`Applied colour to ${count} grouped paper${count===1?'':'s'}.`);return;
    }
    if(!event.target.closest?.('button,a,input,select,textarea,.compact-chip')&&paper)inspectPaper(paper.id);
  });
  root.addEventListener('change',event=>{
    const target=event.target,card=target.closest?.('[data-paper]');
    const paper=card?state.papers.find(item=>item.id===card.dataset.paper):null;
    if(!paper)return;
    const action=target.dataset.action,field=target.dataset.field;
    if(action==='toggle-paper-active'){event.stopPropagation();if(typeof setPaperOnMap==='function')setPaperOnMap(paper,state.activeMapId,target.checked);else paper.selected=target.checked;render();if(typeof renderMapTabs==='function')renderMapTabs();return;}
    if(action==='set-paper-map-tab'){event.stopPropagation();if(typeof setPaperMapTab==='function')setPaperMapTab(paper.id,target.value);return;}
    if(!field)return;
    if(field==='paperKeywords')paper.paperKeywords=splitKeywords(target.value);
    else if(field==='authors')paper.authors=splitAuthors(target.value);
    else if(field==='date'){paper.date=target.value;paper.year=(target.value.match(/\b(19|20)\d{2}\b/)||[''])[0];}
    else if(field==='doi'){paper.doi=normalizeDoi(target.value)||target.value.trim();enrichPaperFromDoi(paper).then(()=>render());return;}
    else paper[field]=target.value;
    render();
  });
}


    // "Tian C, Yang M, Xu H, et al." for tables; the full list is in the cell's tooltip.
    function shortAuthorList(authors, max = 3) {
      const names = (authors || []).map(name => {
        const parts = String(name || '').trim().split(/\s+/);
        if (parts.length < 2) return parts[0] || '';
        if (/,/.test(name)) return String(name).trim();
        const surname = parts.pop();
        return `${surname} ${parts.flatMap(p => p.split('-')).map(p => p.replace(/[^\p{L}]/gu, '').charAt(0).toUpperCase()).join('')}`.trim();
      }).filter(Boolean);
      return names.length > max ? `${names.slice(0, max).join(', ')}, et al.` : names.join(', ');
    }

    function renderPapers() {
      const areaOptions = paper => [
        `<option value="">No area</option>`,
        ...state.areas.map(area => `<option value="${area.id}" ${paper.areaId === area.id ? 'selected' : ''}>${escapeHtml(area.name)}</option>`)
      ].join('');
      const paperMetaChips = paper => {
        const allKeywords = displayKeywords(paper);
        const keywords = allKeywords.slice(0, 3);
        const extra = Math.max(0, allKeywords.length - keywords.length);
        const userTags = (typeof paperUserTags === 'function' ? paperUserTags(paper) : []).slice(0, 3);
        const chips = [
          ...userTags.map(value => ({ value, action: 'paper-keyword', title: `Your tag: ${value}`, userTag: true })),
          ...keywords.map((value, idx) => ({ value, action: 'paper-keyword', title: `Keyword #${idx + 1}: ${value}` })),
          ...(extra ? [{ value: `+${extra}`, action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }] : [{ value: '🏷️ tags', action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }])
        ];
        return chips.map(item => `<button class="compact-chip${item.action === 'open-paper-keywords' ? ' tag-edit-chip' : ''}${item.userTag ? ' is-user-tag' : ''}" type="button" data-action="${item.action}" data-keyword="${escapeHtml(item.value)}" data-paper="${paper.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.value)}</button>`).join('');
      };
      const clusterByPaper = new Map();
      state.clusters.forEach((cluster, index) => cluster.forEach(id => clusterByPaper.set(id, index)));
      const strongestByPaper = new Map();
      for (const link of state.links || []) {
        const score = Number(link.score || 0);
        strongestByPaper.set(link.source, Math.max(strongestByPaper.get(link.source) || 0, score));
        strongestByPaper.set(link.target, Math.max(strongestByPaper.get(link.target) || 0, score));
      }
      const paperOrganizeMarkup = paper => {
        const group = typeof paperGroupInfo === 'function' ? paperGroupInfo(paper, clusterByPaper) : { color: paperColor(paper, clusterByPaper), name: '' };
        return `
        <div class="paper-organize">
          <label class="paper-control paper-color" title="Paper colour">
            <input type="color" value="${escapeHtml(paper.color || group.color)}" data-field="color" aria-label="Paper colour">
          </label>
          <button type="button" class="button small secondary group-color-btn" data-action="color-group" data-paper="${paper.id}" title="Apply this colour to all papers in this group${group.name ? ` (${escapeHtml(group.name)})` : ''}">Colour group</button>
          <label class="paper-control paper-area" title="Map area">
            <select data-field="areaId" aria-label="Map area">${areaOptions(paper)}</select>
          </label>
          ${state.maps && state.maps.length > 1 ? `
          <label class="paper-control paper-map-tab" title="Assign to map tab">
            <select class="paper-map-tab-dropdown" data-action="set-paper-map-tab" data-paper="${paper.id}" aria-label="Assign to map tab">
              ${typeof mapTabOptionsMarkup === 'function' ? mapTabOptionsMarkup(paper) : ''}
            </select>
          </label>` : ''}
          <div class="paper-actions-row">
            <button class="icon-button" title="Focus paper on graph" aria-label="Focus paper on graph" data-action="focus" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></button>
            <button class="icon-button danger" title="Remove paper" aria-label="Remove paper" data-action="remove" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg></button>
          </div>
        </div>
      `;
      };
      const paperHeaderMarkup = paper => {
        const match = Math.max(0, Math.min(99, Math.round((strongestByPaper.get(paper.id) || 0) * 100)));
        const publication = [paper.journal, paper.year || paper.date].filter(Boolean).join(' · ');
        const isOnActive = typeof isPaperOnActiveMap === 'function' ? isPaperOnActiveMap(paper) : paper.selected !== false;
        const group = typeof paperGroupInfo === 'function' ? paperGroupInfo(paper, clusterByPaper) : { color: paperColor(paper, clusterByPaper), name: '' };
        return `
          <div class="paper-card-top">
            <input type="checkbox" class="paper-chk" ${isOnActive ? 'checked' : ''} data-action="toggle-paper-active" title="Toggle paper on active map" aria-label="Toggle paper on active map">
            <span class="paper-swatch" style="background:${escapeHtml(group.color)}" title="${escapeHtml(group.name ? group.name + ' (' + group.color + ')' : group.color)}"></span>
            ${group.name ? `<span class="paper-group-badge" style="background:${escapeHtml(group.color)}20; color:${escapeHtml(group.color)}; border:1px solid ${escapeHtml(group.color)}55;" title="Group: ${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>` : ''}
            <span class="paper-publication">${escapeHtml(publication || paperDomainLabel(paper))}</span>
            ${match ? `<span class="paper-badge match" title="Strongest link to another paper">${match}%</span>` : ''}
          </div>
        `;
      };
      const paperFactsMarkup = paper => {
        const authorCount = paperAuthors(paper).length;
        const facts = [
          paperStudyType(paper),
          `${authorCount || 'No'} author${authorCount === 1 ? '' : 's'}`,
          paperCitationCount(paper) !== null ? `${paperCitationCount(paper)} citations (${paper.citationMetrics.source})` : ''
        ].filter(Boolean);
        return `<div class="paper-facts">${facts.map(fact => `<span class="paper-fact">${escapeHtml(fact)}</span>`).join('')}</div>`;
      };
      const renderCompactPaper = paper => {
        const group = typeof paperGroupInfo === 'function' ? paperGroupInfo(paper, clusterByPaper) : { color: paperColor(paper, clusterByPaper), name: '' };
        return `
        <article class="pulse-paper-card" data-paper="${paper.id}" tabindex="0" style="border-left: 3.5px solid ${escapeHtml(group.color)};" aria-label="Inspect ${escapeHtml(paper.title || 'Untitled paper')}">
          <input type="checkbox" class="paper-chk" ${typeof isPaperOnActiveMap === 'function' ? (isPaperOnActiveMap(paper) ? 'checked' : '') : (paper.selected !== false ? 'checked' : '')} data-action="toggle-paper-active" title="Toggle paper on active map">
          <div class="pulse-paper-card-body">
            <div class="pulse-paper-title"><span class="paper-swatch" style="background:${escapeHtml(group.color)}; display:inline-block; vertical-align:middle; margin-right:4px;" title="${escapeHtml(group.name ? group.name + ' (' + group.color + ')' : group.color)}"></span>${escapeHtml(paper.title || 'Untitled paper')}</div>
            <div class="pulse-paper-meta" title="${escapeHtml([paperAuthorSummary(paper), paper.year, paper.journal, group.name].filter(Boolean).join(' · '))}">
              <span class="pulse-paper-author">${escapeHtml(paperAuthors(paper).length > 1 ? paperAuthors(paper)[0] + ' et al.' : paperAuthorSummary(paper))}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${group.name ? `<span class="pulse-paper-badge-group" style="background:${escapeHtml(group.color)}20; color:${escapeHtml(group.color)}; border:1px solid ${escapeHtml(group.color)}55;" title="Group: ${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>` : ''}
              ${paperCitationCount(paper) !== null ? `<span class="pulse-paper-badge-cit" title="${escapeHtml(paper.citationMetrics.source)} citations">★ ${paperCitationCount(paper)}</span>` : ''}
              ${paper.doi ? `<span class="pulse-paper-badge-doi" title="${escapeHtml(paper.doi)}">DOI</span>` : ''}
              ${state.maps && state.maps.length > 1 ? `
              <div class="paper-map-tab-selector">
                <select class="paper-map-tab-dropdown" data-action="set-paper-map-tab" data-paper="${paper.id}" title="Assign to map tab" aria-label="Assign to map tab">
                  ${typeof mapTabOptionsMarkup === 'function' ? mapTabOptionsMarkup(paper) : ''}
                </select>
              </div>` : ''}
            </div>
          </div>
        </article>
      `;
      };
      const renderExpandedPaper = paper => {
        const group = typeof paperGroupInfo === 'function' ? paperGroupInfo(paper, clusterByPaper) : { color: paperColor(paper, clusterByPaper), name: '' };
        return `
        <article class="paper-card" data-paper="${paper.id}" tabindex="0" style="border-left: 3.5px solid ${escapeHtml(group.color)};" aria-label="Inspect ${escapeHtml(paper.title || 'Untitled paper')}">
          ${paperHeaderMarkup(paper)}
          <div class="paper-title">${escapeHtml(paper.title || 'Untitled paper')}</div>
          <div class="paper-authors">${escapeHtml(paperAuthorSummary(paper))}</div>
          <div class="compact-meta">${paperMetaChips(paper)}</div>
          ${paperFactsMarkup(paper)}
          ${paper.metadataSource || paper.metadataNote ? `<div class="metadata-line">${escapeHtml(paper.metadataSource ? `Metadata filled from ${paper.metadataSource}.` : paper.metadataNote)}</div>` : ''}
          <div class="paper-edit-grid">
            <label>
              Title
              <input value="${escapeHtml(paper.title)}" data-field="title">
            </label>
            <div class="metadata-grid">
              <label>
                Authors
                <input value="${escapeHtml(paperAuthors(paper).join('; '))}" data-field="authors">
              </label>
              <label>
                Date
                <input value="${escapeHtml(paper.date || paper.year || '')}" data-field="date">
              </label>
              <label>
                Journal
                <input value="${escapeHtml(paper.journal || '')}" data-field="journal">
              </label>
              <label>
                DOI
                <input value="${escapeHtml(paper.doi || '')}" data-field="doi">
              </label>
            </div>
            <label>
              Abstract
              <textarea data-field="abstract">${escapeHtml(paper.abstract || '')}</textarea>
            </label>
            <label>
              <div class="terms-header-row">
                <span>Keywords</span>
                <button class="button small secondary tag-edit-chip" type="button" data-action="open-paper-keywords" data-paper="${paper.id}">🏷️ Manage tags</button>
              </div>
              <input value="${escapeHtml((paper.paperKeywords || []).join('; '))}" data-field="paperKeywords">
            </label>
          </div>
          ${paperOrganizeMarkup(paper)}
        </article>
      `;
      };
      const showMapCol = Boolean(state.maps && state.maps.length > 1);
      const renderLibraryTableRow = paper => {
          const count = paperCitationCount(paper);
          const isOnActive = typeof isPaperOnActiveMap === 'function' ? isPaperOnActiveMap(paper) : paper.selected !== false;
          const group = typeof paperGroupInfo === 'function' ? paperGroupInfo(paper, clusterByPaper) : { color: paperColor(paper, clusterByPaper), name: '' };
          return `<tr class="library-table-row" data-paper="${escapeHtml(paper.id)}" tabindex="0" style="box-shadow: inset 3.5px 0 0 ${escapeHtml(group.color)};" aria-label="Inspect ${escapeHtml(paper.title || 'Untitled paper')}">
          <td class="library-select-column"><input type="checkbox" data-action="select-library-row"  aria-label="Select ${escapeHtml(paper.title || 'Untitled paper')} for bulk actions"></td><td class="library-map-column"><input type="checkbox" data-action="toggle-paper-active" ${isOnActive ? 'checked' : ''} aria-label="Show ${escapeHtml(paper.title || 'Untitled paper')} on map"></td>
          ${showMapCol ? `<td class="library-maptab-column"><select class="table-map-tab-select" data-action="set-paper-map-tab" data-paper="${paper.id}" aria-label="Assign to map tab">${typeof mapTabOptionsMarkup === 'function' ? mapTabOptionsMarkup(paper) : ''}</select></td>` : ''}
          <td class="library-title-cell"><span class="paper-swatch" style="background:${escapeHtml(group.color)}; display:inline-block; vertical-align:middle; margin-right:6px;" title="${escapeHtml(group.name ? group.name + ' (' + group.color + ')' : group.color)}"></span><button type="button" data-action="focus" class="library-title-button">${escapeHtml(paper.title || 'Untitled paper')}</button></td>
          <td class="library-group-cell">${group.name ? `<span class="library-group-pill" style="color:${escapeHtml(group.color)}; border:1px solid ${escapeHtml(group.color)}55; background:${escapeHtml(group.color)}18;" title="Group: ${escapeHtml(group.name)}"><span class="paper-swatch" style="background:${escapeHtml(group.color)}; width:6px; height:6px; display:inline-block; vertical-align:middle; margin-right:4px;"></span>${escapeHtml(group.name)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
          <td class="library-authors-cell" title="${escapeHtml(paperAuthors(paper).join(', '))}">${escapeHtml(shortAuthorList(paperAuthors(paper)) || '—')}</td><td class="library-year-cell">${escapeHtml(paper.year || '—')}</td>
          <td class="library-journal-cell">${escapeHtml(paper.journal || '—')}</td><td class="library-citations-cell" title="${escapeHtml(count !== null ? 'Verified from ' + paper.citationMetrics.source : 'Citation count not checked')}">${count !== null ? count.toLocaleString() : '—'}</td>
          <td class="library-doi-cell">${paper.doi ? `<a href="${escapeHtml((typeof paperOpenUrl === 'function' ? paperOpenUrl(paper) : '') || safePaperUrl('https://doi.org/' + paper.doi))}" target="_blank" rel="noreferrer">${escapeHtml(paper.doi)}</a>` : '—'}</td><td class="library-tags-cell"><div class="library-table-tags">${paperMetaChips(paper)}</div></td></tr>`;

      };
      const renderLibraryTable = papers => {
        const columns = [['title', 'Paper'], ['group', 'Group'], ['authors', 'Authors'], ['year', 'Year'], ['journal', 'Journal'], ['citations', 'Citations']];
        const headers = columns.map(([key, label]) => `<th scope="col" class="library-col-${key}" aria-sort="${state.librarySortKey === key ? (state.librarySortAsc ? 'ascending' : 'descending') : 'none'}"><button type="button" data-table-sort="${key}">${label}${state.librarySortKey === key ? (state.librarySortAsc ? ' ↑' : ' ↓') : ''}</button></th>`).join('');
        const showMapCol = Boolean(state.maps && state.maps.length > 1);
        return `<table class="library-table"><caption class="sr-only">Papers in your library. Select a paper to open its inspector.</caption><thead><tr><th scope="col" class="library-select-column"><input id="librarySelectVisible" type="checkbox" aria-label="Select all visible papers"></th><th scope="col" class="library-map-column">On map</th>${showMapCol ? '<th scope="col" class="library-maptab-column">Map</th>' : ''}${headers}<th scope="col" class="library-col-doi">DOI</th><th scope="col" class="library-col-tags">Tags</th></tr></thead><tbody>${papers.map(renderLibraryTableRow).join('')}</tbody></table>`;
      };


      const hasFilter = Boolean(state.filterTags && state.filterTags.length > 0);
      const displayPapers = libraryDisplayPapers({clusterByPaper});

      if (els.paperCount) {
        els.paperCount.textContent = hasFilter
          ? `Showing ${displayPapers.length} of ${state.papers.length} (filtered)`
          : `${state.papers.length} paper${state.papers.length === 1 ? '' : 's'}`;
      }
      if (els.railLibraryBadge) {
        els.railLibraryBadge.textContent = state.papers.length;
      }
      els.paperList.classList.toggle('is-table', state.libraryFullscreen);
      els.paperList.setAttribute('role', state.libraryFullscreen ? 'region' : 'list');
      const mode = state.libraryFullscreen ? 'table' : state.paperView === 'compact' ? 'compact' : 'expanded';
      const renderRow = mode === 'table' ? renderLibraryTableRow : mode === 'compact' ? renderCompactPaper : renderExpandedPaper;
      const emptyMarkup = hasFilter
        ? `<div class="empty-filter-state" style="padding:24px 16px;text-align:center;color:var(--muted)"><p>No papers match the active tag filter${state.filterTags.length > 1 ? 's' : ''}.</p><button class="button small secondary" data-action="clear-filters-from-list" type="button">Clear tag filters</button></div>`
        : '<div class="empty-filter-state" style="padding:24px 16px;text-align:center;color:var(--muted)">No papers in library yet.</div>';
      renderLibraryRows(displayPapers,{mode,renderRow,tableMarkup:renderLibraryTable([]),emptyMarkup,clusterByPaper});
      renderLibraryBulkActions(displayPapers);
      if (typeof renderMultiSelection === 'function') renderMultiSelection();
    }

    function connectionStrengthLabel(score) {
      if (score >= 0.85) return 'Very Strong Connection';
      if (score >= 0.65) return 'Strong Connection';
      if (score >= 0.45) return 'Moderate Relationship';
      return 'Emerging / Weak Connection';
    }

    function focusPairOnMap(source, target) {
      if (!source || !target) return;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const dist = Math.max(80, Math.hypot(source.x - target.x, source.y - target.y));
      const targetWidth = Math.max(380, Math.min(1800, dist * 2.8));
      const targetHeight = targetWidth * 0.75;
      state.view.width = targetWidth;
      state.view.height = targetHeight;
      state.view.x = midX - targetWidth / 2;
      state.view.y = midY - targetHeight / 2;
      render();
      showToast(`Focused on ${compactTitle(source.title)} ↔ ${compactTitle(target.title)}.`);
    }
