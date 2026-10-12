// A native, scrollable paper deck using real publication metadata.
const timelineMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let timelineRenderedSignature = '';
let timelineReadingScroll = false;
let timelineResizeObserver = null;

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
  const groups = [];
  ordered.forEach(({paper,date}, index) => {
    let group = groups.find(group => group.year === date.year);
    if (!group) { group = {year:date.year, index, count:0, months:[]}; groups.push(group); }
    group.count++;
    let month = group.months.find(month => month.number === date.month);
    if (!month) { month = {number:date.month, label:date.month ? timelineMonthNames[date.month - 1] : 'Month unknown', index, papers:[]}; group.months.push(month); }
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
}

function selectTimelineIndex(index, focusControl = 'stage') {
  const ordered = chronologicalPapers();
  if (!Number.isInteger(index) || index < 0 || index >= ordered.length) return false;
  state.timelineFocusId = ordered[index].paper.id;
  inspectPaper(ordered[index].paper.id);
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
  const ordered = chronologicalPapers();
  const index = timelineScrollIndex(stage.scrollTop, stage.getBoundingClientRect?.().height || stage.clientHeight, ordered.length);
  if (index < 0 || index === timelineFocusIndex(ordered)) return;
  // Keep the native scrolling surface intact while updating the inspector and rail.
  timelineReadingScroll = true;
  try { state.timelineFocusId = ordered[index].paper.id; inspectPaper(ordered[index].paper.id); }
  finally { timelineReadingScroll = false; }
}

function timelineArrow(direction) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}"></path></svg>`;
}

function renderTimelineRail(ordered, index) {
  const rail = els.timelineView.querySelector('.timeline-year-rail');
  if (!rail) return;
  const scrollTop = rail.scrollTop;
  const previousIndex = rail.dataset?.selectedIndex;
  const current = ordered[index];
  const expanded = state.timelineExpandedYears || (state.timelineExpandedYears = new Set());
  rail.innerHTML = timelineDateGroups(ordered).map(group => {
    const open = expanded.has(group.year);
    const yearControl = `year-${group.index}`;
    const months = open ? `<div class="timeline-year-months" id="timeline-months-${group.index}">${group.months.map(month => `<div class="timeline-month-group"><button type="button" class="timeline-month-stop${current.date.year === group.year && current.date.month === month.number ? ' is-current' : ''}" data-timeline-index="${month.index}" data-timeline-control="month-${month.index}">${escapeHtml(month.label)}<small>${month.papers.length}</small></button><div class="timeline-date-list">${month.papers.map(item => `<button type="button" class="timeline-date-stop${item.index === index ? ' is-current' : ''}" data-timeline-index="${item.index}" data-timeline-control="date-${item.index}" ${item.index === index ? 'aria-current="date"' : ''} title="${escapeHtml(item.paper.title || 'Untitled paper')}">${item.date.precision === 'day' ? `<span>${escapeHtml(item.date.label)}</span>` : ''}<small>${escapeHtml(item.paper.title || 'Untitled paper')}</small></button>`).join('')}</div></div>`).join('')}</div>` : `<div id="timeline-months-${group.index}" hidden></div>`;
    return `<div class="timeline-year-group"><button type="button" class="timeline-year-stop${group.year === current.date.year ? ' is-current' : ''}" data-timeline-year="${escapeHtml(group.year)}" data-timeline-control="${yearControl}" aria-expanded="${open}" aria-controls="timeline-months-${group.index}" aria-label="${escapeHtml(group.year)} · ${group.count} paper${group.count === 1 ? '' : 's'}"><span class="timeline-year-dot" aria-hidden="true"></span><strong>${escapeHtml(group.year)}</strong><span class="timeline-year-chevron" aria-hidden="true">${open ? '−' : '+'}</span><small>${group.count} paper${group.count === 1 ? '' : 's'}</small></button>${months}</div>`;
  }).join('');
  rail.scrollTop = scrollTop;
  if (rail.dataset) rail.dataset.selectedIndex = String(index);
  if (previousIndex !== String(index) && rail.getBoundingClientRect) {
    const stop = rail.querySelector('.timeline-date-stop.is-current') || rail.querySelector('.timeline-year-stop.is-current');
    if (stop) {
      const bounds = rail.getBoundingClientRect(), selected = stop.getBoundingClientRect();
      if (selected.top < bounds.top + 12) rail.scrollTop += selected.top - bounds.top - 12;
      else if (selected.bottom > bounds.bottom - 12) rail.scrollTop += selected.bottom - bounds.bottom + 12;
    }
  }
  rail.querySelectorAll('[data-timeline-year]').forEach(button => {
    button.addEventListener('click', () => {
      const year = button.dataset.timelineYear;
      if (expanded.has(year)) expanded.delete(year); else expanded.add(year);
      const group = timelineDateGroups(chronologicalPapers()).find(group => group.year === year);
      selectTimelineIndex(group.index, button.dataset.timelineControl);
    });
  });
  rail.querySelectorAll('[data-timeline-index]').forEach(button => {
    button.addEventListener('click', () => selectTimelineIndex(Number(button.dataset.timelineIndex), button.dataset.timelineControl));
  });
}

