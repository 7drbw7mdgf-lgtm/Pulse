/**
 * Map interactions: pan / box-select pointer modes, multi-paper selection
 * (shared with the Library table selection used for bridge seeds), and
 * dragging papers from the Library onto the map.
 *
 * Dragging uses pointer events rather than HTML5 drag-and-drop: the desktop
 * webview handles native drops itself (for PDF imports), which would swallow
 * in-page drag events.
 */
(function (root) {
  'use strict';

  const DRAG_THRESHOLD = 6;
  let boxSelect = null;
  let paperDrag = null;
  let suppressNextClick = false;

  function normalizedBox(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }

  function papersInBox(papers, box) {
    return (papers || []).filter(paper => Number.isFinite(paper.x) && Number.isFinite(paper.y)
      && paper.x >= box.x && paper.x <= box.x + box.width
      && paper.y >= box.y && paper.y <= box.y + box.height).map(paper => paper.id);
  }

  function mapPointerMode() {
    return state.mapPointerMode === 'select' ? 'select' : 'pan';
  }

  function setMapPointerMode(mode) {
    state.mapPointerMode = mode === 'select' ? 'select' : 'pan';
    const select = state.mapPointerMode === 'select';
    els.map?.classList.toggle('is-select-mode', select);
    for (const [id, active] of [['mapModePan', !select], ['mapModeSelect', select]]) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function visibleMapPapers() {
    return typeof activeMapPapers === 'function' ? activeMapPapers() : (state.papers || []).filter(paper => paper.selected !== false);
  }

  function selectionIds() {
    if (typeof state.librarySelectedIds?.has !== 'function') state.librarySelectedIds = new Set();
    return state.librarySelectedIds;
  }

  function setMultiSelection(ids, { additive = false } = {}) {
    const selected = selectionIds();
    if (!additive) selected.clear();
    ids.forEach(id => selected.add(id));
    refreshAfterSelection();
  }

  function toggleMapMultiSelection(id) {
    const selected = selectionIds();
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    refreshAfterSelection();
  }

  function clearMapMultiSelection() {
    selectionIds().clear();
    refreshAfterSelection();
  }

  function refreshAfterSelection() {
    // The Library table shows the same selection as checked rows.
    if (typeof renderPapers === 'function') renderPapers();
    renderMultiSelection();
  }

  function renderMultiSelection() {
    const selected = selectionIds();
    els.map?.querySelectorAll('.node').forEach(node => node.classList.toggle('is-multi-selected', selected.has(node.dataset.id)));
    document.querySelectorAll('.pulse-paper-card, .paper-card, .library-table-row').forEach(card => {
      card.classList.toggle('is-multi-selected', selected.has(card.dataset.paper));
    });
    renderSelectionBar();
    if (typeof PulseMapTools !== 'undefined') PulseMapTools.refresh();
  }

  function renderSelectionBar() {
    const bar = document.getElementById('mapSelectionBar');
    if (!bar) return;
    const count = selectionIds().size;
    bar.hidden = count === 0;
    const label = document.getElementById('mapSelectionCount');
    if (label) label.textContent = count === 1 ? '1 paper selected' : `${count} papers selected`;
    const bridge = document.getElementById('mapSelectionBridge');
    if (bridge) {
      bridge.disabled = count < 2 || count > 8 || Boolean(state.discoveryLoading);
      bridge.title = count < 2 ? 'Select at least two papers to find bridges between them'
        : count > 8 ? 'Select up to eight papers for one bridge search'
        : 'Search for what the selected papers share and find papers connecting them';
    }
  }

  function findBridgesForSelection() {
    const count = selectionIds().size;
    if (count < 2 || count > 8) {
      if (typeof showToast === 'function') showToast(count < 2 ? 'Select at least two papers to find bridges.' : 'Select up to eight papers for one bridge search.');
      return;
    }
    // Bridge mode makes the discovery run use the selected papers as seeds.
    state.discoveryBridgeMode = true;
    if (typeof syncDiscoveryControls === 'function') syncDiscoveryControls();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
    if (typeof runDiscoveryPipeline === 'function') runDiscoveryPipeline();
  }

  // ---- Box selection on the map ------------------------------------------

  function beginMapBoxSelection(event) {
    if (event.button !== 0) return false;
    if (mapPointerMode() !== 'select' && !event.shiftKey) return false;
    const start = svgPoint(event);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'selection-box');
    rect.setAttribute('x', start.x); rect.setAttribute('y', start.y);
    rect.setAttribute('width', 0); rect.setAttribute('height', 0);
    els.map.appendChild(rect);
    boxSelect = { pointerId: event.pointerId, start, rect, additive: event.shiftKey || event.metaKey || event.ctrlKey, moved: false };
    els.map.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return true;
  }

  function updateMapBoxSelection(event) {
    if (!boxSelect || boxSelect.pointerId !== event.pointerId) return false;
    const box = normalizedBox(boxSelect.start, svgPoint(event));
    if (box.width > 3 || box.height > 3) boxSelect.moved = true;
    boxSelect.rect.setAttribute('x', box.x); boxSelect.rect.setAttribute('y', box.y);
    boxSelect.rect.setAttribute('width', box.width); boxSelect.rect.setAttribute('height', box.height);
    return true;
  }

  function finishMapBoxSelection(event) {
    if (!boxSelect || boxSelect.pointerId !== event.pointerId) return false;
    const { start, rect, additive, moved } = boxSelect;
    boxSelect = null;
    rect.remove();
    if (event.type === 'pointercancel') return true;
    if (moved) state.suppressMapClick = true;  // The drag is not a background click.
    if (!moved) {
      // A plain click on empty canvas in select mode clears the selection.
      if (!additive) clearMapMultiSelection();
      return true;
    }
    const ids = papersInBox(visibleMapPapers(), normalizedBox(start, svgPoint(event)));
    setMultiSelection(ids, { additive });
    if (typeof showToast === 'function' && ids.length) {
      const total = selectionIds().size;
      showToast(total >= 2 ? `${total} papers selected. Use Find bridges to search what they share.` : '1 paper selected.');
    }
    return true;
  }

  // ---- Dragging papers from the Library onto the map ----------------------

  function dragSourceFor(target) {
    if (!target?.closest) return null;
    const interactive = target.closest('button, a, input, select, textarea, label, .compact-chip, [contenteditable="true"]');
    if (interactive && !interactive.classList.contains('library-title-button')) return null;
    return target.closest('.pulse-paper-card, .paper-card, .library-table-row');
  }

  function viewportUnder(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    const viewport = hit?.closest?.('.map-viewport');
    if (!viewport || !els.map || els.map.hidden || els.map.style.display === 'none') return null;
    if (state.libraryFullscreen) return null;
    return viewport;
  }

  function onLibraryPointerDown(event) {
    if (event.button !== 0 || (event.pointerType && event.pointerType === 'touch')) return;
    const source = dragSourceFor(event.target);
    if (!source?.dataset.paper) return;
    paperDrag = { id: source.dataset.paper, source, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, ghost: null, viewport: null };
  }

  function startPaperDrag(event) {
    const paper = state.papers.find(item => item.id === paperDrag.id);
    if (!paper) { paperDrag = null; return; }
    paperDrag.active = true;
    try {
      paperDrag.source.setPointerCapture?.(paperDrag.pointerId);
    } catch (_) {}
    const ghost = document.createElement('div');
    ghost.className = 'map-drag-ghost';
    const title = typeof compactTitle === 'function' ? compactTitle(paper.title) : String(paper.title || 'Paper');
    ghost.innerHTML = `${escapeHtml(title)}<small>Drop on the map to add and focus it</small>`;
    document.body.appendChild(ghost);
    paperDrag.ghost = ghost;
    paperDrag.source.classList.add('is-drag-source');
    document.body.classList.add('is-dragging-paper');
    window.getSelection?.()?.removeAllRanges?.();
  }

  function onDocumentPointerMove(event) {
    if (!paperDrag || paperDrag.pointerId !== event.pointerId) return;
    if (!paperDrag.active) {
      if (Math.hypot(event.clientX - paperDrag.startX, event.clientY - paperDrag.startY) < DRAG_THRESHOLD) return;
      startPaperDrag(event);
      if (!paperDrag) return;
    }
    event.preventDefault();
    paperDrag.ghost.style.left = event.clientX + 'px';
    paperDrag.ghost.style.top = event.clientY + 'px';
    const viewport = viewportUnder(event.clientX, event.clientY);
    if (viewport !== paperDrag.viewport) {
      paperDrag.viewport?.classList.remove('is-paper-drop-target');
      viewport?.classList.add('is-paper-drop-target');
      paperDrag.viewport = viewport;
    }
  }

  function endPaperDrag(event) {
    if (!paperDrag || paperDrag.pointerId !== event.pointerId) return;
    const drag = paperDrag;
    paperDrag = null;
    if (!drag.active) return;
    try {
      drag.source.releasePointerCapture?.(drag.pointerId);
    } catch (_) {}
    drag.ghost?.remove();
    drag.source.classList.remove('is-drag-source');
    drag.viewport?.classList.remove('is-paper-drop-target');
    document.body.classList.remove('is-dragging-paper');
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
    if (event.type !== 'pointercancel' && viewportUnder(event.clientX, event.clientY)) {
      dropPaperOnMap(drag.id, event.clientX, event.clientY);
    }
  }

  function dropPaperOnMap(paperId, clientX, clientY) {
    const paper = state.papers.find(item => item.id === paperId);
    if (!paper) return false;
    const mapId = state.activeMapId || (state.maps && state.maps[0]?.id) || 'map-1';
    const wasOnMap = typeof isPaperOnActiveMap === 'function' ? isPaperOnActiveMap(paper) : paper.selected !== false;
    if (typeof setPaperOnMap === 'function') setPaperOnMap(paper, mapId, true);
    else paper.selected = true;
    const point = svgPoint({ clientX, clientY });
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      paper.x = point.x;
      paper.y = point.y;
    }
    const area = typeof areaForPoint === 'function' ? areaForPoint(paper.x, paper.y) : null;
    if (area) paper.areaId = area.id;
    // The dropped paper becomes the map's focus (as when double-clicking a node) and its details open.
    paper.pinnedPosition = false;
    state.selectedId = paper.id;
    state.selectedLinkId = null;
    // Open the details first: the panel narrows the map, and centring must use the final size.
    if (typeof inspectPaper === 'function') inspectPaper(paper.id);
    else if (typeof renderDetails === 'function') renderDetails();
    if (typeof centerGraphOnPaper === 'function') centerGraphOnPaper(paper.id, true);
    else if (typeof render === 'function') render();
    if (typeof renderMapTabs === 'function') renderMapTabs();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
    if (typeof showToast === 'function') {
      const title = typeof compactTitle === 'function' ? compactTitle(paper.title) : paper.title;
      const mapName = (state.maps || []).find(map => map.id === mapId)?.name || 'the map';
      showToast(wasOnMap ? `Focused on "${title}".` : `Added "${title}" to ${mapName} and focused on it.`);
    }
    return true;
  }

  // ---- Clear map: untick every paper on the active map (papers stay in the Library) ----

  let clearMapUndo = null;

  function setClearMapButton(undoing) {
    const button = document.getElementById('mapClearAll');
    if (!button) return;
    button.classList.toggle('is-undo', undoing);
    button.title = undoing ? 'Undo clear map' : 'Clear map (untick all papers)';
    button.setAttribute('aria-label', undoing ? 'Undo clear map' : 'Clear map');
    const label = button.querySelector?.('.dock-btn-label');
    if (label) label.textContent = undoing ? 'Undo' : 'Clear';
  }

  function refreshAfterMapChange() {
    if (typeof render === 'function') render();
    if (typeof renderMapTabs === 'function') renderMapTabs();
    if (typeof renderDetails === 'function') renderDetails();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  function clearActiveMap() {
    const mapId = state.activeMapId || (state.maps && state.maps[0]?.id) || 'map-1';
    const onMap = (state.papers || []).filter(paper => typeof isPaperOnMap === 'function' ? isPaperOnMap(paper, mapId) : paper.selected !== false);
    if (!onMap.length) {
      if (typeof showToast === 'function') showToast('This map is already empty.');
      return 0;
    }
    const previous = onMap.map(paper => ({ paper, mapIds: Array.isArray(paper.mapIds) ? [...paper.mapIds] : undefined, mapId: paper.mapId, selected: paper.selected }));
    for (const paper of onMap) {
      if (typeof setPaperOnMap === 'function') setPaperOnMap(paper, mapId, false);
      else paper.selected = false;
    }
    if (state.selectedId && onMap.some(paper => paper.id === state.selectedId)) state.selectedId = null;
    if (onMap.some(paper => paper.id === state.centerId)) state.centerId = null;
    clearTimeout(clearMapUndo?.timer);
    clearMapUndo = { mapId, previous, timer: setTimeout(() => { clearMapUndo = null; setClearMapButton(false); }, 10000) };
    setClearMapButton(true);
    refreshAfterMapChange();
    if (typeof showToast === 'function') showToast(`Cleared ${onMap.length} paper${onMap.length === 1 ? '' : 's'} from the map. They stay in your Library.`);
    return onMap.length;
  }

  function undoClearActiveMap() {
    if (!clearMapUndo) return false;
    clearTimeout(clearMapUndo.timer);
    for (const { paper, mapIds, mapId, selected } of clearMapUndo.previous) {
      if (mapIds === undefined) delete paper.mapIds; else paper.mapIds = mapIds;
      if (mapId === undefined) delete paper.mapId; else paper.mapId = mapId;
      paper.selected = typeof isPaperOnActiveMap === 'function' ? isPaperOnActiveMap(paper) : selected;
    }
    const count = clearMapUndo.previous.length;
    clearMapUndo = null;
    setClearMapButton(false);
    refreshAfterMapChange();
    if (typeof showToast === 'function') showToast(`Restored ${count} paper${count === 1 ? '' : 's'} to the map.`);
    return true;
  }

  function onClearMapClick() {
    if (clearMapUndo) undoClearActiveMap();
    else clearActiveMap();
  }

  function onLibraryClickCapture(event) {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.stopPropagation();
    event.preventDefault();
  }

  function bindMapInteractions() {
    if (root.__pulseMapInteractionsBound) return;
    root.__pulseMapInteractionsBound = true;
    els.map?.addEventListener('click', event => {
      if (!state.suppressMapClick) return;
      state.suppressMapClick = false;
      event.stopImmediatePropagation();
    }, true);
    document.getElementById('mapModePan')?.addEventListener('click', () => setMapPointerMode('pan'));
    document.getElementById('mapModeSelect')?.addEventListener('click', () => setMapPointerMode('select'));
    document.getElementById('mapSelectionBridge')?.addEventListener('click', findBridgesForSelection);
    document.getElementById('mapSelectionClear')?.addEventListener('click', clearMapMultiSelection);
    document.getElementById('mapClearAll')?.addEventListener('click', onClearMapClick);
    els.paperList?.addEventListener('pointerdown', onLibraryPointerDown);
    els.paperList?.addEventListener('click', onLibraryClickCapture, true);
    document.addEventListener('pointermove', onDocumentPointerMove, { passive: false });
    document.addEventListener('pointerup', endPaperDrag);
    document.addEventListener('pointercancel', endPaperDrag);
    setMapPointerMode(state.mapPointerMode);
    renderMultiSelection();
  }

  Object.assign(root, {
    normalizedBox, papersInBox, mapPointerMode, setMapPointerMode, toggleMapMultiSelection,
    clearMapMultiSelection, renderMultiSelection, findBridgesForSelection, beginMapBoxSelection,
    updateMapBoxSelection, finishMapBoxSelection, dropPaperOnMap, clearActiveMap, undoClearActiveMap, bindMapInteractions
  });
})(typeof window !== 'undefined' ? window : globalThis);
