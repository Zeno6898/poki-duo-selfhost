// SPDX-License-Identifier: AGPL-3.0-or-later
// Blind relay: routes public TLS connections to helpers by SNI without terminating them.
//
// Public side (:443): reads the ClientHello's server_name, finds the helper registered for that
// hostname and pipes the raw bytes both ways. The TLS session is between the client and the
// helper; the relay holds no key for it and sees only ciphertext.
//
// Helper side (:8443, TLS with the relay's own certificate): a helper proves it owns an Ed25519
// key by signing a nonce; its hostname is the base32 of that public key under the relay's
// domain. For each public connection the relay sends {"t":"open","id"} on the helper's control
// connection, and the helper dials a new connection that starts with {"t":"stream","id"}.
// Control messages are JSON lines. Payloads are never logged; only counters are kept.
'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const PROOF_CONTEXT = 'poki-relay-v1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_HELLO_BYTES = 16 * 1024 + 5;
const MAX_LINE_BYTES = 4096;

/** RFC 4648 base32, lowercase, no padding (a DNS label: 52 characters for 32 bytes). */
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** The hostname label for a raw 32-byte Ed25519 public key. */
function labelFor(rawPublicKey) {
  return base32(rawPublicKey);
}

/** What a helper signs to prove it owns its key. */
function proofMessage(nonce, label) {
  return Buffer.concat([Buffer.from(`${PROOF_CONTEXT}:${label}:`), nonce]);
}

/**
 * The server_name of a TLS ClientHello in `buf`.
 * Returns {need: true} while more bytes are needed, {name} (null when there is none), or
 * {error} when the bytes are not a ClientHello.
 */
function parseSni(buf) {
  if (buf.length < 5) return { need: true };
  if (buf[0] !== 0x16) return { error: 'not a TLS handshake' };
  const recordLength = buf.readUInt16BE(3);
  if (recordLength > 16384 + 2048) return { error: 'record too long' };
  if (buf.length < 5 + recordLength) return { need: true };
  const hello = buf.subarray(5, 5 + recordLength);
  try {
    let at = 0;
    if (hello[at] !== 0x01) return { error: 'not a ClientHello' };
    const helloLength = hello.readUIntBE(1, 3);
    if (helloLength + 4 > hello.length) return { error: 'ClientHello spans records' };
    at = 4 + 2 + 32; // type, length, version, random
    at += 1 + hello[at]; // session id
    at += 2 + hello.readUInt16BE(at); // cipher suites
    at += 1 + hello[at]; // compression methods
    if (at === 4 + helloLength) return { name: null };
    const extensionsEnd = at + 2 + hello.readUInt16BE(at);
    at += 2;
    while (at + 4 <= extensionsEnd) {
      const type = hello.readUInt16BE(at);
      const length = hello.readUInt16BE(at + 2);
      at += 4;
      if (type === 0) {
        let p = at + 2; // server name list length
        const end = at + length;
        while (p + 3 <= end) {
          const kind = hello[p];
          const nameLength = hello.readUInt16BE(p + 1);
          p += 3;
          if (kind === 0) return { name: hello.subarray(p, p + nameLength).toString('ascii') };
          p += nameLength;
        }
        return { name: null };
      }
      at += length;
    }
    return { name: null };
  } catch {
    return { error: 'malformed ClientHello' };
  }
}

/** Reads JSON lines from a socket until `onLine` returns false; the rest goes to `onRest`. */
function readLines(socket, onLine, onRest) {
  let pending = Buffer.alloc(0);
  const onData = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > MAX_LINE_BYTES) socket.destroy();
        return;
      }
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (onLine(message) === false) {
        socket.off('data', onData);
        socket.pause();
        onRest(pending);
        return;
      }
    }
  };
  socket.on('data', onData);
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * A relay. Options: domain (helpers get <label>.<domain>), helperTls {key, cert} (the relay's
 * own certificate for the helper side), publicPort, helperPort, host, helloTimeoutMs,
 * streamTimeoutMs. `observe(direction, chunk)` is a test hook that sees relayed bytes.
 */
