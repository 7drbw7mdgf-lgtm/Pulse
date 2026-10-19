/* Publication patterns in the saved library, with traceable paper drill-downs. */
const trendsUi = { topic: '', period: '', sort: 'count', topicLimit: 12, paperLimit: 24, model: null };
const trendsCache = { entries: new Map(), key: '', model: null, builds: 0, renderedKey: '', root: null };

function trendsPublicationYear(paper) {
  // A malformed date must not hide a valid year supplied by another provider.
  for (const value of [paper?.date, paper?.publicationDate, paper?.year]) {
    const match = String(value || '').trim().match(/(?:^|\b)(\d{4})(?=\b|-|\/)/);
    const year = match ? Number(match[1]) : 0;
    if (year >= 1500 && year <= 9999) return year;
  }
  return null;
}

function trendsPaperTerms(paper) {
  let terms = [];
  if (typeof mergedKeywords === 'function') {
    try { terms = typeof displayKeywords === 'function' ? displayKeywords(paper) : mergedKeywords(paper); } catch (_) { /* malformed legacy metadata */ }
  }
  if (!Array.isArray(terms) || !terms.length) {
    terms = [...(Array.isArray(paper?.paperKeywords) ? paper.paperKeywords : []),
      ...(Array.isArray(paper?.gemmaKeywords) ? paper.gemmaKeywords : []),
      ...(Array.isArray(paper?.keywords) ? paper.keywords : [])];
  }
  const tags = typeof paperUserTags === 'function' ? paperUserTags(paper) : paper?.userTags;
  return [...terms, ...(Array.isArray(tags) ? tags : [])];
}

function trendsTermEntries(values) {
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim().replace(/\s+/g, ' ');
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, label });
  }
  return entries;
}

function trendsYearBins(yearCounts) {
  const years = [...yearCounts.keys()].sort((a, b) => a - b);
  if (!years.length) return [];
  // Preserve every saved paper while keeping long historical ranges readable.
  const span = years.at(-1) - years[0] + 1;
  const step = span <= 18 ? 1 : span <= 90 ? 5 : span <= 180 ? 10 : Math.ceil(span / 18 / 25) * 25;
  const grouped = new Map();
  for (const year of years) {
    const start = step === 1 ? year : Math.floor(year / step) * step;
    // The final bin stops at its newest known year, so future papers cannot
    // silently join a historical bar when its drill-down is selected.
    const end = Math.min(start + step - 1, years.at(-1));
    const key = `years:${start}:${end}`;
    let bin = grouped.get(key);
    if (!bin) {
      bin = { key, start, end, count: 0, label: step === 1 ? String(year) : `${start}–${end}` };
      grouped.set(key, bin);
    }
    bin.count += yearCounts.get(year);
  }
  return [...grouped.values()];
}

