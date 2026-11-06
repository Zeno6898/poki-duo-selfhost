// Compact JWS for access tokens: signing with Ed25519 (the built-in server) and verification
// against a JWKS (the built-in key, or an external authorization server's keys).
import { createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify, createHash } from 'node:crypto';

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const algorithms = {
  EdDSA: { kty: ['OKP'], hash: null },
  ES256: { kty: ['EC'], hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { kty: ['EC'], hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  RS256: { kty: ['RSA'], hash: 'sha256' },
  PS256: { kty: ['RSA'], hash: 'sha256', padding: 6, saltLength: 32 },
};

export class JwtError extends Error { name = 'JwtError'; }

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { ...jwk, kid: thumbprint(jwk), alg: 'EdDSA', use: 'sig' };
}

// RFC 7638 thumbprint for OKP keys.
export function thumbprint(jwk) {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
}

export function publicJwk(privateJwk) {
  const { d, ...rest } = privateJwk;
  return rest;
}

export function signJwt(claims, privateJwk, type = 'at+jwt') {
  const header = { alg: 'EdDSA', typ: type, kid: privateJwk.kid };
  const input = `${b64(header)}.${b64(claims)}`;
  const { kid, alg, use, ...keyData } = privateJwk;
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: keyData, format: 'jwk' }));
  return `${input}.${signature.toString('base64url')}`;
}

export function decodeJwt(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new JwtError('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new JwtError('Malformed token');
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), input: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch { throw new JwtError('Malformed token'); }
}

// keys: array of public JWKs. Checks signature, iss, aud, exp, nbf. Returns the claims.
export function verifyJwt(token, { keys, issuer, audience, now = Date.now() / 1000, leeway = 30, allowedAlgorithms = Object.keys(algorithms) }) {
  const { header, claims, input, signature } = decodeJwt(token);
  const spec = algorithms[header.alg];
  if (!spec || !allowedAlgorithms.includes(header.alg)) throw new JwtError(`Token algorithm ${header.alg} is not accepted`);
  if (header.crit) throw new JwtError('Token has unsupported critical headers');
  const candidates = keys.filter(k => (!header.kid || k.kid === header.kid) && spec.kty.includes(k.kty) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
  if (candidates.length === 0) throw Object.assign(new JwtError('No signing key matches the token'), { unknownKey: true });
  const valid = candidates.some(jwk => {
    const { kid, alg, use, key_ops, x5c, x5t, ...keyData } = jwk;
    let key;
    try { key = createPublicKey({ key: keyData, format: 'jwk' }); } catch { return false; }
    const options = { key, ...(spec.dsaEncoding ? { dsaEncoding: spec.dsaEncoding } : {}), ...(spec.padding ? { padding: spec.padding, saltLength: spec.saltLength } : {}) };
    try { return verify(spec.hash, Buffer.from(input), options, signature); } catch { return false; }
  });
  if (!valid) throw new JwtError('Token signature is invalid');
  if (typeof claims !== 'object' || claims === null) throw new JwtError('Token claims are invalid');
  if (claims.iss !== issuer) throw new JwtError('Token issuer is not accepted');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw new JwtError('Token audience is not this server');
  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) throw new JwtError('Token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > now) throw new JwtError('Token is not valid yet');
  if (typeof claims.iat === 'number' && claims.iat - leeway > now) throw new JwtError('Token was issued in the future');
  return claims;
}
