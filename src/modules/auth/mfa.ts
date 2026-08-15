import { randomBytes } from 'node:crypto'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@/db'
import { mfaRecoveryCodes, sessions, userMfa, users } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import type { ActorContext } from '@/modules/tenancy/context'
import { hashPassword, verifyPassword } from './password'
import { decryptSecret, encryptSecret } from './secret-box'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp'

/**
 * Second-factor enrolment and verification (spec §14: "MFA support").
 *
 * ## Enrolment is two steps, and that is the important part
 *
 * `beginEnrollment` generates a secret and stores it **unconfirmed**.
 * `confirmEnrollment` turns it on, and only after a code generated from that
 * secret has been checked.
 *
 * Enabling on generation would be one fewer round trip and would lock out
 * everybody who scanned the wrong QR code, mistyped the secret, or has a phone
 * whose clock is wrong — and they find out at their next sign-in, from the
 * outside, with no way back in. The confirmation step is not ceremony; it is
 * the only proof that the thing which will be demanded tomorrow works today.
 *
 * ## Recovery codes exist because phones are lost
 *
 * Ten single-use codes, shown exactly once, hashed the way passwords are. Any
 * MFA implementation without them is one dropped phone away from a support
 * process that consists of turning MFA off for whoever asks — which is worse
 * than not having had it.
 */

const RECOVERY_CODE_COUNT = 10

export type MfaStatus = {
  enrolled: boolean
  confirmedAt: Date | null
  recoveryCodesRemaining: number
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)

  if (!row?.confirmedAt) {
    return { enrolled: false, confirmedAt: null, recoveryCodesRemaining: 0 }
  }

  const remaining = await db
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))

  return {
    enrolled: true,
    confirmedAt: row.confirmedAt,
    recoveryCodesRemaining: remaining.length,
  }
}

/** Whether this user must present a second factor to sign in. */
export async function hasConfirmedMfa(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ confirmedAt: userMfa.confirmedAt })
    .from(userMfa)
    .where(eq(userMfa.userId, userId))
    .limit(1)

  return row?.confirmedAt !== null && row?.confirmedAt !== undefined
}

export type EnrollmentStart = {
  /** Shown for manual entry when a camera will not focus. */
  secret: string
  /** What the authenticator app scans. */
  otpauthUri: string
}

/**
 * Starts enrolment, replacing any unconfirmed attempt.
 *
 * Replacing rather than reusing matters: somebody who abandoned an enrolment
 * halfway and comes back a week later expects a fresh QR code, and the app on
 * their phone may already hold the abandoned one under the same label.
 *
 * A **confirmed** enrolment is not replaced — `resetMfa` is the deliberate
 * path for that, so a stray click cannot silently swap out a working factor.
 */
export async function beginEnrollment(
  userId: string,
  opts: { issuer?: string } = {},
): Promise<EnrollmentStart> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw new Error('User not found')

  const [existing] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)
  if (existing?.confirmedAt) {
    throw new Error(
      'Two-factor authentication is already switched on. Turn it off first to enrol a new device.',
    )
  }

  const secret = generateTotpSecret()
  const secretEncrypted = encryptSecret(secret)

  if (existing) {
    await db
      .update(userMfa)
      .set({ secretEncrypted, lastUsedStep: null, updatedAt: new Date() })
      .where(eq(userMfa.id, existing.id))
  } else {
    await db.insert(userMfa).values({ userId, secretEncrypted })
  }

  return {
    secret,
    otpauthUri: otpauthUri({
      secretBase32: secret,
      accountName: user.email,
      issuer: opts.issuer ?? 'Accountrix Plus',
    }),
  }
}

export type ConfirmResult = { ok: true; recoveryCodes: string[] } | { ok: false; error: string }

/**
 * Turns MFA on, given a code from the secret just issued.
 *
 * Returns the recovery codes, once. They are hashed on the way in and there is
 * no way to read them back — which is the point, and which is why the UI has
 * to make the person acknowledge that they have them.
 */
export async function confirmEnrollment(
  userId: string,
  code: string,
  opts: { now?: Date } = {},
): Promise<ConfirmResult> {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)

  if (!row) return { ok: false, error: 'Start setting up two-factor authentication first.' }
  if (row.confirmedAt) return { ok: false, error: 'Two-factor authentication is already on.' }

  const now = opts.now ?? new Date()
  const result = verifyTotp(decryptSecret(row.secretEncrypted), code, now.getTime(), null)

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'malformed'
          ? 'An authentication code is six digits.'
          : 'That code did not match. Check your phone’s clock is set automatically, then try the next one.',
    }
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())

  await db.transaction(async (tx) => {
    await tx
      .update(userMfa)
      .set({ confirmedAt: now, lastUsedStep: result.step, updatedAt: now })
      .where(eq(userMfa.id, row.id))

    // Any codes from a previous enrolment are gone with it. Leaving them would
    // mean an old printout still opened the account.
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))

    for (const plain of codes) {
      await tx.insert(mfaRecoveryCodes).values({ userId, codeHash: await hashPassword(plain) })
    }
  })

  return { ok: true, recoveryCodes: codes }
}

export type ChallengeResult =
  | { ok: true; usedRecoveryCode: boolean }
  | { ok: false; reason: 'not_enrolled' | 'incorrect' | 'already_used' }

/**
 * Checks a code at sign-in. Accepts a TOTP code or an unused recovery code.
 *
 * The TOTP step is recorded on success, so the same code cannot be presented
 * again — see `verifyTotp` for why that is not paranoia.
 */
