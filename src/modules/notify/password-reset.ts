import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships, sessions, users } from '@/db/schema'
import { hashPassword } from '@/modules/auth/password'
import { recordAudit } from '@/modules/audit'
import { truncateIp } from '@/modules/auth/login-history'
import { issueToken, lookupToken, redeemToken, revokeTokensFor } from './tokens'
import { sendPasswordReset } from './service'

/**
 * "I forgot my password" (spec §19).
 *
 * Absent since Phase 13 on purpose: the note then read *"a half-built reset
 * flow is a bypass for everything above it, so it is absent rather than
 * approximate."* Everything above it now means a password, a second factor,
 * device sessions, and lockout, and this had to fit under all four.
 *
 * ## What it must not become
 *
 *  - **Not an oracle.** The response is identical whether or not the address
 *    exists. A form that says "no account with that email" is a way to find out
 *    who banks here, one address at a time.
 *  - **Not an MFA bypass.** Resetting the password does not touch enrolment. A
 *    stolen mailbox gets you a password, and a password alone has not been
 *    enough since ADR 0013.
 *  - **Not a way around lockout.** Resetting clears the *reason* somebody was
 *    locked out — repeated wrong passwords — because their password is now
 *    different. It does not clear an account somebody else is attacking, and
 *    the login history keeps every attempt either way.
 */

export type RequestResult = {
  /**
   * Always true. Whether an email went is deliberately not reported — see the
   * oracle note above.
   */
  accepted: true
}

/**
 * Starts a reset. Sends a letter if the address belongs to somebody, and says
 * exactly the same thing either way.
 */
export async function requestPasswordReset(input: {
  email: string
  ipAddress?: string | null
}): Promise<RequestResult> {
  const email = input.email.trim().toLowerCase()

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (user) {
    const issued = await issueToken({
      purpose: 'password_reset',
      email,
      userId: user.id,
      requestedIp: truncateIp(input.ipAddress ?? null),
    })

    // A rate-limit refusal is swallowed rather than surfaced, for the same
    // reason the missing-account case is: "you have asked five times already"
    // tells an attacker their guess was a real address.
    await sendPasswordReset({
      to: email,
      toName: user.name,
      token: issued.token,
      expiresAt: issued.expiresAt,
      reference: issued.id,
    }).catch(() => undefined)
  }

  return { accepted: true }
}

export type ResetOutcome =
  | { ok: true; sessionsEnded: number; email: string }
  | { ok: false; error: string }

/**
 * Finishes a reset.
 *
 * Every other session is ended, because the whole reason somebody resets a
 * password is often that they think another person has it. Leaving that
 * person's session alive would make the reset ceremonial.
 */
export async function completePasswordReset(input: {
  token: string
  newPassword: string
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<ResetOutcome> {
  if (input.newPassword.length < 8) {
    return { ok: false, error: 'A password must be at least 8 characters.' }
  }

  const lookup = await lookupToken('password_reset', input.token)
  if (!lookup.ok) {
    return {
      ok: false,
      error:
        lookup.reason === 'expired'
          ? 'That link has expired. Ask for a new one.'
          : lookup.reason === 'used'
            ? 'That link has already been used. Ask for a new one if you still need it.'
            : 'That link is not valid. Ask for a new one.',
    }
  }

  const record = lookup.token
  if (!record.userId) return { ok: false, error: 'That link is not valid.' }

  const [user] = await db.select().from(users).where(eq(users.id, record.userId)).limit(1)
  if (!user) return { ok: false, error: 'That link is not valid.' }

  // The address is re-checked against the user's *current* one. A token issued
  // to an address somebody has since changed away from should not still work —
  // otherwise changing your email leaves the old inbox holding a live key.
  if (user.email.toLowerCase() !== record.email) {
    return { ok: false, error: 'That link is no longer valid for this account.' }
  }

  const passwordHash = await hashPassword(input.newPassword)

  return db.transaction(async (tx) => {
    // Spent inside the transaction that does the work, so a failure below
    // leaves the link usable rather than burning somebody's only chance.
    await redeemToken(record.id, tx)

    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id))

    const ended = await tx
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id })

    // Any other live reset link dies too. Three requests in a panic should not
    // leave two working keys in a mailbox somebody else can read.
    await revokeTokensFor('password_reset', record.email, tx)

    // Audited into every company this person belongs to. There is no single
    // "their" company for somebody who works at four, and a password reset is
    // exactly the event each of those companies is entitled to see.
    const companies = await tx
      .select({ companyId: memberships.companyId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id))

    for (const membership of companies) {
      await recordAudit(
        {
          userId: user.id,
          userName: user.name,
          companyId: membership.companyId,
          role: membership.role,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
        {
          action: 'password.reset',
          entityType: 'user',
          entityId: user.id,
          after: { sessionsEnded: ended.length },
        },
        tx,
      )
    }

    return { ok: true as const, sessionsEnded: ended.length, email: user.email }
  })
}

/** Whether a reset link is still good, for rendering the page. */
export async function checkResetToken(token: string) {
  const lookup = await lookupToken('password_reset', token)
  return lookup.ok
    ? { ok: true as const, email: lookup.token.email }
    : { ok: false as const, reason: lookup.reason }
}
