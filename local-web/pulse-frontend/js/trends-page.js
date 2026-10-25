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

/* A short, deterministic briefing. Every action leads to the records counted. */
function trendsBriefingSignals(model, data, summary) {
  const groups=(data?.groups||[]).filter(group=>!group.ungrouped);
  const primary=[...groups].sort((a,b)=>b.papers.length-a.papers.length||a.label.localeCompare(b.label))[0];
  const concept=model.topics[0];
  const focus=primary
    ? {kind:'focus',eyebrow:'Largest research cluster',title:primary.label,value:trendsPlural(primary.papers.length),detail:`${trendsPercentage(primary.papers.length/model.total*100)} of your saved library`,group:primary.id}
    : concept ? {kind:'focus',eyebrow:'Most represented concept',title:concept.label,value:trendsPlural(concept.count),detail:'Based on saved keywords and tags',topic:concept.key}
    : {kind:'focus',eyebrow:'Research focus',title:'Concepts needed',detail:'Add keywords or tags to reveal your research focus.'};
  const shifts=groups.map(group=>({group,row:summary.stats.get(group.id)}))
    .filter(({row})=>row?.momentum.change!==null&&['rising','falling','new'].includes(row?.momentum.status))
    .sort((a,b)=>Math.abs(b.row.momentum.change)-Math.abs(a.row.momentum.change)||b.row.recent-a.row.recent);
  const shift=shifts[0];
  const signal=shift
    ? {kind:'shift',eyebrow:'Strongest share signal',title:shift.group.label,value:trendsChangeText(shift.row.momentum),status:shift.row.momentum.status,
       detail:`${trendsWindowLabel(summary.recent)} vs ${trendsWindowLabel(summary.prior)} · ${shift.row.recent} recent / ${shift.row.prior} prior`,group:shift.group.id}
    : {kind:'shift',eyebrow:'Share signals',title:'No clear shift yet',detail:groups.length?'Changes need enough dated papers and a clear comparison.':'Topic groups are needed to compare changes.'};
  const peak=[...model.bins].filter(bin=>bin.start).sort((a,b)=>b.count-a.count||b.end-a.end)[0];
  const activity=peak
    ? {kind:'activity',eyebrow:'Busiest publication period',title:peak.label,value:trendsPlural(peak.count),detail:'Publication dates of papers in your library',period:peak.key}
    : {kind:'activity',eyebrow:'Publication coverage',title:'No historical years',value:trendsPlural(model.undated),detail:'Add publication years to reveal the timeline.',...(model.undated?{period:'undated'}:{})};
  return [focus,signal,activity];
}

