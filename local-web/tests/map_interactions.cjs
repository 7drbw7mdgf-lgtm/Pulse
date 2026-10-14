const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../pulse-frontend/js/map-interactions.js'), 'utf8');

function element(id, tagName = 'div') {
  const classes = new Set();
  const el = {
    id, tagName: tagName.toUpperCase(), hidden: false, textContent: '', disabled: false, title: '', dataset: {}, attributes: {}, style: {}, children: [], parentNode: null,
    classList: {
      toggle(name, on) { if (on === undefined ? !classes.has(name) : on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains: name => classes.has(name)
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener() {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    querySelectorAll() { return []; },
    setPointerCapture(id) { this.capturedPointer = id; },
    releasePointerCapture(id) { if (this.capturedPointer === id) this.capturedPointer = null; },
    remove() { this.removed = true; if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); } },
    closest(selector) {
      const parts = selector.split(',').map(s => s.trim());
      let cur = this;
      while (cur) {
        for (const p of parts) {
          if (p.startsWith('.') && cur.classList.contains(p.slice(1))) return cur;
          if (p.toLowerCase() === (cur.tagName || '').toLowerCase()) return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }
  };
  return el;
}

function sandbox() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const calls = { toasts: [], runs: 0, renders: 0, onMap: [] };
  const papers = [
    { id: 'a', title: 'Paper A', x: 10, y: 10 }, { id: 'b', title: 'Paper B', x: 50, y: 40 },
    { id: 'c', title: 'Paper C', x: 300, y: 300 }, { id: 'd', title: 'Paper D', x: 60, y: 20, offMap: true }
  ];
  const listeners = new Map();
  const addListener = (target, type, fn) => {
    const key = `${target}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };
  const dispatch = (target, type, event) => {
    (listeners.get(`${target}:${type}`) || []).forEach(fn => fn(event));
  };
  const mapViewport = element('mapViewport');
  mapViewport.classList.add('map-viewport');
  const context = {
    state: { papers, librarySelectedIds: new Set(), maps: [{ id: 'map-1', name: 'Map 1' }], activeMapId: 'map-1', mapPointerMode: 'pan' },
    els: { map: get('map'), paperList: get('paperList') },
    document: {
      getElementById: get, querySelectorAll: () => [], addEventListener(type, fn) { addListener('document', type, fn); },
      createElementNS: (ns, tag) => element(tag), createElement: tag => element(tag), body: element('body'),
      elementFromPoint: (x, y) => mapViewport
    },
    window: {},
    svgPoint: event => ({ x: event.clientX, y: event.clientY }),
    escapeHtml: value => String(value),
    compactTitle: value => String(value),
    activeMapPapers: () => papers.filter(paper => !paper.offMap),
    isPaperOnActiveMap: paper => !paper.offMap,
    setPaperOnMap: (paper, mapId, add) => { calls.onMap.push([paper.id, mapId, add]); paper.offMap = !add; },
    areaForPoint: () => null,
    render: () => { calls.renders += 1; }, renderDetails() {}, renderPapers() {}, scheduleAutosave() {}, syncDiscoveryControls() {},
    runDiscoveryPipeline: () => { calls.runs += 1; },
    showToast: message => calls.toasts.push(message),
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout
  };
  context.els.paperList.addEventListener = (type, fn) => addListener('paperList', type, fn);
  context.globalThis = context;
  context.window = context;  // In a page, window is the global object.
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, get, calls, papers, dispatch, mapViewport };
}

// Geometry helpers.
{
  const { context } = sandbox();
  const box = context.normalizedBox({ x: 60, y: 50 }, { x: 0, y: 0 });
  assert.deepStrictEqual({ ...box }, { x: 0, y: 0, width: 60, height: 50 });
  assert.deepStrictEqual([...context.papersInBox(context.activeMapPapers(), box)], ['a', 'b']);
}

// Pointer-mode toggle.
{
  const { context, get } = sandbox();
  context.setMapPointerMode('select');
  assert.strictEqual(context.mapPointerMode(), 'select');
  assert.strictEqual(get('mapModeSelect').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(get('mapModePan').getAttribute('aria-pressed'), 'false');
  assert.ok(get('map').classList.contains('is-select-mode'));
  context.setMapPointerMode('pan');
  assert.ok(!get('map').classList.contains('is-select-mode'));
}

// Box selection: only in select mode (or with Shift), selects papers inside the box on the active map.
{
  const { context, get } = sandbox();
  const down = { button: 0, pointerId: 1, clientX: 0, clientY: 0, shiftKey: false, preventDefault() {} };
  assert.strictEqual(context.beginMapBoxSelection(down), false, 'pan mode does not start a box');
  context.setMapPointerMode('select');
  assert.strictEqual(context.beginMapBoxSelection(down), true);
  assert.strictEqual(context.updateMapBoxSelection({ pointerId: 1, clientX: 70, clientY: 50 }), true);
  assert.strictEqual(context.finishMapBoxSelection({ type: 'pointerup', pointerId: 1, clientX: 70, clientY: 50 }), true);
  assert.deepStrictEqual([...context.state.librarySelectedIds].sort(), ['a', 'b'], 'the off-map paper D is not selected');
  assert.strictEqual(get('mapSelectionBar').hidden, false);
  assert.strictEqual(get('mapSelectionCount').textContent, '2 papers selected');
  assert.strictEqual(get('mapSelectionBridge').disabled, false);
  assert.strictEqual(context.state.suppressMapClick, true, 'the drag is not treated as a background click');
}

// Shift-box adds to the selection; a plain click in select mode clears it.
{
  const { context } = sandbox();
  context.state.librarySelectedIds.add('c');
  context.beginMapBoxSelection({ button: 0, pointerId: 2, clientX: 0, clientY: 0, shiftKey: true, preventDefault() {} });
  context.updateMapBoxSelection({ pointerId: 2, clientX: 20, clientY: 20 });
  context.finishMapBoxSelection({ type: 'pointerup', pointerId: 2, clientX: 20, clientY: 20 });
  assert.deepStrictEqual([...context.state.librarySelectedIds].sort(), ['a', 'c']);
  context.setMapPointerMode('select');
  context.beginMapBoxSelection({ button: 0, pointerId: 3, clientX: 5, clientY: 5, shiftKey: false, preventDefault() {} });
  context.finishMapBoxSelection({ type: 'pointerup', pointerId: 3, clientX: 5, clientY: 5 });
  assert.strictEqual(context.state.librarySelectedIds.size, 0);
}

// Toggling and finding bridges.
{
  const { context, get, calls } = sandbox();
  context.toggleMapMultiSelection('a');
  assert.strictEqual(get('mapSelectionBridge').disabled, true, 'one paper cannot be bridged');
  context.findBridgesForSelection();
  assert.strictEqual(calls.runs, 0);
  assert.match(calls.toasts.at(-1), /at least two/);
  context.toggleMapMultiSelection('b');
  context.findBridgesForSelection();
  assert.strictEqual(context.state.discoveryBridgeMode, true);
  assert.strictEqual(calls.runs, 1);
  context.toggleMapMultiSelection('b');
  assert.deepStrictEqual([...context.state.librarySelectedIds], ['a']);
  context.clearMapMultiSelection();
  assert.strictEqual(get('mapSelectionBar').hidden, true);
}

// Dropping a Library paper onto the map adds it to the active map at the drop point.
{
  const { context, calls, papers } = sandbox();
  const paper = papers.find(item => item.id === 'd');
  assert.strictEqual(context.dropPaperOnMap('d', 123, 456), true);
  assert.deepStrictEqual(calls.onMap.at(-1), ['d', 'map-1', true]);
  assert.strictEqual(paper.x, 123);
  assert.strictEqual(paper.y, 456);
  assert.strictEqual(paper.pinnedPosition, true);
  assert.strictEqual(context.state.selectedId, 'd');
  assert.match(calls.toasts.at(-1), /Added "Paper D" to Map 1/);
  context.dropPaperOnMap('d', 10, 10);
  assert.match(calls.toasts.at(-1), /Moved "Paper D"/);
  assert.strictEqual(context.dropPaperOnMap('missing', 0, 0), false);
}

// Interactive pointer drag-and-drop: Compact card (.pulse-paper-card)
{
  const { context, calls, papers, dispatch } = sandbox();
  context.bindMapInteractions();

  const card = element('card-d', 'article');
  card.classList.add('pulse-paper-card');
  card.dataset.paper = 'd';
  const title = element('title-d', 'div');
  title.classList.add('pulse-paper-title');
  card.appendChild(title);

  // 1. Pointer down on title inside compact card
  dispatch('paperList', 'pointerdown', { button: 0, pointerId: 10, clientX: 50, clientY: 50, target: title });

  // 2. Small move (< DRAG_THRESHOLD 6px) does not start drag
  dispatch('document', 'pointermove', { pointerId: 10, clientX: 52, clientY: 52, preventDefault() {} });
  assert.strictEqual(card.classList.contains('is-drag-source'), false);

  // 3. Move >= DRAG_THRESHOLD starts drag
  dispatch('document', 'pointermove', { pointerId: 10, clientX: 200, clientY: 300, preventDefault() {} });
  assert.strictEqual(card.classList.contains('is-drag-source'), true);
  assert.strictEqual(card.capturedPointer, 10, 'pointer capture was acquired');

  // 4. Pointer up over map drops and places the paper
  dispatch('document', 'pointerup', { type: 'pointerup', pointerId: 10, clientX: 200, clientY: 300 });
  const paper = papers.find(p => p.id === 'd');
  assert.strictEqual(paper.x, 200);
  assert.strictEqual(paper.y, 300);
  assert.strictEqual(paper.pinnedPosition, true);
  assert.strictEqual(card.classList.contains('is-drag-source'), false);
  assert.strictEqual(card.capturedPointer, null, 'pointer capture was released');
  assert.match(calls.toasts.at(-1), /Added "Paper D" to Map 1/);
}

// Interactive pointer drag-and-drop: Expanded card (.paper-card)
{
  const { context, calls, papers, dispatch } = sandbox();
  context.bindMapInteractions();

  const card = element('expanded-d', 'article');
  card.classList.add('paper-card');
  card.dataset.paper = 'd';
  const title = element('exp-title-d', 'div');
  title.classList.add('paper-title');
  card.appendChild(title);

  // Pointer down on title inside expanded card
  dispatch('paperList', 'pointerdown', { button: 0, pointerId: 11, clientX: 40, clientY: 40, target: title });
  dispatch('document', 'pointermove', { pointerId: 11, clientX: 180, clientY: 220, preventDefault() {} });
  assert.strictEqual(card.classList.contains('is-drag-source'), true, 'expanded card is recognized as drag source');

  dispatch('document', 'pointerup', { type: 'pointerup', pointerId: 11, clientX: 180, clientY: 220 });
  const paper = papers.find(p => p.id === 'd');
  assert.strictEqual(paper.x, 180);
  assert.strictEqual(paper.y, 220);
  assert.strictEqual(paper.pinnedPosition, true);
}

// Interactive pointer drag-and-drop: Table row title button (.library-title-button inside .library-table-row)
{
  const { context, calls, papers, dispatch } = sandbox();
  context.bindMapInteractions();

  const row = element('row-d', 'tr');
  row.classList.add('library-table-row');
  row.dataset.paper = 'd';
  const cell = element('cell-d', 'td');
  cell.classList.add('library-title-cell');
  const btn = element('btn-title-d', 'button');
  btn.classList.add('library-title-button');
  cell.appendChild(btn);
  row.appendChild(cell);

  dispatch('paperList', 'pointerdown', { button: 0, pointerId: 12, clientX: 30, clientY: 30, target: btn });
  dispatch('document', 'pointermove', { pointerId: 12, clientX: 250, clientY: 350, preventDefault() {} });
  assert.strictEqual(row.classList.contains('is-drag-source'), true, 'table title button is allowed to drag row');

  dispatch('document', 'pointerup', { type: 'pointerup', pointerId: 12, clientX: 250, clientY: 350 });
  const paper = papers.find(p => p.id === 'd');
  assert.strictEqual(paper.x, 250);
  assert.strictEqual(paper.y, 350);
}

// Checkboxes and form inputs inside cards do NOT start drag
{
  const { context, dispatch } = sandbox();
  context.bindMapInteractions();

  const card = element('card-chk', 'article');
  card.classList.add('paper-card');
  card.dataset.paper = 'd';
  const chk = element('chk-d', 'input');
  card.appendChild(chk);

  dispatch('paperList', 'pointerdown', { button: 0, pointerId: 13, clientX: 20, clientY: 20, target: chk });
  dispatch('document', 'pointermove', { pointerId: 13, clientX: 100, clientY: 100, preventDefault() {} });
  assert.strictEqual(card.classList.contains('is-drag-source'), false, 'input click does not start drag');
}

console.log('PASS: map pointer modes, box selection, bridge seeds and Library-to-map dropping (compact, expanded, table)');
