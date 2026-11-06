// A built-in OAuth 2.1 authorization server for one person (POKI_OAUTH=builtin).
//
// It is deliberately small: authorization code with PKCE (S256 only), dynamic client
// registration (RFC 7591) limited to allowlisted redirect hosts, refresh-token rotation with
// reuse detection, and a login page that asks for the one allowlisted account's password and a
// TOTP code. Access tokens are short-lived Ed25519 JWTs whose audience is this daemon's /mcp URL.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateSigningKey, publicJwk, signJwt } from './jwt.mjs';
import { verifyPassword } from './password.mjs';
import { verifyTotp } from './totp.mjs';
import { JsonStore } from './store.mjs';
import { escapeHtml, noStore, openCors, readForm, readJson, sendJson, sendOAuthError } from './http.mjs';

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const now = () => Math.floor(Date.now() / 1000);

const CODE_TTL = 60, REQUEST_TTL = 600, MAX_CLIENTS = 50, MAX_PENDING = 100;
const LOCK_AFTER = 5, LOCK_WINDOW_MS = 15 * 60 * 1000;

export async function loadAccount(file) {
  let account;
  try { account = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? `No OAuth account at ${file}. Create one with bin/poki-oauth-account create.` : `Cannot read ${file}: ${error.message}`); }
  if (typeof account.username !== 'string' || !account.username || typeof account.password_hash !== 'string' || typeof account.totp_secret !== 'string') throw new Error(`${file} must hold username, password_hash and totp_secret; recreate it with bin/poki-oauth-account create.`);
  return account;
}

