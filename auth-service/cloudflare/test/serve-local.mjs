// Test harness: serves worker.mjs over local HTTP with Mendeley's token endpoint faked.
// Usage: node serve-local.mjs  -> prints the port on stdout. Accepts code "good-code" only.
import http from 'node:http';
import worker from '../worker.mjs';

const env = { MENDELEY_CLIENT_ID: 'harness-client', MENDELEY_CLIENT_SECRET: 'harness-secret', STATE_KEY: 'h'.repeat(40) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.mendeley.com/oauth/token') return realFetch(url, init);
  const fields = new URLSearchParams(init.body);
  const authorised = init.headers.Authorization === 'Basic ' + btoa('harness-client:harness-secret');
  if (authorised && fields.get('grant_type') === 'authorization_code' && fields.get('code') === 'good-code') {
    return Response.json({ access_token: 'harness-access', refresh_token: 'harness-refresh', expires_in: 3600, token_type: 'bearer' });
  }
  if (authorised && fields.get('grant_type') === 'refresh_token' && fields.get('refresh_token') === 'harness-refresh') {
    return Response.json({ access_token: 'harness-access-2', refresh_token: 'harness-refresh-2', expires_in: 3600, token_type: 'bearer' });
  }
  return Response.json({ error: 'invalid_grant', error_description: 'Code not accepted' }, { status: 400 });
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
  const response = await worker.fetch(request, { ...env, PUBLIC_ORIGIN: `http://127.0.0.1:${server.address().port}` });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port) + '\n'); });
