
    function bindTableHeaders() {
      els.tableView.querySelectorAll('[data-action="sort-table"]').forEach(button => {
        button.addEventListener('click', () => {
          const key = button.dataset.column;
          state.tableSort = {
            key,
            direction: state.tableSort.key === key && state.tableSort.direction === 'asc' ? 'desc' : 'asc'
          };
          renderTableView();
        });
      });
      els.tableView.querySelectorAll('th[data-column]').forEach(header => {
        header.addEventListener('dragstart', event => {
          event.dataTransfer.setData('text/plain', header.dataset.column);
          event.dataTransfer.effectAllowed = 'move';
        });
        header.addEventListener('dragover', event => {
          event.preventDefault();
          header.classList.add('is-drag-over');
        });
        header.addEventListener('dragleave', () => header.classList.remove('is-drag-over'));
        header.addEventListener('drop', event => {
          event.preventDefault();
          header.classList.remove('is-drag-over');
          moveTableColumn(event.dataTransfer.getData('text/plain'), header.dataset.column);
        });
      });
    }

    function moveTableColumn(sourceKey, targetKey) {
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const columns = [...state.tableColumns];
      const from = columns.indexOf(sourceKey);
      const to = columns.indexOf(targetKey);
      if (from < 0 || to < 0) return;
      const [moved] = columns.splice(from, 1);
      columns.splice(to, 0, moved);
      state.tableColumns = columns;
      renderTableView();
    }

    function updateViewSize(width, height) {
      state.view.width = width;
      state.view.height = height;
    }

    function panCanvas(direction) {
      const stepX = state.view.width * 0.16;
      const stepY = state.view.height * 0.16;
      if (direction === 'left') state.view.x -= stepX;
      if (direction === 'right') state.view.x += stepX;
      if (direction === 'up') state.view.y -= stepY;
      if (direction === 'down') state.view.y += stepY;
      if (direction === 'reset') {
        state.view.x = 0;
        state.view.y = 0;
      }
      if (direction === 'fit') fitCanvasToMap();
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
    }

    function fitCanvasToMap() {
      if (!state.papers.length) {
        state.view.x = 0;
        state.view.y = 0;
        return;
      }
      const xs = state.papers.map(paper => paper.x || 0);
      const ys = state.papers.map(paper => paper.y || 0);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const mapCenterX = (minX + maxX) / 2;
      const mapCenterY = (minY + maxY) / 2;
      state.view.x = mapCenterX - state.view.width / 2;
      state.view.y = mapCenterY - state.view.height / 2;
    }

    function linkId(link) {
      return [link.source, link.target].sort().join('__');
    }

    function selectedLinkEndpoints() {
      const link = state.links.find(item => linkId(item) === state.selectedLinkId);
      return new Set(link ? [link.source, link.target] : []);
    }

    function compactTitle(title) {
      const words = title.replace(/\s+/g, ' ').trim();
      return words.length > 34 ? `${words.slice(0, 31)}...` : words;
    }

    function formatSmartLabel(paper, mode) {
      if (mode === 'none') return { lines: [] };
      if (mode === 'keywords') {
        const kws = mergedKeywords(paper).slice(0, 2);
        if (kws.length) return { lines: [kws.join(' / ').slice(0, 24)] };
      }
      if (mode === 'full') {
        const title = String(paper.title || 'Untitled').replace(/\s+/g, ' ').trim();
        if (title.length <= 24) return { lines: [title] };
        const words = title.split(' ');
        let l1 = '', l2 = '';
        let onFirst = true;
        for (const w of words) {
          if (onFirst) {
            const cand = l1 ? l1 + ' ' + w : w;
            if (cand.length <= 22) {
              l1 = cand;
            } else {
              onFirst = false;
              l2 = w;
            }
          } else {
            const cand = l2 ? l2 + ' ' + w : w;
            if (cand.length <= 22) {
              l2 = cand;
            } else {
              l2 += '...';
              break;
            }
          }
        }
        return { lines: l2 ? [l1, l2] : [l1 || title.slice(0, 22) + '...'] };
      }
      // 'short' mode: Standard academic citation label: Author et al. (Year)
      const authors = paperAuthors(paper);
      const year = paper.year || (paper.date && String(paper.date).match(/\b(19|20)\d{2}\b/) ? String(paper.date).match(/\b(19|20)\d{2}\b/)[0] : '');
      const yStr = year ? `(${year})` : '';
      if (authors.length > 0) {
        let authorStr = '';
        if (authors.length === 1) {
          authorStr = extractLastName(authors[0]) || 'Author';
        } else if (authors.length === 2) {
          const l1 = extractLastName(authors[0]) || 'Author';
          const l2 = extractLastName(authors[1]) || 'Author';
          authorStr = `${l1} & ${l2}`;
        } else {
          const l1 = extractLastName(authors[0]) || 'Author';
          authorStr = `${l1} et al.`;
        }
        const fullCitation = yStr ? `${authorStr} ${yStr}` : authorStr;
        if (fullCitation.length <= 24) {
          return { lines: [fullCitation] };
        }
        if (yStr) {
          const line1 = authorStr.length <= 24 ? authorStr : (authorStr.slice(0, 21) + '...');
          return { lines: [line1, yStr] };
        }
        return { lines: [authorStr.length <= 24 ? authorStr : (authorStr.slice(0, 21) + '...')] };
      }
      const t = String(paper.title || 'Untitled').replace(/\s+/g, ' ').trim();
      return { lines: [t.length > 22 ? t.slice(0, 19) + '...' : t] };
    }

    function graphLabel(paper) {
      const data = formatSmartLabel(paper, state.graphStyle.labelMode || 'short');
      return data.lines.join(' ');
    }

    function syncGraphControls() {
      const style = state.graphStyle;
      els.nodeSizeInput.value = Math.round(style.nodeSize || 22);
      els.nodeSizeValue.textContent = Math.round(style.nodeSize || 22);
      els.edgeScaleInput.value = Math.round((style.edgeScale || 1) * 100);
      els.edgeScaleValue.textContent = `${Math.round((style.edgeScale || 1) * 100)}%`;
      els.spacingInput.value = Math.round((style.spacing || 1) * 100);
      els.spacingValue.textContent = `${Math.round((style.spacing || 1) * 100)}%`;
      els.labelModeInput.value = style.labelMode || 'short';
      els.gridToggleInput.checked = style.showGrid !== false;
      els.areasToggleInput.checked = style.showAreas !== false;
    }

    function updateGraphStyle(updates) {
      state.graphStyle = { ...state.graphStyle, ...updates };
      syncGraphControls();
      render();
    }

    function resetGraphStyle() {
      state.graphStyle = {
        nodeSize: 22,
        edgeScale: 0.65,
        spacing: 1,
        labelMode: 'short',
        showGrid: true,
        showAreas: true
      };
      syncGraphControls();
      render();
      showToast('Graph style reset.');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function safeHref(url) {
      if (!url) return '';
      const s = String(url).trim();
      return /^(?:https?:\/\/|\/|#|mailto:)/i.test(s) ? s : '';
    }

    function bindNodeEvents() {
      els.map.querySelectorAll('.node').forEach(node => {
        const id = node.dataset.id;

        node.addEventListener('dblclick', event => {
          event.stopPropagation();
          centerGraphOnPaper(id, true);
        });

        node.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const paper = state.papers.find(item => item.id === id);
          if (!paper) return;
          node.parentNode.appendChild(node);
          node.classList.add('is-dragging');
          const point = svgPoint(event);
          state.drag = {
            id,
            offsetX: point.x - paper.x,
            offsetY: point.y - paper.y,
            startX: point.x,
            startY: point.y,
            moved: false
          };
          node.setPointerCapture(event.pointerId);
          els.map.classList.add('is-panning');
          state.selectedId = id;
          state.selectedLinkId = null;
          renderDetails();
          renderSelection();
        });

        node.addEventListener('pointermove', event => {
          if (!state.drag || state.drag.id !== id) return;
          const paper = state.papers.find(item => item.id === state.drag.id);
          if (!paper) return;
          const point = svgPoint(event);
          if (!state.drag.moved && Math.hypot(point.x - state.drag.startX, point.y - state.drag.startY) > 4) {
            state.drag.moved = true;
          }
          if (state.drag.moved) {
            paper.x = point.x - state.drag.offsetX;
            paper.y = point.y - state.drag.offsetY;
            node.setAttribute('transform', `translate(${paper.x.toFixed(1)},${paper.y.toFixed(1)})`);
            renderEdgesOnly();
          }
        });

        node.addEventListener('pointerup', () => {
          if (state.drag && state.drag.id === id) {
            const paper = state.papers.find(item => item.id === state.drag.id);
            const wasDragged = state.drag.moved;
            state.drag = null;
            node.classList.remove('is-dragging');
            els.map.classList.remove('is-panning');

            if (wasDragged) {
              const area = paper ? areaForPoint(paper.x, paper.y) : null;
              if (paper) {
                paper.areaId = area?.id || paper.areaId || '';
                paper.pinnedPosition = true;
              }
              if (area) showToast(`Placed "${compactTitle(paper.title)}" in ${area.name}.`);
              render();
            } else {
              // Rapid tap / click double-click detection
              const now = Date.now();
              if (lastNodeClickTime && (now - lastNodeClickTime < 380) && lastNodeClickId === id) {
                lastNodeClickTime = 0;
                lastNodeClickId = null;
                centerGraphOnPaper(id, true);
              } else {
                lastNodeClickTime = now;
                lastNodeClickId = id;
              }
            }
          }
        });

        node.addEventListener('pointercancel', () => {
          state.drag = null;
          node.classList.remove('is-dragging');
          els.map.classList.remove('is-panning');
        });
      });
    }
