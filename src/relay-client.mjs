// The daemon's side of the blind relay (deploy/relay): with POKI_RELAY_URL set, the daemon
// registers <label>.<domain> at the relay (label = base32 of its Ed25519 identity key, which
// stays in <stateDir>/relay/identity.key), takes each relayed stream and ends its TLS here, so
// the relay only ever carries ciphertext. The certificate comes from ACME by TLS-ALPN-01 through
// the same relay (Let's Encrypt staging unless POKI_ACME_DIRECTORY says otherwise); until one
// exists a self-signed certificate is served. Without POKI_RELAY_URL nothing here runs.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { AcmeClient, letsEncryptStaging } from './relay/acme.mjs';
import { newKey, pemOf, selfSigned } from './relay/x509.mjs';

const PROOF_CONTEXT = 'poki-relay-v1';
const RENEW_BEFORE_MS = 30 * 86400_000;
const MAX_HELLO_BYTES = 16 * 1024 + 5;

/** RFC 4648 base32, lowercase, no padding: the relay's hostname label for a raw public key. */
export function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bitCount = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) { out += alphabet[(value >>> (bitCount - 5)) & 31]; bitCount -= 5; }
  }
  if (bitCount > 0) out += alphabet[(value << (5 - bitCount)) & 31];
  return out;
}

/** The server_name and ALPN protocols of a ClientHello: {need} | {error} | {name, alpn}. */
export function parseHello(buf) {
  if (buf.length < 5) return { need: true };
  if (buf[0] !== 0x16) return { error: 'not TLS' };
  const recordLength = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLength) return { need: true };
  const hello = buf.subarray(5, 5 + recordLength);
  const found = { name: null, alpn: [] };
  try {
    if (hello[0] !== 0x01) return { error: 'not a ClientHello' };
    let at = 4 + 2 + 32;
    at += 1 + hello[at];
    at += 2 + hello.readUInt16BE(at);
    at += 1 + hello[at];
    if (at >= hello.length) return found;
    const end = at + 2 + hello.readUInt16BE(at);
    at += 2;
    while (at + 4 <= end) {
      const type = hello.readUInt16BE(at), size = hello.readUInt16BE(at + 2);
      const body = hello.subarray(at + 4, at + 4 + size);
      if (type === 0 && body.length > 5 && body[2] === 0) found.name = body.subarray(5, 5 + body.readUInt16BE(3)).toString('ascii').toLowerCase();
      if (type === 16) {
        for (let p = 2; p < body.length; p += 1 + body[p]) found.alpn.push(body.subarray(p + 1, p + 1 + body[p]).toString('ascii'));
      }
      at += 4 + size;
    }
    return found;
  } catch {
    return { error: 'malformed ClientHello' };
  }
}

