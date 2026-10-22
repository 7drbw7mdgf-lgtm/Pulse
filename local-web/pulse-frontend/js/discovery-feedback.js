/* Discovery relevance feedback: concept features, contrastive profiles and re-ranking. */
// Explicit local labels steer only searches with the same question and seeds.
const FEEDBACK_STOP = new Set(
  'a an the and or of in on for to from with by is are was were this that these those we our their it as at be using study studies research results paper approach analysis method methods based new how why what which can could do does did have has effects effect role impact important review overview understanding'.split(' ')
);
const _discoveryFeatureCache = new Map();

function discoveryFeedbackPaperKey(paper) {
  if (!paper) return '';
  if (typeof paper._fbKey === 'string' && paper._fbKey) return paper._fbKey;
  const rawDoi = paper.doi;
  if (rawDoi) {
    const d = String(rawDoi).trim().toLowerCase();
    const clean = (d.startsWith('http') || d.startsWith('doi:') || d.endsWith('.'))
      ? d.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').replace(/\.+$/, '')
      : d;
    if (clean) return clean;
  }
  if (paper.s2PaperId) return String(paper.s2PaperId);
  return (String(paper.title || '').normalize('NFKC').toLowerCase().match(/[a-z0-9_]+/g) || []).join(' ');
}

function discoveryFeedbackTitleKey(value) {
  return (String(value || '').normalize('NFKC').toLowerCase().match(/[a-z0-9_]+/g) || []).join(' ');
}

function _recordTitleKey(paper) {
  if (typeof paper._fbTitleKey === 'string') return paper._fbTitleKey;
  const k = discoveryFeedbackTitleKey(paper.title);
  paper._fbTitleKey = k;
  return k;
}

function _surnameToken(name) {
  const cleaned = String(name || '').replace(/\(.*?\)|\[.*?\]|\d+/g, ' ');
  if (cleaned.includes(',')) {
    const words = cleaned.split(',')[0].toLowerCase().match(/[a-z0-9_-]+/g) || [];
    return words.length ? words[words.length - 1] : '';
  }
  const words = cleaned.toLowerCase().match(/[a-z0-9_-]+/g) || [];
  if (words.length > 1 && words[words.length - 1].length <= 2) return words[0];
  return words.length ? words[words.length - 1] : '';
}

function _tokenizeWords(value) {
  const raw = String(value || '').toLowerCase().match(/[a-z0-9_-]+/g);
  if (!raw) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (w.length > 2 && !FEEDBACK_STOP.has(w)) out.push(w);
  }
  return out;
}

