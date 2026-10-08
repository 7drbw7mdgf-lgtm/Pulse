
    function recommendationKey(papers) {
      const steering = [
        state.recommendationSteerKeywords,
        state.recommendationExcludeKeywords,
        state.recommendationAuthors,
        state.recommendationJournals
      ].map(values => values.map(term => term.toLowerCase()).sort().join('__')).join('::');
      return [
        papers.map(paper => paper.id).sort().join('__'),
        steering,
        state.recommendationRecencyTilt,
        state.recommendationImpactTilt
      ].join('::steer:');
    }

    function parseSteerList(value, limit = 12) {
      return dedupeList(String(value || '')
        .split(/\s*(?:,|;|\n|\|)\s*/)
        .map(cleanField)
        .filter(term => term.length >= 2 && term.length <= 80))
        .slice(0, limit);
    }

    function parseSteerKeywords(value) {
      return parseSteerList(value, 12);
    }

    function dedupeList(values) {
      const seen = new Set();
      const result = [];
      values.forEach(value => {
        const key = String(value || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push(String(value).trim());
      });
      return result;
    }

    function setRecommendationSteerOpen(open) {
      state.recommendationSteerOpen = open;
      renderDetails();
    }

    function svgPoint(event) {
      const point = els.map.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      return point.matrixTransform(els.map.getScreenCTM().inverse());
    }

    function renderEdgesOnly() {
      els.map.querySelectorAll('.edge, .edge-hit').forEach(edge => {
        const source = state.papers.find(paper => paper.id === edge.dataset.source);
        const target = state.papers.find(paper => paper.id === edge.dataset.target);
        if (source && target) {
          edge.setAttribute('x1', source.x);
          edge.setAttribute('y1', source.y);
          edge.setAttribute('x2', target.x);
          edge.setAttribute('y2', target.y);
        }
      });
    }

    function renderSelection() {
      els.map.querySelectorAll('.node').forEach(node => {
        node.classList.toggle('is-selected', node.dataset.id === state.selectedId);
        node.classList.toggle('is-centered', node.dataset.id === state.centerId);
        node.classList.toggle('is-linked', selectedLinkEndpoints().has(node.dataset.id));
      });
      els.map.querySelectorAll('.edge').forEach(edge => edge.classList.toggle('is-selected', edge.dataset.link === state.selectedLinkId));
      els.map.querySelectorAll('.area-region').forEach(region => {
        region.classList.toggle('is-selected', region.dataset.area === state.selectedAreaId);
      });
      document.querySelectorAll('.pulse-paper-card, .paper-card, .library-table-row, .rail-card-item, .timeline-paper').forEach(card => {
        const id = card.dataset.paper || card.dataset.timelineId;
        card.classList.toggle('is-selected', id === state.selectedId);
      });
    }

    function inspectPaper(id, { closeAgent = true } = {}) {
      if (!state.papers.some(paper => paper.id === id)) return;
      state.selectedId = id;
      state.selectedLinkId = null;
      state.detailsAbstractExpanded = false;
      if (state.libraryFullscreen) setLibraryFullscreen(false);
      if (!state.inspectorVisible) setInspectorVisible(true);
      if (closeAgent && !els.aiPanel.hidden) setAiPanelOpen(false);
      renderSelection();
      renderDetails();
      els.details.scrollTop = 0;
      if (typeof updateAgentControls === 'function') updateAgentControls();
    }

    function metadataSummary(paper) {
      const parts = [];
      const authors = paperAuthors(paper);
      if (authors.length) parts.push(authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''));
      if (paper.year || paper.date) parts.push(paper.year || paper.date);
      if (paper.journal) parts.push(paper.journal);
      if (paper.doi) parts.push(`DOI ${paper.doi}`);
      return parts.length ? parts.join(' | ') : 'Metadata not found yet. Add authors, date, journal, or DOI here.';
    }

    function keyFindings(paper) {
      if ((paper.keyFindings || []).length) return paper.keyFindings.slice(0, 5);
      const source = cleanField(`${paper.abstract || ''} ${paper.text || ''}`).slice(0, 9000);
      const sentences = source
        .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
        .map(sentence => cleanField(sentence))
        .filter(sentence => sentence.length >= 45 && sentence.length <= 360)
        .filter(sentence => !/^(abstract|introduction|references|keywords?)\b/i.test(sentence));
      const signals = [
        /\b(result|results|finding|findings|found|show|shows|showed|demonstrate|demonstrates|reveals?|suggests?)\b/i,
        /\b(conclude|concludes|conclusion|indicate|indicates|evidence|associated|improves?|reduces?|increases?)\b/i,
        /\b(significant|novel|important|key|major|robust|effective|efficient|higher|lower)\b/i,
        /\b(we|this study|this paper|our)\b/i
      ];
      const scored = sentences.map((sentence, index) => ({
        sentence,
        score: signals.reduce((score, pattern) => score + (pattern.test(sentence) ? 1 : 0), 0) + (index < 3 ? 0.4 : 0)
      }));
      const findings = scored
        .filter(item => item.score >= 1.4)
        .sort((a, b) => b.score - a.score)
        .map(item => item.sentence)
        .slice(0, 3);
      if (findings.length) return findings;
      if (paper.abstract) return [cleanField(paper.abstract).slice(0, 260)];
      return mergedKeywords(paper).length ? [`Themes: ${mergedKeywords(paper).slice(0, 6).join(', ')}.`] : [];
    }

    function evidenceSummary(paper) {
      const bits = [];
      if (paper.metadataSource) bits.push(paper.metadataSource);
      if ((paper.referenceIds || []).length) bits.push(`${paper.referenceIds.length} refs`);
      if ((paper.citedByIds || []).length) bits.push(`${paper.citedByIds.length} citing samples`);
      if (paper.citedByCount) bits.push(`${paper.citedByCount} citations`);
      if ((paper.text || '').length) bits.push(`${Math.round((paper.text || '').length / 100) / 10}k chars`);
      return bits.join(' | ') || 'Metadata only';
    }

    function renderLinkages() {
      if (!els.linkageList) return;
      const sorted = [...state.links].sort((a, b) => b.score - a.score);
      els.linkageSummary.textContent = sorted.length
        ? `${sorted.length} link${sorted.length === 1 ? '' : 's'} at ${Math.round(state.threshold * 100)}% threshold.`
        : (state.papers.length < 2 ? 'Add at least two papers to create links.' : 'No links above the current threshold.');

      els.linkageList.innerHTML = sorted.length ? sorted.map(link => {
        const source = state.papers.find(paper => paper.id === link.source);
        const target = state.papers.find(paper => paper.id === link.target);
        const id = linkId(link);
        const selected = state.selectedLinkId === id ? ' is-selected' : '';
        const sharedTerms = sharedKeywords(source, target).slice(0, 5);
        return `<button class="linkage-item${selected}" data-link="${id}" type="button">
          <span class="linkage-score">${escapeHtml(linkTypeName(link))} · ${Math.round(link.score * 100)}%</span>
          <span class="linkage-title">${escapeHtml(source.title)} ↔ ${escapeHtml(target.title)}</span>
          <span class="linkage-meta">${escapeHtml(link.evidence || (sharedTerms.length ? `Shared terms: ${sharedTerms.join(', ')}` : 'Related through document text and metadata.'))}</span>
        </button>`;
      }).join('') : '<div class="settings-status">No linkages selected. Load papers or lower the similarity threshold to reveal weaker relationships.</div>';

      els.linkageList.querySelectorAll('[data-link]').forEach(button => {
        button.addEventListener('click', () => selectLinkage(button.dataset.link));
      });
    }

    function renderAreasPanel() {
      if (!els.areaList) return;
      els.areaList.innerHTML = state.areas.length ? state.areas.map(area => {
        const count = state.papers.filter(paper => paper.areaId === area.id).length;
        const selected = state.selectedAreaId === area.id ? ' is-selected' : '';
        return `<div class="area-row${selected}" data-area="${area.id}">
          <input type="color" value="${escapeHtml(area.color)}" data-area-field="color" aria-label="Area color">
          <input type="text" value="${escapeHtml(area.name)}" data-area-field="name" aria-label="Area name">
          <button class="icon-button danger" type="button" data-action="remove-area" aria-label="Remove area">×</button>
          <div class="metadata-line">${count} paper${count === 1 ? '' : 's'} inside. Drag the map region to move its papers, or drag the corner handle to resize.</div>
          <div class="area-size-presets" aria-label="Area size presets">
            <button type="button" data-area-preset="small">Small</button>
            <button type="button" data-area-preset="medium">Medium</button>
            <button type="button" data-area-preset="wide">Wide</button>
          </div>
          <div class="area-size-row">
            <label>Width
              <input type="number" min="160" max="1200" step="10" value="${Math.round(area.width)}" data-area-size="width">
            </label>
            <label>Height
              <input type="number" min="110" max="1200" step="10" value="${Math.round(area.height)}" data-area-size="height">
            </label>
          </div>
        </div>`;
      }).join('') : '<div class="settings-status">No areas yet. Press + Area to create a named region on the map.</div>';

      els.areaList.querySelectorAll('.area-row').forEach(row => {
        row.addEventListener('click', event => {
          if (event.target.closest('button, input')) return;
          state.selectedAreaId = row.dataset.area;
          renderSelection();
          renderAreasPanel();
        });
      });

      els.areaList.querySelectorAll('[data-area-field]').forEach(input => {
        input.addEventListener('input', event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          area[event.target.dataset.areaField] = event.target.value;
          state.selectedAreaId = area.id;
        });
        input.addEventListener('change', () => render());
      });
      els.areaList.querySelectorAll('[data-area-size]').forEach(input => {
        const updateSize = event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          resizeArea(area, event.target.dataset.areaSize, event.target.value);
          state.selectedAreaId = area.id;
          render();
        };
        input.addEventListener('input', updateSize);
        input.addEventListener('change', updateSize);
      });
      els.areaList.querySelectorAll('[data-area-preset]').forEach(button => {
        button.addEventListener('click', event => {
          const row = event.target.closest('[data-area]');
          const area = state.areas.find(item => item.id === row.dataset.area);
          if (!area) return;
          const preset = event.target.dataset.areaPreset;
          const sizes = {
            small: [220, 150],
            medium: [320, 220],
            wide: [460, 240]
          };
          const [width, height] = sizes[preset] || sizes.medium;
          setAreaSize(area, width, height);
          state.selectedAreaId = area.id;
          render();
        });
      });
      els.areaList.querySelectorAll('[data-action="remove-area"]').forEach(button => {
        button.addEventListener('click', event => removeArea(event.target.closest('[data-area]').dataset.area));
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
