/* The Trends page: the map, the year chart and the Groups → Concepts → Papers list all read one selection in trendsUi. */
const trendsGroupCache = { key: '', value: null };
let trendsPlayTimer = 0;

/* Topic groups from the map's concept analysis; null until that analysis exists. */
function trendsGroupData(model) {
  if (typeof TrendsGroups === 'undefined' || !(state.vectors instanceof Map) || !state.vectors.size) return null;
  const key = JSON.stringify([model.cacheRevision, state.graphAnalysisRevision || 0, state.vectors.size, (state.links || []).length, trendsUi.groupTarget]);
  if (trendsGroupCache.key === key) return trendsGroupCache.value;
  const papers = model.records.map(record => record.paper);
  const value = TrendsGroups.groupLibrary(papers, TrendsGroups.fromGraph(papers, state.vectors, state.links, state.keywords), trendsUi.groupTarget, trendsPaperTerms);
  value.members = new Map(value.groups.map(group => [group.id, new Set(group.papers.map(paper => paper.id))]));
  trendsGroupCache.key = key; trendsGroupCache.value = value;
  return value;
}

function trendsChangeText(m) {
  if (m.status === 'new') return 'New';
  if (m.change === null) return 'No baseline';
  if (Math.abs(m.change) < .05) return m.status === 'unclear' ? 'Stable share?' : 'Stable share';
  return `${m.change > 0 ? '+' : '−'}${Math.abs(m.change).toFixed(1)} pp${m.status === 'unclear' ? '?' : ''}`;
}

/* Counts per group under the current period, sizes as of the playback year, and share change in the two windows ending then. */
function trendsGroupStats(model, data, asOf) {
  const end = asOf ?? model.latestYear, size = model.windowSize;
  const recent = end === null ? null : { start: end - size + 1, end }, prior = recent && { start: recent.start - size, end: recent.start - 1 };
  const slot = year => !recent || year === null ? '' : year >= recent.start && year <= recent.end ? 'recent' : year >= prior.start && year <= prior.end ? 'prior' : '';
  const totals = { recent: 0, prior: 0 }, stats = new Map([['*', { count: 0, visible: 0, recent: 0, prior: 0 }]]);
  data?.groups.forEach(group => stats.set(group.id, { count: 0, visible: 0, recent: 0, prior: 0 }));
  for (const record of model.records) {
    const rows = [stats.get('*'), stats.get(data?.groupOf.get(record.paper.id))].filter(Boolean), window = slot(record.year);
    if (window) totals[window]++;
    for (const row of rows) {
      if (trendsInPeriod(record, trendsUi.period, model)) row.count++;
      if (asOf === null || (record.year !== null && record.year <= asOf)) row.visible++;
      if (window) row[window]++;
    }
  }
  for (const [id, row] of stats) {
    row.momentum = id === '*' ? { change: null, z: 0, status: 'unclear' } : trendsMomentum(row.recent, totals.recent, row.prior, totals.prior);
    row.tip = recent && totals.recent && totals.prior ? `${trendsWindowLabel(recent)}: ${row.recent} of ${trendsPlural(totals.recent)}; ${trendsWindowLabel(prior)}: ${row.prior} of ${trendsPlural(totals.prior)}${row.momentum.status === 'unclear' ? '. Not clear at 95%; could be chance' : ''}` : 'Not enough dated papers to compare windows';
  }
  return { stats, recent, prior };
}

function trendsTopicMarkup(topic, count) {
  const selected = trendsUi.topic === topic.key, status = topic.status || 'unclear';
  const detail = `${topic.recent} recent · ${topic.prior} prior across the library`;
  return `<button type="button" class="trends-topic${selected ? ' is-active' : ''}" data-trends-topic="${trendsEscape(topic.key)}" data-trends-control="topic-${trendsEscape(topic.key)}" aria-pressed="${selected}" aria-label="${trendsEscape(topic.label)}: ${trendsPlural(count)}. ${trendsEscape(detail)}. Filter papers."><span class="trends-topic-name">${trendsEscape(topic.label)}</span><strong>${count.toLocaleString()}</strong><span class="trends-topic-change is-${status}" title="${trendsEscape(detail)}">${trendsChangeText({ change: topic.shareChange, status })}</span></button>`;
}