function conceptFeatures(paper) {
  if (!paper || typeof paper !== 'object') return new Set();
  if (paper._fbFeatures instanceof Set) return paper._fbFeatures;
  const pKey = discoveryFeedbackPaperKey(paper);
  const cacheKey = pKey + '::' + String(paper.title || '').length + '::' + String(paper.abstract || '').length + '::' + String((paper.referenceIds || []).length) + '::' + String((paper.paperKeywords || []).length);
  if (cacheKey.length > 6 && _discoveryFeatureCache.has(cacheKey)) {
    const cached = _discoveryFeatureCache.get(cacheKey);
    paper._fbFeatures = cached;
    return cached;
  }
  const rawKw = paper.paperKeywords || paper.keywords || [];
  const keywords = Array.isArray(rawKw) ? rawKw : [rawKw];
  const segments = [paper.title || '', String(paper.abstract || '').slice(0, 8000), ...keywords.slice(0, 20)];
  const features = new Set();
  for (let s = 0; s < segments.length; s++) {
    const words = _tokenizeWords(segments[s]);
    for (let i = 0; i < words.length; i++) {
      features.add(words[i]);
      if (i + 1 < words.length) features.add(words[i] + ' ' + words[i + 1]);
    }
  }

  // 1. Shared references and DBEF pivots
  const dbef = paper.dbef && typeof paper.dbef === 'object' ? paper.dbef : {};
  const refList = [...(Array.isArray(paper.referenceIds) ? paper.referenceIds.slice(0, 80) : []), ...(Array.isArray(dbef.sharedReferenceIds) ? dbef.sharedReferenceIds.slice(0, 80) : [])];
  for (let i = 0; i < refList.length; i++) {
    const token = String(refList[i] || '').trim().toLowerCase();
    if (token) features.add('ref:' + token);
  }
  const seedMatches = Array.isArray(dbef.seedMatches) ? dbef.seedMatches.slice(0, 12) : [];
  for (let i = 0; i < seedMatches.length; i++) {
    const m = seedMatches[i];
    if (m && Number(m.shared || 0) > 0) {
      const pivot = String(m.seedId ?? m.seedIndex ?? '').trim().toLowerCase();
      if (pivot) features.add('pivot:' + pivot);
    }
  }

  // 2. Co-citation and direct-citation evidence
  const topSub = String(paper.subType || '').trim().toLowerCase();
  if (topSub.includes('backward')) features.add('cite:backward');
  if (topSub.includes('forward')) features.add('cite:forward');
  if (topSub.includes('co-citation')) features.add('cite:cocited');
  if (topSub.includes('bibliographic coupling') || Object.keys(dbef).length > 0) features.add('cite:coupled');
  if (topSub.includes('chase')) features.add('cite:chase');
  const evidence = Array.isArray(paper.retrievalEvidence) ? paper.retrievalEvidence.slice(0, 24) : [];
  for (let i = 0; i < evidence.length; i++) {
    const ev = evidence[i];
    if (!ev || typeof ev !== 'object') continue;
    const ch = String(ev.channel || '').trim().toLowerCase();
    const st = String(ev.subType || '').trim().toLowerCase();
    if ((ch.startsWith('citations:') && ch.endsWith(':backward')) || st.includes('backward')) {
      features.add('cite:backward');
      if (ch) features.add('cite:' + ch);
    }
    if ((ch.startsWith('citations:') && ch.endsWith(':forward')) || st.includes('forward')) {
      features.add('cite:forward');
      if (ch) features.add('cite:' + ch);
    }
    if (ch.includes('cocitation') || st.includes('co-citation')) features.add('cite:cocited');
    if (ch === 'dbef' || ch.startsWith('dbef:') || st.includes('bibliographic coupling')) features.add('cite:coupled');
    if (st.includes('chase')) features.add('cite:chase');
    const seedIndices = Array.isArray(ev.seedIndices) ? ev.seedIndices.slice(0, 8) : [];
    for (let j = 0; j < seedIndices.length; j++) features.add('cite:seed:' + String(seedIndices[j]));
  }
  const citedBy = Array.isArray(paper.citedByIds) ? paper.citedByIds.slice(0, 40) : [];
  for (let i = 0; i < citedBy.length; i++) {
    const token = String(citedBy[i] || '').trim().toLowerCase();
    if (token) features.add('cocite:' + token);
  }

  // 3. Concepts and sharedConcepts
  const conceptSources = [keywords, paper.matchedConcepts || [], paper.sharedConcepts || [], dbef.sharedConcepts || []];
  for (let s = 0; s < conceptSources.length; s++) {
    const clist = Array.isArray(conceptSources[s]) ? conceptSources[s] : [conceptSources[s]];
    for (let i = 0; i < Math.min(24, clist.length); i++) {
      const cwords = _tokenizeWords(clist[i]).slice(0, 6);
      if (cwords.length) features.add('concept:' + cwords.join(' '));
    }
  }

  // 4. Authors and venue
  const authors = Array.isArray(paper.authors) ? paper.authors : (paper.authors ? [paper.authors] : []);
  for (let i = 0; i < Math.min(12, authors.length); i++) {
    const sn = _surnameToken(authors[i]);
    if (sn.length > 2) features.add('author:' + sn);
  }
  const venue = String(paper.journal || paper.venue || '').trim();
  if (venue) {
    const vwords = _tokenizeWords(venue).slice(0, 8);
    if (vwords.length) features.add('venue:' + vwords.join(' '));
  }

  if (cacheKey.length > 6) {
    if (_discoveryFeatureCache.size > 5000) _discoveryFeatureCache.clear();
    _discoveryFeatureCache.set(cacheKey, features);
  }
  paper._fbFeatures = features;
  return features;
}