async function loadSigningKey(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const key = generateSigningKey();
    await writeFile(file, JSON.stringify(key), { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    return key;
  }
}

export function validRedirectUri(uri, allowedHosts) {
  let url;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
  return allowedHosts.some(host => host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host);
}

// RFC 8252: a loopback redirect may use any port, so compare without it.
function redirectMatches(registered, given) {
  if (registered === given) return true;
  try {
    const a = new URL(registered), b = new URL(given);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(a.hostname);
    return loopback && a.protocol === 'http:' && a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

export class AuthorizationServer {
  pending = new Map(); codes = new Map(); failures = []; lastTotpCounter = -Infinity;

  constructor(config, { account, key, store }) {
    this.config = config; this.account = account; this.key = key; this.store = store;
    this.jwks = { keys: [publicJwk(key)] };
  }

  static async create(config) {
    const [account, key, store] = await Promise.all([loadAccount(config.accountFile), loadSigningKey(config.keyFile), new JsonStore(config.storeFile).load()]);
    return new AuthorizationServer(config, { account, key, store });
  }

  get metadata() {
    const issuer = this.config.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      jwks_uri: `${issuer}/jwks.json`,
      scopes_supported: this.config.scopes,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // Whether an access token's grant still exists (revoking a grant ends its access tokens too).
  grantActive(sid) { const grant = this.store.data.grants[sid]; return Boolean(grant && grant.expires_at > now()); }

  // Returns true when it handled the request.
  async handle(req, res, path) {
    const open = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/jwks.json', '/token', '/register', '/revoke'];
    if (req.method === 'OPTIONS' && open.includes(path)) { res.writeHead(204, openCors); res.end(); return true; }
    try {
      if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') return this.get(req, res, () => sendJson(res, 200, this.metadata, openCors));
      if (path === '/jwks.json') return this.get(req, res, () => sendJson(res, 200, this.jwks, openCors));
      if (path === '/authorize') { await (req.method === 'POST' ? this.login(req, res) : this.get(req, res, () => this.authorize(req, res))); return true; }
      if (path === '/token') { await this.post(req, res, () => this.token(req, res)); return true; }
      if (path === '/register') { await this.post(req, res, () => this.register(req, res)); return true; }
      if (path === '/revoke') { await this.post(req, res, () => this.revoke(req, res)); return true; }
    } catch (error) {
      if (!res.headersSent) sendOAuthError(res, error.status ?? 400, 'invalid_request', error.status ? error.message : 'Malformed request', openCors);
      return true;
    }
    return false;
  }
  get(req, res, next) { if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET' }); res.end(); return true; } next(); return true; }
  async post(req, res, next) { if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; } await next(); }

  // RFC 7591 dynamic client registration.
  async register(req, res) {
    const body = await readJson(req);
    const fail = description => sendOAuthError(res, 400, 'invalid_client_metadata', description, openCors);
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) return fail('redirect_uris must list one to five URIs');
    const bad = uris.find(uri => typeof uri !== 'string' || !validRedirectUri(uri, this.config.redirectHosts));
    if (bad !== undefined) return sendOAuthError(res, 400, 'invalid_redirect_uri', `Redirect URI host is not allowed here. Allowed hosts: ${this.config.redirectHosts.join(', ')} (POKI_OAUTH_REDIRECT_HOSTS).`, openCors);
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return fail('Unsupported token_endpoint_auth_method');
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some(g => !['authorization_code', 'refresh_token'].includes(g))) return fail('grant_types must be authorization_code, optionally with refresh_token');
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.some(t => t !== 'code')) return fail('response_types must be code');
    const clients = this.store.data.clients;
    if (Object.keys(clients).length >= MAX_CLIENTS) this.pruneClients();
    if (Object.keys(clients).length >= MAX_CLIENTS) return sendOAuthError(res, 400, 'invalid_client_metadata', 'Too many registered clients; remove some with bin/poki-oauth-account revoke', openCors);
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Unnamed client';
    const client = { client_id: randomUUID(), client_id_issued_at: now(), client_name: name, redirect_uris: uris, grant_types: grantTypes, response_types: ['code'], token_endpoint_auth_method: method, ...(typeof body.scope === 'string' ? { scope: body.scope } : {}) };
    let secret;
    if (method !== 'none') { secret = random(); client.client_secret_hash = digest(secret); client.client_secret_expires_at = 0; }
    clients[client.client_id] = client;
    await this.store.save();
    const { client_secret_hash, ...visible } = client;
    sendJson(res, 201, { ...visible, ...(secret ? { client_secret: secret } : {}) }, { ...noStore, ...openCors });
  }

  // Drops clients that never completed a login, oldest first.
  pruneClients() {
    const inUse = new Set(Object.values(this.store.data.grants).map(g => g.client_id));
    const idle = Object.values(this.store.data.clients).filter(c => !inUse.has(c.client_id)).sort((a, b) => a.client_id_issued_at - b.client_id_issued_at);
    for (const client of idle.slice(0, Math.max(1, idle.length / 2))) delete this.store.data.clients[client.client_id];
  }

  authorizeError(res, message) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', ...this.pageHeaders() });
    res.end(this.page('Cannot sign in', `<p>${escapeHtml(message)}</p>`));
  }
  redirect(res, uri, params) {
    const url = new URL(uri);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    res.writeHead(302, { Location: url.href, ...noStore });
    res.end();
  }

  authorize(req, res) {
    const params = new URL(req.url, this.config.issuer).searchParams;
    const client = this.store.data.clients[params.get('client_id') ?? ''];
    if (!client) return this.authorizeError(res, 'This client is not registered with this server.');
    const redirectUri = params.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.some(uri => redirectMatches(uri, redirectUri))) return this.authorizeError(res, 'The redirect URI does not match this client\'s registration.');
    const state = params.get('state') ?? undefined;
    const fail = (error, description) => this.redirect(res, redirectUri, { error, error_description: description, state, iss: this.config.issuer });
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = params.get('code_challenge');
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'PKCE code_challenge is required');
    if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    const resource = params.get('resource');
    if (resource && resource.replace(/\/$/, '') !== this.config.resource) return fail('invalid_target', 'resource must be this server\'s MCP URL');
    const requested = (params.get('scope') ?? '').split(' ').filter(Boolean);
    if (requested.some(s => !this.config.scopes.includes(s))) return fail('invalid_scope', `Supported scopes: ${this.config.scopes.join(' ')}`);
    for (const [id, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(id);
    if (this.pending.size >= MAX_PENDING) return fail('temporarily_unavailable', 'Too many sign-ins in progress');
    const id = random();
    this.pending.set(id, { client_id: client.client_id, redirect_uri: redirectUri, state, challenge, scope: this.config.scopes.join(' '), resource: this.config.resource, expires: Date.now() + REQUEST_TTL * 1000 });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...this.pageHeaders() });
    res.end(this.loginPage(id, client, redirectUri));
  }

  locked() {
    const cutoff = Date.now() - LOCK_WINDOW_MS;
    this.failures = this.failures.filter(time => time > cutoff);
    return this.failures.length >= LOCK_AFTER;
  }

  async login(req, res) {
    // The form posts from this server's own page; a cross-site post is refused.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.config.issuer) { res.writeHead(403, this.pageHeaders()); res.end('Cross-origin sign-in refused'); return; }
    const form = await readForm(req);
    const id = form.get('request_id') ?? '';
    const pending = this.pending.get(id);
    if (!pending || pending.expires < Date.now()) { this.pending.delete(id); return this.authorizeError(res, 'This sign-in page has expired. Start again from your MCP client.'); }
    const client = this.store.data.clients[pending.client_id];
    if (!client) { this.pending.delete(id); return this.authorizeError(res, 'This client is no longer registered.'); }
    if (form.get('action') === 'deny') {
      this.pending.delete(id);
      return this.redirect(res, pending.redirect_uri, { error: 'access_denied', state: pending.state, iss: this.config.issuer });
    }
    if (this.locked()) return this.retry(res, id, client, pending, 'Too many failed sign-ins. Wait 15 minutes and try again.', 429);
    const username = form.get('username') ?? '', password = form.get('password') ?? '', code = form.get('totp') ?? '';
    const userOk = same(username, this.account.username);
    const passwordOk = await verifyPassword(password, this.account.password_hash);
    const counter = verifyTotp(this.account.totp_secret, code, { after: this.lastTotpCounter });
    if (!userOk || !passwordOk || counter === undefined) {
      this.failures.push(Date.now());
      await sleep(this.config.failureDelayMs ?? 1000);
      return this.retry(res, id, client, pending, 'The account, password or code is not right.', 401);
    }
    this.lastTotpCounter = counter;
    this.failures = [];
    this.pending.delete(id);
    const authorizationCode = random();
    this.codes.set(digest(authorizationCode), { ...pending, sub: this.account.username, expires: Date.now() + CODE_TTL * 1000 });
    for (const [key, entry] of this.codes) if (entry.expires < Date.now()) this.codes.delete(key);
    this.redirect(res, pending.redirect_uri, { code: authorizationCode, state: pending.state, iss: this.config.issuer });
  }

  retry(res, id, client, pending, message, status) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...this.pageHeaders() });
    res.end(this.loginPage(id, client, pending.redirect_uri, message));
  }

  // Returns the client, or undefined after sending invalid_client.
  authenticateClient(req, res, form) {
    let id = form.get('client_id'), secret = form.get('client_secret');
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) { sendOAuthError(res, 401, 'invalid_client', 'Malformed Basic credentials', openCors); return; }
      const basicId = decodeURIComponent(decoded.slice(0, colon));
      if (id && id !== basicId) { sendOAuthError(res, 401, 'invalid_client', 'client_id does not match', openCors); return; }
      id = basicId; secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = this.store.data.clients[id ?? ''];
    if (!client) { sendOAuthError(res, 401, 'invalid_client', 'Unknown client', openCors); return; }
    if (client.token_endpoint_auth_method !== 'none' && !(secret && same(digest(secret), client.client_secret_hash))) { sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed', openCors); return; }
    return client;
  }

  async token(req, res) {
    const form = await readForm(req);
    const client = this.authenticateClient(req, res, form);
    if (!client) return;
    const grantType = form.get('grant_type');
    const fail = (error, description) => sendOAuthError(res, 400, error, description, openCors);
    const resource = form.get('resource');
    if (resource && resource.replace(/\/$/, '') !== this.config.resource) return fail('invalid_target', 'resource must be this server\'s MCP URL');
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? '';
      const key = digest(code);
      const entry = this.codes.get(key);
      this.codes.delete(key);
      if (!entry || entry.expires < Date.now() || entry.client_id !== client.client_id) return fail('invalid_grant', 'The authorization code is invalid or has expired');
      const redirectUri = form.get('redirect_uri');
      if (redirectUri !== undefined ? redirectUri !== entry.redirect_uri : client.redirect_uris.length > 1) return fail('invalid_grant', 'redirect_uri does not match the authorization request');
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(digest(verifier), entry.challenge)) return fail('invalid_grant', 'PKCE verification failed');
      const grant = { id: random(16), client_id: client.client_id, sub: entry.sub, scope: entry.scope, created_at: now(), expires_at: now() + this.config.refreshTtl };
      return this.issue(res, grant, client);
    }
    if (grantType === 'refresh_token') {
      if (!client.grant_types.includes('refresh_token')) return fail('unauthorized_client', 'This client did not register for refresh tokens');
      const hash = digest(form.get('refresh_token') ?? '');
      const grants = this.store.data.grants;
      const grant = Object.values(grants).find(g => same(g.refresh_hash, hash));
      const replayed = Object.values(grants).find(g => g.previous_hashes?.some(h => same(h, hash)));
      if (replayed) { delete grants[replayed.id]; await this.store.save(); return fail('invalid_grant', 'This refresh token was already used; the grant has been revoked. Sign in again.'); }
      if (!grant || grant.client_id !== client.client_id || grant.expires_at <= now()) return fail('invalid_grant', 'The refresh token is invalid or has expired');
      return this.issue(res, grant, client);
    }
    return fail('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  async issue(res, grant, client) {
    const refresh = random();
    if (grant.refresh_hash) grant.previous_hashes = [...(grant.previous_hashes ?? []), grant.refresh_hash].slice(-5);
    grant.refresh_hash = digest(refresh);
    grant.used_at = now();
    for (const [id, old] of Object.entries(this.store.data.grants)) if (old.expires_at <= now()) delete this.store.data.grants[id];
    const withRefresh = client.grant_types.includes('refresh_token');
    if (withRefresh) { this.store.data.grants[grant.id] = grant; }
    else this.store.data.grants[grant.id] = { ...grant, refresh_hash: digest(random()), expires_at: now() + this.config.accessTtl };
    await this.store.save();
    const issued = now();
    const access = signJwt({ iss: this.config.issuer, sub: grant.sub, aud: this.config.resource, client_id: client.client_id, scope: grant.scope, sid: grant.id, iat: issued, exp: issued + this.config.accessTtl, jti: random(16) }, this.key);
    sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: this.config.accessTtl, scope: grant.scope, ...(withRefresh ? { refresh_token: refresh } : {}) }, { ...noStore, ...openCors });
  }

  // RFC 7009. Revoking a refresh token ends its grant and the grant's access tokens.
  async revoke(req, res) {
    const form = await readForm(req);
    const client = this.authenticateClient(req, res, form);
    if (!client) return;
    const hash = digest(form.get('token') ?? '');
    const grant = Object.values(this.store.data.grants).find(g => g.client_id === client.client_id && same(g.refresh_hash, hash));
    if (grant) { delete this.store.data.grants[grant.id]; await this.store.save(); }
    res.writeHead(200, { ...noStore, ...openCors }); res.end();
  }

  pageHeaders() {
    return { ...noStore, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  }

  page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#161616}input{background:#222;color:#f2f2f2;border-color:#444}}
h1{font-size:1.3rem}label{display:block;margin:.8rem 0 .2rem}input{width:100%;box-sizing:border-box;padding:.55rem;font:inherit;border:1px solid #bbb;border-radius:6px}
.row{display:flex;gap:.6rem;margin-top:1.2rem}button{flex:1;padding:.6rem;font:inherit;border-radius:6px;border:1px solid #888;cursor:pointer}
button[value=approve]{background:#1d4ed8;color:#fff;border-color:#1d4ed8}.note{font-size:.9rem;opacity:.8}.error{color:#b91c1c}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  }

  loginPage(id, client, redirectUri, message) {
    const host = new URL(redirectUri).host;
    return this.page('Sign in to Poki MCP', `
<p><strong>${escapeHtml(client.client_name)}</strong> is asking to control the phone attached to this Poki server. After you sign in it is sent back to <strong>${escapeHtml(host)}</strong>.</p>
<p class="note">Only continue if you started this from your own MCP client.</p>
${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/authorize" autocomplete="on">
<input type="hidden" name="request_id" value="${escapeHtml(id)}">
<label for="username">Account</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<label for="totp">Authenticator code</label><input id="totp" name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
<div class="row"><button name="action" value="deny" formnovalidate>Deny</button><button name="action" value="approve">Allow</button></div>
</form>`);
  }
}
