import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteConfig } from '../src/auth/config.mjs';
import { hashPassword, verifyPassword } from '../src/auth/password.mjs';
import { base32Encode, totpAt, verifyTotp, counterAt, generateSecret } from '../src/auth/totp.mjs';
import { generateSigningKey, publicJwk, signJwt, verifyJwt } from '../src/auth/jwt.mjs';
import { createFront } from '../src/auth/front.mjs';
import { AuthorizationServer, validRedirectUri } from '../src/auth/authorization-server.mjs';
import { externalVerifier } from '../src/auth/resource-server.mjs';

const b64url = buffer => buffer.toString('base64url');
const pkce = () => { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }; };
const LOCAL_TOKEN = 'l'.repeat(64);

// --- configuration ---------------------------------------------------------------------------

test('with no remote settings the daemon stays local with a random token', () => {
  const config = remoteConfig({}, '/state');
  assert.deepEqual(config, { bind: '127.0.0.1', token: undefined, publicUrl: undefined, mode: 'local' });
});

test('remote settings refuse unsafe combinations with a message naming the fix', () => {
  assert.throws(() => remoteConfig({ POKI_MCP_BIND: '0.0.0.0' }, '/s'), /POKI_MCP_PUBLIC_URL and POKI_OAUTH/);
  assert.throws(() => remoteConfig({ POKI_MCP_BIND: 'example.com' }, '/s'), /IP address/);
  assert.throws(() => remoteConfig({ POKI_MCP_TOKEN: 'short' }, '/s'), /at least 32/);
  assert.throws(() => remoteConfig({ POKI_MCP_PUBLIC_URL: 'http://poki.example.com' }, '/s'), /https/);
  assert.throws(() => remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.com/mcp' }, '/s'), /origin only/);
  assert.throws(() => remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.com' }, '/s'), /POKI_OAUTH=builtin/);
  assert.throws(() => remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.com', POKI_OAUTH: 'external' }, '/s'), /POKI_OAUTH_ISSUER/);
  assert.throws(() => remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.com', POKI_OAUTH: 'external', POKI_OAUTH_ISSUER: 'https://id.example.com' }, '/s'), /POKI_OAUTH_ALLOWED_SUBJECTS/);
});

test('a stable token can come from POKI_MCP_TOKEN or a credentials file', async t => {
  assert.equal(remoteConfig({ POKI_MCP_TOKEN: LOCAL_TOKEN }, '/s').token, LOCAL_TOKEN);
  const dir = await mkdtemp(join(tmpdir(), 'poki-token-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'token'), `${LOCAL_TOKEN}\n`);
  assert.equal(remoteConfig({ POKI_MCP_TOKEN_FILE: join(dir, 'token') }, '/s').token, LOCAL_TOKEN);
});

test('builtin mode derives the resource, metadata URL and redirect allowlist from the public URL', () => {
  const config = remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://Poki.Example.ts.net/', POKI_OAUTH: 'builtin', POKI_MCP_BIND: '0.0.0.0' }, '/state');
  assert.equal(config.resource, 'https://poki.example.ts.net/mcp');
  assert.equal(config.issuer, 'https://poki.example.ts.net');
  assert.equal(config.resourceMetadataUrl, 'https://poki.example.ts.net/.well-known/oauth-protected-resource/mcp');
  assert.equal(config.accountFile, '/state/oauth/account.json');
  assert.ok(config.redirectHosts.includes('claude.ai'));
});

// --- primitives --------------------------------------------------------------------------------

test('passwords are stored as salted scrypt hashes', async () => {
  const hash = await hashPassword('correct horse battery', { N: 1024, r: 8, p: 1 });
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.ok(!hash.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong horse battery', hash), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  await assert.rejects(hashPassword('short'), /12 characters/);
});

test('TOTP matches the RFC 6238 vectors, allows one step of drift and refuses replays', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30), 8), '07081804');
  const now = Date.now(), code = totpAt(secret, counterAt(now));
  const counter = verifyTotp(secret, code, { now });
  assert.equal(counter, counterAt(now));
  assert.equal(verifyTotp(secret, code, { now, after: counter }), undefined, 'a used code is refused');
  assert.equal(verifyTotp(secret, totpAt(secret, counterAt(now) - 1), { now }), counterAt(now) - 1);
  assert.equal(verifyTotp(secret, totpAt(secret, counterAt(now) - 3), { now }), undefined);
  assert.equal(verifyTotp(secret, 'abcdef', { now }), undefined);
});

test('JWTs are checked for signature, issuer, audience, expiry and algorithm', () => {
  const key = generateSigningKey(), keys = [publicJwk(key)];
  const claims = { iss: 'https://a', aud: 'https://a/mcp', exp: Math.floor(Date.now() / 1000) + 60 };
  const token = signJwt(claims, key);
  assert.equal(verifyJwt(token, { keys, issuer: 'https://a', audience: 'https://a/mcp' }).iss, 'https://a');
  assert.throws(() => verifyJwt(token, { keys, issuer: 'https://b', audience: 'https://a/mcp' }), /issuer/);
  assert.throws(() => verifyJwt(token, { keys, issuer: 'https://a', audience: 'https://other/mcp' }), /audience/);
  assert.throws(() => verifyJwt(signJwt({ ...claims, exp: 1 }, key), { keys, issuer: 'https://a', audience: 'https://a/mcp' }), /expired/);
  const [h, p, s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, aud: 'https://a/mcp', sub: 'mallory' })).toString('base64url')}.${s}`;
  assert.throws(() => verifyJwt(forged, { keys, issuer: 'https://a', audience: 'https://a/mcp' }), /signature/);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${p}.`;
  assert.throws(() => verifyJwt(none, { keys, issuer: 'https://a', audience: 'https://a/mcp' }), /Malformed|algorithm/);
  assert.throws(() => verifyJwt(token, { keys: [publicJwk(generateSigningKey())], issuer: 'https://a', audience: 'https://a/mcp' }), /No signing key/);
});

