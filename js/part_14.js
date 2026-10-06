      });
    }

    function sharedKeywords(source, target) {
      if (!source || !target) return [];
      const left = new Set(mergedKeywords(source).map(term => term.toLowerCase()));
      return mergedKeywords(target).filter(term => left.has(term.toLowerCase()));
    }

    function linkTypeName(link) {
      const labels = {
        citation: 'Direct citation',
        bibliographic: 'Bibliographic coupling',
        cocitation: 'Co-citation',
        mixed: 'Mixed literature link',
        similarity: 'Text similarity'
      };
      return labels[link?.type || 'similarity'] || 'Link';
    }

    function linkLabel(link) {
      const score = `${Math.round((link.score || 0) * 100)}%`;
      return `${linkTypeName(link)} (${score}). ${link.evidence || 'Related through title, abstract, keywords, or metadata.'}`;
    }

    function paperMatchScore(paper) {
      const strongest = state.links
        .filter(link => link.source === paper.id || link.target === paper.id)
        .reduce((best, link) => Math.max(best, Number(link.score || 0)), 0);
      return Math.max(0, Math.min(99, Math.round(strongest * 100)));
    }

    function paperStudyType(paper) {
      const text = `${paper.title || ''} ${paper.abstract || ''} ${(paper.paperKeywords || []).join(' ')}`.toLowerCase();
      if (/\breview|systematic review|meta-analysis\b/.test(text)) return 'Review';
      if (/\btrial|randomi[sz]ed|cohort|case-control|participant|patients?\b/.test(text)) return 'Clinical study';
      if (/\bexperiment|assay|culture|sequenc|rna-seq|transcriptomic|proteomic|genomic\b/.test(text)) return 'Experimental study';
      if (/\bmodel|algorithm|embedding|transformer|network|machine learning\b/.test(text)) return 'Computational study';
      return 'Research article';
    }

    function paperDomainLabel(paper) {
      const keywords = mergedKeywords(paper).join(' ').toLowerCase();
      const title = `${paper.title || ''} ${paper.journal || ''}`.toLowerCase();
      if (/\btranscript|rna|gene expression|sequenc|genomic\b/.test(`${keywords} ${title}`)) return 'Transcriptomics';
      if (/\bmicrobi|bacteria|campylobacter|biofilm|infection|immune\b/.test(`${keywords} ${title}`)) return 'Microbiology';
      if (/\bmachine learning|embedding|graph|network|transformer|retrieval\b/.test(`${keywords} ${title}`)) return 'AI literature discovery';
      if (/\bclinical|patient|therapy|therapeutic|disease\b/.test(`${keywords} ${title}`)) return 'Clinical biology';
      return 'Literature mapping';
    }

    function paperAuthorSummary(paper) {
      const authors = paperAuthors(paper);
      if (!authors.length) return 'Unknown authors';
      return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ` +${authors.length - 3}` : '');
    }

    function renderPapers() {
      const areaOptions = paper => [
        `<option value="">No area</option>`,
        ...state.areas.map(area => `<option value="${area.id}" ${paper.areaId === area.id ? 'selected' : ''}>${escapeHtml(area.name)}</option>`)
      ].join('');
      const paperMetaChips = paper => {
        const keywords = mergedKeywords(paper).slice(0, 3);
        const extra = Math.max(0, mergedKeywords(paper).length - keywords.length);
        const chips = [
          ...keywords.map((value, idx) => ({ value, action: 'paper-keyword', title: `Keyword #${idx + 1}: ${value}` })),
          ...(extra ? [{ value: `+${extra}`, action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }] : [{ value: '🏷️ tags', action: 'open-paper-keywords', title: 'Manage & reorder keyword tags' }])
        ];
        return chips.map(item => `<button class="compact-chip${item.action === 'open-paper-keywords' ? ' tag-edit-chip' : ''}" type="button" data-action="${item.action}" data-keyword="${escapeHtml(item.value)}" data-paper="${paper.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.value)}</button>`).join('');
      };
      const clusterByPaper = new Map();
      state.clusters.forEach((cluster, index) => cluster.forEach(id => clusterByPaper.set(id, index)));
      const paperOrganizeMarkup = paper => `
        <div class="paper-organize">
          <label class="paper-control paper-color" title="Node colour">
            <input type="color" value="${escapeHtml(paper.color || paperColor(paper, clusterByPaper))}" data-field="color" aria-label="Node colour">
          </label>
          <label class="paper-control paper-area" title="Map area">
            <select data-field="areaId" aria-label="Map area">${areaOptions(paper)}</select>
          </label>
          <div class="paper-actions-row">
            <button class="icon-button" title="Focus paper on graph" aria-label="Focus paper on graph" data-action="focus" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></button>
            <button class="icon-button danger" title="Remove paper" aria-label="Remove paper" data-action="remove" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg></button>
          </div>
        </div>
      `;
      const paperHeaderMarkup = paper => {
        const match = paperMatchScore(paper);
        const publication = [paper.journal, paper.year || paper.date].filter(Boolean).join(' · ');
        return `
          <div class="paper-card-top">
            <span class="paper-swatch" style="background:${escapeHtml(paperColor(paper, clusterByPaper))}"></span>
            <span class="paper-publication">${escapeHtml(publication || paperDomainLabel(paper))}</span>
            ${match ? `<span class="paper-badge match" title="Strongest link to another paper">${match}%</span>` : ''}
          </div>
        `;
      };
      const paperFactsMarkup = paper => {
        const authorCount = paperAuthors(paper).length;
        const facts = [
          paperStudyType(paper),
          `${authorCount || 'No'} author${authorCount === 1 ? '' : 's'}`,
          paper.citedByCount ? `${paper.citedByCount} citations` : ''
        ].filter(Boolean);
        return `<div class="paper-facts">${facts.map(fact => `<span class="paper-fact">${escapeHtml(fact)}</span>`).join('')}</div>`;
      };
      const renderCompactPaper = paper => `
        <article class="pulse-paper-card${state.selectedId === paper.id ? ' is-selected' : ''}" data-paper="${paper.id}">
          <input type="checkbox" class="paper-chk" ${paper.selected !== false ? 'checked' : ''} data-action="toggle-paper-active" title="Toggle paper on map">
          <div class="pulse-paper-card-body">
            <div class="pulse-paper-title">${escapeHtml(paper.title || 'Untitled paper')}</div>
            <div class="pulse-paper-meta">
              <span>${escapeHtml(paperAuthorSummary(paper))}</span>
              <span>· ${escapeHtml(paper.year || 'No year')}</span>
              ${paper.journal ? `<span class="pulse-paper-journal">· ${escapeHtml(paper.journal.length > 22 ? paper.journal.slice(0, 20) + '...' : paper.journal)}</span>` : ''}
            </div>
          </div>
        </article>
      `;
      const renderExpandedPaper = paper => `
        <article class="paper-card${state.selectedId === paper.id ? ' is-selected' : ''}" data-paper="${paper.id}">
          ${paperHeaderMarkup(paper)}
          <div class="paper-title">${escapeHtml(paper.title || 'Untitled paper')}</div>
          <div class="paper-authors">${escapeHtml(paperAuthorSummary(paper))}</div>
          <div class="compact-meta">${paperMetaChips(paper)}</div>
          ${paperFactsMarkup(paper)}
          ${paper.metadataSource || paper.metadataNote ? `<div class="metadata-line">${escapeHtml(paper.metadataSource ? `Metadata filled from ${paper.metadataSource}.` : paper.metadataNote)}</div>` : ''}
          <div class="paper-edit-grid">
            <label>
              Title
              <input value="${escapeHtml(paper.title)}" data-field="title">
            </label>
            <div class="metadata-grid">
              <label>
                Authors
                <input value="${escapeHtml(paperAuthors(paper).join('; '))}" data-field="authors">
              </label>
              <label>
                Date
                <input value="${escapeHtml(paper.date || paper.year || '')}" data-field="date">
              </label>
              <label>
                Journal
                <input value="${escapeHtml(paper.journal || '')}" data-field="journal">
              </label>
              <label>
                DOI
                <input value="${escapeHtml(paper.doi || '')}" data-field="doi">
              </label>
            </div>
            <label>
              Abstract
              <textarea data-field="abstract">${escapeHtml(paper.abstract || '')}</textarea>
            </label>
            <label>
              <div class="terms-header-row">
                <span>Keywords</span>
                <button class="button small secondary tag-edit-chip" type="button" data-action="open-paper-keywords" data-paper="${paper.id}">🏷️ Manage tags</button>
              </div>
              <input value="${escapeHtml((paper.paperKeywords || []).join('; '))}" data-field="paperKeywords">
            </label>
          </div>
          ${paperOrganizeMarkup(paper)}
        </article>
      `;
      const hasFilter = Boolean(state.librarySearch || (state.filterTags && state.filterTags.length > 0));
      const displayPapers = state.papers.filter(paperMatchesFilters);

      if (els.paperCount) {
        els.paperCount.textContent = hasFilter
          ? `Showing ${displayPapers.length} of ${state.papers.length} (filtered)`
          : `${state.papers.length} paper${state.papers.length === 1 ? '' : 's'}`;
      }
      if (els.railLibraryBadge) {
        els.railLibraryBadge.textContent = state.papers.length;
      }

      if (!displayPapers.length) {
        els.paperList.innerHTML = hasFilter
          ? `<div class="empty-filter-state" style="padding: 24px 16px; text-align: center; color: var(--muted);">
              <p style="margin: 0 0 10px 0; font-size: 13px;">No papers match the active tag filter${state.filterTags.length > 1 ? 's' : ''}.</p>
              <button class="button small secondary" data-action="clear-filters-from-list" type="button">Clear tag filters</button>
            </div>`
          : '<div class="empty-filter-state" style="padding: 24px 16px; text-align: center; color: var(--muted); font-size: 13px;">No papers in library yet.</div>';

        els.paperList.querySelector('[data-action="clear-filters-from-list"]')?.addEventListener('click', clearFilterTags);
      } else {
        els.paperList.innerHTML = displayPapers.map(paper => (
          state.paperView === 'compact' ? renderCompactPaper(paper) : renderExpandedPaper(paper)
        )).join('');
      }

      els.paperList.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('change', event => {
          const card = event.target.closest('[data-paper]');
          const paper = state.papers.find(item => item.id === card.dataset.paper);
          if (event.target.dataset.field === 'paperKeywords') {
            paper.paperKeywords = splitKeywords(event.target.value);
          } else if (event.target.dataset.field === 'authors') {
            paper.authors = splitAuthors(event.target.value);
          } else if (event.target.dataset.field === 'date') {
            paper.date = event.target.value;
            paper.year = (event.target.value.match(/\b(19|20)\d{2}\b/) || [''])[0];
          } else if (event.target.dataset.field === 'doi') {
            paper.doi = normalizeDoi(event.target.value) || event.target.value.trim();
            enrichPaperFromDoi(paper).then(() => render());
            return;
          } else if (event.target.dataset.field === 'areaId') {
            paper.areaId = event.target.value;
          } else if (event.target.dataset.field === 'color') {
            paper.color = event.target.value;
          } else {
            paper[event.target.dataset.field] = event.target.value;
          }
          render();
        });
      });

      els.paperList.querySelectorAll('[data-action="remove"]').forEach(button => {
        button.addEventListener('click', event => {
          const id = event.target.closest('[data-paper]').dataset.paper;
          state.papers = state.papers.filter(paper => paper.id !== id);
          if (state.selectedId === id) state.selectedId = null;
          if (state.selectedLinkId?.includes(id)) state.selectedLinkId = null;
          if (state.centerId === id) state.centerId = null;
          render();
        });
      });

      els.paperList.querySelectorAll('[data-action="focus"]').forEach(button => {
        button.addEventListener('click', event => {
          state.selectedId = event.target.closest('[data-paper]').dataset.paper;
          renderDetails();
          renderSelection();
        });
      });

      els.paperList.querySelectorAll('[data-action="paper-keyword"]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const term = cleanField(event.currentTarget.dataset.keyword || '');
          const card = event.currentTarget.closest('[data-paper]');
          const paper = state.papers.find(item => item.id === card?.dataset.paper);
          if (!term) return;
          if (paper) state.selectedId = paper.id;
          openTagActionMenu(term, event.currentTarget, paper?.id);
        });
      });

      els.paperList.querySelectorAll('[data-action="show-all-keywords"], [data-action="open-paper-keywords"]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const card = event.currentTarget.closest('[data-paper]');
          const paperId = button.dataset.paper || card?.dataset.paper;
          if (paperId) openKeywordModal(paperId);
        });
      });

      els.paperList.querySelectorAll('.pulse-paper-card, .paper-card').forEach(card => {
        card.addEventListener('click', event => {
          if (event.target.closest('button, input, select, textarea, .compact-chip')) return;
          state.selectedId = card.dataset.paper;
          renderSelection();
          renderDetails();
        });
      });

      els.paperList.querySelectorAll('[data-action="toggle-paper-active"]').forEach(chk => {
        chk.addEventListener('change', event => {
          event.stopPropagation();
          const card = event.target.closest('[data-paper]');
          const paper = state.papers.find(p => p.id === card?.dataset.paper);
          if (paper) {
            paper.selected = event.target.checked;
            render();
          }
        });
      });
    }

    function connectionStrengthLabel(score) {
      if (score >= 0.85) return 'Very Strong Connection';
      if (score >= 0.65) return 'Strong Connection';
      if (score >= 0.45) return 'Moderate Relationship';
      return 'Emerging / Weak Connection';
    }

    function focusPairOnMap(source, target) {
      if (!source || !target) return;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const dist = Math.max(80, Math.hypot(source.x - target.x, source.y - target.y));
      const targetWidth = Math.max(380, Math.min(1800, dist * 2.8));
      const targetHeight = targetWidth * 0.75;
      state.view.width = targetWidth;
      state.view.height = targetHeight;
      state.view.x = midX - targetWidth / 2;
      state.view.y = midY - targetHeight / 2;
      render();
      showToast(`Focused on ${compactTitle(source.title)} ↔ ${compactTitle(target.title)}.`);
    }

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
