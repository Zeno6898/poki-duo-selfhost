// The real daemon with POKI_OAUTH=builtin: an MCP client signs in through the OAuth flow and
// calls tools over HTTP, while the local stdio client keeps using the token in mcp.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { hashPassword } from '../src/auth/password.mjs';
import { generateSecret, totpAt, counterAt } from '../src/auth/totp.mjs';
import { fixture } from './fixture.mjs';

test('a remote MCP client signs in with OAuth and calls tools on the real daemon', { timeout: 60000 }, async t => {
  const accountDir = await mkdtemp(join(tmpdir(), 'poki-account-'));
  t.after(() => rm(accountDir, { recursive: true, force: true }));
  const totpSecret = generateSecret();
  await writeFile(join(accountDir, 'account.json'), JSON.stringify({ username: 'owner', password_hash: await hashPassword('correct horse battery', { N: 1024, r: 8, p: 1 }), totp_secret: totpSecret }), { mode: 0o600 });
  // The fixture copies process.env into the daemon's environment. Host checks ignore the port, so
  // http://localhost stands in for the public HTTPS hostname.
  Object.assign(process.env, { POKI_MCP_PUBLIC_URL: 'http://localhost', POKI_OAUTH: 'builtin', POKI_OAUTH_ACCOUNT_FILE: join(accountDir, 'account.json'), POKI_INPUT_LOCK: '1' });
  t.after(() => { for (const key of ['POKI_MCP_PUBLIC_URL', 'POKI_OAUTH', 'POKI_OAUTH_ACCOUNT_FILE', 'POKI_INPUT_LOCK']) delete process.env[key]; });
  const f = await fixture(t);
  const endpoint = JSON.parse(await readFile(join(f.dir, 'state/mcp.json'), 'utf8'));
  const port = endpoint.port;
  const request = (method, path, { form, json, headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : json ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json: parsed }); });
    });
    req.on('error', reject); req.end(body);
  });

  // Discovery, as a client starting from nothing but the URL would do it.
  const challenge = await request('POST', '/mcp', { json: {} });
  assert.equal(challenge.status, 401);
  const metadataUrl = new URL(challenge.headers['www-authenticate'].match(/resource_metadata="([^"]+)"/)[1]);
  const prm = await request('GET', metadataUrl.pathname);
  assert.equal(prm.json.resource, 'http://localhost/mcp');
  const as = await request('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.json.issuer, prm.json.authorization_servers[0]);

  const client = (await request('POST', '/register', { json: { client_name: 'Test agent', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none' } })).json;
  const verifier = randomBytes(32).toString('base64url');
  const page = await request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/callback', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: prm.json.resource })}`);
  const login = await request('POST', '/authorize', { form: { request_id: page.text.match(/name="request_id" value="([^"]+)"/)[1], username: 'owner', password: 'correct horse battery', totp: totpAt(totpSecret, counterAt()), action: 'approve' } });
  assert.equal(login.status, 302, login.text);
  const code = new URL(login.headers.location).searchParams.get('code');
  const tokens = (await request('POST', '/token', { form: { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9/callback', code_verifier: verifier, client_id: client.client_id } })).json;
  assert.ok(tokens.access_token);

  // A standard MCP client over Streamable HTTP with the access token.
  const remote = new Client({ name: 'remote-agent', version: '1' });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  t.after(() => remote.close());
  const status = await remote.callTool({ name: 'poki_mcp_status', arguments: {} });
  assert.ok(!status.isError, JSON.stringify(status));
  const devices = await remote.callTool({ name: 'list_devices', arguments: {} });
  assert.ok(!devices.isError, JSON.stringify(devices));
  assert.match(JSON.stringify(devices), /fixture-phone/);

  // The local stdio client is unaffected.
  const local = await f.call('poki_mcp_status');
  assert.ok(!local.isError, JSON.stringify(local));

  // A bad token on the public hostname still gets the challenge, not the tools.
  const rejected = new Client({ name: 'bad', version: '1' });
  await assert.rejects(rejected.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } })));
});
