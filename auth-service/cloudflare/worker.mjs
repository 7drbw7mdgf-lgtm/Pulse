/**
 * Pulse Mendeley token exchange (Cloudflare Worker, free plan).
 *
 * Holds only the Mendeley application secret. It turns a sign-in code into tokens for the
 * Pulse app that started the sign-in, and refreshes tokens on request. It stores nothing:
 * sign-in state travels in an HMAC-signed, ten-minute `state` value. Tokens are returned to
 * the desktop, which keeps them encrypted locally and calls Mendeley directly.
 *
 * Secrets (wrangler secret put): MENDELEY_CLIENT_ID, MENDELEY_CLIENT_SECRET, STATE_KEY.
 */
const AUTHORIZE = 'https://api.mendeley.com/oauth/authorize';
const TOKEN = 'https://api.mendeley.com/oauth/token';
// Mendeley's edge rejects requests without a named user agent (Cloudflare error 1010).
const USER_AGENT = 'Pulse-exchange/1 (Mendeley sign-in)';
const PROTOCOL = 'exchange-1';
const STATE_SECONDS = 600;
const encoder = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function page(message, status) {
  const safe = String(message).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Mendeley connection</title><body style="font:16px system-ui;max-width:480px;margin:18vh auto;padding:24px"><h1>Mendeley connection</h1><p>${safe}</p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
  });
}

function base64url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
}

async function hmac(env, data) {
  if (!env.STATE_KEY || env.STATE_KEY.length < 32) throw new Error('STATE_KEY is not configured');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STATE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signState(env, claims) {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  return payload + '.' + await hmac(env, payload);
}

async function readState(env, state) {
  if (typeof state !== 'string' || state.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state)) return null;
  const [payload, signature] = state.split('.');
  if (!sameText(signature, await hmac(env, payload))) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))); } catch { return null; }
  if (!claims || typeof claims.c !== 'string' || !Number.isInteger(claims.p) || typeof claims.e !== 'number') return null;
  if (claims.e < Date.now() / 1000) return null;
  return claims;
}

async function s256(verifier) {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
}

function redirectUri(env, request) {
  return (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, '') + '/callback';
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 16384) return null;
  try { const body = JSON.parse(text); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}

async function providerToken(env, fields) {
  const response = await fetch(TOKEN, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT,
      Authorization: 'Basic ' + btoa(env.MENDELEY_CLIENT_ID + ':' + env.MENDELEY_CLIENT_SECRET)
    },
    body: new URLSearchParams(fields).toString()
  });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    if (response.status === 401) {
      return json({
        error: 'Mendeley application authentication failed. The Pulse sign-in service owner must verify its registered application ID and secret before connecting again.',
        code: 'mendeley_application_authentication_failed', stage: 'application_authentication', providerStatus: 401
      }, 401);
    }
    const reason = String(body.error_description || body.message || body.error || 'Mendeley refused the request.').slice(0, 300);
    return json({ error: reason, code: 'mendeley_token_exchange_failed', stage: 'token_exchange', providerStatus: response.status }, response.status === 400 ? 400 : 502);
  }
  const { access_token, refresh_token, expires_in, token_type } = body;
  if (typeof access_token !== 'string' || !access_token) return json({ error: 'Mendeley did not issue a token.' }, 502);
  return json({ access_token, refresh_token, expires_in, token_type });
}

async function start(request, env) {
  const body = await readJson(request);
  const challenge = body?.challenge, port = body?.port;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return json({ error: 'Invalid sign-in request.' }, 400);
  }
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = await signState(env, { c: challenge, p: port, e: Math.floor(Date.now() / 1000) + STATE_SECONDS, n: nonce });
  const query = new URLSearchParams({ client_id: env.MENDELEY_CLIENT_ID, redirect_uri: redirectUri(env, request), response_type: 'code', scope: 'all', state });
  return json({ authorizationUrl: AUTHORIZE + '?' + query.toString(), state, protocol: PROTOCOL });
}

async function callback(request, env) {
  const params = new URL(request.url).searchParams;
  const claims = await readState(env, params.get('state'));
  if (!claims) return page('This sign-in link is invalid or has expired. Start again in Pulse.', 400);
  // Hand the result to the Pulse app on this computer. The code is useless without the app's verifier.
  const local = new URL(`http://127.0.0.1:${claims.p}/mendeley/callback`);
  local.searchParams.set('state', params.get('state'));
  const code = params.get('code');
  if (params.get('error') || !code) local.searchParams.set('error', 'access_denied');
  else local.searchParams.set('code', code);
  return new Response(null, { status: 302, headers: { Location: local.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

async function token(request, env) {
  const body = await readJson(request);
  const claims = await readState(env, body?.state);
  const code = body?.code, verifier = body?.verifier;
  if (!claims || typeof code !== 'string' || !code || code.length > 4096 || typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    return json({ error: 'This sign-in is invalid or has expired. Connect again.' }, 400);
  }
  if (!sameText(await s256(verifier), claims.c)) return json({ error: 'This sign-in was started by a different app.' }, 400);
  return providerToken(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env, request) });
}

async function refresh(request, env) {
  const body = await readJson(request);
  const refreshToken = body?.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 4096) return json({ error: 'Invalid refresh request.' }, 400);
  return providerToken(env, { grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri(env, request) });
}

export default {
  async fetch(request, env) {
    try {
      const { pathname } = new URL(request.url);
      const configured = Boolean(env.MENDELEY_CLIENT_ID && env.MENDELEY_CLIENT_SECRET && env.STATE_KEY && env.STATE_KEY.length >= 32);
      // This checks configuration presence, without claiming the provider accepts it.
      if (request.method === 'GET' && pathname === '/health') return json({ ok: configured, configured,
        providerAuthentication: 'not_checked', protocol: PROTOCOL }, configured ? 200 : 503);
      if (!configured) return json({ error: 'The sign-in service is not configured.' }, 503);
      if (request.method === 'GET' && pathname === '/callback') return await callback(request, env);
      if (request.method === 'POST' && pathname === '/start') return await start(request, env);
      if (request.method === 'POST' && pathname === '/token') return await token(request, env);
      if (request.method === 'POST' && pathname === '/refresh') return await refresh(request, env);
      return json({ error: 'Not found.' }, 404);
    } catch {
      return json({ error: 'The sign-in service failed. Try again.' }, 500);
    }
  }
};
