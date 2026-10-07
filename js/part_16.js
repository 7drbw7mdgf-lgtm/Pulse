
    function renderDetails() {
      if (state.selectedLinkId) {
        renderLinkageDetails();
        return;
      }

      let paper = state.papers.find(item => item.id === state.selectedId);
      if (!paper && state.papers.length > 0) {
        paper = state.papers[0];
        state.selectedId = paper.id;
      }
      if (!paper) {
        els.details.hidden = false;
        els.details.innerHTML = `
          <div class="inspector-placeholder">
            <div class="inspector-placeholder-icon">📄</div>
            <h3>Paper Inspector</h3>
            <p>Select any paper from the library or click a node on the map to inspect relevance scores, citation metrics, and foundational evidence.</p>
          </div>
        `;
        return;
      }

      const related = state.links
        .filter(link => link.source === paper.id || link.target === paper.id)
        .map(link => ({
          score: link.score,
          type: link.type,
          paper: state.papers.find(item => item.id === (link.source === paper.id ? link.target : link.source))
        }))
        .filter(item => item.paper)
        .sort((a, b) => b.score - a.score);
      const recommendationSeeds = selectedPapersForRecommendation();
      const recKey = recommendationKey(recommendationSeeds);
      const recommendations = state.recommendations.get(recKey) || [];
      const isLoadingRecommendations = state.recommendationLoadingKey === recKey;
      const steerText = state.recommendationSteerKeywords.join('; ');
      const excludeText = state.recommendationExcludeKeywords.join('; ');
      const authorText = state.recommendationAuthors.join('; ');
      const journalText = state.recommendationJournals.join('; ');
      const graphText = state.graphSteerKeywords.join('; ');
      const activeSteerChips = [
        ...state.recommendationSteerKeywords.map(t => renderMiniSteerChip(t, 'steer', '🎯 ')),
        ...state.graphSteerKeywords.map(t => renderMiniSteerChip(t, 'graph', '🌐 ')),
        ...state.recommendationExcludeKeywords.map(t => renderMiniSteerChip(t, 'exclude', '⛔ ')),
      ].join('');

      const rawAbstract = (paper.abstract || paper.text || '').trim();
      const isAbstractLong = rawAbstract.length > 300;
      const displayAbstract = (isAbstractLong && !state.detailsAbstractExpanded)
        ? rawAbstract.slice(0, 297) + '...'
        : rawAbstract;

      // 1. Relevance scores
      const strongestLink = related[0]?.score || 0;
      const semScore = Math.round(Math.max(0, ...related.map(r => cosine(state.vectors.get(paper.id), state.vectors.get(r.paper.id)))) * 100);
      const citScore = Math.round(Math.max(0, ...related.filter(r => r.type === 'citation').map(r => r.score)) * 100);
      const cocScore = Math.round(Math.max(0, ...related.filter(r => r.type === 'cocitation').map(r => r.score)) * 100);
      const concepts = new Set(mergedKeywords(paper).map(term => term.toLowerCase()));
      const conScore = Math.round(Math.max(0, ...related.map(r => {
        const other = new Set(mergedKeywords(r.paper).map(term => term.toLowerCase()));
        const common = [...concepts].filter(term => other.has(term)).length;
        return common / Math.max(1, new Set([...concepts, ...other]).size);
      })) * 100);

      // 2. Metrics (4-box row)
      const metricCitations = paper.citedByCount ? String(paper.citedByCount) : '—';
      const metricReferences = paper.referenceIds?.length ? String(paper.referenceIds.length) : (paper.references?.length ? String(paper.references.length) : '—');
      const metricInfluential = Number.isFinite(paper.influentialCitationCount) ? String(paper.influentialCitationCount) : '—';
      const yearNum = parseInt(paper.year || (String(paper.date || '').match(/\b(19|20)\d{2}\b/) || [''])[0]);
      const yearsActive = yearNum ? Math.max(1, new Date().getFullYear() - yearNum) : 1;
      const metricVelocity = (paper.citedByCount && yearNum) ? (paper.citedByCount / yearsActive).toFixed(1) : '—';

      // 3. Key concepts
      const topConcepts = mergedKeywords(paper).slice(0, 8);

      // 4. Why this paper evidence
      const whyList = [];
      if (related.length) {
        whyList.push({ icon: '🔗', text: `Strong linkage with <strong>${escapeHtml(compactTitle(related[0].paper.title))}</strong> (${Math.round(related[0].score * 100)}% match)` });
      }
      if (paper.citedByCount && paper.citedByCount > 50) {
        whyList.push({ icon: '⭐', text: `Cornerstone publication with <strong>${paper.citedByCount}</strong> verified citations` });

      }
      if (topConcepts.length) {
        whyList.push({ icon: '🎯', text: `Shares key concepts: <em>${escapeHtml(topConcepts.slice(0, 3).join(', '))}</em>` });
      }

      els.details.hidden = false;
      els.details.innerHTML = `
        <div class="inspector-card-header">
          <div class="inspector-title-area">
            <h2 class="inspector-title">${escapeHtml(paper.title || 'Untitled paper')}</h2>
            <div class="inspector-authors-line">
              <span>${escapeHtml(paperAuthors(paper).slice(0, 3).join(', '))}${paperAuthors(paper).length > 3 ? ' et al.' : ''}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${paper.journal ? `<span class="inspector-journal">· ${escapeHtml(paper.journal)}</span>` : ''}
            </div>
          </div>
          <button class="ai-close details-close-btn" data-action="close-details" type="button" title="Close inspector" aria-label="Close inspector">×</button>
        </div>

        <div class="inspector-quick-actions">
          ${paper.doi ? `
            <a class="inspector-btn primary" href="https://doi.org/${escapeHtml(paper.doi)}" target="_blank" rel="noreferrer">
              <span>Open paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          ` : `
            <a class="inspector-btn primary" href="https://scholar.google.com/scholar?q=${encodeURIComponent(paper.title)}" target="_blank" rel="noreferrer">
              <span>Find paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          `}
          <button class="inspector-btn secondary" type="button" data-action="toggle-paper-seed">
            <span>${state.discoverySeed?.id === paper.id ? 'Core seed ⭐' : 'In library'}</span>
          </button>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Relevance to your search</div>
          <div class="relevance-bars-list">
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Semantic similarity</span>
              <div class="relevance-track"><div class="relevance-fill fill-sem" style="width:${semScore}%"></div></div>
              <span class="relevance-score">${semScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Citation proximity</span>
              <div class="relevance-track"><div class="relevance-fill fill-cit" style="width:${citScore}%"></div></div>
              <span class="relevance-score">${citScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Co-citation strength</span>
              <div class="relevance-track"><div class="relevance-fill fill-coc" style="width:${cocScore}%"></div></div>
              <span class="relevance-score">${cocScore}%</span>
            </div>
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Concept overlap</span>
              <div class="relevance-track"><div class="relevance-fill fill-con" style="width:${conScore}%"></div></div>
              <span class="relevance-score">${conScore}%</span>
            </div>
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>Key concepts</span>
            <button class="button small secondary tag-edit-chip" data-action="open-paper-keywords" data-paper="${paper.id}" type="button">Manage tags</button>
          </div>
          <div class="concept-chips-wrap">
            ${topConcepts.map((term, i) => `
              <button class="concept-chip" data-action="tag-action-menu" data-term="${escapeHtml(term)}" type="button" title="Click for tag options">
                <span style="opacity:0.6; margin-right:3px;">#${i + 1}</span>
                ${escapeHtml(term)}
              </button>
            `).join('')}
            ${!topConcepts.length ? '<span class="subtle" style="font-size:11px;">No concept tags extracted yet.</span>' : ''}
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Citation metrics</div>
          <div class="metrics-quad-grid">
            <div class="metric-quad-box">
              <div class="metric-quad-label">Citations</div>
              <div class="metric-quad-val">${escapeHtml(metricCitations)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">References</div>
              <div class="metric-quad-val">${escapeHtml(metricReferences)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">Influential</div>
              <div class="metric-quad-val">${escapeHtml(metricInfluential)}</div>
            </div>
            <div class="metric-quad-box">
              <div class="metric-quad-label">Rate / yr</div>
              <div class="metric-quad-val">${escapeHtml(metricVelocity)}</div>
            </div>
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Why this paper?</div>
          <div class="why-paper-list">
            ${whyList.map(item => `
              <div class="why-paper-item">
                <span class="why-paper-icon">${item.icon}</span>
                <span>${item.text}</span>
              </div>
            `).join('')}
          </div>
        </div>

        ${rawAbstract ? `
          <div class="inspector-section">
            <div class="inspector-section-title">Abstract</div>
            <p class="details-abstract-text" style="font-size:11px; line-height:1.45; color:var(--ink-2);">${escapeHtml(displayAbstract)}</p>
            ${isAbstractLong ? `<button class="details-abstract-toggle" data-action="toggle-abstract" type="button" style="margin-top:4px;">${state.detailsAbstractExpanded ? 'Show less' : 'Read full text'}</button>` : ''}
          </div>
        ` : ''}

        <div class="inspector-section">
          <div class="inspector-section-title">Connected in workspace (${related.length})</div>
          <div class="related-list">
            ${related.length ? related.map(item => `
              <div class="related-item clickable-linkage" data-action="view-related-link" data-link="${linkId({ source: paper.id, target: item.paper.id })}" role="button" tabindex="0" title="Click to view linkage">
                <div class="score">${Math.round(item.score * 100)}%</div>
                <div class="related-title">${escapeHtml(item.paper.title)}</div>
              </div>
            `).join('') : '<p class="subtle" style="font-size:11px;">No links above threshold.</p>'}
          </div>
        </div>

        <div class="discovery-hub" style="margin-top:12px;">
          <div class="discovery-hub-head">
            <div>
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
        state.discoverySeed = (state.discoverySeed?.id === paper.id) ? null : paper;
        renderDetails();
        showToast(state.discoverySeed ? `Set "${compactTitle(paper.title)}" as discovery seed` : 'Cleared discovery seed');
      });
      els.details.querySelector('[data-action="add-as-new-seed"]')?.addEventListener('click', () => {
        state.discoverySeed = paper;
        runDiscoveryPipeline();
      });
      els.details.querySelector('[data-action="find-similar-work"]')?.addEventListener('click', () => {
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
            renderDetails();
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