function trendsPaperMarkup(record) {
  const { paper, year } = record;
  const id = trendsEscape(paper.id), url = trendsPaperUrl(paper), selected = paper.id === state.selectedId;
  const authors = typeof paperAuthorSummary === 'function' ? paperAuthorSummary(paper) : (Array.isArray(paper.authors) ? paper.authors.slice(0, 3).join(', ') : '');
  return `<article class="trends-paper${selected ? ' is-selected' : ''}" data-trends-paper="${id}"><div class="trends-paper-top"><span class="trends-paper-year">${year === null ? 'Undated' : year}</span>${paper.journal ? `<span class="trends-paper-venue" title="${trendsEscape(paper.journal)}">${trendsEscape(paper.journal)}</span>` : ''}</div><button class="trends-paper-title" type="button" data-trends-inspect="${id}" data-trends-control="paper-${id}"${selected ? ' aria-current="true"' : ''}>${trendsEscape(paper.title || 'Untitled paper')}</button>${authors ? `<p class="trends-paper-authors">${trendsEscape(authors)}</p>` : ''}<div class="trends-paper-actions"><button type="button" data-trends-inspect="${id}" data-trends-control="details-${id}">Details</button>${url ? `<a href="${trendsEscape(url)}" target="_blank" rel="noreferrer">Open paper <span aria-hidden="true">↗</span></a>` : ''}<button type="button" data-trends-network="${id}" data-trends-control="network-${id}">View in graph <span aria-hidden="true">→</span></button></div></article>`;
}

