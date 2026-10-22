const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const part01Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/app-core.js'), 'utf8');
const part10Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/map-render.js'), 'utf8');
const part14Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/library-list.js'), 'utf8');
const inspectorSource = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/inspector.js'), 'utf8');
const part24Source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/library-bulk-actions.js'), 'utf8');

function createElement(tag = 'div') {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
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
      const matches = [];
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        let isMatch = false;
        if (sel.startsWith('[data-action="') && sel.endsWith('"]')) {
          const action = sel.slice(14, -2);
          if (node.dataset && node.dataset.action === action) isMatch = true;
        } else if (sel.startsWith('[data-field="') && sel.endsWith('"]')) {
          const field = sel.slice(13, -2);
          if (node.dataset && node.dataset.field === field) isMatch = true;
        } else if (sel === '[data-field]') {
          if (node.dataset && node.dataset.field) isMatch = true;
        } else if (sel === '[data-table-sort]') {
          if (node.dataset && node.dataset.tableSort) isMatch = true;
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

function setupTest() {
  const papers = [
    { id: 'p1', title: 'Paper 1 (Cluster A)', citationMetrics: { source: 'OpenAlex' } },
    { id: 'p2', title: 'Paper 2 (Cluster A)', citationMetrics: { source: 'OpenAlex' } },
    { id: 'p3', title: 'Paper 3 (Cluster B)', citationMetrics: { source: 'OpenAlex' } },
    { id: 'p4', title: 'Paper 4 (Area 1)', areaId: 'area-1', citationMetrics: { source: 'OpenAlex' } }
  ];

  const areas = [
    { id: 'area-1', name: 'Neurology Area', color: '#ff0055' }
  ];

  const clusters = [
    ['p1', 'p2'],
    ['p3']
  ];

  const palette = ['#0f7c74', '#d05a33', '#2f77b4', '#7a9b35'];

  const state = {
    papers,
    areas,
    clusters,
    librarySelectedIds: new Set(),
    librarySortKey: 'year',
    librarySortAsc: false,
    selectedId: null,
    paperView: 'compact',
    libraryFullscreen: false,
    filterTags: []
  };

  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, createElement(id === 'map' ? 'svg' : 'div'));
    return elements.get(id);
  };

  const toasts = [];

  const context = {
    state,
    palette,
    els: {
      paperList: get('paperList'),
      paperCount: get('paperCount'),
      railLibraryBadge: get('railLibraryBadge'),
      map: get('map'),
      emptyState: get('emptyState'),
      tableView: get('tableView')
    },
    document: {
      getElementById: get,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    escapeHtml: s => String(s || ''),
    paperMatchScore: () => null,
    mergedKeywords: () => [], displayKeywords: () => [],
    paperAuthors: () => ['Dr. Smith'],
    paperAuthorSummary: () => 'Dr. Smith',
    paperCitationCount: () => 10,
    paperDomainLabel: () => 'Medicine',
    paperStudyType: () => 'Review',
    cleanField: s => s,
    backendReady: Promise.resolve(),
    calculateRelatedness: () => {},
    showToast: msg => { toasts.push(msg); },
    inspectPaper: () => {},
    scheduleAutosave: () => {},
    renderMultiSelection: () => {},
    renderTagFilterBar: () => {},
    renderLibraryBulkActions: () => {},
    render: () => {},
    isPaperOnActiveMap: () => true,
    paperMatchesFilters: () => true
  };

  context.globalThis = context;
  context.window = context;
  vm.createContext(context);

  vm.runInContext(part10Source, context);
  vm.runInContext(inspectorSource, context);
  vm.runInContext(part14Source, context);
  vm.runInContext(part24Source, context);
  context.render = () => { context.renderPapers(); };

  return { context, state, toasts, get, papers };
}

// 1. Test paperGroupInfo identification
{
  const { context, papers } = setupTest();

  const groupP1 = context.paperGroupInfo(papers[0]);
  const groupP2 = context.paperGroupInfo(papers[1]);
  const groupP3 = context.paperGroupInfo(papers[2]);
  const groupP4 = context.paperGroupInfo(papers[3]);

  assert.strictEqual(groupP1.name, 'Group 1', 'p1 should be in Group 1');
  assert.strictEqual(groupP2.name, 'Group 1', 'p2 should be in Group 1');
  assert.strictEqual(groupP1.color, groupP2.color, 'p1 and p2 should have identical group color');
  assert.strictEqual(groupP3.name, 'Group 2', 'p3 should be in Group 2');
  assert.notStrictEqual(groupP1.color, groupP3.color, 'p1 and p3 should have different group colors');
  assert.strictEqual(groupP4.name, 'Neurology Area', 'p4 should take area name');
  assert.strictEqual(groupP4.color, '#ff0055', 'p4 should take area color');
}

// 2. Test compact card markup includes color coding
{
  const { context, get } = setupTest();
  context.state.paperView = 'compact';
  context.renderPapers();

  const html = get('paperList').innerHTML;
  assert.ok(html.includes('border-left: 3.5px solid #0f7c74'), 'Compact card must have border-left in group color');
  assert.ok(html.includes('Group 1'), 'Compact card must display group badge name');
  assert.ok(html.includes('pulse-paper-badge-group'), 'Compact card must have group badge class');
  assert.ok(html.includes('Neurology Area'), 'Compact card must display area name for area paper');
}

// 3. Test expanded card markup includes color coding and group color button
{
  const { context, get } = setupTest();
  context.state.paperView = 'expanded';
  context.renderPapers();

  const html = get('paperList').innerHTML;
  assert.ok(html.includes('border-left: 3.5px solid #0f7c74'), 'Expanded card must have border-left in group color');
  assert.ok(html.includes('paper-group-badge'), 'Expanded card must have group badge');
  assert.ok(html.includes('data-action="color-group"'), 'Expanded card must have Colour group button');
  assert.ok(html.includes('Colour group'), 'Expanded card button text must say Colour group');
}

// 4. Test table view markup includes Group column and row color coding
{
  const { context, get } = setupTest();
  context.state.libraryFullscreen = true;
  context.renderPapers();

  const html = get('paperList').innerHTML;
  assert.ok(html.includes('library-group-cell'), 'Table view must have group cell');
  assert.ok(html.includes('data-table-sort="group"'), 'Table view must allow sorting by group');
  assert.ok(html.includes('box-shadow: inset 3.5px 0 0 #0f7c74'), 'Table row must have inset group color indicator');
  assert.ok(html.includes('Neurology Area'), 'Table row must show area name');
}

// 5. Test group sorting in libraryDisplayPapers
{
  const { context, state } = setupTest();
  state.librarySortKey = 'group';
  state.librarySortAsc = true;

  const sortedAsc = context.libraryDisplayPapers();
  assert.strictEqual(sortedAsc[0].id, 'p1', 'First paper in Group 1');
  assert.strictEqual(sortedAsc[1].id, 'p2', 'Second paper in Group 1');
  assert.strictEqual(sortedAsc[2].id, 'p3', 'Paper in Group 2');
  assert.strictEqual(sortedAsc[3].id, 'p4', 'Neurology Area sorts alphabetically');

  state.librarySortAsc = false;
  const sortedDesc = context.libraryDisplayPapers();
  assert.strictEqual(sortedDesc[0].id, 'p4');
}

// 6. Test bulk color coding
{
  const { context, state, toasts } = setupTest();
  state.librarySelectedIds = new Set(['p1', 'p2']);

  context.colorLibrarySelection('#9900ff');

  assert.strictEqual(state.papers[0].color, '#9900ff', 'p1 should receive chosen color');
  assert.strictEqual(state.papers[1].color, '#9900ff', 'p2 should receive chosen color');
  assert.strictEqual(state.papers[2].color, undefined, 'p3 was not selected, should remain unchanged');
  assert.ok(toasts.some(t => t.includes('Coloured 2 selected papers')), 'Toast notification should be displayed');
}

console.log('PASS: All library group color coding tests passed successfully.');
