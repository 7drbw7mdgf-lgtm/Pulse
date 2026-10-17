// A native, scrollable paper deck using real publication metadata.
const timelineMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let timelineRenderedSignature = '';
let timelineReadingScroll = false;
let timelineSelecting = false;
let timelineResizeObserver = null;
let timelineModel = null;
let timelineViewportHeight = 0;
let timelineScrollFrame = null;
let timelineScrollTimer = null;
let timelinePendingInspectorId = null;
let timelineRailElement = null;
let timelineRailSignature = '';
let timelineModelVersion = 0;
const timelineOverscan = 2;

function parsePaperDate(paper) {
  const raw = String(paper?.date || paper?.publicationDate || paper?.year || '').trim();
  const match = raw.match(/\b(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!match || Number(match[1]) < 1500) return {sortKey:'9999-99-99', label:'Date unknown', year:'Undated', month:null, day:null, precision:'unknown'};
  const year = match[1];
  let month = match[2] ? Number(match[2]) : null;
  let day = match[3] ? Number(match[3]) : null;
  if (month < 1 || month > 12) { month = null; day = null; }
  if (month && day !== null) {
    const date = new Date(Date.UTC(Number(year), month - 1, day));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) day = null;
  }
  const precision = day !== null ? 'day' : month !== null ? 'month' : 'year';
  const label = month ? `${day !== null ? day + ' ' : ''}${timelineMonthNames[month - 1]} ${year}` : year;
  // Missing month/day are only padded for ordering, never presented as known dates.
  return {sortKey:`${year}-${String(month || 1).padStart(2,'0')}-${String(day || 1).padStart(2,'0')}`, label, year, month, day, precision};
}

function chronologicalPapers() {
  return state.papers.map(paper => ({paper, date:parsePaperDate(paper)}))
    .sort((a,b) => a.date.sortKey.localeCompare(b.date.sortKey));
}

function timelineDateGroups(ordered) {
  const groups = [], byYear = new Map();
  ordered.forEach(({paper,date}, index) => {
    let group = byYear.get(date.year);
    if (!group) { group = {year:date.year, index, count:0, months:[], byMonth:new Map()}; groups.push(group); byYear.set(date.year,group); }
    group.count++;
    let month = group.byMonth.get(date.month);
    if (!month) { month = {number:date.month, label:date.month ? timelineMonthNames[date.month - 1] : 'Month unknown', index, papers:[]}; group.months.push(month); group.byMonth.set(date.month,month); }
    month.papers.push({paper,date,index});
  });
  return groups;
}

function timelineFocusIndex(ordered) {
  let index = ordered.findIndex(item => item.paper.id === state.timelineFocusId);
  if (index < 0) index = ordered.findIndex(item => item.paper.id === state.selectedId);
  return index >= 0 ? index : 0;
}

function setTimelineVisible(visible) {
  if (!els.timelineView) return;
  els.timelineView.hidden = !visible;
  els.app.classList.toggle('timeline-active', visible);
  if (visible) { state.timelineFocusId = state.selectedId; renderTimeline(); }
  else cancelTimelineScrollWork();
}

function selectTimelineIndex(index, focusControl = 'stage') {
  const ordered = timelineModel?.ordered || chronologicalPapers();
  if (!Number.isInteger(index) || index < 0 || index >= ordered.length) return false;
  cancelTimelineScrollWork();
  state.timelineFocusId = ordered[index].paper.id;
  timelineSelecting = true;
  try { inspectPaper(ordered[index].paper.id); }
  finally { timelineSelecting = false; }
  const control = els.timelineView.querySelector(`[data-timeline-control="${focusControl}"]:not(:disabled)`)
    || els.timelineView.querySelector('[data-timeline-control="stage"]');
  control?.focus({preventScroll:true});
  return true;
}

function timelineScrollIndex(scrollTop, viewportHeight, count) {
  if (!count || viewportHeight <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.round(scrollTop / viewportHeight)));
}

