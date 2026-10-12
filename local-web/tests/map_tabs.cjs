const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const mapTabsSource = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/map-tabs.js'), 'utf8');

const elements = new Map();
const document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '',
        textContent: '',
        hidden: false,
        dataset: {},
        addEventListener: () => {},
        querySelectorAll: () => []
      });
    }
    return elements.get(id);
  },
  createElement(tag) {
    return {
      type: tag,
      className: '',
      value: '',
      style: {},
      addEventListener: () => {},
      replaceWith: () => {},
      focus: () => {},
      select: () => {}
    };
  }
};

const state = {
  maps: [{ id: 'map-1', name: 'Map 1' }],
  activeMapId: 'map-1',
  papers: [
    { id: 'p1', title: 'Paper 1', selected: true, mapIds: ['map-1'] },
    { id: 'p2', title: 'Paper 2', selected: true, mapIds: ['map-1'] },
    { id: 'p3', title: 'Paper 3', selected: false, mapIds: [] }
  ],
  links: [
    { source: 'p1', target: 'p2', score: 0.8 },
    { source: 'p2', target: 'p3', score: 0.5 }
  ],
  clusters: [['p1', 'p2']],
  librarySelectedIds: new Set(['p3'])
};

let renderCalled = 0;
let renderPapersCalled = 0;
let toastMsg = '';

const context = {
  state,
  document,
  escapeHtml: s => String(s || ''),
  showToast: msg => { toastMsg = msg; },
  render: () => { renderCalled++; },
  renderPapers: () => { renderPapersCalled++; },
  scheduleAutosave: () => {}
};

vm.createContext(context);
vm.runInContext(mapTabsSource, context);

// 1. Initial active map test
assert.equal(context.isPaperOnActiveMap(state.papers[0]), true);
assert.equal(context.isPaperOnActiveMap(state.papers[1]), true);
assert.equal(context.isPaperOnActiveMap(state.papers[2]), false);
assert.equal(context.activeMapPapers().length, 2);

// 2. Create new blank map tab
const newMapId = context.createNewMapTab('Project Blank');
assert.equal(state.maps.length, 2);
assert.equal(state.activeMapId, newMapId);
// Newly created map should start empty
assert.equal(context.activeMapPapers().length, 0);

// 3. Add paper p3 to the new blank map
context.setPaperOnMap(state.papers[2], newMapId, true);
assert.equal(context.isPaperOnActiveMap(state.papers[2]), true);
assert.equal(context.activeMapPapers().length, 1);
assert.deepEqual(state.papers[2].mapIds, [newMapId]);

// 4. Map tab options markup should generate options for all tabs
const optsHtml = context.mapTabOptionsMarkup(state.papers[2]);
assert(optsHtml.includes('Project Blank'));
assert(optsHtml.includes('Map 1'));
assert(optsHtml.includes('All maps'));

// 5. Bulk add selected papers to active map
state.librarySelectedIds = new Set(['p1', 'p2']);
context.bulkAddSelectedToMap(newMapId);
assert.equal(context.activeMapPapers().length, 3);
assert(state.papers[0].mapIds.includes(newMapId));
assert(state.papers[1].mapIds.includes(newMapId));

// 6. Switch back to Map 1
context.setActiveMapTab('map-1');
assert.equal(state.activeMapId, 'map-1');
assert.equal(context.activeMapPapers().length, 2);

// 7. Rename map tab
context.renameMapTab('map-1', 'Primary Graph');
assert.equal(state.maps[0].name, 'Primary Graph');

// 8. Close the new map tab
context.closeMapTab(newMapId);
assert.equal(state.maps.length, 1);
assert.equal(state.activeMapId, 'map-1');
// p1 and p2 should have newMapId pruned from mapIds
assert.deepEqual(state.papers[0].mapIds, ['map-1']);

console.log('PASS: map tab creation, blank maps, tab switching, and library paper tab assignment.');
