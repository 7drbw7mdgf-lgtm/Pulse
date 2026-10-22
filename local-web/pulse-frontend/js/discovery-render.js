/* Discovery workspace rendering, keyboard focus, grading and initialisation. */
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

      if(typeof PulseScreening!=='undefined')PulseScreening.render();
      if(typeof PulseSearch!=='undefined')PulseSearch.render();
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
          const papers=selectedDiscoveryPapers(),grade=action==='bulk-relevant'?2:0;
          const prior=papers.map(discoveryRating);
          if(typeof PulseScreening!=='undefined'&&!PulseScreening.canBatch(papers.length))return showToast('Screen up to 500 selected papers at a time.');
          papers.forEach(result=>labelDiscoveryPaper(result,grade,{screening:false,rerank:false,deferRender:true}));
          scheduleAutosave();
          if(typeof PulseScreening!=='undefined')PulseScreening.recordGrades(papers,grade,prior);
          state.discoverySelectedKeys.clear();
          renderDiscoveryModal();
        } else if (action === 'bulk-compare') {
          openDiscoveryCompareDialog(selectedDiscoveryPapers());
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