function readTimelineScroll(stage) {
  const ordered = timelineModel?.ordered;
  if (!ordered?.length || els.timelineView.hidden) return;
  const index = timelineScrollIndex(stage.scrollTop, timelineViewportHeight || stage.clientHeight, ordered.length);
  if (index < 0) return;
  // Native momentum owns scrollTop. Work here is limited to five nearby cards
  // and the current controls; sorting and inspector rendering wait for rest.
  timelineReadingScroll = true;
  try {
    const previous = timelineModel.byId.get(state.timelineFocusId);
    state.timelineFocusId = ordered[index].paper.id;
    timelinePendingInspectorId = ordered[index].paper.id;
    if (index !== previous) syncTimelineSelection(ordered,index);
  }
  finally { timelineReadingScroll = false; }
  if (timelineScrollTimer !== null) clearTimeout(timelineScrollTimer);
  timelineScrollTimer = setTimeout(settleTimelineScroll, 140);
}

function cancelTimelineScrollWork() {
  if (timelineScrollTimer !== null) clearTimeout(timelineScrollTimer);
  if (timelineScrollFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(timelineScrollFrame);
  timelineScrollTimer = null; timelineScrollFrame = null; timelinePendingInspectorId = null;
}

function settleTimelineScroll() {
  if (timelineScrollTimer !== null) clearTimeout(timelineScrollTimer);
  timelineScrollTimer = null;
  const id = timelinePendingInspectorId;
  timelinePendingInspectorId = null;
  if (!id || els.timelineView.hidden || !timelineModel?.byId.has(id)) return;
  timelineReadingScroll = true;
  try {
    if (state.selectedId !== id) inspectPaper(id);
    renderTimelineRail(timelineModel.ordered,timelineFocusIndex(timelineModel.ordered),{reveal:true});
  } finally { timelineReadingScroll = false; }
}

function timelineWindowRange(index, count) {
  return {start:Math.max(0,index - timelineOverscan), end:Math.min(count,index + timelineOverscan + 1)};
}

function renderTimelineWindow(ordered, index, {refresh = false} = {}) {
  const surface = els.timelineView.querySelector('.timeline-virtual-space');
  if (!surface || !timelineViewportHeight) return;
  const {start,end} = timelineWindowRange(index,ordered.length);
  surface.style.height = `${ordered.length * timelineViewportHeight}px`;
  if (refresh) surface.innerHTML = '';
  const mounted = new Set();
  surface.querySelectorAll('[data-timeline-slot]').forEach(slot => {
    const position = Number(slot.dataset.timelineSlot);
    if (position < start || position >= end) {
      if (slot.contains?.(document.activeElement)) els.timelineView.querySelector('.timeline-stack')?.focus({preventScroll:true});
      slot.remove();
    }
    else {
      mounted.add(position);
      slot.style.top = `${position * timelineViewportHeight}px`;
      slot.style.height = `${timelineViewportHeight}px`;
    }
  });
  for (let position = start; position < end; position++) {
    if (!mounted.has(position)) {
      const markup = timelinePaperCard(ordered[position],position,ordered.length,ordered);
      const next = [...surface.querySelectorAll('[data-timeline-slot]')].find(slot => Number(slot.dataset.timelineSlot) > position);
      if (next) next.insertAdjacentHTML('beforebegin',markup);
      else surface.insertAdjacentHTML('beforeend',markup);
    }
  }
}

function timelineArrow(direction) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}"></path></svg>`;
}

