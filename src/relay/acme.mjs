// A small ACME (RFC 8555) client for one hostname, validated by TLS-ALPN-01 (RFC 8737), with
// node:crypto only. `present(token, keyAuthorization)` must make the TLS listener answer
// ALPN acme-tls/1 for the hostname with the challenge certificate until `clear()`.
import { createHash, sign } from 'node:crypto';
import { certificateRequest, newKey } from './x509.mjs';

export const letsEncryptStaging = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const b64u = data => Buffer.from(data).toString('base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The RFC 7638 thumbprint of an EC P-256 public key. */
export function thumbprint(publicKey) {
  const { crv, kty, x, y } = publicKey.export({ format: 'jwk' });
  return b64u(createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
}

export class AcmeClient {
  constructor({ directory = letsEncryptStaging, accountKey, contact, fetch: fetchImpl = fetch, pollMs = 1000 }) {
    Object.assign(this, { directoryUrl: directory, accountKey, contact, fetch: fetchImpl, pollMs });
    this.nonce = undefined;
    this.kid = undefined;
  }

  async directory() {
    this.dir ??= await (await this.fetch(this.directoryUrl)).json();
    return this.dir;
  }

  async newNonce() {
    const response = await this.fetch((await this.directory()).newNonce, { method: 'HEAD' });
    return response.headers.get('replay-nonce');
  }

  // A signed POST; `payload` undefined is POST-as-GET.
  async post(url, payload, { retry = true, accept } = {}) {
    const nonce = this.nonce ?? await this.newNonce();
    this.nonce = undefined;
    const header = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk() }) };
    const protectedHeader = b64u(JSON.stringify(header));
    const body = payload === undefined ? '' : b64u(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${protectedHeader}.${body}`), { key: this.accountKey.privateKey, dsaEncoding: 'ieee-p1363' });
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json', ...(accept ? { Accept: accept } : {}) },
      body: JSON.stringify({ protected: protectedHeader, payload: body, signature: b64u(signature) }),
    });
    this.nonce = response.headers.get('replay-nonce') ?? undefined;
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      if (retry && problem.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, { retry: false, accept });
      throw new Error(`ACME ${url}: ${response.status} ${problem.type ?? ''} ${problem.detail ?? ''}`.trim());
    }
    return response;
  }

  jwk() {
    const { crv, kty, x, y } = this.accountKey.publicKey.export({ format: 'jwk' });
    return { crv, kty, x, y };
  }

  async account() {
    if (this.kid) return this.kid;
    const payload = { termsOfServiceAgreed: true, ...(this.contact ? { contact: [`mailto:${this.contact}`] } : {}) };
    const response = await this.post((await this.directory()).newAccount, payload);
    this.kid = response.headers.get('location');
    return this.kid;
  }

  async poll(url, done) {
    for (let i = 0; i < 120; i += 1) {
      const body = await (await this.post(url)).json();
      if (done(body)) return body;
      if (body.status === 'invalid') throw new Error(`ACME ${url} invalid: ${JSON.stringify(body.error ?? body.challenges?.find(c => c.error)?.error ?? {})}`);
      await sleep(this.pollMs);
    }
    throw new Error(`ACME ${url}: timed out`);
  }

  /**
   * A certificate for `hostname`: {key (a new P-256 pair), chain (PEM)}. `present` and `clear`
   * put up and take down the TLS-ALPN-01 answer.
   */
  async issue(hostname, { present, clear }) {
    await this.account();
    const created = await this.post((await this.directory()).newOrder, { identifiers: [{ type: 'dns', value: hostname }] });
    const orderUrl = created.headers.get('location');
    let order = await created.json();
    for (const authorizationUrl of order.authorizations) {
      const authorization = await (await this.post(authorizationUrl)).json();
      if (authorization.status === 'valid') continue;
      const challenge = authorization.challenges.find(c => c.type === 'tls-alpn-01');
      if (!challenge) throw new Error('ACME: the server offers no tls-alpn-01 challenge');
      present(challenge.token, `${challenge.token}.${thumbprint(this.accountKey.publicKey)}`);
      try {
        await this.post(challenge.url, {});
        await this.poll(authorizationUrl, body => body.status === 'valid');
      } finally {
        clear();
      }
    }
    const key = newKey();
    order = await (await this.post(order.finalize, { csr: b64u(certificateRequest(key, hostname)) })).json();
    if (order.status !== 'valid') order = await this.poll(orderUrl, body => body.status === 'valid');
    const chain = await (await this.post(order.certificate, undefined, { accept: 'application/pem-certificate-chain' })).text();
    return { key, chain };
  }
}
