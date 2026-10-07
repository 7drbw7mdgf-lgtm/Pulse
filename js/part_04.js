          `).join('');

          els.canvasFilterTags.querySelectorAll('[data-action="remove-canvas-filter-tag"]').forEach(btn => {
            btn.addEventListener('click', e => {
              e.stopPropagation();
              removeFilterTag(btn.dataset.tag);
            });
          });
        }
      }
    }

    function renderLibraryTagCloud() {
      if (!els.libraryTagCloud) return;
      const allTags = getLibraryAllTags();
      const query = (els.tagFilterSearchInput?.value || '').trim().toLowerCase();
      const filtered = query
        ? allTags.filter(item => item.tag.toLowerCase().includes(query))
        : allTags;

      if (!filtered.length) {
        els.libraryTagCloud.innerHTML = allTags.length === 0
          ? '<div class="subtle-empty">No tags in library yet. Add tags or sample papers.</div>'
          : '<div class="subtle-empty">No matching tags found.</div>';
        return;
      }

      els.libraryTagCloud.innerHTML = filtered.slice(0, 48).map(item => {
        const isActive = state.filterTags.some(t => t.toLowerCase() === item.tag.toLowerCase());
        return `<button class="cloud-tag-chip${isActive ? ' is-active' : ''}" type="button" data-action="toggle-cloud-tag" data-tag="${escapeHtml(item.tag)}" title="Filter library by &quot;${escapeHtml(item.tag)}&quot;">
          ${escapeHtml(item.tag)} <span class="cloud-tag-count">${item.count}</span>
        </button>`;
      }).join('');

      els.libraryTagCloud.querySelectorAll('[data-action="toggle-cloud-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          toggleFilterTag(btn.dataset.tag);
        });
      });
    }

    function toggleFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      const idx = state.filterTags.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.filterTags.splice(idx, 1);
        showToast(`Removed tag filter: "${cleaned}"`);
      } else {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
      }
      renderTagFilterBar();
      render();
    }

    function addFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      if (!state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase())) {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
        renderTagFilterBar();
        render();
      }
    }

    function removeFilterTag(tag) {
      const cleaned = cleanField(tag);
      state.filterTags = state.filterTags.filter(t => t.toLowerCase() !== cleaned.toLowerCase());
      showToast(`Removed tag filter: "${cleaned}"`);
      renderTagFilterBar();
      render();
    }

    function clearFilterTags() {
      state.filterTags = [];
      state.librarySearch = '';
      if (els.tagFilterSearchInput) els.tagFilterSearchInput.value = '';
      showToast('Cleared all tag filters.');
      renderTagFilterBar();
      render();
    }

    function toggleRecommendationSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from recommendation steering.`);
      } else {
        state.recommendationSteerKeywords = dedupeList([cleaned, ...state.recommendationSteerKeywords]).slice(0, 12);
        state.recommendationSteerOpen = true;
        showToast(`Steering recommendations toward "${cleaned}".`);
      }
      renderDetails();
    }

    function toggleGraphSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.graphSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.graphSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from map focus.`);
      } else {
        state.graphSteerKeywords = dedupeList([cleaned, ...state.graphSteerKeywords]).slice(0, 12);
        showToast(`Refocusing map around "${cleaned}".`);
      }
      render();
    }

    function toggleExcludeSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationExcludeKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationExcludeKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from exclusions.`);
      } else {
        state.recommendationExcludeKeywords = dedupeList([cleaned, ...state.recommendationExcludeKeywords]).slice(0, 16);
        showToast(`Excluding recommendations with "${cleaned}".`);
      }
      renderDetails();
    }

    let currentTagActionTerm = '';

    function openTagActionMenu(term, anchorEl) {
      const cleaned = cleanField(term);
      if (!cleaned || !els.tagActionMenu || !anchorEl) return;
      currentTagActionTerm = cleaned;

      if (els.tagActionMenuTitle) els.tagActionMenuTitle.textContent = cleaned;

      const isFiltered = state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isSteered = state.recommendationSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isGraphSteered = state.graphSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isExcluded = state.recommendationExcludeKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());

      if (els.tagActionFilterLabel) {
        els.tagActionFilterLabel.textContent = isFiltered
          ? `Remove "${cleaned}" from library filter`
          : `Filter library by "${cleaned}"`;
      }
      if (els.tagActionSteerLabel) {
        els.tagActionSteerLabel.textContent = isSteered
          ? `Remove "${cleaned}" from recommendation steering`
          : `Steer recommendations toward "${cleaned}"`;
      }
      if (els.tagActionGraphLabel) {
        els.tagActionGraphLabel.textContent = isGraphSteered
          ? `Remove "${cleaned}" from map focus`
          : `Focus map graph around "${cleaned}"`;
      }
      if (els.tagActionExcludeLabel) {
        els.tagActionExcludeLabel.textContent = isExcluded
          ? `Remove "${cleaned}" from exclusions`
          : `Exclude recommendations with "${cleaned}"`;
      }

      const rect = anchorEl.getBoundingClientRect();
      const menuWidth = 260;
      const menuHeight = 220;
      let left = rect.left;
      let top = rect.bottom + 6;

      if (left + menuWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - menuWidth - 12);
      }
      if (top + menuHeight > window.innerHeight - 12) {
        top = Math.max(12, rect.top - menuHeight - 6);
      }

      els.tagActionMenu.style.left = `${Math.round(left)}px`;
      els.tagActionMenu.style.top = `${Math.round(top)}px`;
      els.tagActionMenu.hidden = false;
    }

    function closeTagActionMenu() {
      if (els.tagActionMenu) els.tagActionMenu.hidden = true;
      currentTagActionTerm = '';
    }

    function setPaperPanelHidden(hidden) {
      if (els.app) els.app.classList.toggle('panel-hidden', hidden);
      if (els.panelToggleButton) {
        els.panelToggleButton.textContent = hidden ? '>' : '<';
        els.panelToggleButton.title = hidden ? 'Show paper panel' : 'Hide paper panel';
        els.panelToggleButton.setAttribute('aria-label', hidden ? 'Show paper panel' : 'Hide paper panel');
        els.panelToggleButton.setAttribute('aria-expanded', String(!hidden));
      }
      if (els.showPanelButton) els.showPanelButton.setAttribute('aria-expanded', String(!hidden));
      window.requestAnimationFrame(() => render());
    }

    function backendUrl(path) {
      return `${apiBase}${path}`;
    }

    function backendNavigationUrl(path) {
      const url = new URL(backendUrl(path), window.location.href);
      if (apiToken) url.searchParams.set('token', apiToken);
      return url.toString();
    }

    function apiHeaders(extra = {}) {
      const headers = { ...extra };
      if (apiToken) {
        headers['X-Pulse-Token'] = apiToken;
        headers['X-Iratxe-Token'] = apiToken;
      }
      return headers;
    }

    function syncProviderControls() {
      const local = els.aiProviderInput.value === 'local';
      document.getElementById('cloudProviderGroup').hidden = local;
      document.getElementById('cloudSettingsStep').hidden = local;
      document.getElementById('localOllamaSettingsStep').hidden = !local;
      els.cloudProviderInput.disabled = local;
      els.ollamaChatEndpointInput.disabled = !local;
      els.ollamaModelSelect.disabled = !local;
      els.embeddingModelInput.disabled = !local;
      els.testBackendButton.disabled = false;
    }

    function visibleLinks() {
      return state.links.filter(link => state.linkTypeFilter === 'all' || link.type === state.linkTypeFilter);
    }

    function setWorkspaceView(view) {
      els.app.classList.remove('network-fullscreen');
      const fullButton = document.getElementById('networkFullscreenButton');
      fullButton.textContent = 'Full screen';
      fullButton.setAttribute('aria-pressed', 'false');
      state.workspaceView = view;
      state.inspectorOpen = false;
      if (view === 'timeline') state.mode = 'timeline';
      else if (view === 'library') state.mode = 'table';
      else if (view === 'network' && !['network', 'clusters', 'radial'].includes(state.mode)) state.mode = 'network';
      render();
    }

    function toggleNetworkFullscreen(force) {
      const full = typeof force === 'boolean' ? force : !els.app.classList.contains('network-fullscreen');
      els.app.classList.toggle('network-fullscreen', full);
      const button = document.getElementById('networkFullscreenButton');
      button.textContent = full ? 'Exit full screen' : 'Full screen';
      button.setAttribute('aria-pressed', String(full));
      render();
    }

    function setDiscoverySeed(id) {
      if(state.discoveryLoading && state.pinnedSeedId!==id)cancelDiscovery();
      state.selectedId = id;
      state.pinnedSeedId = id;
      state.selectedLinkId = null;
      if (state.discoverySeed?.id !== id) {
        state.discoveryStatus='';state.discoveryWarnings=[];
        state.discoveryResults = [];
        state.discoverySelectedKeys = new Set();
        state.discoveryHasRun = false;
        state.discoveryError = '';
      }
    }

    function renderDiscoveryWorkspace() {
      const seedId = state.pinnedSeedId || state.selectedId || state.papers[0]?.id || '';
      const seed = state.papers.find(paper => paper.id === seedId) || state.papers[0];
      els.discoverySeedSelect.innerHTML = state.papers.length ? state.papers.map(paper => `<option value="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}${paper.year ? ` (${escapeHtml(paper.year)})` : ''}</option>`).join('') : '<option value="">Add a paper above to begin</option>';
      els.discoverySeedSelect.value = seed?.id || '';
      const busy = state.discoveryLoading || state.citationLoading;
      els.discoverySeedSelect.disabled = !state.papers.length || busy;
      els.discoveryRunButton.disabled = !seed || busy || !Object.values(state.discoveryBranches).some(Boolean);
      els.discoveryRunButton.textContent = busy ? 'Finding papers…' : 'Find related papers';
      els.discoveryCancelButton.hidden = !state.discoveryLoading;
      els.discoveryProgress.hidden = !busy && !state.discoveryStatus && !state.discoveryWarnings.length;
      els.discoveryProgress.textContent = state.discoveryStatus || (busy ? `Searching from “${seed?.title || 'your paper'}”. Results will appear below.` : '');
      if(state.discoveryWarnings.length)els.discoveryProgress.textContent += ` ${state.discoveryWarnings.join(' ')}`;
      const hasResults = state.discoveryResults.length > 0;
      els.discoveryModal.querySelector('.discovery-modal-toolbar').hidden = !hasResults;
      els.discoveryModal.querySelector('.discovery-status-bar').hidden = !hasResults;
      els.discoveryModal.querySelector('.discovery-modal-footer').hidden = !hasResults;
      document.querySelectorAll('[data-depth], [data-method], [data-special]').forEach(button => button.disabled = busy || (!seed && Boolean(button.dataset.special)));
      renderDiscoveryModal();
    }

    function publicationDate(paper) {
      const raw = String(paper.date || '').trim();
      const iso = raw.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
      if (iso && Number(iso[1]) >= 1000) {
        return {time: Date.UTC(Number(iso[1]), Number(iso[2] || 1) - 1, Number(iso[3] || 1)), year: iso[1], label: raw};
      }
      const parsed = raw ? Date.parse(raw) : NaN;
      if (Number.isFinite(parsed)) return {time: parsed, year: String(new Date(parsed).getUTCFullYear()), label: raw};
      const year = String(paper.year || '').match(/\b([12]\d{3})\b/)?.[1];
      return year ? {time: Date.UTC(Number(year), 0, 1), year, label: year} : null;
    }

    function chronologicalPapers() {
      return state.papers.map(paper => ({paper, date: publicationDate(paper)})).sort((left, right) => {
        if (!left.date && right.date) return 1;
        if (left.date && !right.date) return -1;
        return (left.date?.time || 0) - (right.date?.time || 0) || left.paper.title.localeCompare(right.paper.title);
      });
    }

    function renderTimeline() {
      const ordered = chronologicalPapers();
      let previousYear = null;
      const count = ordered.length;
      els.timelineView.innerHTML = `<header class="timeline-header"><span class="discovery-source-pill">Chronological Literature View</span><h1>Timeline</h1><p>Oldest to newest · ${count} papers across your research library.</p></header><div class="timeline-track">${ordered.map(({paper, date}) => {
        const year = date?.year || 'Undated';
        const heading = year !== previousYear ? `<div class="timeline-year-heading"><h2 class="timeline-year">${escapeHtml(year)}</h2><span class="timeline-year-badge">${ordered.filter(o => (o.date?.year || 'Undated') === year).length} paper${ordered.filter(o => (o.date?.year || 'Undated') === year).length === 1 ? '' : 's'}</span></div>` : '';
        previousYear = year;
        const citations = Number(paper.citationCount ?? paper.citations ?? 0);
        const citeHtml = citations > 0 ? `<span class="timeline-cite-pill">★ ${citations.toLocaleString()} cites</span>` : '';
        const isSelected = state.selectedId === paper.id ? ' is-selected' : '';
        const isSeminal = (citations > 100 || (paper.tags && paper.tags.includes('seminal')));
        const seminalBadge = isSeminal ? '<span class="timeline-seminal-badge">Seminal</span>' : '';
        return `${heading}<article class="timeline-paper${isSelected}" data-timeline-id="${escapeHtml(paper.id)}"><div class="timeline-date-wrap"><span class="timeline-date">${escapeHtml(date?.label || 'Date unknown')}</span>${citeHtml}</div><div class="timeline-content"><div class="timeline-title-row"><button type="button" class="timeline-paper-title" data-timeline-inspect="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}</button>${seminalBadge}</div><p>${escapeHtml([paperAuthorSummary(paper), paper.journal].filter(Boolean).join(' · '))}</p>${paper.abstract ? `<p class="timeline-abstract">${escapeHtml(paper.abstract.slice(0, 240))}${paper.abstract.length > 240 ? '…' : ''}</p>` : ''}</div><div class="timeline-actions"><button type="button" class="button secondary xs" data-timeline-discover="${escapeHtml(paper.id)}">Discover related</button><button type="button" class="button xs" data-timeline-focus="${escapeHtml(paper.id)}">View in graph</button></div></article>`;
      }).join('') || '<div class="timeline-empty">Add papers to see how the literature develops over time.</div>'}</div>`;
      els.timelineView.querySelectorAll('[data-timeline-inspect]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.timelineInspect;
        state.inspectorOpen = true;
        renderDetails();
      }));
      els.timelineView.querySelectorAll('[data-timeline-discover]').forEach(button => button.addEventListener('click', () => {
        setDiscoverySeed(button.dataset.timelineDiscover);
        setWorkspaceView('discover');
      }));
      els.timelineView.querySelectorAll('[data-timeline-focus]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.timelineFocus;
        state.centerId = button.dataset.timelineFocus;
        setWorkspaceView('network');
      }));
    }

    function syncWorkspaceControls() {
      els.app.dataset.workspace = state.workspaceView;
      els.discoveryModal.hidden = state.workspaceView !== 'discover';
      document.querySelector('.pulse-workspace-cols').hidden = state.workspaceView === 'discover';
      document.querySelectorAll('[data-rail]').forEach(button => {
        const active = button.dataset.rail === state.workspaceView;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      document.querySelectorAll('[data-mode]').forEach(button => {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      });
      els.canvasLayoutSelect.value = state.mode;
      els.canvasLinksSelect.value = state.linkTypeFilter;
      els.labelModeInput.value = state.graphStyle.labelMode;
      els.showLabelsToggle.checked = state.graphStyle.labelMode !== 'none';
      const branches = {citations:'citationGraph',network:'citationNetwork',semantic:'semanticSearch',concepts:'lexicalSearch'};
