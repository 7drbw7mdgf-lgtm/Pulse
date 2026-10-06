              <span class="discovery-hub-tag">S2AG Exploration</span>
              <h3>Literature Discovery</h3>
            </div>
            <button class="button small primary discovery-run-btn" data-action="run-discovery-pipeline" type="button" ${state.discoveryLoading ? 'disabled' : ''}>
              ${state.discoveryLoading ? '⏳ Discovering...' : '⚡ Discover Related'}
            </button>
          </div>

          <div class="quick-tools-row">
            <button class="qtool-btn" data-action="snowball-backward" type="button" title="Fetch references cited by this paper" ${state.citationLoading ? 'disabled' : ''}>← Refs</button>
            <button class="qtool-btn" data-action="snowball-forward" type="button" title="Fetch papers citing this work" ${state.citationLoading ? 'disabled' : ''}>Cites →</button>
            <button class="qtool-btn" data-action="chase-2hop" type="button" title="Iterative 2-Hop Chase" ${state.citationLoading ? 'disabled' : ''}>2-Hop ⟳</button>
            <button class="qtool-btn" data-action="network-triangulate" type="button" title="Co-citation & Bibliographic Coupling" ${state.citationLoading ? 'disabled' : ''}>Co-cite ⋈</button>
            <button class="qtool-btn" data-action="find-seminal" type="button" title="Foundational seminal papers" ${state.citationLoading ? 'disabled' : ''}>Seminal ⭐</button>
          </div>

          ${state.discoveryResults?.length ? `
            <button class="discovery-view-results-btn" data-action="open-discovery-results-modal" type="button">
              🔍 View Discovered Papers (${state.discoveryResults.length})
            </button>
          ` : ''}

          <div class="discovery-steer-toggle-row">
            <button class="button xs secondary steer-toggle-btn" data-action="toggle-recommend-steer" type="button">
              <span>🎯 Steer &amp; Ranking options</span>
              <span class="steer-toggle-arrow">${state.recommendationSteerOpen ? '▲' : '▼'}</span>
            </button>
          </div>

          <div class="recommend-steer-panel" ${state.recommendationSteerOpen ? '' : 'hidden'}>
            <div class="steer-compact-head">
              <h3>🎯 Steer &amp; Filter</h3>
              <span class="subtle">${state.recommendationSteerKeywords.length + state.graphSteerKeywords.length + state.recommendationExcludeKeywords.length} active</span>
            </div>
            <div class="steer-chips-unified">
              ${activeSteerChips || '<span class="subtle-empty">No active steer tags. Use buttons below or click tags.</span>'}
            </div>
            <div class="steer-input-compact-bar">
              <input id="newSteerTagInput" placeholder="Add tag..." autocomplete="off">
              <div class="steer-action-btn-group">
                <button class="button xs primary" id="addSteerTagBtn" type="button">+ Steer</button>
                <button class="button xs" id="addGraphTagBtn" type="button">🌐 Map</button>
                <button class="button xs danger" id="addExcludeTagBtn" type="button">⛔ Not</button>
              </div>
            </div>
          </div>

          ${state.seminalSuggestions?.length ? `
            <div id="seminalResults" class="recommendation-list">${renderSeminalMarkup()}</div>
          ` : ''}

          <div id="recommendationResults" class="recommendation-list">
            ${renderRecommendationMarkup(recommendations, isLoadingRecommendations)}
          </div>
        </div>

        <div class="inspector-footer-btns">
          <button class="inspector-action-large primary" data-action="add-as-new-seed" type="button">
            🌱 Add as new seed
          </button>
          <button class="inspector-action-large secondary" data-action="find-similar-work" type="button">
            🔍 Find similar
          </button>
        </div>
      `;

      els.details.querySelector('[data-action="close-details"]')?.addEventListener('click', closePaperPopup);
      els.details.querySelector('[data-action="toggle-abstract"]')?.addEventListener('click', () => {
        state.detailsAbstractExpanded = !state.detailsAbstractExpanded;
        renderDetails();
      });
      els.details.querySelector('[data-action="toggle-paper-seed"]')?.addEventListener('click', () => {
        state.pinnedSeedId = state.pinnedSeedId === paper.id ? null : paper.id;
        renderDetails();
        scheduleAutosave();
        showToast(state.pinnedSeedId ? `Set "${compactTitle(paper.title)}" as discovery seed` : 'Cleared discovery seed');
      });
      els.details.querySelector('[data-action="add-as-new-seed"]')?.addEventListener('click', () => {
        state.pinnedSeedId = paper.id;
        state.discoverySeed = paper;
        runDiscoveryPipeline();
      });
      els.details.querySelector('[data-action="find-similar-work"]')?.addEventListener('click', () => {
        state.pinnedSeedId = paper.id;
        state.discoverySeed = paper;
        recommendSelectedPapers();
      });
      els.details.querySelector('[data-action="map-citations"]')?.addEventListener('click', mapCitationTopology);
      els.details.querySelector('[data-action="find-seminal"]')?.addEventListener('click', findMissingSeminal);
      els.details.querySelector('[data-action="snowball-backward"]')?.addEventListener('click', () => snowballSelectedPaper('backward'));
      els.details.querySelector('[data-action="snowball-forward"]')?.addEventListener('click', () => snowballSelectedPaper('forward'));
      els.details.querySelector('[data-action="chase-2hop"]')?.addEventListener('click', chase2HopSelectedPaper);
      els.details.querySelector('[data-action="network-triangulate"]')?.addEventListener('click', triangulateNetworkSelectedPaper);
      els.details.querySelector('[data-action="run-discovery-pipeline"]')?.addEventListener('click', runDiscoveryPipeline);
      els.details.querySelector('[data-action="open-discovery-results-modal"]')?.addEventListener('click', () => {
        if (state.discoveryResults?.length) openDiscoveryModal(state.discoveryResults, state.discoverySeed || paper);
      });
      els.details.querySelectorAll('[data-action="toggle-branch"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const branch = btn.dataset.branch;
          if (branch && state.discoveryBranches[branch] !== undefined) {
            state.discoveryBranches[branch] = !state.discoveryBranches[branch];
            render();
          }
        });
      });
      els.details.querySelector('[data-action="recommend"]')?.addEventListener('click', recommendSelectedPapers);
      els.details.querySelector('[data-action="toggle-recommend-steer"]')?.addEventListener('click', () => setRecommendationSteerOpen(!state.recommendationSteerOpen));
      els.details.querySelectorAll('[data-action="open-paper-keywords"]').forEach(btn => {
        btn.addEventListener('click', () => openKeywordModal(btn.dataset.paper || paper.id));
      });
      els.details.querySelectorAll('[data-action="tag-action-menu"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          openTagActionMenu(btn.dataset.term, btn, paper.id);
        });
      });
      els.details.querySelectorAll('[data-action="quick-steer-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          toggleRecommendationSteer(btn.dataset.tag);
        });
      });
      const steerInput = els.details.querySelector('#newSteerTagInput');
      const steerAddBtn = els.details.querySelector('#addSteerTagBtn');
      steerAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleRecommendationSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      steerInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (steerInput.value) {
            toggleRecommendationSteer(steerInput.value);
            steerInput.value = '';
          }
        }
      });
      const graphAddBtn = els.details.querySelector('#addGraphTagBtn');
      graphAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleGraphSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      const excludeAddBtn = els.details.querySelector('#addExcludeTagBtn');
      excludeAddBtn?.addEventListener('click', () => {
        if (steerInput?.value) {
          toggleExcludeSteer(steerInput.value);
          steerInput.value = '';
        }
      });
      els.details.querySelectorAll('[data-action="view-related-link"]').forEach(item => {
        item.addEventListener('click', () => {
          if (item.dataset.link) selectLinkage(item.dataset.link);
        });
      });
      bindRecommendationSteerInputs();
      bindSteerChipButtons();
      els.details.querySelectorAll('[data-action="add-recommendation"]').forEach(button => {
        button.addEventListener('click', () => addRecommendedPaperToMap(Number(button.dataset.recIndex)));
      });
      els.details.querySelectorAll('[data-action="add-seminal"]').forEach(button => {
        button.addEventListener('click', () => addSeminalPaperToMap(Number(button.dataset.seminalIndex)));
      });
      els.details.querySelectorAll('[data-action="recommend-more-like"]').forEach(button => {
        button.addEventListener('click', () => steerFromRecommendation(Number(button.dataset.recIndex), 'more'));
      });
      els.details.querySelectorAll('[data-action="recommend-less-like"]').forEach(button => {
        button.addEventListener('click', () => steerFromRecommendation(Number(button.dataset.recIndex), 'less'));
      });
    }

    function closePaperPopup() {
      state.inspectorOpen = false;
      state.selectedId = null;
      state.selectedLinkId = null;
      els.details.hidden = true;
      renderSelection();
    }

    function renderMiniSteerChip(term, group, prefix = '') {
      return `
        <span class="steer-mini-chip chip-${group}">
          <button class="chip-label" type="button" data-action="tag-action-menu" data-term="${escapeHtml(term)}" title="Click for tag options">
            ${escapeHtml(prefix + term)}
          </button>
          <button class="chip-remove-btn" type="button" data-action="remove-steer-chip" data-chip-group="${group}" data-chip-value="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(prefix + term)}">×</button>
        </span>
      `;
    }

    function renderSteerChips(values, group, prefix = '') {
      return values.map(term => renderMiniSteerChip(term, group, prefix)).join('');
    }

    function bindRecommendationSteerInputs() {
      const bindings = [
        { selector: '#recommendAuthorInput', kind: 'list', group: 'authors', limit: 10, assign: value => { state.recommendationAuthors = parseSteerList(value, 10); } },
        { selector: '#recommendJournalInput', kind: 'list', group: 'journals', limit: 10, assign: value => { state.recommendationJournals = parseSteerList(value, 10); } },
        { selector: '#recommendRecencyTilt', assign: value => { state.recommendationRecencyTilt = Number(value) || 0; } },
        { selector: '#recommendImpactTilt', assign: value => { state.recommendationImpactTilt = Number(value) || 0; } }
      ];
      bindings.forEach(binding => {
        const input = els.details.querySelector(binding.selector);
        input?.addEventListener('input', event => binding.assign(event.target.value));
        if (binding.kind === 'list') {
          input?.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitSteerInput(input, binding.group, binding.limit);
            showToast('Keyword added.');
            if (binding.group === 'graph') render();
            else renderDetails();
          });
        }
        input?.addEventListener('change', event => {
          binding.assign(event.target.value);
          if (binding.kind === 'list') event.target.value = steerValuesForGroup(binding.group).join('; ');
          showToast('Recommendation steering updated.');
          if (binding.selector === '#graphSteerInput') {
            render();
          } else {
            renderDetails();
          }
        });
      });
    }

    function commitSteerInput(input, group, limit) {
      const values = parseSteerList(input.value, limit);
      setSteerValuesForGroup(group, values);
      input.value = values.join('; ');
    }

    function bindSteerChipButtons() {
      els.details.querySelectorAll('[data-action="remove-steer-chip"]').forEach(button => {
        button.addEventListener('click', () => {
          removeSteerChip(button.dataset.chipGroup, button.dataset.chipValue);
        });
      });
    }

    function steerValuesForGroup(group) {
      if (group === 'steer') return state.recommendationSteerKeywords;
      if (group === 'exclude') return state.recommendationExcludeKeywords;
      if (group === 'authors') return state.recommendationAuthors;
      if (group === 'journals') return state.recommendationJournals;
      if (group === 'graph') return state.graphSteerKeywords;
      return [];
    }

    function setSteerValuesForGroup(group, values) {
      if (group === 'steer') state.recommendationSteerKeywords = values;
      if (group === 'exclude') state.recommendationExcludeKeywords = values;
      if (group === 'authors') state.recommendationAuthors = values;
      if (group === 'journals') state.recommendationJournals = values;
      if (group === 'graph') state.graphSteerKeywords = values;
    }

    function removeSteerChip(group, value) {
      const normalized = String(value || '').toLowerCase();
      setSteerValuesForGroup(group, steerValuesForGroup(group).filter(term => term.toLowerCase() !== normalized));
      showToast('Keyword removed.');
      if (group === 'graph') render();
      else renderDetails();
    }

    function renderRecommendationMarkup(recommendations, loading) {
      if (loading) {
        const steerBits = [
          state.recommendationSteerKeywords.length ? `toward ${state.recommendationSteerKeywords.join(', ')}` : '',
          state.recommendationExcludeKeywords.length ? `away from ${state.recommendationExcludeKeywords.join(', ')}` : '',
          state.recommendationAuthors.length ? `authors ${state.recommendationAuthors.join(', ')}` : '',
          state.recommendationJournals.length ? `venues ${state.recommendationJournals.join(', ')}` : ''
        ].filter(Boolean).join('; ');
        const steer = steerBits ? ` steered ${steerBits}` : '';
        return `<div class="settings-status">Searching Semantic Scholar (S2AG), OpenAlex, and Crossref${escapeHtml(steer)} for literature...</div>`;
      }
      if (!recommendations.length) {
        return '<div class="settings-status">No literature suggestions yet. Select a paper and click ⚡ Run Pipeline or Find related papers.</div>';
      }
      return recommendations.map((item, index) => {
        const href = item.doi ? `https://doi.org/${item.doi}` : (item.url || (item.s2PaperId ? `https://www.semanticscholar.org/paper/${item.s2PaperId}` : '') || item.openAlexId || '#');
        const authorList = paperAuthors(item);
        const authors = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';
        const meta = [item.source || '', authors, item.year || item.date, item.journal, item.doi ? `DOI ${item.doi}` : '', item.citedByCount ? `${item.citedByCount} citations` : '', item.influentialCitationCount ? `⭐ ${item.influentialCitationCount} influential` : '']
          .filter(Boolean)
          .join(' | ');

        const badges = (item.discoveryBadges || []).map(b => {
          let cls = 'badge-general';
          if (b.includes('SPECTER2')) cls = 'badge-specter';
          else if (b.includes('Co-citation')) cls = 'badge-cocitation';
          else if (b.includes('Bib Coupling')) cls = 'badge-bibcoupling';
          else if (b.includes('2-Hop')) cls = 'badge-chase';
          else if (b.includes('Influential')) cls = 'badge-influential';
          else if (b.includes('Backward') || b.includes('Forward')) cls = 'badge-citation';
          else cls = 'badge-concept';
          return `<span class="discovery-badge ${cls}">${escapeHtml(b)}</span>`;
        }).join('');

        const scorePill = item.score !== undefined ? `
          <span class="discovery-score-pill" title="Relevance: ${item.scoreBreakdown?.relevance || 0} | Proximity: ${item.scoreBreakdown?.citationProximity || 0} | Semantic: ${item.scoreBreakdown?.semanticSimilarity || 0} | Convergence Bonus: +${item.scoreBreakdown?.convergenceBonus || 0}">
            Score ${Math.round(item.score)}
          </span>
        ` : '';

        return `<article class="recommendation-item">
          <div class="recommendation-title-row">
            <a class="recommendation-title" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || 'Untitled recommendation')}</a>
            ${scorePill}
          </div>
          <div class="recommendation-meta">${escapeHtml(meta || item.source || 'Recommended paper')}</div>
          ${badges ? `<div class="recommendation-badges-row">${badges}</div>` : ''}
          <div class="recommendation-reason">${escapeHtml(item.reason || 'Recommended from selected-paper title, abstract, and citation topology.')}</div>
          ${item.title === 'Recommendation search failed' || item.title === 'Discovery search failed' ? '' : `
            <div class="recommend-feedback">
              <button class="button xs" data-action="recommend-more-like" data-rec-index="${index}" type="button">More like this</button>
              <button class="button xs" data-action="recommend-less-like" data-rec-index="${index}" type="button">Less like this</button>
            </div>
            <button class="button small" data-action="add-recommendation" data-rec-index="${index}" type="button">Add to map</button>
          `}
        </article>`;
      }).join('');
    }

    function renderSeminalMarkup() {
      if (!state.seminalSuggestions.length) return '';
      return state.seminalSuggestions.map((item, index) => {
        const href = item.doi ? `https://doi.org/${item.doi}` : (item.url || item.openAlexId || '#');
        const authorList = paperAuthors(item);
        const authors = authorList.length ? (authorList.slice(0, 3).join(', ') + (authorList.length > 3 ? ' et al.' : '')) : '';
        const meta = [authors, item.year || item.date, item.journal, item.doi ? `DOI ${item.doi}` : '', item.citedByLoadedCount ? `${item.citedByLoadedCount} map citations` : ''].filter(Boolean).join(' | ');
        return `<article class="recommendation-item">
          <a class="recommendation-title" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || 'Untitled foundational paper')}</a>
          <div class="recommendation-meta">${escapeHtml(meta || 'Missing foundational paper')}</div>
          <div class="recommendation-reason">${escapeHtml(item.reason || 'Frequently referenced by papers already on this map.')}</div>
          <button class="button" data-action="add-seminal" data-seminal-index="${index}" type="button">Add seminal paper</button>
        </article>`;
      }).join('');
    }

    function recommendationAlreadyOnMap(item) {
      const doi = normalizeDoi(item?.doi || '');
      const titleKey = cleanField(item?.title || '').toLowerCase();
      return state.papers.some(paper =>
        (doi && sameDoi(paper.doi || '', doi))
