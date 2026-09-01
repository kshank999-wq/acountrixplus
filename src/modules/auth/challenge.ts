import { sign, signatureMatches } from '@/lib/signing'

/**
 * The token that carries "this password was correct" from the first sign-in
 * step to the second (spec §14).
 *
 * ## Why this is not a session
 *
 * The obvious shortcut is to create the session after the password and mark it
 * "half signed in", then upgrade it once the code arrives. That puts a real
 * session cookie in the browser of somebody who has not finished
 * authenticating, and every subsequent check has to remember to ask whether
 * this particular session is the pretend kind. One place that forgets is a
 * full sign-in with a password alone.
 *
 * So the intermediate state is not a session at all. It is a signed assertion
 * that grants exactly one thing: the right to present a second factor. It
 * cannot be exchanged for anything else, and nothing in the application reads
 * it except `completeChallenge`.
 *
 * ## What it is bound to
 *
 * - **A short expiry.** Five minutes is long enough to find a phone and short
 *   enough that a token left in a browser history is worthless.
 * - **The password hash.** Changing the password invalidates every outstanding
 *   challenge — which is what somebody who has just realised their password
 *   was stolen is trying to achieve.
 *
 * It is deliberately **not** bound to an IP address. A phone that switches
 * from wifi to cellular between the two steps would fail, and the people that
 * hurts are the ones doing everything right.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000

export const CHALLENGE_COOKIE = 'accountrix_mfa_challenge'

/**
 * This module's slice of the signing secret.
 *
 * The `:mfa-challenge` suffix was this file's own good instinct and is the
 * rule everywhere since Phase 81 — `signingSecret` applies it, so the derived
 * value is byte-for-byte what it was.
 */
const PURPOSE = 'mfa-challenge'

/**
 * A fingerprint of the password hash, rather than the hash itself.
 *
 * The token goes to the browser, and a password hash — even a scrypt one — is
 * not something to hand out. Eight bytes of HMAC is plenty to notice a change
 * and useless for anything else.
 */
function passwordBinding(passwordHash: string): string {
  return sign(passwordHash, PURPOSE).slice(0, 11)
}

export function issueChallenge(opts: {
  userId: string
  passwordHash: string
  now?: Date
}): string {
  const expiresAt = (opts.now?.getTime() ?? Date.now()) + CHALLENGE_TTL_MS
  const payload = [opts.userId, String(expiresAt), passwordBinding(opts.passwordHash)].join('.')
  const signature = sign(payload, PURPOSE)

  return `${payload}.${signature}`
}

export type ChallengeToken = { userId: string; expiresAt: number }

/**
 * Reads a token, or returns null.
 *
 * Null for every failure — tampered, expired, or issued against a password
 * that has since changed. The caller cannot tell which, and does not need to:
 * all three mean "start again".
 */
export function readChallenge(
  token: string | undefined,
  opts: { passwordHash: string; now?: Date },
): ChallengeToken | null {
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [userId, expiresAtRaw, binding, signature] = parts
  const payload = [userId, expiresAtRaw, binding].join('.')

  if (!signatureMatches(payload, signature, PURPOSE)) return null

  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt)) return null
  if (expiresAt <= (opts.now?.getTime() ?? Date.now())) return null

  // Checked after the signature, so a forged token is rejected as a forgery
  // rather than reaching a comparison against a real user's password.
  if (binding !== passwordBinding(opts.passwordHash)) return null

  return { userId, expiresAt }
}

/**
 * The user a token names, without validating it.
 *
 * Needed because the password hash cannot be looked up until the user is
 * known, and the signature cannot be checked without the hash. The value is
 * used for that lookup and for nothing else — `readChallenge` is what decides
 * whether the token is real.
 */
export function challengeSubject(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  return parts.length === 4 ? parts[0] : null
}

export function challengeCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
  }
}