function renderTimelineRail(ordered, index, {reveal = false} = {}) {
  const rail = els.timelineView.querySelector('.timeline-year-rail');
  if (!rail) return;
  const scrollTop = rail.scrollTop;
  const previousIndex = rail.dataset?.selectedIndex;
  const current = ordered[index];
  const expanded = state.timelineExpandedYears || (state.timelineExpandedYears = new Set());
  const signature = `${timelineModelVersion}:${[...expanded].sort().join(',')}`;
  const groups = timelineModel?.ordered === ordered ? timelineModel.groups : timelineDateGroups(ordered);
  if (timelineRailElement !== rail || timelineRailSignature !== signature) {
  rail.innerHTML = groups.map(group => {
    const open = expanded.has(group.year);
    const yearControl = `year-${group.index}`;
    const months = open ? `<div class="timeline-year-months" id="timeline-months-${group.index}">${group.months.map(month => `<div class="timeline-month-group"><button type="button" class="timeline-month-stop${current.date.year === group.year && current.date.month === month.number ? ' is-current' : ''}" data-timeline-month="${group.index}:${month.number || 0}" data-timeline-index="${month.index}" data-timeline-control="month-${month.index}">${escapeHtml(month.label)}<small>${month.papers.length}</small></button><div class="timeline-date-list">${month.papers.map(item => `<button type="button" class="timeline-date-stop${item.index === index ? ' is-current' : ''}" data-timeline-index="${item.index}" data-timeline-control="date-${item.index}" ${item.index === index ? 'aria-current="date"' : ''} title="${escapeHtml(item.paper.title || 'Untitled paper')}">${item.date.precision === 'day' ? `<span>${escapeHtml(item.date.label)}</span>` : ''}<small>${escapeHtml(item.paper.title || 'Untitled paper')}</small></button>`).join('')}</div></div>`).join('')}</div>` : `<div id="timeline-months-${group.index}" hidden></div>`;
    return `<div class="timeline-year-group"><button type="button" class="timeline-year-stop${group.year === current.date.year ? ' is-current' : ''}" data-timeline-year="${escapeHtml(group.year)}" data-timeline-control="${yearControl}" aria-expanded="${open}" aria-controls="timeline-months-${group.index}" aria-label="${escapeHtml(group.year)} · ${group.count} paper${group.count === 1 ? '' : 's'}"><span class="timeline-year-dot" aria-hidden="true"></span><strong>${escapeHtml(group.year)}</strong><span class="timeline-year-chevron" aria-hidden="true">${open ? '−' : '+'}</span><small>${group.count} paper${group.count === 1 ? '' : 's'}</small></button>${months}</div>`;
  }).join('');
  timelineRailElement = rail; timelineRailSignature = signature;
  } else if (previousIndex !== String(index)) {
    rail.querySelectorAll('.is-current').forEach(stop => { stop.classList.remove('is-current'); stop.removeAttribute('aria-current'); });
    const group = timelineModel?.yearGroups.get(current.date.year) || groups.find(item => item.year === current.date.year);
    rail.querySelector(`[data-timeline-year="${current.date.year}"]`)?.classList.add('is-current');
    rail.querySelector(`[data-timeline-month="${group.index}:${current.date.month || 0}"]`)?.classList.add('is-current');
    const dateStop = rail.querySelector(`[data-timeline-control="date-${index}"]`);
    dateStop?.classList.add('is-current'); dateStop?.setAttribute('aria-current','date');
  }
  rail.scrollTop = scrollTop;
  if (rail.dataset) rail.dataset.selectedIndex = String(index);
  if ((reveal || (!timelineReadingScroll && previousIndex !== String(index))) && rail.getBoundingClientRect) {
    const stop = rail.querySelector('.timeline-date-stop.is-current') || rail.querySelector('.timeline-year-stop.is-current');
    if (stop) {
      const bounds = rail.getBoundingClientRect(), selected = stop.getBoundingClientRect();
      if (selected.top < bounds.top + 12) rail.scrollTop += selected.top - bounds.top - 12;
      else if (selected.bottom > bounds.bottom - 12) rail.scrollTop += selected.bottom - bounds.bottom + 12;
    }
  }
}

