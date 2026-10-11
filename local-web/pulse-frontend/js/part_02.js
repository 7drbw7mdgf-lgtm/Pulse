
    function openDiscoveryModal(results, seedPaper, resultKey=null) {
      if(typeof recommendationKey==='function'&&typeof selectedPapersForRecommendation==='function'){
        const activeKey=resultKey||recommendationKey(selectedPapersForRecommendation());
        if(state.discoveryResultKey!==activeKey)state.discoveryRunContext=state.discoveryRunInfo?.get(activeKey)?.runContext||null;
        state.discoveryResultKey=activeKey;
      }
      const continuing = Boolean(state.discoverySearching && (!resultKey || state.discoverySearching.key === resultKey));
      const keepSelected = continuing ? new Set(state.discoverySelectedKeys || []) : new Set();
      const keepFocus = continuing ? state.discoveryFocusKey : null;
      state.discoverySearching = null;
      state.discoveryResults = results || [];
      state.discoverySeed = seedPaper || state.papers.find(p => p.id === state.selectedId) || state.papers[0];
      state.discoveryQueue = 'review';
      state.discoveryWhyKinds = new Set();
      state.discoveryHiddenStrengths = new Set();
      state.discoveryShowExplore = false;
      state.discoveryFocusKey = keepFocus;
      state.discoveryFilterText = '';
      state.discoveryFilterAuthor = '';
      state.discoveryFilterYear = 'all';
      state.discoveryFilterBranch = 'all';
      state.discoverySortBy = 'score';
      state.discoveryQuickTag = '';
      state.discoveryFullTextOnly = false;
      const fullTextToggle=document.getElementById('discoveryFullTextOnly');if(fullTextToggle)fullTextToggle.checked=false;
      state.discoveryExpandedAbstracts = new Set();

      const validKeys = new Set(state.discoveryResults.map(discoveryPaperKey));
      state.discoverySelectedKeys = new Set([...keepSelected].filter(key => validKeys.has(key)));

      if (els.discoveryFilterText) els.discoveryFilterText.value = '';
      if (els.discoveryClearTextBtn) els.discoveryClearTextBtn.hidden = true;
      if (els.discoveryFilterAuthor) els.discoveryFilterAuthor.value = '';
      if (els.discoveryFilterYear) els.discoveryFilterYear.value = 'all';
      if (els.discoverySortBy) els.discoverySortBy.value = 'score';

      if (els.discoveryModal) els.discoveryModal.hidden = false;
      renderDiscoveryModal();
      if (typeof els.discoveryModal?.querySelector === 'function') els.discoveryModal.querySelector('.dv-card')?.focus();
    }

    function closeDiscoveryModal() {
      if (els.discoveryModal) els.discoveryModal.hidden = true;
    }

    function selectedDiscoveryPapers() {
      const seen = new Set();
      return (state.discoveryResults || []).filter(item => {
        const key = discoveryPaperKey(item);
        if (!state.discoverySelectedKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function updateDiscoverySelection() {
      const selected = selectedDiscoveryPapers();
      const selectedCount = selected.length;
      const visibleKeys = new Set(getFilteredDiscoveryPapers().map(discoveryPaperKey));
      const hiddenCount = selected.filter(item => !visibleKeys.has(discoveryPaperKey(item))).length;
      if (els.discoverySelectedCount) {
        els.discoverySelectedCount.textContent = `${selectedCount} selected${hiddenCount ? ` · ${hiddenCount} hidden by filters` : ''}`;
      }
      if (els.discoveryAddSelectedMapBtn) {
        els.discoveryAddSelectedMapBtn.textContent = `Add ${selectedCount} to library and map`;
        els.discoveryAddSelectedMapBtn.disabled = selectedCount === 0;
      }
      if (els.discoveryAddSelectedLibraryBtn) {
        els.discoveryAddSelectedLibraryBtn.textContent = `Library only (${selectedCount})`;
        els.discoveryAddSelectedLibraryBtn.disabled = selectedCount === 0;
      }
      const bulk = document.getElementById('discoveryBulkBar');
      const hints = document.getElementById('discoveryHints');
      if (bulk) bulk.hidden = selectedCount === 0;
      if (hints) hints.hidden = selectedCount > 0;
      els.discoveryPaperList?.querySelectorAll('.discovery-paper-item').forEach(card => {
        card.classList.toggle('is-selected', state.discoverySelectedKeys.has(card.dataset.paperKey));
      });
      els.discoveryPaperList?.querySelectorAll('.discovery-item-checkbox').forEach(checkbox => {
        checkbox.checked = state.discoverySelectedKeys.has(checkbox.dataset.paperKey);
      });
    }

    function setDiscoveryPaperSelected(key, selected) {
      if (!(state.discoveryResults || []).some(item => discoveryPaperKey(item) === key)) return;
      if (selected) state.discoverySelectedKeys.add(key);
      else state.discoverySelectedKeys.delete(key);
      updateDiscoverySelection();
    }

    function getFilteredDiscoveryPapers() {
      const items = state.discoveryResults || [];
      const query = (state.discoveryFilterText || '').trim().toLowerCase();
      const authorQuery = (state.discoveryFilterAuthor || '').trim().toLowerCase();
      const yearFilter = state.discoveryFilterYear || 'all';
      const branchFilter = state.discoveryFilterBranch || 'all';
      const quickTag = (state.discoveryQuickTag || '').trim().toLowerCase();

      const queue = state.discoveryQueue || 'review';
      const hiddenStrengths = state.discoveryHiddenStrengths || new Set();
      const whyKinds = state.discoveryWhyKinds || new Set();
      return items.filter(item => {
        if (queue !== 'all' && !state.discoverySearching && discoveryQueueOf(item) !== queue) return false;
        if (hiddenStrengths.has(discoveryStrength(item))) return false;
        if (whyKinds.size && !discoveryWhy(item).some(reason => whyKinds.has(discoveryWhyGroup(reason.kind)))) return false;
        if(state.discoveryFullTextOnly&&!safeHref(item.fullTextUrl||''))return false;
        if (quickTag) {
          const tags = [...(item.paperKeywords || []), ...(item.discoveryBadges || []), ...(item.matchedConcepts || [])].map(t => t.toLowerCase());
          const matchQuick = tags.some(t => t.includes(quickTag)) ||
            (item.title || '').toLowerCase().includes(quickTag) ||
            (item.abstract || '').toLowerCase().includes(quickTag);
          if (!matchQuick) return false;
        }

        if (query) {
          const haystack = [
            item.title || '',
            item.abstract || '',
            item.journal || '',
            item.doi || '',
            ...(item.paperKeywords || []),
            ...(item.discoveryBadges || []),
            ...(item.matchedConcepts || []),
            item.reason || '',
            ...discoveryWhy(item).map(reason => reason.detail || reason.label)
          ].join(' ').toLowerCase();
          if (!haystack.includes(query)) return false;
        }

        if (authorQuery) {
          const authorHaystack = (Array.isArray(item.authors) ? item.authors.join(' ') : String(item.authors || '')).toLowerCase();
          if (!authorHaystack.includes(authorQuery)) return false;
        }

        if (yearFilter !== 'all') {
          const yMatch = String(item.year || item.date || '').match(/\b(19|20)\d{2}\b/);
          const y = yMatch ? parseInt(yMatch[0], 10) : 0;
          if (yearFilter === 'older') {
            if (y >= 2015) return false;
          } else {
            const minYear = parseInt(yearFilter, 10);
            if (isNaN(minYear) || y < minYear) return false;
          }
        }

        if (branchFilter !== 'all') {
          if (branchFilter === 'semanticSearch') {
            const isSpecter = item.branch === 'semanticSearch' ||
              Boolean(item.branchHits?.semanticSearch) ||
              (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
            if (!isSpecter) return false;
          } else if (branchFilter === 'citationNetwork') {
            const isNetwork = item.branch === 'citationNetwork' ||
              Boolean(item.branchHits?.citationNetwork) ||
              (item.discoveryBadges || []).some(b => b.includes('Co-citation') || b.includes('Bib Coupling'));
            if (!isNetwork) return false;
          } else if (branchFilter === 'citationGraph') {
            const isGraph = item.branch === 'citationGraph' ||
              Boolean(item.branchHits?.citationGraph) ||
              (item.discoveryBadges || []).some(b => b.includes('Backward') || b.includes('Forward') || b.includes('2-Hop') || b.includes('Cite'));
            if (!isGraph) return false;
          } else if (branchFilter === 'lexicalConceptual') {
            const isLexical = item.branch === 'lexicalConceptual' ||
              Boolean(item.branchHits?.lexicalConceptual) ||
              (item.discoveryBadges || []).some(b => b.includes('Concept') || b.includes('Search'));
            if (!isLexical) return false;
          }
        }

        return true;
      }).sort((a, b) => {
        const sortBy = state.discoverySortBy || 'score';
        if (sortBy === 'citations') {
          return (b.citedByCount ?? b.citationCount ?? -1) - (a.citedByCount ?? a.citationCount ?? -1);
        }
        if (sortBy === 'year-desc') {
          const yA = parseInt(String(a.year || a.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          const yB = parseInt(String(b.year || b.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          return yB - yA;
        }
        if (sortBy === 'year-asc') {
          const yA = parseInt(String(a.year || a.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          const yB = parseInt(String(b.year || b.date || '').match(/\b(19|20)\d{2}\b/)?.[0] || '0', 10);
          return yA - yB;
        }
        if (sortBy === 'title') {
          return (a.title || '').localeCompare(b.title || '');
        }
        return a.rank&&b.rank?a.rank-b.rank:(b.score || 0) - (a.score || 0);
      });
    }

    // ─── Discovery review workspace (1.8) ───
    const DISCOVERY_SOURCE_LABELS = {
      citationGraph: 'Citation graph', citationNetwork: 'Citation network', semanticSearch: 'Semantic search',
      lexicalConceptual: 'Semantic Scholar', europePmc: 'Europe PMC', core: 'CORE'
    };
    const DISCOVERY_WHY_GROUPS = {
      authors: 'authors', 'cites-seed': 'citations', 'cited-by-seed': 'citations', 'two-steps': 'citations',
      'co-cited': 'citations', 'shared-references': 'citations', topic: 'topic', question: 'topic', search: 'search'
    };
    const DISCOVERY_WHY_FILTERS = [['authors', 'Shares authors with your seed'], ['citations', 'Linked by citations'], ['topic', 'Matches your topic'], ['search', 'Found by search only']];
    const DISCOVERY_STRENGTHS = [['strong', 'Strong matches'], ['related', 'Related'], ['explore', 'Worth exploring']];

    function discoveryStrength(item) {
      const label = String(item.matchLabel || '').toLowerCase();
      if (label.startsWith('strong')) return 'strong';
      if (label.startsWith('related')) return 'related';
      if (label.startsWith('explore')) return 'explore';
      const score = Number(item.score);
      return score >= 65 ? 'strong' : score >= 40 ? 'related' : 'explore';
    }

    function discoveryWhyGroup(kind) {
      return DISCOVERY_WHY_GROUPS[kind] || 'search';
    }

    // Results from before 1.8 have no whyFound; keep their specific reasons, drop the generic one.
    function discoveryWhy(item) {
      if (Array.isArray(item.whyFound) && item.whyFound.length) return item.whyFound;
      const reasons = (item.matchReasons || []).filter(reason => !/^Provider ranks combined/i.test(reason));
      if (reasons.length) return reasons.map(reason => ({ kind: /citation/i.test(reason) ? 'cites-seed' : 'topic', label: reason, detail: reason }));
      const sources = [...new Set((item.sourceList || []).filter(Boolean))];
      return [{ kind: 'search', label: 'Topic search', detail: sources.length ? `Found by topic search in ${sources.join(', ')}` : (item.reason || 'Found by your selected search sources') }];
    }

    function discoveryQueueOf(item) {
      if (recommendationAlreadyOnMap(item)) return 'library';
      const rating = typeof discoveryRating === 'function' ? discoveryRating(item) : undefined;
      if (rating === 2) return 'relevant';
      if (rating === 0) return 'not';
      return 'review';
    }

    function cleanDiscoveryTitle(value) {
      return String(value || 'Untitled').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    }

    function discoveryCitationText(item) {
      const value = item.citedByCount ?? item.citationCount;
      if (Number.isFinite(value) && value > 0) return `${value.toLocaleString()} citation${value === 1 ? '' : 's'}`;
      if (value === 0 && item.citationCountSource && item.citationCountSource !== 'CORE') return '0 citations';
      return '—';
    }

    function discoveryAuthorLine(item, limit = 3) {
      const authors = Array.isArray(item.authors) ? item.authors : (item.authors ? [item.authors] : []);
      const short = name => (typeof shortAuthorName === 'function' ? shortAuthorName(name) : String(name));
      if (!authors.length) return 'Authors not listed';
      return authors.slice(0, limit).map(short).join(', ') + (authors.length > limit ? ` +${authors.length - limit}` : '');
    }

    function discoveryYear(item) {
      return Number(String(item.year || item.date || '').match(/\b(1[89]|20)\d{2}\b/)?.[0] || 0);
    }

    function discoveryRunInfoForModal() {
      return state.discoveryRunInfo?.get(state.discoveryResultKey || recommendationKey(selectedPapersForRecommendation())) || {};
    }

    // One row per search source: finished, still running, failed or rate-limited.
    function discoverySourceRows() {
      const searching = state.discoverySearching;
      const info = searching?.job || discoveryRunInfoForModal();
      const resultKey = state.discoveryResultKey || (typeof recommendationKey === 'function' && typeof selectedPapersForRecommendation === 'function' ? recommendationKey(selectedPapersForRecommendation()) : '');
      const errors = searching?.job?.errors || state.discoverySearchErrors?.get(resultKey) || info.errors || {};
      const done = new Set(info.branchesExecuted || []);
      const counts = info.sourceCounts || {};
      const planned = searching?.planned?.length ? searching.planned : [...new Set([...Object.keys(counts), ...done, ...Object.keys(errors)])];
      return planned.map(key => {
        const name = DISCOVERY_SOURCE_LABELS[key] || key;
        const error = errors[key];
        if (error) {
          const limited = /429|rate|too many/i.test(error);
          return { key, name, status: limited ? 'warn' : 'fail', detail: limited ? 'Rate limited — add a free API key in Settings for full results' : String(error).replace(/^[^:]+:\s*/, '').slice(0, 120) };
        }
        if (done.has(key) || counts[key] !== undefined || !searching) return { key, name, status: 'ok', detail: counts[key] !== undefined ? `${counts[key]} papers` : 'Done' };
        return { key, name, status: 'run', detail: 'Searching…' };
      });
    }

    function discoveryPlannedSources(options) {
      const planned = [];
      for (const key of ['citationGraph', 'citationNetwork', 'semanticSearch']) if (options.branches?.[key]) planned.push(key);
      if (options.branches?.lexicalSearch) {
        if (options.searchSources?.semanticScholar !== false) planned.push('lexicalConceptual');
        if (options.searchSources?.europePmc) planned.push('europePmc');
        if (options.searchSources?.core) planned.push('core');
      }
      return planned;
    }

    function openDiscoverySearching(seedPaper, key, options) {
      state.discoverySearching = { key, seed: seedPaper, startedAt: Date.now(), job: null, planned: discoveryPlannedSources(options || {}) };
      state.discoveryResults = [];
      state.discoveryResultKey = key;
      state.discoverySeed = seedPaper;
      state.discoverySelectedKeys = new Set();
      state.discoveryQueue = 'review';
      if (els.discoveryModal) els.discoveryModal.hidden = false;
      renderDiscoveryModal();
    }

    function updateDiscoverySearching(job) {
      if (!state.discoverySearching) return;
      state.discoverySearching.job = job;
      if (Array.isArray(job?.recommendations)) state.discoveryResults = job.recommendations;
      if (els.discoveryModal && !els.discoveryModal.hidden) renderDiscoveryModal();
    }

    function discoveryElapsed(start) {
      const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function discoveryYearBuckets(items) {
      const years = items.map(discoveryYear).filter(Boolean);
      if (!years.length) return [];
      const min = Math.min(...years), max = Math.max(...years);
      const span = Math.max(1, Math.ceil((max - min + 1) / 5));
      const buckets = [];
      for (let start = min; start <= max; start += span) {
        const end = Math.min(max, start + span - 1);
        buckets.push({ start, end, count: years.filter(year => year >= start && year <= end).length });
      }
      return buckets;
    }

    function discoveryRowMarkup(item, focusedKey, searching) {
      const key = discoveryPaperKey(item);
      const isSelected = state.discoverySelectedKeys.has(key);
      const strength = discoveryStrength(item);
      const level = strength === 'strong' ? 3 : strength === 'related' ? 2 : 1;
      const queue = discoveryQueueOf(item);
      const tag = queue === 'relevant' ? '<span class="dv-triage is-yes">Relevant</span>' : queue === 'not' ? '<span class="dv-triage is-no">Not relevant</span>' : queue === 'library' ? '<span class="dv-triage">In library</span>' : '';
      const reasons = discoveryWhy(item).slice(0, 3).map(reason => `<span class="dv-reason" title="${escapeHtml(reason.detail || reason.label)}">${escapeHtml(reason.label)}</span>`).join('')
        + (safeHref(item.fullTextUrl || '') ? '<span class="dv-reason is-fulltext">Full text available</span>' : '');
      const meta = [discoveryAuthorLine(item), item.year || item.date || '', item.journal || item.venue || ''].filter(Boolean).join(' · ');
      return `
        <article class="discovery-paper-item dv-row${isSelected ? ' is-selected' : ''}${key === focusedKey ? ' is-focused' : ''}" data-paper-key="${escapeHtml(key)}" role="listitem">
          ${searching ? '' : `<input type="checkbox" class="discovery-item-checkbox" data-paper-key="${escapeHtml(key)}" ${isSelected ? 'checked' : ''} aria-label="${escapeHtml(`Select ${cleanDiscoveryTitle(item.title)}`)}">`}
          <button class="dv-row-main" type="button" data-dv-focus="${escapeHtml(key)}">
            <span class="dv-row-title"><span>${escapeHtml(cleanDiscoveryTitle(item.title))}</span>${tag}</span>
            <span class="dv-row-meta">${escapeHtml(meta)}</span>
            ${reasons ? `<span class="dv-reasons">${reasons}</span>` : ''}
          </button>
          <span class="dv-row-side">
            <span class="dv-meter" role="img" aria-label="${escapeHtml(DISCOVERY_STRENGTHS.find(([id]) => id === strength)[1])}">${[1, 2, 3].map(n => `<i class="${n <= level ? 'on' : ''}"></i>`).join('')}</span>
            <span class="dv-cites" title="${discoveryCitationText(item) === '—' ? 'No citation count reported by these sources' : escapeHtml(item.citationCountSource || '')}">${escapeHtml(discoveryCitationText(item))}</span>
          </span>
        </article>`;
    }

    function discoveryPreviewMarkup(item, searching) {
      if (!item) {
        return `<div class="dv-preview-empty"><p>${searching ? 'Results appear here as each source finishes.' : 'No paper matches these filters.'}</p></div>`;
      }
      const key = discoveryPaperKey(item);
      const strength = discoveryStrength(item);
      const queue = discoveryQueueOf(item);
      const rating = typeof discoveryRating === 'function' ? discoveryRating(item) : undefined;
      const href = safeHref(item.url || (item.doi ? `https://doi.org/${item.doi}` : ''));
      const fullText = safeHref(item.fullTextUrl || '');
      const versions = (item.relatedVersions || []).map(version => {
        const link = safeHref(version.url || (version.doi ? `https://doi.org/${version.doi}` : ''));
        const label = [version.year, (version.sourceList || []).join(', ') || version.documentType || 'Other version'].filter(Boolean).join(' · ');
        return link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
      }).join('');
      const meta = [discoveryAuthorLine(item, 6), item.year || item.date || '', item.journal || item.venue || '', item.doi ? `DOI ${item.doi}` : '', discoveryCitationText(item) !== '—' ? discoveryCitationText(item) : ''].filter(Boolean).join(' · ');
      const strengthName = DISCOVERY_STRENGTHS.find(([id]) => id === strength)[1].replace(/es$/, '').replace(/s$/, '');
      return `
        <div class="dv-preview-scroll">
          <div class="dv-preview-badges"><span class="dv-strength is-${strength}">${escapeHtml(strength === 'strong' ? 'Strong match' : strengthName)}</span>${Number.isFinite(item.score) ? `<span class="dv-score" title="Scores are relative within this search, not probabilities">${Math.round(item.score)} / 100 relative</span>` : ''}</div>
          <h3 class="dv-preview-title">${escapeHtml(cleanDiscoveryTitle(item.title))}</h3>
          <p class="dv-preview-meta">${escapeHtml(meta)}</p>
          <section class="dv-why"><h4>Why Pulse suggested this</h4><ul>${discoveryWhy(item).map(reason => `<li>${escapeHtml(reason.detail || reason.label)}</li>`).join('')}${fullText ? `<li>Free full text available${item.sourceList?.length ? ` (${escapeHtml(item.sourceList.join(', '))})` : ''}</li>` : ''}</ul></section>
          ${item.abstract ? `<section class="dv-abstract"><h4>Abstract</h4><p>${escapeHtml(item.abstract)}</p></section>` : '<p class="dv-muted">No abstract available from these sources.</p>'}
          ${versions ? `<section class="dv-versions"><h4>Other versions</h4><div>${versions}</div></section>` : ''}
          <div class="dv-links">
            ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open paper</a>` : ''}
            ${fullText ? `<a href="${escapeHtml(fullText)}" target="_blank" rel="noreferrer">Full text</a>` : ''}
            ${searching ? '' : `<button type="button" data-dv-action="more-like" data-paper-key="${escapeHtml(key)}">More like this</button><button type="button" data-dv-action="less-like" data-paper-key="${escapeHtml(key)}">Fewer like this</button>`}
          </div>
        </div>
        ${searching ? '' : `<div class="dv-preview-actions">
          <div class="dv-pair" role="group" aria-label="Is this relevant to your review?">
            <button type="button" class="is-yes" data-dv-grade="2" data-paper-key="${escapeHtml(key)}" aria-pressed="${rating === 2}">Relevant</button>
            <button type="button" class="is-no" data-dv-grade="0" data-paper-key="${escapeHtml(key)}" aria-pressed="${rating === 0}">Not relevant</button>
          </div>
          ${queue === 'library'
            ? '<p class="dv-muted dv-in-library">Already in your library.</p>'
            : `<button type="button" class="dv-btn primary block" data-dv-action="add-focused" data-paper-key="${escapeHtml(key)}">Add to library and map</button>`}
        </div>`}`;
    }

    function renderDiscoveryModal() {
      if (!els.discoveryModal || els.discoveryModal.hidden) return;
      const searching = state.discoverySearching;
      const totalItems = state.discoveryResults || [];
      const filtered = getFilteredDiscoveryPapers();
      const seed = searching?.seed || state.discoverySeed;
      const seedTitle = cleanDiscoveryTitle(seed?.title || 'Selected seed paper');
      const strengthCount = id => totalItems.filter(item => discoveryStrength(item) === id).length;

      const title = document.getElementById('discoveryModalTitle');
      if (title) title.innerHTML = `${escapeHtml(seedTitle)}${seed?.year ? ` <span>· ${escapeHtml(String((seed.authors || [])[0] || '').split(/[ ,]/).filter(Boolean).pop() || '')} ${escapeHtml(seed.year)}</span>` : ''}`;
      if (els.discoveryModalSubtitle) els.discoveryModalSubtitle.textContent = `${totalItems.length} related paper${totalItems.length === 1 ? '' : 's'} found for "${seedTitle.slice(0, 60)}${seedTitle.length > 60 ? '…' : ''}".`;
      if (els.discoveryCountSummary) {
        els.discoveryCountSummary.innerHTML = searching
          ? `<strong>${totalItems.length} candidates so far</strong>`
          : `<strong>${totalItems.length} paper${totalItems.length === 1 ? '' : 's'}</strong> <span>· ${strengthCount('strong')} strong · ${strengthCount('related')} related · ${strengthCount('explore')} to explore</span>`;
      }
      const runInfo = discoveryRunInfoForModal();
      const rankingNotice = document.getElementById('discoveryRankingNotice');
      if (rankingNotice) rankingNotice.textContent = runInfo.rankingNotice || 'Ranked by research relevance · scores are relative, not probabilities';
      const details = document.getElementById('discoverySearchDetailsContent');
      if (details) details.innerHTML = '<div>' + escapeHtml((runInfo.queryPlan || []).length + ' focused queries · ' + Object.entries(runInfo.sourceCounts || {}).map(([name, count]) => (DISCOVERY_SOURCE_LABELS[name] || name) + ': ' + count).join(' · ')) + '</div>' + (runInfo.queryPlan || []).slice(0, 8).map(query => `<div>${escapeHtml(query.label || query.kind || 'Query')}: ${escapeHtml(query.text || query.query || '')}</div>`).join('');

      const rows = discoverySourceRows();
      const sourceStatus = document.getElementById('discoverySourceStatus');
      if (sourceStatus) sourceStatus.innerHTML = rows.map(row => `<span class="dv-source is-${row.status}" title="${escapeHtml(row.detail)}"><i></i>${escapeHtml(row.name)}${row.status === 'ok' && /papers/.test(row.detail) ? ` ${escapeHtml(row.detail.replace(' papers', ''))}` : row.status === 'fail' ? ' failed' : row.status === 'warn' ? ' limited' : ''}</span>`).join('');
      const notice = document.getElementById('discoverySourceNotice');
      if (notice) {
        const problems = rows.filter(row => row.status === 'fail' || row.status === 'warn');
        const stopped = runInfo.stoppedEarly ? ['Stopped early: results come only from the sources that had finished'] : [];
        const messages = [...stopped, ...problems.map(row => `${row.name}: ${row.detail}`)];
        notice.hidden = !messages.length || Boolean(searching);
        notice.textContent = messages.length ? 'Partial results · ' + messages.join(' · ') : '';
      }
      const progress = document.getElementById('discoveryProgressPanel');
      if (progress) {
        progress.hidden = !searching;
        if (searching) {
          const job = searching.job || {};
          const percent = job.stage === 'ranking' ? 95 : Math.round(85 * (job.completed || 0) / Math.max(1, job.total || rows.length || 1));
          progress.innerHTML = `
            <div class="dv-progress-head">
              <strong>${job.stage === 'ranking' ? 'Ranking results…' : `Searching ${rows.length || ''} source${rows.length === 1 ? '' : 's'}…`}</strong>
              <span>${job.total ? `${job.completed || 0} of ${job.total} done · ` : ''}${totalItems.length} candidates so far · ${discoveryElapsed(searching.startedAt)} elapsed</span>
              <span class="dv-progress-bar"><span style="width:${percent}%"></span></span>
              <button type="button" class="dv-btn" data-dv-action="stop-review">Stop and review</button>
            </div>
            <div class="dv-progress-sources">${rows.map(row => `<div class="dv-source-card is-${row.status}"><i></i><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.detail)}</small></span>${row.status === 'warn' ? '<button type="button" class="dv-btn small" data-dv-action="open-settings">Add key</button>' : ''}</div>`).join('')}</div>`;
        }
      }

      const queues = document.getElementById('discoveryQueues');
      if (queues) {
        const count = id => totalItems.filter(item => discoveryQueueOf(item) === id).length;
        const active = state.discoveryQueue || 'review';
        queues.innerHTML = [['review', 'To review'], ['relevant', 'Relevant'], ['not', 'Not relevant'], ['library', 'Already in library'], ['all', 'All results']]
          .map(([id, label]) => `<button type="button" data-dv-queue="${id}" aria-pressed="${active === id}"><span>${label}</span><span>${id === 'all' ? totalItems.length : count(id)}</span></button>`).join('');
      }
      const why = document.getElementById('discoveryWhyFilters');
      if (why) {
        const chosen = state.discoveryWhyKinds || new Set();
        why.innerHTML = '<legend>Why it was found</legend>' + DISCOVERY_WHY_FILTERS.map(([id, label]) => {
          const n = totalItems.filter(item => discoveryWhy(item).some(reason => discoveryWhyGroup(reason.kind) === id)).length;
          return n ? `<label><input type="checkbox" data-dv-why="${id}" ${chosen.has(id) ? 'checked' : ''}>${label}<span>${n}</span></label>` : '';
        }).join('');
      }
      const strengths = document.getElementById('discoveryStrengthFilters');
      if (strengths) {
        const hidden = state.discoveryHiddenStrengths || new Set();
        strengths.innerHTML = '<legend>Match strength</legend>' + DISCOVERY_STRENGTHS.map(([id, label]) => `<label><input type="checkbox" data-dv-strength="${id}" ${hidden.has(id) ? '' : 'checked'}>${label}<span>${strengthCount(id)}</span></label>`).join('');
      }
      const chart = document.getElementById('discoveryYearChart');
      if (chart) {
        const buckets = discoveryYearBuckets(totalItems);
        const peak = Math.max(1, ...buckets.map(bucket => bucket.count));
        chart.setAttribute('aria-label', 'Results by publication year: ' + buckets.map(bucket => `${bucket.count} from ${bucket.start}${bucket.end !== bucket.start ? ' to ' + bucket.end : ''}`).join(', '));
        chart.innerHTML = buckets.length ? `<div class="dv-bars">${buckets.map(bucket => `<span title="${bucket.start}${bucket.end !== bucket.start ? '–' + bucket.end : ''}: ${bucket.count}"><small>${bucket.count}</small><i style="height:${Math.max(3, Math.round(bucket.count / peak * 40))}px"></i></span>`).join('')}</div><div class="dv-bar-range"><span>${buckets[0].start}</span><span>${buckets[buckets.length - 1].end}</span></div>` : '';
      }
      const fullTextCount = document.getElementById('discoveryFullTextCount');
      if (fullTextCount) fullTextCount.textContent = String(totalItems.filter(item => safeHref(item.fullTextUrl || '')).length);

      updateDiscoverySelection();
      if (!els.discoveryPaperList) return;
      const focused = filtered.find(item => discoveryPaperKey(item) === state.discoveryFocusKey) || filtered[0] || null;
      state.discoveryFocusKey = focused ? discoveryPaperKey(focused) : null;
      const preview = document.getElementById('discoveryPreview');
      if (preview) preview.innerHTML = discoveryPreviewMarkup(focused, Boolean(searching));

      if (!filtered.length) {
        els.discoveryPaperList.innerHTML = `
          <div class="discovery-empty-state">
            <div class="discovery-empty-text">${searching ? 'Waiting for the first results…' : totalItems.length ? 'No papers match your filters' : 'No related papers returned'}</div>
            <div class="discovery-empty-subtext">${searching ? 'Sources report back one at a time; this can take a few minutes.' : totalItems.length ? 'Try another queue, reset the filters, or include more match strengths.' : 'Try broader keywords, fewer exclusions or another search source.'}</div>
          </div>`;
        return;
      }
      const focusKey = state.discoveryFocusKey;
      if ((state.discoverySortBy || 'score') === 'score') {
        els.discoveryPaperList.innerHTML = DISCOVERY_STRENGTHS.map(([id, label]) => {
          const items = filtered.filter(item => discoveryStrength(item) === id);
          if (!items.length) return '';
          const collapsed = id === 'explore' && !state.discoveryShowExplore && filtered.some(item => discoveryStrength(item) !== 'explore');
          return `<section class="dv-group" aria-label="${label}">
            <div class="dv-group-head"><h3>${label} <span>· ${items.length}</span></h3>${searching ? '' : `<button type="button" data-dv-select-group="${id}">Select all</button>`}</div>
            ${collapsed ? `<button type="button" class="dv-show-more" data-dv-action="show-explore">Show ${items.length} paper${items.length === 1 ? '' : 's'} worth exploring</button>` : items.map(item => discoveryRowMarkup(item, focusKey, Boolean(searching))).join('')}
          </section>`;
        }).join('');
      } else {
        els.discoveryPaperList.innerHTML = filtered.map(item => discoveryRowMarkup(item, focusKey, Boolean(searching))).join('');
      }
      els.discoveryPaperList.querySelectorAll('.discovery-item-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', () => setDiscoveryPaperSelected(checkbox.dataset.paperKey, checkbox.checked));
      });
      initDiscoveryWorkspace();
    }

    function focusDiscoveryPaper(key, scroll = true) {
      state.discoveryFocusKey = key;
      renderDiscoveryModal();
      if (scroll) els.discoveryPaperList?.querySelector(`[data-paper-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    function stepDiscoveryFocus(offset) {
      const items = getFilteredDiscoveryPapers().filter(item => (state.discoverySortBy || 'score') !== 'score' || discoveryStrength(item) !== 'explore' || state.discoveryShowExplore || getFilteredDiscoveryPapers().every(other => discoveryStrength(other) === 'explore'));
      const index = items.findIndex(item => discoveryPaperKey(item) === state.discoveryFocusKey);
      const next = items[Math.max(0, Math.min(items.length - 1, index + offset))];
      if (next) focusDiscoveryPaper(discoveryPaperKey(next));
    }

    function gradeFocusedDiscovery(grade) {
      const item = (state.discoveryResults || []).find(result => discoveryPaperKey(result) === state.discoveryFocusKey);
      if (!item || typeof labelDiscoveryPaper !== 'function') return;
      const before = getFilteredDiscoveryPapers();
      const index = before.findIndex(result => discoveryPaperKey(result) === state.discoveryFocusKey);
      labelDiscoveryPaper(item, discoveryRating(item) === grade ? undefined : grade);
      // In the review queue, labelled papers leave the list; move on to the next one.
      const after = getFilteredDiscoveryPapers();
      const next = after[Math.min(index, after.length - 1)];
      if (next) focusDiscoveryPaper(discoveryPaperKey(next));
    }

    function initDiscoveryWorkspace() {
      if (!els.discoveryModal?.dataset || typeof els.discoveryModal.addEventListener !== 'function' || els.discoveryModal.dataset.workspaceReady) return;
      els.discoveryModal.dataset.workspaceReady = '1';
      els.discoveryModal.addEventListener('click', event => {
        const target = event.target.closest?.('[data-dv-focus],[data-dv-queue],[data-dv-grade],[data-dv-action],[data-dv-select-group]');
        if (!target) return;
        if (target.dataset.dvFocus) return focusDiscoveryPaper(target.dataset.dvFocus, false);
        if (target.dataset.dvQueue) { state.discoveryQueue = target.dataset.dvQueue; state.discoveryFocusKey = null; return renderDiscoveryModal(); }
        if (target.dataset.dvGrade) { state.discoveryFocusKey = target.dataset.paperKey; return gradeFocusedDiscovery(Number(target.dataset.dvGrade)); }
        if (target.dataset.dvSelectGroup) {
          getFilteredDiscoveryPapers().filter(item => discoveryStrength(item) === target.dataset.dvSelectGroup).forEach(item => state.discoverySelectedKeys.add(discoveryPaperKey(item)));
          return renderDiscoveryModal();
        }
        const action = target.dataset.dvAction;
        const item = (state.discoveryResults || []).find(result => discoveryPaperKey(result) === target.dataset.paperKey);
        if (action === 'show-explore') { state.discoveryShowExplore = true; renderDiscoveryModal(); }
        else if (action === 'add-focused' && item) addSelectedDiscoveredToMap({ items: [item], keepOpen: true });
        else if (action === 'more-like' && item && typeof steerFromRecommendation === 'function') steerFromRecommendation((state.discoveryResults || []).indexOf(item), 'more');
        else if (action === 'less-like' && item && typeof steerFromRecommendation === 'function') steerFromRecommendation((state.discoveryResults || []).indexOf(item), 'less');
        else if (action === 'stop-review' && typeof cancelDiscoverySearch === 'function') { state.discoveryStopReview = true; cancelDiscoverySearch(); }
        else if (action === 'open-settings' && typeof setSettingsOpen === 'function') setSettingsOpen(true);
        else if (action === 'bulk-relevant' || action === 'bulk-not') {
          selectedDiscoveryPapers().forEach(result => labelDiscoveryPaper(result, action === 'bulk-relevant' ? 2 : 0));
          state.discoverySelectedKeys.clear();
          renderDiscoveryModal();
        } else if (action === 'bulk-export' && typeof recordRis === 'function') {
          const papers = selectedDiscoveryPapers().map(result => ({ ...result, title: cleanDiscoveryTitle(result.title), authors: Array.isArray(result.authors) ? result.authors : [] }));
          downloadRecordFile('pulse-discovery-selection.ris', recordRis(papers), 'application/x-research-info-systems');
          showToast(`Exported ${papers.length} citation${papers.length === 1 ? '' : 's'}.`);
        } else if (action === 'open-options' && typeof setDiscoveryOptionsOpen === 'function') { closeDiscoveryModal(); setDiscoveryOptionsOpen(true); }
        else if (action === 'run-again' && typeof runDiscoveryPipeline === 'function') runDiscoveryPipeline();
      });
      els.discoveryModal.addEventListener('change', event => {
        const input = event.target;
        if (input.dataset?.dvWhy) {
          state.discoveryWhyKinds = new Set(state.discoveryWhyKinds || []);
          if (input.checked) state.discoveryWhyKinds.add(input.dataset.dvWhy); else state.discoveryWhyKinds.delete(input.dataset.dvWhy);
          renderDiscoveryModal();
        } else if (input.dataset?.dvStrength) {
          state.discoveryHiddenStrengths = new Set(state.discoveryHiddenStrengths || []);
          if (input.checked) state.discoveryHiddenStrengths.delete(input.dataset.dvStrength); else state.discoveryHiddenStrengths.add(input.dataset.dvStrength);
          renderDiscoveryModal();
        }
      });
      els.discoveryModal.addEventListener('keydown', event => {
        if (els.discoveryModal.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === 'Escape') { event.preventDefault(); return closeDiscoveryModal(); }
        if (event.target.closest?.('input, textarea, select')) return;
        const key = event.key.toLowerCase();
        if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); stepDiscoveryFocus(1); }
        else if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); stepDiscoveryFocus(-1); }
        else if (state.discoverySearching) return;
        else if (key === 'r') { event.preventDefault(); gradeFocusedDiscovery(2); }
        else if (key === 'n') { event.preventDefault(); gradeFocusedDiscovery(0); }
        else if (key === 'a') {
          event.preventDefault();
          const item = (state.discoveryResults || []).find(result => discoveryPaperKey(result) === state.discoveryFocusKey);
          if (item && !recommendationAlreadyOnMap(item)) addSelectedDiscoveredToMap({ items: [item], keepOpen: true });
        } else if (event.key === ' ' && state.discoveryFocusKey) {
          event.preventDefault();
          setDiscoveryPaperSelected(state.discoveryFocusKey, !state.discoverySelectedKeys.has(state.discoveryFocusKey));
        }
      });
    }
