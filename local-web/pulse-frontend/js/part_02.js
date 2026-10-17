const discoveryBoundCheckboxes=new WeakSet();

    function openDiscoveryModal(results,seedPaper,resultKey=null) {
      const key=resultKey||(typeof recommendationKey==='function'&&typeof selectedPapersForRecommendation==='function'?recommendationKey(selectedPapersForRecommendation()):state.discoveryResultKey||null);
      const continuing=Boolean(state.discoverySearching&&state.discoverySearching.key===key);
      const keepSelected=continuing?new Set(state.discoverySelectedKeys||[]):new Set();
      const keepFocus=continuing&&state.discoveryFocusExplicit?state.discoveryFocusKey:null;
      if(state.discoveryResultKey!==key)state.discoveryRunContext=state.discoveryRunInfo?.get(key)?.runContext||null;
      state.discoveryResultKey=key;state.discoverySearching=null;
      if(continuing && state.discoveryUserTouchedRelevance && (state.discoveryResults||[]).length) {
        // The reviewer has started marking papers: keep their order, refresh paper
        // details in place, and offer the final ranking instead of reordering.
        const incoming=new Map((results||[]).map(paper=>[discoveryPaperKey(paper),paper]));
        const old=state.discoveryResults,keys=new Set(old.map(discoveryPaperKey));
        state.discoveryResults=[...old.map(paper=>incoming.get(discoveryPaperKey(paper))||paper),...(results||[]).filter(paper=>!keys.has(discoveryPaperKey(paper)))];
        state.discoveryPendingRefinedOrder=results||[];
        state.discoveryPendingRefinedOrderKey=key;
      } else {
        state.discoveryResults=results||[];
        state.discoveryPendingRefinedOrder=null;
        state.discoveryPendingRefinedOrderKey=null;
      }
      state.discoverySeed=seedPaper||state.papers.find(p=>p.id===state.selectedId)||state.papers[0];
      if(!continuing){
        state.discoveryUserTouchedRelevance=false;
        state.discoveryPendingRefinedOrder=null;
        state.discoveryPendingRefinedOrderKey=null;
        state.discoverySessionJudgedKeys=new Set();
        state.discoveryMovedUpNote='';
        state.discoveryMovedUpCount=0;
        Object.assign(state,{discoveryQueue:'review',discoveryWhyKinds:new Set(),discoveryHiddenStrengths:new Set(),discoveryShowExplore:false,
          discoveryMobilePane:'results',discoveryFiltersOpen:false,discoveryFilterText:'',discoveryFilterAuthor:'',discoveryFilterYear:'all',
          discoveryFilterBranch:'all',discoverySortBy:'score',discoveryQuickTag:'',discoveryFullTextOnly:false,discoveryExpandedAbstracts:new Set(),discoveryRenderLimit:100,discoveryPageSignature:''});
        for(const [element,value] of [[els.discoveryFilterText,''],[els.discoveryFilterAuthor,''],[els.discoveryFilterYear,'all'],[els.discoverySortBy,'score']])if(element)element.value=value;
        if(els.discoveryClearTextBtn)els.discoveryClearTextBtn.hidden=true;
        const fullText=document.getElementById('discoveryFullTextOnly');if(fullText)fullText.checked=false;
      }
      if(typeof warmDiscoveryFeedbackFeatures==='function')warmDiscoveryFeedbackFeatures(state.discoveryResults);
      state.discoveryFocusKey=keepFocus;state.discoveryFocusExplicit=Boolean(keepFocus);
      const valid=new Set(state.discoveryResults.map(discoveryPaperKey));state.discoverySelectedKeys=new Set([...keepSelected].filter(key=>valid.has(key)));
      if(els.discoveryModal)els.discoveryModal.hidden=false;
      renderDiscoveryModal({preservePosition:continuing});
      if(!continuing&&typeof els.discoveryModal?.querySelector==='function')els.discoveryModal.querySelector('.dv-card')?.focus();
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
      const restoreCheckbox = document.activeElement?.matches?.('.discovery-item-checkbox') && document.activeElement.dataset.paperKey === key;
      if (selected) {
        state.discoverySelectedKeys.add(key);
        state.discoveryFocusKey = key;
        state.discoveryFocusExplicit = true;
      } else {
        state.discoverySelectedKeys.delete(key);
        if (state.discoveryFocusKey === key) {
          const next = getFilteredDiscoveryPapers().find(item => state.discoverySelectedKeys.has(discoveryPaperKey(item)));
          state.discoveryFocusKey = next ? discoveryPaperKey(next) : null;
          state.discoveryFocusExplicit = Boolean(next);
        }
      }
      renderDiscoveryModal();
      if (restoreCheckbox) {
        [...(els.discoveryPaperList?.querySelectorAll('.discovery-item-checkbox') || [])].find(input => input.dataset.paperKey === key)?.focus({preventScroll:true});
      }
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
        if (queue !== 'all' && !state.discoverySearching && discoveryQueueOf(item) !== queue && !(queue === 'review' && state.discoverySessionJudgedKeys?.has(discoveryPaperKey(item)))) return false;
        if (hiddenStrengths.has(discoveryStrength(item))) return false;
        if (whyKinds.size && !discoveryWhy(item).some(reason => whyKinds.has(discoveryWhyGroup(reason.kind)))) return false;
        if (state.discoveryFullTextOnly && !safeHref(item.fullTextUrl || '')) return false;
        if (state.discoveryHideLibrary && discoveryQueueOf(item) === 'library') return false;
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
            ...(Array.isArray(item.authors) ? item.authors : [item.authors || '']),
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
          return (discoveryCitationCount(b) ?? -1) - (discoveryCitationCount(a) ?? -1);
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
        if (state.discoverySearching) {
          const isDirect = item => item.branch === 'citationGraph' || item.subType === 'Backward Citation' || item.subType === 'Forward Citation';
          const aDirect = isDirect(a);
          const bDirect = isDirect(b);
          if (aDirect !== bDirect) return aDirect ? -1 : 1;
        }
        return a.rank&&b.rank?a.rank-b.rank:(b.score || 0) - (a.score || 0);
      });
    }

    // ─── Discovery review workspace (1.7.1) ───
    const DISCOVERY_SOURCE_LABELS = {
      citationGraph: 'Citations', citationCoCitation: 'Co-citation', citationNetwork: 'DBEF', authorTrajectory: 'Author trajectory', semanticSearch: 'Semantic',
      lexicalConceptual: 'Semantic Scholar', europePmc: 'Europe PMC', core: 'CORE', fullText: 'Full-text'
    };
    const DISCOVERY_WHY_GROUPS = {
      authors: 'authors', 'senior-author': 'author-trajectory', 'first-author': 'author-trajectory', 'cites-seed': 'citations', 'cited-by-seed': 'citations', 'two-steps': 'citations',
      'co-cited': 'citations', 'shared-references': 'citations', topic: 'topic', question: 'topic', search: 'search', bridge: 'bridge', fulltext: 'fulltext'
    };
    const DISCOVERY_WHY_FILTERS = [['author-trajectory', 'Same senior or first author'], ['authors', 'Shares authors with your seed'], ['citations', 'Linked by citations'], ['topic', 'Matches your topic'], ['search', 'Found by search only'], ['bridge', 'Connects selected seeds'], ['fulltext', 'Matched full-text passages']];
    const DISCOVERY_STRENGTHS = [['strong', 'Strong matches'], ['related', 'Related'], ['explore', 'Worth exploring']];

    function discoveryStrength(item) {
      const rawLabel = item._initialMatchLabel !== undefined ? item._initialMatchLabel : item.matchLabel;
      const label = String(rawLabel || '').toLowerCase();
      if (label === 'not relevant') return 'explore';
      if (label === 'relevant') return item.strongMatchEligible === true ? 'strong' : 'related';
      if (label.startsWith('strong')) return item.strongMatchEligible === true ? 'strong' : 'related';
      if (label.startsWith('related')) return 'related';
      if (label.startsWith('explore')) return 'explore';
      const score = Number(item._initialScore !== undefined ? item._initialScore : item.score);
      return score >= 40 ? 'related' : 'explore';
    }

    function discoveryWhyGroup(kind) {
      return DISCOVERY_WHY_GROUPS[kind] || 'search';
    }

    // Results from before 1.7.1 have no whyFound; keep their specific reasons, drop the generic one.
    function discoveryWhy(item) {
      if (Array.isArray(item.whyFound) && item.whyFound.length) return item.whyFound;
      const trajectory = item.authorTrajectoryLabel ? [{ kind: item.authorRole === 'first' ? 'first-author' : 'senior-author', label: item.authorTrajectoryLabel, detail: item.reason || item.authorTrajectoryLabel }] : [];
      const reasons = (item.matchReasons || []).filter(reason => !/^Provider ranks combined/i.test(reason));
      if (reasons.length) return [...trajectory, ...reasons.map(reason => ({ kind: /citation/i.test(reason) ? 'cites-seed' : 'topic', label: reason, detail: reason }))];
      if (trajectory.length) return trajectory;
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

    function discoveryCitationCount(item) {
      const value = item.citedByCount ?? item.citationCount;
      if (Number.isInteger(value) && value > 0) return value;
      // Older cached records can have a default zero. Only show zero when the
      // provider actually supplied it, with matching count provenance.
      if (value === 0 && item.citationCountSource && item.citationCountSource !== 'CORE'
          && item.citationCountsBySource?.[item.citationCountSource] === 0) return 0;
      return null;
    }

    function discoveryCitationText(item) {
      const value = discoveryCitationCount(item);
      return value === null ? '—' : `${value.toLocaleString()} citation${value === 1 ? '' : 's'}`;
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
        const count = counts[key];
        // Compatibility with retained results from earlier app versions. An
        // informational notice must never hide an independent provider error.
        const legacyHopNotice = key === 'citationGraph' && /^Additional citation hops stopped at the time budget; direct citations and collected results are retained\.$/.test(error || '');
        const dbefNotice = (info.notices?.[key] || []).find(notice => notice.code?.startsWith('dbef-'));
        const extraHopLimit = legacyHopNotice || (info.notices?.[key] || []).some(notice => notice.code === 'extra-hop-limit');
        if(error&&/temporarily paused/i.test(error)){
          const seconds=String(error).match(/retry in (\d+) seconds/i)?.[1];
          return {key,name,status:'warn',count,canAddKey:false,detail:`Temporarily paused${seconds?' · retry in '+seconds+'s':''}${count>0?' · '+count+' papers retained':''}`};
        }
        if (error && !legacyHopNotice) {
          const limited = /429|rate|too many/i.test(error);
          const canAddKey = ['citationGraph', 'semanticSearch', 'lexicalConceptual', 'core'].includes(key);
          const partial = count > 0;
          return { key, name, status: partial || limited ? 'warn' : 'fail', canAddKey: limited && canAddKey,
            detail: partial ? `${count} papers retained · ${limited ? 'request limit reached' : 'some requests unavailable'}` : limited ? (canAddKey ? 'Request limit reached. Try later or add an API key in Settings.' : 'Request limit reached. Try again later.') : 'Search unavailable. Try again later.' };
        }
        if (searching && !done.has(key)) return { key, name, status: 'run', count,
          detail: count !== undefined ? `${count} papers so far · searching…` : 'Searching…' };
        return { key, name, status: 'ok', count,
          detail: `${count !== undefined ? `${count} papers` : 'Done'}${extraHopLimit ? ' · extra hops reached the limit' : dbefNotice?.code === 'dbef-limit' ? ' · collection limit reached' : dbefNotice?.code === 'dbef-no-references' ? ' · no indexed seed references' : ''}` };
      });
    }

    function discoveryPlannedSources(options) {
      const planned = [];
      if(options.fullTextSearch)planned.push('fullText');
      for (const key of ['citationGraph', 'citationNetwork', 'citationCoCitation', 'authorTrajectory', 'semanticSearch']) if (options.branches?.[key]) planned.push(key);
      if (options.branches?.lexicalSearch) {
        if (options.searchSources?.semanticScholar !== false) planned.push('lexicalConceptual');
        if (options.searchSources?.europePmc) planned.push('europePmc');
        if (options.searchSources?.core) planned.push('core');
        if (options.searchSources?.arxiv) planned.push('arxiv');
      }
      return planned;
    }

    function openDiscoverySearching(seedPaper, key, options) {
      state.discoverySearching = { key, seed: seedPaper, startedAt: Date.now(), job: null, planned: discoveryPlannedSources(options || {}) };
      state.discoveryResults = [];state.discoveryRenderLimit=100;state.discoveryPageSignature='';
      state.discoverySessionJudgedKeys = new Set();
      state.discoveryMovedUpNote = '';
      state.discoveryMovedUpCount = 0;
      Object.assign(state,{discoveryFilterText:'',discoveryFilterAuthor:'',discoveryFilterYear:'all',discoveryFilterBranch:'all',discoverySortBy:'score',discoveryQuickTag:'',discoveryShowExplore:false,discoveryWhyKinds:new Set(),discoveryHiddenStrengths:new Set(),discoveryFullTextOnly:false});
      for(const [element,value] of [[els.discoveryFilterText,''],[els.discoveryFilterAuthor,''],[els.discoveryFilterYear,'all'],[els.discoverySortBy,'score']])if(element)element.value=value;
      state.discoveryResultKey = key;
      state.discoverySeed = seedPaper;
      state.discoverySelectedKeys = new Set();
      state.discoveryFocusKey = null;
      state.discoveryFocusExplicit = false;
      state.discoveryQueue = 'review';
      if (els.discoveryModal) els.discoveryModal.hidden = false;
      renderDiscoveryModal();
    }

    function updateDiscoverySearching(job) {
      if (!state.discoverySearching) return;
      state.discoverySearching.job = job;
      if (!state.discoveryFocusExplicit) state.discoveryFocusKey = null;
      if (Array.isArray(job?.recommendations) && job.recommendations.length > 0) {
        if (state.discoveryUserTouchedRelevance) {
          state.discoveryPendingRefinedOrder = job.recommendations;
          state.discoveryPendingRefinedOrderKey = state.discoverySearching.key;
        } else {
          // Show the latest ranked order, but keep papers already on screen that
          // dropped out of the newest top 100, so nothing vanishes while reading.
          const latest=new Set(job.recommendations.map(discoveryPaperKey));
          state.discoveryResults=[...job.recommendations,...(state.discoveryResults||[]).filter(paper=>!latest.has(discoveryPaperKey(paper)))];
        }
      }
      if (els.discoveryModal && !els.discoveryModal.hidden) renderDiscoveryModal({preservePosition:true});
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
      const reasonsList = discoveryWhy(item).map(reason => ({ label: reason.label, detail: reason.detail || reason.label, kind: reason.kind }));
      const conceptsList = (item.matchedConcepts || item.paperKeywords || []).map(k => ({ label: k, detail: k, kind: 'concept' }));
      const seenLabels = new Set();
      const allPills = [];
      for (const p of [...reasonsList, ...conceptsList]) {
        if (!seenLabels.has(p.label)) {
          seenLabels.add(p.label);
          allPills.push(p);
        }
      }
      const reasons = allPills.slice(0, 4).map(p => `<span class="dv-reason${p.kind === 'senior-author' || p.kind === 'first-author' ? ' is-author-trajectory' : ''}" title="${escapeHtml(p.detail)}">${escapeHtml(p.label)}</span>`).join('')
        + (safeHref(item.fullTextUrl || '') ? '<span class="dv-reason is-fulltext">Full text available</span>' : '');
      const meta = [discoveryAuthorLine(item), item.year || item.date || '', item.journal || item.venue || ''].filter(Boolean).join(' · ');
      return `
        <article class="discovery-paper-item dv-row${isSelected ? ' is-selected' : ''}${key === focusedKey ? ' is-focused' : ''}" data-paper-key="${escapeHtml(key)}" role="listitem">
          ${searching ? '' : `<input type="checkbox" class="discovery-item-checkbox" data-paper-key="${escapeHtml(key)}" ${isSelected ? 'checked' : ''} aria-label="${escapeHtml(`Select ${cleanDiscoveryTitle(item.title)}`)}">`}
          <button class="dv-row-main" type="button" data-dv-focus="${escapeHtml(key)}" aria-current="${key === focusedKey}">
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
      const openUrl = typeof paperOpenUrl === 'function' ? paperOpenUrl(item) : '';
      const href = safeHref(openUrl || item.url || (item.doi ? `https://doi.org/${item.doi}` : ''));
      const fullText = safeHref(item.fullTextUrl || '');
      const versions = (item.relatedVersions || []).map(version => {
        const versionOpen = typeof paperOpenUrl === 'function' ? paperOpenUrl(version) : '';
        const link = safeHref(versionOpen || version.url || (version.doi ? `https://doi.org/${version.doi}` : ''));
        const label = [version.year, (version.sourceList || []).join(', ') || version.documentType || 'Other version'].filter(Boolean).join(' · ');
        return link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
      }).join('');
      const publication = [item.year || item.date || '', item.journal || item.venue || ''].filter(Boolean).join(' · ');
      const citationText = discoveryCitationText(item);
      const doi = (typeof normalizeDoi === 'function' ? normalizeDoi(item.doi || '') : '') || (item.doi || '').trim();
      const doiHref = doi ? safeHref(`https://doi.org/${encodeURI(doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, ''))}`) : '';
      const strengthLabel = item.matchLabel === 'Relevant' ? 'Relevant' : strength === 'strong' ? 'Strong' : strength === 'related' ? 'Related' : 'Explore';
      const whyReasons = discoveryWhy(item);
      const trajectoryReason = whyReasons.find(r => r.kind === 'senior-author' || r.kind === 'first-author');
      const trajectoryBadge = item.authorTrajectoryLabel || trajectoryReason?.label || '';
      return `
        <div class="dv-preview-heading"><span>Paper preview</span><button type="button" class="dv-link dv-preview-back" data-dv-action="show-results">Back to results</button></div>
        <div class="dv-preview-scroll" tabindex="0" aria-label="Read paper abstract">
          <div class="dv-preview-badges">
            <span class="dv-strength is-${strength}">${escapeHtml(strengthLabel)}</span>
            ${trajectoryBadge ? `<span class="dv-badge dv-author-trajectory" title="${escapeHtml(trajectoryReason?.detail || item.reason || trajectoryBadge)}">${escapeHtml(trajectoryBadge)}</span>` : ''}
            ${Number.isFinite(item.score) ? `<span class="dv-score" title="Scores are relative within this search, not probabilities">${Math.round(item.score)} / 100 relative</span>` : ''}
          </div>
          <h3 class="dv-preview-title">${escapeHtml(cleanDiscoveryTitle(item.title))}</h3>
          ${typeof publicationMarkup==='function'?publicationMarkup(item):''}
          <div class="dv-preview-meta">
            <p>${escapeHtml(discoveryAuthorLine(item, 6))}${publication ? ` · ${escapeHtml(publication)}` : ''}</p>
          </div>
          <div class="dv-paper-facts">${doiHref ? `<a href="${escapeHtml(doiHref)}" target="_blank" rel="noreferrer" aria-label="DOI ${escapeHtml(doi)}">${escapeHtml(doi)}</a>\n` : ''}<span title="${escapeHtml(item.citationCountSource || '')}">${citationText === '—' ? 'Citation count unavailable' : escapeHtml(citationText)}</span></div>
          <div class="dv-suggested-card">
            <h4>WHY PULSE SUGGESTED THIS</h4>
            <ul>
              ${whyReasons.map(reason => `<li><span class="dv-check-icon">✓</span> <span>${escapeHtml(reason.detail || reason.label)}</span></li>`).join('')}
              ${fullText ? `<li><span class="dv-check-icon">✓</span> <span>Free full text available</span></li>` : ''}
            </ul>
          </div>
          ${(Array.isArray(item.citationContexts) && item.citationContexts.length) || (Array.isArray(item.citationIntents) && item.citationIntents.length) || item.isInfluentialCitation ? `
            <section class="dv-citation-context">
              <div class="dv-citation-context-head">
                <h4>How it cites your seed</h4>
                <div class="dv-citation-intents">
                  ${(item.citationIntents || []).slice(0, 3).map(intent => {
                    const label = /^method/i.test(intent) ? 'Methods' : /^result/i.test(intent) ? 'Results' : 'Background';
                    const cls = /^method/i.test(intent) ? 'is-methods' : /^result/i.test(intent) ? 'is-results' : 'is-background';
                    return `<span class="dv-intent-badge ${cls}">${escapeHtml(label)}</span>`;
                  }).join('')}
                  ${item.isInfluentialCitation ? '<span class="dv-intent-badge is-influential">Influential</span>' : ''}
                </div>
              </div>
              ${(item.citationContexts || []).length ? `<ul class="dv-citation-quotes">${(item.citationContexts || []).slice(0, 3).map(ctx => `<li>“${escapeHtml(String(ctx || '').slice(0, 300))}”</li>`).join('')}</ul>` : ''}
            </section>` : ''}
          ${item.abstract ? `
            <section class="dv-abstract">
              <h4>ABSTRACT</h4>
              <p>${escapeHtml(item.abstract)}</p>
            </section>` : '<p class="dv-muted">No abstract available from these sources.</p>'}
          <div class="dv-why" style="display:none" hidden></div>
          <div class="dv-links">
            ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open paper</a>` : ''}
            ${fullText && fullText !== href ? `<a href="${escapeHtml(fullText)}" target="_blank" rel="noreferrer" class="dv-fulltext-link">Full text</a>` : ''}
            ${searching ? '' : `<button type="button" data-dv-action="more-like" data-paper-key="${escapeHtml(key)}">More like this</button><button type="button" data-dv-action="less-like" data-paper-key="${escapeHtml(key)}">Fewer like this</button>`}
          </div>
          ${item.isBridge ? `<section class="dv-bridge"><h4>Connections across seeds</h4><ul>${(item.bridgeEvidence||[]).map(row=>`<li><strong>${escapeHtml(row.seedTitle)}</strong><br>${escapeHtml(row.evidence)}</li>`).join('')}</ul></section>` : ''}
          ${item.aiReview ? `<p class="dv-muted">AI review: ${escapeHtml(item.aiReview.decision.replace(/_/g,' '))} · ${escapeHtml(item.aiReview.reason)}</p>` : ''}
          <section class="dv-passages"><button type="button" data-dv-action="read-passages" data-paper-key="${escapeHtml(key)}">Read source passages</button>${typeof discoveryPassageMarkup==='function'?discoveryPassageMarkup(item):''}</section>
          ${versions ? `<section class="dv-versions"><h4>Other versions</h4><div>${versions}</div></section>` : ''}
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

    function captureDiscoveryPosition(list) {
      if(!list?.getBoundingClientRect)return null;
      const top=list.getBoundingClientRect().top;
      const anchor=[...list.querySelectorAll('.dv-row')].find(row=>row.getBoundingClientRect().bottom>top);
      const active=document.activeElement;
      return {key:anchor?.dataset.paperKey,offset:anchor?anchor.getBoundingClientRect().top-top:0,scrollTop:list.scrollTop,
        activeKey:list.contains(active)?active.closest?.('.dv-row')?.dataset.paperKey:null,activeCheckbox:active?.classList?.contains('discovery-item-checkbox')};
    }
    function restoreDiscoveryPosition(list,position) {
      if(!position)return;
      const row=[...list.querySelectorAll('.dv-row')].find(row=>row.dataset.paperKey===position.key);
      list.scrollTop=row?list.scrollTop+row.getBoundingClientRect().top-list.getBoundingClientRect().top-position.offset:position.scrollTop;
      const active=[...list.querySelectorAll('.dv-row')].find(row=>row.dataset.paperKey===position.activeKey);
      active?.querySelector(position.activeCheckbox?'.discovery-item-checkbox':'.dv-row-main')?.focus({preventScroll:true});
    }
    function reconcileDiscoveryRows(list,html) {
      if(typeof document.createElement!=='function'){list.innerHTML=html;return;}
      const template=document.createElement('template');
      if(!template.content){list.innerHTML=html;return;}
      template.innerHTML=html;
      const existing=new Map([...list.querySelectorAll('.dv-row')].map(row=>[row.dataset.paperKey,row]));
      for(const row of template.content.querySelectorAll('.dv-row')){
        const previous=existing.get(row.dataset.paperKey);
        if(previous&&previous.outerHTML===row.outerHTML)row.replaceWith(previous);
      }
      list.replaceChildren(template.content);
    }

    function renderDiscoveryModal(options={}) {
      if (!els.discoveryModal || els.discoveryModal.hidden) return;
      const searching = state.discoverySearching;
      const totalItems = state.discoveryResults || [];
      const filtered = getFilteredDiscoveryPapers();
      const signature=JSON.stringify([state.discoveryResultKey,state.discoveryFilterText,state.discoveryFilterAuthor,state.discoveryFilterYear,state.discoverySortBy,state.discoveryQueue,[...(state.discoveryHiddenStrengths||[])],[...(state.discoveryWhyKinds||[])],state.discoveryShowExplore,state.discoveryQuickTag,state.discoveryFullTextOnly,state.discoveryHideLibrary,state.discoveryFilterBranch]);
      const sameView=signature===state.discoveryPageSignature;
      if(!sameView){state.discoveryRenderLimit=100;state.discoveryPageSignature=signature;}
      const position=(sameView||options.preservePosition)?captureDiscoveryPosition(els.discoveryPaperList):null;
      const previewEl=document.getElementById('discoveryPreview');
      const previewScroll=previewEl?.querySelector?.('.dv-preview-scroll')?.scrollTop||0;
      const activePreviewGrade=previewEl?.contains?.(document.activeElement)?document.activeElement?.dataset?.dvGrade:null;
      const oldPreviewKey=state.discoveryFocusKey;
      const seed = searching?.seed || state.discoverySeed;
      const seedTitle = cleanDiscoveryTitle(seed?.title || 'Selected seed paper');
      const conceptMode=Boolean(seed?.isConceptQuery);
      const strengthCount = id => totalItems.filter(item => discoveryStrength(item) === id).length;

      const title = document.getElementById('discoveryModalTitle');
      if (title) title.textContent = conceptMode?'Concept search':'Literature discovery';
      const bridgeSeeds=!conceptMode&&state.discoveryRunContext?.bridgeMode?(state.discoveryRunContext.seedPapers||[]):[];
      const eyebrow=document.getElementById('discoveryModalEyebrow');if(eyebrow)eyebrow.textContent=conceptMode?'Papers matching your concept':bridgeSeeds.length>1?`Bridging ${bridgeSeeds.length} selected papers`:'Related to your seed paper';
      const bridgeTitle=bridgeSeeds.slice(0,3).map(paper=>cleanDiscoveryTitle(paper.title||'Untitled')).join(' ↔ ')+(bridgeSeeds.length>3?` + ${bridgeSeeds.length-3} more`:'');
      if (els.discoveryModalSubtitle) els.discoveryModalSubtitle.textContent = bridgeSeeds.length>1?bridgeTitle:seedTitle;
      if (els.discoveryModal.dataset) {
        els.discoveryModal.dataset.pane = state.discoveryMobilePane || 'results';
        els.discoveryModal.dataset.filtersOpen = String(Boolean(state.discoveryFiltersOpen));
      }
      document.getElementById('discoveryFiltersBtn')?.setAttribute('aria-expanded', String(Boolean(state.discoveryFiltersOpen)));
      if (els.discoveryCountSummary) {
        const movedNote = !searching && state.discoveryMovedUpNote ? ` · <span class="dv-moved-note" role="status">${escapeHtml(state.discoveryMovedUpNote)}</span>` : '';
        els.discoveryCountSummary.innerHTML = searching
          ? `<strong>${totalItems.length} candidates so far</strong>`
          : `<strong>${totalItems.length} papers</strong> · <span>${strengthCount('strong')} strong</span> · <span>${strengthCount('related')} related</span> · <span>${strengthCount('explore')} to explore</span>${movedNote}`;
      }
      const footerNote = document.getElementById('discoveryFooterNote');
      if (footerNote) {
        footerNote.textContent = state.discoveryMovedUpNote
          ? `${state.discoveryMovedUpNote} below · refine or rerun this question to search with your feedback.`
          : 'Mark results, then refine or rerun this question to use your feedback.';
      }
      const runInfo = discoveryRunInfoForModal();
      const conceptSummary=document.getElementById('discoveryConceptSummary');
      if(conceptSummary){
        // Bridge searches show the concepts the selected papers share.
        const bridgeIntent=!conceptMode?(searching?.job?.bridgeConcept||runInfo.bridgeConcept):null;
        const intent=conceptMode?(searching?.job?.conceptSearch||runInfo.conceptSearch):bridgeIntent;
        const label=bridgeIntent?(intent?.aiAssisted?'Shared concepts':'Shared terms'):(intent?.aiAssisted?'AI search keywords':'Search keywords');
        conceptSummary.hidden=!intent?.keywords?.length;
        conceptSummary.innerHTML=intent?.keywords?.length?'<strong>'+label+'</strong>'+intent.keywords.map(term=>`<span class="dv-keyword">${escapeHtml(term)}</span>`).join('')+(intent.aiAssisted?'':`<small>${escapeHtml(intent.notice)}</small>`):'';
      }
      const refine = document.getElementById('discoveryRefineFeedback');
      if (refine) {
        const context=state.discoveryRunContext;
        const feedback = typeof discoveryFeedbackPayload === 'function' ? discoveryFeedbackPayload(context?.seedPapers||selectedPapersForRecommendation(),{...discoveryConfiguration(),researchQuestion:context?.researchQuestion||discoveryConfiguration().researchQuestion}).relevanceFeedback : [];
        refine.hidden = !feedback.length; refine.disabled = searching;
        refine.textContent = 'Refine with feedback (' + feedback.length + ')';
      }
      const rankingNotice = document.getElementById('discoveryRankingNotice');
      if (rankingNotice) rankingNotice.textContent = runInfo.rankingNotice || 'Ranked by research relevance · scores are relative, not probabilities';
      const details = document.getElementById('discoverySearchDetailsContent');
      if (details) details.innerHTML = '<div>' + escapeHtml((runInfo.queryPlan || []).length + ' focused queries · ' + (runInfo.candidateCount || totalItems.length) + ' candidates assessed · ' + (runInfo.feedbackApplied || 0) + ' relevance labels used · ' + (runInfo.bridgeCount || 0) + ' bridges · ' + (runInfo.aiReviewedCount || 0) + ' AI-reviewed · ' + Object.entries(runInfo.sourceCounts || {}).map(([name, count]) => (DISCOVERY_SOURCE_LABELS[name] || name) + ': ' + count).join(' · ')) + '</div>' + '<div>'+escapeHtml('Provider contributions: '+Object.entries(runInfo.providerContributions||{}).map(([name,count])=>name+': '+count).join(' · '))+'</div>' + '<div>'+escapeHtml(Object.entries(runInfo.sourceCooldowns||{}).map(([name,status])=>name+' paused · retry in '+status.retryInSeconds+'s').join(' · '))+'</div>' + (runInfo.queryPlan || []).slice(0, 8).map(query => `<div>${escapeHtml(query.label || query.kind || 'Query')}: ${escapeHtml(query.text || query.query || '')}</div>`).join('');

      const rows = discoverySourceRows();
      const sourceStatus = document.getElementById('discoverySourceStatus');
      if (sourceStatus) {
        sourceStatus.innerHTML = rows.map(row => {
          const countNum = row.count !== undefined ? ` ${row.count}` : '';
          const statusText = row.status === 'fail' ? ' failed' : row.status === 'warn' ? ' limited' : countNum;
          return `<span class="dv-source is-${row.status}" title="${escapeHtml(row.detail)}" aria-label="${escapeHtml(row.name + ': ' + row.detail)}"><span class="dv-dot"></span>${escapeHtml(row.name)}${statusText}</span>`;
        }).join('');
      }
      if (details && runInfo.dbef?.method) details.innerHTML += '<div>DBEF: '+escapeHtml(runInfo.dbef.candidateCount+' candidates · '+runInfo.dbef.referenceCount+' seed references · '+runInfo.dbef.corpusSizeSource)+'</div>';
      if (details && runInfo.feedbackConcepts) {
        const concepts=runInfo.feedbackConcepts;
        if(concepts.prefer?.length)details.innerHTML += '<div>'+escapeHtml('Feedback favors: '+concepts.prefer.join(', '))+'</div>';
        if(concepts.avoid?.length)details.innerHTML += '<div>'+escapeHtml('Feedback lowers: '+concepts.avoid.join(', '))+'</div>';
      }
      if (details) details.innerHTML += rows.map(row => `<div>${escapeHtml(row.name)}: ${escapeHtml(row.detail)}</div>`).join('');
      const notice = document.getElementById('discoverySourceNotice');
      if (notice) {
        const problems = rows.filter(row => row.status === 'fail' || row.status === 'warn');
        const stopped = runInfo.stoppedEarly ? ['Stopped early: showing results collected before the search stopped'] : [];
        notice.hidden = !(stopped.length || problems.length) || Boolean(searching);
        notice.textContent = stopped.length ? 'Search stopped. You can review the results collected so far.' : problems.length ? `Partial results · ${problems.map(row => row.name).join(', ')} unavailable or limited. See search details.` : '';
      }
      const openAlexCooldown = runInfo?.sourceCooldowns?.OpenAlex || searching?.job?.sourceCooldowns?.OpenAlex;
      const limitBanner = document.getElementById('openAlexLimitBanner');
      if (limitBanner) {
        if (openAlexCooldown && openAlexCooldown.retryInSeconds > 0) {
          const timeEl = document.getElementById('openAlexLimitTime');
          const expireTime = new Date(Date.now() + openAlexCooldown.retryInSeconds * 1000);
          const timeStr = expireTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          if (timeEl) timeEl.textContent = timeStr;
          limitBanner.hidden = false;
        } else {
          limitBanner.hidden = true;
        }
      }
      const progress = document.getElementById('discoveryProgressPanel');
      if (progress) {
        progress.hidden = !searching && !state.discoveryPendingRefinedOrder;
        progress.classList?.toggle('is-compact', Boolean((searching || state.discoveryPendingRefinedOrder) && totalItems.length));
        if (state.discoveryPendingRefinedOrder) {
          progress.innerHTML = `
            <div class="dv-progress-head">
              <strong>Refined ranking ready</strong>
              <span>New AI-scored ranking available based on full candidate analysis.</span>
              <button type="button" class="dv-btn primary" data-dv-action="apply-refined-order">Apply refined order</button>
            </div>`;
        } else if (searching) {
          const job = searching.job || {};
          const isRefining = job.stage === 'refining' || job.stage === 'ranking';
          const percent = isRefining ? 95 : Math.round(85 * (job.completed || 0) / Math.max(1, job.total || rows.length || 1));
          progress.innerHTML = `
            <div class="dv-progress-head">
              <strong>${job.stage === 'keywords' ? (job.searchMode === 'bridge' ? 'Finding what the selected papers share…' : 'Preparing search keywords…') : isRefining ? 'Refining…' : `Searching ${rows.length || ''} source${rows.length === 1 ? '' : 's'}…`}</strong>
              <span>${job.total ? `${job.completed || 0} of ${job.total} done · ` : ''}${totalItems.length} candidates so far · ${discoveryElapsed(searching.startedAt)} elapsed</span>
              <span class="dv-progress-bar"><span style="width:${percent}%"></span></span>
              <button type="button" class="dv-btn dv-btn-stop-review" data-dv-action="stop-review">Stop and review</button>
            </div>
            ${totalItems.length ? '' : `<div class="dv-progress-sources">${rows.map(row => `<div class="dv-source-card is-${row.status}"><i></i><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.detail)}</small></span>${row.canAddKey ? '<button type="button" class="dv-btn small" data-dv-action="open-settings">Add key</button>' : ''}</div>`).join('')}</div>`}`;
        }
      }

      const queues = document.getElementById('discoveryQueues');
      if (queues) {
        const count = id => totalItems.filter(item => discoveryQueueOf(item) === id).length;
        const active = state.discoveryQueue || 'review';
        queues.innerHTML = [['review', 'To review'], ['relevant', 'Relevant'], ['not', 'Not relevant'], ['library', 'Already in library']]
          .map(([id, label]) => `<button type="button" data-dv-queue="${id}" aria-pressed="${active === id}"><span>${label}</span><span>(${count(id)})</span></button>`).join('');
      }
      const why = document.getElementById('discoveryWhyFilters');
      if (why) {
        const chosen = state.discoveryWhyKinds || new Set();
        why.innerHTML = '<legend>Why it was found</legend>' + DISCOVERY_WHY_FILTERS.map(([id, label]) => {
          const n = totalItems.filter(item => discoveryWhy(item).some(reason => discoveryWhyGroup(reason.kind) === id)).length;
          return n ? `<label><input type="checkbox" data-dv-why="${id}" ${chosen.has(id) ? 'checked' : ''}><span>${label}</span><span>(${n})</span></label>` : '';
        }).join('');
      }
      const strengths = document.getElementById('discoveryStrengthFilters');
      if (strengths) {
        const hidden = state.discoveryHiddenStrengths || new Set();
        strengths.innerHTML = '<legend>Match strength</legend>' + DISCOVERY_STRENGTHS.map(([id, label]) => {
          const shortName = id === 'strong' ? 'Strong' : id === 'related' ? 'Related' : 'Worth exploring';
          return `<label><input type="checkbox" data-dv-strength="${id}" ${hidden.has(id) ? '' : 'checked'}><span>${shortName}</span><span>(${strengthCount(id)})</span></label>`;
        }).join('');
      }
      const chart = document.getElementById('discoveryYearChart');
      if (chart) {
        const buckets = discoveryYearBuckets(totalItems);
        const peak = Math.max(1, ...buckets.map(bucket => bucket.count));
        chart.setAttribute('aria-label', 'Results by publication year: ' + buckets.map(bucket => `${bucket.count} from ${bucket.start}${bucket.end !== bucket.start ? ' to ' + bucket.end : ''}`).join(', '));
        chart.innerHTML = buckets.length ? `<div class="dv-bars">${buckets.map(bucket => `<span title="${bucket.start}${bucket.end !== bucket.start ? '–' + bucket.end : ''}: ${bucket.count}"><small>${bucket.count}</small><i style="height:${Math.max(6, Math.round(bucket.count / peak * 36))}px"></i></span>`).join('')}</div><div class="dv-bar-range"><span>${buckets[0].start}</span><span>${buckets[buckets.length - 1].end}</span></div>` : '';
      }
      const fullTextCount = document.getElementById('discoveryFullTextCount');
      if (fullTextCount) fullTextCount.textContent = `(${totalItems.filter(item => safeHref(item.fullTextUrl || '')).length})`;
      const libraryCount = document.getElementById('discoveryLibraryCount');
      if (libraryCount) libraryCount.textContent = `(${totalItems.filter(item => discoveryQueueOf(item) === 'library').length})`;

      updateDiscoverySelection();
      if (!els.discoveryPaperList) return;
      const previousFocus = filtered.find(item => discoveryPaperKey(item) === state.discoveryFocusKey);
      const focused = previousFocus || filtered[0] || null;
      if (!previousFocus) state.discoveryFocusExplicit = false;
      state.discoveryFocusKey = focused ? discoveryPaperKey(focused) : null;
      const preview = document.getElementById('discoveryPreview');
      if (preview) {
        if (preview.dataset) preview.dataset.paperKey = state.discoveryFocusKey || '';
        preview.innerHTML = discoveryPreviewMarkup(focused, Boolean(searching));
        if(oldPreviewKey===state.discoveryFocusKey){
          const body=preview.querySelector?.('.dv-preview-scroll');if(body)body.scrollTop=previewScroll;
          if(activePreviewGrade)preview.querySelector?.(`[data-dv-grade="${activePreviewGrade}"]`)?.focus?.({preventScroll:true});
        }
      }

      if (!filtered.length) {
        els.discoveryPaperList.innerHTML = `
          <div class="discovery-empty-state">
            <div class="discovery-empty-text">${searching ? 'Waiting for the first results…' : totalItems.length ? 'No papers match your filters' : 'No related papers returned'}</div>
            <div class="discovery-empty-subtext">${searching ? 'Sources report back one at a time; this can take a few minutes.' : totalItems.length ? 'Try another queue, reset the filters, or include more match strengths.' : 'Try broader keywords, fewer exclusions or another search source.'}</div>
          </div>`;
        return;
      }
      const focusKey = state.discoveryFocusKey;
      const focusedIndex=filtered.findIndex(item=>discoveryPaperKey(item)===focusKey);
      if(state.discoveryFocusExplicit&&focusedIndex>=state.discoveryRenderLimit)state.discoveryRenderLimit=Math.ceil((focusedIndex+1)/100)*100;
      const visible=filtered.slice(0,state.discoveryRenderLimit||100);
      let html;
      if ((state.discoverySortBy || 'score') === 'score') {
        html = DISCOVERY_STRENGTHS.map(([id, label]) => {
          const items = visible.filter(item => discoveryStrength(item) === id);
          const totalGroup=filtered.filter(item=>discoveryStrength(item)===id).length;
          if (!items.length) return '';
          const groupTitle = id === 'strong' ? 'Strong matches' : id === 'related' ? 'Related' : 'Worth exploring';
          const selectGroupLabel = id === 'strong' ? 'Select all strong' : id === 'related' ? 'Select all related' : 'Select all explore';
          return `<section class="dv-group" aria-label="${label}">
            <div class="dv-group-head"><h3>${groupTitle} <span>· ${totalGroup}</span></h3>${searching ? '' : `<button type="button" data-dv-select-group="${id}">${selectGroupLabel}</button>`}</div>
            ${items.map(item => discoveryRowMarkup(item, focusKey, Boolean(searching))).join('')}
            ${id === 'strong' && items.length===totalGroup ? '<div class="dv-group-footer"><button type="button" class="dv-all-shown-btn" disabled>All strong matches shown</button></div>' : ''}
          </section>`;
        }).join('');
      } else {
        html = visible.map(item => discoveryRowMarkup(item, focusKey, Boolean(searching))).join('');
      }
      if(visible.length<filtered.length)html+=`<div class="dv-page-more"><span>${visible.length} of ${filtered.length} matching papers shown</span><button type="button" class="dv-btn" data-dv-action="load-more">Show next ${Math.min(100,filtered.length-visible.length)}</button></div>`;
      reconcileDiscoveryRows(els.discoveryPaperList,html);
      restoreDiscoveryPosition(els.discoveryPaperList,position);
      if(!sameView&&!options.preservePosition)els.discoveryPaperList.scrollTop=0;
      els.discoveryPaperList.querySelectorAll('.discovery-item-checkbox').forEach(checkbox => {
        if(discoveryBoundCheckboxes.has(checkbox))return;discoveryBoundCheckboxes.add(checkbox);
        checkbox.addEventListener('change', () => setDiscoveryPaperSelected(checkbox.dataset.paperKey, checkbox.checked));
      });
      initDiscoveryWorkspace();
    }

    function focusDiscoveryPaper(key, scroll = true) {
      state.discoveryFocusKey = key;
      state.discoveryFocusExplicit = true;
      state.discoveryMobilePane = 'preview';
      state.discoveryFiltersOpen = false;
      renderDiscoveryModal();
      if (scroll) scrollFocusedDiscoveryPaper();
    }

    function scrollFocusedDiscoveryPaper() {
      els.discoveryPaperList?.querySelector?.('.dv-row.is-focused')?.scrollIntoView({ block: 'nearest' });
    }

    function stepDiscoveryFocus(offset) {
      const items = getFilteredDiscoveryPapers();
      const index = items.findIndex(item => discoveryPaperKey(item) === state.discoveryFocusKey);
      const next = items[Math.max(0, Math.min(items.length - 1, index + offset))];
      if (next) focusDiscoveryPaper(discoveryPaperKey(next));
    }

    function gradeFocusedDiscovery(grade) {
      const item = (state.discoveryResults || []).find(result => discoveryPaperKey(result) === state.discoveryFocusKey);
      if (!item || typeof labelDiscoveryPaper !== 'function') return;
      state.discoveryUserTouchedRelevance = true;
      labelDiscoveryPaper(item, discoveryRating(item) === grade ? undefined : grade);
    }

    function initDiscoveryWorkspace() {
      if (!els.discoveryModal?.dataset || typeof els.discoveryModal.addEventListener !== 'function' || els.discoveryModal.dataset.workspaceReady) return;
      els.discoveryModal.dataset.workspaceReady = '1';

      const searchDetailsBtn = document.getElementById('discoverySearchDetailsBtn');
      const searchDetailsDetails = document.getElementById('discoverySearchDetails');
      if (searchDetailsBtn && searchDetailsDetails && !searchDetailsBtn.dataset.bound) {
        searchDetailsBtn.dataset.bound = '1';
        searchDetailsBtn.addEventListener('click', () => {
          searchDetailsDetails.hidden = !searchDetailsDetails.hidden;
          if (!searchDetailsDetails.hidden) searchDetailsDetails.open = true;
        });
      }

      const hideLibInput = document.getElementById('discoveryHideLibrary');
      if (hideLibInput && !hideLibInput.dataset.bound) {
        hideLibInput.dataset.bound = '1';
        hideLibInput.addEventListener('change', () => {
          state.discoveryHideLibrary = hideLibInput.checked;
          renderDiscoveryModal();
        });
      }

      els.discoveryModal.addEventListener('click', event => {
        const target = event.target.closest?.('[data-dv-focus],[data-dv-queue],[data-dv-grade],[data-dv-action],[data-dv-select-group]');
        if (!target) return;
        if (target.dataset.dvFocus) return focusDiscoveryPaper(target.dataset.dvFocus, false);
        if (target.dataset.dvQueue) { state.discoveryQueue = target.dataset.dvQueue; state.discoverySessionJudgedKeys = new Set(); state.discoveryMovedUpNote = ''; state.discoveryFocusKey = null; state.discoveryFiltersOpen = false; state.discoveryMobilePane = 'results'; return renderDiscoveryModal(); }
        if (target.dataset.dvGrade) { state.discoveryFocusKey = target.dataset.paperKey; return gradeFocusedDiscovery(Number(target.dataset.dvGrade)); }
        if (target.dataset.dvSelectGroup) {
          getFilteredDiscoveryPapers().filter(item => discoveryStrength(item) === target.dataset.dvSelectGroup).forEach(item => state.discoverySelectedKeys.add(discoveryPaperKey(item)));
          return renderDiscoveryModal();
        }
        const action = target.dataset.dvAction;
        const item = (state.discoveryResults || []).find(result => discoveryPaperKey(result) === target.dataset.paperKey);
        if (action === 'apply-refined-order') {
          if (state.discoveryPendingRefinedOrder) {
            state.discoveryResults = state.discoveryPendingRefinedOrder;
            state.discoveryPendingRefinedOrder = null;
            state.discoveryPendingRefinedOrderKey = null;
            state.discoveryUserTouchedRelevance = false;
            renderDiscoveryModal({preservePosition: true});
          }
        }
        else if(action==='load-more'){state.discoveryRenderLimit=(state.discoveryRenderLimit||100)+100;renderDiscoveryModal({preservePosition:true});}
        else if (action === 'toggle-filters') { state.discoveryFiltersOpen = !state.discoveryFiltersOpen; renderDiscoveryModal(); }
        else if (action === 'show-results') { state.discoveryMobilePane = 'results'; renderDiscoveryModal(); }
        else if (action === 'show-explore') { state.discoveryShowExplore = true; renderDiscoveryModal(); }
        else if (action === 'add-focused' && item) addSelectedDiscoveredToMap({ items: [item], keepOpen: true });
        else if (action === 'read-passages' && item) readDiscoveryPassages(item);
        else if (action === 'more-like' && item && typeof steerFromRecommendation === 'function') steerFromRecommendation((state.discoveryResults || []).indexOf(item), 'more');
        else if (action === 'less-like' && item && typeof steerFromRecommendation === 'function') steerFromRecommendation((state.discoveryResults || []).indexOf(item), 'less');
        else if (action === 'open-settings' && typeof setSettingsOpen === 'function') setSettingsOpen(true);
        else if (action === 'open-openalex-settings') {
          if (typeof setSettingsOpen === 'function') setSettingsOpen(true);
          if (typeof setSettingsTab === 'function') setSettingsTab('search');
          setTimeout(() => document.getElementById('openAlexApiKeyInput')?.focus(), 100);
        }
        else if (action === 'bulk-relevant' || action === 'bulk-not') {
          state.discoveryUserTouchedRelevance = true;
          selectedDiscoveryPapers().forEach(result => labelDiscoveryPaper(result, action === 'bulk-relevant' ? 2 : 0));
          state.discoverySelectedKeys.clear();
          renderDiscoveryModal();
        } else if (action === 'bulk-managers') {
          if (typeof openManagers === 'function') openManagers();
          else document.getElementById('libraryManagersDialog')?.showModal?.();
        } else if (action === 'bulk-export' && typeof recordRis === 'function') {
          const papers = selectedDiscoveryPapers().map(result => ({ ...result, title: cleanDiscoveryTitle(result.title), authors: Array.isArray(result.authors) ? result.authors : [] }));
          downloadRecordFile('pulse-discovery-selection.ris', recordRis(papers), 'application/x-research-info-systems');
          showToast(`Exported ${papers.length} citation${papers.length === 1 ? '' : 's'}.`);
        } else if (action === 'open-options' && typeof setDiscoveryOptionsOpen === 'function') { closeDiscoveryModal(); setDiscoveryOptionsOpen(true); }
        else if (action === 'run-again' && typeof repeatDiscoverySearch === 'function') repeatDiscoverySearch();
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
