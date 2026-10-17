/**
 * Pulse relay (Cloudflare Worker + D1, free plan).
 *
 * Sync: each Mac encrypts library records with keys derived from the user's sync code before
 * upload. The relay sees a random vault ID, a hash of an access token, record IDs that are
 * keyed hashes, and ciphertext. It keeps only the newest version of each record.
 *
 * Crash reports: accepts reports a user chose to send (already redacted on the Mac), with a
 * size limit and a per-network hourly limit. They are read by the owner with `wrangler d1`.
 */
const PROTOCOL = 'relay-1';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_RECORD = 512 * 1024;
const MAX_VAULT_BYTES = 200 * 1024 * 1024;
const MAX_PUSH = 200;
const MAX_PULL = 500;
const MAX_REPORT = 64 * 1024;
const REPORTS_PER_HOUR = 20;
const HEX = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BLOB = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { const body = JSON.parse(text); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}

/** Returns the vault row when vault + auth are valid; creates the vault on first use when `create` is set. */
async function openVault(env, body, { create = false } = {}) {
  const vault = body?.vault, auth = body?.auth;
  if (typeof vault !== 'string' || !HEX.test(vault) || typeof auth !== 'string' || !TOKEN.test(auth)) return { error: json({ error: 'Invalid sync credentials.' }, 400) };
  const authHash = await sha256(auth);
  let row = await env.DB.prepare('SELECT vault_id, auth_hash, head, bytes FROM vaults WHERE vault_id = ?').bind(vault).first();
  if (!row && create) {
    const now = Date.now();
    await env.DB.prepare('INSERT OR IGNORE INTO vaults (vault_id, auth_hash, head, bytes, created, touched) VALUES (?, ?, 0, 0, ?, ?)').bind(vault, authHash, now, now).run();
    row = await env.DB.prepare('SELECT vault_id, auth_hash, head, bytes FROM vaults WHERE vault_id = ?').bind(vault).first();
  }
  if (!row) return { error: json({ error: 'This sync code has no data yet.' }, 404) };
  if (!sameText(row.auth_hash, authHash)) return { error: json({ error: 'Invalid sync credentials.' }, 403) };
  return { row };
}

async function register(env, body) {
  const { row, error } = await openVault(env, body, { create: true });
  return error || json({ ok: true, head: row.head, protocol: PROTOCOL });
}

async function push(env, body) {
  const { row, error } = await openVault(env, body, { create: true });
  if (error) return error;
  const device = body.device, records = body.records;
  if (typeof device !== 'string' || !HEX.test(device) || !Array.isArray(records) || !records.length || records.length > MAX_PUSH) return json({ error: 'Invalid sync upload.' }, 400);
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !HEX.test(record.id) || seen.has(record.id) ||
        typeof record.blob !== 'string' || !record.blob || record.blob.length > MAX_RECORD || !BLOB.test(record.blob)) {
      return json({ error: 'Invalid sync record.' }, 400);
    }
    seen.add(record.id);
  }
  const ids = records.map(record => record.id);
  const previous = await env.DB.prepare(`SELECT record_id, length(blob) AS size FROM records WHERE vault_id = ? AND record_id IN (${ids.map(() => '?').join(',')})`).bind(row.vault_id, ...ids).all();
  const oldSize = (previous.results || []).reduce((sum, item) => sum + Number(item.size || 0), 0);
  const newSize = records.reduce((sum, record) => sum + record.blob.length, 0);
  const bytes = Number(row.bytes) - oldSize + newSize;
  if (bytes > MAX_VAULT_BYTES) return json({ error: 'Sync storage limit reached.' }, 413);
  const head = Number(row.head);
  const statements = records.map((record, index) => env.DB.prepare(
    'INSERT INTO records (vault_id, record_id, seq, device, blob) VALUES (?, ?, ?, ?, ?) ON CONFLICT (vault_id, record_id) DO UPDATE SET seq = excluded.seq, device = excluded.device, blob = excluded.blob'
  ).bind(row.vault_id, record.id, head + index + 1, device, record.blob));
  // Guarded head update: a concurrent push from another Mac makes this batch fail and retry.
  statements.push(env.DB.prepare('UPDATE vaults SET head = ?, bytes = ?, touched = ? WHERE vault_id = ? AND head = ?')
    .bind(head + records.length, bytes, Date.now(), row.vault_id, head));
  const results = await env.DB.batch(statements);
  if (!results.at(-1)?.meta?.changes) return json({ error: 'Another Mac synced at the same time. Try again.', retry: true }, 409);
  return json({ ok: true, head: head + records.length });
}

async function pull(env, body) {
  const { row, error } = await openVault(env, body);
  if (error) return error;
  const since = Number.isInteger(body.since) && body.since >= 0 ? body.since : 0;
  const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, MAX_PULL) : MAX_PULL;
  const result = await env.DB.prepare('SELECT record_id AS id, seq, device, blob FROM records WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?').bind(row.vault_id, since, limit + 1).all();
  const records = (result.results || []).slice(0, limit);
  return json({ ok: true, records, head: Number(row.head), more: (result.results || []).length > limit });
}

async function erase(env, body) {
  const { row, error } = await openVault(env, body);
  if (error) return error;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE vault_id = ?').bind(row.vault_id),
    env.DB.prepare('DELETE FROM vaults WHERE vault_id = ?').bind(row.vault_id)
  ]);
  return json({ ok: true });
}

async function report(env, body, request) {
  const item = body?.report;
  const text = JSON.stringify(item ?? null);
  if (!item || typeof item !== 'object' || Array.isArray(item) || text.length > MAX_REPORT ||
      typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(item.id) ||
      typeof item.appVersion !== 'string' || item.appVersion.length > 32 || typeof item.kind !== 'string' || item.kind.length > 32) {
    return json({ error: 'Invalid report.' }, 400);
  }
  // Hourly limit per network, keyed by a hash so the address itself is not stored.
  const hour = Math.floor(Date.now() / 3600000);
  const bucket = await sha256(`${request.headers.get('CF-Connecting-IP') || 'unknown'}:${hour}`);
  await env.DB.prepare('INSERT INTO report_limits (bucket, count) VALUES (?, 1) ON CONFLICT (bucket) DO UPDATE SET count = count + 1').bind(bucket).run();
  const used = await env.DB.prepare('SELECT count FROM report_limits WHERE bucket = ?').bind(bucket).first();
  if (Number(used?.count || 0) > REPORTS_PER_HOUR) return json({ error: 'Too many reports. Try again later.' }, 429);
  await env.DB.prepare('INSERT OR IGNORE INTO reports (id, created, version, kind, body) VALUES (?, ?, ?, ?, ?)')
    .bind(item.id, Date.now(), item.appVersion, item.kind, text).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    try {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/health') return json({ ok: Boolean(env.DB), protocol: PROTOCOL }, env.DB ? 200 : 503);
      if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
      if (!env.DB) return json({ error: 'The relay is not configured.' }, 503);
      const routes = { '/sync/v1/register': register, '/sync/v1/push': push, '/sync/v1/pull': pull, '/sync/v1/erase': erase, '/reports/v1': report };
      const handler = routes[pathname];
      if (!handler) return json({ error: 'Not found.' }, 404);
      const body = await readJson(request);
      if (!body) return json({ error: 'Invalid request.' }, 400);
      return await handler(env, body, request);
    } catch {
      return json({ error: 'The relay failed. Try again.' }, 500);
    }
  }
};