function syncTimelineSelection(ordered, index) {
  const stage = els.timelineView.querySelector('.timeline-stack');
  const previousIndex = stage.dataset.timelineSelectedIndex;
  renderTimelineWindow(ordered,index);
  els.timelineView.querySelectorAll('.timeline-paper').forEach(card => {
    card.classList.toggle('is-selected', card.dataset.timelineId === ordered[index].paper.id);
  });
  const previous = els.timelineView.querySelector('[data-timeline-control="previous"]');
  const next = els.timelineView.querySelector('[data-timeline-control="next"]');
  previous.disabled = index === 0; previous.dataset.timelineIndex = index - 1;
  next.disabled = index === ordered.length - 1; next.dataset.timelineIndex = index + 1;
  els.timelineView.querySelector('.timeline-position strong').innerHTML = `Paper ${index + 1} <span>/ ${ordered.length}</span>`;
  renderTimelineRail(ordered,index);
  if (!timelineReadingScroll && timelineViewportHeight && (timelineSelecting || previousIndex !== String(index))) stage.scrollTop = index * timelineViewportHeight;
  stage.dataset.timelineSelectedIndex = String(index);
}

function timelineStackPreviews(ordered, index) {
  return [-2,-1,1,2].map(offset => {
    const item = ordered[index + offset];
    if (!item) return '';
    return `<button type="button" class="timeline-stack-preview ${offset < 0 ? 'is-before' : 'is-after'}${Math.abs(offset) === 2 ? ' is-distant' : ''}" data-timeline-index="${index + offset}" data-timeline-preview="${index + offset}" tabindex="-1" aria-hidden="true" title="Select ${escapeHtml(item.paper.title || 'Untitled paper')}"><span class="timeline-preview-year">${escapeHtml(item.date.year)}</span><span class="timeline-preview-title">${escapeHtml(item.paper.title || 'Untitled paper')}</span></button>`;
  }).join('');
}

function timelinePaperCard({paper,date}, index, count, ordered) {
  const citations = paperCitationCount(paper);
  const citationText = citations === null ? 'Citations not checked' : `${citations.toLocaleString()} citation${citations === 1 ? '' : 's'}`;
  const paperUrl = (typeof paperOpenUrl === 'function' ? paperOpenUrl(paper) : '') || (paper.doi ? `https://doi.org/${encodeURI(paper.doi)}` : safePaperUrl(paper.url || ''));
  const summary = String(paper.abstract || '').trim();
  return `<div class="timeline-card-slot" data-timeline-slot="${index}" style="top:${index * timelineViewportHeight}px;height:${timelineViewportHeight}px"><div class="timeline-card-pile">${timelineStackPreviews(ordered,index)}<article class="timeline-paper" data-timeline-id="${escapeHtml(paper.id)}" role="group" aria-roledescription="slide" aria-label="Paper ${index + 1} of ${count}"><div class="timeline-folder-tab">${escapeHtml(date.year)}<span>Paper ${String(index + 1).padStart(2,'0')}</span></div><div class="timeline-document-cover"><div class="timeline-cover-top"><span>${escapeHtml(date.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"></path></svg></div><button type="button" class="timeline-paper-title" data-timeline-index="${index}" data-timeline-control="details-${index}">${escapeHtml(paper.title || 'Untitled paper')}</button><p class="timeline-cover-authors">${escapeHtml(paperAuthorSummary(paper))}</p><div class="timeline-document-lines" aria-hidden="true"><span></span><span></span><span></span></div>${summary ? `<p class="timeline-abstract">${escapeHtml(summary.slice(0,220))}${summary.length > 220 ? '…' : ''}</p>` : '<p class="timeline-no-abstract">Select Details to view this paper’s metadata.</p>'}</div><footer class="timeline-paper-footer"><div class="timeline-publication"><span title="${escapeHtml(paper.journal || 'Journal not available')}">${escapeHtml(paper.journal || 'Journal not available')}</span><small>${escapeHtml(citationText)}</small></div><div class="timeline-actions"><button type="button" class="timeline-action" data-timeline-index="${index}" data-timeline-control="inspect-${index}">Details</button>${paperUrl !== '#' ? `<a class="timeline-action primary" href="${escapeHtml(paperUrl)}" target="_blank" rel="noreferrer">Open paper <span aria-hidden="true">↗</span></a>` : ''}<button type="button" class="timeline-action" data-timeline-graph="${index}" data-timeline-control="graph-${index}">View in graph</button></div></footer></article></div></div>`;
}

