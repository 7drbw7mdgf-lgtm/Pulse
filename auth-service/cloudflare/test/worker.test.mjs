// node --test auth-service/cloudflare/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import worker from '../worker.mjs';

const env = { MENDELEY_CLIENT_ID: 'test-client', MENDELEY_CLIENT_SECRET: 'test-secret', STATE_KEY: 'k'.repeat(40) };
const ORIGIN = 'https://pulse-mendeley.example.workers.dev';
const b64url = buf => Buffer.from(buf).toString('base64url');
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());

function call(path, { method = 'GET', body, environment = env } = {}) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return worker.fetch(new Request(ORIGIN + path, init), environment);
}

function mockProvider(handler) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return handler(url, init); };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function signIn(port = 51234) {
  const started = await (await call('/start', { method: 'POST', body: { challenge, port } })).json();
  const url = new URL(started.authorizationUrl);
  return { started, url };
}

test('health reports configuration without exposing secrets', async () => {
  const ok = await call('/health');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, protocol: 'exchange-1' });
  const missing = await call('/health', { environment: {} });
  assert.equal(missing.status, 503);
  assert.ok(!JSON.stringify(await missing.json()).includes('test-secret'));
});

test('start returns a Mendeley authorization URL bound to the worker callback and never the secret', async () => {
  const { started, url } = await signIn();
  assert.equal(url.origin + url.pathname, 'https://api.mendeley.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client');
  assert.equal(url.searchParams.get('redirect_uri'), ORIGIN + '/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), started.state);
  assert.ok(!started.authorizationUrl.includes('test-secret'));
  for (const body of [{ challenge: 'short', port: 51234 }, { challenge, port: 80 }, { challenge, port: '51234' }]) {
    assert.equal((await call('/start', { method: 'POST', body })).status, 400);
  }
});

test('callback forwards the code only to the loopback port in the signed state', async () => {
  const { started } = await signIn(50001);
  const response = await call(`/callback?code=abc&state=${encodeURIComponent(started.state)}`);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin, 'http://127.0.0.1:50001');
  assert.equal(location.pathname, '/mendeley/callback');
  assert.equal(location.searchParams.get('code'), 'abc');
  assert.equal(location.searchParams.get('state'), started.state);
  const declined = new URL((await call(`/callback?error=access_denied&state=${encodeURIComponent(started.state)}`)).headers.get('Location'));
  assert.equal(declined.searchParams.get('error'), 'access_denied');
  assert.equal(declined.searchParams.get('code'), null);
});

test('tampered, foreign or expired state is rejected', async () => {
  const { started } = await signIn(50001);
  const [payload, signature] = started.state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), p: 6666 })).toString('base64url') + '.' + signature;
  assert.equal((await call(`/callback?code=abc&state=${encodeURIComponent(forged)}`)).status, 400);
  const other = await call(`/callback?code=abc&state=${encodeURIComponent(started.state)}`, { environment: { ...env, STATE_KEY: 'x'.repeat(40) } });
  assert.equal(other.status, 400);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try { assert.equal((await call(`/callback?code=abc&state=${encodeURIComponent(started.state)}`)).status, 400); }
  finally { Date.now = realNow; }
});

test('token exchange requires the verifier that started the sign-in and uses the secret only with Mendeley', async () => {
  const { started } = await signIn();
  const provider = mockProvider(async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer', extra: 'dropped' }));
  try {
    const wrong = await call('/token', { method: 'POST', body: { code: 'abc', state: started.state, verifier: b64url(randomBytes(48)) } });
    assert.equal(wrong.status, 400);
    assert.equal(provider.seen.length, 0, 'a wrong verifier never reaches Mendeley');
    const ok = await call('/token', { method: 'POST', body: { code: 'abc', state: started.state, verifier } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer' });
    const [{ url, init }] = provider.seen;
    assert.equal(url, 'https://api.mendeley.com/oauth/token');
    assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('test-client:test-secret').toString('base64'));
    assert.match(init.headers['User-Agent'], /^Pulse/);
    const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('grant_type'), 'authorization_code');
    assert.equal(fields.get('code'), 'abc');
    assert.equal(fields.get('redirect_uri'), ORIGIN + '/callback');
  } finally { provider.restore(); }
});

test('refresh forwards only the refresh token and passes on provider refusals without leaking the secret', async () => {
  const provider = mockProvider(async () => Response.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, { status: 400 }));
  try {
    const refused = await call('/refresh', { method: 'POST', body: { refresh_token: 'old' } });
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.error, 'Refresh token expired');
    assert.ok(!JSON.stringify(body).includes('test-secret'));
    assert.equal(new URLSearchParams(provider.seen[0].init.body).get('grant_type'), 'refresh_token');
    assert.equal((await call('/refresh', { method: 'POST', body: {} })).status, 400);
  } finally { provider.restore(); }
});

test('unknown routes and methods are refused', async () => {
  assert.equal((await call('/token')).status, 404);
  assert.equal((await call('/anything', { method: 'POST', body: {} })).status, 404);
});
