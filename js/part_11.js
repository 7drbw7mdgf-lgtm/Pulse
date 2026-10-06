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
          state.inspectorOpen = true;
          renderDetails();
          showToast('Selected paper from Bibliography.');
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
      return paperLinks(paper.id).length;
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
      const link = linksById.get(state.selectedLinkId);
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