function syncTimelineSelection(ordered, index) {
  const stage = els.timelineView.querySelector('.timeline-stack');
  els.timelineView.querySelectorAll('.timeline-paper').forEach(card => {
    card.classList.toggle('is-selected', card.dataset.timelineId === ordered[index].paper.id);
  });
  const previous = els.timelineView.querySelector('[data-timeline-control="previous"]');
  const next = els.timelineView.querySelector('[data-timeline-control="next"]');
  previous.disabled = index === 0; previous.dataset.timelineIndex = index - 1;
  next.disabled = index === ordered.length - 1; next.dataset.timelineIndex = index + 1;
  els.timelineView.querySelector('.timeline-position strong').innerHTML = `Paper ${index + 1} <span>/ ${ordered.length}</span>`;
  renderTimelineRail(ordered,index);
  const height = stage.getBoundingClientRect?.().height || stage.clientHeight;
  if (!timelineReadingScroll && height) stage.scrollTop = index * height;
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
  return `<div class="timeline-card-slot"><div class="timeline-card-pile">${timelineStackPreviews(ordered,index)}<article class="timeline-paper" data-timeline-id="${escapeHtml(paper.id)}" role="group" aria-roledescription="slide" aria-label="Paper ${index + 1} of ${count}"><div class="timeline-folder-tab">${escapeHtml(date.year)}<span>Paper ${String(index + 1).padStart(2,'0')}</span></div><div class="timeline-document-cover"><div class="timeline-cover-top"><span>${escapeHtml(date.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"></path></svg></div><button type="button" class="timeline-paper-title" data-timeline-index="${index}" data-timeline-control="details-${index}">${escapeHtml(paper.title || 'Untitled paper')}</button><p class="timeline-cover-authors">${escapeHtml(paperAuthorSummary(paper))}</p><div class="timeline-document-lines" aria-hidden="true"><span></span><span></span><span></span></div>${summary ? `<p class="timeline-abstract">${escapeHtml(summary.slice(0,220))}${summary.length > 220 ? '…' : ''}</p>` : '<p class="timeline-no-abstract">Select Details to view this paper’s metadata.</p>'}</div><footer class="timeline-paper-footer"><div class="timeline-publication"><span title="${escapeHtml(paper.journal || 'Journal not available')}">${escapeHtml(paper.journal || 'Journal not available')}</span><small>${escapeHtml(citationText)}</small></div><div class="timeline-actions"><button type="button" class="timeline-action" data-timeline-index="${index}" data-timeline-control="inspect-${index}">Details</button>${paperUrl !== '#' ? `<a class="timeline-action primary" href="${escapeHtml(paperUrl)}" target="_blank" rel="noreferrer">Open paper <span aria-hidden="true">↗</span></a>` : ''}<button type="button" class="timeline-action" data-timeline-graph="${index}" data-timeline-control="graph-${index}">View in graph</button></div></footer></article></div></div>`;
}

