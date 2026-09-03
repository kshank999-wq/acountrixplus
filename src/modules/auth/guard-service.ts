import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '@/db'
import { companies, guardAttempts, memberships, users } from '@/db/schema'
import { verifyPassword } from './password'
import { truncateIp } from './login-history'
import { guardVerdict, type GuardedAct } from './reauthentication'
import {
  blockedMessage,
  GUARD_COOLOFF_MINUTES,
  standingFrom,
  warningLetter,
  type GuardAttempt,
} from './guard-attempts'

/**
 * The one place a guarded act checks a password (Phase 100).
 *
 * Phase 99 put `guardVerdict` in four functions and left it at that. This is
 * the same check with the counting, the cool-off and the warning around it —
 * and it is one function so that a fifth act cannot get three of the four.
 *
 * The order matters and is the whole of it:
 *
 * 1. **Blocked?** Refuse without recording. Recording a refused attempt would
 *    push the oldest failure forward on every retry and the block would never
 *    lift — the bug `lockoutState` avoids by excluding its own `locked_out`
 *    rows, met again from the other direction.
 * 2. **Right password?** Recorded either way. A success is what clears the run.
 * 3. **Just crossed the limit?** Tell the owner, once.
 */

export type GuardOutcome = { ok: true } | { ok: false; why: string }

/**
 * Whether this act may go ahead for this person, right now.
 *
 * `sendWarning` is injected rather than imported so this module does not
 * depend on the notify layer, which depends on `users` and would make the
 * import graph a circle. The caller that has a mailer passes one; a caller
 * that does not passes nothing and the warning is skipped, which is honest
 * — better a guard with no letter than no guard.
 */
export async function guardAct(input: {
  userId: string
  act: GuardedAct
  given: string | null | undefined
  passwordHash: string
  ipAddress?: string | null
  now?: Date
  sendWarning?: (letter: {
    to: string
    toName: string
    subject: string
    body: string[]
  }) => Promise<unknown>
}): Promise<GuardOutcome> {
  const now = input.now ?? new Date()
  const windowStart = new Date(now.getTime() - GUARD_COOLOFF_MINUTES * 60_000)

  const rows = await db
    .select({ ok: guardAttempts.ok, createdAt: guardAttempts.createdAt })
    .from(guardAttempts)
    .where(
      and(
        eq(guardAttempts.userId, input.userId),
        eq(guardAttempts.act, input.act),
        gte(guardAttempts.createdAt, windowStart),
      ),
    )
    .orderBy(desc(guardAttempts.createdAt))
    .limit(50)

  const recent: GuardAttempt[] = rows.map((row) => ({
    act: input.act,
    ok: row.ok,
    at: row.createdAt,
  }))

  const before = standingFrom(recent, { now })

  // Refused without a row. See the docstring: recording here would keep the
  // block alive for as long as somebody kept knocking.
  if (before.blocked) return { ok: false, why: blockedMessage(before, now) }

  const matches = await verifyPassword(input.given ?? '', input.passwordHash)

  await db.insert(guardAttempts).values({
    userId: input.userId,
    act: input.act,
    ok: matches,
    ipAddress: truncateIp(input.ipAddress ?? null),
  })

  const verdict = guardVerdict({ act: input.act, given: input.given, matches })
  if (verdict.ok) return verdict

  const after = standingFrom(
    [{ act: input.act, ok: matches, at: now }, ...recent],
    { now },
  )

  if (after.shouldWarn && input.sendWarning) {
    const [me] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))

    if (me) {
      /**
       * A company the person belongs to, so the letter has a name in it and a
       * failed send lands somewhere an operator will see (Phase 38's reasoning
       * for `sendPasswordReset`). The oldest membership, so the same person
       * always lands in the same place.
       */
      const [membership] = await db
        .select({ name: companies.name })
        .from(memberships)
        .innerJoin(companies, eq(companies.id, memberships.companyId))
        .where(eq(memberships.userId, input.userId))
        .orderBy(memberships.createdAt)
        .limit(1)

      const letter = warningLetter({
        act: input.act,
        failedCount: after.failedCount,
        // "your books" for somebody who belongs to no company, which
        // registration does not produce but a deleted company would.
        companyName: membership?.name ?? 'your books',
      })

      await input
        .sendWarning({ to: me.email, toName: me.name, ...letter })
        .catch(() => undefined)
    }
  }

  // The plain refusal until the limit is reached, then the one that says how
  // long. Both say the account is untouched.
  return after.blocked ? { ok: false, why: blockedMessage(after, now) } : verdict
}
