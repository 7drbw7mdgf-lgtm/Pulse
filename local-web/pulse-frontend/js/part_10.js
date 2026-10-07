
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
      if (state.selectedLinkId && !state.links.some(link => linkId(link) === state.selectedLinkId)) {
        state.selectedLinkId = null;
      }
      if (state.libraryFullscreen) {
        renderTagFilterBar();
        renderPapers();
        updateMetrics();
        scheduleAutosave();
        return;
      }
      const isTableMode = state.mode === 'table';
      els.map.hidden = isTableMode;
      els.map.style.display = isTableMode ? 'none' : '';
      els.tableView.hidden = !isTableMode;
      const titleHeading = (els.canvasTitle || document.querySelector('.canvas-title'))?.querySelector('h1');
      if (titleHeading) {
        titleHeading.textContent = isTableMode ? 'Biolography' : (state.mode === 'radial' ? 'Radial hierarchy' : (state.mode === 'clusters' ? 'Topic clusters' : 'Relatedness graph'));
      }
      if (isTableMode) {
        renderTableView();
      }
      const rect = els.map.getBoundingClientRect();
      const width = Math.max(rect.width, 640);
      const height = Math.max(rect.height, 520);
      const safeHeight = Math.max(360, height - bottomDockSpace());
      updateViewSize(width, height);
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
      els.map.classList.toggle('no-grid', !state.graphStyle.showGrid);
      layout(width, safeHeight);
      applyAreaContainment();

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

      const hasFilter = Boolean(state.filterTags && state.filterTags.length > 0);
      const sortedLinks = [...state.links].sort((a, b) => a.score - b.score);
      const linkMarkup = sortedLinks.map(link => {
        const source = state.papers.find(paper => paper.id === link.source);
        const target = state.papers.find(paper => paper.id === link.target);
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
        for (let j = 0; j < state.papers.length; j++) {
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
      bindAreaEvents();
      bindEdgeEvents();
      bindNodeEvents();
      renderTagFilterBar();
      renderTableView();
      renderPapers();
      renderDetails();
      renderLinkages();
      renderAreasPanel();
      updateMetrics();
      scheduleAutosave();
    }

    function renderTableView(focusColumn = '') {
      if (!els.tableView) return;
      if (!state.papers.length) {
        els.tableView.innerHTML = '<div class="table-empty">Drop papers to build an extracted Biolography table.</div>';
        return;
      }
      const rows = filteredTablePapers();
      const columns = activeTableColumns();
      const isCompact = state.paperView === 'compact';
      els.tableView.innerHTML = `
        <table class="findings-table${isCompact ? ' is-compact' : ''}" aria-label="Extracted Biolography findings">
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
        ${rows.length ? '' : '<div class="table-empty">No papers match those Biolography filters.</div>'}
      `;
      bindTableFilters();
      bindTableHeaders();
      if (focusColumn) {
        const input = els.tableView.querySelector(`[data-table-filter="${focusColumn}"]`);
        if (input) {
          input.focus();
          const end = input.value.length;
          input.setSelectionRange?.(end, end);
        }
      }
      els.tableView.querySelectorAll('[data-table-paper]').forEach(row => {
        row.addEventListener('click', () => {
          state.selectedId = row.dataset.tablePaper;
          renderDetails();
          showToast('Selected paper from Biolography.');
        });
      });
      els.tableView.querySelectorAll('[data-action="table-edit-tags"]').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          openKeywordModal(btn.dataset.paper);
        });
      });
    }

    function tableColumnDefinitions() {
      const isCompact = state.paperView === 'compact';
      return [
        {
          key: 'paper',
          label: 'Paper',
          text: paper => `${paper.title || ''} ${paper.doi || ''} ${paper.name || ''}`,
          sort: paper => paper.title || '',
          cell: paper => {
            const title = escapeHtml(paper.title || 'Untitled paper');
            const meta = escapeHtml(paper.doi ? `DOI ${paper.doi}` : (paper.name || ''));
            const abstractSnippet = (!isCompact && paper.abstract)
              ? `<div class="table-abstract-snippet" title="${escapeHtml(paper.abstract)}">${escapeHtml(paper.abstract.length > 220 ? paper.abstract.slice(0, 217) + '...' : paper.abstract)}</div>`
              : '';
            return `<div class="table-paper-cell">
              <div class="table-paper-title">${title}</div>
              ${meta ? `<div class="metadata-line">${meta}</div>` : ''}
              ${abstractSnippet}
            </div>`;
          }
        },
        {
          key: 'authors',
          label: 'Authors',
          text: paper => paperAuthors(paper).join(' '),
          sort: paper => paperAuthors(paper).join(' '),
          cell: paper => {
            const list = paperAuthors(paper);
            if (!list.length) return '<span class="subtle">Unknown</span>';
            if (isCompact) {
              return escapeHtml(list.slice(0, 3).join('; ') + (list.length > 3 ? ` (+${list.length - 3})` : ''));
            }
            return `<div class="table-authors-expanded">${escapeHtml(list.join('; '))}</div>`;
          }
        },
        {
          key: 'year',
          label: 'Year',
          text: paper => `${paper.year || ''} ${paper.date || ''}`,
          sort: paper => paper.year || paper.date || '',
          cell: paper => escapeHtml(paper.year || paper.date || '')
        },
        {
          key: 'venue',
          label: 'Venue',
          text: paper => paper.journal || '',
          sort: paper => paper.journal || '',
          cell: paper => escapeHtml(paper.journal || '')
        },
        {
          key: 'keywords',
          label: 'Keywords',
          text: paper => mergedKeywords(paper).join(' '),
          sort: paper => mergedKeywords(paper).join(' '),
          cell: paper => {
            const terms = mergedKeywords(paper);
            const count = isCompact ? 4 : terms.length;
            const chips = terms.slice(0, count).map((term, i) => `<span class="term"><span class="term-rank">#${i + 1}</span>${escapeHtml(term)}</span>`).join('');
            const extra = isCompact && terms.length > count ? `<span class="table-extra-chips subtle">+${terms.length - count}</span>` : '';
            return `<div class="table-keywords-cell">${chips}${extra}<button class="compact-chip tag-edit-chip" type="button" data-action="table-edit-tags" data-paper="${paper.id}" title="Manage &amp; reorder keyword tags">🏷️</button></div>`;
          }
        },
        {
          key: 'findings',
          label: 'Key findings',
          text: paper => keyFindings(paper).join(' '),
          sort: paper => keyFindings(paper).join(' '),
          cell: paper => {
            const findings = keyFindings(paper);
            if (!findings.length) return '<span class="subtle">No clear finding extracted yet.</span>';
            if (isCompact) {
              const top = findings.slice(0, 2);
              return `<div class="table-findings-compact">${top.map(item => `<div>${escapeHtml(item)}</div>`).join('')}${findings.length > 2 ? `<div class="subtle" style="font-size:10px;">+${findings.length - 2} more</div>` : ''}</div>`;
            }
            return `<div class="table-findings-expanded">${findings.map(item => `<div class="finding-bullet">• ${escapeHtml(item)}</div>`).join('')}</div>`;
          }
        },
        {
          key: 'links',
          label: 'Links',
          text: paper => String(tableLinkCount(paper)),
          sort: paper => tableLinkCount(paper),
          cell: paper => {
            const count = tableLinkCount(paper);
            return `<span class="table-link-badge ${count ? 'has-links' : 'no-links'}">${count} link${count === 1 ? '' : 's'}</span>`;
          }
        }
      ];
    }

    function activeTableColumns() {
      const definitions = tableColumnDefinitions();
      const byKey = new Map(definitions.map(column => [column.key, column]));
      const ordered = state.tableColumns.map(key => byKey.get(key)).filter(Boolean);
      definitions.forEach(column => {
        if (!ordered.some(item => item.key === column.key)) ordered.push(column);
      });
      return ordered;
    }

    function tableLinkCount(paper) {
      return state.links.filter(link => link.source === paper.id || link.target === paper.id).length;
    }

    function filteredTablePapers() {
      const columns = tableColumnDefinitions();
      const filters = Object.entries(state.tableFilters || {})
        .map(([key, value]) => [key, String(value || '').trim().toLowerCase()])
        .filter(([, value]) => value);
      const filtered = state.papers.filter(paper => {
        if (!paperMatchesFilters(paper)) return false;
        return filters.every(([key, value]) => {
          const column = columns.find(item => item.key === key);
          return column ? String(column.text(paper) || '').toLowerCase().includes(value) : true;
        });
      });
      const sortColumn = columns.find(column => column.key === state.tableSort.key) || columns[0];
      return filtered.sort((a, b) => {
        const left = sortColumn.sort(a);
        const right = sortColumn.sort(b);
        const direction = state.tableSort.direction === 'desc' ? -1 : 1;
        if (typeof left === 'number' || typeof right === 'number') return ((Number(left) || 0) - (Number(right) || 0)) * direction;
        return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' }) * direction;
      });
    }

    function bindTableFilters() {
      els.tableView.querySelectorAll('[data-table-filter]').forEach(input => {
        input?.addEventListener('input', event => {
          state.tableFilters[event.target.dataset.tableFilter] = event.target.value;
          renderTableView(event.target.dataset.tableFilter);
        });
      });
    }
