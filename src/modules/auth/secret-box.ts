import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Authenticated encryption for secrets held in the database (spec §19:
 * "encryption in transit and at rest; server-side secret management").
 *
 * ## What this is for, and what it is not
 *
 * A TOTP secret is password-equivalent: anyone holding it can generate valid
 * codes forever. Unlike a password it cannot be hashed, because the server has
 * to reproduce codes from it — so it is encrypted instead, with a key that
 * lives in the environment rather than in the database.
 *
 * That distinction is the whole value. A database dump — a leaked backup, a
 * SQL injection, a misconfigured replica — yields ciphertext, and the key was
 * never in it. It is **not** protection against an attacker who already runs
 * code on the server, and nothing at this layer could be.
 *
 * ## Why GCM and not CBC
 *
 * GCM authenticates as well as encrypts, so a modified ciphertext fails to
 * decrypt rather than producing plausible garbage. With CBC an attacker who
 * can write to the database can flip bits in the plaintext, and the failure
 * mode is a TOTP secret that quietly becomes a different TOTP secret.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version
 * prefix is there so a future key rotation or algorithm change can be told
 * apart from existing rows rather than guessed at by length.
 */

const VERSION = 'v1'
const IV_BYTES = 12 // 96 bits, the size GCM is specified for
const KEY_BYTES = 32

/**
 * The encryption key.
 *
 * Same shape as `SESSION_SECRET` in `session.ts`: a development fallback so
 * local setup has no ceremony, and a hard refusal in production. A predictable
 * key is the same as no key.
 *
 * Hashed to 32 bytes rather than requiring an exactly-32-byte value, so the
 * environment variable can be any passphrase. This is not a password-hashing
 * problem — the input is a high-entropy secret from `openssl rand`, not
 * something a person chose — so a single SHA-256 is the right tool and a KDF
 * would only add cost.
 */
function encryptionKey(): Buffer {
  const configured = process.env.ENCRYPTION_KEY

  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENCRYPTION_KEY must be set in production. Generate one with: openssl rand -base64 32',
      )
    }
    return createHash('sha256').update('dev-only-insecure-encryption-key').digest()
  }

  return createHash('sha256').update(configured).digest().subarray(0, KEY_BYTES)
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

/**
 * Decrypts, or throws.
 *
 * Throwing rather than returning null on purpose: every caller here is about
 * to make an authentication decision, and a null that gets treated as "no MFA
 * configured" would turn a corrupted row into an open door.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored secret is not in a form this version can read.')
  }

  const [, ivPart, tagPart, ciphertextPart] = parts

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** True when a value looks like something `decryptSecret` could read. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split('.').length === 4
}
