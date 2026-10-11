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


    function updateInspectorNav(paper) {
      const prev = document.getElementById('inspectorPrev');
      const next = document.getElementById('inspectorNext');
      const position = document.getElementById('inspectorPosition');
      if (!prev || !next || !position) return;
      const list = paper ? libraryDisplayPapers() : [];
      const index = paper ? list.findIndex(item => item.id === paper.id) : -1;
      position.textContent = index >= 0 ? `${index + 1} of ${list.length} in Library` : 'Paper details';
      prev.disabled = index <= 0;
      next.disabled = index < 0 || index >= list.length - 1;
    }

    function stepInspectorPaper(offset) {
      const list = libraryDisplayPapers();
      const index = list.findIndex(item => item.id === state.selectedId);
      const target = list[index + offset];
      if (target) inspectPaper(target.id, { closeAgent: false });
    }

    function inspectorIcon(name) {
      const paths = {
        open: '<path d="M14 3h7v7"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>',
        discover: '<circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="6" r="2.5"></circle><circle cx="18" cy="18" r="2.5"></circle><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8"></path>',
        check: '<path d="M20 6L9 17l-5-5"></path>',
        spark: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"></path>',
        chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
        chevron: '<path d="M9 18l6-6-6-6"></path>',
        lock: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>'
      };
      return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
    }

    function renderDetails() {
      syncDiscoveryControls();
      if (!state.inspectorVisible) {
        els.details.hidden = true;
        return;
      }
      updateInspectorNav(null);
      if (state.selectedLinkId) {
        els.detailsContent.classList.remove('inspector-v2');
        renderLinkageDetails();
        return;
      }

      let paper = state.papers.find(item => item.id === state.selectedId);
      if (!paper && state.papers.length > 0) {
        paper = state.papers[0];
        state.selectedId = paper.id;
      }
      els.details.hidden = false;
      if (!paper) {
        els.detailsContent.classList.remove('inspector-v2');
        els.detailsContent.innerHTML = `
          <div class="inspector-placeholder">
            <div class="inspector-placeholder-icon">📄</div>
            <h3>Select a paper</h3>
            <p>Choose a paper from the library or map to see its details.</p>
          </div>
        `;
        return;
      }
      updateInspectorNav(paper);

      const tab = inspectorTab();
      const recommendationSeeds = selectedPapersForRecommendation();
      const recKey = recommendationKey(recommendationSeeds);
      const recommendations = state.recommendations.get(recKey) || [];
      const isLoadingRecommendations = state.recommendationLoadingKey === recKey;
      const neighbours = libraryNeighbours(paper);
      const isSeed = state.discoverySeed?.id === paper.id;
      const status = normalizedReadingStatus(paper.readingStatus);
      const doiHref = paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi).replace(/%2F/gi, '/')}` : '';
      const fullText = safeHref(paper.fullTextUrl || '');
      const venue = [paper.journal ? `<i>${escapeHtml(paper.journal)}</i>` : '', escapeHtml(inspectorPagination(paper))].filter(Boolean).join(' ');
      const meta = [escapeHtml(inspectorAuthorLine(paper)), escapeHtml(paper.year || 'No year'), venue].filter(Boolean).join(' · ');
      const provenance = paper.metadataNote || (paper.doiVerified ? 'Identity confirmed from the DOI record.' : 'DOI found in the imported file; not yet confirmed.');

      const header = `
        <div class="insp-head">
          <h2 class="insp-title">${escapeHtml(paper.title || 'Untitled paper')}</h2>
          <p class="insp-meta">${meta}</p>
          <div class="insp-status">
            ${paper.doi
              ? `<a class="insp-chip ${paper.doiVerified ? 'is-ok' : ''}" href="${escapeHtml(doiHref)}" target="_blank" rel="noreferrer" title="${escapeHtml(`${paper.doi} — ${provenance}`)}">${paper.doiVerified ? inspectorIcon('check') + 'DOI verified' : 'DOI unconfirmed'}</a>`
              : `<span class="insp-chip is-warn" title="${escapeHtml(provenance)}">No DOI yet</span>`}
            ${isSeed ? '<span class="insp-chip is-accent">Discovery seed</span>' : ''}
            <label class="insp-chip insp-status-chip${status ? ' is-' + status : ''}">
              <span>Status</span>
              <select data-field="readingStatus" aria-label="Reading status">
                <option value="" ${status ? '' : 'selected'}>Not set</option>
                ${READING_STATUSES.map(([key, label]) => `<option value="${key}" ${status === key ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="insp-actions">
            <a class="insp-btn primary" href="${escapeHtml(doiHref || `https://scholar.google.com/scholar?q=${encodeURIComponent(paperMetadataSearchText(paper))}`)}" target="_blank" rel="noreferrer">${inspectorIcon('open')}${paper.doi ? 'Open paper' : 'Find paper'}</a>
            <button class="insp-btn soft" data-action="run-discovery-pipeline" type="button" ${state.discoveryLoading || !Object.values(discoveryConfiguration().branches).some(Boolean) ? 'disabled' : ''}>${inspectorIcon('discover')}${state.discoveryLoading ? 'Discovering…' : 'Discover related'}</button>
            <div class="insp-more">
              <button class="insp-btn icon" type="button" data-action="toggle-more" aria-haspopup="menu" aria-expanded="false" aria-controls="inspectorMoreMenu" aria-label="More actions for this paper"><svg viewBox="0 0 24 24" aria-hidden="true" class="filled"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button>
              <div class="insp-menu" id="inspectorMoreMenu" role="menu" hidden>
                ${fullText ? `<a role="menuitem" href="${escapeHtml(fullText)}" target="_blank" rel="noreferrer">Open full text</a>` : ''}
                <button role="menuitem" type="button" data-action="lookup-metadata">Look up details</button>
                <button role="menuitem" type="button" data-action="copy-citation">Copy citation</button>
                <button role="menuitem" type="button" data-action="toggle-paper-seed">${isSeed ? 'Clear discovery seed' : 'Use as discovery seed'}</button>
                <button role="menuitem" type="button" data-action="send-to-manager">Send to Zotero or Mendeley…</button>
                <hr>
                <button role="menuitem" type="button" class="danger" data-action="remove-paper">Remove from library</button>
              </div>
            </div>
          </div>
          <div class="insp-tabs" role="tablist" aria-label="Paper sections">
            ${INSPECTOR_TABS.map(key => {
              const label = { overview: 'Overview', connections: 'Connections', notes: 'Notes' }[key];
              const badge = key === 'connections' && neighbours.length ? `<span class="insp-tab-count">${neighbours.length}</span>` : '';
              return `<button class="insp-tab" id="inspector-tab-${key}" role="tab" type="button" data-tab="${key}" aria-selected="${tab === key}" aria-controls="inspector-panel" tabindex="${tab === key ? 0 : -1}">${label}${badge}</button>`;
            }).join('')}
          </div>
        </div>`;

      els.details.hidden = false;
      els.detailsContent.classList.add('inspector-v2');
      els.detailsContent.innerHTML = `${header}<div class="insp-body" id="inspector-panel" role="tabpanel" aria-labelledby="inspector-tab-${tab}">${
        tab === 'connections' ? inspectorConnectionsMarkup(paper, neighbours, recommendations, isLoadingRecommendations)
        : tab === 'notes' ? inspectorNotesMarkup(paper)
        : inspectorOverviewMarkup(paper)
      }</div>`;

      bindInspector(paper, recommendations);
      syncDiscoveryControls();
      refreshPaperMetrics(paper);
    }

    function inspectorOverviewMarkup(paper) {
      const rawAbstract = (paper.abstract || paper.text || '').trim();
      const isAbstractLong = rawAbstract.length > 420;
      const displayAbstract = isAbstractLong && !state.detailsAbstractExpanded ? rawAbstract.slice(0, 417).replace(/\s+\S*$/, '') + '…' : rawAbstract;
      const metrics = metricsForPaper(paper);
      const yearNum = Number(paper.year);
      const currentYear = new Date().getFullYear();
      const perYear = Number.isInteger(yearNum) && yearNum > 1500 && yearNum <= currentYear && Number.isFinite(metrics?.citationCount)
        ? (metrics.citationCount / (currentYear - yearNum + 1)).toFixed(1) : '—';
      const influential = Number.isFinite(metrics?.influentialCitationCount) ? metricValue(metrics.influentialCitationCount) : '';
      const checked = metrics?.checkedAt ? new Date(metrics.checkedAt) : null;
      const checkedLabel = checked && !Number.isNaN(checked.getTime())
        ? (checked.toDateString() === new Date().toDateString() ? 'checked today' : `checked ${checked.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)
        : 'not checked yet';
      const concepts = mergedKeywords(paper);
      const shownConcepts = state.inspectorShowAllConcepts ? concepts : concepts.slice(0, 6);
      const findings = (paper.keyFindings || []).filter(Boolean);
      return `
        <section class="insp-section">
          <h3 class="insp-label">Abstract</h3>
          ${rawAbstract
            ? `<p class="insp-abstract">${escapeHtml(displayAbstract)}</p>${isAbstractLong ? `<button class="insp-link" type="button" data-action="toggle-abstract">${state.detailsAbstractExpanded ? 'Show less' : 'Show full abstract'}</button>` : ''}`
            : '<p class="insp-muted">No abstract available. Use <strong>Look up details</strong> in the ⋯ menu to search the indexes again.</p>'}
        </section>
        <section class="insp-metrics" aria-label="Citation metrics">
          <div class="insp-metric-values">
            <div><strong>${escapeHtml(metricValue(metrics?.citationCount))}</strong><span>citations</span></div>
            <div><strong>${escapeHtml(metricValue(metrics?.referenceCount))}</strong><span>references</span></div>
            <div title="Citations divided by calendar years since publication, including this year"><strong>${escapeHtml(perYear)}</strong><span>per year</span></div>
            ${influential ? `<div><strong>${escapeHtml(influential)}</strong><span>influential</span></div>` : ''}
          </div>
          <button class="insp-metric-source" type="button" data-action="refresh-metrics" title="${escapeHtml(metricsStatusText(paper).replace(/<[^>]+>/g, ''))} — click to refresh">${escapeHtml(metrics?.source || 'Citations')}<br>${escapeHtml(checkedLabel)}</button>
        </section>
        <section class="insp-section">
          <h3 class="insp-label">Key findings</h3>
          ${findings.length
            ? `<ul class="insp-findings">${findings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : `<div class="insp-empty"><p>No findings extracted yet. The AI agent can read this paper with a local model and list its main results.</p><button class="insp-btn small" type="button" data-action="open-agent">${inspectorIcon('spark')}Summarise with local AI</button></div>`}
        </section>
        <section class="insp-section">
          <div class="insp-label-row"><h3 class="insp-label">Key concepts</h3><button class="insp-link small" type="button" data-action="open-paper-keywords">Edit</button></div>
          <div class="insp-chips">
            ${shownConcepts.map(term => `<button class="insp-concept" type="button" data-action="tag-action-menu" data-term="${escapeHtml(term)}" title="Filter, steer or remove this concept">${escapeHtml(term)}</button>`).join('')}
            ${concepts.length > 6 ? `<button class="insp-concept more" type="button" data-action="toggle-concepts">${state.inspectorShowAllConcepts ? 'Show fewer' : `+${concepts.length - 6} more`}</button>` : ''}
            ${concepts.length ? '' : '<span class="insp-muted">No concepts extracted yet.</span>'}
          </div>
        </section>`;
    }

    function inspectorConnectionsMarkup(paper, neighbours, recommendations, isLoadingRecommendations) {
      const metrics = metricsForPaper(paper);
      const others = Math.max(0, state.papers.length - 1);
      const citationLinked = neighbours.some(item => item.link.type && item.link.type !== 'similarity');
      const neighbourCards = neighbours.slice(0, 12).map(({ link, other, score, shared }) => `
        <button class="insp-neighbour" type="button" data-action="inspect-paper" data-paper="${escapeHtml(other.id)}">
          <span class="insp-neighbour-top"><span class="insp-link-type">${escapeHtml(linkTypeName(link))} · ${Math.round(score * 100)}%</span><span>${escapeHtml(other.year || '')}</span></span>
          <span class="insp-neighbour-title">${escapeHtml(other.title || 'Untitled paper')}</span>
          <span class="insp-neighbour-meta">${escapeHtml(inspectorAuthorLine(other))}${other.journal ? ' · ' + escapeHtml(other.journal) : ''}</span>
          ${shared.length ? `<span class="insp-shared"><span>Shared:</span>${shared.map(term => `<span class="insp-shared-chip">${escapeHtml(term)}</span>`).join('')}</span>` : ''}
        </button>`).join('');
      const discoveryStatus = isLoadingRecommendations
        ? '<p class="discovery-panel-status" role="status">Finding papers related to this paper…</p>'
        : recommendations.length && recommendations[0].title === 'Discovery search failed'
          ? `<p class="discovery-panel-status" role="alert">${escapeHtml(recommendations[0].reason)}</p>`
          : recommendations.length
            ? `<button class="discovery-view-results-btn" data-action="open-discovery-results-modal" type="button">Review ${recommendations.length} related paper${recommendations.length === 1 ? '' : 's'}</button>`
            : '';
      return `
        <section class="insp-section">
          <div class="insp-label-row"><h3 class="insp-label">In your library</h3><span class="insp-hint">${neighbours.length} of ${others} other paper${others === 1 ? '' : 's'}</span></div>
          ${neighbourCards || `<div class="insp-empty"><p>${others ? `No links to your other ${others} paper${others === 1 ? '' : 's'} at the current similarity threshold (${Math.round(state.threshold * 100)}%). Lower it in the map controls to reveal weaker links.` : 'Add more papers to see how they connect to this one.'}</p></div>`}
        </section>
        ${citationLinked || paperHasCitationData(paper) ? '' : `
        <section class="insp-section">
          <h3 class="insp-label">Citation links in your library</h3>
          <div class="insp-empty"><p>Not mapped yet. Map citations to see which papers in your library cite this one, are cited by it, or share its references.</p>
            <button class="insp-btn small" type="button" data-action="map-citations" ${state.citationLoading ? 'disabled' : ''}>${state.citationLoading ? 'Mapping citations…' : 'Map citations'}</button></div>
        </section>`}
        <section class="insp-section">
          <h3 class="insp-label">Beyond your library</h3>
          <div class="insp-rows">
            <button class="insp-row" type="button" data-action="list-citations"><span><strong>Citing papers</strong><small>Papers that cite this one</small></span><span class="insp-row-end">${escapeHtml(metricValue(metrics?.citationCount))}${inspectorIcon('chevron')}</span></button>
            <button class="insp-row" type="button" data-action="list-references"><span><strong>References</strong><small>Papers this one cites</small></span><span class="insp-row-end">${escapeHtml(metricValue(metrics?.referenceCount))}${inspectorIcon('chevron')}</span></button>
          </div>
          <div class="insp-discovery">
            <div class="discovery-config-summary"><span data-discovery-summary>${escapeHtml(discoveryOptionsLabel())}</span><button id="inspectorDiscoveryOptions" type="button" data-action="open-discovery-options" aria-haspopup="dialog" aria-controls="discoveryOptionsPopup" aria-expanded="false">Options</button></div>
            ${discoveryStatus}
          </div>
        </section>`;
    }

    function inspectorNotesMarkup(paper) {
      const status = normalizedReadingStatus(paper.readingStatus);
      const relevance = normalizedRelevance(paper.relevance);
      return `
        <section class="insp-section">
          <h3 class="insp-label" id="inspector-status-label">Reading status</h3>
          <div class="insp-segmented" role="group" aria-labelledby="inspector-status-label">
            ${READING_STATUSES.map(([key, label]) => `<button type="button" data-set-field="readingStatus" data-value="${key}" aria-pressed="${status === key}">${label}</button>`).join('')}
          </div>
        </section>
        <section class="insp-section">
          <h3 class="insp-label" id="inspector-relevance-label">Relevant to your review?</h3>
          <div class="insp-pair" role="group" aria-labelledby="inspector-relevance-label">
            ${RELEVANCE_CHOICES.map(([key, label]) => `<button type="button" class="${key === 'relevant' ? 'is-yes' : 'is-no'}" data-set-field="relevance" data-value="${key}" aria-pressed="${relevance === key}">${label}</button>`).join('')}
          </div>
        </section>
        <section class="insp-section">
          <div class="insp-label-row"><h3 class="insp-label">Your tags</h3><span class="insp-hint">also filter the library</span></div>
          <div class="insp-chips">
            ${paperUserTags(paper).map(tag => `<span class="insp-user-tag">${escapeHtml(tag)}<button type="button" data-action="remove-user-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)}">×</button></span>`).join('')}
            <label class="insp-tag-input"><span class="visually-hidden">Add a tag</span><input type="text" data-action="add-user-tag" placeholder="+ Add tag" maxlength="60" autocomplete="off"></label>
          </div>
        </section>
        <section class="insp-section">
          <label class="insp-label" for="inspectorNotes">Notes</label>
          <textarea id="inspectorNotes" class="insp-notes" rows="8" maxlength="20000" placeholder="What does this paper show, and how will you use it?">${escapeHtml(paper.notes || '')}</textarea>
          <span class="insp-saved">${inspectorIcon('lock')}<span data-notes-status>Saved on this Mac only</span></span>
        </section>
        <button class="insp-btn block" type="button" data-action="open-agent">${inspectorIcon('chat')}Ask the AI agent about this paper</button>`;
    }

    function setInspectorMenuOpen(open) {
      const toggle = els.detailsContent.querySelector('[data-action="toggle-more"]');
      const menu = document.getElementById('inspectorMoreMenu');
      if (!toggle || !menu) return;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('[role="menuitem"]')?.focus();
    }

    function updatePaperPersonalField(paper, field, value) {
      paper[field] = value;
      scheduleAutosave();
    }

    function bindInspector(paper, recommendations) {
      const root = els.detailsContent;
      const on = (selector, handler) => root.querySelectorAll(selector).forEach(node => node.addEventListener('click', handler));
      root.querySelectorAll('.insp-tab').forEach(button => {
        button.addEventListener('click', () => { setInspectorTab(button.dataset.tab); renderDetails(); root.querySelector(`#inspector-tab-${button.dataset.tab}`)?.focus(); });
        button.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = INSPECTOR_TABS.indexOf(button.dataset.tab);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? INSPECTOR_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
          setInspectorTab(INSPECTOR_TABS[next]);
          renderDetails();
          root.querySelector(`#inspector-tab-${INSPECTOR_TABS[next]}`)?.focus();
        });
      });
      root.querySelector('[data-field="readingStatus"]')?.addEventListener('change', event => {
        updatePaperPersonalField(paper, 'readingStatus', normalizedReadingStatus(event.target.value));
        renderDetails();
      });
      root.querySelectorAll('[data-set-field]').forEach(button => button.addEventListener('click', () => {
        const field = button.dataset.setField;
        const value = paper[field] === button.dataset.value ? '' : button.dataset.value;
        updatePaperPersonalField(paper, field, field === 'readingStatus' ? normalizedReadingStatus(value) : normalizedRelevance(value));
        renderDetails();
      }));
      const notes = root.querySelector('#inspectorNotes');
      notes?.addEventListener('input', () => {
        paper.notes = notes.value.slice(0, 20000);
        const label = root.querySelector('[data-notes-status]');
        if (label) label.textContent = 'Saving…';
        clearTimeout(state.inspectorNotesTimer);
        state.inspectorNotesTimer = setTimeout(() => { scheduleAutosave(); if (label) label.textContent = 'Saved on this Mac only'; }, 600);
      });
      const tagInput = root.querySelector('[data-action="add-user-tag"]');
      tagInput?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ',') return;
        event.preventDefault();
        const values = splitKeywords(tagInput.value);
        const added = (values.length ? values : [tagInput.value]).map(value => addPaperUserTag(paper, value)).some(Boolean);
        tagInput.value = '';
        if (added) { scheduleAutosave(); renderPapers(); renderDetails(); root.querySelector('[data-action="add-user-tag"]')?.focus(); }
      });
      on('[data-action="remove-user-tag"]', event => {
        if (removePaperUserTag(paper, event.currentTarget.dataset.tag)) { scheduleAutosave(); renderPapers(); renderDetails(); }
      });

      const toggleMore = root.querySelector('[data-action="toggle-more"]');
      toggleMore?.addEventListener('click', event => {
        event.stopPropagation();
        setInspectorMenuOpen(document.getElementById('inspectorMoreMenu').hidden);
      });
      document.getElementById('inspectorMoreMenu')?.addEventListener('keydown', event => {
        if (event.key === 'Escape') { setInspectorMenuOpen(false); toggleMore?.focus(); }
      });
      on('#inspectorMoreMenu [role="menuitem"]', () => setInspectorMenuOpen(false));

      on('[data-action="lookup-metadata"]', async () => {
        showToast('Looking up paper details…');
        const matched = await resolvePaperMetadata(paper, { force: true });
        render();
        showToast(matched ? 'Paper details updated.' : paper.metadataNote || 'No confident match found.');
      });
      on('[data-action="copy-citation"]', async () => {
        const text = paperCitationText(paper);
        try { await navigator.clipboard.writeText(text); showToast('Citation copied.'); }
        catch { showToast(text); }
      });
      on('[data-action="toggle-paper-seed"]', () => {
        state.discoverySeed = isSeedPaper(paper) ? null : paper;
        renderDetails();
        showToast(state.discoverySeed ? `Set "${compactTitle(paper.title)}" as discovery seed` : 'Cleared discovery seed');
      });
      on('[data-action="send-to-manager"]', () => {
        const scope = document.getElementById('managerScope');
        if (scope) scope.value = 'selected';
        openManagers();
      });
      on('[data-action="remove-paper"]', () => removePapersWithRecovery([paper.id]));
      on('[data-action="open-agent"]', () => document.getElementById('aiAgentFab')?.click());
      on('[data-action="toggle-abstract"]', () => { state.detailsAbstractExpanded = !state.detailsAbstractExpanded; renderDetails(); });
      on('[data-action="toggle-concepts"]', () => { state.inspectorShowAllConcepts = !state.inspectorShowAllConcepts; renderDetails(); });
      on('[data-action="refresh-metrics"]', () => refreshPaperMetrics(paper, true));
      on('[data-action="list-citations"]', () => openPaperRelations(paper, 'citations'));
      on('[data-action="list-references"]', () => openPaperRelations(paper, 'references'));
      on('[data-action="map-citations"]', mapCitationTopology);
      on('[data-action="inspect-paper"]', event => inspectPaper(event.currentTarget.dataset.paper, { closeAgent: false }));
      on('[data-action="run-discovery-pipeline"]', runDiscoveryPipeline);
      on('[data-action="open-discovery-options"]', () => setDiscoveryOptionsOpen(true, false, 'inspectorDiscoveryOptions'));
      on('[data-action="open-discovery-results-modal"]', () => { if (recommendations.length) openDiscoveryModal(recommendations, paper); });
      on('[data-action="open-paper-keywords"]', () => openKeywordModal(paper.id));
      root.querySelectorAll('[data-action="tag-action-menu"]').forEach(button => button.addEventListener('click', event => {
        event.stopPropagation();
        openTagActionMenu(button.dataset.term, button, paper.id);
      }));
    }

    function isSeedPaper(paper) {
      return state.discoverySeed?.id === paper.id;
    }

    document.getElementById('inspectorPrev')?.addEventListener('click', () => stepInspectorPaper(-1));
    document.getElementById('inspectorNext')?.addEventListener('click', () => stepInspectorPaper(1));
    document.addEventListener('click', event => {
      const menu = document.getElementById('inspectorMoreMenu');
      if (menu && !menu.hidden && !event.target.closest?.('.insp-more')) setInspectorMenuOpen(false);
    });