function warmDiscoveryFeedbackFeatures(records) {
  if (!Array.isArray(records)) return;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r && typeof r === 'object') {
      r._fbKey = discoveryFeedbackPaperKey(r);
      _recordTitleKey(r);
      conceptFeatures(r);
    }
  }
}

function contrastiveProfile(rows) {
  const validRows = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object' && r.paper) : [];
  const positive = validRows.filter(r => Number(r.grade) > 0).map(r => conceptFeatures(r.paper));
  const negative = validRows.filter(r => Number(r.grade) === 0).map(r => conceptFeatures(r.paper));
  const total = positive.length + negative.length;
  if (!positive.length && !negative.length) {
    return { weights: {}, prefer: [], avoid: [], paired: false, count: 0 };
  }
  const pos = new Map(), neg = new Map(), allFeatures = new Set();
  for (const doc of positive) {
    for (const f of doc) { pos.set(f, (pos.get(f) || 0) + 1); allFeatures.add(f); }
  }
  for (const doc of negative) {
    for (const f of doc) { neg.set(f, (neg.get(f) || 0) + 1); allFeatures.add(f); }
  }
  const rawWeights = {};
  for (const feature of allFeatures) {
    const pCount = pos.get(feature) || 0;
    const nCount = neg.get(feature) || 0;
    let a, b;
    if (positive.length) {
      a = (pCount + 1) / (positive.length + 2);
      b = negative.length ? (nCount + 1) / (negative.length + 2) : 1 / (positive.length + 2);
      if (negative.length && pCount * negative.length === nCount * positive.length) continue;
    } else {
      a = 1 / (negative.length + 2);
      b = (nCount + 1) / (negative.length + 2);
    }
    let weight = Math.log(a / b) * Math.log1p((total + 1) / (pCount + nCount + 1));
    if (feature.includes(':')) weight *= 1.25;
    weight = Math.round(weight * 1e8) / 1e8;
    if (Math.abs(weight) > 0.05) rawWeights[feature] = weight;
  }
  const strongest = Object.keys(rawWeights).sort((fa, fb) => {
    const wa = Math.round(Math.abs(rawWeights[fa]) * 1e6);
    const wb = Math.round(Math.abs(rawWeights[fb]) * 1e6);
    if (wb !== wa) return wb - wa;
    const la = fa.split(' ').length, lb = fb.split(' ').length;
    if (lb !== la) return lb - la;
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  }).slice(0, 80);
  const weights = {};
  for (const f of strongest) weights[f] = rawWeights[f];
  const paired = Boolean(positive.length && negative.length);
  return {
    weights,
    prefer: strongest.filter(f => weights[f] > 0 && !f.includes(':')).slice(0, 12),
    avoid: strongest.filter(f => weights[f] < 0 && !f.includes(':')).slice(0, 12),
    paired,
    count: total
  };
}

function _compileProfile(profile) {
  if (profile._compiled) return profile._compiled;
  const weights = profile?.weights || {};
  const keys = Object.keys(weights);
  let posTotal = 0, negTotal = 0;
  const entries = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const f = keys[i], w = weights[f];
    if (w > 0) posTotal += w; else if (w < 0) negTotal -= w;
    entries[i] = { f, w, plain: !f.includes(':') };
  }
  const paired = Boolean(profile.paired);
  const count = Number(profile.count || 0);
  const conf = (paired && count > 2) ? Math.min(2.8, 1.0 + 0.55 * Math.log(count / 2.0)) : 1.0;
  const compiled = {
    entries,
    posDenom: Math.max(1.0, Math.min(8.0, posTotal)),
    negDenom: Math.max(1.0, paired ? negTotal : Math.min(8.0, negTotal)),
    negScale: paired ? 0.25 : 1.0,
    paired,
    scale: paired ? (0.14 * conf) : 0.06,
    capPos: 0.14 * conf,
    capNeg: 0.16 * conf
  };
  Object.defineProperty(profile, '_compiled', { value: compiled, enumerable: false });
  return compiled;
}