function renderTimeline() {
  if (!els.timelineView || els.timelineView.hidden) return;
  // inspectPaper calls back here after scrolling settles. Reuse the complete
  // model and keep both native scroll surfaces and their descendants intact.
  if ((timelineReadingScroll || timelineSelecting) && timelineModel) {
    syncTimelineSelection(timelineModel.ordered,timelineFocusIndex(timelineModel.ordered));
    return;
  }
  // A direct selection elsewhere in the library takes precedence over a
  // pending inspector update from a previous trackpad gesture.
  if (timelinePendingInspectorId !== null && state.selectedId === state.timelineFocusId && state.selectedId !== timelinePendingInspectorId) cancelTimelineScrollWork();
  const ordered = chronologicalPapers(), count = ordered.length;
  const focusControl = els.timelineView.contains(document.activeElement) ? document.activeElement.dataset.timelineControl : null;
  const index = timelineFocusIndex(ordered);
  const signature = JSON.stringify(ordered.map(({paper,date}) => [paper.id,paper.title,date,paperAuthorSummary(paper),paper.journal,paperCitationCount(paper),paper.doi,paper.url,paper.fullTextUrl,paper.landingPageUrl,paper.pdfUrl,typeof paperOpenUrl === 'function' ? paperOpenUrl(paper) : '',paper.abstract]));
  const changed = timelineRenderedSignature !== signature;
  if (changed || !timelineModel) {
    timelineModelVersion++;
    const groups = timelineDateGroups(ordered);
    timelineModel = {ordered, groups, byId:new Map(ordered.map((item,i) => [item.paper.id,i])), yearGroups:new Map(groups.map(group => [group.year,group]))};
    timelineRenderedSignature = signature;
  }
  const cached = timelineModel.ordered;
  if (count) state.timelineFocusId = cached[index].paper.id;
  const existing = els.timelineView.querySelector('.timeline-stack');
  if (count && existing) {
    timelineViewportHeight = existing.clientHeight || timelineViewportHeight;
    if (changed) renderTimelineWindow(cached,index,{refresh:true});
    const scrolling = timelinePendingInspectorId !== null;
    timelineReadingScroll = scrolling;
    try { syncTimelineSelection(cached,index); }
    finally { timelineReadingScroll = false; }
    if (focusControl) {
      const control = els.timelineView.querySelector(`[data-timeline-control="${focusControl}"]:not(:disabled)`)
        || els.timelineView.querySelector('[data-timeline-control="stage"]');
      control?.focus({preventScroll:true});
    }
    return;
  }
  cancelTimelineScrollWork();
  timelineResizeObserver?.disconnect();
  if (!count) {
    state.timelineFocusId = null;
    els.timelineView.innerHTML = `<div class="timeline-empty"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5v38M15 12h18M15 24h18M15 36h18"></path><circle cx="24" cy="12" r="4"></circle><circle cx="24" cy="24" r="4"></circle><circle cx="24" cy="36" r="4"></circle></svg><h2>Your timeline starts with a paper</h2><p>Add or import papers to explore your library by publication date.</p><button type="button" class="button primary" data-timeline-add>Add a paper</button></div>`;
    timelineRailElement = null; timelineRailSignature = '';
    return;
  }
  els.timelineView.innerHTML = `<div class="timeline-browser"><nav class="timeline-year-rail" aria-label="Publication years" tabindex="0"></nav><div class="timeline-deck"><button type="button" class="timeline-step" data-timeline-index="${index - 1}" data-timeline-control="previous" aria-label="Previous paper" title="Previous paper">${timelineArrow('up')}</button><div class="timeline-stack" role="region" aria-roledescription="carousel" aria-label="Papers in publication order" tabindex="0" data-timeline-control="stage"><div class="timeline-virtual-space"></div></div><button type="button" class="timeline-step" data-timeline-index="${index + 1}" data-timeline-control="next" aria-label="Next paper" title="Next paper">${timelineArrow('down')}</button><div class="timeline-position" role="status" aria-live="polite"><strong></strong><span>Oldest to newest</span></div></div></div>`;
  const stage = els.timelineView.querySelector('.timeline-stack');
  timelineViewportHeight = stage.clientHeight || stage.getBoundingClientRect().height;
  stage.addEventListener('scroll', () => {
    if (timelineScrollFrame !== null) return;
    timelineScrollFrame = requestAnimationFrame(() => {
      timelineScrollFrame = null;
      if (stage.isConnected && !els.timelineView.hidden) readTimelineScroll(stage);
    });
  }, {passive:true});
  stage.addEventListener('scrollend', () => {
    if (timelineScrollFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(timelineScrollFrame);
      timelineScrollFrame = null; readTimelineScroll(stage);
    }
    settleTimelineScroll();
  }, {passive:true});
  syncTimelineSelection(cached,index);
  if (typeof ResizeObserver !== 'undefined') {
    timelineResizeObserver = new ResizeObserver(() => {
      if (els.timelineView.hidden) return;
      const nextHeight = stage.clientHeight;
      if (nextHeight && nextHeight !== timelineViewportHeight) {
        // Keep the same fractional paper position during an inspector resize.
        const position = timelineViewportHeight ? stage.scrollTop / timelineViewportHeight : index;
        timelineViewportHeight = nextHeight;
        renderTimelineWindow(timelineModel.ordered,timelineFocusIndex(timelineModel.ordered));
        stage.scrollTop = position * nextHeight;
      }
    });
    timelineResizeObserver.observe(stage);
  }
  if (focusControl) els.timelineView.querySelector('[data-timeline-control="stage"]')?.focus({preventScroll:true});
}

