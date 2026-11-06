// RFC 6238 time-based one-time passwords: SHA-1, 6 digits, 30-second steps, as authenticator apps expect.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('TOTP secret is not base32.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret() { return base32Encode(randomBytes(20)); }

export function totpAt(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export const counterAt = (now = Date.now()) => Math.floor(now / 30000);

// Returns the matching counter (to refuse a replay of it later), or undefined. Accepts one step of clock drift.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, after = -Infinity } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return undefined;
  const given = Buffer.from(code.trim());
  const current = counterAt(now);
  for (let counter = current - window; counter <= current + window; counter++) {
    if (counter <= after) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, counter)), given)) return counter;
  }
  return undefined;
}

export function otpauthUri(secret, account, issuer = 'Poki MCP') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
