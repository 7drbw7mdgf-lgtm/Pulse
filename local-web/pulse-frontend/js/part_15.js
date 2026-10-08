
    function renderLinkageDetails() {
      const link = state.links.find(item => linkId(item) === state.selectedLinkId);
      if (!link) {
        state.selectedLinkId = null;
        els.details.hidden = true;
        return;
      }
      const source = state.papers.find(item => item.id === link.source);
      const target = state.papers.find(item => item.id === link.target);
      if (!source || !target) {
        state.selectedLinkId = null;
        els.details.hidden = true;
        return;
      }

      const scorePct = Math.round(link.score * 100);
      const sharedKws = sharedKeywords(source, target);
      const sourceOrgs = (source.organisms || []).map(o => o.trim());
      const targetOrgs = (target.organisms || []).map(o => o.trim());
      const sharedOrgs = dedupeList(sourceOrgs.filter(so => targetOrgs.some(to => to.toLowerCase() === so.toLowerCase())));

      const sourceTechs = (source.techniques || []).map(t => t.trim());
      const targetTechs = (target.techniques || []).map(t => t.trim());
      const sharedTechs = dedupeList(sourceTechs.filter(st => targetTechs.some(tt => tt.toLowerCase() === st.toLowerCase())));

      const sourceAlex = normalizeOpenAlexId(source.openAlexId || source.openAlexUrl || '');
      const targetAlex = normalizeOpenAlexId(target.openAlexId || target.openAlexUrl || '');
      const sourceCitesTarget = targetAlex && (source.referenceIds || []).some(id => normalizeOpenAlexId(id) === targetAlex);
      const targetCitesSource = sourceAlex && (target.referenceIds || []).some(id => normalizeOpenAlexId(id) === sourceAlex);
      const sharedRefs = intersectIds(source.referenceIds, target.referenceIds);
      const sharedCiters = intersectIds(source.citedByIds, target.citedByIds);

      const citationFacts = [];
      if (sourceCitesTarget) {
        citationFacts.push(`<strong>${escapeHtml(compactTitle(source.title))}</strong> directly cites <strong>${escapeHtml(compactTitle(target.title))}</strong>.`);
      }
      if (targetCitesSource) {
        citationFacts.push(`<strong>${escapeHtml(compactTitle(target.title))}</strong> directly cites <strong>${escapeHtml(compactTitle(source.title))}</strong>.`);
      }
      if (sharedRefs.length > 0) {
        citationFacts.push(`Share <strong>${sharedRefs.length}</strong> common referenced paper${sharedRefs.length === 1 ? '' : 's'} in their bibliographies.`);
      }
      if (sharedCiters.length > 0) {
        citationFacts.push(`Co-cited together by <strong>${sharedCiters.length}</strong> external literature paper${sharedCiters.length === 1 ? '' : 's'}.`);
      }
      if (!citationFacts.length) {
        citationFacts.push('Connected through semantic embedding and full-text keyword proximity in the literature map.');
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
          inspectPaper(btn.dataset.paper);
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
