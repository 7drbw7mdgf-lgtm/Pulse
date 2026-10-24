/* Renders the Trends page: library totals, the topic map with its year chart, and one list of groups, concepts and papers. */
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
  const active = root.contains(document.activeElement) ? document.activeElement.dataset.trendsControl : '';
  const scrollTop = root.scrollTop;
  const chartScrollLeft = root.querySelector('.trends-chart')?.scrollLeft || 0;
  if (refresh || !trendsUi.model) trendsUi.model = cachedTrendsModel(state.papers);
  const model = trendsUi.model;
  const data = model.total ? trendsGroupData(model) : null;
  if (trendsUi.topic && !model.topicMap.has(trendsUi.topic)) trendsUi.topic = '';
  if (trendsUi.period && !model.bins.some(bin => bin.key === trendsUi.period)) trendsUi.period = '';
  if (trendsUi.group && trendsUi.group !== '*' && !data?.members.has(trendsUi.group)) trendsUi.group = '';
  // Before the map has grouped the library, the list is the whole library, always open.
  const open = data ? trendsUi.group : '*';
  const renderKey = JSON.stringify([model.cacheRevision, data ? trendsGroupCache.key : '', open, trendsUi.topic, trendsUi.period,
    trendsUi.sort, trendsUi.topicLimit, trendsUi.paperLimit, trendsUi.playing]);
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
  root.innerHTML = `<div class="trends-dashboard"><header class="trends-header"><div><span class="trends-eyebrow">SAVED LIBRARY</span><h2>Library trends</h2><p>Explore how your saved papers group by topic and how each group grew over time.</p></div><span class="trends-scope">Whole library</span></header>`
    + `<div class="trends-stats" aria-label="Saved library coverage"><div class="trends-stat"><span>Saved papers</span><strong>${model.total.toLocaleString()}</strong><small>Your whole Pulse library</small></div><div class="trends-stat"><span>With publication years</span><strong>${model.dated.toLocaleString()}<small> / ${model.total.toLocaleString()}</small></strong><small>${model.undated ? `${trendsPlural(model.undated)} undated` : 'All papers have a year'}</small></div><div class="trends-stat"><span>Concepts represented</span><strong>${model.topics.length.toLocaleString()}</strong><small>Across ${trendsPlural(model.withTopics)}</small></div><div class="trends-stat"><span>Topic groups</span><strong>${groupCount.toLocaleString()}</strong><small>Groups of related papers</small></div></div>`
    + `<div class="trends-merged"><section class="trends-panel trends-map-panel" aria-labelledby="trendsMapTitle"><div class="trends-panel-heading"><div><h3 id="trendsMapTitle">Topic map</h3><p>Bubbles are groups of related papers and dots are papers. Click a bubble, dot or bar to filter the list.</p></div>${data ? `<label class="trends-sort-label"><span class="sr-only">Number of topic groups</span><select data-trends-target data-trends-control="target" aria-label="Number of topic groups">${[6, 10, 15, 20].map(option).join('')}</select></label>` : ''}</div>`
    + (data ? `<div class="trends-map-slot" data-trends-map></div><p class="sr-only">The map shows ${trendsPlural(data.groups.length, 'topic group')}; the list beside it has the same groups with their numbers.</p>${trendsLegendMarkup()}` : '<p class="trends-map-waiting">Topic groups appear once Pulse has compared the concepts in your papers on the map.</p>')
    + `<div class="trends-timeline"><div class="trends-panel-heading"><div><h3 id="trendsActivityTitle">${chartTitle}</h3><p>${trendsUi.playing && period ? `Showing the library up to ${period.end}` : 'Click a bar to filter, or play to watch the library grow.'}</p></div>${model.bins.some(bin => bin.start) ? `<button type="button" class="trends-play" data-trends-play data-trends-control="play" aria-pressed="${trendsUi.playing}">${trendsUi.playing ? 'Stop' : 'Play'}</button>` : ''}</div>${trendsChartMarkup(model)}</div><p class="trends-method-note">Counts describe your saved library. Periods with no saved papers are omitted; undated and future-year records stay visible separately.</p></section>`
    + `<section class="trends-panel trends-list-panel" aria-labelledby="trendsListTitle"><div class="trends-panel-heading"><div><h3 id="trendsListTitle">Groups, concepts and papers</h3><p role="status" aria-live="polite">${trendsPlural(matches)}${hasFilters ? ' match your filters' : ' in your library'}</p></div><label class="trends-sort-label"><span class="sr-only">Sort</span><select data-trends-sort data-trends-control="sort" aria-label="Sort groups and concepts"><option value="count"${trendsUi.sort === 'count' ? ' selected' : ''}>Most papers</option><option value="recent"${trendsUi.sort === 'recent' ? ' selected' : ''}>Most recent papers</option><option value="change"${trendsUi.sort === 'change' ? ' selected' : ''}>Share increase</option></select></label></div>`
    + (hasFilters ? `<div class="trends-filter-chips" aria-label="Active trends filters">${group ? `<button type="button" data-trends-clear-group data-trends-control="clear-group" aria-label="Remove group filter ${trendsEscape(group.label)}">${trendsEscape(group.label)} <span aria-hidden="true">×</span></button>` : ''}${topic ? `<button type="button" data-trends-clear-topic data-trends-control="clear-topic" aria-label="Remove concept filter ${trendsEscape(topic.label)}">${trendsEscape(topic.label)} <span aria-hidden="true">×</span></button>` : ''}${period ? `<button type="button" data-trends-clear-period data-trends-control="clear-period" aria-label="Remove publication filter ${trendsEscape(period.label)}">${trendsEscape(period.label)} <span aria-hidden="true">×</span></button>` : ''}<button type="button" class="trends-reset" data-trends-reset data-trends-control="reset">Reset filters</button></div>` : '')
    + (summary.recent ? `<div class="trends-window-note"><strong>Recent ${trendsWindowLabel(summary.recent)}</strong><span>compared with ${trendsWindowLabel(summary.prior)}. A “?” marks a change that could be chance.</span></div>` : '<p class="trends-window-note">Add publication years to compare concept activity over time.</p>')
    + `<div class="trends-tree">${trendsRowMarkup(model, '*', 'All papers', summary.stats.get('*'), null, open)}${rows.map(([item, row]) => trendsRowMarkup(model, item.id, item.label, row, data.members.get(item.id), open)).join('')}</div>`
    + `<p class="trends-method-note">${partial}${summary.recent ? `Share = papers in a group or concept ÷ all papers in the same ${model.windowSize}-year window. “pp” means percentage points, and only changes clear at 95% are coloured. Counts follow the selected period. ${exclusions ? `${trendsEscape(exclusions)} are excluded from the comparison. ` : ''}` : ''}Concepts can overlap; each paper counts once per concept.</p></section></div>`
    + '<p class="trends-footer-note">This view summarizes your saved papers, not the wider research literature.</p></div>';
  bindTrendsControls(root, model, data);
  if (data && typeof TrendsMap !== 'undefined') TrendsMap.mount(root.querySelector('[data-trends-map]'), trendsMapData(model, data, summary, asOf));
  root.scrollTop = scrollTop;
  const chart = root.querySelector('.trends-chart');
  if (chart) chart.scrollLeft = chartScrollLeft;
  if (active) [...root.querySelectorAll('[data-trends-control]')].find(control => control.dataset.trendsControl === active)?.focus({ preventScroll: true });
}

function bindTrendsControls(root, model, data) {
  const on = (selector, handler, type = 'click') => root.querySelectorAll(selector).forEach(element => element.addEventListener(type, event => handler(element, event)));
  on('[data-trends-group]', button => { if (data) trendsSelect({ group: trendsUi.group === button.dataset.trendsGroup ? '' : button.dataset.trendsGroup }); });
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