export async function verifyChallenge(
  userId: string,
  code: string,
  opts: { now?: Date } = {},
): Promise<ChallengeResult> {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)
  if (!row?.confirmedAt) return { ok: false, reason: 'not_enrolled' }

  const now = opts.now ?? new Date()
  const result = verifyTotp(
    decryptSecret(row.secretEncrypted),
    code,
    now.getTime(),
    row.lastUsedStep,
  )

  if (result.ok) {
    await db
      .update(userMfa)
      .set({ lastUsedStep: result.step, updatedAt: now })
      .where(eq(userMfa.id, row.id))

    return { ok: true, usedRecoveryCode: false }
  }

  if (result.reason === 'already_used') return { ok: false, reason: 'already_used' }

  // Not a TOTP code — it may be a recovery code, which is a different shape.
  if (await consumeRecoveryCode(userId, code, now)) {
    return { ok: true, usedRecoveryCode: true }
  }

  return { ok: false, reason: 'incorrect' }
}

/**
 * Spends a recovery code if it matches an unused one.
 *
 * Every unused code is checked rather than looked up, because they are hashed
 * with a per-code salt and there is nothing to look up by. Ten scrypt
 * verifications is deliberate work on a path an attacker can drive, which is
 * what the lockout is for; the alternative — a searchable hash — would make
 * the stored codes crackable in bulk.
 */
async function consumeRecoveryCode(userId: string, code: string, now: Date): Promise<boolean> {
  const normalized = code.trim().toLowerCase().replace(/\s/g, '')
  if (!/^[a-z0-9-]{8,}$/.test(normalized)) return false

  const candidates = await db
    .select()
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))

  for (const candidate of candidates) {
    if (!(await verifyPassword(normalized, candidate.codeHash))) continue

    // Marking used inside a conditional update, so two simultaneous uses of
    // the same code cannot both succeed: the second matches no unused row.
    const [claimed] = await db
      .update(mfaRecoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(mfaRecoveryCodes.id, candidate.id), isNull(mfaRecoveryCodes.usedAt)))
      .returning()

    return claimed !== undefined
  }

  return false
}

/**
 * Turns MFA off, given the current password.
 *
 * The password is required and checked here rather than trusted from the
 * session, because an unattended browser is the exact situation MFA is
 * protecting against, and "switch off the protection" is the first thing
 * somebody sitting at one would do.
 */
export async function disableMfa(
  userId: string,
  currentPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return { ok: false, error: 'User not found' }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: 'That password is not right.' }
  }

  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))
    await tx.delete(userMfa).where(eq(userMfa.userId, userId))
  })

  return { ok: true }
}

/** Issues a fresh set of recovery codes, invalidating the old ones. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)
  if (!row?.confirmedAt) {
    throw new Error('Two-factor authentication is not switched on for this account.')
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())

  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))
    for (const plain of codes) {
      await tx.insert(mfaRecoveryCodes).values({ userId, codeHash: await hashPassword(plain) })
    }
  })

  return codes
}

/**
 * A recovery code: two groups of five, from an alphabet with no ambiguous
 * characters.
 *
 * `0`/`o`, `1`/`l`/`i` are excluded because these get read off paper and typed
 * by somebody who is already having a bad day. ~51 bits of entropy, which is
 * far past what the lockout allows anybody to search.
 */
function generateRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(10)
  const characters = [...bytes].map((byte) => alphabet[byte % alphabet.length])
  return `${characters.slice(0, 5).join('')}-${characters.slice(5).join('')}`
}

/**
 * Changes a password, and ends every other session.
 *
 * ## The second half is the point
 *
 * Changing a password after a compromise is the first thing anybody does, and
 * on its own it achieves **nothing**: the attacker's session cookie is still
 * valid, because sessions are not derived from the password. They stay signed
 * in while the victim congratulates themselves.
 *
 * So the sessions go with it. The current one is kept, because signing someone
 * out of the page where they just changed their password is a good way to make
 * them think it failed.
 *
 * It also invalidates every outstanding MFA challenge token, which are signed
 * over the password hash — see `challenge.ts`.
 */
export async function changePassword(
  ctx: ActorContext,
  input: { currentPassword: string; newPassword: string; currentSessionId?: string | null },
): Promise<{ ok: true; sessionsEnded: number } | { ok: false; error: string }> {
  if (input.newPassword.length < 8) {
    return { ok: false, error: 'A password must be at least 8 characters.' }
  }
  if (input.newPassword === input.currentPassword) {
    return { ok: false, error: 'That is the password you already have.' }
  }

  const [user] = await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1)
  if (!user) return { ok: false, error: 'User not found' }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    return { ok: false, error: 'That is not your current password.' }
  }

  const passwordHash = await hashPassword(input.newPassword)

  return db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, ctx.userId))

    // `sessions.id` is non-null, so a plain `ne` is safe here — unlike the
    // device sweep in `devices.ts`, where the column is nullable and `<>`
    // silently spares every row that has no device.
    const ended = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, ctx.userId),
          input.currentSessionId ? ne(sessions.id, input.currentSessionId) : undefined,
        ),
      )
      .returning({ id: sessions.id })

    await recordAudit(
      ctx,
      {
        action: 'password.change',
        entityType: 'user',
        entityId: ctx.userId,
        // Never the password, never the hash — an audit log is read by more
        // people than the table it describes.
        after: { sessionsEnded: ended.length },
      },
      tx,
    )

    return { ok: true as const, sessionsEnded: ended.length }
  })
}