// Delegation keeps listeners stable as neighboring cards enter and leave view.
els.timelineView?.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || !els.timelineView.contains(button)) return;
  if (button.hasAttribute('data-timeline-add')) { setRailAddOpen(true); return; }
  if (button.dataset.timelineYear) {
    const year = button.dataset.timelineYear;
    const expanded = state.timelineExpandedYears || (state.timelineExpandedYears = new Set());
    if (expanded.has(year)) expanded.delete(year); else expanded.add(year);
    const group = timelineModel?.yearGroups.get(year);
    if (group) selectTimelineIndex(group.index,button.dataset.timelineControl);
  } else if (button.dataset.timelineGraph !== undefined) {
    const paper = timelineModel?.ordered[Number(button.dataset.timelineGraph)]?.paper;
    if (!paper) return;
    setTimelineVisible(false); inspectPaper(paper.id); state.centerId = paper.id; state.mode = 'network';
    highlightRail('network'); render();
  } else if (button.dataset.timelineIndex !== undefined) {
    selectTimelineIndex(Number(button.dataset.timelineIndex),button.dataset.timelineControl);
  }
});

els.timelineView?.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const ordered = timelineModel?.ordered || chronologicalPapers();
  if (!ordered.length) return;
  const current = timelineFocusIndex(ordered);
  const index = {ArrowUp:current - 1, ArrowDown:current + 1, Home:0, End:ordered.length - 1}[event.key];
  if (index === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault(); selectTimelineIndex(index);
});
