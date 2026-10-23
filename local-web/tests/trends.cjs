const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/trends.js'), 'utf8');
const view = { hidden: false, innerHTML: '', scrollTop: 73, contains: () => false,
  querySelector: () => null, querySelectorAll: () => [] };
const classes = new Set();
const context = { console, Date, Set, Map, state: { papers: [], selectedId: null },
  els: { trendsView: view, app: { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } } },
  document: { activeElement: { dataset: {} } }, window: {},
  mergedKeywords: paper => [...(paper.paperKeywords || []), ...(paper.gemmaKeywords || [])],
  paperUserTags: paper => paper.userTags || [],
  paperOpenUrl: paper => paper.url || '',
  paperAuthorSummary: paper => (paper.authors || []).join(', '), inspectPaper() {} };
vm.createContext(context); vm.runInContext(source, context);
const model = (papers, options = {}) => context.buildTrendsModel(papers, { currentYear: 2026, ...options });
const ids = entries => Array.from(entries, entry => entry.paper.id);
const p = (id, year, terms = []) => ({ id, year, title: `Paper ${id}`, paperKeywords: terms });

// Real publication metadata, legacy formats and honest coverage gaps.
assert.equal(context.trendsPublicationYear({ date: 'unknown', year: '2023' }), 2023);
assert.equal(context.trendsPublicationYear({ date: '2021-04-17', year: '2023' }), 2021);
assert.equal(context.trendsPublicationYear({ date: '14 March 2022' }), 2022);
assert.equal(context.trendsPublicationYear({ date: 'bad', publicationDate: '2020/05/06' }), 2020);
assert.equal(context.trendsPublicationYear({ year: '20261' }), null);
assert.equal(context.trendsPublicationYear({ year: '1200' }), null);
assert.equal(context.trendsPublicationYear({ year: null }), null);

const papers = [p('prior-a', 2021, ['RNA', ' rna ', 'Genomics']), p('prior-b', 2022, ['Genomics']),
  p('recent-a', 2024, ['RNA']), p('recent-b', 2025, ['RNA']), p('recent-c', 2026, ['Genomics']),
  p('old', 2010, ['RNA']), p('undated', '', ['RNA']), p('future', 9999, ['RNA']),
  { ...p('tags', 2026, ['   RNA   ']), gemmaKeywords: ['rna'], userTags: ['RNA', 'Methods'] }];
const m = model(papers);
assert.equal(m.total, 9); assert.equal(m.dated, 8); assert.equal(m.undated, 1); assert.equal(m.upcoming, 1);
assert.equal(m.latestYear, 2026); assert.equal(m.historical, 7);
assert.deepEqual([m.recent.start, m.recent.end, m.recent.count], [2024, 2026, 4]);
assert.deepEqual([m.prior.start, m.prior.end, m.prior.count], [2021, 2023, 2]);
const rna = m.topicMap.get('rna');
assert.equal(rna.count, 7); assert.equal(rna.recent, 3); assert.equal(rna.prior, 1);
assert.equal(rna.recentShare, 75); assert.equal(rna.priorShare, 50); assert.equal(rna.shareChange, 25);
assert.equal(m.topicMap.get('methods').count, 1);
assert.equal(m.bins.reduce((sum, bin) => sum + bin.count, 0), m.total);
assert(m.bins.length < 20); assert(m.bins.some(bin => bin.key === 'upcoming'));
assert.equal(m.yearCounts.has(9999), false);
const nearFuture = model([p('older', 2000), p('present', 2026), p('future-near', 2027)]);
for (const bin of nearFuture.bins.filter(bin => bin.start)) {
  assert.equal(context.trendsFilterPapers(nearFuture, { period: bin.key }).length, bin.count);
  assert(bin.end <= 2026);
}

// Composed filters reveal the actual source records, independent of graph state.
assert.deepEqual(ids(context.trendsFilterPapers(m, { topic: 'rna', period: 'years:2024:2026' })), ['tags', 'recent-b', 'recent-a']);
assert.deepEqual(ids(context.trendsFilterPapers(m, { topic: 'methods', period: 'years:2021:2023' })), []);
assert.deepEqual(ids(context.trendsFilterPapers(m, { topic: 'rna', period: 'undated' })), ['undated']);
assert.deepEqual(ids(context.trendsFilterPapers(m, { period: 'upcoming' })), ['future']);
assert.deepEqual(ids(context.trendsFilterPapers(m, { period: 'bad-period' })), []);

// No invented growth from an empty baseline; current-year windows are explicit.
const noBaseline = model([p('a', 2025, ['Novel']), p('b', 2024, ['Novel'])]);
assert.equal(noBaseline.latestYear, 2025);
assert.deepEqual([noBaseline.recent.start, noBaseline.recent.end], [2023, 2025]);
assert.equal(noBaseline.prior.count, 0); assert.equal(noBaseline.topics[0].shareChange, null);
const onlyUndated = model([p('a', '', ['Concept']), p('b', '', ['Concept'])]);
assert.equal(onlyUndated.recent, null); assert.equal(onlyUndated.latestYear, null);
assert.equal(onlyUndated.topics[0].count, 2); assert.equal(onlyUndated.bins[0].key, 'undated');
const onlyFuture = model([p('a', 2200, ['Concept'])]);
assert.equal(onlyFuture.recent, null); assert.equal(onlyFuture.bins.length, 1);
const empty = model([]); assert.equal(empty.total, 0); assert.equal(empty.topics.length, 0); assert.equal(empty.bins.length, 0);