function trendsBriefingMarkup(model,data,summary) {
  return `<section class="trends-briefing" aria-label="Research briefing">${trendsBriefingSignals(model,data,summary).map(signal=>{
    const target=signal.group?` data-trends-signal-group="${trendsEscape(signal.group)}"`:signal.topic?` data-trends-signal-topic="${trendsEscape(signal.topic)}"`:signal.period?` data-trends-signal-period="${trendsEscape(signal.period)}"`:'';
    const tag=target?'button':'article';
    return `<${tag}${target?' type="button"':''} class="trends-signal trends-signal-${signal.kind}"${target}${target?` data-trends-control="signal-${signal.kind}"`:''}><span class="trends-signal-eyebrow">${signal.eyebrow}</span><span class="trends-signal-main"><strong>${trendsEscape(signal.title)}</strong>${signal.value?`<span class="trends-signal-value${signal.status?' is-'+signal.status:''}">${trendsEscape(signal.value)}</span>`:''}</span><span class="trends-signal-detail">${trendsEscape(signal.detail)}</span>${target?'<span class="trends-signal-arrow" aria-hidden="true">↗</span>':''}</${tag}>`;
  }).join('')}</section>`;
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
  root.innerHTML = `<div class="trends-dashboard"><header class="trends-header"><div class="trends-title-block"><span class="trends-core" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="21" stroke="currentColor" stroke-dasharray="25 7 4 7"/><circle cx="24" cy="24" r="15" stroke="currentColor" opacity=".45"/><path d="m24 13 9.5 5.5v11L24 35l-9.5-5.5v-11Z" stroke="currentColor"/><circle cx="24" cy="24" r="4" fill="currentColor"/></svg></span><div><span class="trends-eyebrow">PULSE / RESEARCH INTELLIGENCE</span><h2>Library intelligence</h2><p>Your research landscape. Every signal leads back to a paper.</p></div></div><span class="trends-scope"><i aria-hidden="true"></i>Local library analysis</span></header>`
    + `<div class="trends-stats" aria-label="Saved library coverage"><div class="trends-stat"><span>Saved papers</span><strong>${model.total.toLocaleString()}</strong><small>Your whole Pulse library</small><span class="trends-stat-meter" aria-hidden="true"><i style="width:100%"></i></span></div><div class="trends-stat"><span>With publication years</span><strong>${model.dated.toLocaleString()}<small> / ${model.total.toLocaleString()}</small></strong><small>${model.undated ? `${trendsPlural(model.undated)} undated` : 'All papers have a year'}</small><span class="trends-stat-meter" aria-hidden="true"><i style="width:${(model.dated/model.total*100).toFixed(1)}%"></i></span></div><div class="trends-stat"><span>Concepts represented</span><strong>${model.topics.length.toLocaleString()}</strong><small>Across ${trendsPlural(model.withTopics)}</small><span class="trends-stat-meter" aria-hidden="true"><i style="width:${(model.withTopics/model.total*100).toFixed(1)}%"></i></span></div><div class="trends-stat"><span>Topic groups</span><strong>${groupCount.toLocaleString()}</strong><small>${data?'Concept communities':'Awaiting concept analysis'}</small><span class="trends-stat-meter is-segmented" aria-hidden="true"><i style="width:${data?'100':'0'}%"></i></span></div></div>`
    + trendsBriefingMarkup(model,data,summary)
    + `<div class="trends-merged"><section class="trends-panel trends-map-panel" aria-labelledby="trendsMapTitle"><div class="trends-panel-heading"><div><span class="trends-section-code">01 / CONCEPT SPACE</span><h3 id="trendsMapTitle">Topic constellation</h3><p>Select a cluster or paper to trace the research behind it.</p></div>${data ? `<label class="trends-sort-label"><span class="sr-only">Number of topic groups</span><select data-trends-target data-trends-control="target" aria-label="Number of topic groups">${[6, 10, 15, 20].map(option).join('')}</select></label>` : ''}</div>`
    + (data ? `<div class="trends-map-slot"><span class="trends-map-coordinate" aria-hidden="true">LIBRARY // ${model.total.toLocaleString()} RECORDS</span><div class="trends-map-mount" data-trends-map></div><span class="trends-map-instruction" aria-hidden="true">PUBLICATION AGE → ORBIT DEPTH</span></div><p class="sr-only">The map shows ${trendsPlural(data.groups.length, 'topic group')}; the list beside it has the same groups with their numbers.</p>${trendsLegendMarkup()}` : '<p class="trends-map-waiting">Topic groups appear once Pulse has compared the concepts in your papers on the map.</p>')
    + `<div class="trends-timeline"><div class="trends-panel-heading"><div><span class="trends-section-code">02 / PUBLICATION PULSE</span><h3 id="trendsActivityTitle">${chartTitle}</h3><p>${trendsUi.playing && period ? `Showing the library up to ${period.end}` : 'Click a bar to filter, or play to watch the library grow.'}</p></div>${model.bins.some(bin => bin.start) ? `<button type="button" class="trends-play" data-trends-play data-trends-control="play" aria-pressed="${trendsUi.playing}">${trendsUi.playing ? 'Stop' : 'Play'}</button>` : ''}</div>${trendsChartMarkup(model)}</div><p class="trends-method-note">Counts describe your saved library. Periods with no saved papers are omitted; undated and future-year records stay visible separately.</p></section>`
    + `<section class="trends-panel trends-list-panel" aria-labelledby="trendsListTitle"><div class="trends-panel-heading"><div><span class="trends-section-code">03 / RESEARCH EXPLORER</span><h3 id="trendsListTitle">Clusters &amp; evidence</h3><p role="status" aria-live="polite">${trendsPlural(matches)}${hasFilters ? ' match your filters' : ' in your library'}</p></div><label class="trends-sort-label"><span class="sr-only">Sort</span><select data-trends-sort data-trends-control="sort" aria-label="Sort groups and concepts"><option value="count"${trendsUi.sort === 'count' ? ' selected' : ''}>Most papers</option><option value="recent"${trendsUi.sort === 'recent' ? ' selected' : ''}>Most recent papers</option><option value="change"${trendsUi.sort === 'change' ? ' selected' : ''}>Share increase</option></select></label></div>`
    + (hasFilters ? `<div class="trends-filter-chips" aria-label="Active trends filters">${group ? `<button type="button" data-trends-clear-group data-trends-control="clear-group" aria-label="Remove group filter ${trendsEscape(group.label)}">${trendsEscape(group.label)} <span aria-hidden="true">×</span></button>` : ''}${topic ? `<button type="button" data-trends-clear-topic data-trends-control="clear-topic" aria-label="Remove concept filter ${trendsEscape(topic.label)}">${trendsEscape(topic.label)} <span aria-hidden="true">×</span></button>` : ''}${period ? `<button type="button" data-trends-clear-period data-trends-control="clear-period" aria-label="Remove publication filter ${trendsEscape(period.label)}">${trendsEscape(period.label)} <span aria-hidden="true">×</span></button>` : ''}<button type="button" class="trends-reset" data-trends-reset data-trends-control="reset">Reset filters</button></div>` : '')
    + (summary.recent ? `<div class="trends-window-note"><strong>Recent ${trendsWindowLabel(summary.recent)}</strong><span>compared with ${trendsWindowLabel(summary.prior)}. A “?” marks a change that could be chance.</span></div>` : '<p class="trends-window-note">Add publication years to compare concept activity over time.</p>')
    + `<div class="trends-tree">${trendsRowMarkup(model, '*', 'All papers', summary.stats.get('*'), null, open)}${rows.map(([item, row]) => trendsRowMarkup(model, item.id, item.label, row, data.members.get(item.id), open)).join('')}</div>`
    + `<p class="trends-method-note">${partial}${summary.recent ? `Share = papers in a group or concept ÷ all papers in the same ${model.windowSize}-year window. “pp” means percentage points, and only changes clear at 95% are coloured. Counts follow the selected period. ${exclusions ? `${trendsEscape(exclusions)} are excluded from the comparison. ` : ''}` : ''}Concepts can overlap; each paper counts once per concept.</p></section></div>`
    + '<p class="trends-footer-note"><span aria-hidden="true">⌁</span> Calculated from your saved library · Open a signal to inspect its source papers.</p></div>';
  bindTrendsControls(root, model, data);
  if (data && typeof TrendsMap !== 'undefined') TrendsMap.mount(root.querySelector('[data-trends-map]'), trendsMapData(model, data, summary, asOf));
  root.scrollTop = scrollTop;
  const chart = root.querySelector('.trends-chart');
  if (chart) chart.scrollLeft = chartScrollLeft;
  if (active) [...root.querySelectorAll('[data-trends-control]')].find(control => control.dataset.trendsControl === active)?.focus({ preventScroll: true });
}

function bindTrendsControls(root, model, data) {
  const on = (selector, handler, type = 'click') => root.querySelectorAll(selector).forEach(element => element.addEventListener(type, event => handler(element, event)));
  on('[data-trends-signal-group]', button => trendsSelect({group:button.dataset.trendsSignalGroup,topic:'',period:'',paperLimit:10}));
  on('[data-trends-signal-topic]', button => trendsSelect({group:'*',topic:button.dataset.trendsSignalTopic,period:'',paperLimit:10}));
  on('[data-trends-signal-period]', button => trendsSelect({group:'*',topic:'',period:button.dataset.trendsSignalPeriod,paperLimit:10}));
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
