// Chronological view replaces Collections while using the same papers and inspector.
let timelineDirection = 'asc';
function timelineYear(paper) {
  const value = String(paper.year || paper.date || '');
  const match = value.match(/(?:^|\D)((?:18|19|20|21)\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}
function renderTimelineView() {
  const container = els.timelineView;
  const papers = state.papers.filter(paper => !state.filterTags.length || paperMatchesFilters(paper));
  const ordered = papers.slice().sort((a,b) => {
    const ya=timelineYear(a), yb=timelineYear(b);
    if (ya===null && yb!==null) return 1;
    if (yb===null && ya!==null) return -1;
    return ((ya || 0)-(yb || 0))*(timelineDirection==='asc'?1:-1) || String(a.title).localeCompare(String(b.title));
  });
  let previous = '';
  container.innerHTML = `<div class="timeline-heading"><div><h2>Timeline</h2><p>${ordered.length} papers arranged by publication year</p></div><label>Order <select id="timelineOrder"><option value="asc" ${timelineDirection==='asc'?'selected':''}>Oldest first</option><option value="desc" ${timelineDirection==='desc'?'selected':''}>Newest first</option></select></label></div>` +
    (ordered.length ? ordered.map(paper => {
      const year=timelineYear(paper), label=year===null?'Year unknown':String(year);
      const group=label!==previous?`<h3 class="timeline-year">${label}</h3>`:'';previous=label;
      const authors=Array.isArray(paper.authors)?paper.authors.join(', '):String(paper.authors || '');
      return `${group}<article class="timeline-paper ${state.selectedId===paper.id?'is-selected':''}" data-year="${year===null?'unknown':year}"><button class="timeline-title" data-timeline-paper="${escapeHtml(paper.id)}">${escapeHtml(paper.title || 'Untitled paper')}</button><p>${escapeHtml([authors,paper.journal || paper.venue].filter(Boolean).join(' · '))}</p><div class="timeline-paper-footer"><span>${Number(paper.citedByCount || 0)} citations</span><button class="pill-btn-sm" data-timeline-graph="${escapeHtml(paper.id)}">View in network</button></div></article>`;
    }).join(''):'<div class="timeline-empty">Add or import papers to see their publication history.</div>');
  container.querySelector('#timelineOrder').addEventListener('change', event => {timelineDirection=event.target.value;renderTimelineView();});
  container.querySelectorAll('[data-timeline-paper]').forEach(button => button.addEventListener('click', () => {state.selectedId=button.dataset.timelinePaper;render();}));
  container.querySelectorAll('[data-timeline-graph]').forEach(button => button.addEventListener('click', () => {
    state.selectedId=button.dataset.timelineGraph;state.mode='network';
    document.querySelectorAll('.rail-item').forEach(item => item.classList.toggle('active',item.dataset.rail==='network'));
    render();
  }));
}
