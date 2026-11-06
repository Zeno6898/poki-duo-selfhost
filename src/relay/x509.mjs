// Just enough DER to make the certificates the relay client needs with node:crypto alone: a
// self-signed certificate (the stand-in until ACME issues one, and the TLS-ALPN-01 challenge
// certificate, RFC 8737) and a PKCS#10 request for ACME's finalize. Keys are ECDSA P-256.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
const octets = bytes => tlv(0x04, bytes);
const bits = bytes => tlv(0x03, Buffer.from([0]), bytes);
const bool = value => tlv(0x01, Buffer.from([value ? 0xff : 0]));
function integer(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function utcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${s}Z`));
}

const ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2'));
const name = cn => sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const extension = (id, critical, value) => sequence(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const subjectAltName = names => extension('2.5.29.17', false, sequence(...names.map(n => tlv(0x82, Buffer.from(n)))));

/** A new ECDSA P-256 key pair. */
export function newKey() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function pem(label, der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/**
 * A self-signed certificate for `hostname` as PEM. `acmeKeyAuthorization` makes it the
 * TLS-ALPN-01 challenge certificate (the critical id-pe-acmeIdentifier extension, RFC 8737).
 */
export function selfSigned({ privateKey, publicKey }, hostname, { days = 7, acmeKeyAuthorization } = {}) {
  const now = Date.now();
  const extensions = [subjectAltName([hostname])];
  if (acmeKeyAuthorization !== undefined) {
    const digest = createHash('sha256').update(acmeKeyAuthorization).digest();
    extensions.push(extension('1.3.6.1.5.5.7.1.31', true, octets(digest)));
  }
  const tbs = sequence(
    explicit(0, integer([2])),
    integer(randomBytes(16)),
    ecdsaSha256,
    name(hostname),
    sequence(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + days * 86400_000))),
    name(hostname),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(...extensions)),
  );
  return pem('CERTIFICATE', sequence(tbs, ecdsaSha256, bits(sign('sha256', tbs, privateKey))));
}

/** A PKCS#10 certificate request for `hostname`, DER. */
export function certificateRequest({ privateKey, publicKey }, hostname) {
  const info = sequence(
    integer([0]),
    name(hostname),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa0, sequence(oid('1.2.840.113549.1.9.14'), set(sequence(subjectAltName([hostname]))))),
  );
  return sequence(info, ecdsaSha256, bits(sign('sha256', info, privateKey)));
}

export const pemOf = pem;