function renderTimeline() {
  if (!els.timelineView || els.timelineView.hidden) return;
  const ordered = chronologicalPapers(), count = ordered.length;
  const focusControl = els.timelineView.contains(document.activeElement) ? document.activeElement.dataset.timelineControl : null;
  const index = timelineFocusIndex(ordered);
  const signature = JSON.stringify(ordered.map(({paper,date}) => [paper.id,paper.title,date,paperAuthorSummary(paper),paper.journal,paperCitationCount(paper),paper.doi,paper.url,paper.abstract]));
  if (count) state.timelineFocusId = ordered[index].paper.id;
  if (count && timelineRenderedSignature === signature && els.timelineView.querySelector('.timeline-stack')) {
    syncTimelineSelection(ordered,index);
    if (focusControl && !timelineReadingScroll) els.timelineView.querySelector(`[data-timeline-control="${focusControl}"]:not(:disabled)`)?.focus({preventScroll:true});
    return;
  }
  timelineRenderedSignature = signature;
  timelineResizeObserver?.disconnect();
  if (!count) {
    state.timelineFocusId = null;
    els.timelineView.innerHTML = `<div class="timeline-empty"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5v38M15 12h18M15 24h18M15 36h18"></path><circle cx="24" cy="12" r="4"></circle><circle cx="24" cy="24" r="4"></circle><circle cx="24" cy="36" r="4"></circle></svg><h2>Your timeline starts with a paper</h2><p>Add or import papers to explore your library by publication date.</p><button type="button" class="button primary" data-timeline-add>Add a paper</button></div>`;
    els.timelineView.querySelector('[data-timeline-add]').addEventListener('click', () => setRailAddOpen(true));
    return;
  }
  state.timelineFocusId = ordered[index].paper.id;
  els.timelineView.innerHTML = `<div class="timeline-browser"><nav class="timeline-year-rail" aria-label="Publication years" tabindex="0"></nav><div class="timeline-deck"><button type="button" class="timeline-step" data-timeline-index="${index - 1}" data-timeline-control="previous" aria-label="Previous paper" title="Previous paper">${timelineArrow('up')}</button><div class="timeline-stack" role="region" aria-roledescription="carousel" aria-label="Papers in publication order" tabindex="0" data-timeline-control="stage">${ordered.map((item,i) => timelinePaperCard(item,i,count,ordered)).join('')}</div><button type="button" class="timeline-step" data-timeline-index="${index + 1}" data-timeline-control="next" aria-label="Next paper" title="Next paper">${timelineArrow('down')}</button><div class="timeline-position" role="status" aria-live="polite"><strong></strong><span>Oldest to newest</span></div></div></div>`;
  els.timelineView.querySelectorAll('[data-timeline-index]').forEach(button => {
    button.addEventListener('click', () => selectTimelineIndex(Number(button.dataset.timelineIndex), button.dataset.timelineControl));
  });
  els.timelineView.querySelectorAll('[data-timeline-graph]').forEach(button => {
    button.addEventListener('click', () => {
      const paper = chronologicalPapers()[Number(button.dataset.timelineGraph)]?.paper;
      if (!paper) return;
      setTimelineVisible(false); inspectPaper(paper.id); state.centerId = paper.id; state.mode = 'network';
      highlightRail('network'); render();
    });
  });
  const stage = els.timelineView.querySelector('.timeline-stack');
  let frame = null;
  stage.addEventListener('scroll', () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; if (stage.isConnected) readTimelineScroll(stage); });
  }, {passive:true});
  syncTimelineSelection(ordered,index);
  if (typeof ResizeObserver !== 'undefined') {
    let height = stage.getBoundingClientRect().height;
    timelineResizeObserver = new ResizeObserver(() => {
      const nextHeight = stage.getBoundingClientRect().height;
      if (nextHeight && nextHeight !== height) {
        height = nextHeight;
        stage.scrollTop = timelineFocusIndex(chronologicalPapers()) * height;
      }
    });
    timelineResizeObserver.observe(stage);
  }
  if (focusControl) {
    const control = els.timelineView.querySelector(`[data-timeline-control="${focusControl}"]:not(:disabled)`)
      || els.timelineView.querySelector('[data-timeline-control="stage"]');
    control?.focus({preventScroll:true});
  }
}

els.timelineView?.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const ordered = chronologicalPapers();
  if (!ordered.length) return;
  const current = timelineFocusIndex(ordered);
  const index = {ArrowUp:current - 1, ArrowDown:current + 1, Home:0, End:ordered.length - 1}[event.key];
  if (index === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault(); selectTimelineIndex(index);
});
