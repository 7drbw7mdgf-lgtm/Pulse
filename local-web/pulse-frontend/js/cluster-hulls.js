/* Automatic organic boundary envelopes around research clusters. */
function renderClusterHulls(papers, clusters) {
  if (!Array.isArray(clusters) || clusters.length < 2 || !Array.isArray(papers) || papers.length < 3) return '';
  const paperMap = new Map(papers.map(p => [p.id, p]));
  const paletteList = typeof palette !== 'undefined' ? palette : ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];

  function convexHull(points) {
    if (points.length <= 2) return points;
    const pts = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function expandHull(hull, padding = 42) {
    // A padded envelope needs area even when two papers (or an entire group) lie on a line.
    return convexHull(hull.flatMap(p=>Array.from({length:12},(_,i)=>({
      x:p.x+Math.cos(i*Math.PI/6)*padding,y:p.y+Math.sin(i*Math.PI/6)*padding
    }))));
  }

  function smoothPath(pts) {
    if (!pts || pts.length < 2) return '';
    if (pts.length === 2) {
      const [a, b] = pts;
      return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} L ${b.x.toFixed(1)} ${b.y.toFixed(1)} Z`;
    }
    const last=pts[pts.length-1];
    let d = `M ${((last.x+pts[0].x)/2).toFixed(1)} ${((last.y+pts[0].y)/2).toFixed(1)}`;
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];
      const midX = (curr.x + next.x) / 2;
      const midY = (curr.y + next.y) / 2;
      d += ` Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}, ${midX.toFixed(1)} ${midY.toFixed(1)}`;
    }
    d += ' Z';
    return d;
  }

  return clusters.map((clusterIds, idx) => {
    const clusterPapers = clusterIds.map(id => paperMap.get(id)).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (clusterPapers.length < 2) return '';
    const color = paletteList[idx % paletteList.length];
    const points = clusterPapers.map(p => ({ x: p.x, y: p.y }));
    const hull = convexHull(points);
    const expanded = expandHull(hull, Math.max(38,(typeof state!=='undefined'?state.graphStyle?.nodeSize||22:22)+18));
    const pathData = smoothPath(expanded);
    if (!pathData) return '';

    return `
      <g class="cluster-boundary" data-cluster-index="${idx}">
        <path class="cluster-hull-path" d="${pathData}" fill="${color}" stroke="${color}" />
      </g>
    `;
  }).join('');
}
