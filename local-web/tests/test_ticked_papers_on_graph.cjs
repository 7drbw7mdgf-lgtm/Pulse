const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

// Load relevant frontend scripts
const mapTabsSource = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/map-tabs.js'), 'utf8');
const part09Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/part_09.js'), 'utf8');
const part10Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/part_10.js'), 'utf8');
const part14Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/part_14.js'), 'utf8');
const part18Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/part_18.js'), 'utf8');

function createElement(tag = 'div') {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c)
    },
    setAttribute(name, val) { this.attributes[name] = String(val); },
    getAttribute(name) { return this.attributes[name]; },
    getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach(fn => fn(event));
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel) {
      // Basic selector search for test harness
      const matches = [];
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        let isMatch = false;
        if (sel === 'h2' && node.tagName === 'H2') isMatch = true;
        else if (sel === '.empty-hint' && node.classList && node.classList.contains('empty-hint')) isMatch = true;
        else if (sel.startsWith('[data-action="') && sel.endsWith('"]')) {
          const action = sel.slice(14, -2);
          if (node.dataset && node.dataset.action === action) isMatch = true;
        } else if (sel.includes('.pulse-paper-card') || sel.includes('.paper-card') || sel.includes('.library-table-row')) {
          if (node.classList && (node.classList.contains('pulse-paper-card') || node.classList.contains('paper-card') || node.classList.contains('library-table-row'))) isMatch = true;
        }
        if (isMatch) matches.push(node);
        (node.children || []).forEach(walk);
      }
      walk(this);
      return matches;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === '[data-paper]' && cur.dataset && cur.dataset.paper) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
  };
  return el;
}

