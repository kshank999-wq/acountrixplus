import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * What this application signs with (Phase 81).
 *
 * ## Three copies, and a fourth about to be written
 *
 * `auth/session`, `auth/challenge` and `auth/secret-box` each read a secret out
 * of the environment, each refuse in production when it is missing, and each
 * fall back to a fixed development value. `secret-box`'s own comment says so:
 *
 * > Same shape as `SESSION_SECRET` in `session.ts`.
 *
 * Phase 81 needed a fourth, to sign a tracking link's destination. Writing it
 * would have been the defect this codebase keeps removing, so the shape is
 * named once instead.
 *
 * ## Domain separation
 *
 * `challenge` already had the right idea — it signs with `${secret}:mfa-challenge`
 * rather than the bare secret, so a signature minted for one purpose cannot be
 * replayed as another. That is now the rule rather than one module's good
 * instinct, and `purpose` is required for everything except the session cookie.
 *
 * The session cookie signs with the **bare** secret, deliberately: it did
 * before this phase, and adding a suffix would invalidate every cookie
 * currently in a browser. A refactor is not a logout.
 *
 * `secret-box` is left alone. It reads `ENCRYPTION_KEY`, not `SESSION_SECRET`,
 * because an encryption key and a signing key should not be the same value —
 * that is a different secret with the same shape, and merging them would be
 * merging two things that only look alike.
 *
 * Nothing here touches the database or the clock.
 */

/** The development fallback, matching what `session.ts` has always used. */
const DEV_SECRET = 'dev-only-insecure-session-secret'

/**
 * The signing secret, separated by purpose.
 *
 * Omit `purpose` only for the session cookie, whose signatures predate this
 * function and must keep verifying.
 */
export function signingSecret(purpose?: string): string {
  const configured = process.env.SESSION_SECRET

  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production.')
  }

  const secret = configured ?? DEV_SECRET
  return purpose ? `${secret}:${purpose}` : secret
}

/** An HMAC over `payload`, in the encoding every caller here already used. */
export function sign(payload: string, purpose?: string): string {
  return createHmac('sha256', signingSecret(purpose)).update(payload).digest('base64url')
}

/**
 * Whether a signature is the one this application would have produced.
 *
 * Compared in constant time, and length-checked first because
 * `timingSafeEqual` throws on a mismatch — which would itself be a signal.
 */
export function signatureMatches(payload: string, provided: string, purpose?: string): boolean {
  const expected = Buffer.from(sign(payload, purpose))
  const given = Buffer.from(provided)

  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}
