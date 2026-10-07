
    function bindAreaEvents() {
      els.map.querySelectorAll('.area-region').forEach(region => {
        region.addEventListener('pointerdown', event => {
          if (event.target.closest?.('.area-resize-handle')) return;
          if (event.target.closest?.('.node')) return;
          event.stopPropagation();
          const area = state.areas.find(item => item.id === region.dataset.area);
          if (!area) return;
          const point = svgPoint(event);
          state.selectedAreaId = area.id;
          state.areaDrag = { id: area.id, offsetX: point.x - area.x, offsetY: point.y - area.y };
          region.setPointerCapture(event.pointerId);
          renderAreasPanel();
          renderSelection();
        });

        region.addEventListener('pointermove', event => {
          if (!state.areaDrag || state.areaDrag.id !== region.dataset.area) return;
          const area = state.areas.find(item => item.id === state.areaDrag.id);
          const point = svgPoint(event);
          const oldX = area.x;
          const oldY = area.y;
          area.x = point.x - state.areaDrag.offsetX;
          area.y = point.y - state.areaDrag.offsetY;
          const dx = area.x - oldX;
          const dy = area.y - oldY;
          state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
            paper.x += dx;
            paper.y += dy;
          });
          region.querySelector('rect')?.setAttribute('x', area.x);
          region.querySelector('rect')?.setAttribute('y', area.y);
          const label = region.querySelector('text');
          label?.setAttribute('x', area.x + 16);
          label?.setAttribute('y', area.y + 28);
          state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
            els.map.querySelector(`.node[data-id="${paper.id}"]`)?.setAttribute('transform', `translate(${paper.x},${paper.y})`);
          });
          renderEdgesOnly();
        });

        region.addEventListener('pointerup', () => {
          state.areaDrag = null;
          render();
        });
        region.addEventListener('pointercancel', () => { state.areaDrag = null; });
      });

      els.map.querySelectorAll('.area-resize-handle').forEach(handle => {
        handle.addEventListener('pointerdown', event => {
          event.stopPropagation();
          const region = event.target.closest('.area-region');
          const area = state.areas.find(item => item.id === region.dataset.area);
          if (!area) return;
          const point = svgPoint(event);
          state.selectedAreaId = area.id;
          state.areaResize = {
            id: area.id,
            pointerId: event.pointerId,
            startX: point.x,
            startY: point.y,
            width: area.width,
            height: area.height
          };
          handle.setPointerCapture(event.pointerId);
          els.map.setPointerCapture?.(event.pointerId);
          renderAreasPanel();
          renderSelection();
        });

        handle.addEventListener('pointermove', event => {
          updateAreaResize(event);
        });

        handle.addEventListener('pointerup', () => {
          state.areaResize = null;
          render();
        });
        handle.addEventListener('pointercancel', () => { state.areaResize = null; });
      });
    }

    function updateAreaResize(event) {
      if (!state.areaResize || state.areaResize.pointerId !== event.pointerId) return;
      const area = state.areas.find(item => item.id === state.areaResize.id);
      if (!area) return;
      const point = svgPoint(event);
      setAreaSize(area, state.areaResize.width + point.x - state.areaResize.startX, state.areaResize.height + point.y - state.areaResize.startY);
      const region = els.map.querySelector(`.area-region[data-area="${area.id}"]`);
      const rect = region?.querySelector('rect:not(.area-resize-handle)');
      const handle = region?.querySelector('.area-resize-handle');
      rect?.setAttribute('width', area.width);
      rect?.setAttribute('height', area.height);
      handle?.setAttribute('x', area.x + area.width - 15);
      handle?.setAttribute('y', area.y + area.height - 15);
      state.papers.filter(paper => paper.areaId === area.id).forEach(paper => {
        els.map.querySelector(`.node[data-id="${paper.id}"]`)?.setAttribute('transform', `translate(${paper.x},${paper.y})`);
      });
      renderEdgesOnly();
    }

    function bindCanvasPanEvents() {
      els.map.addEventListener('wheel', event => {
        event.preventDefault();
        zoomCanvasAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.12 : 0.88);
      }, { passive: false });

      els.map.addEventListener('pointerdown', event => {
        if (event.target.closest?.('.node') || event.target.closest?.('.edge') || event.target.closest?.('.edge-hit') || event.target.closest?.('.area-region')) return;
        state.panDrag = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          startX: state.view.x,
          startY: state.view.y
        };
        els.map.classList.add('is-panning');
        els.map.setPointerCapture(event.pointerId);
      });

      els.map.addEventListener('pointermove', event => {
        if (state.areaResize) {
          updateAreaResize(event);
          return;
        }
        if (!state.panDrag || state.panDrag.pointerId !== event.pointerId) return;
        const rect = els.map.getBoundingClientRect();
        const scaleX = state.view.width / Math.max(rect.width, 1);
        const scaleY = state.view.height / Math.max(rect.height, 1);
        state.view.x = state.panDrag.startX - (event.clientX - state.panDrag.clientX) * scaleX;
        state.view.y = state.panDrag.startY - (event.clientY - state.panDrag.clientY) * scaleY;
        els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
      });

      const endPan = event => {
        if (state.areaResize && state.areaResize.pointerId === event.pointerId) {
          state.areaResize = null;
          render();
          return;
        }
        if (!state.panDrag || state.panDrag.pointerId !== event.pointerId) return;
        state.panDrag = null;
        els.map.classList.remove('is-panning');
      };
      els.map.addEventListener('pointerup', endPan);
      els.map.addEventListener('pointercancel', endPan);
    }

    function zoomCanvasAt(clientX, clientY, factor) {
      const rect = els.map.getBoundingClientRect();
      const anchorX = state.view.x + ((clientX - rect.left) / Math.max(rect.width, 1)) * state.view.width;
      const anchorY = state.view.y + ((clientY - rect.top) / Math.max(rect.height, 1)) * state.view.height;
      const nextWidth = Math.max(220, Math.min(4200, state.view.width * factor));
      const nextHeight = Math.max(180, Math.min(3600, state.view.height * factor));
      const ratioX = (anchorX - state.view.x) / state.view.width;
      const ratioY = (anchorY - state.view.y) / state.view.height;
      state.view.width = nextWidth;
      state.view.height = nextHeight;
      state.view.x = anchorX - ratioX * state.view.width;
      state.view.y = anchorY - ratioY * state.view.height;
      els.map.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);
    }

    function centerGraphOnPaper(id, withBounce = true) {
      const paper = state.papers.find(item => item.id === id);
      if (!paper) return;

      if (recenterAnimId) {
        cancelAnimationFrame(recenterAnimId);
        recenterAnimId = null;
      }
      if (bounceAnimationTimer) {
        clearTimeout(bounceAnimationTimer);
        bounceAnimationTimer = null;
      }

      state.centerId = id;
      state.selectedId = id;

      const rect = els.map.getBoundingClientRect();
      const width = Math.max(rect.width, 640);
      const height = Math.max(rect.height, 520);
      const safeHeight = Math.max(360, height - bottomDockSpace());
      const centerX = width / 2;
      const centerY = safeHeight / 2;

      // 1. Snapshot start positions and camera view
      const startPositions = new Map();
      state.papers.forEach(p => {
        startPositions.set(p.id, { x: Number(p.x) || centerX, y: Number(p.y) || centerY });
      });
      const startViewX = Number(state.view.x) || 0;
      const startViewY = Number(state.view.y) || 0;

      // 2. Compute target positions using centered concentric layout
      layoutCenteredPaper(width, safeHeight, centerX, centerY);
      const targetPositions = new Map();
      state.papers.forEach(p => {
        targetPositions.set(p.id, { x: p.x, y: p.y });
      });

      // Target camera view is centered (0, 0)
      const targetViewX = 0;
      const targetViewY = 0;

      // Restore starting positions on paper objects so they start from current positions
      state.papers.forEach(p => {
        const s = startPositions.get(p.id);
        if (s) {
          p.x = s.x;
          p.y = s.y;
        }
      });

      // Set bouncing node ID for CSS animation & ripples
      bouncingNodeId = id;
      bounceAnimationTimer = setTimeout(() => {
        bouncingNodeId = null;
        els.map.querySelectorAll('.node.is-bouncing').forEach(el => el.classList.remove('is-bouncing'));
        els.map.querySelectorAll('.bounce-ripple, .bounce-ripple-2').forEach(el => el.remove());
      }, 1000);

      // Render DOM structure without altering start positions
      isRecenteringAnimation = true;
      render();

      if (!withBounce) {
        isRecenteringAnimation = false;
        return;
      }

      // 3. Elastic Spring / Bounce Animation
      const duration = 750;
      const startTime = performance.now();

      function easeOutBack(t) {
        const c1 = 1.9; // Spring overshoot factor
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }

      function animateBounce(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = progress >= 1 ? 1 : easeOutBack(progress);

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
      return selected ? [selected] : [];
    }
