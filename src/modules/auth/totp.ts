import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords, RFC 6238 (spec §14: "MFA support").
 *
 * ## Why this is written out rather than imported
 *
 * TOTP is about sixty lines and the whole of it is testable against the
 * published RFC vectors, which is what the tests do. A dependency here would
 * be a dependency in the authentication path — the one place in this codebase
 * where a supply-chain problem is worst — in exchange for saving those sixty
 * lines. `node:crypto` does the part that actually needs to be right.
 *
 * ## The parts that are easy to get wrong
 *
 * - **The counter is time ÷ 30, floored** — not the time. Off-by-one here
 *   produces codes that work for the implementer and fail for everyone in a
 *   different second.
 * - **Comparison must be constant-time.** A `===` on the code leaks, through
 *   timing, how many leading digits were right, which turns 10^6 guesses into
 *   about 60.
 * - **The drift window has to be small and symmetric.** ±1 step accepts a
 *   clock 30 seconds out either way. Wider is a common "fix" for support
 *   tickets and it multiplies the guessing surface.
 * - **A used code must not work twice** — see `verifyTotp`'s `afterStep`.
 */

/** Seconds per code. Fixed at 30 because every authenticator app assumes it. */
export const TOTP_STEP_SECONDS = 30

/** Digits in a code. */
export const TOTP_DIGITS = 6

/**
 * How many steps either side of now are accepted.
 *
 * One step means a clock up to 30 seconds out still works. It also means an
 * attacker guessing blind has three valid codes rather than one — 3 in 10^6
 * per attempt, which the lockout in `login-history.ts` is what actually
 * bounds.
 */
export const TOTP_DRIFT_STEPS = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Base32 without padding, the encoding every authenticator app expects.
 *
 * Not base64: the secret gets typed by hand when a camera will not focus on
 * the QR code, and base32 has no case sensitivity and no characters that look
 * like each other.
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''

  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(encoded: string): Buffer {
  // Spaces are stripped because apps display the secret in groups of four and
  // people paste what they see.
  const cleaned = encoded.toUpperCase().replace(/[\s=]/g, '')

  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index === -1) throw new Error('That is not a valid secret.')

    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

/**
 * A fresh secret.
 *
 * 20 bytes is what RFC 4226 recommends and what HMAC-SHA1's block structure
 * makes the natural size; it encodes to 32 base32 characters.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The counter for a moment in time. Exported because the tests need to pin it. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS)
}

/**
 * The code for a given counter value.
 *
 * The dynamic-truncation dance at the end is RFC 4226 §5.4: the low nibble of
 * the last byte picks where in the digest to read four bytes from, and the top
 * bit is masked off so the result is positive on platforms with signed 32-bit
 * integers.
 */
export function totpCodeForStep(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32)

  const counter = Buffer.alloc(8)
  // Written as two 32-bit halves: `writeBigUInt64BE` would need a BigInt, and
  // the step fits in 32 bits until the year 6053.
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0)
  counter.writeUInt32BE(step >>> 0, 4)

  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The code valid right now. */
export function totpCode(secretBase32: string, atMs: number): string {
  return totpCodeForStep(secretBase32, totpStep(atMs))
}

export type TotpResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'malformed' | 'incorrect' | 'already_used' }

/**
 * Checks a code, and says which step it matched.
 *
 * `afterStep` is the caller's record of the last step this user successfully
 * used, and codes at or before it are refused. Without it a code remains
 * usable for its whole 30-second window and a little longer with drift — so
 * anyone who reads it over a shoulder, or off a phishing page a second after
 * the victim typed it, can sign in with it too. Returning the matched step is
 * what lets the caller store it.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number,
  afterStep?: number | null,
): TotpResult {
  const cleaned = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, reason: 'malformed' }

  const current = totpStep(atMs)

  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset++) {
    const step = current + offset
    if (!constantTimeEquals(cleaned, totpCodeForStep(secretBase32, step))) continue

    // Matched, but possibly a code that has already been spent.
    if (afterStep !== null && afterStep !== undefined && step <= afterStep) {
      return { ok: false, reason: 'already_used' }
    }
    return { ok: true, step }
  }

  return { ok: false, reason: 'incorrect' }
}

/**
 * The URI an authenticator app scans.
 *
 * The issuer appears twice — once in the label prefix and once as a parameter
 * — because apps disagree about which they read, and one that reads neither
 * shows an entry called "user@example.com" with no clue which service it is
 * for.
 */
export function otpauthUri(opts: {
  secretBase32: string
  accountName: string
  issuer: string
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`)
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })

  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Compares two strings without leaking where they first differ.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so the lengths are checked first and a mismatch returns before the
 * comparison. Code length is not a secret — every code is six digits.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
