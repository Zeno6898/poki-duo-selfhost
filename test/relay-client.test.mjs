// The daemon's relay client against the in-process relay (deploy/relay) and a fake ACME server
// that validates TLS-ALPN-01 through the relay, as Let's Encrypt would.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { parseHello, relaySettings, startRelay } from '../src/relay-client.mjs';
import { thumbprint } from '../src/relay/acme.mjs';

const require = createRequire(import.meta.url);
const { createRelay } = require('../deploy/relay/relay.js');
const DOMAIN = 'relay.test';
const work = mkdtempSync(join(tmpdir(), 'poki-relay-client-'));
const quiet = () => {};

function openssl(...args) { execFileSync('openssl', args, { stdio: 'ignore' }); }
function certificate(name, subject, san, extra = []) {
  const key = join(work, `${name}.key`), cert = join(work, `${name}.crt`);
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${subject}`, '-addext', `subjectAltName=${san}`, ...extra);
  return { key: readFileSync(key), cert: readFileSync(cert), keyFile: key, certFile: cert };
}
const relaySide = certificate('relay-side', 'relay', 'IP:127.0.0.1');
const authority = certificate('fake-ca', 'Fake ACME CA', 'DNS:fake-ca.test', ['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);

async function startTestRelay(t) {
  const relay = createRelay({ domain: DOMAIN, helperTls: relaySide, publicPort: 0, helperPort: 0, host: '127.0.0.1' });
  const ports = await relay.listen();
  t.after(() => relay.close());
  return { relay, ports };
}

// A fake ACME server: checks every JWS, validates tls-alpn-01 by connecting through the relay,
// and signs the CSR with a throwaway CA.
async function startFakeAcme(t, relayPublicPort) {
  let base, accountJwk, hostname, token = 'tok-' + Date.now(), authz = 'pending', validations = 0;
  const nonce = () => String(Math.random()).slice(2);
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Replay-Nonce': nonce(), 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/directory') return send(200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` });
    if (req.url === '/nonce') return send(200, '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const jws = JSON.parse(raw);
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url'));
    const jwk = header.jwk ?? accountJwk;
    const ok = verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
    if (!ok || header.url !== `${base}${req.url}`) return send(400, { type: 'urn:ietf:params:acme:error:malformed' });
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url')) : undefined;
    switch (req.url) {
      case '/account':
        accountJwk = header.jwk;
        return send(201, { status: 'valid' }, { Location: `${base}/acct/1` });
      case '/order':
        hostname = payload.identifiers[0].value;
        return send(201, { status: 'pending', authorizations: [`${base}/authz`], finalize: `${base}/finalize` }, { Location: `${base}/order/1` });
      case '/authz':
        return send(200, { status: authz, challenges: [{ type: 'http-01', url: `${base}/nope`, token }, { type: 'tls-alpn-01', url: `${base}/chall`, token }] });
      case '/chall': {
        validations += 1;
        const expected = createHash('sha256').update(`${token}.${thumbprint(createPublicKey({ key: accountJwk, format: 'jwk' }))}`).digest();
        authz = await new Promise(resolve => {
          const socket = tls.connect({ host: '127.0.0.1', port: relayPublicPort, servername: hostname, ALPNProtocols: ['acme-tls/1'], rejectUnauthorized: false });
          socket.once('secureConnect', () => {
            const der = socket.getPeerX509Certificate().raw;
            // id-pe-acmeIdentifier (1.3.6.1.5.5.7.1.31) and the key authorization's digest.
            const acmeIdentifier = Buffer.from('06082b0601050507011f', 'hex');
            const good = socket.alpnProtocol === 'acme-tls/1' && der.includes(acmeIdentifier) && der.includes(expected);
            socket.destroy();
            resolve(good ? 'valid' : 'invalid');
          });
          socket.once('error', () => resolve('invalid'));
        });
        return send(200, { status: 'processing' });
      }
      case '/finalize': {
        const csr = join(work, 'request.der'), leaf = join(work, 'leaf.pem');
        writeFileSync(csr, Buffer.from(payload.csr, 'base64url'));
        openssl('req', '-inform', 'der', '-in', csr, '-out', `${csr}.pem`);
        openssl('x509', '-req', '-in', `${csr}.pem`, '-CA', authority.certFile, '-CAkey', authority.keyFile, '-days', '90', '-copy_extensions', 'copy', '-out', leaf);
        return send(200, { status: 'valid', certificate: `${base}/cert` });
      }
      case '/order/1':
        return send(200, { status: 'valid', certificate: `${base}/cert` });
      case '/cert':
        return send(200, readFileSync(join(work, 'leaf.pem'), 'utf8') + authority.cert.toString(), { 'Content-Type': 'application/pem-certificate-chain' });
      default:
        return send(404, {});
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return { directory: `${base}/directory`, validations: () => validations };
}

function daemonListener(t) {
  const listener = http.createServer((req, res) => res.end(`daemon saw ${req.headers.host} ${req.url}`));
  t.after(() => listener.close());
  return listener;
}

function get(port, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port, servername: hostname, headers: { host: hostname }, path: '/mcp', agent: false, ...options }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body, cert: res.socket.getPeerX509Certificate?.() }));
    });
    req.on('error', reject);
  });
}

