#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Stands in for the Poki app on the relay (relay frames v1): keeps the WebSocket, answers MCP
// with a tiny server (initialize, tools/list, tools/call "echo"), and prints the connector URL.
//
//   node test/phone-sim.mjs https://pokimcp.zheha.nz            # run as a phone until Ctrl-C
//   node test/phone-sim.mjs https://pokimcp.zheha.nz --check    # also act as the MCP client:
//                                                               # OAuth + initialize + tools/call; exit 0 or 1
// The identity key and secret are kept in ./phone-sim.json (created on first run), so the
// connector URL stays the same between runs. Node 22+ (global WebSocket).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Every HTTP call gives up after 20 s, so --check fails instead of hanging behind a proxy that never answers.
const fetch = (url, options = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(20_000), ...options });
const origin = (process.argv[2] ?? '').replace(/\/$/, '');
const check = process.argv.includes('--check');
const stateFile = process.env.PHONE_SIM_STATE ?? 'phone-sim.json';
if (!/^https?:\/\//.test(origin)) {
  console.error('usage: node test/phone-sim.mjs <relay origin, e.g. https://pokimcp.zheha.nz> [--check]');
  process.exit(2);
}

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

// Identity and one connector secret, made once.
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined;
if (!state) {
  const { privateKey } = generateKeyPairSync('ed25519');
  state = { key: privateKey.export({ format: 'pem', type: 'pkcs8' }), secret: randomBytes(32).toString('base64url') };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
const privateKey = createPrivateKey(state.key);
const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const label = base32(raw);
const access = [createHash('sha256').update(state.secret).digest('hex')];
const connectorUrl = `${origin}/v1/${label}/${state.secret}/mcp`;

// A minimal MCP server, as PokiCore answers: application/json, one session id.
const session = randomBytes(8).toString('hex');
function mcp(request) {
  if (request.method !== 'POST') return { status: request.method === 'DELETE' ? 200 : 405, headers: {}, body: '' };
  const message = JSON.parse(request.body);
  const reply = result => ({ status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) });
  if (message.id === undefined) return { status: 202, headers: {}, body: '' };
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'phone-sim', version: '1' } });
    case 'tools/list':
      return reply({ tools: [{ name: 'echo', description: 'Echoes its text (phone simulator).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
    case 'tools/call':
      return reply({ content: [{ type: 'text', text: `phone-sim echo: ${message.params?.arguments?.text ?? ''}` }] });
    default:
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) };
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/${label}/connect`);
    let lastPong = Date.now();
    // Fail fast when the upgrade is refused (e.g. 401 from Cloudflare Access) or never answers.
    const handshake = setTimeout(() => { reject(new Error('no ready frame within 15 s')); ws.close(); }, 15_000);
    const keepalive = setInterval(() => {
      if (Date.now() - lastPong > 60_000) ws.close();
      else if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 25_000);
    ws.addEventListener('message', event => {
      if (event.data === 'pong') { lastPong = Date.now(); return; }
      const frame = JSON.parse(event.data);
      if (frame.t === 'challenge') {
        const signature = sign(null, Buffer.concat([Buffer.from(`poki-relay-v1:${label}:`), Buffer.from(frame.nonce, 'base64')]), privateKey);
        ws.send(JSON.stringify({ t: 'hello', v: 1, key: raw.toString('base64'), sig: signature.toString('base64'), access, app: 'phone-sim' }));
      } else if (frame.t === 'ready') {
        clearTimeout(handshake);
        resolve(ws);
      } else if (frame.t === 'req') {
        let answer;
        try { answer = mcp(frame); } catch (error) { answer = { status: 400, headers: {}, body: String(error.message) }; }
        ws.send(JSON.stringify({ t: 'res', id: frame.id, ...answer }));
      }
    });
    ws.addEventListener('close', event => {
      clearInterval(keepalive);
      clearTimeout(handshake);
      reject(new Error(`closed ${event.code} ${event.reason}`));
      if (!check) { console.error(`phone-sim: connection closed (${event.code}); reconnecting in 2 s`); setTimeout(() => connect().catch(() => {}), 2000); }
    });
    ws.addEventListener('error', event => { clearTimeout(handshake); reject(new Error(`connect failed: ${event.message ?? 'websocket error'}`)); });
  });
}

const b64u = buffer => Buffer.from(buffer).toString('base64url');
// Endpoints are fetched on the origin given (wrangler dev rewrites the Worker's own URLs to the
// route's hostname); against the live deployment this changes nothing.
const here = url => { const u = new URL(url); return `${origin}${u.pathname}${u.search}`; };
const samePath = (a, b) => new URL(a).pathname === new URL(b).pathname;
async function asClient() {
  const expect = (cond, what) => { if (!cond) throw new Error(`check failed: ${what}`); console.log(`ok  ${what}`); };
  const first = await fetch(connectorUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  expect(first.status === 401, `unauthenticated MCP request gets 401 (got ${first.status})`);
  const prmUrl = first.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1];
  const prm = await (await fetch(here(prmUrl))).json();
  expect(samePath(prm.resource, connectorUrl), 'protected resource metadata names the connector URL');
  const issuer = new URL(prm.authorization_servers[0]);
  const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json();
  expect(as.issuer === prm.authorization_servers[0], 'authorization server metadata');
  const redirect = 'http://127.0.0.1:9/callback';
  const client = await (await fetch(here(as.registration_endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'phone-sim check', redirect_uris: [redirect] }) })).json();
  expect(Boolean(client.client_id), 'dynamic client registration');
  const verifier = b64u(randomBytes(32));
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 's', resource: prm.resource, scope: 'poki' });
  const authorized = await fetch(`${here(as.authorization_endpoint)}?${params}`, { redirect: 'manual' });
  const code = new URL(authorized.headers.get('location') ?? 'http://x/').searchParams.get('code');
  expect(authorized.status === 302 && code, 'authorize grants a code (the phone knows the secret)');
  const tokens = await (await fetch(here(as.token_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: client.client_id }) })).json();
  expect(Boolean(tokens.access_token), 'token exchange with PKCE');
  const call = async body => {
    const started = Date.now();
    const response = await fetch(connectorUrl, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json(), ms: Date.now() - started };
  };
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } });
  expect(init.status === 200 && init.json.result?.serverInfo?.name === 'phone-sim', `initialize through the relay (${init.ms} ms)`);
  const echo = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } });
  expect(echo.json.result?.content?.[0]?.text === 'phone-sim echo: hello', `tools/call round trip (${echo.ms} ms)`);
}

const ws = await connect().catch(error => { console.error(`phone-sim: ${error.message}`); process.exit(1); });
console.log(`phone-sim: connected as ${label}`);
console.log(`connector URL: ${connectorUrl}`);
if (check) {
  try {
    await asClient();
    console.log('all checks passed');
    ws.close(1000);
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    ws.close(1000);
    process.exit(1);
  }
}
