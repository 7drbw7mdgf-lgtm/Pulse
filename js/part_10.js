        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startAreas = state.areas.map(a => ({ id: a.id, x: a.x, y: a.y, width: a.width, height: a.height }));
      const startTime = performance.now();
      const duration = 280;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        state.areas.forEach(a => {
          const orig = startAreas.find(sa => sa.id === a.id);
          if (orig) {
            a.x = cx + (orig.x - cx) * currentFactor;
            a.y = cy + (orig.y - cy) * currentFactor;
            a.width = orig.width * Math.sqrt(currentFactor);
            a.height = orig.height * Math.sqrt(currentFactor);
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map blown up (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function compressMap(factor = 0.75) {
      if (!state.papers.length) return;
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.max(0.35, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Minimum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startTime = performance.now();
      const duration = 240;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map condensed (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function areaForPoint(x, y) {
      return [...state.areas].reverse().find(area => pointInArea(x, y, area));
    }

    function pointInArea(x, y, area) {
      return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
    }

    function resizeArea(area, field, value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      area[field] = Math.max(field === 'width' ? 160 : 110, Math.min(1200, next));
      applyAreaContainment();
    }

    function setAreaSize(area, width, height) {
      area.width = Math.max(160, Math.min(1200, width));
      area.height = Math.max(110, Math.min(1200, height));
      applyAreaContainment();
    }

    function createArea() {
      const index = state.areas.length;
      const width = Math.max(230, state.view.width * 0.28);
      const height = Math.max(150, state.view.height * 0.24);
      const area = {
        id: uid(),
        name: `Area ${index + 1}`,
        color: palette[index % palette.length],
        x: state.view.x + 92 + index * 34,
        y: state.view.y + 96 + index * 28,
        width,
        height
      };
      state.areas.push(area);
      state.selectedAreaId = area.id;
      setAreaPanelOpen(true);
      render();
      showToast(`Created ${area.name}.`);
    }

    function removeArea(id) {
      const area = state.areas.find(item => item.id === id);
      state.areas = state.areas.filter(item => item.id !== id);
      state.papers.forEach(paper => {
        if (paper.areaId === id) paper.areaId = '';
      });
      if (state.selectedAreaId === id) state.selectedAreaId = null;
      render();
      showToast(`${area?.name || 'Area'} removed.`);
    }

    function paperColor(paper, clusterByPaper) {
      if (paper.color) return paper.color;
      const area = state.areas.find(item => item.id === paper.areaId);
      if (area?.color) return area.color;
      return palette[(clusterByPaper.get(paper.id) || 0) % palette.length];
    }

    function render() {
      calculateRelatedness();
      syncWorkspaceControls();
      if (state.selectedLinkId && !state.links.some(link => linkId(link) === state.selectedLinkId)) {
        state.selectedLinkId = null;
      }
      const isTableMode = state.mode === 'table';
      const isTimelineMode = state.workspaceView === 'timeline';
      els.timelineView.hidden = !isTimelineMode;
      if (isTimelineMode) renderTimeline();
      els.map.hidden = isTableMode || isTimelineMode;
      els.map.style.display = isTableMode || isTimelineMode ? 'none' : '';
      els.tableView.hidden = !isTableMode;
      const titleHeading = (els.canvasTitle || document.querySelector('.canvas-title'))?.querySelector('h1');
      if (titleHeading) {
        titleHeading.textContent = isTableMode ? 'Bibliography' : (state.mode === 'radial' ? 'Radial hierarchy' : (state.mode === 'clusters' ? 'Topic clusters' : 'Relatedness graph'));
      }
      if (isTableMode) {
        renderTableView();
      }
      if (state.workspaceView !== 'network') {
        renderTagFilterBar(); if(state.workspaceView==='library')renderTableView();
        renderPapers();renderDetails();updateMetrics();scheduleAutosave();return;
      }
      const rect = els.map.getBoundingClientRect();
      const width = Math.max(rect.width, 640);
      const height = Math.max(rect.height, 520);
      const safeHeight = Math.max(360, height - bottomDockSpace());
      updateViewSize(width, height);
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
      els.map.classList.toggle('no-grid', !state.graphStyle.showGrid);
      if (state.workspaceView === 'network') {
        layout(width, safeHeight);
        applyAreaContainment();
      }

      const paintKey=JSON.stringify([graphRevision,state.linkTypeFilter,state.librarySearch,state.filterTags,state.filterMode,state.graphStyle,state.areas,bouncingNodeId,state.papers.map(p=>[p.id,p.title,p.authors,p.year,p.journal,p.x,p.y,p.color,p.areaId,p.gemmaKeywords])]);
      if(paintKey===graphMarkupKey) {
        renderDetails();renderSelection();syncWorkspaceControls();updateMetrics();scheduleAutosave();return;
      }
      graphMarkupKey=paintKey;graphStats.paints++;
      const clusterByPaper = new Map();
      state.clusters.forEach((cluster, index) => cluster.forEach(id => clusterByPaper.set(id, index)));

      const areaMarkup = state.graphStyle.showAreas ? state.areas.map(area => {
        const selected = state.selectedAreaId === area.id ? ' is-selected' : '';
        return `<g class="area-region${selected}" data-area="${area.id}">
          <rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" rx="18" fill="${area.color}" stroke="${area.color}"></rect>
          <text x="${area.x + 16}" y="${area.y + 28}">${escapeHtml(area.name)}</text>
          <rect class="area-resize-handle" x="${area.x + area.width - 15}" y="${area.y + area.height - 15}" width="22" height="22" rx="7"></rect>
        </g>`;
      }).join('') : '';

      const hasFilter = Boolean(state.librarySearch || (state.filterTags && state.filterTags.length > 0));
      const availableLinks = visibleLinks();
      const sortedLinks = availableLinks.length > 2500 ? availableLinks.slice().sort((a,b)=>b.score-a.score).slice(0,2500).sort((a,b)=>a.score-b.score) : availableLinks.sort((a,b)=>a.score-b.score);
      const linkMarkup = sortedLinks.map(link => {
        const source = papersById.get(link.source);
        const target = papersById.get(link.target);
        const sourceMatches = !hasFilter || (source && paperMatchesFilters(source));
        const targetMatches = !hasFilter || (target && paperMatchesFilters(target));
        const filterDimmed = hasFilter && (!sourceMatches || !targetMatches) ? ' is-filter-dimmed' : '';
        const opacity = Math.min(0.72, 0.18 + link.score * 0.48);
        const width = (0.55 + link.score * 3.15) * (state.graphStyle.edgeScale || 0.65);
        const id = linkId(link);
        const selected = state.selectedLinkId === id ? ' is-selected' : '';
        const label = linkLabel(link);
        return `<line class="edge${selected}${filterDimmed}" data-type="${escapeHtml(link.type || 'similarity')}" data-link="${id}" data-source="${link.source}" data-target="${link.target}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke-width="${selected ? (width + 2.4).toFixed(2) : width.toFixed(2)}" opacity="${selected ? '1' : opacity.toFixed(2)}"><title>${escapeHtml(label)}</title></line>
          <line class="edge-hit" data-link="${id}" data-source="${link.source}" data-target="${link.target}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke-width="20" stroke="transparent" stroke-linecap="round"><title>${escapeHtml(label)}</title></line>`;
      }).join('');

      const nodeMarkup = state.papers.map((paper, idx) => {
        const color = paperColor(paper, clusterByPaper);
        const radius = state.graphStyle.nodeSize || 22;
        const linked = selectedLinkEndpoints().has(paper.id) ? ' is-linked' : '';
        const selected = state.selectedId === paper.id ? ' is-selected' : '';
        const centered = state.centerId === paper.id ? ' is-centered' : '';
        const matchesFilter = !hasFilter || paperMatchesFilters(paper);
        const filterClass = hasFilter ? (matchesFilter ? ' is-filter-match' : ' is-filter-dimmed') : '';

        // Check neighboring nodes within proximity to avoid label collisions
        let labelPos = 'bottom';
        let neighborBelow = false;
        let neighborAbove = false;
        for (let j = 0; state.papers.length <= 100 && j < state.papers.length; j++) {
          if (j === idx) continue;
          const other = state.papers[j];
          const dist = Math.hypot(paper.x - other.x, paper.y - other.y);
          if (dist < radius * 2.6 + 36) {
            if (other.y > paper.y) neighborBelow = true;
            if (other.y < paper.y) neighborAbove = true;
          }
        }
        if (neighborBelow && !neighborAbove) {
          labelPos = 'top';
        }

        const labelData = formatSmartLabel(paper, state.graphStyle.labelMode || 'short');
        let labelSvg = '';
        if (labelData.lines && labelData.lines.length > 0) {
          const fontSize = Math.max(10, Math.min(13, radius * 0.52));
          const lineHeight = fontSize + 3;
          const startY = labelPos === 'top'
            ? -(radius + 8 + (labelData.lines.length - 1) * lineHeight)
            : (radius + 15);

          const tspans = labelData.lines.map((line, lIdx) =>
            `<tspan x="0" y="${(startY + lIdx * lineHeight).toFixed(1)}">${escapeHtml(line)}</tspan>`
          ).join('');

          labelSvg = `<text class="node-label pos-${labelPos}" text-anchor="middle" font-size="${fontSize}">${tspans}</text>`;
        }

        const isBouncing = bouncingNodeId === paper.id;
        const bouncingClass = isBouncing ? ' is-bouncing' : '';
        const rippleSvg = isBouncing ? `
          <circle class="bounce-ripple" r="${radius}" fill="none" stroke="${color}" stroke-width="3.5"></circle>
          <circle class="bounce-ripple bounce-ripple-2" r="${radius}" fill="none" stroke="var(--accent)" stroke-width="2.5"></circle>
        ` : '';

        return `<g class="node${selected}${linked}${centered}${filterClass}${bouncingClass}" data-id="${paper.id}" transform="translate(${paper.x.toFixed(1)},${paper.y.toFixed(1)})">
          ${rippleSvg}
          <circle class="node-main-circle" r="${radius}" fill="${color}"></circle>
          ${labelSvg}
          <title>${escapeHtml(paper.title || '')}</title>
        </g>`;
      }).join('');

      els.map.innerHTML = `<g>${areaMarkup}</g><g>${linkMarkup}</g><g>${nodeMarkup}</g>`;
      paintedSelectedLinkId=state.selectedLinkId;edgeElementsById=new Map();
      els.map.querySelectorAll('.edge').forEach(edge=>{const id=edge.dataset.link;if(!edgeElementsById.has(id))edgeElementsById.set(id,[]);edgeElementsById.get(id).push(edge);});
      bindAreaEvents();
      bindEdgeEvents();
      bindNodeEvents();
      renderTagFilterBar();
      renderPapers();
      renderDetails();
      if(!els.linkagePanel.hidden)renderLinkages();
      if(!els.areaPanel.hidden)renderAreasPanel();
      updateMetrics();
      scheduleAutosave();
    }

    function renderTableView(focusColumn = '') {
      if (!els.tableView) return;
      if (!state.papers.length) {
        els.tableView.innerHTML = '<div class="table-empty">Drop papers to build an extracted Bibliography table.</div>';
        return;
      }
      const rows = filteredTablePapers();
      const columns = activeTableColumns();
      const isCompact = state.paperView === 'compact';
      els.tableView.innerHTML = `
        <table class="findings-table${isCompact ? ' is-compact' : ''}" aria-label="Extracted Bibliography findings">
          <thead>
            <tr>
              ${columns.map(column => `
                <th draggable="true" data-column="${column.key}">
                  <div class="table-heading">
                    <button type="button" data-action="sort-table" data-column="${column.key}">
                      ${escapeHtml(column.label)}${state.tableSort.key === column.key ? (state.tableSort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                    <input data-table-filter="${column.key}" value="${escapeHtml(state.tableFilters[column.key] || '')}" placeholder="Filter">
                  </div>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(paper => {
              return `<tr data-table-paper="${paper.id}">
                ${columns.map(column => `<td class="${column.key === 'findings' ? 'findings-cell' : ''}">${column.cell(paper)}</td>`).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${rows.length ? '' : '<div class="table-empty">No papers match those Bibliography filters.</div>'}
