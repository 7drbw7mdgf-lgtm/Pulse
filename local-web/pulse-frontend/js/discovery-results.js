/* Discovery result labels, sources, strength groups and row/preview markup. */
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
          ${typeof PulseEvidence!=='undefined'&&discoveryReviewContext().seedPapers?.some(p=>p.doi||p.pmid)?`<button class="dv-btn small" data-verify-citation="${escapeHtml(discoveryPaperKey(item))}">Verify citation passage</button>`:''}
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
