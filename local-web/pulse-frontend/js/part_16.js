const inspectorSectionKeys = ['concepts', 'metrics', 'abstract', 'discovery'];

function inspectorSectionExpanded(key) {
  if (!state.inspectorCollapsedSections) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('pulse-inspector-collapsed-sections') || '[]'); } catch {}
    state.inspectorCollapsedSections = new Set(Array.isArray(saved) ? saved.filter(value => inspectorSectionKeys.includes(value)) : []);
  }
  return !state.inspectorCollapsedSections.has(key);
}

function inspectorSectionToggle(key, label) {
  return `<button class="inspector-section-toggle" type="button" aria-expanded="${inspectorSectionExpanded(key)}" aria-controls="inspector-section-${key}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 5 5-5 5"></path></svg><span>${label}</span></button>`;
}

function setInspectorSectionExpanded(section, expanded) {
  const key = section.dataset.inspectorSection;
  if (!inspectorSectionKeys.includes(key)) return;
  inspectorSectionExpanded(key);
  const body = section.querySelector('.inspector-section-body');
  const toggle = section.querySelector('.inspector-section-toggle');
  if (!body || !toggle) return;
  body.hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  section.classList.toggle('is-collapsed', !expanded);
  if (expanded) state.inspectorCollapsedSections.delete(key); else state.inspectorCollapsedSections.add(key);
}

