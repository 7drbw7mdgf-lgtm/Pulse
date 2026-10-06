      }

      els.details.hidden = false;
      els.details.innerHTML = `
        <div class="linkage-details-card">
          <div class="details-header linkage-details-header">
            <div class="linkage-header-title">
              <span class="link-type-badge ${escapeHtml(link.type || 'similarity')}">${escapeHtml(linkTypeName(link))}</span>
              <h2>Paper Similarities</h2>
            </div>
            <button class="ai-close" data-action="close-linkage" type="button" aria-label="Close paper similarities">×</button>
          </div>

          <div class="linkage-score-banner">
            <div class="score-dial">
              <span class="score-dial-number">${scorePct}%</span>
              <span class="score-dial-label">Match</span>
            </div>
            <div class="score-dial-meta">
              <strong>${escapeHtml(connectionStrengthLabel(link.score))}</strong>
              <p class="subtle">${escapeHtml(link.evidence || 'Strong semantic and literature relationship.')}</p>
            </div>
          </div>

          <div class="linkage-pair-nodes">
            <div class="linkage-node-card">
              <span class="linkage-node-role">Paper 1</span>
              <h3 class="linkage-node-title">${escapeHtml(source.title)}</h3>
              <p class="metadata-line">${escapeHtml(metadataSummary(source))}</p>
              <button class="button small secondary" type="button" data-action="inspect-paper" data-paper="${source.id}">Inspect Paper 1</button>
            </div>

            <div class="linkage-connector-icon" aria-hidden="true">↔</div>

            <div class="linkage-node-card">
              <span class="linkage-node-role">Paper 2</span>
              <h3 class="linkage-node-title">${escapeHtml(target.title)}</h3>
              <p class="metadata-line">${escapeHtml(metadataSummary(target))}</p>
              <button class="button small secondary" type="button" data-action="inspect-paper" data-paper="${target.id}">Inspect Paper 2</button>
            </div>
          </div>

          <div class="linkage-breakdown-section">
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🏷️</span>
                <strong>Shared Keywords &amp; Themes</strong>
                <span class="badge-count">${sharedKws.length}</span>
              </div>
              <div class="terms">
                ${sharedKws.length
                  ? sharedKws.map(term => `<button class="term shared-term-btn" type="button" data-action="steer-shared-term" data-term="${escapeHtml(term)}" title="Click to steer recommendations toward &quot;${escapeHtml(term)}&quot;">${escapeHtml(term)}</button>`).join('')
                  : '<span class="subtle">No exact keyword overlap. Related via document body text and abstract semantics.</span>'}
              </div>
            </div>

            ${sharedOrgs.length ? `
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🧬</span>
                <strong>Shared Organisms &amp; Models</strong>
                <span class="badge-count">${sharedOrgs.length}</span>
              </div>
              <div class="terms">
                ${sharedOrgs.map(org => `<span class="term org-term">${escapeHtml(org)}</span>`).join('')}
              </div>
            </div>` : ''}

            ${sharedTechs.length ? `
            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🔬</span>
                <strong>Shared Techniques &amp; Assays</strong>
                <span class="badge-count">${sharedTechs.length}</span>
              </div>
              <div class="terms">
                ${sharedTechs.map(tech => `<span class="term tech-term">${escapeHtml(tech)}</span>`).join('')}
              </div>
            </div>` : ''}

            <div class="similarity-group">
              <div class="similarity-group-header">
                <span class="sim-icon">🔗</span>
                <strong>Citation &amp; Bibliographic Overlap</strong>
              </div>
              <ul class="similarity-fact-list">
                ${citationFacts.map(fact => `<li>${fact}</li>`).join('')}
              </ul>
            </div>
          </div>

          <div class="details-actions">
            <button class="button primary" data-action="recommend-pair" type="button">
              Find papers connecting both
            </button>
            <div class="recommend-steer-grid">
              <button class="button" data-action="focus-pair" type="button">Focus pair on map</button>
              <button class="button" data-action="deselect-linkage" type="button">Deselect linkage</button>
            </div>
          </div>
        </div>
      `;

      els.details.querySelector('[data-action="close-linkage"]')?.addEventListener('click', clearLinkageSelection);
      els.details.querySelector('[data-action="deselect-linkage"]')?.addEventListener('click', clearLinkageSelection);
      els.details.querySelector('[data-action="focus-pair"]')?.addEventListener('click', () => focusPairOnMap(source, target));
      els.details.querySelector('[data-action="recommend-pair"]')?.addEventListener('click', recommendSelectedPapers);

      els.details.querySelectorAll('[data-action="inspect-paper"]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.selectedId = btn.dataset.paper;
          state.selectedLinkId = null;
          render();
        });
      });

      els.details.querySelectorAll('[data-action="steer-shared-term"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const term = cleanField(btn.dataset.term || '');
          if (!term) return;
          state.recommendationSteerKeywords = dedupeList([term, ...state.recommendationSteerKeywords]).slice(0, 12);
          state.graphSteerKeywords = dedupeList([term, ...state.graphSteerKeywords]).slice(0, 12);
          showToast(`Steering recommendations toward "${term}".`);
          recommendSelectedPapers();
        });
      });
    }

    function renderDetails() {
      if (!state.inspectorOpen || state.workspaceView === 'discover') {
        els.details.hidden = true;
        return;
      }
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
            <span>${state.pinnedSeedId === paper.id ? 'Core seed ⭐' : 'Use as seed'}</span>
          </button>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Link evidence in your map</div>
          <div class="relevance-bars-list">
            <div class="relevance-bar-row">
              <span class="relevance-bar-label">Text similarity</span>
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
