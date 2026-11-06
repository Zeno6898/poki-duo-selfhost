// The Worker in workerd (Miniflare): a fake phone on the WebSocket, an MCP client over HTTP.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { base32 } from '../src/index.js';

const HOST = 'https://pokimcp.zheha.nz';
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64u = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  return { keys, raw, label: base32(raw) };
}

// A fake phone: connects, answers the challenge, and answers requests with `answer`.
async function phone(id, secrets, { answer, sign = id.keys.privateKey, label = id.label } = {}) {
  const response = await SELF.fetch(`${HOST}/v1/${label}/connect`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  ws.accept();
  const frames = [];
  const waiters = [];
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code)));
  ws.addEventListener('message', event => { void (async () => {
    if (event.data === 'pong') { frames.push({ t: 'pong' }); return; }
    const frame = JSON.parse(event.data);
    frames.push(frame);
    for (const w of waiters.splice(0)) w();
    if (frame.t === 'challenge') {
      const message = new Uint8Array([...enc.encode(`poki-relay-v1:${id.label}:`), ...Uint8Array.from(atob(frame.nonce), c => c.charCodeAt(0))]);
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, sign, message);
      const access = await Promise.all(secrets.map(async s => hex(await sha256(s))));
      ws.send(JSON.stringify({ t: 'hello', v: 1, key: b64(id.raw), sig: b64(sig), access, app: 'test' }));
    } else if (frame.t === 'req' && answer) {
      const reply = await answer(frame);
      if (reply) ws.send(JSON.stringify({ t: 'res', id: frame.id, ...reply }));
    }
  })(); });
  const next = async t => {
    for (let i = 0; i < 200; i += 1) {
      const found = frames.find(f => f.t === t && !f.seen);
      if (found) { found.seen = true; return found; }
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 20); });
    }
    return undefined;
  };
  return { ws, frames, next, closed };
}

const echo = async frame => ({ status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(frame.body).id, result: { echoed: frame.method, headers: frame.headers } }) });

// The OAuth flow a client like claude.ai runs, from the 401 onwards.
async function signIn(label, secret) {
  const base = `${HOST}/v1/${label}/${secret}`;
  const challenge = await SELF.fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  expect(challenge.status).toBe(401);
  const prmUrl = challenge.headers.get('WWW-Authenticate').match(/resource_metadata="([^"]+)"/)[1];
  const prm = await (await SELF.fetch(prmUrl)).json();
  expect(prm.resource).toBe(`${base}/mcp`);
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await (await SELF.fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json();
  expect(as.issuer).toBe(prm.authorization_servers[0]);
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  const client = await (await SELF.fetch(as.registration_endpoint, { method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json();
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: b64u(await sha256(verifier)), code_challenge_method: 'S256', state: 'xyz', resource: prm.resource, scope: 'poki' });
  const authorized = await SELF.fetch(`${as.authorization_endpoint}?${params}`, { redirect: 'manual' });
  return { as, client, verifier, prm, authorized };
}
async function tokens(as, client, verifier, code) {
  const response = await SELF.fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier, client_id: client.client_id }) });
  return { status: response.status, body: await response.json() };
}
const call = (url, token, body = { jsonrpc: '2.0', id: 7, method: 'tools/list' }, headers = {}) =>
  SELF.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', Cookie: 'c=1', ...headers }, body: JSON.stringify(body) });

async function connected(answer = echo) {
  const id = await identity();
  const secret = newSecret();
  const p = await phone(id, [secret], { answer });
  const ready = await p.next('ready');
  const { as, client, verifier, prm, authorized } = await signIn(id.label, secret);
  const code = new URL(authorized.headers.get('Location')).searchParams.get('code');
  const { body } = await tokens(as, client, verifier, code);
  return { id, secret, p, ready, token: body.access_token, refresh: body.refresh_token, mcp: prm.resource, as, client };
}

describe('phone connection', () => {
  it('answers the challenge with ready, and refuses a wrong key', async () => {
    const id = await identity();
    const p = await phone(id, [newSecret()]);
    const ready = await p.next('ready');
    expect(ready).toMatchObject({ t: 'ready', max_body: 4194304, req_timeout_ms: 1500 });
    p.ws.send('ping');
    expect(await p.next('pong')).toBeTruthy();
    const other = await identity();
    const forged = await phone(id, [], { sign: other.keys.privateKey });
    expect(await forged.closed).toBe(4401);
    expect(p.frames.some(f => f.t === 'ready')).toBe(true);
  });

  it('a newer connection replaces the older one', async () => {
    const id = await identity();
    const first = await phone(id, [newSecret()]);
    await first.next('ready');
    const second = await phone(id, [newSecret()]);
    await second.next('ready');
    expect(await first.closed).toBe(4000);
  });
});