function buildTrendsModel(papers, options = {}) {
  const currentYear = Number.isInteger(options.currentYear) ? options.currentYear : new Date().getFullYear();
  const windowSize = Number.isInteger(options.windowSize) && options.windowSize > 0 ? options.windowSize : 3;
  const getTerms = options.getTerms || trendsPaperTerms;
  const records = [];
  const yearCounts = new Map();
  const topicMap = new Map();
  let undated = 0, upcoming = 0, withTopics = 0, latestYear = null;
  for (const paper of Array.isArray(papers) ? papers : []) {
    if (!paper || typeof paper !== 'object') continue;
    const year = trendsPublicationYear(paper);
    const terms = trendsTermEntries(getTerms(paper));
    const record = { paper, year, terms: new Set(terms.map(term => term.key)) };
    records.push(record);
    if (terms.length) withTopics++;
    if (year === null) undated++;
    else if (year > currentYear) upcoming++;
    else {
      yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
      latestYear = latestYear === null ? year : Math.max(latestYear, year);
    }
    for (const term of terms) {
      let topic = topicMap.get(term.key);
      if (!topic) {
        topic = { ...term, count: 0, recent: 0, prior: 0, recentShare: 0, priorShare: 0, shareChange: null };
        topicMap.set(term.key, topic);
      }
      topic.count++;
    }
  }
  const recent = latestYear === null ? null : { start: latestYear - windowSize + 1, end: latestYear, count: 0 };
  const prior = latestYear === null ? null : { start: latestYear - windowSize * 2 + 1, end: latestYear - windowSize, count: 0 };
  if (recent) {
    for (const record of records) {
      const period = record.year !== null && record.year >= recent.start && record.year <= recent.end ? recent
        : record.year !== null && record.year >= prior.start && record.year <= prior.end ? prior : null;
      if (!period) continue;
      period.count++;
      const field = period === recent ? 'recent' : 'prior';
      for (const key of record.terms) topicMap.get(key)[field]++;
    }
    for (const topic of topicMap.values()) {
      topic.recentShare = recent.count ? topic.recent / recent.count * 100 : 0;
      topic.priorShare = prior.count ? topic.prior / prior.count * 100 : 0;
      // With no papers in a baseline window there is no defensible share change.
      topic.shareChange = recent.count && prior.count ? topic.recentShare - topic.priorShare : null;
    }
  }
  const topics = [...topicMap.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const bins = trendsYearBins(yearCounts);
  if (upcoming) bins.push({ key: 'upcoming', count: upcoming, label: 'Future years' });
  if (undated) bins.push({ key: 'undated', count: undated, label: 'Undated' });
  return { records, total: records.length, dated: records.length - undated, historical: records.length - undated - upcoming,
    undated, upcoming, withTopics, topics, topicMap, yearCounts, bins, currentYear, latestYear, recent, prior, windowSize };
}

function cachedTrendsModel(papers) {
  const currentYear = new Date().getFullYear();
  const next = new Map(), keys = [currentYear];
  for (const paper of papers) {
    // Full text, positions, selections and colours cannot affect these counts.
    // Reuse the keywords already produced by the graph analysis.
    const derived = state.keywords?.get(paper.id) || [];
    const fingerprint = JSON.stringify([paper.id, paper.date, paper.publicationDate, paper.year,
      paper.title, paper.authors, paper.journal, paper.paperKeywords, paper.gemmaKeywords,
      paper.keywords, paper.userTags, derived, paper.doi, paper.url, paper.landingPageUrl,
      paper.fullTextUrl, paper.pdfUrl, paper.openAlexId, paper.s2PaperId]);
    const previous = trendsCache.entries.get(paper.id);
    const entry = previous?.fingerprint === fingerprint ? previous
      : { fingerprint, terms: trendsPaperTerms(paper) };
    entry.paper = paper;
    next.set(paper.id, entry);
    keys.push(fingerprint);
  }
  const groups = state.clusters || [];
  keys.push(groups);
  const key = JSON.stringify(keys);
  trendsCache.entries = next;
  if (key === trendsCache.key && trendsCache.model) {
    for (const record of trendsCache.model.records) record.paper = next.get(record.paper.id).paper;
    return trendsCache.model;
  }
  trendsCache.key = key;
  const model = buildTrendsModel(papers, { currentYear, getTerms: paper => next.get(paper.id).terms });
  model.groups = groups.map(ids => [...ids]);
  model.cacheRevision = ++trendsCache.builds;
  trendsCache.model = model;
  return model;
}

function trendsFilterPapers(model, filters = {}) {
  return model.records.filter(record => {
    if (filters.topic && !record.terms.has(filters.topic)) return false;
    if (!filters.period) return true;
    if (filters.period === 'undated') return record.year === null;
    if (filters.period === 'upcoming') return record.year !== null && record.year > model.currentYear;
    const match = /^years:(\d{4}):(\d{4})$/.exec(filters.period);
    return Boolean(match && record.year !== null && record.year >= Number(match[1]) && record.year <= Number(match[2]));
  }).sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity)
    || String(a.paper.title || '').localeCompare(String(b.paper.title || '')));
}

