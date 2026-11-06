// scrypt password hashes in the form scrypt$N$r$p$salt$hash (salt and hash base64url).
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const defaults = { N: 32768, r: 8, p: 1 };

export async function hashPassword(password, { N, r, p } = defaults) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(parts[4], 'base64url'), expected.length, { N, r, p, maxmem: 256 * N * r });
  return expected.length > 0 && timingSafeEqual(actual, expected);
}
