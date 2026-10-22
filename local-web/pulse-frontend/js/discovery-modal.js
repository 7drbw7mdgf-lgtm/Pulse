/* Discovery modal: opening, closing, selection and filtering of discovered papers. */
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
      const compareBtn = document.getElementById('discoveryCompareBtn');
      if (compareBtn) {
        const canCompare = selectedCount >= 2 && selectedCount <= 15;
        compareBtn.disabled = !canCompare;
        compareBtn.textContent = canCompare ? `Compare selected (${selectedCount})` : 'Compare selected';
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