function trendsVisible() {
  return Boolean(els.trendsView && !els.trendsView.hidden);
}

function setTrendsVisible(visible) {
  if (!els.trendsView) return;
  els.trendsView.hidden = !visible;
  els.app.classList.toggle('trends-active', Boolean(visible));
  if (visible) {
    if (typeof calculateRelatedness === 'function') calculateRelatedness();
    renderTrends();
  }
}

function trendsEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function trendsPlural(count, noun = 'paper') {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function trendsWindowLabel(window) {
  return window ? `${window.start}–${window.end}` : 'No dated papers';
}

function trendsPercentage(value) {
  return `${value === 0 ? '0' : value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

function trendsPaperUrl(paper) {
  if (typeof paperOpenUrl !== 'function') return '';
  const url = String(paperOpenUrl(paper) || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function trendsChartMarkup(model) {
  if (!model.bins.length) return '<div class="trends-chart-empty">Add publication years to see how your saved papers are distributed over time.</div>';
  const max = Math.max(...model.bins.map(bin => bin.count), 1);
  return `<div class="trends-chart" role="group" aria-label="Filter saved papers by publication period">${model.bins.map(bin => {
    const selected = trendsUi.period === bin.key;
    const special = bin.key === 'undated' || bin.key === 'upcoming';
    return `<button type="button" class="trends-year${selected ? ' is-active' : ''}${special ? ' is-unknown' : ''}" data-trends-period="${bin.key}" data-trends-control="period-${bin.key}" aria-pressed="${selected}" aria-label="${trendsEscape(bin.label)}: ${trendsPlural(bin.count)}. Filter papers."><span class="trends-bar-count">${bin.count.toLocaleString()}</span><span class="trends-bar-track" aria-hidden="true"><span class="trends-bar" style="height:${Math.max(3, bin.count / max * 100).toFixed(2)}%"></span></span><span class="trends-bar-label">${trendsEscape(bin.label)}</span></button>`;
  }).join('')}</div>`;
}

function trendsTopicMarkup(topic, model) {
  const selected = trendsUi.topic === topic.key;
  const change = topic.shareChange;
  const changeText = change === null ? 'No baseline' : Math.abs(change) < .05 ? 'Stable share' : `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)} pp`;
  const comparison = model.recent ? `${topic.recent} recent · ${topic.prior} prior` : 'Publication years needed for comparison';
  const recentDetail = model.recent ? `${trendsWindowLabel(model.recent)}: ${trendsPlural(topic.recent)}, ${trendsPercentage(topic.recentShare)} of ${trendsPlural(model.recent.count)}; ${trendsWindowLabel(model.prior)}: ${trendsPlural(topic.prior)}, ${trendsPercentage(topic.priorShare)} of ${trendsPlural(model.prior.count)}` : comparison;
  return `<button type="button" class="trends-topic${selected ? ' is-active' : ''}" data-trends-topic="${trendsEscape(topic.key)}" data-trends-control="topic-${trendsEscape(topic.key)}" aria-pressed="${selected}" aria-label="${trendsEscape(topic.label)}: ${trendsPlural(topic.count)} in your library. ${trendsEscape(recentDetail)}. Filter papers."><span class="trends-topic-name">${trendsEscape(topic.label)}</span><strong>${topic.count.toLocaleString()}<small> papers</small></strong><span class="trends-topic-comparison">${trendsEscape(comparison)}</span><span class="trends-topic-change${change !== null && change > .05 ? ' is-increasing' : ''}" title="${trendsEscape(recentDetail)}">${changeText}</span></button>`;
}

function trendsPaperMarkup(record) {
  const { paper, year } = record;
  const id = trendsEscape(paper.id);
  const url = trendsPaperUrl(paper);
  const authors = typeof paperAuthorSummary === 'function' ? paperAuthorSummary(paper) : (Array.isArray(paper.authors) ? paper.authors.slice(0, 3).join(', ') : '');
  const selected = paper.id === state.selectedId;
  return `<article class="trends-paper${selected ? ' is-selected' : ''}" data-trends-paper="${id}"><div class="trends-paper-top"><span class="trends-paper-year">${year === null ? 'Undated' : year}</span>${paper.journal ? `<span class="trends-paper-venue" title="${trendsEscape(paper.journal)}">${trendsEscape(paper.journal)}</span>` : ''}</div><button class="trends-paper-title" type="button" data-trends-inspect="${id}" data-trends-control="paper-${id}"${selected ? ' aria-current="true"' : ''}>${trendsEscape(paper.title || 'Untitled paper')}</button>${authors ? `<p class="trends-paper-authors">${trendsEscape(authors)}</p>` : ''}<div class="trends-paper-actions"><button type="button" data-trends-inspect="${id}" data-trends-control="details-${id}">Details</button>${url ? `<a href="${trendsEscape(url)}" target="_blank" rel="noreferrer">Open paper <span aria-hidden="true">↗</span></a>` : ''}<button type="button" data-trends-network="${id}" data-trends-control="network-${id}">View in graph <span aria-hidden="true">→</span></button></div></article>`;
}

function renderTrendsSelection() {
  if (!trendsVisible()) return;
  els.trendsView.querySelectorAll('[data-trends-paper]').forEach(card => {
    const selected = card.dataset.trendsPaper === String(state.selectedId);
    card.classList.toggle('is-selected', selected);
    const title = card.querySelector('.trends-paper-title');
    if (selected) title?.setAttribute('aria-current', 'true'); else title?.removeAttribute('aria-current');
  });
}

function renderTrends({ refresh = true } = {}) {
  if (!trendsVisible()) return;
  const root = els.trendsView;
  const active = root.contains(document.activeElement) ? document.activeElement.dataset.trendsControl : '';
  const scrollTop = root.scrollTop;
  const chartScrollLeft = root.querySelector('.trends-chart')?.scrollLeft || 0;
  if (refresh || !trendsUi.model) trendsUi.model = cachedTrendsModel(state.papers);
  const model = trendsUi.model;
  if (trendsUi.topic && !model.topicMap.has(trendsUi.topic)) trendsUi.topic = '';
  if (trendsUi.period && !model.bins.some(bin => bin.key === trendsUi.period)) trendsUi.period = '';
  const renderKey = JSON.stringify([model.cacheRevision, trendsUi.topic, trendsUi.period,
    trendsUi.sort, trendsUi.topicLimit, trendsUi.paperLimit]);
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
  let topics = model.topics;
  if (trendsUi.sort === 'recent') topics = [...topics].sort((a, b) => b.recent - a.recent || b.count - a.count || a.label.localeCompare(b.label));
  if (trendsUi.sort === 'change') topics = [...topics].sort((a, b) => (b.shareChange ?? -Infinity) - (a.shareChange ?? -Infinity) || b.count - a.count || a.label.localeCompare(b.label));
  const matches = trendsFilterPapers(model, trendsUi);
  const topic = model.topicMap.get(trendsUi.topic);
  const period = model.bins.find(bin => bin.key === trendsUi.period);
  const hasFilters = Boolean(topic || period);
  const partial = model.latestYear === model.currentYear ? 'The current publication year is incomplete. ' : '';
  const chartTitle = model.bins.some(bin => bin.start !== bin.end) ? 'Publication activity by period' : 'Publication activity by year';
  const exclusions = [model.undated ? `${trendsPlural(model.undated)} without a year` : '', model.upcoming ? `${trendsPlural(model.upcoming)} with future years` : ''].filter(Boolean).join(' and ');
  root.innerHTML = `<div class="trends-dashboard"><header class="trends-header"><div><span class="trends-eyebrow">SAVED LIBRARY</span><h2>Library trends</h2><p>Explore publication years and shared concepts in your saved papers.</p></div><span class="trends-scope">Whole library</span></header><div class="trends-stats" aria-label="Saved library coverage"><div class="trends-stat"><span>Saved papers</span><strong>${model.total.toLocaleString()}</strong><small>Your whole Pulse library</small></div><div class="trends-stat"><span>With publication years</span><strong>${model.dated.toLocaleString()}<small> / ${model.total.toLocaleString()}</small></strong><small>${model.undated ? `${trendsPlural(model.undated)} undated` : 'All papers have a year'}</small></div><div class="trends-stat"><span>Concepts represented</span><strong>${model.topics.length.toLocaleString()}</strong><small>Across ${trendsPlural(model.withTopics)}</small></div><div class="trends-stat"><span>Topic groups</span><strong>${model.groups.length.toLocaleString()}</strong><small>Groups of related papers</small></div></div><section class="trends-panel trends-activity" aria-labelledby="trendsActivityTitle"><div class="trends-panel-heading"><div><h3 id="trendsActivityTitle">${chartTitle}</h3><p>Click a period to explore its saved papers.</p></div><span class="trends-panel-note">Publication date · ${trendsPlural(model.total)}</span></div>${trendsChartMarkup(model)}<p class="trends-method-note">Counts describe your saved library. Periods with no saved papers are omitted; undated and future-year records stay visible separately.</p></section><div class="trends-explore"><section class="trends-panel trends-concepts" aria-labelledby="trendsConceptsTitle"><div class="trends-panel-heading"><div><h3 id="trendsConceptsTitle">Concept activity</h3><p>Tags and extracted keywords</p></div><label class="trends-sort-label"><span class="sr-only">Sort concepts</span><select data-trends-sort data-trends-control="sort" aria-label="Sort concepts"><option value="count"${trendsUi.sort === 'count' ? ' selected' : ''}>Most represented</option><option value="recent"${trendsUi.sort === 'recent' ? ' selected' : ''}>Most recent papers</option><option value="change"${trendsUi.sort === 'change' ? ' selected' : ''}>Share increase</option></select></label></div>${model.recent ? `<div class="trends-window-note"><strong>Recent ${trendsWindowLabel(model.recent)}</strong><span>${trendsPlural(model.recent.count)} · prior ${trendsWindowLabel(model.prior)}: ${trendsPlural(model.prior.count)}</span></div>` : '<p class="trends-window-note">Add publication years to compare concept activity over time.</p>'}<div class="trends-topic-list">${topics.length ? topics.slice(0, trendsUi.topicLimit).map(item => trendsTopicMarkup(item, model)).join('') : '<p class="trends-no-concepts">No concepts yet. Add tags or keywords to your papers to see them here.</p>'}</div>${topics.length > trendsUi.topicLimit ? `<button type="button" class="trends-more" data-trends-more-topics data-trends-control="more-topics">Show more concepts <span>${topics.length - trendsUi.topicLimit} more</span></button>` : ''}<p class="trends-method-note">${partial}${model.recent ? `Equal ${model.windowSize}-year windows end at the latest nonfuture publication year in your library. Share = papers with this concept ÷ all papers in the same window. “pp” means percentage points. ${exclusions ? `${trendsEscape(exclusions)} are excluded from the comparison. ` : ''}` : ''}Concepts can overlap; each paper counts once per concept.</p></section><section class="trends-panel trends-matches" aria-labelledby="trendsPapersTitle"><div class="trends-panel-heading"><div><h3 id="trendsPapersTitle">${hasFilters ? 'Matching papers' : 'Explore the papers'}</h3><p role="status" aria-live="polite">${trendsPlural(matches.length)}${hasFilters ? ' match your filters' : ' · newest publication first'}</p></div>${hasFilters ? '<button type="button" class="trends-reset" data-trends-reset data-trends-control="reset">Reset filters</button>' : ''}</div>${hasFilters ? `<div class="trends-filter-chips" aria-label="Active trends filters">${topic ? `<button type="button" data-trends-clear-topic data-trends-control="clear-topic" aria-label="Remove concept filter ${trendsEscape(topic.label)}">${trendsEscape(topic.label)} <span aria-hidden="true">×</span></button>` : ''}${period ? `<button type="button" data-trends-clear-period data-trends-control="clear-period" aria-label="Remove publication filter ${trendsEscape(period.label)}">${trendsEscape(period.label)} <span aria-hidden="true">×</span></button>` : ''}</div>` : ''}<div class="trends-paper-list">${matches.length ? matches.slice(0, trendsUi.paperLimit).map(trendsPaperMarkup).join('') : '<div class="trends-no-matches"><strong>No papers match both filters</strong><p>Remove a concept or publication filter to explore more of your library.</p></div>'}</div>${matches.length > trendsUi.paperLimit ? `<button type="button" class="trends-more" data-trends-more-papers data-trends-control="more-papers">Show more papers <span>${matches.length - trendsUi.paperLimit} more</span></button>` : ''}</section></div><p class="trends-footer-note">This view summarizes your saved papers, not the wider research literature.</p></div>`;
  if (topic && typeof startTrendsTopicSearch === 'function') {
    const action = document.createElement('button');
    action.type = 'button'; action.className = 'trends-reset'; action.textContent = 'Discover this concept';
    action.addEventListener('click', () => startTrendsTopicSearch(topic.label));
    root.querySelector('.trends-matches .trends-panel-heading')?.append(action);
  }
  root.querySelectorAll('[data-trends-period]').forEach(button => button.addEventListener('click', () => {
    trendsUi.period = trendsUi.period === button.dataset.trendsPeriod ? '' : button.dataset.trendsPeriod;
    trendsUi.paperLimit = 24; renderTrends({ refresh: false });
  }));
  root.querySelectorAll('[data-trends-topic]').forEach(button => button.addEventListener('click', () => {
    trendsUi.topic = trendsUi.topic === button.dataset.trendsTopic ? '' : button.dataset.trendsTopic;
    trendsUi.paperLimit = 24; renderTrends({ refresh: false });
  }));
  root.querySelector('[data-trends-sort]')?.addEventListener('change', event => { trendsUi.sort = event.target.value; renderTrends({ refresh: false }); });
  root.querySelector('[data-trends-reset]')?.addEventListener('click', () => { trendsUi.topic = ''; trendsUi.period = ''; trendsUi.paperLimit = 24; renderTrends({ refresh: false }); });
  root.querySelector('[data-trends-clear-topic]')?.addEventListener('click', () => { trendsUi.topic = ''; trendsUi.paperLimit = 24; renderTrends({ refresh: false }); });
  root.querySelector('[data-trends-clear-period]')?.addEventListener('click', () => { trendsUi.period = ''; trendsUi.paperLimit = 24; renderTrends({ refresh: false }); });
  root.querySelector('[data-trends-more-topics]')?.addEventListener('click', () => { trendsUi.topicLimit += 12; renderTrends({ refresh: false }); });
  root.querySelector('[data-trends-more-papers]')?.addEventListener('click', () => { trendsUi.paperLimit += 24; renderTrends({ refresh: false }); });
  root.querySelectorAll('[data-trends-inspect]').forEach(button => button.addEventListener('click', () => { inspectPaper(button.dataset.trendsInspect); renderTrendsSelection(); }));
  root.querySelectorAll('[data-trends-network]').forEach(button => button.addEventListener('click', () => {
    if (typeof window.openTrendsPaperInGraph === 'function') window.openTrendsPaperInGraph(button.dataset.trendsNetwork);
  }));
  root.scrollTop = scrollTop;
  const chart = root.querySelector('.trends-chart');
  if (chart) chart.scrollLeft = chartScrollLeft;
  if (active) [...root.querySelectorAll('[data-trends-control]')].find(control => control.dataset.trendsControl === active)?.focus({ preventScroll: true });
}
