
    function closePaperPopup() {
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
        const href = safeHref(item.doi ? `https://doi.org/${item.doi}` : (item.url || (item.s2PaperId ? `https://www.semanticscholar.org/paper/${item.s2PaperId}` : '') || item.openAlexId || '#'));
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
        const href = safeHref(item.doi ? `https://doi.org/${item.doi}` : (item.url || item.openAlexId || '#'));
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
        || (titleKey && cleanField(paper.title || '').toLowerCase() === titleKey)
      );
    }

    function paperFromRecommendation(item) {
      return normalizeImportedPaper({
        ...item,
        paperKeywords: item.paperKeywords || item.keywords || [],
        text: `${item.title || ''}\n\n${item.abstract || ''}\n\n${(item.paperKeywords || item.keywords || []).join('; ')}`,
        name: item.source ? `${item.source} recommendation` : 'Recommended paper'
      }, item.source ? `${item.source} recommendation` : 'Recommendation');
    }

    function addRecommendationTrailToMap(seed, recommendations, count = 3) {
      const fresh = (recommendations || [])
        .filter(item => item.title !== 'Recommendation search failed' && item.title !== 'Discovery search failed' && !recommendationAlreadyOnMap(item))
        .slice(0, count);
      fresh.forEach((item, index) => {
        const paper = paperFromRecommendation(item);
        const angle = (-Math.PI / 2) + index * ((Math.PI * 2) / Math.max(fresh.length, 3));
        paper.x = (seed?.x || 0) + Math.cos(angle) * 180;
        paper.y = (seed?.y || 0) + Math.sin(angle) * 150;
        paper.areaId = seed?.areaId || '';
        state.papers.push(paper);
        if (seed && seed.id !== paper.id) {
          const isBib = item.subType === 'Bibliographic coupling' || (item.discoveryBadges || []).some(b => b.includes('Bib Coupling'));
          const isCoCite = item.subType === 'Co-citation' || (item.discoveryBadges || []).some(b => b.includes('Co-citation'));
          const isSpecter = item.subType === 'SPECTER2' || (item.discoveryBadges || []).some(b => b.includes('SPECTER2'));
          const ltype = isBib ? 'bibliographic' : (isCoCite ? 'cocitation' : (isSpecter ? 'similarity' : 'mixed'));
          state.links.push({
            source: seed.id,
            target: paper.id,
            score: item.score ? Math.min(0.95, item.score / 100) : 0.82,
            type: ltype,
            evidence: item.reason || 'S2AG Literature Discovery recommendation'
          });
        }
      });
      return fresh.length;
    }

    function recommendationFeedbackTerms(item) {
      const terms = [
        ...(item?.paperKeywords || item?.keywords || []),
        ...tokenize(`${item?.title || ''} ${item?.abstract || ''}`).filter(term => !term.includes(' '))
      ];
      return dedupeList(terms.map(cleanField).filter(term => term.length >= 4 && term.length <= 48)).slice(0, 5);
    }

    function steerFromRecommendation(index, direction) {
      const seeds = selectedPapersForRecommendation();
      const key = recommendationKey(seeds);
      const item = (state.recommendations.get(key) || [])[index];
      if (!item) return;
      const terms = recommendationFeedbackTerms(item);
      if (!terms.length) {
        showToast('No useful feedback terms found for that recommendation.');
        return;
      }
      if (direction === 'less') {
        state.recommendationExcludeKeywords = dedupeList([...terms, ...state.recommendationExcludeKeywords]).slice(0, 16);
        showToast('Added terms to steer away from.');
      } else {
        state.recommendationSteerKeywords = dedupeList([...terms, ...state.recommendationSteerKeywords]).slice(0, 12);
        state.graphSteerKeywords = dedupeList([...terms.slice(0, 3), ...state.graphSteerKeywords]).slice(0, 12);
        showToast('Added terms to steer toward and refocus the map.');
      }
      state.recommendationSteerOpen = true;
      render();
    }

    function citationPaperPayload(paper) {
      return {
        id: paper.id,
        title: paper.title || '',
        doi: paper.doi || '',
        s2PaperId: paper.s2PaperId || '',
        openAlexId: paper.openAlexId || '',
        openAlexUrl: paper.openAlexUrl || '',
        techniques: paper.techniques || [],
        organisms: paper.organisms || [],
        paperKeywords: paper.paperKeywords || paper.keywords || [],
        referenceIds: paper.referenceIds || [],
        citedByIds: paper.citedByIds || []
      };
    }

    function applyCitationMetadata(paper, metadata = {}) {
      mergeDoiMetadata(paper, metadata);
      if (metadata.s2PaperId) paper.s2PaperId = metadata.s2PaperId;
      if (metadata.influentialCitationCount) paper.influentialCitationCount = metadata.influentialCitationCount;
      paper.openAlexId = normalizeOpenAlexId(metadata.openAlexId || metadata.openAlexUrl || paper.openAlexId || '');
      paper.openAlexUrl = metadata.openAlexUrl || paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${paper.openAlexId}` : '');
      paper.referenceIds = dedupeList([...(paper.referenceIds || []), ...(metadata.referenceIds || [])].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      paper.citedByIds = dedupeList([...(paper.citedByIds || []), ...(metadata.citedByIds || [])].map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160);
      paper.citedByCount = Number(metadata.citedByCount || paper.citedByCount || 0);
    }

    async function mapCitationTopology() {
      if (!state.papers.length) {
        showToast('Load papers before mapping citations.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/enrich'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ papers: state.papers.map(citationPaperPayload) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not map citations.');
        (data.papers || []).forEach(item => {
          const paper = state.papers.find(candidate => candidate.id === item.id)
            || state.papers.find(candidate => sameDoi(candidate.doi || '', item.doi || ''));
          if (paper) applyCitationMetadata(paper, item.metadata || {});
        });
        showToast(`Mapped citation topology for ${(data.papers || []).length} paper${(data.papers || []).length === 1 ? '' : 's'}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    async function findMissingSeminal() {
      if (!state.papers.some(paper => (paper.referenceIds || []).length)) {
        await mapCitationTopology();
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/seminal'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ papers: state.papers.map(citationPaperPayload), threshold: Math.max(2, Math.ceil(state.papers.length * 0.35)) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not find missing seminal papers.');
        state.seminalSuggestions = data.recommendations || [];
        showToast(state.seminalSuggestions.length ? `Found ${state.seminalSuggestions.length} missing foundational paper${state.seminalSuggestions.length === 1 ? '' : 's'}.` : 'No common missing reference found yet.');
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }

    async function snowballSelectedPaper(direction) {
      const seed = state.papers.find(item => item.id === state.selectedId);
      if (!seed) {
        showToast('Select a paper first.');
        return;
      }
      state.citationLoading = true;
      renderDetails();
      try {
        const response = await fetch(backendUrl('/api/citations/snowball'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ paper: citationPaperPayload(seed), direction, limit: 25 })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not snowball from this paper.');
        const added = addCitationPapersToMap(seed, data.recommendations || [], direction);
        showToast(`Citation chase found ${(data.recommendations || []).length} papers and added ${added}.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        state.citationLoading = false;
        render();
      }
    }
