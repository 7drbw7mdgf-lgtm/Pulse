
    function addSelectedDiscoveredToMap() {
      if (!state.discoveryResults?.length) return;
      const seed = state.discoverySeed || state.papers.find(p => p.id === state.selectedId) || state.papers[0];
      const selectedItems = state.discoveryResults.filter(item => state.discoverySelectedKeys.has(discoveryPaperKey(item)));
      if (!selectedItems.length) {
        showToast('Please select at least one paper using the tick boxes.');
        return;
      }

      let addedCount = 0;
      const totalToAdd = selectedItems.length;
      selectedItems.forEach((item, index) => {
        if (recommendationAlreadyOnMap(item)) return;
        const paper = paperFromRecommendation(item);
        const orbitIndex = Math.floor(index / 8);
        const posInOrbit = index % 8;
        const orbitRadius = 200 + orbitIndex * 120;
        const angle = (-Math.PI / 2) + posInOrbit * ((Math.PI * 2) / Math.min(8, Math.max(totalToAdd - orbitIndex * 8, 1)));
        paper.x = (seed?.x || state.view.x + state.view.width / 2) + Math.cos(angle) * orbitRadius;
        paper.y = (seed?.y || state.view.y + state.view.height / 2) + Math.sin(angle) * (orbitRadius * 0.85);
        paper.areaId = seed?.areaId || '';
        state.papers.push(paper);
        addedCount++;

        if (seed && seed.id !== paper.id) {
          const isBib = item.subType === 'Bibliographic coupling' || (item.discoveryBadges || []).some(b => b.includes('Bib Coupling'));
          const isCoCite = item.subType === 'Co-citation' || (item.discoveryBadges || []).some(b => b.includes('Co-citation'));
          const isSpecter = item.subType === 'SPECTER2' || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
          const ltype = isBib ? 'bibliographic' : (isCoCite ? 'cocitation' : (isSpecter ? 'similarity' : 'mixed'));
          state.links.push({
            source: seed.id,
            target: paper.id,
            score: item.score ? Math.min(0.95, Math.max(0.4, item.score / 100)) : 0.82,
            type: ltype,
            evidence: item.reason || 'S2AG Literature Discovery recommendation'
          });
        }
      });

      closeDiscoveryModal();
      render();
      if (addedCount > 0) {
        showToast(`Added ${addedCount} discovered paper${addedCount === 1 ? '' : 's'} to map & library.`);
      } else {
        showToast('Selected papers were already on the map.');
      }
    }

    function addSelectedDiscoveredToLibrary() {
      if (!state.discoveryResults?.length) return;
      const selectedItems = state.discoveryResults.filter(item => state.discoverySelectedKeys.has(discoveryPaperKey(item)));
      if (!selectedItems.length) {
        showToast('Please select at least one paper using the tick boxes.');
        return;
      }

      let addedCount = 0;
      selectedItems.forEach(item => {
        if (recommendationAlreadyOnMap(item)) return;
        const paper = paperFromRecommendation(item);
        paper.x = state.view.x + state.view.width / 2 + (Math.random() - 0.5) * 200;
        paper.y = state.view.y + state.view.height / 2 + (Math.random() - 0.5) * 200;
        state.papers.push(paper);
        addedCount++;
      });

      closeDiscoveryModal();
      render();
      if (addedCount > 0) {
        showToast(`Added ${addedCount} discovered paper${addedCount === 1 ? '' : 's'} to library.`);
      } else {
        showToast('Selected papers were already in your library.');
      }
    }

    function openKeywordModal(paperId) {
      const paper = state.papers.find(item => item.id === paperId);
      if (!paper) return;
      state.activeKeywordPaperId = paperId;
      if (!Array.isArray(paper.paperKeywords) || !paper.paperKeywords.length) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      if (els.keywordModalSubtitle) {
        els.keywordModalSubtitle.textContent = paper.title || 'Untitled paper';
      }
      renderKeywordModalTags();
      if (els.keywordModal) els.keywordModal.hidden = false;
      if (els.newKeywordInput) {
        els.newKeywordInput.value = '';
        els.newKeywordInput.focus();
      }
    }

    function closeKeywordModal() {
      state.activeKeywordPaperId = null;
      if (els.keywordModal) els.keywordModal.hidden = true;
    }

    function renderKeywordModalTags() {
      if (!state.activeKeywordPaperId) return;
      const paper = state.papers.find(item => item.id === state.activeKeywordPaperId);
      if (!paper) {
        closeKeywordModal();
        return;
      }
      if (!Array.isArray(paper.paperKeywords)) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      const keywords = paper.paperKeywords;
      if (els.keywordTagCount) {
        els.keywordTagCount.textContent = `${keywords.length} tag${keywords.length === 1 ? '' : 's'}`;
      }

      if (!keywords.length) {
        els.keywordTagList.innerHTML = '<div class="keyword-empty-msg">No keyword tags yet. Add tags using the input above or suggestions below.</div>';
      } else {
        els.keywordTagList.innerHTML = keywords.map((term, index) => `
          <div class="keyword-tag-chip" draggable="true" data-index="${index}" data-keyword="${escapeHtml(term)}" title="Drag to reorder (#${index + 1} importance)">
            <span class="keyword-drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
            <span class="keyword-rank-badge" title="Importance rank #${index + 1}">#${index + 1}</span>
            <span class="keyword-tag-text">${escapeHtml(term)}</span>
            <div class="keyword-tag-actions">
              <button class="keyword-move-btn" type="button" data-action="move-tag-up" data-index="${index}" title="Increase importance (move left)" ${index === 0 ? 'disabled' : ''}>◀</button>
              <button class="keyword-move-btn" type="button" data-action="move-tag-down" data-index="${index}" title="Decrease importance (move right)" ${index === keywords.length - 1 ? 'disabled' : ''}>▶</button>
              <button class="keyword-remove-btn" type="button" data-action="remove-tag" data-index="${index}" title="Remove tag">×</button>
            </div>
          </div>
        `).join('');
      }

      // Move buttons
      els.keywordTagList.querySelectorAll('[data-action="move-tag-up"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          if (idx > 0) reorderPaperKeywords(paper.id, idx, idx - 1);
        });
      });
      els.keywordTagList.querySelectorAll('[data-action="move-tag-down"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          if (idx < keywords.length - 1) reorderPaperKeywords(paper.id, idx, idx + 1);
        });
      });
      els.keywordTagList.querySelectorAll('[data-action="remove-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const idx = Number(btn.dataset.index);
          removePaperKeywordByIndex(paper.id, idx);
        });
      });

      // HTML5 Drag and Drop reordering
      els.keywordTagList.querySelectorAll('.keyword-tag-chip').forEach(chip => {
        chip.addEventListener('dragstart', event => {
          event.dataTransfer.setData('text/plain', chip.dataset.index);
          event.dataTransfer.effectAllowed = 'move';
          chip.classList.add('is-dragging');
        });
        chip.addEventListener('dragover', event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          chip.classList.add('is-dragover');
        });
        chip.addEventListener('dragleave', () => {
          chip.classList.remove('is-dragover');
        });
        chip.addEventListener('drop', event => {
          event.preventDefault();
          chip.classList.remove('is-dragover');
          const fromIdx = Number(event.dataTransfer.getData('text/plain'));
          const toIdx = Number(chip.dataset.index);
          if (!isNaN(fromIdx) && !isNaN(toIdx) && fromIdx !== toIdx) {
            reorderPaperKeywords(paper.id, fromIdx, toIdx);
          }
        });
        chip.addEventListener('dragend', () => {
          chip.classList.remove('is-dragging');
          els.keywordTagList.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
        });
      });

      // Suggestions from extracted terms, Gemma, discovery terms
      if (els.keywordSuggestionsSection && els.keywordSuggestionsList) {
        const activeSet = new Set(keywords.map(k => k.trim().toLowerCase()));
        const candidates = dedupeList([
          ...(paper.gemmaKeywords || []),
          ...(paper.discoveryTerms || []),
          ...(state.keywords.get(paper.id) || []),
          ...(paper.techniques || []),
          ...(paper.organisms || [])
        ].map(cleanField).filter(term => term.length >= 2 && term.length <= 48));

        const suggestions = candidates.filter(term => !activeSet.has(term.toLowerCase())).slice(0, 14);
        if (suggestions.length > 0) {
          els.keywordSuggestionsSection.hidden = false;
          els.keywordSuggestionsList.innerHTML = suggestions.map(term => `
            <button class="keyword-suggest-chip" type="button" data-term="${escapeHtml(term)}" title="Click to add as keyword tag">+ ${escapeHtml(term)}</button>
          `).join('');
          els.keywordSuggestionsList.querySelectorAll('.keyword-suggest-chip').forEach(btn => {
            btn.addEventListener('click', () => {
              addKeywordToPaper(paper.id, btn.dataset.term);
            });
          });
        } else {
          els.keywordSuggestionsSection.hidden = true;
        }
      }
    }

    function reorderPaperKeywords(paperId, fromIdx, toIdx) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper || !Array.isArray(paper.paperKeywords)) return;
      if (fromIdx < 0 || fromIdx >= paper.paperKeywords.length || toIdx < 0 || toIdx >= paper.paperKeywords.length) return;
      const [moved] = paper.paperKeywords.splice(fromIdx, 1);
      paper.paperKeywords.splice(toIdx, 0, moved);
      paper.keywords = [...paper.paperKeywords];
      renderKeywordModalTags();
      calculateRelatedness();
      render();
      scheduleAutosave();
    }

    function removePaperKeywordByIndex(paperId, index) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper || !Array.isArray(paper.paperKeywords)) return;
      const [removed] = paper.paperKeywords.splice(index, 1);
      if (removed) {
        const removedLower = removed.trim().toLowerCase();
        if (Array.isArray(paper.gemmaKeywords)) {
          paper.gemmaKeywords = paper.gemmaKeywords.filter(k => k.trim().toLowerCase() !== removedLower);
        }
        if (state.keywords.has(paper.id)) {
          state.keywords.set(paper.id, state.keywords.get(paper.id).filter(k => k.trim().toLowerCase() !== removedLower));
        }
        showToast(`Removed tag "${removed}".`);
      }
      paper.keywords = [...paper.paperKeywords];
      renderKeywordModalTags();
      calculateRelatedness();
      render();
      scheduleAutosave();
    }

    function addKeywordToPaper(paperId, newTerm) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper) return;
      const clean = cleanField(newTerm);
      if (!clean) return;
      if (!Array.isArray(paper.paperKeywords)) {
        paper.paperKeywords = [...mergedKeywords(paper)];
      }
      const lower = clean.toLowerCase();
      if (!paper.paperKeywords.some(k => k.trim().toLowerCase() === lower)) {
        paper.paperKeywords.push(clean);
        paper.keywords = [...paper.paperKeywords];
        showToast(`Added tag "${clean}".`);
        renderKeywordModalTags();
        calculateRelatedness();
        render();
        scheduleAutosave();
      }
    }

    function addKeywordsFromInput() {
      if (!state.activeKeywordPaperId || !els.newKeywordInput) return;
      const val = els.newKeywordInput.value.trim();
      if (!val) return;
      const terms = splitKeywords(val);
      const toAdd = terms.length ? terms : [val];
      toAdd.forEach(term => addKeywordToPaper(state.activeKeywordPaperId, term));
      els.newKeywordInput.value = '';
    }

    function paperMatchesFilters(paper) {
      if (!state.filterTags || !state.filterTags.length) return true;
      const paperTags = mergedKeywords(paper).map(k => k.toLowerCase().trim());
      if (state.filterMode === 'any') {
        return state.filterTags.some(tag => {
          const t = tag.toLowerCase().trim();
          return paperTags.some(k => k === t || k.includes(t) || t.includes(k));
        });
      }
      return state.filterTags.every(tag => {
        const t = tag.toLowerCase().trim();
        return paperTags.some(k => k === t || k.includes(t) || t.includes(k));
      });
    }

    function getLibraryAllTags() {
      const counts = new Map();
      state.papers.forEach(paper => {
        const kws = mergedKeywords(paper);
        kws.forEach(kw => {
          const cleaned = cleanField(kw);
          if (!cleaned) return;
          counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
        });
      });
      return Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    function renderTagFilterBar() {
      if (!els.tagFilterBar) return;
      const activeCount = state.filterTags.length;
      if (els.activeFilterBadge) {
        els.activeFilterBadge.hidden = activeCount === 0;
        els.activeFilterBadge.textContent = String(activeCount);
      }
      if (els.clearTagFiltersButton) {
        els.clearTagFiltersButton.hidden = activeCount === 0;
      }
      if (els.activeTagFiltersList) {
        els.activeTagFiltersList.innerHTML = state.filterTags.map(tag => `
          <span class="filter-tag-chip">
            <span>${escapeHtml(tag)}</span>
            <button class="remove-filter-btn" type="button" data-action="remove-filter-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove filter ${escapeHtml(tag)}">×</button>
          </span>
        `).join('');

        els.activeTagFiltersList.querySelectorAll('[data-action="remove-filter-tag"]').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            removeFilterTag(btn.dataset.tag);
          });
        });
      }

      renderLibraryTagCloud();

      if (els.canvasFilterBar && els.canvasFilterTags) {
        els.canvasFilterBar.hidden = activeCount === 0;
        if (activeCount > 0) {
          els.canvasFilterTags.innerHTML = state.filterTags.map(tag => `
            <span class="canvas-filter-pill">
              ${escapeHtml(tag)}
              <button type="button" data-action="remove-canvas-filter-tag" data-tag="${escapeHtml(tag)}" aria-label="Remove filter ${escapeHtml(tag)}">×</button>
            </span>
          `).join('');

          els.canvasFilterTags.querySelectorAll('[data-action="remove-canvas-filter-tag"]').forEach(btn => {
            btn.addEventListener('click', e => {
              e.stopPropagation();
              removeFilterTag(btn.dataset.tag);
            });
          });
        }
      }
    }
