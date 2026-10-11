
    function openDiscoveryModal(results, seedPaper, resultKey=null) {
      if(typeof recommendationKey==='function'&&typeof selectedPapersForRecommendation==='function'){
        const activeKey=resultKey||recommendationKey(selectedPapersForRecommendation());
        if(state.discoveryResultKey!==activeKey)state.discoveryRunContext=state.discoveryRunInfo?.get(activeKey)?.runContext||null;
        state.discoveryResultKey=activeKey;
      }
      state.discoveryResults = results || [];
      state.discoverySeed = seedPaper || state.papers.find(p => p.id === state.selectedId) || state.papers[0];
      state.discoveryFilterText = '';
      state.discoveryFilterAuthor = '';
      state.discoveryFilterYear = 'all';
      state.discoveryFilterBranch = 'all';
      state.discoverySortBy = 'score';
      state.discoveryQuickTag = '';
      state.discoveryFullTextOnly = false;
      const fullTextToggle=document.getElementById('discoveryFullTextOnly');if(fullTextToggle)fullTextToggle.checked=false;
      state.discoveryExpandedAbstracts = new Set();

      state.discoverySelectedKeys = new Set();

      if (els.discoveryFilterText) els.discoveryFilterText.value = '';
      if (els.discoveryClearTextBtn) els.discoveryClearTextBtn.hidden = true;
      if (els.discoveryFilterAuthor) els.discoveryFilterAuthor.value = '';
      if (els.discoveryFilterYear) els.discoveryFilterYear.value = 'all';
      if (els.discoverySortBy) els.discoverySortBy.value = 'score';

      if (els.discoveryModal) els.discoveryModal.hidden = false;
      renderDiscoveryModal();
      if (els.discoveryFilterText) els.discoveryFilterText.focus();
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
        els.discoveryAddSelectedMapBtn.textContent = `⭐ Add Selected to Map (${selectedCount})`;
        els.discoveryAddSelectedMapBtn.disabled = selectedCount === 0;
      }
      if (els.discoveryAddSelectedLibraryBtn) {
        els.discoveryAddSelectedLibraryBtn.textContent = `+ Add to Library (${selectedCount})`;
        els.discoveryAddSelectedLibraryBtn.disabled = selectedCount === 0;
      }
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

      return items.filter(item => {
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
            item.reason || ''
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
          return (b.citedByCount ?? b.citationCount ?? 0) - (a.citedByCount ?? a.citationCount ?? 0);
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

    function renderDiscoveryModal() {
      if (!els.discoveryModal || els.discoveryModal.hidden) return;

      const totalItems = state.discoveryResults || [];
      const filtered = getFilteredDiscoveryPapers();

      if (els.discoveryModalSubtitle) {
        const seedTitle = state.discoverySeed?.title || 'Selected seed paper';
        els.discoveryModalSubtitle.textContent = `${totalItems.length} related paper${totalItems.length === 1 ? '' : 's'} found for "${seedTitle.slice(0, 60)}${seedTitle.length > 60 ? '...' : ''}" using your selected discovery options.`;
      }
      const runInfo=state.discoveryRunInfo?.get(state.discoveryResultKey||recommendationKey(selectedPapersForRecommendation()))||{};
      const rankingNotice=document.getElementById('discoveryRankingNotice');if(rankingNotice)rankingNotice.textContent=runInfo.rankingNotice||'Ranked by research relevance · scores are relative, not probabilities';
      const details=document.getElementById('discoverySearchDetailsContent');if(details)details.innerHTML='<div>'+escapeHtml((runInfo.queryPlan||[]).length+' focused queries · '+Object.entries(runInfo.sourceCounts||{}).map(([name,count])=>name+': '+count).join(' · '))+'</div>'+((runInfo.queryPlan||[]).map(query=>'<div>'+escapeHtml(query.text)+'</div>').join(''));
      const notice=document.getElementById('discoverySourceNotice');
      if(notice){
        const errors=state.discoverySearchErrors?.get(state.discoveryResultKey||recommendationKey(selectedPapersForRecommendation())) || {};
        const labels={europePmc:'Europe PMC',core:'CORE',lexicalConceptual:'Semantic Scholar search',citationGraph:'Citations',citationNetwork:'Citation network',semanticSearch:'Semantic search'};
        notice.hidden=!Object.keys(errors).length;
        notice.textContent=Object.keys(errors).length ? 'Partial results · '+Object.entries(errors).map(([source,message])=>{const label=labels[source]||source;return String(message).startsWith(label+':') ? String(message) : `${label}: ${message}`;}).join(' · ') : '';
      }

      const countSpecter = totalItems.filter(item => item.branch === 'semanticSearch' || item.branchHits?.semanticSearch || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'))).length;
      const countNetwork = totalItems.filter(item => item.branch === 'citationNetwork' || item.branchHits?.citationNetwork || (item.discoveryBadges || []).some(b => b.includes('Co-citation') || b.includes('Bib Coupling'))).length;
      const countCitation = totalItems.filter(item => item.branch === 'citationGraph' || item.branchHits?.citationGraph || (item.discoveryBadges || []).some(b => b.includes('Backward') || b.includes('Forward') || b.includes('2-Hop') || b.includes('Cite'))).length;
      const countLexical = totalItems.filter(item => item.branch === 'lexicalConceptual' || item.branchHits?.lexicalConceptual || (item.discoveryBadges || []).some(b => b.includes('Concept') || b.includes('Search'))).length;

      if (els.branchCountAll) els.branchCountAll.textContent = String(totalItems.length);
      if (els.branchCountSpecter) els.branchCountSpecter.textContent = String(countSpecter);
      if (els.branchCountNetwork) els.branchCountNetwork.textContent = String(countNetwork);
      if (els.branchCountCitation) els.branchCountCitation.textContent = String(countCitation);
      if (els.branchCountLexical) els.branchCountLexical.textContent = String(countLexical);

      els.discoveryModal.querySelectorAll('.branch-filter-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.branch === (state.discoveryFilterBranch || 'all'));
      });

      const tagFreq = new Map();
      totalItems.forEach(item => {
        (item.paperKeywords || []).concat(item.matchedConcepts || []).forEach(term => {
          const t = cleanField(term).trim();
          if (t && t.length > 2 && !stopwords.has(t.toLowerCase())) {
            const key = t.toLowerCase();
            tagFreq.set(key, { term: t, count: (tagFreq.get(key)?.count || 0) + 1 });
          }
        });
      });
      const topTags = Array.from(tagFreq.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      if (els.discoveryKeywordChipsRow && els.discoveryKeywordChipsList) {
        if (topTags.length > 0) {
          els.discoveryKeywordChipsRow.hidden = false;
          els.discoveryKeywordChipsList.innerHTML = topTags.map(tag => {
            const isActive = state.discoveryQuickTag?.toLowerCase() === tag.term.toLowerCase();
            return `<button class="discovery-filter-chip ${isActive ? 'is-active' : ''}" type="button" data-tag="${escapeHtml(tag.term)}">${escapeHtml(tag.term)} (${tag.count})</button>`;
          }).join('');
        } else {
          els.discoveryKeywordChipsRow.hidden = true;
        }
      }

      if (els.discoveryCountSummary) {
        els.discoveryCountSummary.textContent = `Showing ${filtered.length} of ${totalItems.length} papers`;
      }
      updateDiscoverySelection();

      if (!els.discoveryPaperList) return;
      if (!filtered.length) {
        els.discoveryPaperList.innerHTML = `
          <div class="discovery-empty-state">
            <span class="discovery-empty-icon">🔎</span>
            <div class="discovery-empty-text">${totalItems.length?"No papers match your filters":"No related papers returned"}</div>
            <div class="discovery-empty-subtext">${totalItems.length?"Reset filters or try another year or method.":"Try broader keywords, fewer exclusions or another search source."}</div>
          </div>
        `;
        return;
      }

      els.discoveryPaperList.innerHTML = filtered.map(item => {
        const key = discoveryPaperKey(item);
        const isSelected = state.discoverySelectedKeys.has(key);
        const inLibrary = recommendationAlreadyOnMap(item);
        const isExpanded = state.discoveryExpandedAbstracts.has(key);

        const authorList = Array.isArray(item.authors) ? item.authors : (item.authors ? [item.authors] : []);
        const authorStr = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';

        const metaParts = [
          authorStr,
          item.year || item.date || '',
          item.journal || item.venue || '',
          item.doi ? `DOI ${item.doi}` : '',
          Number.isFinite(item.citedByCount ?? item.citationCount) ? `${item.citedByCount ?? item.citationCount} citations${item.citationCountSource ? ' ('+item.citationCountSource+')' : ''}` : '',
          item.influentialCitationCount ? `⭐ ${item.influentialCitationCount} influential` : ''
        ].filter(Boolean);

        const badgesHtml = [...new Set([...(item.discoveryBadges || []),...(item.sourceList || [])])].map(b => {
          let cls = 'badge-general';
          if (b.includes('SPECTER2')) cls = 'badge-specter';
          else if (b.includes('Co-citation')) cls = 'badge-cocitation';
          else if (b.includes('Bib Coupling')) cls = 'badge-bibcoupling';
          else if (b.includes('2-Hop')) cls = 'badge-chase';
          else if (b.includes('Influential')) cls = 'badge-influential';
          else if (b.includes('Backward') || b.includes('Forward') || b.includes('Cite')) cls = 'badge-citation';
          else cls = 'badge-concept';
          return `<span class="discovery-badge ${cls}">${escapeHtml(b)}</span>`;
        }).join('');

        const scorePill = item.score !== undefined ? `<span class="discovery-score-pill-modal" title="${escapeHtml('Relative relevance '+Math.round(item.score)+' / 100 · not a probability')}">${escapeHtml(item.matchLabel||'Related')}</span>` : '';
        const matchReasons=(item.matchReasons||[]).slice(0,2).map(reason=>escapeHtml(reason)).join(' · ');
        const versions=(item.relatedVersions||[]).map(version=>{const link=safeHref(version.url||(version.doi?'https://doi.org/'+version.doi:''));return link?`<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(version.year||'Other version')} ↗</a>`:escapeHtml(version.title||'Other version');}).join(' · ');
        const rating=typeof discoveryRating==='function'?discoveryRating(item):undefined;
        const abstractText = item.abstract || item.reason || '';
        const href = safeHref(item.url || (item.doi ? `https://doi.org/${item.doi}` : ''));

        return `
          <article class="discovery-paper-item ${isSelected ? 'is-selected' : ''}" data-paper-key="${escapeHtml(key)}">
            <div class="discovery-checkbox-col">
              <input type="checkbox" class="discovery-item-checkbox" data-paper-key="${escapeHtml(key)}" ${isSelected ? 'checked' : ''} aria-label="${escapeHtml(`Select ${item.title || 'paper'}`)}">
            </div>
            <div class="discovery-paper-content">
              <div class="discovery-paper-top">
                <h3 class="discovery-paper-title">
                  ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">${escapeHtml(item.title || 'Untitled')}</a>` : escapeHtml(item.title || 'Untitled')}
                </h3>
                <div class="discovery-item-actions-top">
                  ${inLibrary ? '<span class="already-added-pill">✓ In Library</span>' : ''}
                  ${scorePill}
                </div>
              </div>

              <div class="discovery-paper-meta">
                ${metaParts.map(part => `<span>${escapeHtml(part)}</span>`).join('<span class="separator">•</span>')}
              </div>

              ${matchReasons?`<div class="discovery-match-reasons">${matchReasons}</div>`:''}
              ${versions?`<details class="discovery-versions" onclick="event.stopPropagation()"><summary>${item.relatedVersions.length} other version${item.relatedVersions.length===1?'':'s'}</summary>${versions}</details>`:''}
              ${badgesHtml ? `<div class="discovery-paper-badges">${badgesHtml}</div>` : ''}
              ${safeHref(item.fullTextUrl || '') ? `<a class="discovery-full-text-link" href="${escapeHtml(safeHref(item.fullTextUrl))}" target="_blank" rel="noreferrer">Available full text ↗</a>` : ''}

              ${abstractText ? `
                <div class="discovery-abstract-drawer" onclick="event.stopPropagation()">
                  <div class="discovery-abstract-text ${isExpanded ? '' : 'is-clamped'}">
                    ${escapeHtml(abstractText)}
                  </div>
                  ${abstractText.length > 140 ? `
                    <button class="discovery-abstract-expand-btn" type="button" data-toggle-abstract="${escapeHtml(key)}">
                      ${isExpanded ? '▲ Show less' : '▼ Show more abstract'}
                    </button>
                  ` : ''}
                </div>
              ` : ''}
              <div class="discovery-relevance-review"><span>Useful for your question?</span><button type="button" data-relevance-grade="2" data-paper-key="${escapeHtml(key)}" aria-pressed="${rating===2}">Relevant</button><button type="button" data-relevance-grade="0" data-paper-key="${escapeHtml(key)}" aria-pressed="${rating===0}">Not relevant</button></div>
            </div>
          </article>
        `;
      }).join('');

      els.discoveryPaperList.querySelectorAll('.discovery-paper-item').forEach(card => {
        card.addEventListener('click', event => {
          if (event.target.closest('a, input, button, details')) return;
          const key = card.dataset.paperKey;
          if (!key) return;
          setDiscoveryPaperSelected(key, !state.discoverySelectedKeys.has(key));
        });
      });

      els.discoveryPaperList.querySelectorAll('.discovery-item-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          const key = cb.dataset.paperKey;
          if (!key) return;
          setDiscoveryPaperSelected(key, cb.checked);
        });
      });

      els.discoveryPaperList.querySelectorAll('[data-toggle-abstract]').forEach(btn => {
        btn.addEventListener('click', event => {
          event.stopPropagation();
          const key = btn.dataset.toggleAbstract;
          if (state.discoveryExpandedAbstracts.has(key)) {
            state.discoveryExpandedAbstracts.delete(key);
          } else {
            state.discoveryExpandedAbstracts.add(key);
          }
          renderDiscoveryModal();
        });
      });

      if (els.discoveryKeywordChipsList) {
        els.discoveryKeywordChipsList.querySelectorAll('.discovery-filter-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const tag = btn.dataset.tag;
            if (state.discoveryQuickTag === tag) {
              state.discoveryQuickTag = '';
            } else {
              state.discoveryQuickTag = tag;
            }
            renderDiscoveryModal();
          });
        });
      }
    }
