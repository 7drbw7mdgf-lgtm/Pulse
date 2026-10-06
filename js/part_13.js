        // Interpolate camera view
        state.view.x = startViewX + (targetViewX - startViewX) * ease;
        state.view.y = startViewY + (targetViewY - startViewY) * ease;
        els.map.setAttribute('viewBox', `${state.view.x.toFixed(1)} ${state.view.y.toFixed(1)} ${state.view.width} ${state.view.height}`);

        // Interpolate paper positions
        state.papers.forEach(p => {
          const start = startPositions.get(p.id);
          const target = targetPositions.get(p.id);
          if (start && target) {
            p.x = start.x + (target.x - start.x) * ease;
            p.y = start.y + (target.y - start.y) * ease;
          }
        });

        // Update DOM node translations
        els.map.querySelectorAll('.node').forEach(nodeEl => {
          const p = state.papers.find(item => item.id === nodeEl.dataset.id);
          if (p) {
            nodeEl.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
          }
        });

        // Update SVG edge line endpoints
        renderEdgesOnly();

        if (progress < 1) {
          recenterAnimId = requestAnimationFrame(animateBounce);
        } else {
          recenterAnimId = null;
          isRecenteringAnimation = false;
          // Finalize at exact target positions
          state.view.x = targetViewX;
          state.view.y = targetViewY;
          els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
          state.papers.forEach(p => {
            const target = targetPositions.get(p.id);
            if (target) {
              p.x = target.x;
              p.y = target.y;
            }
          });
          els.map.querySelectorAll('.node').forEach(nodeEl => {
            const p = state.papers.find(item => item.id === nodeEl.dataset.id);
            if (p) {
              nodeEl.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
            }
          });
          renderEdgesOnly();
          renderSelection();
          renderDetails();
        }
      }

      recenterAnimId = requestAnimationFrame(animateBounce);
      showToast(`Centered graph on "${compactTitle(paper.title)}".`);
    }

    function clearCenteredPaper() {
      if (!state.centerId) return;
      state.centerId = null;
      render();
      showToast('Centered graph cleared.');
    }

    function bindEdgeEvents() {
      els.map.querySelectorAll('.edge, .edge-hit').forEach(edge => {
        edge.addEventListener('click', event => {
          event.stopPropagation();
          selectLinkage(edge.dataset.link);
        });
        edge.addEventListener('mouseenter', () => {
          const id = edge.dataset.link;
          const vEdge = els.map.querySelector(`.edge[data-link="${id}"]`);
          if (vEdge) vEdge.classList.add('is-hovered');
        });
        edge.addEventListener('mouseleave', () => {
          const id = edge.dataset.link;
          const vEdge = els.map.querySelector(`.edge[data-link="${id}"]`);
          if (vEdge) vEdge.classList.remove('is-hovered');
        });
      });
    }

    function selectLinkage(id) {
      state.inspectorOpen = true;
      state.selectedLinkId = id;
      state.selectedId = null;
      render();
      if (els.details) {
        els.details.hidden = false;
        els.details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    function clearLinkageSelection() {
      state.selectedLinkId = null;
      render();
    }

    function selectedPapersForRecommendation() {
      const selectedLink = state.links.find(item => linkId(item) === state.selectedLinkId);
      if (selectedLink) {
        return [selectedLink.source, selectedLink.target]
          .map(id => state.papers.find(paper => paper.id === id))
          .filter(Boolean);
      }
      const selected = state.papers.find(item => item.id === state.selectedId);
      const pinned = state.papers.find(item => item.id === state.pinnedSeedId);
      return pinned ? [pinned] : (selected ? [selected] : []);
    }

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
        const source = papersById.get(edge.dataset.source);
        const target = papersById.get(edge.dataset.target);
        if (source && target) {
          edge.setAttribute('x1', source.x);
          edge.setAttribute('y1', source.y);
          edge.setAttribute('x2', target.x);
          edge.setAttribute('y2', target.y);
        }
      });
    }

    function renderSelection() {
      if(paintedSelectedLinkId!==state.selectedLinkId) {
        for(const id of new Set([paintedSelectedLinkId,state.selectedLinkId].filter(Boolean))) {
          const link=linksById.get(id);if(!link)continue;
          const selected=id===state.selectedLinkId;
          const width=(.55+link.score*3.15)*(state.graphStyle.edgeScale||.65);
          for(const edge of edgeElementsById.get(id)||[]) {
            edge.classList.toggle('is-selected',selected);
            edge.setAttribute('stroke-width',(selected?width+2.4:width).toFixed(2));
            edge.setAttribute('opacity',selected?'1':Math.min(.72,.18+link.score*.48).toFixed(2));
          }
        }
        paintedSelectedLinkId=state.selectedLinkId;
      }
      const linked=selectedLinkEndpoints();
      els.map.querySelectorAll('.node').forEach(node => {
        node.classList.toggle('is-linked',linked.has(node.dataset.id));
        node.classList.toggle('is-selected', node.dataset.id === state.selectedId);
        node.classList.toggle('is-centered', node.dataset.id === state.centerId);
      });
      els.map.querySelectorAll('.area-region').forEach(region => {
        region.classList.toggle('is-selected', region.dataset.area === state.selectedAreaId);
      });
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
      const sorted = [...state.links].sort((a, b) => b.score - a.score).slice(0,2500);
      els.linkageSummary.textContent = sorted.length
        ? `${sorted.length} link${sorted.length === 1 ? '' : 's'} at ${Math.round(state.threshold * 100)}% threshold.`
        : (state.papers.length < 2 ? 'Add at least two papers to create links.' : 'No links above the current threshold.');

      els.linkageList.innerHTML = sorted.length ? sorted.map(link => {
        const source = papersById.get(link.source);
        const target = papersById.get(link.target);
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