function feedbackAdjustment(paper, profile, semantic = null, features = null) {
  if (!profile || !profile.weights) return [0.0, null];
  const comp = _compileProfile(profile);
  const entries = comp.entries;
  if (!entries.length) return [0.0, null];
  const feats = features || conceptFeatures(paper);
  const posConcepts = [], negConcepts = [];
  let posMatched = 0, negMatched = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (feats.has(e.f)) {
      if (e.w > 0) {
        posMatched += e.w;
        if (e.plain && posConcepts.length < 3) posConcepts.push(e.f);
      } else if (e.w < 0) {
        negMatched -= e.w;
        if (e.plain && negConcepts.length < 3) negConcepts.push(e.f);
      }
    }
  }
  const pos = posMatched / comp.posDenom;
  const neg = (negMatched / comp.negDenom) * comp.negScale;
  const lexical = comp.scale * (pos - neg);
  const dense = (semantic !== null && semantic !== undefined && comp.paired) ? 0.15 * Number(semantic) : 0.0;
  const adj = Math.round(Math.max(-comp.capNeg, Math.min(comp.capPos, lexical + dense)) * 1e6) / 1e6;
  return [adj, {
    positiveConcepts: posConcepts,
    negativeConcepts: negConcepts,
    semanticContrast: (semantic !== null && semantic !== undefined) ? Math.round(Number(semantic) * 1e4) / 1e4 : null
  }];
}

function _candidatePreFeedbackScore(record, grade = undefined) {
  const sb = record.scoreBreakdown || {};
  if (sb.preFeedbackScore !== undefined && sb.preFeedbackScore !== null) {
    let base = Number(sb.preFeedbackScore);
    if (grade === 0) {
      const vel = Number(sb.citationVelocityPrior || 0);
      const fnd = Number(sb.foundationalPrior || 0);
      const cit = Number(sb.citationLinkBonus || 0);
      const bonus = (cit > 0 && fnd > 0) ? Math.min(cit + fnd, Math.max(cit, fnd) + 0.03) : (cit + fnd);
      base -= (vel + bonus);
    }
    return base;
  }
  const prevFb = Number(sb.feedback || 0);
  return (Number(record.score || 0) / 100.0) - prevFb;
}

function _recordStrengthTier(item) {
  const rawLabel = item._initialMatchLabel !== undefined ? item._initialMatchLabel : item.matchLabel;
  const label = String(rawLabel || '').toLowerCase();
  if (label === 'not relevant') return 2;
  if (label === 'relevant' || label.startsWith('strong')) return item.strongMatchEligible === true ? 0 : 1;
  if (label.startsWith('related')) return 1;
  if (label.startsWith('explore')) return 2;
  const score = Number(item._initialScore !== undefined ? item._initialScore : item.score);
  return score >= 40 ? 1 : 2;
}