async function writePrivate(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

/**
 * The relay settings from the environment, or undefined when POKI_RELAY_URL is not set. Makes
 * the identity key on first use. `env` is the environment with POKI_MCP_PUBLIC_URL set to the
 * relay hostname, for remoteConfig.
 */
export async function relaySettings(env, stateDir) {
  const value = env.POKI_RELAY_URL?.trim();
  if (!value) return undefined;
  let url;
  try { url = new URL(/^[a-z]+:\/\//.test(value) ? value : `tls://${value}`); } catch { throw new Error('POKI_RELAY_URL must be host:port, such as relay.example.com:8443'); }
  const relayHost = url.hostname;
  const relayPort = Number(url.port || 8443);
  const domain = (env.POKI_RELAY_DOMAIN?.trim() || relayHost).toLowerCase().replace(/^\.|\.$/g, '');
  const dir = join(stateDir, 'relay');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const identityFile = join(dir, 'identity.key');
  let privateKey;
  try {
    privateKey = createPrivateKey(await readFile(identityFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${identityFile}: ${error.message}`);
    ({ privateKey } = generateKeyPairSync('ed25519'));
    await writePrivate(identityFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${identityFile} must be an Ed25519 key`);
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const label = base32(raw);
  const hostname = `${label}.${domain}`;
  const publicUrl = `https://${hostname}`;
  if (env.POKI_MCP_PUBLIC_URL && env.POKI_MCP_PUBLIC_URL.replace(/\/$/, '') !== publicUrl) {
    throw new Error(`POKI_MCP_PUBLIC_URL must be ${publicUrl} (the relay hostname of ${identityFile}), or unset`);
  }
  return {
    env: { ...env, POKI_MCP_PUBLIC_URL: publicUrl },
    relayHost, relayPort, domain, label, hostname, publicUrl, dir, raw, privateKey,
    ca: env.POKI_RELAY_CA ? await readFile(env.POKI_RELAY_CA) : undefined,
    acmeDirectory: env.POKI_ACME_DIRECTORY?.trim() || letsEncryptStaging,
    acmeContact: env.POKI_ACME_EMAIL?.trim() || undefined,
  };
}

/**
 * Connects to the relay and serves its streams into `listener` (the daemon's http.Server) over
 * TLS that ends here. Resolves once registered with {hostname, close(), status()}.
 */
export async function startRelay(settings, listener, { log = message => console.error(`poki relay: ${message}`), fetch: fetchImpl, acmePollMs } = {}) {
  const { hostname, dir } = settings;
  const certFile = join(dir, 'cert.pem'), keyFile = join(dir, 'key.pem');
  let certificate; // {context, validTo, source}
  let challenge; // tls.SecureContext for acme-tls/1
  let control;
  let stopped = false;
  let renewTimer;
  const status = { hostname, registered: false, streams: 0, certificate: 'none', acme_error: undefined };

  function use(key, cert, source) {
    const x509 = new X509Certificate(cert);
    certificate = { context: tls.createSecureContext({ key, cert }), validTo: new Date(x509.validTo).getTime(), source };
    status.certificate = source;
    status.certificate_valid_to = x509.validTo;
  }
  try {
    const [cert, key] = await Promise.all([readFile(certFile, 'utf8'), readFile(keyFile, 'utf8')]);
    const x509 = new X509Certificate(cert);
    if (x509.checkHost(hostname) && new Date(x509.validTo).getTime() > Date.now()) use(key, cert, 'acme');
  } catch { /* no certificate yet */ }
  if (!certificate) {
    const key = newKey();
    use(key.privateKey.export({ format: 'pem', type: 'pkcs8' }), selfSigned(key, hostname), 'self-signed');
  }

  function serve(stream) {
    status.streams += 1;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => stream.destroy(), 10_000);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const hello = buffered.length > MAX_HELLO_BYTES ? { error: 'too long' } : parseHello(buffered);
      if (hello.need) return;
      stream.off('data', onData);
      stream.pause();
      clearTimeout(timer);
      if (hello.error || (hello.name && hello.name !== hostname)) { stream.destroy(); return; }
      const acme = hello.alpn.includes('acme-tls/1');
      if (acme && !challenge) { stream.destroy(); return; }
      stream.unshift(buffered);
      const socket = new tls.TLSSocket(stream, {
        isServer: true,
        secureContext: acme ? challenge : certificate.context,
        ALPNProtocols: acme ? ['acme-tls/1'] : ['http/1.1'],
      });
      socket.on('error', () => socket.destroy());
      if (acme) {
        // The validation needs only the handshake.
        socket.once('secure', () => setTimeout(() => socket.end(), 1000).unref());
        return;
      }
      socket.once('secure', () => listener.emit('connection', socket));
    };
    stream.on('data', onData);
    stream.on('error', () => stream.destroy());
  }

  const dial = () => tls.connect({ host: settings.relayHost, port: settings.relayPort, ...(isIP(settings.relayHost) ? {} : { servername: settings.relayHost }), ...(settings.ca ? { ca: settings.ca } : {}) });

  function connect() {
    return new Promise((resolve, reject) => {
      const socket = dial();
      control = socket;
      let pending = '';
      let ready = false;
      socket.setEncoding('utf8');
      socket.setKeepAlive(true, 30_000);
      socket.on('error', error => { if (!ready) reject(error); });
      socket.on('close', () => {
        status.registered = false;
        if (!ready) reject(new Error('the relay closed the connection'));
        else if (!stopped) reconnect(1000);
      });
      socket.once('secureConnect', () => socket.write(`${JSON.stringify({ t: 'hello', key: settings.raw.toString('base64') })}\n`));
      socket.on('data', text => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          let message;
          try { message = JSON.parse(pending.slice(0, newline)); } catch { socket.destroy(); return; }
          pending = pending.slice(newline + 1);
          if (message.t === 'challenge') {
            const proof = Buffer.concat([Buffer.from(`${PROOF_CONTEXT}:${settings.label}:`), Buffer.from(message.nonce, 'base64')]);
            socket.write(`${JSON.stringify({ t: 'proof', sig: sign(null, proof, settings.privateKey).toString('base64') })}\n`);
          } else if (message.t === 'ready') {
            if (message.hostname !== hostname) { socket.destroy(); reject(new Error(`the relay gave ${message.hostname}, expected ${hostname}`)); return; }
            ready = true;
            status.registered = true;
            // ACME validates through the relay, so it starts once registered.
            if (!renewTimer) scheduleRenewal(0);
            resolve();
          } else if (message.t === 'open' && typeof message.id === 'string') {
            const stream = dial();
            stream.once('secureConnect', () => { stream.write(`${JSON.stringify({ t: 'stream', id: message.id })}\n`); serve(stream); });
            stream.on('error', () => stream.destroy());
          } else if (message.t === 'error') {
            reject(new Error(`relay: ${message.error}`));
          }
        }
      });
    });
  }

  function reconnect(delay) {
    if (stopped) return;
    setTimeout(() => {
      connect().then(() => log('registered again')).catch(error => {
        log(`cannot reach the relay (${error.message}); retrying`);
        reconnect(Math.min(delay * 2, 60_000));
      });
    }, delay).unref();
  }

  async function renew() {
    if (stopped) return;
    if (certificate.source === 'acme' && certificate.validTo - Date.now() > RENEW_BEFORE_MS) return;
    const accountFile = join(dir, 'acme-account.key');
    let accountKey;
    try {
      const privateKey = createPrivateKey(await readFile(accountFile));
      accountKey = { privateKey, publicKey: createPublicKey(privateKey) };
    } catch {
      accountKey = newKey();
      await writePrivate(accountFile, accountKey.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    }
    const client = new AcmeClient({ directory: settings.acmeDirectory, accountKey, contact: settings.acmeContact, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(acmePollMs ? { pollMs: acmePollMs } : {}) });
    const { key, chain } = await client.issue(hostname, {
      present: (_token, keyAuthorization) => {
        const challengeKey = newKey();
        challenge = tls.createSecureContext({
          key: challengeKey.privateKey.export({ format: 'pem', type: 'pkcs8' }),
          cert: selfSigned(challengeKey, hostname, { days: 1, acmeKeyAuthorization: keyAuthorization }),
        });
      },
      clear: () => { challenge = undefined; },
    });
    const keyPem = key.privateKey.export({ format: 'pem', type: 'pkcs8' });
    await writePrivate(keyFile, keyPem);
    await writePrivate(certFile, chain);
    use(keyPem, chain, 'acme');
    status.acme_error = undefined;
    log(`certificate for ${hostname} until ${status.certificate_valid_to}`);
  }

  function scheduleRenewal(delay) {
    if (stopped) return;
    renewTimer = setTimeout(() => {
      renew().then(() => scheduleRenewal(12 * 3600_000)).catch(error => {
        status.acme_error = error.message;
        log(`ACME failed: ${error.message}; retrying in an hour`);
        scheduleRenewal(3600_000);
      });
    }, delay);
    renewTimer.unref();
  }

  // Not reachable now: the daemon starts anyway and keeps trying.
  await connect().then(
    () => log(`registered ${settings.publicUrl}`),
    error => { log(`cannot reach the relay (${error.message}); retrying`); reconnect(1000); },
  );
  return {
    hostname,
    status: () => ({ ...status }),
    renew,
    close() {
      stopped = true;
      clearTimeout(renewTimer);
      control?.destroy();
    },
  };
}

export { pemOf };
