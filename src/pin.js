import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

/**
 * PIN handling.
 *
 * A payment PIN is a 4–6 digit secret. We NEVER store it in plaintext — we
 * store a salted scrypt hash, and verify by re-hashing the attempt with the
 * same salt and comparing in constant time. This is the same shape as proper
 * password storage; a PIN is just a short password.
 */

const KEYLEN = 64;

/** Throw if `pin` isn't a 4–6 digit string. */
export function assertValidPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) {
    throw new ApiError(400, 'pin must be 4 to 6 digits');
  }
}

/** Hash a PIN for storage. Returns `scrypt$<saltHex>$<hashHex>`. */
export function hashPin(pin) {
  assertValidPin(pin);
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a PIN attempt against a stored hash. Never throws on mismatch. */
export function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
