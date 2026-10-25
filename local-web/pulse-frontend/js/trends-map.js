/* Trends map: topic groups as flat bubbles with their papers in orbit, drawn from the Trends page's shared selection. */
const TrendsMap = (() => {
  const wrap = document.createElement('div'), canvas = document.createElement('canvas'), tip = document.createElement('div');
  wrap.className = 'trends-map'; tip.className = 'trends-map-tip'; tip.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('aria-hidden', 'true');
  wrap.append(canvas, tip);
  const ctx = canvas.getContext('2d'), view = { w: 0, h: 0, dpr: 1 }, palette = {};
  const nodes = new Map();
  const scene = { list: [], orbiters: [], byPaper: new Map(), hoverNode: null, hoverPaper: null, linked: null, drag: null, data: null };
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let fit = 1, last = 0, running = false;

  function readPalette() {
    const style = getComputedStyle(wrap.isConnected ? wrap : document.documentElement);
    const read = name => style.getPropertyValue(name).trim();
    Object.assign(palette, { rising: read('--ok'), falling: read('--danger'), new: read('--warn'), unclear: read('--trends-map-neutral') || read('--muted'),
      paper: read('--ink-2'), ink: read('--ink'), line: read('--line-strong') || read('--line'), accent: read('--accent') });
  }
  new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette);

  function layoutScale() {
    const area = scene.list.reduce((sum, node) => sum + Math.PI * (node.target + 34) ** 2, 0);
    fit = Math.max(.35, Math.min(1.15, Math.sqrt(view.w * view.h * .42 / Math.max(1, area))));
  }
  function resize() {
    const box = wrap.getBoundingClientRect();
    if (!box.width || !box.height) return;
    view.w = box.width; view.h = box.height; view.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(view.w * view.dpr); canvas.height = Math.round(view.h * view.dpr);
    layoutScale();
  }
  new ResizeObserver(resize).observe(wrap);

  const radius = node => node.size * fit * node.scale;
  const spacing = node => (scene.data?.group === node.id ? 13 : 8) * fit * Math.max(.6, node.scale);
  const orbitRadius = (node, ring) => radius(node) + 10 * fit + ring * spacing(node);
  const extent = node => node.size < 1 ? 0 : orbitRadius(node, 4) + 5;

  function step(dt) {
    const selected = scene.data?.group, focus = nodes.get(selected), cx = view.w / 2, cy = view.h / 2;
    for (const node of scene.list) {
      node.scale += ((focus ? (node === focus ? 1.35 : .6) : 1) - node.scale) * Math.min(1, dt * 5);
      node.size += (node.target - node.size) * Math.min(1, dt * 4);
      if (scene.drag?.node === node) continue;
      const pull = node === focus ? 5 : 1.1;
      node.vx += (cx - node.x) * pull * dt; node.vy += (cy - node.y) * pull * dt * 1.4;
    }
    const list = scene.list;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy) || .01;
      const overlap = extent(a) + extent(b) + 4 - distance;
      if (overlap <= 0) continue;
      // A dragged or selected bubble holds its place and pushes the other.
      const fixedA = scene.drag?.node === a || a === focus, fixedB = scene.drag?.node === b || b === focus;
      const wa = fixedA ? 0 : fixedB ? 1 : .5, wb = fixedB ? 0 : fixedA ? 1 : .5;
      const nx = dx / distance, ny = dy / distance, rate = Math.min(1, dt * 8) * overlap;
      a.x -= nx * rate * wa; a.y -= ny * rate * wa; b.x += nx * rate * wb; b.y += ny * rate * wb;
      a.vx -= nx * overlap * wa * 2; a.vy -= ny * overlap * wa * 2; b.vx += nx * overlap * wb * 2; b.vy += ny * overlap * wb * 2;
    }
    const damping = Math.pow(.02, dt);
    for (const node of list) {
      if (scene.drag?.node === node) continue;
      node.vx *= damping; node.vy *= damping; node.x += node.vx * dt; node.y += node.vy * dt;
      const margin = Math.min(Math.max(extent(node), 16), view.w / 2, view.h / 2);
      node.x = Math.max(margin, Math.min(view.w - margin, node.x));
      node.y = Math.max(margin, Math.min(view.h - margin, node.y));
    }
    const now = performance.now(), spin = still.matches ? 0 : 1;
    list.forEach((node, index) => {
      const direction = index % 2 ? -1 : 1;
      for (const orbiter of node.orbiters) {
        orbiter.alpha += ((orbiter.visible ? 1 : 0) - orbiter.alpha) * Math.min(1, dt * 4);
        if (orbiter !== scene.hoverPaper) orbiter.angle += spin * direction * dt * .35 / (1 + orbiter.ring * .55);
        const r = orbitRadius(node, orbiter.ring) * (1 + spin * .03 * Math.sin(now / 900 + orbiter.phase)) * (.6 + .4 * orbiter.alpha);
        orbiter.x = node.x + Math.cos(orbiter.angle) * r; orbiter.y = node.y + Math.sin(orbiter.angle) * r;
      }
    });
  }

  const font = (weight, size) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  function wrapText(text, width) {
    const shorten=value=>{let result=value;while(result.length>1&&ctx.measureText(result+'…').width>width)result=result.slice(0,-1);return result+'…';};
    const lines=[];
    let line='';
    for(const word of text.split(/\s+/)){
      const token=ctx.measureText(word).width>width?shorten(word):word;
      const trial=line?line+' '+token:token;
      if(ctx.measureText(trial).width>width&&line){lines.push(line);line=token;}else line=trial;
    }
    if(line)lines.push(line);
    if(lines.length>3)return [...lines.slice(0,2),shorten(lines[2])];
    return lines;
  }
  function drawLabel(node, r) {
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=palette.ink;
    // Small clusters show their count; full names remain in the tooltip and list.
    // Larger labels stay inside their bubble instead of colliding with neighbours.
    if(r<20){ctx.font=font(600,10);ctx.fillText(node.stats.split(' · ')[0],node.x,node.y);return;}
    const size=Math.max(9,Math.min(12,r/3.2));
    ctx.font=font(600,size);
    const lines=wrapText(node.label,r*1.65),height=size*1.2;
    const top=node.y-(lines.length*height+size)/2;
    lines.forEach((line,index)=>ctx.fillText(line,node.x,top+height*index+height/2));
    ctx.font=font(500,Math.max(8,size*.8));ctx.fillStyle=palette.paper;
    ctx.fillText(node.stats,node.x,top+height*lines.length+size*.6);
  }

  function draw() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    const { hoverNode, hoverPaper } = scene, selected = nodes.get(scene.data?.group), topic = scene.data?.topicPapers;
    const dimmed = node => (hoverNode && hoverNode !== node) || (selected && selected !== node && !(scene.linked && scene.linked.includes(node)));
    for (const node of scene.list) {
      if (node.size < 1) continue;
      ctx.globalAlpha = dimmed(node) ? .25 : .6; ctx.strokeStyle = palette.line; ctx.lineWidth = 1;
      for (let ring = 0; ring < 5; ring++) {
        if (!node.orbiters.some(orbiter => orbiter.visible && orbiter.ring === ring)) continue;
        ctx.setLineDash(ring === 4 ? [3, 4] : []);
        ctx.beginPath(); ctx.arc(node.x, node.y, orbitRadius(node, ring), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    if (hoverPaper && scene.linked) {
      ctx.globalAlpha = .8; ctx.lineWidth = 1.2;
      for (const other of scene.linked) {
        ctx.strokeStyle = palette[other.status];
        ctx.beginPath(); ctx.moveTo(hoverPaper.x, hoverPaper.y); ctx.lineTo(other.x, other.y); ctx.stroke();
      }
    }
    for (const orbiter of scene.orbiters) {
      if (orbiter.alpha < .02) continue;
      const hot = orbiter === hoverPaper || orbiter.id === scene.data?.selectedPaper, hit = topic?.has(orbiter.id);
      const faded = (dimmed(orbiter.node) && !hot) || (topic && !hit) || !orbiter.emphasis;
      ctx.globalAlpha = (faded ? .16 : [.95, .8, .62, .45, .4][orbiter.ring]) * orbiter.alpha;
      ctx.fillStyle = hot || hit ? palette.accent : palette.paper;
      ctx.beginPath(); ctx.arc(orbiter.x, orbiter.y, (hot ? 5 : hit ? 3.6 : 2.4) * Math.max(.8, fit), 0, Math.PI * 2); ctx.fill();
    }
    for (const node of scene.list) {
      const r = radius(node);
      if (r < 2) continue;
      const alpha = dimmed(node) ? .35 : 1, colour = palette[node.status] || palette.unclear;
      ctx.shadowColor = colour; ctx.shadowBlur = node === selected || node === hoverNode ? 16 : 6;
      ctx.globalAlpha = alpha * .13; ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(node.x, node.y, r * (node === hoverNode ? 1.04 : 1), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = alpha; ctx.strokeStyle = colour; ctx.lineWidth = node === selected ? 2.5 : 1.5; ctx.stroke();
      ctx.shadowBlur = 0;
      if (r >= 10) drawLabel(node, r);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    // The loop stops whenever the map leaves the page or the Trends view is hidden; mount restarts it.
    if (!wrap.isConnected || !wrap.offsetParent || document.hidden) { running = false; return; }
    const dt = Math.min(.033, (now - last) / 1000);
    last = now;
    if (!view.w) resize();
    step(dt); draw();
    requestAnimationFrame(frame);
  }

  function wake() {
    if (running || !scene.data) return;
    running = true; last = performance.now(); requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', wake);

  /* Rebuild bubbles and orbits from the page's groups and selection, keeping positions of groups that persist. */
  function mount(slot, data) {
    if (wrap.parentNode !== slot) slot.append(wrap);
    tip.classList.remove('show');
    readPalette();
    scene.data = data;
    resize();
    const seen = new Set();
    scene.orbiters = []; scene.byPaper = new Map();
    scene.list = data.groups.map((group, index) => {
      seen.add(group.id);
      let node = nodes.get(group.id);
      if (!node) {
        const angle = index * 2.399, spread = 30 + index * 16;
        node = { id: group.id, x: view.w / 2 + Math.cos(angle) * spread, y: view.h / 2 + Math.sin(angle) * spread, vx: 0, vy: 0, scale: .2, size: 0, orbiters: [] };
        nodes.set(group.id, node);
      }
      const previous = new Map(node.orbiters.map(orbiter => [orbiter.id, orbiter]));
      Object.assign(node, { label: group.label, status: group.status, stats: group.stats, tip: group.tip, target: group.visible ? 18 + Math.sqrt(group.visible) * 8 : 0 });
      node.orbiters = group.papers.map((paper, i) => {
        const orbiter = previous.get(paper.id) || { id: paper.id, angle: (i * 2.3999) % (Math.PI * 2), phase: i * .7, alpha: 0, x: node.x, y: node.y };
        Object.assign(orbiter, paper, { node });
        scene.orbiters.push(orbiter); scene.byPaper.set(paper.id, orbiter);
        return orbiter;
      });
      return node;
    });
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    layoutScale();
    wake();
  }

  /* ---------- pointer interaction ---------- */
  const pointer = event => { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const nodeAt = point => [...scene.list].reverse().find(node => radius(node) > 2 && Math.hypot(point.x - node.x, point.y - node.y) <= radius(node));
  function paperAt(point) {
    let best = null, distance = 7;
    const selected = scene.data?.group;
    for (const orbiter of scene.orbiters) {
      if (orbiter.alpha < .5 || (selected && nodes.has(selected) && orbiter.node.id !== selected)) continue;
      const d = Math.hypot(point.x - orbiter.x, point.y - orbiter.y);
      if (d < distance) { best = orbiter; distance = d; }
    }
    return best;
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function showTip(point, html) {
    tip.innerHTML = html; tip.classList.add('show');
    tip.style.left = Math.max(6, Math.min(point.x + 12, view.w - tip.offsetWidth - 6)) + 'px';
    tip.style.top = Math.max(6, Math.min(point.y + 12, view.h - tip.offsetHeight - 6)) + 'px';
  }
  function hover(orbiter) {
    scene.hoverPaper = orbiter || null;
    scene.linked = orbiter ? (orbiter.reach || []).map(id => nodes.get(id)).filter(Boolean) : null;
    scene.data?.onHover?.(orbiter ? orbiter.id : '');
  }
  canvas.addEventListener('pointermove', event => {
    const point = pointer(event), drag = scene.drag;
    if (drag) {
      const now = performance.now(), dt = Math.max(1, now - drag.time) / 1000;
      drag.node.vx = (point.x - drag.last.x) / dt; drag.node.vy = (point.y - drag.last.y) / dt;
      drag.node.x = point.x - drag.dx; drag.node.y = point.y - drag.dy;
      drag.moved ||= Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 4;
      drag.last = point; drag.time = now; tip.classList.remove('show');
      return;
    }
    const orbiter = paperAt(point);
    if (orbiter !== scene.hoverPaper) hover(orbiter);
    scene.hoverNode = orbiter ? null : nodeAt(point) || null;
    canvas.style.cursor = orbiter || scene.hoverNode ? 'pointer' : 'grab';
    if (orbiter) showTip(point, `<b>${escape(orbiter.title)}</b>${escape(orbiter.detail)}${orbiter.reach?.length ? `<small>Also linked to ${escape(orbiter.reach.map(id => nodes.get(id)?.label).filter(Boolean).join(', '))}</small>` : ''}`);
    else if (scene.hoverNode) showTip(point, `<b>${escape(scene.hoverNode.label)}</b><small>${escape(scene.hoverNode.tip)}</small>`);
    else tip.classList.remove('show');
  });
  canvas.addEventListener('pointerleave', () => {
    if (scene.drag) return;
    scene.hoverNode = null; hover(null); tip.classList.remove('show');
  });
  canvas.addEventListener('pointerdown', event => {
    const point = pointer(event), node = paperAt(point) ? null : nodeAt(point);
    if (!node) return;
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* capture is optional */ }
    scene.drag = { node, dx: point.x - node.x, dy: point.y - node.y, start: point, last: point, time: performance.now(), moved: false };
  });
  canvas.addEventListener('pointerup', event => {
    const point = pointer(event), drag = scene.drag;
    if (drag) {
      scene.drag = null;
      if (!drag.moved) { drag.node.vx = drag.node.vy = 0; scene.data?.onGroup?.(drag.node.id); }
      return;
    }
    const orbiter = paperAt(point);
    if (orbiter) scene.data?.onPaper?.(orbiter.id, orbiter.node.id);
  });

  /* A paper hovered in the list lights up on the map. */
  function highlight(id) {
    const orbiter = scene.byPaper.get(id) || null;
    scene.hoverPaper = orbiter;
    scene.linked = orbiter ? (orbiter.reach || []).map(other => nodes.get(other)).filter(Boolean) : null;
  }

  return { mount, highlight, wake, scene };
})();