test('dynamic registration accepts only allowlisted https or loopback redirects', () => {
  const hosts = ['claude.ai', 'localhost', '127.0.0.1'];
  assert.equal(validRedirectUri('https://claude.ai/api/mcp/auth_callback', hosts), true);
  assert.equal(validRedirectUri('http://localhost:53682/callback', hosts), true);
  assert.equal(validRedirectUri('http://claude.ai/callback', hosts), false);
  assert.equal(validRedirectUri('https://evil.example/callback', hosts), false);
  assert.equal(validRedirectUri('https://claude.ai.evil.example/cb', hosts), false);
  assert.equal(validRedirectUri('https://claude.ai/cb#x', hosts), false);
  assert.equal(validRedirectUri('https://app.example.com/cb', ['*.example.com']), true);
});

// --- the HTTP flow -----------------------------------------------------------------------------

// Starts a daemon front with the built-in server. Accepted requests answer {session, path}.
async function startFront(t, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-oauth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const totpSecret = generateSecret();
  await writeFile(join(dir, 'account.json'), JSON.stringify({ username: 'owner', password_hash: await hashPassword('correct horse battery', { N: 1024, r: 8, p: 1 }), totp_secret: totpSecret }));
  const config = remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.ts.net', POKI_OAUTH: 'builtin', POKI_OAUTH_ACCOUNT_FILE: join(dir, 'account.json'), ...extraEnv }, dir);
  config.failureDelayMs = 0;
  const authorizationServer = await AuthorizationServer.create(config);
  const front = await createFront(config, LOCAL_TOKEN, { authorizationServer });
  const server = http.createServer(async (req, res) => {
    const accepted = await front(req, res);
    if (accepted) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ session: accepted.session, path: accepted.path, scopes: accepted.authInfo?.scopes })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  // Requests go to 127.0.0.1 with a chosen Host header, as Funnel or cloudflared would send them.
  const request = (method, path, { host = 'poki.example.ts.net', headers = {}, body, form, json } = {}) => new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : body;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : json ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json: parsed }); });
    });
    req.on('error', reject); req.end(payload);
  });
  const code = () => totpAt(totpSecret, counterAt());
  return { request, config, authorizationServer, dir, totpSecret, code };
}

