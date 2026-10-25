/* Trends: select topics, browse their papers, and open maps or charts when needed. */
function renderTrendsSelection() {
  if (!trendsVisible()) return;
  els.trendsView.querySelectorAll('[data-trends-paper]').forEach(card => {
    const selected = card.dataset.trendsPaper === String(state.selectedId);
    card.classList.toggle('is-selected', selected);
    const title = card.querySelector('.trends-paper-title');
    if (selected) title?.setAttribute('aria-current', 'true'); else title?.removeAttribute('aria-current');
  });
  if (typeof TrendsMap === 'undefined' || !TrendsMap.scene.data) return;
  TrendsMap.scene.data.selectedPaper = state.selectedId;
  // Reopening Trends without a fresh render still restarts the map's animation.
  TrendsMap.wake();
}

function trendsLegendMarkup() {
  const item = (status, label) => `<span><i class="trends-group-dot is-${status}"></i>${label}</span>`;
  return `<div class="trends-legend" aria-hidden="true">${item('rising', 'Rising')}${item('falling', 'Falling')}${item('unclear', 'No clear change')}${item('new', 'New')}<span>Inner orbits are newer papers; the dashed orbit is undated</span></div>`;
}

function renderTrends({ refresh = true } = {}) {
  if (!trendsVisible()) return;
  const root = els.trendsView;
  // Native disclosure changes precede their queued toggle event. Read them
  // before background updates rebuild the page, so a just-closed section stays closed.
  const visuals = root.querySelector('[data-trends-visuals]');
  const keywords = root.querySelector('[data-trends-keywords]');
  if (visuals) {
    trendsUi.visualsOpen = visuals.open;
    if (!visuals.open && trendsUi.playing) { trendsStopPlay(); trendsUi.period = ''; }
  }
  if (keywords) trendsUi.conceptsOpen = keywords.open;
  const active = root.contains(document.activeElement) ? document.activeElement.dataset.trendsControl : '';
  const scrollTop = root.scrollTop;
  const chartScrollLeft = root.querySelector('.trends-chart')?.scrollLeft || 0;
  if (refresh || !trendsUi.model) trendsUi.model = cachedTrendsModel(state.papers);
  const model = trendsUi.model;
  const data = model.total ? trendsGroupData(model) : null;
  if (trendsUi.topic && !model.topicMap.has(trendsUi.topic)) trendsUi.topic = '';
  if (trendsUi.period && !model.bins.some(bin => bin.key === trendsUi.period)) trendsUi.period = '';
  if (trendsUi.group && trendsUi.group !== '*' && !data?.members.has(trendsUi.group)) trendsUi.group = '';
  // Without a selected topic, show all saved papers immediately.
  const open = trendsUi.group || '*';
  const renderKey = JSON.stringify([model.cacheRevision, data ? trendsGroupCache.key : '', open, trendsUi.topic, trendsUi.period,
    trendsUi.sort, trendsUi.topicLimit, trendsUi.paperLimit, trendsUi.playing, trendsUi.visualsOpen, trendsUi.conceptsOpen]);
  if (trendsCache.root === root && trendsCache.renderedKey === renderKey) {
    renderTrendsSelection();
    return;
  }
  trendsCache.root = root;
  trendsCache.renderedKey = renderKey;
  if (!model.total) {
    trendsUi.topic = ''; trendsUi.period = '';
    root.innerHTML = '<div class="trends-empty"><span class="trends-empty-symbol" aria-hidden="true">↗</span><span class="trends-eyebrow">SAVED LIBRARY</span><h2>Your trends start with a paper</h2><p>Add or import papers to explore publication activity and the concepts represented in your library.</p><button type="button" class="button primary" data-trends-add data-trends-control="add">Add a paper</button></div>';
    root.querySelector('[data-trends-add]')?.addEventListener('click', () => { if (typeof setRailAddOpen === 'function') setRailAddOpen(true); });
    return;
  }
  const period = model.bins.find(bin => bin.key === trendsUi.period), topic = model.topicMap.get(trendsUi.topic);
  const group = data?.groups.find(item => item.id === trendsUi.group), members = data?.members.get(trendsUi.group);
  const asOf = trendsUi.playing && period?.end ? period.end : null;
  const summary = trendsGroupStats(model, data, asOf);
  const matches = trendsFilterPapers(model, { members, topic: trendsUi.topic, period: trendsUi.period }).length;
  const hasFilters = Boolean(group || topic || period);
  const sortRows = { count: (a, b) => b[1].count - a[1].count, recent: (a, b) => b[1].recent - a[1].recent || b[1].count - a[1].count,
    change: (a, b) => (b[1].momentum.change ?? -Infinity) - (a[1].momentum.change ?? -Infinity) || b[1].count - a[1].count }[trendsUi.sort];
  const rows = (data?.groups || []).map(item => [item, summary.stats.get(item.id)]).sort((a, b) => sortRows(a, b) || a[0].label.localeCompare(b[0].label));
  const partial = model.latestYear === model.currentYear ? 'The current publication year is incomplete. ' : '';
  const chartTitle = model.bins.some(bin => bin.start !== bin.end) ? 'Publication activity by period' : 'Publication activity by year';
  const exclusions = [model.undated ? `${trendsPlural(model.undated)} without a year` : '', model.upcoming ? `${trendsPlural(model.upcoming)} with future years` : ''].filter(Boolean).join(' and ');
  const groupCount = data ? data.groups.length : model.groups.length;
  const option = value => `<option value="${value}"${trendsUi.groupTarget === value ? ' selected' : ''}>${value} groups</option>`;
  const firstYear=model.yearCounts.size?Math.min(...model.yearCounts.keys()):null;
  const yearRange=firstYear===null?'Years not available':firstYear===model.latestYear?String(firstYear):`${firstYear}–${model.latestYear}`;
  const filters=`${group?`<button type="button" data-trends-clear-group data-trends-control="clear-group" aria-label="Remove topic filter ${trendsEscape(group.label)}">${trendsEscape(group.label)} <span aria-hidden="true">×</span></button>`:''}${topic?`<button type="button" data-trends-clear-topic data-trends-control="clear-topic" aria-label="Remove keyword filter ${trendsEscape(topic.label)}">${trendsEscape(topic.label)} <span aria-hidden="true">×</span></button>`:''}`;
  root.innerHTML = `<div class="trends-dashboard"><header class="trends-header"><div><h2>Library trends</h2><p>Choose a topic to explore its papers. Narrow by year when you need to.</p></div><span class="trends-scope">All saved papers</span></header>`
    + `<div class="trends-summary" aria-label="Saved library summary"><span><strong>${model.total.toLocaleString()}</strong> papers</span><span><strong>${groupCount.toLocaleString()}</strong> topic groups</span><span><strong>${yearRange}</strong> publication years</span></div>`
    + `<div class="trends-toolbar"><label class="trends-period-label">Published<select data-trends-period-select data-trends-control="publication-period" aria-label="Publication period"><option value="">All years</option>${model.bins.map(bin=>`<option value="${bin.key}"${trendsUi.period===bin.key?' selected':''}>${trendsEscape(bin.label)} (${bin.count.toLocaleString()})</option>`).join('')}</select></label><div class="trends-filter-chips" aria-label="Active trends filters">${filters}</div>${hasFilters?'<button type="button" class="trends-reset" data-trends-reset data-trends-control="reset">Clear filters</button>':''}</div>`
    + `<details class="trends-visuals" data-trends-visuals${trendsUi.visualsOpen?' open':''}><summary><span>Map &amp; timeline</span><small>Explore topics visually or compare publication years</small></summary><div class="trends-visual-grid"><section class="trends-map-panel" aria-labelledby="trendsMapTitle"><div class="trends-panel-heading"><div><h3 id="trendsMapTitle">Topic map</h3><p>Choose a bubble to see its papers.</p></div>${data?`<label class="trends-sort-label"><span class="sr-only">Number of topic groups</span><select data-trends-target data-trends-control="target" aria-label="Number of topic groups">${[6,10,15,20].map(option).join('')}</select></label>`:''}</div>`
    + (data?`<div class="trends-map-slot" data-trends-map></div>${trendsLegendMarkup()}`:'<p class="trends-map-waiting">Topic groups appear once Pulse has compared the concepts in your papers on the map.</p>')
    + `</section><section class="trends-timeline" aria-labelledby="trendsActivityTitle"><div class="trends-panel-heading"><div><h3 id="trendsActivityTitle">${chartTitle}</h3><p>${trendsUi.playing&&period?`Showing the library up to ${period.end}`:'Choose a bar to filter papers by publication date.'}</p></div>${model.bins.some(bin=>bin.start)?`<button type="button" class="trends-play" data-trends-play data-trends-control="play" aria-pressed="${trendsUi.playing}">${trendsUi.playing?'Stop':'Play'}</button>`:''}</div>${trendsChartMarkup(model)}<p class="trends-method-note">Counts describe your saved library. Periods with no saved papers are omitted; undated and future-year records stay visible separately.</p></section></div></details>`
    + `<div class="trends-merged"><section class="trends-panel trends-topics-panel" aria-labelledby="trendsTopicsTitle"><div class="trends-panel-heading"><div><h3 id="trendsTopicsTitle">Topics</h3><p>Select one to see its papers.</p></div><label class="trends-sort-label"><span class="sr-only">Sort topics</span><select data-trends-sort data-trends-control="sort" aria-label="Sort topics"><option value="count"${trendsUi.sort==='count'?' selected':''}>Most papers</option><option value="recent"${trendsUi.sort==='recent'?' selected':''}>Most recent</option><option value="change"${trendsUi.sort==='change'?' selected':''}>Growing share</option></select></label></div><div class="trends-tree">${trendsRowMarkup(model,'*','All papers',summary.stats.get('*'),null,open)}${rows.map(([item,row])=>trendsRowMarkup(model,item.id,item.label,row,data.members.get(item.id),open)).join('')}</div>${!data?'<p class="trends-method-note">Topic groups appear once concept analysis is ready. You can explore all papers and keywords now.</p>':''}</section>`
    + `<section id="trendsPapers" class="trends-panel trends-list-panel" aria-labelledby="trendsListTitle"><div class="trends-panel-heading"><div><h3 id="trendsListTitle">${group?trendsEscape(group.label):'All papers'}</h3><p role="status" aria-live="polite">${trendsPlural(matches)}${hasFilters?' match your filters':''} · newest first</p></div></div>${trendsGroupBody(model,members)}</section></div>`
    + `<details class="trends-about"><summary>About these numbers</summary><div><p>${model.dated.toLocaleString()} of ${model.total.toLocaleString()} papers have publication years. ${model.topics.length.toLocaleString()} concepts are represented across ${trendsPlural(model.withTopics)}.</p><p>${summary.recent?`Topic changes compare ${trendsWindowLabel(summary.recent)} with ${trendsWindowLabel(summary.prior)}. `:'Add publication years to compare concept activity over time. '}${partial}${summary.recent?`Share = papers in a group or concept ÷ all papers in the same ${model.windowSize}-year window. “pp” means percentage points. A “?” marks a change that could be chance; only changes clear at 95% are coloured. ${exclusions?`${trendsEscape(exclusions)} are excluded from the comparison. `:''}`:''}Concepts can overlap; each paper counts once per concept.</p></div></details><p class="trends-footer-note">Based on your saved papers, not the wider research literature.</p></div>`;
  bindTrendsControls(root,model,data,summary,asOf);
  if(data&&trendsUi.visualsOpen&&typeof TrendsMap!=='undefined')TrendsMap.mount(root.querySelector('[data-trends-map]'),trendsMapData(model,data,summary,asOf));
  root.scrollTop = scrollTop;
  const chart = root.querySelector('.trends-chart');
  if (chart) chart.scrollLeft = chartScrollLeft;
  if (active) [...root.querySelectorAll('[data-trends-control]')].find(control => control.dataset.trendsControl === active)?.focus({ preventScroll: true });
}

