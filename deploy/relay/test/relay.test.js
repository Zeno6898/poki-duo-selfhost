// SPDX-License-Identifier: AGPL-3.0-or-later
// Relay + fake helper + fake client in one process: bytes pass unmodified, the relay never has
// the helper's key nor sees plaintext, unknown hostnames and bad proofs are refused, and ALPN
// (acme-tls/1, for TLS-ALPN-01) passes through.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tls = require('node:tls');
const { createRelay, parseSni, labelFor } = require('../relay.js');
const { connectHelper, generateIdentity, rawPublicKey } = require('../helper.js');

const DOMAIN = 'relay.test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poki-relay-'));

function certificate(name, altName) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${altName}`,
    '-addext', `subjectAltName=DNS:${altName}`,
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function setup(t, { observe } = {}) {
  const relayTls = certificate('relay', 'relay-side.test');
  const relay = createRelay({
    domain: DOMAIN,
    helperTls: relayTls,
    publicPort: 0,
    helperPort: 0,
    host: '127.0.0.1',
    observe,
  });
  const ports = await relay.listen();
  t.after(() => relay.close());
  const identity = generateIdentity();
  const hostname = `${labelFor(rawPublicKey(identity.publicKey))}.${DOMAIN}`;
  const helperTls = certificate('helper', hostname);
  // The helper's own TLS server: it alone holds the key for its hostname. It echoes.
  const helperServer = tls.createServer(
    { key: helperTls.key, cert: helperTls.cert, ALPNProtocols: ['acme-tls/1', 'http/1.1'] },
    (socket) => socket.pipe(socket),
  );
  const helper = await connectHelper({
    relayHost: '127.0.0.1',
    relayPort: ports.helperPort,
    relayServername: 'relay-side.test',
    tls: { ca: relayTls.cert },
    ...identity,
    onStream: (socket) => helperServer.emit('connection', socket),
  });
  t.after(() => helper.close());
  return { relay, ports, relayTls, helperTls, hostname, helper, identity };
}

function client(port, servername, ca, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca, ...extra });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed before TLS')));
  });
}

function echo(socket, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= payload.length) resolve(Buffer.concat(chunks));
    });
    socket.on('error', reject);
    socket.write(payload);
  });
}

test('bytes pass unmodified and the relay sees only ciphertext', async (t) => {
  const seen = [];
  const s = await setup(t, { observe: (_, chunk) => seen.push(Buffer.from(chunk)) });
  assert.equal(s.helper.hostname, s.hostname);
  const marker = Buffer.from('PLAINTEXT-MARKER-poki-relay-0123456789');
  const payload = Buffer.concat([marker, crypto.randomBytes(1 << 20), marker]);
  const socket = await client(s.ports.publicPort, s.hostname, s.helperTls.cert);
  const back = await echo(socket, payload);
  socket.destroy();
  assert.ok(back.equals(payload), 'echoed bytes are the bytes sent');
  // The TLS session ended at the helper: the certificate the client saw is the helper's.
  const relayed = Buffer.concat(seen);
  assert.ok(relayed.length > payload.length * 2, 'both directions went through the relay');
  assert.equal(relayed.indexOf(marker), -1, 'the relay never saw the plaintext');
  // The relay holds no key for the helper's hostname: none of its state contains it.
  const helperKey = s.helperTls.key.toString();
  const identityKey = s.identity.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const state = JSON.stringify({ counters: s.relay.counters }) + s.relayTls.key.toString();
  assert.ok(!state.includes(helperKey) && !state.includes(identityKey));
  assert.ok(s.relay.counters.streams_opened >= 1);
  assert.ok(s.relay.counters.bytes_to_helpers >= payload.length);
});

test('parallel streams stay apart', async (t) => {
  const s = await setup(t);
  const payloads = Array.from({ length: 8 }, () => crypto.randomBytes(64 * 1024));
  const results = await Promise.all(
    payloads.map(async (payload) => {
      const socket = await client(s.ports.publicPort, s.hostname, s.helperTls.cert);
      const back = await echo(socket, payload);
      socket.destroy();
      return back.equals(payload);
    }),
  );
  assert.deepEqual(results, payloads.map(() => true));
  assert.equal(s.relay.counters.streams_opened, 8);
});

test('ALPN passes through (TLS-ALPN-01 is just another stream)', async (t) => {
  const s = await setup(t);
  const socket = await client(s.ports.publicPort, s.hostname, s.helperTls.cert, {
    ALPNProtocols: ['acme-tls/1'],
  });
  assert.equal(socket.alpnProtocol, 'acme-tls/1');
  socket.destroy();
});

test('an unknown hostname is closed', async (t) => {
  const s = await setup(t);
  await assert.rejects(client(s.ports.publicPort, `${'a'.repeat(52)}.${DOMAIN}`, s.helperTls.cert));
  await assert.rejects(client(s.ports.publicPort, 'other.example', s.helperTls.cert));
  assert.equal(s.relay.counters.unknown_hostname, 2);
});

test('a hostname claim without the key is refused', async (t) => {
  const s = await setup(t);
  const thief = generateIdentity();
  await assert.rejects(
    connectHelper({
      relayHost: '127.0.0.1',
      relayPort: s.ports.helperPort,
      relayServername: 'relay-side.test',
      tls: { ca: s.relayTls.cert },
      publicKey: s.identity.publicKey, // claims the victim's hostname
      privateKey: thief.privateKey, // but cannot sign for it
      onStream: () => assert.fail('no stream for an impostor'),
    }),
  );
  assert.equal(s.relay.counters.auth_failures, 1);
});

test('the SNI parser reads a real ClientHello', async () => {
  const captured = await new Promise((resolve) => {
    const server = require('node:net').createServer((socket) => {
      socket.once('data', (chunk) => {
        resolve(chunk);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const socket = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: 'abc.relay.test' });
      socket.on('error', () => {});
    });
  });
  assert.deepEqual(parseSni(captured), { name: 'abc.relay.test' });
  assert.deepEqual(parseSni(captured.subarray(0, 10)), { need: true });
  assert.ok(parseSni(Buffer.from('GET / HTTP/1.1\r\n')).error);
});