async function signIn(f, { redirect = 'https://claude.ai/api/mcp/auth_callback', method = 'none' } = {}) {
  const registered = await f.request('POST', '/register', { json: { client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: method } });
  assert.equal(registered.status, 201, registered.text);
  const client = registered.json;
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'poki', resource: f.config.resource });
  const page = await f.request('GET', `/authorize?${query}`);
  assert.equal(page.status, 200, page.text);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.text, /Claude/);
  assert.match(page.text, /claude\.ai/);
  const requestId = page.text.match(/name="request_id" value="([^"]+)"/)[1];
  // The TOTP replay guard refuses a code used in the same 30 s step, so tests that sign in twice
  // move the guard back.
  f.authorizationServer.lastTotpCounter = -Infinity;
  const login = await f.request('POST', '/authorize', { form: { request_id: requestId, username: 'owner', password: 'correct horse battery', totp: f.code(), action: 'approve' }, headers: { Origin: 'https://poki.example.ts.net' } });
  assert.equal(login.status, 302, login.text);
  const location = new URL(login.headers.location);
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get('state'), 'xyz');
  assert.equal(location.searchParams.get('iss'), f.config.issuer);
  const tokenForm = { grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, client_id: client.client_id, resource: f.config.resource };
  const headers = method === 'client_secret_basic' ? { Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` } : {};
  const tokens = await f.request('POST', '/token', { form: method === 'client_secret_basic' ? Object.fromEntries(Object.entries(tokenForm).filter(([k]) => k !== 'client_id')) : tokenForm, headers });
  assert.equal(tokens.status, 200, tokens.text);
  assert.equal(tokens.headers['cache-control'], 'no-store');
  return { client, tokens: tokens.json, verifier, tokenForm };
}

test('an unauthenticated MCP request points the client at the protected resource metadata', async t => {
  const f = await startFront(t);
  const denied = await f.request('POST', '/mcp', { json: {} });
  assert.equal(denied.status, 401);
  assert.match(denied.headers['www-authenticate'], /^Bearer /);
  assert.match(denied.headers['www-authenticate'], /resource_metadata="https:\/\/poki\.example\.ts\.net\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await f.request('GET', '/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual(prm.json, { resource: 'https://poki.example.ts.net/mcp', authorization_servers: ['https://poki.example.ts.net'], bearer_methods_supported: ['header'], resource_name: 'Poki MCP', scopes_supported: ['poki'] });
  const as = await f.request('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.json.issuer, 'https://poki.example.ts.net');
  assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
  assert.equal(as.json.registration_endpoint, 'https://poki.example.ts.net/register');
  const jwks = await f.request('GET', '/jwks.json');
  assert.equal(jwks.json.keys.length, 1);
  assert.equal(jwks.json.keys[0].d, undefined, 'the private key is never published');
});

test('the full sign-in gives an access token that opens one MCP session per grant', async t => {
  const f = await startFront(t);
  const { tokens } = await signIn(f);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.scope, 'poki');
  assert.ok(tokens.refresh_token);
  const accepted = await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.match(accepted.json.session, /^oauth-[A-Za-z0-9_-]+$/);
  assert.deepEqual(accepted.json.scopes, ['poki']);
  const second = await signIn(f);
  const other = await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${second.tokens.access_token}` } });
  assert.notEqual(other.json.session, accepted.json.session, 'two sign-ins are two sessions');
  // Files that hold secrets are private to the daemon user.
  for (const file of ['store.json', 'signing-key.json']) assert.equal((await stat(join(f.dir, 'oauth', file))).mode & 0o777, 0o600);
  const stored = await readFile(join(f.dir, 'oauth/store.json'), 'utf8');
  assert.ok(!stored.includes(tokens.refresh_token), 'refresh tokens are stored hashed');
});

test('a confidential client authenticates with its secret', async t => {
  const f = await startFront(t);
  const { tokens } = await signIn(f, { method: 'client_secret_basic' });
  assert.ok(tokens.access_token);
});

