/**
 * Map tabs management: allows multiple independent maps (including blank maps),
 * ribbon map tab switching, and assigning library papers to specific map tabs.
 */

(function (root) {
  'use strict';

  function initMapState() {
    if (!state.maps || !Array.isArray(state.maps) || state.maps.length === 0) {
      state.maps = [{ id: 'map-1', name: 'Map 1' }];
    }
    if (!state.activeMapId || !state.maps.some(m => m.id === state.activeMapId)) {
      state.activeMapId = state.maps[0].id;
    }
  }

  function isPaperOnMap(paper, mapId) {
    if (!paper || !mapId) return false;
    if (Array.isArray(paper.mapIds)) {
      return paper.mapIds.includes(mapId);
    }
    if (paper.mapId) {
      return paper.mapId === mapId;
    }
    // Default legacy assignment for papers without mapIds:
    const firstMapId = state.maps?.[0]?.id || 'map-1';
    return mapId === firstMapId && paper.selected !== false;
  }

  function isPaperOnActiveMap(paper) {
    initMapState();
    const activeId = state.activeMapId || state.maps[0].id;
    return isPaperOnMap(paper, activeId);
  }

  function activeMapPapers() {
    initMapState();
    return (state.papers || []).filter(isPaperOnActiveMap);
  }

  function setPaperOnMap(paper, mapId, add) {
    initMapState();
    const targetMapId = mapId || state.activeMapId || (state.maps && state.maps[0] && state.maps[0].id) || 'map-1';
    if (!paper || !targetMapId) return;
    let current = Array.isArray(paper.mapIds)
      ? [...paper.mapIds]
      : paper.mapId
        ? [paper.mapId]
        : (paper.selected !== false ? [state.maps[0].id] : []);
    if (add) {
      if (!current.includes(targetMapId)) current.push(targetMapId);
    } else {
      current = current.filter(id => id !== targetMapId);
    }
    paper.mapIds = current;
    paper.selected = isPaperOnActiveMap(paper);
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  function setPaperMapTab(paperId, target) {
    initMapState();
    const paper = state.papers.find(p => p.id === paperId);
    if (!paper) return;
    if (target === 'all') {
      paper.mapIds = state.maps.map(m => m.id);
    } else if (target === 'none') {
      paper.mapIds = [];
    } else if (target) {
      paper.mapIds = [target];
    }
    paper.selected = isPaperOnActiveMap(paper);
    if (typeof render === 'function') render();
    if (typeof renderPapers === 'function') renderPapers();
    renderMapTabs();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  function mapTabOptionsMarkup(paper) {
    initMapState();
    if (!state.maps || state.maps.length <= 1) return '';
    const currentMaps = state.maps.filter(m => isPaperOnMap(paper, m.id));
    const isAll = currentMaps.length === state.maps.length && state.maps.length > 0;
    const isNone = currentMaps.length === 0;
    const options = [];
    for (const m of state.maps) {
      const isSelected = isPaperOnMap(paper, m.id) && !isAll;
      options.push(`<option value="${m.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(m.name)}</option>`);
    }
    options.push(`<option value="all" ${isAll ? 'selected' : ''}>All maps</option>`);
    options.push(`<option value="none" ${isNone ? 'selected' : ''}>Not on any map</option>`);
    return options.join('');
  }

  function createNewMapTab(customName) {
    initMapState();
    const nextNum = state.maps.length + 1;
    const newId = 'map-' + Date.now();
    const name = customName || `Map ${nextNum}`;
    state.maps.push({ id: newId, name });
    setActiveMapTab(newId);
    if (typeof showToast === 'function') {
      showToast(`Created blank map: ${name}`);
    }
    return newId;
  }

  function setActiveMapTab(mapId) {
    initMapState();
    if (!state.maps.some(m => m.id === mapId)) return;
    state.activeMapId = mapId;
    for (const paper of state.papers) {
      paper.selected = isPaperOnActiveMap(paper);
    }
    renderMapTabs();
    if (typeof render === 'function') render();
    if (typeof renderPapers === 'function') renderPapers();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  function closeMapTab(mapId) {
    initMapState();
    if (state.maps.length <= 1) {
      if (typeof showToast === 'function') showToast('Cannot close the only map tab.');
      return;
    }
    const closingMap = state.maps.find(m => m.id === mapId);
    state.maps = state.maps.filter(m => m.id !== mapId);
    for (const paper of state.papers) {
      if (Array.isArray(paper.mapIds)) {
        paper.mapIds = paper.mapIds.filter(id => id !== mapId);
      }
    }
    if (state.activeMapId === mapId) {
      state.activeMapId = state.maps[0].id;
    }
    for (const paper of state.papers) {
      paper.selected = isPaperOnActiveMap(paper);
    }
    renderMapTabs();
    if (typeof render === 'function') render();
    if (typeof renderPapers === 'function') renderPapers();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
    if (typeof showToast === 'function') {
      showToast(`Closed ${closingMap?.name || 'map tab'}`);
    }
  }

  function renameMapTab(mapId, newName) {
    initMapState();
    const targetMap = state.maps.find(m => m.id === mapId);
    if (!targetMap) return;
    const clean = String(newName || '').trim();
    if (!clean) return;
    targetMap.name = clean;
    renderMapTabs();
    if (typeof renderPapers === 'function') renderPapers();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  function renderMapTabs() {
    initMapState();
    const container = document.getElementById('ribbonMapTabsList');
    if (!container) return;

    const tabsHtml = state.maps.map(map => {
      const isActive = map.id === state.activeMapId;
      const count = state.papers.filter(p => isPaperOnMap(p, map.id)).length;
      return `
        <div class="ribbon-map-tab-item ${isActive ? 'is-active' : ''}" data-map-id="${map.id}">
          <button type="button" class="ribbon-map-tab-btn" data-action="switch-map-tab" data-map-id="${map.id}" title="${escapeHtml(map.name)} (${count} paper${count === 1 ? '' : 's'}) — double-click to rename">
            <svg class="map-tab-icon" viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M3 12h3M18 12h3"></path></svg>
            <span class="map-tab-title" data-map-title="${map.id}">${escapeHtml(map.name)}</span>
            <span class="map-tab-count">${count}</span>
          </button>
          ${state.maps.length > 1 ? `<button type="button" class="ribbon-map-tab-close" data-action="close-map-tab" data-map-id="${map.id}" title="Close ${escapeHtml(map.name)}" aria-label="Close ${escapeHtml(map.name)}">×</button>` : ''}
        </div>
      `;
    }).join('');

    container.innerHTML = tabsHtml;

    // Attach click events
    container.querySelectorAll('[data-action="switch-map-tab"]').forEach(btn => {
      btn.addEventListener('click', () => {
        setActiveMapTab(btn.dataset.mapId);
      });
      btn.addEventListener('dblclick', e => {
        e.stopPropagation();
        const mapId = btn.dataset.mapId;
        const currentMap = state.maps.find(m => m.id === mapId);
        const nameSpan = btn.querySelector('.map-tab-title');
        if (!nameSpan) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'map-tab-rename-input';
        input.value = currentMap?.name || '';
        input.style.width = Math.max(60, (input.value.length + 2) * 8) + 'px';
        const commit = () => {
          renameMapTab(mapId, input.value || currentMap.name);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', evt => {
          if (evt.key === 'Enter') { evt.preventDefault(); input.blur(); }
          if (evt.key === 'Escape') { evt.preventDefault(); renderMapTabs(); }
        });
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
      });
    });

    container.querySelectorAll('[data-action="close-map-tab"]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        closeMapTab(btn.dataset.mapId);
      });
    });

    // Update Bulk Map Tab Select in Library if present
    syncBulkMapTabSelect();
  }

  function syncBulkMapTabSelect() {
    const bulkSelect = document.getElementById('libraryBulkMapTabSelect');
    if (!bulkSelect) return;
    if (state.maps.length <= 1) {
      bulkSelect.hidden = true;
      return;
    }
    bulkSelect.hidden = false;
    const opts = ['<option value="">Add to map…</option>'];
    for (const m of state.maps) {
      opts.push(`<option value="${m.id}">To ${escapeHtml(m.name)}</option>`);
    }
    opts.push('<option value="all">To all maps</option>');
    bulkSelect.innerHTML = opts.join('');
  }

  function initMapTabs() {
    initMapState();
    const addBtn = document.getElementById('ribbonNewMapTabBtn');
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = 'true';
      addBtn.addEventListener('click', () => {
        createNewMapTab();
      });
    }

    const bulkSelect = document.getElementById('libraryBulkMapTabSelect');
    if (bulkSelect && !bulkSelect.dataset.bound) {
      bulkSelect.dataset.bound = 'true';
      bulkSelect.addEventListener('change', e => {
        const val = e.target.value;
        if (!val) return;
        bulkAddSelectedToMap(val);
        e.target.value = '';
      });
    }

    renderMapTabs();
  }

  function bulkAddSelectedToMap(targetMapId) {
    const selectedIds = state.librarySelectedIds;
    if (!selectedIds || !selectedIds.size) return;
    let count = 0;
    for (const id of selectedIds) {
      const paper = state.papers.find(p => p.id === id);
      if (!paper) continue;
      if (targetMapId === 'all') {
        paper.mapIds = state.maps.map(m => m.id);
      } else {
        setPaperOnMap(paper, targetMapId, true);
      }
      count++;
    }
    const mapName = state.maps.find(m => m.id === targetMapId)?.name || 'all maps';
    if (typeof showToast === 'function') {
      showToast(`Added ${count} paper${count === 1 ? '' : 's'} to ${mapName}`);
    }
    if (typeof render === 'function') render();
    if (typeof renderPapers === 'function') renderPapers();
    renderMapTabs();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  // Export functions to global scope
  root.isPaperOnMap = isPaperOnMap;
  root.isPaperOnActiveMap = isPaperOnActiveMap;
  root.activeMapPapers = activeMapPapers;
  root.setPaperOnMap = setPaperOnMap;
  root.setPaperMapTab = setPaperMapTab;
  root.mapTabOptionsMarkup = mapTabOptionsMarkup;
  root.createNewMapTab = createNewMapTab;
  root.setActiveMapTab = setActiveMapTab;
  root.closeMapTab = closeMapTab;
  root.renameMapTab = renameMapTab;
  root.renderMapTabs = renderMapTabs;
  root.initMapTabs = initMapTabs;
  root.bulkAddSelectedToMap = bulkAddSelectedToMap;

})(typeof window !== 'undefined' ? window : globalThis);
