// node --test services/relay/test/relay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import worker from '../worker.mjs';
import { fakeD1 } from './fake-d1.mjs';

const hex = () => randomBytes(16).toString('hex');
const token = () => randomBytes(32).toString('base64url');
const call = (env, path, body, headers = {}) => worker.fetch(new Request('https://relay.example' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);

test('health', async () => {
  const response = await worker.fetch(new Request('https://relay.example/health'), { DB: fakeD1() });
  assert.deepEqual(await response.json(), { ok: true, protocol: 'relay-1' });
});

test('records round-trip in order, keeping only the newest version of each', async () => {
  const env = { DB: fakeD1() };
  const vault = hex(), auth = token(), deviceA = hex(), deviceB = hex();
  const a = hex(), b = hex();
  assert.equal((await call(env, '/sync/v1/register', { vault, auth })).status, 200);
  let r = await call(env, '/sync/v1/push', { vault, auth, device: deviceA, records: [{ id: a, blob: 'AAA' }, { id: b, blob: 'BBB' }] });
  assert.equal((await r.json()).head, 2);
  r = await call(env, '/sync/v1/push', { vault, auth, device: deviceB, records: [{ id: a, blob: 'AAA2' }] });
  assert.equal((await r.json()).head, 3);
  const all = await (await call(env, '/sync/v1/pull', { vault, auth, since: 0 })).json();
  assert.deepEqual(all.records.map(x => [x.id, x.seq, x.blob]), [[b, 2, 'BBB'], [a, 3, 'AAA2']]);
  const since2 = await (await call(env, '/sync/v1/pull', { vault, auth, since: 2 })).json();
  assert.deepEqual(since2.records.map(x => x.blob), ['AAA2']);
  assert.equal(since2.records[0].device, deviceB);
  const paged = await (await call(env, '/sync/v1/pull', { vault, auth, since: 0, limit: 1 })).json();
  assert.equal(paged.records.length, 1); assert.equal(paged.more, true);
});

test('a wrong access token cannot read, write or erase a vault', async () => {
  const env = { DB: fakeD1() };
  const vault = hex(), auth = token();
  await call(env, '/sync/v1/push', { vault, auth, device: hex(), records: [{ id: hex(), blob: 'secret' }] });
  for (const path of ['/sync/v1/pull', '/sync/v1/push', '/sync/v1/erase', '/sync/v1/register']) {
    const response = await call(env, path, { vault, auth: token(), device: hex(), records: [{ id: hex(), blob: 'x' }] });
    assert.equal(response.status, 403, path);
  }
  const stored = env.DB.raw.prepare('SELECT auth_hash FROM vaults').get();
  assert.notEqual(stored.auth_hash, auth, 'only a hash of the access token is stored');
});

test('malformed input and oversized uploads are refused', async () => {
  const env = { DB: fakeD1() };
  const vault = hex(), auth = token(), device = hex();
  for (const records of [[], [{ id: 'nothex', blob: 'x' }], [{ id: hex(), blob: 'not base64url!' }], [{ id: hex(), blob: 'x'.repeat(512 * 1024 + 1) }]]) {
    assert.equal((await call(env, '/sync/v1/push', { vault, auth, device, records })).status, 400);
  }
  const id = hex();
  assert.equal((await call(env, '/sync/v1/push', { vault, auth, device, records: [{ id, blob: 'a' }, { id, blob: 'b' }] })).status, 400, 'duplicate IDs');
  assert.equal((await call(env, '/sync/v1/pull', { vault: 'x', auth })).status, 400);
  assert.equal((await call(env, '/sync/v1/pull', { vault: hex(), auth })).status, 404);
});

test('a push racing another Mac fails cleanly and can be retried', async () => {
  const env = { DB: fakeD1() };
  const vault = hex(), auth = token(), device = hex();
  await call(env, '/sync/v1/register', { vault, auth });
  const realBatch = env.DB.batch;
  env.DB.batch = async statements => { env.DB.raw.prepare('UPDATE vaults SET head = head + 5').run(); return realBatch(statements); };
  const raced = await call(env, '/sync/v1/push', { vault, auth, device, records: [{ id: hex(), blob: 'x' }] });
  assert.equal(raced.status, 409);
  env.DB.batch = realBatch;
  const retried = await call(env, '/sync/v1/push', { vault, auth, device, records: [{ id: hex(), blob: 'x' }] });
  assert.equal((await retried.json()).head, 6);
});

test('erase removes the vault and its records', async () => {
  const env = { DB: fakeD1() };
  const vault = hex(), auth = token();
  await call(env, '/sync/v1/push', { vault, auth, device: hex(), records: [{ id: hex(), blob: 'x' }] });
  assert.equal((await call(env, '/sync/v1/erase', { vault, auth })).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM records').get().n, 0);
  assert.equal((await call(env, '/sync/v1/pull', { vault, auth })).status, 404);
});

test('crash reports are size-checked and rate-limited per network', async () => {
  const env = { DB: fakeD1() };
  const report = n => ({ report: { id: 'report-' + n + '-' + hex(), appVersion: '1.9.0', kind: 'frontend', message: 'TypeError' } });
  assert.equal((await call(env, '/reports/v1', report(0), { 'CF-Connecting-IP': '203.0.113.1' })).status, 200);
  assert.equal((await call(env, '/reports/v1', { report: { id: 'x', appVersion: '1', kind: 'k' } })).status, 400);
  assert.equal((await call(env, '/reports/v1', { report: { ...report(1).report, pad: 'x'.repeat(70000) } })).status, 400);
  for (let i = 1; i < 20; i += 1) await call(env, '/reports/v1', report(i), { 'CF-Connecting-IP': '203.0.113.1' });
  assert.equal((await call(env, '/reports/v1', report(99), { 'CF-Connecting-IP': '203.0.113.1' })).status, 429);
  assert.equal((await call(env, '/reports/v1', report(100), { 'CF-Connecting-IP': '198.51.100.7' })).status, 200);
  const stored = env.DB.raw.prepare('SELECT count(*) AS n FROM reports').get().n;
  assert.equal(stored, 21);
  assert.ok(!JSON.stringify(env.DB.raw.prepare('SELECT * FROM report_limits').all()).includes('203.0.113.1'), 'addresses are not stored');
});