describe('OAuth and MCP', () => {
  it('signs in with PKCE and relays a request with only the allowed headers', async () => {
    const c = await connected();
    expect(c.token).toBeTruthy();
    const response = await call(c.mcp, c.token);
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBe('s1');
    const body = await response.json();
    expect(body.id).toBe(7);
    expect(body.result.echoed).toBe('POST');
    expect(Object.keys(body.result.headers).sort()).toEqual(['accept', 'content-type', 'mcp-protocol-version']);
  });

  it('refreshes, and refuses a wrong verifier, a foreign redirect and a token for another secret', async () => {
    const c = await connected();
    const refreshed = await SELF.fetch(c.as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.client.client_id }) });
    expect(refreshed.status).toBe(200);
    expect((await call(c.mcp, (await refreshed.json()).access_token)).status).toBe(200);
    const again = await signIn(c.id.label, c.secret);
    const code = new URL(again.authorized.headers.get('Location')).searchParams.get('code');
    expect((await tokens(again.as, again.client, b64u(crypto.getRandomValues(new Uint8Array(32))), code)).status).toBe(400);
    const foreign = await SELF.fetch(again.as.registration_endpoint, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    expect(foreign.status).toBe(400);
    const otherSecret = newSecret();
    const elsewhere = c.mcp.replace(c.secret, otherSecret);
    expect((await call(elsewhere, c.token)).status).toBe(401);
  });

  it('an unknown secret is not found, and its authorization is denied', async () => {
    const c = await connected();
    const stranger = newSecret();
    const { authorized } = await signIn(c.id.label, stranger);
    expect(new URL(authorized.headers.get('Location')).searchParams.get('error')).toBe('access_denied');
  });

  it('says the phone is offline, times out, and caps body size and rate', async () => {
    const quiet = await connected(async () => undefined);
    const timedOut = await call(quiet.mcp, quiet.token);
    expect(timedOut.status).toBe(504);
    expect((await timedOut.json()).error.code).toBe(-32002);
    expect(await quiet.p.next('cancel')).toBeTruthy();

    const big = await call(quiet.mcp, quiet.token, { jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'x'.repeat(4_300_000) } });
    expect(big.status).toBe(413);

    quiet.p.ws.close(1000);
    await new Promise(resolve => setTimeout(resolve, 50));
    const offline = await call(quiet.mcp, quiet.token, { jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ jsonrpc: '2.0', id: 'a', error: { code: -32001 } });

    const busy = await connected();
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await call(busy.mcp, busy.token)).status);
    expect(statuses.slice(0, 30).every(s => s === 200)).toBe(true);
    const limited = await call(busy.mcp, busy.token, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe(-32003);
  });

  it('the access list can change on the live connection', async () => {
    const c = await connected();
    c.p.ws.send(JSON.stringify({ t: 'access', access: [] }));
    await c.p.next('ready');
    expect((await call(c.mcp, c.token)).status).toBe(404);
  });
});

describe('daily budget', () => {
  it('grants per label and in total, and stops at the caps', async () => {
    const budget = env.BUDGET.get(env.BUDGET.idFromName('test-budget'));
    expect(await budget.take('a', 25, 40, 60)).toBe(25);
    expect(await budget.take('a', 25, 40, 60)).toBe(15);
    expect(await budget.take('a', 25, 40, 60)).toBe(0);
    expect(await budget.take('b', 25, 40, 60)).toBe(20);
    expect(await budget.take('c', 25, 40, 60)).toBe(0);
    const seconds = env.BUDGET.get(env.BUDGET.idFromName('test-seconds'));
    expect(await seconds.take('a', 5, 100, 100, 50, 60)).toBe(5);
    expect(await seconds.take('a', 5, 100, 100, 20, 60)).toBe(0);
  });

  it('nothing but a WebSocket reaches /connect, and malformed paths are not found', async () => {
    const id = await identity();
    expect((await SELF.fetch(`${HOST}/v1/${id.label}/connect`)).status).toBe(426);
    expect((await SELF.fetch(`${HOST}/v1/nope/connect`)).status).toBe(404);
    expect((await SELF.fetch(`${HOST}/`)).status).toBe(404);
  });
});