function bindTrendsControls(root, model, data, summary, asOf) {
  const on = (selector, handler, type = 'click') => root.querySelectorAll(selector).forEach(element => element.addEventListener(type, event => handler(element, event)));
  on('[data-trends-group]', button => {
    trendsSelect({group:button.dataset.trendsGroup==='*'||trendsUi.group===button.dataset.trendsGroup?'':button.dataset.trendsGroup});
    if(root.clientWidth<700)root.querySelector('#trendsListTitle')?.scrollIntoView({block:'nearest'});
  });
  on('[data-trends-period-select]', select=>trendsSelect({period:select.value,paperLimit:10}),'change');
  on('[data-trends-visuals]', details=>{
    if(!root.contains(details))return;
    trendsUi.visualsOpen=details.open;
    if(details.open&&data&&typeof TrendsMap!=='undefined')TrendsMap.mount(root.querySelector('[data-trends-map]'),trendsMapData(model,data,summary,asOf));
    if(!details.open&&trendsUi.playing){trendsStopPlay();trendsSelect({period:''});}
  },'toggle');
  on('[data-trends-keywords]', details=>{if(root.contains(details))trendsUi.conceptsOpen=details.open;},'toggle');
  on('[data-trends-topic]', button => trendsSelect({ topic: trendsUi.topic === button.dataset.trendsTopic ? '' : button.dataset.trendsTopic, paperLimit: 10 }));
  on('[data-trends-period]', button => trendsSelect({ period: trendsUi.period === button.dataset.trendsPeriod ? '' : button.dataset.trendsPeriod, paperLimit: 10 }));
  on('[data-trends-sort]', select => trendsSelect({ sort: select.value }), 'change');
  on('[data-trends-target]', select => trendsSelect({ groupTarget: Number(select.value), group: '' }), 'change');
  on('[data-trends-play]', () => trendsTogglePlay(model));
  on('[data-trends-reset]', () => trendsSelect({ group: '', topic: '', period: '', paperLimit: 10 }));
  on('[data-trends-clear-group]', () => trendsSelect({ group: '' }));
  on('[data-trends-clear-topic]', () => trendsSelect({ topic: '', paperLimit: 10 }));
  on('[data-trends-clear-period]', () => trendsSelect({ period: '', paperLimit: 10 }));
  on('[data-trends-more-topics]', () => trendsSelect({ topicLimit: trendsUi.topicLimit + 10 }));
  on('[data-trends-more-papers]', () => trendsSelect({ paperLimit: trendsUi.paperLimit + 20 }));
  on('[data-trends-discover]', () => startTrendsTopicSearch(model.topicMap.get(trendsUi.topic)?.label || ''));
  on('[data-trends-inspect]', button => { inspectPaper(button.dataset.trendsInspect); renderTrendsSelection(); });
  on('[data-trends-network]', button => { if (typeof window.openTrendsPaperInGraph === 'function') window.openTrendsPaperInGraph(button.dataset.trendsNetwork); });
  // A paper under the pointer in the list lights up on the map.
  if (typeof TrendsMap === 'undefined') return;
  on('[data-trends-paper]', card => TrendsMap.highlight(card.dataset.trendsPaper), 'pointerenter');
  on('[data-trends-paper]', () => TrendsMap.highlight(null), 'pointerleave');
}