// Long spans are grouped into bounded periods and keep every historical record.
const historical = model(Array.from({ length: 527 }, (_, i) => p(String(i), 1500 + i, ['History'])));
assert(historical.bins.length <= 20);
assert.equal(historical.bins.reduce((sum, bin) => sum + bin.count, 0), 527);
const bucket = historical.bins[0];
assert.equal(context.trendsFilterPapers(historical, { period: bucket.key }).length, bucket.count);

// A large library stays bounded in the DOM; sorting/filtering reuse the model.
let termReads = 0;
context.mergedKeywords = paper => { termReads++; return paper.paperKeywords || []; };
const large = Array.from({ length: 1000 }, (_, i) => ({ ...p(String(i), 2000 + i % 27, ['Shared', `Topic ${i % 40}`]), url: 'https://example.org/paper' }));
context.state.papers = large;
context.renderTrends();
assert.equal(termReads, 1000);
assert.equal((view.innerHTML.match(/data-trends-paper="/g) || []).length, 24);
assert.equal((view.innerHTML.match(/data-trends-topic="/g) || []).length, 12);
assert(view.innerHTML.includes('Show more papers')); assert(view.innerHTML.includes('Show more concepts'));
assert(view.innerHTML.includes('aria-pressed="false"')); assert(view.innerHTML.includes('current publication year is incomplete'));
assert.equal(view.scrollTop, 73);
vm.runInContext("trendsUi.topic = 'shared'; trendsUi.period = 'years:2025:2029';", context);
context.renderTrends({ refresh: false }); assert.equal(termReads, 1000);
assert(view.innerHTML.includes('Matching papers')); assert(view.innerHTML.includes('Reset filters'));

// Reopening and selection/layout changes reuse both the aggregate and DOM.
const firstModel = vm.runInContext('trendsUi.model', context);
const originalRender = view.innerHTML;
context.setTrendsVisible(false); context.setTrendsVisible(true);
assert.equal(vm.runInContext('trendsUi.model', context), firstModel);
assert.equal(termReads, 1000);
context.state.selectedId = '30'; context.state.papers[30].x = 800;
context.renderTrends();
assert.equal(vm.runInContext('trendsUi.model', context), firstModel);
assert.equal(termReads, 1000);
const oldYearCount = firstModel.yearCounts.get(2020) || 0;
context.state.papers[30].year = '2020';
context.renderTrends();
assert.equal(vm.runInContext('trendsUi.model.yearCounts.get(2020)', context), oldYearCount + 1);
assert.equal(termReads, 1001, 'Only the changed record rereads its terms');
context.state.keywords = new Map([['31', ['Fresh analysis concept']]]);
context.mergedKeywords = paper => { termReads++; return [...paper.paperKeywords, ...(context.state.keywords.get(paper.id) || [])]; };
context.state.clusters = [large.slice(0,500).map(p => p.id), large.slice(500).map(p => p.id)];
context.renderTrends();
assert.equal(termReads, 1002, 'Accepted graph keywords invalidate only the affected record');
assert.equal(vm.runInContext('trendsUi.model.groups.length', context), 2);
assert(view.innerHTML.includes('Topic groups'));
assert.equal(vm.runInContext("trendsUi.model.topicMap.has('fresh analysis concept')", context), true);

// Data removal resets stale filters, and missing dates leave useful concepts.
context.state.papers = [p('unknown', '', ['New concept'])]; context.renderTrends();
assert.equal(vm.runInContext('trendsUi.topic', context), ''); assert.equal(vm.runInContext('trendsUi.period', context), '');
assert(view.innerHTML.includes('Undated')); assert(view.innerHTML.includes('New concept'));
assert(view.innerHTML.includes('Add publication years to compare'));

// Untrusted metadata is text, and unsafe paper URLs never become links.
context.state.papers = [{ id: 'x"<', title: '<img src=x onerror=bad()>', year: '2026', paperKeywords: ['<script>'], url: 'javascript:bad()' }];
context.renderTrends();
assert(!view.innerHTML.includes('<img src=x')); assert(!view.innerHTML.includes('href="javascript:'));
assert(view.innerHTML.includes('&lt;img')); assert(view.innerHTML.includes('&lt;script&gt;'));
context.state.papers = []; context.renderTrends(); assert(view.innerHTML.includes('Your trends start with a paper'));
context.setTrendsVisible(false); assert.equal(view.hidden, true); assert.equal(classes.has('trends-active'), false);
context.setTrendsVisible(true); assert.equal(view.hidden, false); assert.equal(classes.has('trends-active'), true);
console.log('PASS: Trends publication coverage, case-insensitive per-paper concept counts, equal-window shares, empty baseline, sparse/long/future dates, composed paper filters, stale filters, safe text/URLs, and bounded 1,000-paper rendering with model reuse.');