function setupTestEnvironment() {
  const mapEl = createElement('svg');
  const emptyStateEl = createElement('div');
  const emptyTitle = createElement('h2');
  const emptyHint = createElement('div');
  emptyHint.classList.add('empty-hint');
  emptyStateEl.appendChild(emptyTitle);
  emptyStateEl.appendChild(emptyHint);

  const paperListEl = createElement('div');
  const paperCountEl = createElement('span');
  const metricPapersEl = createElement('span');
  const metricLinksEl = createElement('span');
  const metricClustersEl = createElement('span');

  const state = {
    maps: [{ id: 'map-1', name: 'Map 1' }],
    activeMapId: 'map-1',
    papers: [
      { id: 'p1', title: 'Paper One', selected: true, mapIds: ['map-1'], citationMetrics: { source: 'OpenAlex' } },
      { id: 'p2', title: 'Paper Two', selected: true, mapIds: ['map-1'], citationMetrics: { source: 'OpenAlex' } },
      { id: 'p3', title: 'Paper Three', selected: false, mapIds: [], citationMetrics: { source: 'OpenAlex' } }
    ],
    links: [
      { source: 'p1', target: 'p2', score: 0.85, type: 'similarity' },
      { source: 'p2', target: 'p3', score: 0.70, type: 'citation' }
    ],
    areas: [],
    clusters: [['p1', 'p2', 'p3']],
    librarySelectedIds: new Set(),
    graphStyle: { spacing: 1, nodeSize: 22, showGrid: true, edgeScale: 0.65 },
    view: { x: 0, y: 0, width: 800, height: 600 },
    mode: 'free',
    centerId: null,
    selectedId: null,
    selectedLinkId: null,
    paperView: 'expanded',
    tableFilters: {},
    tableSort: { key: 'paper', direction: 'asc' },
    tableColumns: ['paper', 'authors', 'year', 'venue', 'keywords', 'findings', 'links'],
    filterTags: []
  };

  const palette = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b'];

  const context = {
    state,
    palette,
    els: {
      map: mapEl,
      emptyState: emptyStateEl,
      paperList: paperListEl,
      paperCount: paperCountEl,
      metricPapers: metricPapersEl,
      metricLinks: metricLinksEl,
      metricClusters: metricClustersEl,
      tableView: createElement('div'),
      canvasTitle: createElement('div')
    },
    document: {
      getElementById(id) {
        if (id === 'emptyState') return emptyStateEl;
        if (id === 'paperList') return paperListEl;
        return createElement('div');
      },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    escapeHtml: s => String(s || ''),
    paperMatchScore: () => 88,
    mergedKeywords: () => ['test'], displayKeywords: () => ['test'],
    paperAuthors: () => ['Alice', 'Bob'],
    paperAuthorSummary: () => 'Alice et al.',
    paperCitationCount: () => 42,
    paperDomainLabel: () => 'Biology',
    paperStudyType: () => 'Article',
    keyFindings: () => [],
    cleanField: s => s,
    showToast: () => {},
    inspectPaper: () => {},
    scheduleAutosave: () => {},
    calculateRelatedness: () => {},
    selectedLinkEndpoints: () => new Set(),
    paperMatchesFilters: () => true,
    linkId: link => `${link.source}-${link.target}`,
    linkLabel: () => 'Link',
    formatSmartLabel: paper => ({ lines: [paper.title] }),
    bindAreaEvents: () => {},
    bindEdgeEvents: () => {},
    bindNodeEvents: () => {},
    bindTableFilters: () => {},
    bindTableHeaders: () => {},
    renderTagFilterBar: () => {},
    renderLibraryBulkActions: () => {},
    renderDetails: () => {},
    renderLinkages: () => {},
    renderAreasPanel: () => {},
    filteredTablePapers: () => state.papers,
    activeTableColumns: () => [],
    libraryDisplayPapers: () => state.papers,
    bottomDockSpace: () => 60,
    updateViewSize: (w, h) => { state.view.width = w; state.view.height = h; }
  };

  context.globalThis = context;
  context.window = context;
  vm.createContext(context);

  vm.runInContext(mapTabsSource, context);
  vm.runInContext(part09Source, context);
  vm.runInContext(part10Source, context);
  vm.runInContext(part14Source, context);
  // Extract updateMetrics from part_18
  const updateMetricsCode = part18Source.slice(part18Source.indexOf('function updateMetrics()'), part18Source.indexOf('els.paperCount.textContent = `${state.papers.length} loaded`;'));
  vm.runInContext(`
    ${updateMetricsCode}
      els.paperCount.textContent = \`\${state.papers.length} loaded\`;
      els.metricPapers.textContent = activePapers.length;
      els.metricLinks.textContent = activeLinks.length;
    }
  `, context);

  return { context, state, mapEl, emptyStateEl };
}

// TEST 1: activeMapPapers & initial rendering of ticked papers
{
  const { context, state, mapEl, emptyStateEl } = setupTestEnvironment();

  assert.strictEqual(context.activeMapPapers().length, 2, 'Initial active papers on Map 1 should be p1 and p2');
  assert.strictEqual(context.isPaperOnActiveMap(state.papers[0]), true);
  assert.strictEqual(context.isPaperOnActiveMap(state.papers[1]), true);
  assert.strictEqual(context.isPaperOnActiveMap(state.papers[2]), false);

  context.render();

  // Check SVG output has nodes for p1 and p2, but not p3
  assert.ok(mapEl.innerHTML.includes('data-id="p1"'), 'Graph must display paper p1');
  assert.ok(mapEl.innerHTML.includes('data-id="p2"'), 'Graph must display paper p2');
  assert.ok(!mapEl.innerHTML.includes('data-id="p3"'), 'Graph must not display unticked paper p3');
  assert.strictEqual(emptyStateEl.style.display, 'none', 'Empty state should be hidden when papers are on map');
  assert.strictEqual(context.els.metricPapers.textContent, 2);
}

// TEST 2: Ticking paper p3 adds it immediately to the graph with valid coordinates
{
  const { context, state, mapEl } = setupTestEnvironment();

  // p3 starts with no coordinates (undefined)
  assert.strictEqual(state.papers[2].x, undefined);
  assert.strictEqual(state.papers[2].y, undefined);

  // Tick paper p3
  context.setPaperOnMap(state.papers[2], state.activeMapId, true);
  assert.strictEqual(context.isPaperOnActiveMap(state.papers[2]), true);
  assert.strictEqual(context.activeMapPapers().length, 3);

  // Render after ticking
  context.render();

  // All 3 papers must be in graph SVG
  assert.ok(mapEl.innerHTML.includes('data-id="p1"'));
  assert.ok(mapEl.innerHTML.includes('data-id="p2"'));
  assert.ok(mapEl.innerHTML.includes('data-id="p3"'), 'Paper p3 must now be displayed on the graph');

  // Verify coordinates are finite and not NaN
  assert.ok(Number.isFinite(state.papers[2].x), 'p3 x coordinate must be finite');
  assert.ok(Number.isFinite(state.papers[2].y), 'p3 y coordinate must be finite');
  assert.ok(!mapEl.innerHTML.includes('NaN'), 'Graph SVG must not contain NaN coordinates');
  assert.strictEqual(context.els.metricPapers.textContent, 3);
}

// TEST 3: Unticking papers removes them; unticking all shows empty state
{
  const { context, state, mapEl, emptyStateEl } = setupTestEnvironment();

  // Untick p1, p2, p3
  context.setPaperOnMap(state.papers[0], state.activeMapId, false);
  context.setPaperOnMap(state.papers[1], state.activeMapId, false);
  context.setPaperOnMap(state.papers[2], state.activeMapId, false);

  assert.strictEqual(context.activeMapPapers().length, 0);
  context.render();

  assert.strictEqual(emptyStateEl.style.display, 'grid', 'Empty state should be displayed when all papers are unticked');
  assert.ok(!mapEl.innerHTML.includes('data-id="p1"'));
  assert.ok(!mapEl.innerHTML.includes('data-id="p2"'));
  assert.ok(!mapEl.innerHTML.includes('data-id="p3"'));

  // Now re-tick just p3
  context.setPaperOnMap(state.papers[2], state.activeMapId, true);
  context.render();

  assert.strictEqual(emptyStateEl.style.display, 'none', 'Empty state should hide once p3 is ticked');
  assert.ok(mapEl.innerHTML.includes('data-id="p3"'), 'p3 must be displayed on the graph');
  assert.strictEqual(context.els.metricPapers.textContent, 1);
}

// TEST 4: Clusters mode and Centered mode do NOT crash or fail when some papers are unticked
{
  const { context, state, mapEl } = setupTestEnvironment();

  // Clusters mode with p3 unticked (p3 is in state.clusters[0])
  state.mode = 'clusters';
  context.render();
  assert.ok(mapEl.innerHTML.includes('data-id="p1"'));
  assert.ok(mapEl.innerHTML.includes('data-id="p2"'));
  assert.ok(!mapEl.innerHTML.includes('data-id="p3"'));

  // Centered mode with centerId pointing to unticked p3
  state.mode = 'free';
  state.centerId = 'p3';
  context.render();
  // Should handle gracefully: clear centerId or fallback, without throwing
  assert.ok(mapEl.innerHTML.includes('data-id="p1"'));
  assert.ok(mapEl.innerHTML.includes('data-id="p2"'));
  assert.strictEqual(state.centerId, null, 'Off-map centerId should be cleared gracefully');
}

// TEST 5: Expanded cards render the map checkbox in paperHeaderMarkup
{
  const { context, state } = setupTestEnvironment();

  // In expanded view, renderPapers() creates cards using paperHeaderMarkup
  context.renderPapers();
  const listHtml = context.els.paperList.innerHTML;

  // Verify the toggle-paper-active checkbox is in paperHeaderMarkup
  assert.ok(listHtml.includes('data-action="toggle-paper-active"'), 'Expanded card must include toggle-paper-active checkbox');
  assert.ok(listHtml.includes('class="paper-chk"'), 'Card must include paper-chk styling class');
}

console.log('PASS: All ticked paper graph display tests passed successfully.');