/* An open row lists its concepts (counted inside it, under the period) and then its matching papers. */
function trendsGroupBody(model, members) {
  const counts = new Map();
  for (const record of model.records) {
    if ((members && !members.has(record.paper.id)) || !trendsInPeriod(record, trendsUi.period, model)) continue;
    for (const key of record.terms) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const by = { count: (a, b) => b[1] - a[1], recent: (a, b) => b[0].recent - a[0].recent || b[1] - a[1],
    change: (a, b) => (b[0].shareChange ?? -Infinity) - (a[0].shareChange ?? -Infinity) || b[1] - a[1] }[trendsUi.sort];
  const topics = [...counts].map(([key, count]) => [model.topicMap.get(key), count]).sort((a, b) => by(a, b) || a[0].label.localeCompare(b[0].label));
  const papers = trendsFilterPapers(model, { members, topic: trendsUi.topic, period: trendsUi.period });
  const topic = model.topicMap.get(trendsUi.topic);
  return `<div class="trends-group-body"><p class="trends-subhead">Concepts<span>${trendsPlural(topics.length, 'concept')}</span></p>${topics.length ? topics.slice(0, trendsUi.topicLimit).map(([item, count]) => trendsTopicMarkup(item, count)).join('') : '<p class="trends-no-concepts">No concepts yet. Add tags or keywords to your papers to see them here.</p>'}${topics.length > trendsUi.topicLimit ? `<button type="button" class="trends-more" data-trends-more-topics data-trends-control="more-topics">Show more concepts <span>${topics.length - trendsUi.topicLimit} more</span></button>` : ''}`
    + `<p class="trends-subhead">${topic ? `Papers on ${trendsEscape(topic.label)}` : 'Papers'}<span>${trendsPlural(papers.length)} · newest first</span>${topic && typeof startTrendsTopicSearch === 'function' ? '<button type="button" class="trends-reset" data-trends-discover data-trends-control="discover">Discover this concept</button>' : ''}</p>`
    + `<div class="trends-paper-list">${papers.length ? papers.slice(0, trendsUi.paperLimit).map(trendsPaperMarkup).join('') : '<div class="trends-no-matches"><strong>No papers match these filters</strong><p>Remove a concept or period to see more of this group.</p></div>'}</div>${papers.length > trendsUi.paperLimit ? `<button type="button" class="trends-more" data-trends-more-papers data-trends-control="more-papers">Show more papers <span>${papers.length - trendsUi.paperLimit} more</span></button>` : ''}</div>`;
}

function trendsRowMarkup(model, id, label, row, members, openId) {
  const open = openId === id, status = row.momentum.status;
  return `<div class="trends-group-item${open ? ' is-open' : ''}"><button type="button" class="trends-group" data-trends-group="${id}" data-trends-control="group-${id}" aria-expanded="${open}" title="${trendsEscape(row.tip)}"><span class="trends-group-dot is-${id === '*' ? 'all' : status}" aria-hidden="true"></span><span class="trends-group-name">${trendsEscape(label)}</span><strong>${row.count.toLocaleString()}</strong><span class="trends-topic-change is-${status}">${id === '*' ? (trendsUi.period ? 'In period' : 'All') : trendsChangeText(row.momentum)}</span></button>${open ? trendsGroupBody(model, members) : ''}</div>`;
}

function trendsChartMarkup(model) {
  if (!model.bins.length) return '<div class="trends-chart-empty">Add publication years to see how your saved papers are distributed over time.</div>';
  const max = Math.max(...model.bins.map(bin => bin.count), 1);
  return `<div class="trends-chart" role="group" aria-label="Filter saved papers by publication period">${model.bins.map(bin => {
    const selected = trendsUi.period === bin.key, special = bin.key === 'undated' || bin.key === 'upcoming';
    return `<button type="button" class="trends-year${selected ? ' is-active' : ''}${special ? ' is-unknown' : ''}" data-trends-period="${bin.key}" data-trends-control="period-${bin.key}" aria-pressed="${selected}" aria-label="${trendsEscape(bin.label)}: ${trendsPlural(bin.count)}. Filter papers."><span class="trends-bar-count">${bin.count.toLocaleString()}</span><span class="trends-bar-track" aria-hidden="true"><span class="trends-bar" style="height:${Math.max(3, bin.count / max * 100).toFixed(2)}%"></span></span><span class="trends-bar-label">${trendsEscape(bin.label)}</span></button>`;
  }).join('')}</div>`;
}

/* What the map draws: one bubble per group, one dot per paper, with the list's selection. */
function trendsMapData(model, data, summary, asOf) {
  const byId = model.byId ||= new Map(), reference = asOf ?? model.latestYear ?? model.currentYear;
  if (byId.size !== model.records.length) model.records.forEach(record => byId.set(record.paper.id, record));
  const topic = trendsUi.topic ? new Set(model.records.filter(record => record.terms.has(trendsUi.topic)).map(record => record.paper.id)) : null;
  return { group: trendsUi.group === '*' ? '' : trendsUi.group, topicPapers: topic, selectedPaper: state.selectedId,
    groups: data.groups.map(group => {
      const row = summary.stats.get(group.id);
      return { id: group.id, label: group.label, status: row.momentum.status, visible: row.visible, tip: `${trendsPlural(row.count)}. ${row.tip}`,
        stats: `${row.visible}${row.momentum.change === null ? '' : ' · ' + trendsChangeText(row.momentum)}`,
        papers: group.papers.map(paper => {
          const record = byId.get(paper.id), year = record?.year ?? null, age = year === null ? null : reference - year;
          const authors = typeof paperAuthorSummary === 'function' ? paperAuthorSummary(paper) : '';
          return { id: paper.id, title: paper.title || 'Untitled paper', detail: [authors, year ?? 'Undated', paper.journal].filter(Boolean).join(' · '),
            ring: age === null ? 4 : age <= 2 ? 0 : age <= 5 ? 1 : age <= 10 ? 2 : 3, reach: data.reach.get(paper.id),
            visible: asOf === null || (year !== null && year <= asOf), emphasis: !record || trendsInPeriod(record, trendsUi.period, model) };
        }) };
    }),
    onGroup: id => trendsSelect({ group: trendsUi.group === id ? '' : id }),
    onPaper: (id, group) => { trendsSelect({ group }); inspectPaper(id); renderTrendsSelection(); els.trendsView.querySelector(`[data-trends-paper="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }); },
    onHover: id => els.trendsView.querySelectorAll('[data-trends-paper]').forEach(card => card.classList.toggle('is-hot', card.dataset.trendsPaper === id)) };
}

/* Every control changes the one selection; a new group starts with no concept and short lists. */
function trendsSelect(change) {
  if (trendsUi.playing && !('period' in change && change.keepPlaying)) trendsStopPlay();
  if ('group' in change && change.group !== trendsUi.group) Object.assign(trendsUi, { topic: '', topicLimit: 10, paperLimit: 10 });
  Object.assign(trendsUi, change);
  delete trendsUi.keepPlaying;
  renderTrends({ refresh: false });
}

function trendsStopPlay() {
  clearInterval(trendsPlayTimer);
  trendsPlayTimer = 0; trendsUi.playing = false;
}

/* Playback steps through the dated bars; the map grows to each bar's end year and the list follows the bar. */
function trendsTogglePlay(model) {
  if (trendsUi.playing) { trendsStopPlay(); trendsSelect({ period: '' }); return; }
  const bins = model.bins.filter(bin => bin.start);
  if (!bins.length) return;
  let index = 0;
  trendsUi.playing = true; trendsSelect({ period: bins[0].key, keepPlaying: true });
  trendsPlayTimer = setInterval(() => {
    index++;
    if (!trendsVisible() || index >= bins.length) { trendsStopPlay(); if (trendsVisible()) trendsSelect({ period: '' }); return; }
    trendsSelect({ period: bins[index].key, keepPlaying: true });
  }, 900);
}