function rerankDiscoveryPoolWithFeedback(records, feedback, belowIndex = null) {
  const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (!Array.isArray(records) || !records.length) return { records: [], movedUp: 0, elapsedMs: 0 };
  const grades = new Map();
  for (const row of (feedback || [])) {
    if (row && row.paper) grades.set(discoveryFeedbackPaperKey(row.paper), row.grade);
  }
  const hasFeedback = Boolean(feedback && feedback.length);
  const profile = hasFeedback ? contrastiveProfile(feedback) : { weights: {}, prefer: [], avoid: [], paired: false, count: 0 };
  const scored = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const src = records[i];
    const rec = { ...src };
    if (rec._initialMatchLabel === undefined && rec.matchLabel !== undefined) rec._initialMatchLabel = rec.matchLabel;
    if (rec._initialScore === undefined && rec.score !== undefined) rec._initialScore = rec.score;
    if (rec._initialRank === undefined) rec._initialRank = Number(rec.rank || (i + 1));
    const key = discoveryFeedbackPaperKey(rec);
    const grade = grades.get(key);
    const base = _candidatePreFeedbackScore(rec, grade);
    let adj = 0;
    if (grade !== undefined) {
      adj = grade > 0 ? 0.18 : grade === 0 ? -0.55 : 0.0;
      rec.relevanceGrade = grade;
      rec.matchLabel = grade > 0 ? 'Relevant' : 'Not relevant';
    } else if (hasFeedback) {
      const feats = src._fbFeatures || conceptFeatures(rec);
      const [computedAdj, evidence] = feedbackAdjustment(rec, profile, null, feats);
      adj = computedAdj;
      if (evidence) rec.feedbackEvidence = evidence;
    }
    const raw = base + adj;
    rec.score = Math.round(100.0 * Math.max(0.0, Math.min(1.0, raw)) * 1000) / 1000;
    const sb = { ...(rec.scoreBreakdown || {}) };
    if (sb.preFeedbackScore === undefined || sb.preFeedbackScore === null) {
      sb.preFeedbackScore = Math.round(_candidatePreFeedbackScore(src, undefined) * 1e6) / 1e6;
    }
    sb.feedback = Math.round(adj * 1000) / 1000;
    rec.scoreBreakdown = sb;
    scored[i] = rec;
  }

  const compareCandidates = (a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = _recordTitleKey(a), tb = _recordTitleKey(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const da = String(a.doi || ''), db = String(b.doi || '');
    return da < db ? -1 : da > db ? 1 : 0;
  };

  let combined, movedUp = 0;
  if (belowIndex !== null && belowIndex !== undefined && belowIndex >= 0 && belowIndex < scored.length) {
    const prefix = scored.slice(0, belowIndex + 1);
    const rawSuffix = scored.slice(belowIndex + 1);
    const judgedTier = _recordStrengthTier(scored[belowIndex]);
    const movable = [];
    const movablePositions = [];
    for (let i = 0; i < rawSuffix.length; i++) {
      if (_recordStrengthTier(rawSuffix[i]) >= judgedTier) {
        movable.push(rawSuffix[i]);
        movablePositions.push(i);
      }
    }
    const baselineOrder = movable.slice().sort((a, b) => (a._initialRank || 0) - (b._initialRank || 0));
    const oldPos = new Map();
    for (let i = 0; i < baselineOrder.length; i++) oldPos.set(discoveryFeedbackPaperKey(baselineOrder[i]), i);
    movable.sort(compareCandidates);
    for (let i = 0; i < movable.length; i++) {
      const prev = oldPos.get(discoveryFeedbackPaperKey(movable[i]));
      if (prev !== undefined && prev > i) movedUp++;
    }
    const suffix = rawSuffix.slice();
    for (let i = 0; i < movablePositions.length; i++) {
      suffix[movablePositions[i]] = movable[i];
    }
    combined = prefix.concat(suffix);
  } else {
    const baselineOrder = scored.slice().sort((a, b) => (a._initialRank || 0) - (b._initialRank || 0));
    const oldPos = new Map();
    for (let i = 0; i < baselineOrder.length; i++) oldPos.set(discoveryFeedbackPaperKey(baselineOrder[i]), i);
    combined = scored.slice().sort(compareCandidates);
    for (let i = 0; i < combined.length; i++) {
      const prev = oldPos.get(discoveryFeedbackPaperKey(combined[i]));
      if (prev !== undefined && prev > i) movedUp++;
    }
  }
  for (let i = 0; i < combined.length; i++) combined[i].rank = i + 1;
  const ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return { records: combined, movedUp, elapsedMs: Math.round((ended - started) * 1000) / 1000, profile };
}
