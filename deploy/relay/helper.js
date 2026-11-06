// SPDX-License-Identifier: AGPL-3.0-only
// The helper side of the blind relay: registers a hostname by proving an Ed25519 key and hands
// each relayed stream (raw TLS from a public client) to `onStream`, which terminates TLS with
// the helper's own certificate (for example `tlsServer.emit('connection', socket)`).
'use strict';

const crypto = require('node:crypto');
const tls = require('node:tls');
const { labelFor, proofMessage } = require('./relay.js');

/** A new Ed25519 key pair; keep the private key with the user. */
function generateIdentity() {
  return crypto.generateKeyPairSync('ed25519');
}

/** The raw 32-byte public key of an Ed25519 KeyObject. */
function rawPublicKey(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

/**
 * Connects to a relay. Options: relayHost, relayPort, tls (extra tls.connect options for the
 * relay's own certificate, e.g. {ca}), privateKey, publicKey, onStream(socket).
 * Resolves with {hostname, close()} once registered.
 */
function connectHelper(options) {
  const raw = rawPublicKey(options.publicKey);
  const label = labelFor(raw);
  const dial = () =>
    tls.connect({
      host: options.relayHost,
      port: options.relayPort,
      servername: options.relayServername ?? options.relayHost,
      ...options.tls,
    });
  return new Promise((resolve, reject) => {
    const control = dial();
    let pending = '';
    let ready = false;
    control.setEncoding('utf8');
    control.on('error', (error) => (ready ? undefined : reject(error)));
    control.on('close', () => (ready ? options.onClose?.() : reject(new Error('relay closed'))));
    control.once('secureConnect', () => {
      control.write(`${JSON.stringify({ t: 'hello', key: raw.toString('base64') })}\n`);
    });
    control.on('data', (text) => {
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (message.t === 'challenge') {
          const signature = crypto.sign(
            null,
            proofMessage(Buffer.from(message.nonce, 'base64'), label),
            options.privateKey,
          );
          control.write(`${JSON.stringify({ t: 'proof', sig: signature.toString('base64') })}\n`);
        } else if (message.t === 'ready') {
          ready = true;
          resolve({ hostname: message.hostname, close: () => control.destroy() });
        } else if (message.t === 'open') {
          const stream = dial();
          stream.once('secureConnect', () => {
            stream.write(`${JSON.stringify({ t: 'stream', id: message.id })}\n`);
            options.onStream(stream);
          });
          stream.on('error', () => stream.destroy());
        } else if (message.t === 'error') {
          reject(new Error(message.error));
        }
      }
    });
  });
}

module.exports = { connectHelper, generateIdentity, rawPublicKey };