function bindInspectorSections() {
  els.detailsContent.querySelectorAll('[data-inspector-section]').forEach(section => {
    const key = section.dataset.inspectorSection;
    setInspectorSectionExpanded(section, inspectorSectionExpanded(key));
    const toggle = section.querySelector('.inspector-section-toggle');
    toggle?.addEventListener('click', () => {
      setInspectorSectionExpanded(section, !inspectorSectionExpanded(key));
      try { localStorage.setItem('pulse-inspector-collapsed-sections', JSON.stringify([...state.inspectorCollapsedSections])); } catch {}
    });
    section.querySelector('.discovery-run-btn')?.addEventListener('click', () => {
      // Reveal progress and results when discovery is started from its collapsed heading.
      setInspectorSectionExpanded(section, true);
    });
  });
}


    function renderDetails() {
      syncDiscoveryControls();
      if (!state.inspectorVisible) {
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
        els.detailsContent.innerHTML = `
          <div class="inspector-placeholder">
            <div class="inspector-placeholder-icon">📄</div>
            <h3>Select a paper</h3>
            <p>Choose a paper from the library or map to see its details.</p>
          </div>
        `;
        return;
      }

      const recommendationSeeds = selectedPapersForRecommendation();
      const recKey = recommendationKey(recommendationSeeds);
      const recommendations = state.recommendations.get(recKey) || [];
      const isLoadingRecommendations = state.recommendationLoadingKey === recKey;
      const rawAbstract = (paper.abstract || paper.text || '').trim();
      const isAbstractLong = rawAbstract.length > 300;
      const displayAbstract = (isAbstractLong && !state.detailsAbstractExpanded)
        ? rawAbstract.slice(0, 297) + '...'
        : rawAbstract;

      const metrics = metricsForPaper(paper);
      const metricCitations = metricValue(metrics?.citationCount);
      const metricReferences = metricValue(metrics?.referenceCount);
      const metricInfluential = metricValue(metrics?.influentialCitationCount);
      const yearNum = Number(paper.year);
      const currentYear = new Date().getFullYear();
      const metricVelocity = Number.isInteger(yearNum) && yearNum > 1500 && yearNum <= currentYear && Number.isFinite(metrics?.citationCount)
        ? (metrics.citationCount / (currentYear - yearNum + 1)).toFixed(1) : '—';

      // 3. Key concepts
      const topConcepts = mergedKeywords(paper).slice(0, 8);

      els.details.hidden = false;
      els.detailsContent.innerHTML = `
        <div class="inspector-card-header">
          <div class="inspector-title-area">
            <h2 class="inspector-title">${escapeHtml(paper.title || 'Untitled paper')}</h2>
            <div class="inspector-authors-line">
              <span>${escapeHtml(paperAuthors(paper).slice(0, 3).join(', '))}${paperAuthors(paper).length > 3 ? ' et al.' : ''}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${paper.journal ? `<span class="inspector-journal">· ${escapeHtml(paper.journal)}</span>` : ''}
            </div>
          </div>
        </div>

        ${(paper.doi || paper.metadataNote) ? `<div class="inspector-resolution-note">
          ${paper.doi ? `<div class="resolved-doi"><span>${paper.doiVerified ? 'DOI verified' : 'DOI extracted'}</span><a href="https://doi.org/${escapeHtml(paper.doi)}" target="_blank" rel="noreferrer">${escapeHtml(paper.doi)}</a></div>` : ''}
          ${paper.metadataNote ? `<p>${escapeHtml(paper.metadataNote)}</p>` : ''}
        </div>` : ''}
        <div class="inspector-quick-actions">
          ${paper.doi ? `
            <a class="inspector-btn primary" href="https://doi.org/${escapeHtml(paper.doi)}" target="_blank" rel="noreferrer">
              <span>Open paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          ` : `
            <a class="inspector-btn primary" href="https://scholar.google.com/scholar?q=${encodeURIComponent(paperMetadataSearchText(paper))}" target="_blank" rel="noreferrer">
              <span>Find paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"></path></svg>
            </a>
          `}
          ${safeHref(paper.fullTextUrl || '') ? `<a class="inspector-btn secondary" href="${escapeHtml(safeHref(paper.fullTextUrl))}" target="_blank" rel="noreferrer">Full text ↗</a>` : ''}
          <button class="inspector-btn secondary" type="button" data-action="lookup-metadata">Look up details</button>
          <button class="inspector-btn secondary" type="button" data-action="toggle-paper-seed">
            <span>${state.discoverySeed?.id === paper.id ? 'Core seed ⭐' : 'In library'}</span>
          </button>
        </div>

        <div class="inspector-section" data-inspector-section="concepts">
          <div class="inspector-section-heading">
            ${inspectorSectionToggle('concepts', 'Key concepts')}
            <button class="button small secondary tag-edit-chip" data-action="open-paper-keywords" data-paper="${paper.id}" type="button">Manage tags</button>
          </div>
          <div class="inspector-section-body" id="inspector-section-concepts">
          <div class="concept-chips-wrap">
            ${topConcepts.map(term => `
              <button class="concept-chip" data-action="tag-action-menu" data-term="${escapeHtml(term)}" type="button" title="Click for tag options">
                ${escapeHtml(term)}
              </button>
            `).join('')}
            ${!topConcepts.length ? '<span class="subtle" style="font-size:11px;">No concept tags extracted yet.</span>' : ''}
          </div>
          </div>
        </div>

        <div class="inspector-section" data-inspector-section="metrics">
          <div class="inspector-section-heading metrics-heading">${inspectorSectionToggle('metrics', 'Citation metrics')}<button data-action="refresh-metrics" class="inspector-btn secondary" type="button">Refresh</button></div>
          <div class="inspector-section-body" id="inspector-section-metrics">
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
              <div class="metric-quad-label" title="Citations divided by calendar years since publication, including the current year">Avg / yr</div>
              <div class="metric-quad-val">${escapeHtml(metricVelocity)}</div>
            </div>
          </div>
          <div class="citation-list-actions"><button class="inspector-btn secondary" data-action="list-citations" type="button">Citing papers</button><button class="inspector-btn secondary" data-action="list-references" type="button">References</button></div>
          <details class="citation-source-details"><summary>Source: ${escapeHtml(metrics?.source || 'Not retrieved')}</summary><div class="citation-source-note" role="status">${metricsStatusText(paper)}</div></details>
          </div>
        </div>

        ${rawAbstract ? `
          <div class="inspector-section" data-inspector-section="abstract">
            <div class="inspector-section-heading">${inspectorSectionToggle('abstract', 'Abstract')}</div>
            <div class="inspector-section-body" id="inspector-section-abstract">
            <p class="details-abstract-text" style="font-size:11px; line-height:1.45; color:var(--ink-2);">${escapeHtml(displayAbstract)}</p>
            ${isAbstractLong ? `<button class="details-abstract-toggle" data-action="toggle-abstract" type="button" style="margin-top:4px;">${state.detailsAbstractExpanded ? 'Show less' : 'Read full text'}</button>` : ''}
            </div>
          </div>
        ` : ''}

        <div class="discovery-hub" style="margin-top:12px;" data-inspector-section="discovery">
          <div class="discovery-hub-head">
            ${inspectorSectionToggle('discovery', 'Related papers')}
            <button class="button small primary discovery-run-btn" data-action="run-discovery-pipeline" type="button" ${state.discoveryLoading || !Object.values(discoveryConfiguration().branches).some(Boolean) ? 'disabled' : ''}>
              ${state.discoveryLoading ? 'Discovering…' : 'Discover related'}
            </button>
          </div>
          <div class="inspector-section-body" id="inspector-section-discovery">
            <div class="discovery-config-summary"><span data-discovery-summary>${escapeHtml(discoveryOptionsLabel())}</span><button id="inspectorDiscoveryOptions" type="button" data-action="open-discovery-options" aria-haspopup="dialog" aria-controls="discoveryOptionsPopup" aria-expanded="false">Options</button></div>
            ${isLoadingRecommendations ? '<p class="discovery-panel-status" role="status">Finding papers related to this paper…</p>' : recommendations.length && recommendations[0].title === 'Discovery search failed' ? `<p class="discovery-panel-status" role="alert">${escapeHtml(recommendations[0].reason)}</p>` : recommendations.length ? `<button class="discovery-view-results-btn" data-action="open-discovery-results-modal" type="button">Review ${recommendations.length} related paper${recommendations.length === 1 ? '' : 's'}</button>` : '<p class="discovery-panel-status">Use this paper as the starting point. Choose your options above, then discover related papers.</p>'}
          </div>
        </div>
      `;

      bindInspectorSections();
      syncDiscoveryControls();
      els.details.querySelector('[data-action="refresh-metrics"]')?.addEventListener('click', () => refreshPaperMetrics(paper, true));
      els.details.querySelector('[data-action="list-citations"]')?.addEventListener('click', () => openPaperRelations(paper, 'citations'));
      els.details.querySelector('[data-action="list-references"]')?.addEventListener('click', () => openPaperRelations(paper, 'references'));
      refreshPaperMetrics(paper);
      els.details.querySelector('[data-action="lookup-metadata"]')?.addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = 'Looking up…';
        const matched = await resolvePaperMetadata(paper, {force: true});
        render();
        showToast(matched ? 'Paper details updated.' : paper.metadataNote || 'No confident match found.');
      });
      els.details.querySelector('[data-action="toggle-abstract"]')?.addEventListener('click', () => {
        state.detailsAbstractExpanded = !state.detailsAbstractExpanded;
        renderDetails();
      });
      els.details.querySelector('[data-action="toggle-paper-seed"]')?.addEventListener('click', () => {
        state.discoverySeed = (state.discoverySeed?.id === paper.id) ? null : paper;
        renderDetails();
        showToast(state.discoverySeed ? `Set "${compactTitle(paper.title)}" as discovery seed` : 'Cleared discovery seed');
      });
      els.details.querySelector('[data-action="run-discovery-pipeline"]')?.addEventListener('click', runDiscoveryPipeline);
      els.details.querySelector('[data-action="open-discovery-options"]')?.addEventListener('click', () => setDiscoveryOptionsOpen(true, false, 'inspectorDiscoveryOptions'));
      els.details.querySelector('[data-action="open-discovery-results-modal"]')?.addEventListener('click', () => {
        if (recommendations.length) openDiscoveryModal(recommendations, paper);
      });
      els.details.querySelectorAll('[data-action="open-paper-keywords"]').forEach(btn => {
        btn.addEventListener('click', () => openKeywordModal(btn.dataset.paper || paper.id));
      });
      els.details.querySelectorAll('[data-action="tag-action-menu"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          openTagActionMenu(btn.dataset.term, btn, paper.id);
        });
      });
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
