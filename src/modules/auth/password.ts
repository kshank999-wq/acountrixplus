import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
import { promisify } from 'node:util'

/**
 * `promisify` resolves to scrypt's no-options overload, so the cost parameters
 * would be dropped silently. The explicit signature keeps them.
 */
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Password hashing with scrypt (Node's built-in memory-hard KDF).
 *
 * Stored format: `scrypt$N$r$p$<salt-hex>$<hash-hex>`. The parameters live in
 * the stored string so they can be raised later without invalidating existing
 * hashes — verification reads whatever each row was written with.
 */
const KEY_LENGTH = 64
const PARAMS = { N: 16384, r: 8, p: 1 } as const

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }

  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS)

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$')
}

/**
 * Verifies a password against a stored hash. Returns false rather than
 * throwing on a malformed hash, and always compares in constant time so the
 * comparison itself leaks nothing.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, n, r, p, saltHex, hashHex] = parts
  const params = { N: Number(n), r: Number(r), p: Number(p) }
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    return false
  }

  const expected = Buffer.from(hashHex, 'hex')

  let derived: Buffer
  try {
    derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, params)
  } catch {
    return false
  }

  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}
