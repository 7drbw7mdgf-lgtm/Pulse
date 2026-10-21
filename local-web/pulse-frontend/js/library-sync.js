/**
 * Encrypted between-computer library sync through the Pulse relay.
 *
 * The sync code (32 random bytes) never leaves the computers. From it, HKDF derives a vault ID, a
 * relay access token, an AES-GCM key and an HMAC key for record IDs; the relay stores only
 * ciphertext. Each paper is one record. Merging is three-way against the last synced version:
 * a field changed on one computer wins, lists merge, notes edited on both computers keep both texts.
 * PDFs, extracted full text and map positions stay on the computer where they were made.
 */
(function (root) {
  'use strict';
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const LOCAL_ONLY = new Set(['id', 'syncId', 'x', 'y', 'size', 'selected', 'mapId', 'text', 'bibliographyText', 'evidencePassages', 'citationMetrics', 'pdfAttachments', 'pdfAnnotations', 'pdfQuotes', 'mergedAliases']);
  const NOTE_FIELDS = new Set(['notes']);
  const WORKSPACE_SID = 'workspace';
  const PUSH_BATCH = 100;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const subtle = () => root.crypto.subtle;

  function randomHex(bytes) {
    return [...root.crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function toHex(buffer) { return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  function toB64url(buffer) {
    let text = ''; for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
    return root.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(text) {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
    return Uint8Array.from(root.atob(padded), ch => ch.charCodeAt(0));
  }

  /** 32 random bytes as 52 Crockford base32 characters. */
  function newSyncCode() { return encodeSyncCode(root.crypto.getRandomValues(new Uint8Array(32))); }
  function encodeSyncCode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) out += CROCKFORD[(value << (5 - bits)) & 31];
    return out;
  }
  function normalizeSyncCode(text) {
    return String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  }
  function decodeSyncCode(text) {
    const code = normalizeSyncCode(text);
    if (!/^[0-9A-HJKMNP-TV-Z]{52}$/.test(code)) throw new Error('That sync code is not valid. Copy it again from the other computer.');
    const bytes = []; let bits = 0, value = 0;
    for (const ch of code) { value = (value << 5) | CROCKFORD.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(bytes.slice(0, 32));
  }
  function formatSyncCode(code) { return normalizeSyncCode(code).match(/.{1,4}/g).join('-'); }

  async function deriveSyncKeys(code) {
    const material = await subtle().importKey('raw', decodeSyncCode(code), 'HKDF', false, ['deriveBits', 'deriveKey']);
    const params = info => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('pulse-sync-v1'), info: encoder.encode(info) });
    const vault = toHex(await subtle().deriveBits(params('vault'), material, 128));
    const auth = toB64url(await subtle().deriveBits(params('auth'), material, 256));
    const aead = await subtle().deriveKey(params('encrypt'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const ids = await subtle().deriveKey(params('record-id'), material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    return { vault, auth, aead, ids };
  }
  async function recordId(keys, sid) {
    return toHex(await subtle().sign('HMAC', keys.ids, encoder.encode('record:' + sid))).slice(0, 32);
  }
  async function sealRecord(keys, payload) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('pulse-sync-v1') }, keys.aead, encoder.encode(JSON.stringify(payload)));
    const out = new Uint8Array(12 + data.byteLength); out.set(iv); out.set(new Uint8Array(data), 12);
    return toB64url(out);
  }
  async function openRecord(keys, blob) {
    const raw = fromB64url(blob);
    const data = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: encoder.encode('pulse-sync-v1') }, keys.aead, raw.slice(12));
    return JSON.parse(decoder.decode(data));
  }

  function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
    return JSON.stringify(value === undefined ? null : value);
  }
  const same = (a, b) => stableJson(a) === stableJson(b);
  const isEmpty = value => value == null || value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);

  /** The part of a paper that syncs. */
  function paperSyncView(paper) {
    const view = {};
    for (const key of Object.keys(paper).sort()) if (!LOCAL_ONLY.has(key) && paper[key] !== undefined) view[key] = JSON.parse(JSON.stringify(paper[key]));
    return view;
  }

  function mergeLists(base, local, remote) {
    const key = item => stableJson(item);
    const baseKeys = new Set((base || []).map(key)), remoteKeys = new Set((remote || []).map(key));
    const result = (local || []).filter(item => !(baseKeys.has(key(item)) && !remoteKeys.has(key(item))));
    const present = new Set(result.map(key));
    for (const item of remote || []) if (!baseKeys.has(key(item)) && !present.has(key(item))) { result.push(item); present.add(key(item)); }
    return result;
  }
  function mergeNotes(local, remote) {
    const l = String(local || ''), r = String(remote || '');
    if (!l || r.includes(l)) return r;
    if (!r || l.includes(r)) return l;
    return `${l}\n\n— From your other computer —\n${r}`;
  }

  /** Three-way merge of one paper; `base` is null when two copies meet for the first time. */
  function mergeSyncViews(base, local, remote) {
    const merged = {}; let conflicts = 0;
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const l = local[key], r = remote[key], b = base ? base[key] : undefined;
      let value;
      if (same(l, r)) value = l;
      else if (base && same(r, b)) value = l;
      else if (base && same(l, b)) value = r;
      else if (isEmpty(l)) value = r;
      else if (isEmpty(r)) value = l;
      else if (NOTE_FIELDS.has(key)) { value = mergeNotes(l, r); conflicts += 1; }
      else if (Array.isArray(l) && Array.isArray(r)) value = mergeLists(base ? b : [], l, r);
      else { value = l; conflicts += 1; }  // both computers changed it: the computer that merges keeps its value, then the other computer adopts it
      if (value !== undefined) merged[key] = value;
    }
    return { merged, conflicts };
  }

  function mergeWorkspace(base, local, remote) {
    if (same(local, remote) || (base && same(remote, base))) return local;
    if (base && same(local, base)) return remote;
    const maps = [...(local.maps || [])];
    for (const map of remote.maps || []) if (!maps.some(item => item.id === map.id)) maps.push(map);
    return { ...local, maps };
  }

  /**
   * One sync cycle. `io` supplies: relay(op, body), loadState(), saveState(patch),
   * removePapers(ids), newPaper(view), workspace() and setWorkspace(value).
   */
  async function runLibrarySync(io, papers) {
    const saved = await io.loadState();
    if (!saved.code) return { skipped: 'off' };
    const keys = await deriveSyncKeys(saved.code);
    const device = saved.device || randomHex(16);
    const base = { ...(saved.base || {}) };
    let lastSeq = saved.lastSeq || 0;
    const creds = { vault: keys.vault, auth: keys.auth };
    const summary = { added: 0, updated: 0, removed: 0, conflicts: 0, pushed: 0, unreadable: 0 };
    const ensureIds = () => {
      const seen = new Set();
      for (const paper of papers()) {
        if (!/^[0-9a-f]{32}$/.test(paper.syncId || '') || seen.has(paper.syncId)) paper.syncId = randomHex(16);
        seen.add(paper.syncId);
      }
    };
    ensureIds();

    // 1. Pull everything newer than the last position.
    const removals = [];
    for (;;) {
      let page;
      try { page = await io.relay('pull', { ...creds, since: lastSeq, limit: 500 }); }
      catch (error) { if (error.status === 404) break; throw error; }
      for (const record of page.records || []) {
        lastSeq = Math.max(lastSeq, record.seq);
        let payload;
        try { payload = await openRecord(keys, record.blob); } catch { summary.unreadable += 1; continue; }
        const sid = payload.sid, previous = base[sid];
        if (payload.kind === 'workspace') {
          const local = io.workspace();
          const merged = mergeWorkspace(previous, local, payload.workspace);
          if (!same(merged, local)) io.setWorkspace(merged);
          base[sid] = payload.workspace; continue;
        }
        if (payload.kind !== 'paper' || typeof sid !== 'string') continue;
        const list = papers();
        let local = list.find(paper => paper.syncId === sid);
        if (!local && !payload.deleted && !previous) {
          // First meeting of two copies of the same paper (for example when a computer joins).
          const identity = typeof paperIdentityKey === 'function' ? paperIdentityKey(payload.paper) : '';
          local = identity && list.find(paper => !base[paper.syncId] && paperIdentityKey(paper) === identity);
          if (local) local.syncId = sid;
        }
        if (payload.deleted) {
          if (local && (!previous || same(paperSyncView(local), previous))) { removals.push(local.id); summary.removed += 1; delete base[sid]; }
          else if (!local) delete base[sid];
          continue;  // edited here since the last sync: keep it; it is uploaded again below
        }
        const remote = payload.paper;
        if (!local) {
          if (previous && same(remote, previous)) continue;  // removed here; the removal is uploaded below
          const created = io.newPaper(remote); created.syncId = sid;
          base[sid] = remote; summary.added += 1; continue;
        }
        const view = paperSyncView(local);
        const { merged, conflicts } = mergeSyncViews(previous || null, view, remote);
        summary.conflicts += conflicts;
        if (!same(merged, view)) {
          for (const key of Object.keys(view)) if (!(key in merged)) delete local[key];
          Object.assign(local, JSON.parse(JSON.stringify(merged)));
          summary.updated += 1;
        }
        base[sid] = remote;
      }
      if (!page.more) break;
    }
    if (removals.length) await io.removePapers(removals);
    ensureIds();  // removal can rebuild the paper list

    // 2. Upload what differs from the last synced version, and removals made here.
    const outgoing = [];
    const present = new Set();
    for (const paper of papers()) {
      present.add(paper.syncId);
      const view = paperSyncView(paper);
      if (!same(view, base[paper.syncId])) outgoing.push({ sid: paper.syncId, payload: { v: 1, kind: 'paper', sid: paper.syncId, paper: view } });
    }
    for (const sid of Object.keys(base)) {
      if (sid !== WORKSPACE_SID && !present.has(sid)) outgoing.push({ sid, payload: { v: 1, kind: 'paper', sid, deleted: true } });
    }
    const workspace = io.workspace();
    if (!same(workspace, base[WORKSPACE_SID])) outgoing.push({ sid: WORKSPACE_SID, payload: { v: 1, kind: 'workspace', sid: WORKSPACE_SID, workspace } });
    for (let start = 0; start < outgoing.length; start += PUSH_BATCH) {
      const batch = outgoing.slice(start, start + PUSH_BATCH);
      const records = await Promise.all(batch.map(async item => ({ id: await recordId(keys, item.sid), blob: await sealRecord(keys, item.payload) })));
      await io.relay('push', { ...creds, device, records });
      for (const item of batch) {
        if (item.payload.deleted) delete base[item.sid];
        else base[item.sid] = item.payload.kind === 'workspace' ? item.payload.workspace : item.payload.paper;
      }
      summary.pushed += batch.length;
    }
    await io.saveState({ device, lastSeq, base, lastSyncedAt: new Date().toISOString(), lastError: '' });
    return summary;
  }

  Object.assign(root, {
    newSyncCode, encodeSyncCode, decodeSyncCode, normalizeSyncCode, formatSyncCode, deriveSyncKeys, recordId,
    sealRecord, openRecord, paperSyncView, mergeSyncViews, mergeLists, mergeNotes, stableJson, runLibrarySync
  });
})(typeof window !== 'undefined' ? window : globalThis);