function createRelay(options) {
  const domain = options.domain.toLowerCase().replace(/^\.|\.$/g, '');
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const streamTimeoutMs = options.streamTimeoutMs ?? 10_000;
  const observe = options.observe;
  const helpers = new Map(); // label -> control socket
  const waiting = new Map(); // stream id -> {socket, hello, timer}
  const counters = {
    public_connections: 0,
    unknown_hostname: 0,
    bad_hello: 0,
    streams_opened: 0,
    streams_failed: 0,
    streams_active: 0,
    bytes_to_helpers: 0,
    bytes_to_clients: 0,
    helpers_registered: 0,
    helpers_connected: 0,
    auth_failures: 0,
  };

  function pipe(client, helper, hello) {
    counters.streams_opened += 1;
    counters.streams_active += 1;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      counters.streams_active -= 1;
      client.destroy();
      helper.destroy();
    };
    for (const s of [client, helper]) {
      s.on('error', end);
      s.on('close', end);
      s.setKeepAlive(true, 30_000);
    }
    client.on('data', (chunk) => {
      counters.bytes_to_helpers += chunk.length;
      observe?.('to_helper', chunk);
    });
    helper.on('data', (chunk) => {
      counters.bytes_to_clients += chunk.length;
      observe?.('to_client', chunk);
    });
    counters.bytes_to_helpers += hello.length;
    observe?.('to_helper', hello);
    helper.write(hello);
    client.pipe(helper);
    helper.pipe(client);
    client.resume();
    helper.resume();
  }

  // Public side: route by SNI, never terminate.
  const publicServer = net.createServer((client) => {
    counters.public_connections += 1;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), helloTimeoutMs);
    client.on('error', () => client.destroy());
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HELLO_BYTES) {
        counters.bad_hello += 1;
        client.destroy();
        return;
      }
      const sni = parseSni(buffered);
      if (sni.need) return;
      client.off('data', onData);
      client.pause();
      clearTimeout(timer);
      if (sni.error || !sni.name) {
        counters.bad_hello += 1;
        client.destroy();
        return;
      }
      const name = sni.name.toLowerCase().replace(/\.$/, '');
      const label = name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : null;
      const control = label && !label.includes('.') ? helpers.get(label) : undefined;
      if (!control) {
        counters.unknown_hostname += 1;
        client.destroy();
        return;
      }
      const id = crypto.randomBytes(16).toString('base64url');
      const wait = setTimeout(() => {
        waiting.delete(id);
        counters.streams_failed += 1;
        client.destroy();
      }, streamTimeoutMs);
      waiting.set(id, { socket: client, hello: buffered, timer: wait, label });
      client.once('close', () => {
        if (waiting.get(id)?.socket === client) {
          clearTimeout(wait);
          waiting.delete(id);
        }
      });
      send(control, { t: 'open', id });
    };
    client.on('data', onData);
  });

  // Helper side: registration (hello, challenge, proof) or a stream for an open.
  const helperServer = tls.createServer(
    { key: options.helperTls.key, cert: options.helperTls.cert, minVersion: 'TLSv1.2' },
    (socket) => {
      socket.on('error', () => socket.destroy());
      const timer = setTimeout(() => socket.destroy(), helloTimeoutMs);
      let state = 'first';
      let nonce;
      let publicKey;
      let label;
      readLines(
        socket,
        (message) => {
          if (state === 'first' && message.t === 'stream') {
            clearTimeout(timer);
            const entry = waiting.get(message.id);
            if (!entry) {
              socket.destroy();
              return false;
            }
            waiting.delete(message.id);
            clearTimeout(entry.timer);
            state = 'stream';
            socket._relayEntry = entry;
            return false;
          }
          if (state === 'first' && message.t === 'hello') {
            const raw = Buffer.from(String(message.key ?? ''), 'base64');
            if (raw.length !== 32) {
              counters.auth_failures += 1;
              socket.destroy();
              return false;
            }
            publicKey = crypto.createPublicKey({
              key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
              format: 'der',
              type: 'spki',
            });
            label = labelFor(raw);
            nonce = crypto.randomBytes(32);
            state = 'challenged';
            send(socket, { t: 'challenge', nonce: nonce.toString('base64') });
            return true;
          }
          if (state === 'challenged' && message.t === 'proof') {
            const signature = Buffer.from(String(message.sig ?? ''), 'base64');
            let valid = false;
            try {
              valid = crypto.verify(null, proofMessage(nonce, label), publicKey, signature);
            } catch {
              valid = false;
            }
            if (!valid) {
              counters.auth_failures += 1;
              send(socket, { t: 'error', error: 'proof failed' });
              socket.destroy();
              return false;
            }
            clearTimeout(timer);
            state = 'ready';
            const previous = helpers.get(label);
            if (previous && previous !== socket) previous.destroy();
            helpers.set(label, socket);
            counters.helpers_registered += 1;
            counters.helpers_connected = helpers.size;
            socket.setKeepAlive(true, 30_000);
            socket.on('close', () => {
              if (helpers.get(label) === socket) helpers.delete(label);
              counters.helpers_connected = helpers.size;
            });
            send(socket, { t: 'ready', hostname: `${label}.${domain}` });
            return true;
          }
          if (state === 'ready' && message.t === 'ping') {
            send(socket, { t: 'pong' });
            return true;
          }
          socket.destroy();
          return false;
        },
        (rest) => {
          const entry = socket._relayEntry;
          if (!entry) return;
          if (rest.length) socket.unshift(rest);
          pipe(entry.socket, socket, entry.hello);
        },
      );
    },
  );

  return {
    counters,
    publicServer,
    helperServer,
    async listen() {
      const host = options.host ?? '0.0.0.0';
      await new Promise((resolve) => publicServer.listen(options.publicPort ?? 443, host, resolve));
      await new Promise((resolve) => helperServer.listen(options.helperPort ?? 8443, host, resolve));
      return { publicPort: publicServer.address().port, helperPort: helperServer.address().port };
    },
    async close() {
      for (const socket of helpers.values()) socket.destroy();
      for (const entry of waiting.values()) entry.socket.destroy();
      await Promise.all(
        [publicServer, helperServer].map((server) => new Promise((resolve) => server.close(resolve))),
      );
    },
  };
}

module.exports = { createRelay, parseSni, labelFor, base32, proofMessage, PROOF_CONTEXT };

if (require.main === module) {
  const fs = require('node:fs');
  const env = process.env;
  const relay = createRelay({
    domain: env.RELAY_DOMAIN ?? 'relay.invalid',
    helperTls: {
      key: fs.readFileSync(env.RELAY_HELPER_KEY ?? '/certs/helper-side.key'),
      cert: fs.readFileSync(env.RELAY_HELPER_CERT ?? '/certs/helper-side.crt'),
    },
    publicPort: Number(env.RELAY_PUBLIC_PORT ?? 443),
    helperPort: Number(env.RELAY_HELPER_PORT ?? 8443),
    host: env.RELAY_HOST,
  });
  relay.listen().then((ports) => {
    console.log(`relay: public :${ports.publicPort}, helpers :${ports.helperPort}, domain ${env.RELAY_DOMAIN}`);
  });
  // Counters only, never payloads.
  setInterval(() => console.log(`relay: ${JSON.stringify(relay.counters)}`), 60_000).unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => relay.close().then(() => process.exit(0)));
}
