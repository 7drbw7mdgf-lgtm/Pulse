/* Publication patterns in the saved library, with traceable paper drill-downs. */
// One selection drives the map, the year chart and the list: group ('*' = all papers), concept and period.
const trendsUi = { group: '', topic: '', period: '', sort: 'count', groupTarget: 10, topicLimit: 10, paperLimit: 10, playing: false, model: null };
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

/* Change in share between two windows, tested as two proportions; only differences clear at 95% count as trends. */
function trendsMomentum(recent, recentTotal, prior, priorTotal) {
  if (!recentTotal || !priorTotal) return { change: null, z: 0, status: 'unclear' };
  const p1 = recent / recentTotal, p2 = prior / priorTotal, pooled = (recent + prior) / (recentTotal + priorTotal);
  const change = (p1 - p2) * 100;
  if (!prior && recent >= 3) return { change, z: Infinity, status: 'new' };
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / recentTotal + 1 / priorTotal)), z = se ? (p1 - p2) / se : 0;
  // A handful of papers, or a difference within chance, is reported as unclear rather than as a trend.
  return { change, z, status: recent + prior < 6 || Math.abs(z) < 1.96 ? 'unclear' : z > 0 ? 'rising' : 'falling' };
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
        topic = { ...term, count: 0, recent: 0, prior: 0, recentShare: 0, priorShare: 0, shareChange: null, status: 'unclear' };
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
      topic.status = trendsMomentum(topic.recent, recent.count, topic.prior, prior.count).status;
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

function trendsInPeriod(record, period, model) {
  if (!period) return true;
  if (period === 'undated') return record.year === null;
  if (period === 'upcoming') return record.year !== null && record.year > model.currentYear;
  const match = /^years:(\d{4}):(\d{4})$/.exec(period);
  return Boolean(match && record.year !== null && record.year >= Number(match[1]) && record.year <= Number(match[2]));
}

function trendsFilterPapers(model, filters = {}) {
  return model.records.filter(record => {
    if (filters.members && !filters.members.has(record.paper.id)) return false;
    if (filters.topic && !record.terms.has(filters.topic)) return false;
    return trendsInPeriod(record, filters.period, model);
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