test('refresh tokens rotate, and replaying an old one revokes the grant', async t => {
  const f = await startFront(t);
  const { client, tokens } = await signIn(f);
  const refreshed = await f.request('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id } });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.notEqual(refreshed.json.refresh_token, tokens.refresh_token);
  const ok = await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${refreshed.json.access_token}` } });
  assert.equal(ok.status, 200);
  const replay = await f.request('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id } });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, 'invalid_grant');
  const afterRevoke = await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${refreshed.json.access_token}` } });
  assert.equal(afterRevoke.status, 401, 'revoking the grant ends its access tokens');
  const newer = await f.request('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: refreshed.json.refresh_token, client_id: client.client_id } });
  assert.equal(newer.status, 400);
});

test('revocation ends a grant', async t => {
  const f = await startFront(t);
  const { client, tokens } = await signIn(f);
  assert.equal((await f.request('POST', '/revoke', { form: { token: tokens.refresh_token, client_id: client.client_id } })).status, 200);
  assert.equal((await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});

test('authorization codes are single-use and bound to PKCE, client and redirect', async t => {
  const f = await startFront(t);
  const { tokenForm } = await signIn(f);
  const reuse = await f.request('POST', '/token', { form: tokenForm });
  assert.equal(reuse.json.error, 'invalid_grant');

  const registered = (await f.request('POST', '/register', { json: { client_name: 'C', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' } })).json;
  const begin = async () => {
    const { verifier, challenge } = pkce();
    const page = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    f.authorizationServer.lastTotpCounter = -Infinity;
    const login = await f.request('POST', '/authorize', { form: { request_id: page.text.match(/name="request_id" value="([^"]+)"/)[1], username: 'owner', password: 'correct horse battery', totp: f.code(), action: 'approve' } });
    return { verifier, code: new URL(login.headers.location).searchParams.get('code') };
  };
  const wrongVerifier = await begin();
  assert.equal((await f.request('POST', '/token', { form: { grant_type: 'authorization_code', code: wrongVerifier.code, redirect_uri: 'https://claude.ai/cb', code_verifier: pkce().verifier, client_id: registered.client_id } })).json.error, 'invalid_grant');
  const wrongRedirect = await begin();
  assert.equal((await f.request('POST', '/token', { form: { grant_type: 'authorization_code', code: wrongRedirect.code, redirect_uri: 'https://claude.ai/other', code_verifier: wrongRedirect.verifier, client_id: registered.client_id } })).json.error, 'invalid_grant');
  const wrongClient = await begin();
  const otherClient = (await f.request('POST', '/register', { json: { client_name: 'D', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' } })).json;
  assert.equal((await f.request('POST', '/token', { form: { grant_type: 'authorization_code', code: wrongClient.code, redirect_uri: 'https://claude.ai/cb', code_verifier: wrongClient.verifier, client_id: otherClient.client_id } })).json.error, 'invalid_grant');
});

test('the authorize endpoint refuses requests without PKCE or with a foreign redirect', async t => {
  const f = await startFront(t);
  const client = (await f.request('POST', '/register', { json: { client_name: 'C', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' } })).json;
  const noPkce = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/cb', state: 's' })}`);
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.location).searchParams.get('error'), 'invalid_request');
  const plain = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: pkce().challenge, code_challenge_method: 'plain' })}`);
  assert.equal(new URL(plain.headers.location).searchParams.get('error'), 'invalid_request');
  const foreign = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  assert.equal(foreign.status, 400, 'a mismatched redirect is never followed');
  assert.equal(foreign.headers.location, undefined);
  const target = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })}`);
  assert.equal(new URL(target.headers.location).searchParams.get('error'), 'invalid_target');
  const badRegistration = await f.request('POST', '/register', { json: { redirect_uris: ['https://evil.example/cb'] } });
  assert.equal(badRegistration.status, 400);
  assert.equal(badRegistration.json.error, 'invalid_redirect_uri');
});

test('sign-in needs the password and a fresh TOTP code, and locks after repeated failures', async t => {
  const f = await startFront(t);
  const client = (await f.request('POST', '/register', { json: { client_name: 'C', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' } })).json;
  const page = await f.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  const requestId = page.text.match(/name="request_id" value="([^"]+)"/)[1];
  const attempt = fields => f.request('POST', '/authorize', { form: { request_id: requestId, username: 'owner', password: 'correct horse battery', totp: f.code(), action: 'approve', ...fields } });
  assert.equal((await attempt({ password: 'wrong password!' })).status, 401);
  assert.equal((await attempt({ totp: '000000' === f.code() ? '111111' : '000000' })).status, 401);
  assert.equal((await attempt({ username: 'someone' })).status, 401);
  const crossSite = await f.request('POST', '/authorize', { form: { request_id: requestId }, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  await attempt({ password: 'wrong password!' });
  await attempt({ password: 'wrong password!' });
  const locked = await attempt({});
  assert.equal(locked.status, 429, 'five failures lock sign-in even with the right credentials');
  assert.match(locked.text, /Wait 15 minutes/);
  // Deny always works and returns the error to the client.
  const deny = await f.request('POST', '/authorize', { form: { request_id: requestId, action: 'deny' } });
  assert.equal(new URL(deny.headers.location).searchParams.get('error'), 'access_denied');
});

test('tokens for another audience or signed by another key are refused', async t => {
  const f = await startFront(t);
  const { tokens } = await signIn(f);
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
  const wrongAudience = signJwt({ ...claims, aud: 'https://other.example/mcp' }, f.authorizationServer.key);
  assert.equal((await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${wrongAudience}` } })).status, 401);
  const otherKey = signJwt(claims, generateSigningKey());
  assert.equal((await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${otherKey}` } })).status, 401);
  const wrongScope = signJwt({ ...claims, scope: 'other' }, f.authorizationServer.key);
  assert.equal((await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${wrongScope}` } })).status, 403);
  assert.equal((await f.request('POST', '/mcp', { json: {}, headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } })).status, 401, 'the local token is not accepted on the public hostname');
});

test('Host and Origin are validated, and the local token works only from this machine', async t => {
  const f = await startFront(t);
  const local = { Authorization: `Bearer ${LOCAL_TOKEN}`, 'X-Poki-Mcp-Session': 'local-1' };
  const ok = await f.request('POST', '/mcp', { host: '127.0.0.1:47825', headers: local, json: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.session, 'local-1');
  assert.equal((await f.request('POST', '/mcp', { host: '127.0.0.1', json: {} })).status, 401);
  assert.equal((await f.request('POST', '/mcp', { host: 'attacker.example', headers: local, json: {} })).status, 403);
  assert.equal((await f.request('POST', '/mcp', { host: '127.0.0.1', headers: { ...local, 'X-Forwarded-For': '203.0.113.9' }, json: {} })).status, 403, 'a proxied request never uses the local token');
  assert.equal((await f.request('POST', '/mcp', { host: '127.0.0.1', headers: { ...local, Origin: 'https://evil.example' }, json: {} })).status, 403);
  const { tokens } = await signIn(f);
  const auth = { Authorization: `Bearer ${tokens.access_token}` };
  assert.equal((await f.request('POST', '/mcp', { headers: { ...auth, Origin: 'https://evil.example' }, json: {} })).status, 403);
  const forwarded = await f.request('POST', '/mcp', { host: '127.0.0.1:47825', headers: { ...auth, 'X-Forwarded-Host': 'poki.example.ts.net', 'X-Forwarded-For': '203.0.113.9' }, json: {} });
  assert.equal(forwarded.status, 200, 'a proxy on this machine may pass the public Host as X-Forwarded-Host');
});

test('allowed browser origins get CORS headers on the MCP endpoint', async t => {
  const f = await startFront(t, { POKI_MCP_ALLOWED_ORIGINS: 'inspector.example' });
  const preflight = await f.request('OPTIONS', '/mcp', { headers: { Origin: 'https://inspector.example' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://inspector.example');
  const challenge = await f.request('POST', '/mcp', { headers: { Origin: 'https://inspector.example' }, json: {} });
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers['access-control-allow-origin'], 'https://inspector.example');
});

// --- an external authorization server ----------------------------------------------------------

test('external mode checks tokens against the issuer JWKS and the subject allowlist', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
  const { createSign } = await import('node:crypto');
  const es256 = claims => {
    const input = `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const signature = createSign('sha256').update(input).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${input}.${signature.toString('base64url')}`;
  };
  const config = remoteConfig({ POKI_MCP_PUBLIC_URL: 'https://poki.example.com', POKI_OAUTH: 'external', POKI_OAUTH_ISSUER: 'https://id.example.com', POKI_OAUTH_ALLOWED_SUBJECTS: 'owner@example.com' }, '/s');
  let fetches = 0;
  const fakeFetch = async url => {
    fetches++;
    if (String(url) === 'https://id.example.com/.well-known/oauth-authorization-server') return Response.json({ jwks_uri: 'https://id.example.com/keys' });
    if (String(url) === 'https://id.example.com/keys') return Response.json({ keys: [jwk] });
    return new Response('', { status: 404 });
  };
  const verifier = externalVerifier(config, fakeFetch);
  const exp = Math.floor(Date.now() / 1000) + 300;
  const info = await verifier.verifyAccessToken(es256({ iss: 'https://id.example.com', aud: 'https://poki.example.com/mcp', sub: 'u-1', email: 'owner@example.com', exp, client_id: 'c' }));
  assert.equal(info.clientId, 'c');
  assert.equal(info.resource.href, 'https://poki.example.com/mcp');
  await assert.rejects(verifier.verifyAccessToken(es256({ iss: 'https://id.example.com', aud: 'https://poki.example.com/mcp', sub: 'u-2', email: 'someone@example.com', exp })), /allowed account/);
  await assert.rejects(verifier.verifyAccessToken(es256({ iss: 'https://evil.example.com', aud: 'https://poki.example.com/mcp', sub: 'owner@example.com', exp })), /issuer/);
  assert.equal(fetches, 2, 'the JWKS is cached');
});

// --- Cloudflare Access in front (POKI_OAUTH=cloudflare-access) ---------------------------------

const AUD = 'a'.repeat(64);
const cfEnv = { POKI_MCP_PUBLIC_URL: 'https://poki.example.com', POKI_OAUTH: 'cloudflare-access', POKI_CF_ACCESS_TEAM: 'myteam', POKI_CF_ACCESS_AUD: AUD, POKI_OAUTH_ALLOWED_SUBJECTS: 'owner@example.com' };

test('cloudflare-access mode needs the team, AUD tag, allowed emails and a loopback bind', () => {
  const config = remoteConfig(cfEnv, '/s');
  assert.equal(config.issuer, 'https://myteam.cloudflareaccess.com');
  assert.equal(config.jwksUrl, 'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
  assert.equal(config.audience, AUD);
  assert.deepEqual(config.allowedAlgorithms, ['RS256']);
  assert.throws(() => remoteConfig({ ...cfEnv, POKI_MCP_BIND: '0.0.0.0' }, '/s'), /loopback/);
  assert.throws(() => remoteConfig({ ...cfEnv, POKI_CF_ACCESS_TEAM: '' }, '/s'), /POKI_CF_ACCESS_TEAM/);
  assert.throws(() => remoteConfig({ ...cfEnv, POKI_CF_ACCESS_TEAM: 'evil.com/x' }, '/s'), /POKI_CF_ACCESS_TEAM/);
  assert.throws(() => remoteConfig({ ...cfEnv, POKI_CF_ACCESS_AUD: '' }, '/s'), /POKI_CF_ACCESS_AUD/);
  assert.throws(() => remoteConfig({ ...cfEnv, POKI_OAUTH_ALLOWED_SUBJECTS: '' }, '/s'), /POKI_OAUTH_ALLOWED_SUBJECTS/);
});

async function startCloudflareFront(t) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-1', alg: 'RS256', use: 'sig' };
  const { createSign } = await import('node:crypto');
  const sign = (claims, header = { alg: 'RS256', kid: 'cf-1' }, key = privateKey) => {
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${createSign('sha256').update(input).sign(key).toString('base64url')}`;
  };
  const fetched = [];
  const fakeFetch = async url => { fetched.push(String(url)); return String(url) === 'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs' ? Response.json({ keys: [jwk], public_cert: {}, public_certs: [] }) : new Response('', { status: 404 }); };
  const config = remoteConfig(cfEnv, '/unused');
  const front = await createFront(config, LOCAL_TOKEN, { fetch: fakeFetch });
  const server = http.createServer(async (req, res) => {
    const accepted = await front(req, res);
    if (accepted) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ session: accepted.session, path: accepted.path })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const request = (method, path, { host = 'poki.example.com', headers = {} } = {}) => new Promise((resolve, reject) => {
    const all = Object.fromEntries(Object.entries({ Host: host, 'Content-Type': 'application/json', 'Cf-Ray': 'x', ...headers }).filter(([, v]) => v !== undefined));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: all }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json: parsed }); });
    });
    req.on('error', reject); req.end('{}');
  });
  const exp = Math.floor(Date.now() / 1000) + 300;
  const claims = { iss: 'https://myteam.cloudflareaccess.com', aud: [AUD], email: 'owner@example.com', sub: 'user-uuid', exp, iat: exp - 600, type: 'app' };
  return { request, sign, claims, fetched };
}

test('cloudflare-access mode accepts a verified Access assertion for an allowed email, with no bearer', async t => {
  const f = await startCloudflareFront(t);
  const ok = await f.request('POST', '/mcp', { headers: { 'Cf-Access-Jwt-Assertion': f.sign(f.claims) } });
  assert.equal(ok.status, 200, ok.text);
  const expected = createHash('sha256').update('owner@example.com').digest('base64url').slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
  assert.equal(ok.json.session, `cfaccess-${expected}`, 'the session is keyed by the email');
  const again = await f.request('POST', '/mcp', { headers: { 'Cf-Access-Jwt-Assertion': f.sign({ ...f.claims, iat: f.claims.iat + 1 }) } });
  assert.equal(again.json.session, ok.json.session, 'one person keeps one session across assertions');
  assert.equal(f.fetched.length, 1, 'the JWKS is cached');
});

test('cloudflare-access mode refuses missing, forged, foreign or expired assertions', async t => {
  const f = await startCloudflareFront(t);
  const status = async headers => (await f.request('POST', '/mcp', { headers })).status;
  assert.equal(await status({}), 401);
  assert.equal(await status({ Authorization: `Bearer ${LOCAL_TOKEN}` }), 401, 'a bearer token is not a substitute');
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': f.sign({ ...f.claims, email: 'someone@example.com', sub: 'other' }) }), 401);
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': f.sign({ ...f.claims, aud: ['b'.repeat(64)] }) }), 401);
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': f.sign({ ...f.claims, iss: 'https://otherteam.cloudflareaccess.com' }) }), 401);
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': f.sign({ ...f.claims, exp: 1 }) }), 401);
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': f.sign(f.claims, { alg: 'RS256', kid: 'cf-1' }, otherKey) }), 401);
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'cf-1' })).toString('base64url')}.${Buffer.from(JSON.stringify(f.claims)).toString('base64url')}.`;
  assert.equal(await status({ 'Cf-Access-Jwt-Assertion': unsigned }), 401);
  // Host and Origin rules still apply, and the local token still works on localhost.
  assert.equal((await f.request('POST', '/mcp', { host: 'attacker.example', headers: { 'Cf-Access-Jwt-Assertion': f.sign(f.claims) } })).status, 403);
  assert.equal((await f.request('POST', '/mcp', { headers: { 'Cf-Access-Jwt-Assertion': f.sign(f.claims), Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('GET', '/.well-known/oauth-authorization-server')).status, 404, 'Access, not the daemon, is the authorization server');
  const local = await f.request('POST', '/mcp', { host: '127.0.0.1', headers: { 'Cf-Ray': undefined, Authorization: `Bearer ${LOCAL_TOKEN}`, 'X-Poki-Mcp-Session': 'local' } });
  assert.equal(local.status, 200, local.text);
  const proxied = await f.request('POST', '/mcp', { host: '127.0.0.1', headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, 'X-Poki-Mcp-Session': 'local' } });
  assert.equal(proxied.status, 403, 'Cf-Ray marks a proxied request, so the local token is refused');
});