async function until(check, ms = 15000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function env(stateDir, relayPort, directory) {
  writeFileSync(join(work, 'relay-ca.pem'), relaySide.cert);
  return { POKI_RELAY_URL: `127.0.0.1:${relayPort}`, POKI_RELAY_DOMAIN: DOMAIN, POKI_RELAY_CA: join(work, 'relay-ca.pem'), POKI_ACME_DIRECTORY: directory };
}

test('nothing happens without POKI_RELAY_URL', async () => {
  assert.equal(await relaySettings({}, mkdtempSync(join(work, 'state-'))), undefined);
});

test('the identity key makes the hostname, once, and the public URL must match it', async () => {
  const stateDir = mkdtempSync(join(work, 'state-'));
  const first = await relaySettings({ POKI_RELAY_URL: 'relay.example.com:8443' }, stateDir);
  assert.match(first.hostname, /^[a-z2-7]{52}\.relay\.example\.com$/);
  assert.equal(first.env.POKI_MCP_PUBLIC_URL, `https://${first.hostname}`);
  assert.equal(statSync(join(stateDir, 'relay/identity.key')).mode & 0o777, 0o600);
  const again = await relaySettings({ POKI_RELAY_URL: 'relay.example.com:8443' }, stateDir);
  assert.equal(again.hostname, first.hostname, 'the same key, the same hostname');
  await assert.rejects(relaySettings({ POKI_RELAY_URL: 'relay.example.com:8443', POKI_MCP_PUBLIC_URL: 'https://other.example' }, stateDir), /must be https:\/\//);
});

test('before ACME, the daemon answers through the relay with a self-signed certificate', async t => {
  const { ports } = await startTestRelay(t);
  const settings = await relaySettings(env(null, ports.helperPort, 'http://127.0.0.1:1/directory'), mkdtempSync(join(work, 'state-')));
  const relayed = await startRelay(settings, daemonListener(t), { log: quiet });
  t.after(() => relayed.close());
  assert.equal(relayed.status().registered, true);
  const answer = await get(ports.publicPort, settings.hostname, { rejectUnauthorized: false });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, `daemon saw ${settings.hostname} /mcp`);
  assert.equal(answer.cert.subject, `CN=${settings.hostname}`);
  assert.equal(answer.cert.issuer, answer.cert.subject, 'self-signed');
  assert.equal(relayed.status().certificate, 'self-signed');
});

test('ACME issues a certificate by TLS-ALPN-01 through the relay, and TLS ends in the daemon', async t => {
  const { ports, relay } = await startTestRelay(t);
  const acme = await startFakeAcme(t, ports.publicPort);
  const stateDir = mkdtempSync(join(work, 'state-'));
  const settings = await relaySettings(env(null, ports.helperPort, acme.directory), stateDir);
  const relayed = await startRelay(settings, daemonListener(t), { log: quiet, acmePollMs: 20 });
  t.after(() => relayed.close());
  await until(() => relayed.status().certificate === 'acme' || relayed.status().acme_error);
  assert.equal(relayed.status().acme_error, undefined);
  assert.equal(acme.validations(), 1);
  // A client that trusts only the CA gets through to the daemon, end to end.
  const answer = await get(ports.publicPort, settings.hostname, { ca: authority.cert });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, `daemon saw ${settings.hostname} /mcp`);
  assert.ok(new X509Certificate(answer.cert.raw).checkHost(settings.hostname));
  for (const file of ['cert.pem', 'key.pem', 'acme-account.key']) assert.equal(statSync(join(stateDir, 'relay', file)).mode & 0o777, 0o600);
  // The relay carried the streams but holds no key for the hostname.
  assert.ok(relay.counters.streams_opened >= 2);
  // A restart uses the saved certificate without asking ACME again.
  relayed.close();
  const restarted = await startRelay(settings, daemonListener(t), { log: quiet });
  t.after(() => restarted.close());
  assert.equal(restarted.status().certificate, 'acme');
});

test('the ClientHello parser finds the hostname and ALPN', async () => {
  const hello = await new Promise(resolve => {
    const server = http.createServer();
    server.on('connection', socket => socket.once('data', chunk => { resolve(chunk); socket.destroy(); server.close(); }));
    server.listen(0, '127.0.0.1', () => {
      tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'x.relay.test', ALPNProtocols: ['acme-tls/1'] }).on('error', () => {});
    });
  });
  assert.deepEqual(parseHello(hello), { name: 'x.relay.test', alpn: ['acme-tls/1'] });
});

test('the real daemon serves MCP with builtin OAuth at its relay hostname', { timeout: 60000 }, async t => {
  const { fixture } = await import('./fixture.mjs');
  const { hashPassword } = await import('../src/auth/password.mjs');
  const { generateSecret } = await import('../src/auth/totp.mjs');
  const { ports } = await startTestRelay(t);
  const account = join(mkdtempSync(join(work, 'account-')), 'account.json');
  writeFileSync(account, JSON.stringify({ username: 'owner', password_hash: await hashPassword('correct horse battery', { N: 1024, r: 8, p: 1 }), totp_secret: generateSecret() }), { mode: 0o600 });
  const relayEnv = { ...env(null, ports.helperPort, 'http://127.0.0.1:1/directory'), POKI_OAUTH: 'builtin', POKI_OAUTH_ACCOUNT_FILE: account };
  const f = await fixture(t, { extraEnv: () => relayEnv });
  // The same identity key, so the same hostname the daemon registered.
  const settings = await relaySettings(relayEnv, join(f.dir, 'state'));
  let challenge;
  for (let i = 0; i < 100 && !challenge; i += 1) {
    challenge = await new Promise(resolve => {
      const req = https.request({ host: '127.0.0.1', port: ports.publicPort, servername: settings.hostname, method: 'POST', path: '/mcp', rejectUnauthorized: false, agent: false, headers: { host: settings.hostname, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', () => setTimeout(() => resolve(undefined), 100));
      req.end('{}');
    });
  }
  assert.equal(challenge.statusCode, 401, 'OAuth guards /mcp through the relay');
  assert.match(challenge.headers['www-authenticate'], new RegExp(`resource_metadata="https://${settings.hostname}/\\.well-known/oauth-protected-resource/mcp"`));
});
