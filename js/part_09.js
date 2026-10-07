
    let bouncingNodeId = null;
    let bounceAnimationTimer = null;
    let recenterAnimId = null;
    let isRecenteringAnimation = false;
    let lastNodeClickTime = 0;
    let lastNodeClickId = null;

    let settledLayoutKey = '';
    function layout(width, height) {
      if (isRecenteringAnimation) return;
      const key=JSON.stringify([relatednessRevision,state.mode,state.centerId,width,height,state.graphStyle.spacing,state.papers.map(p=>[p.id,Boolean(p.pinnedPosition)])]);
      if (key===settledLayoutKey) return;
      settledLayoutKey=key;
      const papers = state.papers;
      if (!papers.length) return;
      if (isRecenteringAnimation) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const radius = Math.max(80, Math.min(width, height) * 0.34 * spacing);

      if (state.centerId && layoutCenteredPaper(width, height, centerX, centerY)) return;

      if (state.mode === 'radial') {
        papers.forEach((paper, index) => {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        });
        return;
      }

      if (state.mode === 'clusters') {
        const clusterRadius = Math.max(65, Math.min(width, height) * 0.18 * spacing);
        state.clusters.forEach((cluster, clusterIndex) => {
          const angle = (Math.PI * 2 * clusterIndex) / Math.max(state.clusters.length, 1) - Math.PI / 2;
          const cx = centerX + Math.cos(angle) * radius * 0.72;
          const cy = centerY + Math.sin(angle) * radius * 0.72;
          cluster.forEach((id, index) => {
            const paper = papers.find(item => item.id === id);
            const localAngle = (Math.PI * 2 * index) / Math.max(cluster.length, 1);
            const cDist = Math.min(clusterRadius, 60 + cluster.length * 18);
            paper.x = cx + Math.cos(localAngle) * cDist;
            paper.y = cy + Math.sin(localAngle) * cDist;
          });
        });
        return;
      }

      papers.forEach((paper, index) => {
        if (!paper.x || !paper.y) {
          const angle = (Math.PI * 2 * index) / papers.length - Math.PI / 2;
          paper.x = centerX + Math.cos(angle) * radius;
          paper.y = centerY + Math.sin(angle) * radius;
        }
      });

      for (let tick = 0; tick < 58; tick += 1) {
        const forces = new Map(papers.map(paper => [paper.id, { x: 0, y: 0 }]));

        for (let i = 0; i < papers.length; i += 1) {
          for (let j = i + 1; j < papers.length; j += 1) {
            const a = papers[i];
            const b = papers[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distance = Math.max(45, Math.hypot(dx, dy));
            const push = (1600 * spacing * spacing) / (distance * distance);
            forces.get(a.id).x += (dx / distance) * push;
            forces.get(a.id).y += (dy / distance) * push;
            forces.get(b.id).x -= (dx / distance) * push;
            forces.get(b.id).y -= (dy / distance) * push;

            // Extra anti-collision repulsion specifically for horizontal text labels
            const minX = 120 * spacing;
            const minY = 54 * spacing;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx < minX && absDy < minY) {
              const repelX = (minX - absDx) * 0.08 * (dx >= 0 ? 1 : -1);
              const repelY = (minY - absDy) * 0.12 * (dy >= 0 ? 1 : -1);
              forces.get(a.id).x += repelX;
              forces.get(a.id).y += repelY;
              forces.get(b.id).x -= repelX;
              forces.get(b.id).y -= repelY;
            }
          }
        }

        state.links.forEach(link => {
          const a = papers.find(paper => paper.id === link.source);
          const b = papers.find(paper => paper.id === link.target);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const topologyBoost = link.type && link.type !== 'similarity' ? 0.32 : 0;
          const desired = (270 * spacing) - link.score * 105 - topologyBoost * 46;
          const pull = (distance - desired) * 0.0038 * (0.52 + link.score + topologyBoost);
          forces.get(a.id).x += (dx / distance) * pull;
          forces.get(a.id).y += (dy / distance) * pull;
          forces.get(b.id).x -= (dx / distance) * pull;
          forces.get(b.id).y -= (dy / distance) * pull;
        });

        const gravity = 0.0028 / Math.max(1, spacing * 0.75);
        const spanX = (width / 2 - 80) * Math.max(1, spacing);
        const spanY = (height / 2 - 70) * Math.max(1, spacing);
        papers.forEach(paper => {
          const force = forces.get(paper.id);
          if (paper.pinnedPosition) return;
          force.x += (centerX - paper.x) * gravity;
          force.y += (centerY - paper.y) * gravity;
          paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x + force.x));
          paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y + force.y));
        });
      }
    }

    function layoutCenteredPaper(width, height, centerX, centerY) {
      const focus = state.papers.find(paper => paper.id === state.centerId);
      if (!focus) {
        state.centerId = null;
        return false;
      }

      const linked = state.links
        .filter(link => link.source === focus.id || link.target === focus.id)
        .sort((a, b) => b.score - a.score);
      const neighborIds = linked.map(link => link.source === focus.id ? link.target : link.source);
      const neighborSet = new Set(neighborIds);
      const neighbors = neighborIds
        .map(id => state.papers.find(paper => paper.id === id))
        .filter(Boolean);
      const others = state.papers.filter(paper => paper.id !== focus.id && !neighborSet.has(paper.id));
      const shortestSide = Math.min(width, height);
      const spacing = state.graphStyle.spacing || 1;
      const innerRadius = Math.max(120, Math.min(shortestSide * 0.25, 260)) * spacing;
      const outerRadius = Math.max(innerRadius + 120, Math.min(shortestSide * 0.42, 430) * spacing);

      focus.x = centerX;
      focus.y = centerY;
      placePaperRing(neighbors, centerX, centerY, innerRadius, -Math.PI / 2);
      placePaperRing(others, centerX, centerY, outerRadius, -Math.PI / 2 + Math.PI / Math.max(others.length, 2));
      constrainPapers(width, height);
      return true;
    }

    function placePaperRing(papers, centerX, centerY, radius, offset) {
      papers.forEach((paper, index) => {
        const angle = offset + (Math.PI * 2 * index) / Math.max(papers.length, 1);
        paper.x = centerX + Math.cos(angle) * radius;
        paper.y = centerY + Math.sin(angle) * radius;
      });
    }

    function applyAreaContainment() {
      if (isRecenteringAnimation) return;
      const spacing = state.graphStyle.spacing || 1;
      state.areas.forEach(area => {
        const members = state.papers.filter(paper => paper.areaId === area.id);
        members.forEach((paper, index) => {
          if (pointInArea(paper.x, paper.y, area)) return;
          const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
          const rows = Math.max(1, Math.ceil(members.length / cols));
          const row = Math.floor(index / cols);
          const col = index % cols;
          const gapX = Math.max(58, Math.min(110 * spacing, area.width / Math.max(cols + 1, 2)));
          const gapY = Math.max(58, Math.min(96 * spacing, area.height / Math.max(rows + 1, 2)));
          paper.x = area.x + Math.min(area.width - 42, Math.max(42, (col + 1) * gapX));
          paper.y = area.y + Math.min(area.height - 42, Math.max(42, (row + 1) * gapY + 18));
        });
      });
    }

    function constrainPapers(width, height) {
      const centerX = width / 2;
      const centerY = height / 2;
      const spacing = state.graphStyle.spacing || 1;
      const spanX = (width / 2 - 80) * Math.max(1, spacing);
      const spanY = (height / 2 - 70) * Math.max(1, spacing);
      state.papers.forEach(paper => {
        paper.x = Math.min(centerX + spanX, Math.max(centerX - spanX, paper.x));
        paper.y = Math.min(centerY + spanY, Math.max(centerY - spanY, paper.y));
      });
    }

    function blowUpMap(factor = 1.35) {
      if (!state.papers.length) {
        showToast('Add papers to expand the map');
        return;
      }
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.min(4.0, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Maximum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startAreas = state.areas.map(a => ({ id: a.id, x: a.x, y: a.y, width: a.width, height: a.height }));
      const startTime = performance.now();
      const duration = 280;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        state.areas.forEach(a => {
          const orig = startAreas.find(sa => sa.id === a.id);
          if (orig) {
            a.x = cx + (orig.x - cx) * currentFactor;
            a.y = cy + (orig.y - cy) * currentFactor;
            a.width = orig.width * Math.sqrt(currentFactor);
            a.height = orig.height * Math.sqrt(currentFactor);
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map blown up (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function compressMap(factor = 0.75) {
      if (!state.papers.length) return;
      const currentSpacing = state.graphStyle.spacing || 1;
      const targetSpacing = Math.max(0.35, Number((currentSpacing * factor).toFixed(2)));
      if (Math.abs(targetSpacing - currentSpacing) < 0.01) {
        showToast('Minimum map spacing reached');
        return;
      }

      let sumX = 0, sumY = 0, count = 0;
      state.papers.forEach(p => {
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          sumX += p.x;
          sumY += p.y;
          count++;
        }
      });
      const cx = count ? sumX / count : (state.view.width / 2);
      const cy = count ? sumY / count : (state.view.height / 2);

      const startPositions = state.papers.map(p => ({ id: p.id, x: p.x, y: p.y }));
      const startTime = performance.now();
      const duration = 240;

      state.graphStyle.spacing = targetSpacing;
      if (els.spacingInput) {
        els.spacingInput.value = Math.round(targetSpacing * 100);
      }
      if (els.spacingValue) {
        els.spacingValue.textContent = `${Math.round(targetSpacing * 100)}%`;
      }

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentFactor = 1 + (factor - 1) * ease;

        state.papers.forEach(p => {
          const orig = startPositions.find(sp => sp.id === p.id);
          if (orig && typeof orig.x === 'number') {
            p.x = cx + (orig.x - cx) * currentFactor;
            p.y = cy + (orig.y - cy) * currentFactor;
          }
        });

        render();

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          showToast(`Map condensed (${Math.round(targetSpacing * 100)}% spacing)`);
        }
      }
      requestAnimationFrame(step);
    }

    function areaForPoint(x, y) {
      return [...state.areas].reverse().find(area => pointInArea(x, y, area));
    }

    function pointInArea(x, y, area) {
      return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
    }

    function resizeArea(area, field, value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      area[field] = Math.max(field === 'width' ? 160 : 110, Math.min(1200, next));
      applyAreaContainment();
    }

    function setAreaSize(area, width, height) {
      area.width = Math.max(160, Math.min(1200, width));
      area.height = Math.max(110, Math.min(1200, height));
      applyAreaContainment();
    }

    function createArea() {
      const index = state.areas.length;
      const width = Math.max(230, state.view.width * 0.28);
      const height = Math.max(150, state.view.height * 0.24);
      const area = {
        id: uid(),
        name: `Area ${index + 1}`,
        color: palette[index % palette.length],
        x: state.view.x + 92 + index * 34,
        y: state.view.y + 96 + index * 28,
        width,
        height
      };
      state.areas.push(area);
      state.selectedAreaId = area.id;
      setAreaPanelOpen(true);
      render();
      showToast(`Created ${area.name}.`);
    }
