import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { loginAttempts, securityPolicies } from '@/db/schema'

/**
 * The record of who tried to sign in, and the lockout built on it (spec §14,
 * §19).
 *
 * ## The lockout is on the address, and that is a trade
 *
 * Locking an email address after N failures stops someone working through a
 * password list against one account. It also hands anybody who knows an
 * address a way to lock its owner out — which is why the lock is *temporary*
 * and short, and why it is on the address rather than the account: a lock that
 * had to be lifted by an administrator would turn a nuisance into an outage.
 *
 * The alternative, locking on IP, fails the other way: an attacker has more
 * addresses than a business has offices, and the whole office shares one.
 *
 * What the fifteen minutes actually buys is arithmetic. Ten attempts per
 * quarter-hour is under a thousand a day, against a six-digit TOTP code or any
 * password worth the name.
 */

/** Defaults for a company with no policy row, and for the pre-auth path. */
export const DEFAULT_MAX_FAILED_ATTEMPTS = 10
export const DEFAULT_LOCKOUT_MINUTES = 15

export type LoginOutcome = (typeof loginAttempts.$inferSelect)['outcome']

/**
 * Reduces an address to its network.
 *
 * The history is read to answer "is this the usual place?", which the network
 * answers and the host does not improve on. Keeping the full address would
 * make this table a movement log for every person who uses the product, and
 * spec §19 asks for privacy controls rather than for everything that could be
 * collected.
 */
export function truncateIp(raw: string | null | undefined): string | null {
  if (!raw) return null

  // `x-forwarded-for` is a list; the client is the first entry.
  const first = raw.split(',')[0]?.trim()
  if (!first) return null

  if (first.includes(':')) {
    // IPv6 — keep the routing prefix (/48), drop the rest.
    const groups = first.split(':').filter(Boolean).slice(0, 3)
    return groups.length ? `${groups.join(':')}::/48` : null
  }

  const octets = first.split('.')
  if (octets.length !== 4) return null
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
}

export async function recordLoginAttempt(input: {
  email: string
  userId?: string | null
  outcome: LoginOutcome
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  await db.insert(loginAttempts).values({
    email: input.email.trim().toLowerCase(),
    userId: input.userId ?? null,
    outcome: input.outcome,
    ipPrefix: truncateIp(input.ip),
    // Truncated: enough to tell a browser from a phone, not enough to be a
    // fingerprint worth keeping.
    userAgent: input.userAgent?.slice(0, 200) ?? null,
  })
}

export type LockoutState = {
  locked: boolean
  failedCount: number
  /** Null when not locked. */
  retryAfter: Date | null
}

/**
 * Whether this address is currently locked out.
 *
 * Counts only failures *since the last success*, so signing in correctly
 * clears the count without a separate delete. That matters more than it looks:
 * a counter that is only reset on a timer means somebody who fat-fingers their
 * password across a working day accumulates a lockout they did nothing to
 * earn.
 *
 * The policy is read per company where there is one, but this runs before
 * anybody has proved which company they belong to — so the *strictest* policy
 * across the user's companies would be the principled answer and is not worth
 * a second query on the hot path. The defaults apply here, and the per-company
 * policy governs sessions and MFA, where the company is known.
 */
export async function lockoutState(
  email: string,
  opts: { maxFailedAttempts?: number; lockoutMinutes?: number; now?: Date } = {},
): Promise<LockoutState> {
  const max = opts.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS
  const minutes = opts.lockoutMinutes ?? DEFAULT_LOCKOUT_MINUTES
  const now = opts.now ?? new Date()
  const windowStart = new Date(now.getTime() - minutes * 60_000)

  const normalized = email.trim().toLowerCase()

  const rows = await db
    .select({ outcome: loginAttempts.outcome, createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalized),
        gte(loginAttempts.createdAt, windowStart),
        // Excluded in the query, not in the loop below. A `locked_out` row is
        // the *result* of the lock rather than a new failure, and leaving them
        // in would let a burst of retries push the real failures past the
        // `limit` — so the count would fall and the lock would lift itself.
        sql`${loginAttempts.outcome} <> 'locked_out'`,
      ),
    )
    .orderBy(desc(loginAttempts.createdAt))
    .limit(max + 1)

  let failedCount = 0
  let oldestFailure: Date | null = null

  for (const row of rows) {
    // Walking newest-first and stopping at a success is what makes a
    // successful sign-in clear the count.
    if (row.outcome === 'success') break

    failedCount++
    oldestFailure = row.createdAt
  }

  if (failedCount < max || !oldestFailure) {
    return { locked: false, failedCount, retryAfter: null }
  }

  return {
    locked: true,
    failedCount,
    retryAfter: new Date(oldestFailure.getTime() + minutes * 60_000),
  }
}

/** The policy in force for a company, or the defaults where none is set. */
export async function securityPolicy(companyId: string) {
  const [row] = await db
    .select()
    .from(securityPolicies)
    .where(eq(securityPolicies.companyId, companyId))
    .limit(1)

  return {
    requireMfa: row?.requireMfa ?? false,
    maxFailedAttempts: row?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS,
    lockoutMinutes: row?.lockoutMinutes ?? DEFAULT_LOCKOUT_MINUTES,
    sessionTtlDays: row?.sessionTtlDays ?? 30,
  }
}

export type LoginHistoryRow = {
  id: string
  outcome: LoginOutcome
  ipPrefix: string | null
  userAgent: string | null
  createdAt: Date
}

/**
 * A user's own sign-in history.
 *
 * Deliberately not permission-gated by a company role: this is the person's
 * own account, and the row that matters most — a successful sign-in they do
 * not recognize — is the one an administrator has no better claim to see than
 * they do.
 */
export async function loginHistoryForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<LoginHistoryRow[]> {
  return db
    .select({
      id: loginAttempts.id,
      outcome: loginAttempts.outcome,
      ipPrefix: loginAttempts.ipPrefix,
      userAgent: loginAttempts.userAgent,
      createdAt: loginAttempts.createdAt,
    })
    .from(loginAttempts)
    .where(eq(loginAttempts.userId, userId))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(opts.limit ?? 25)
}

// Wording lives in `vocabulary.ts`, which imports nothing, so a client
// component can label an outcome without pulling the database client into the
// browser bundle.
export { LOGIN_OUTCOME_LABELS } from './vocabulary'

/** Failed sign-ins across a company's members, for the security page. */
export async function recentFailuresForCompany(
  companyId: string,
  opts: { limit?: number; sinceHours?: number } = {},
) {
  const since = new Date(Date.now() - (opts.sinceHours ?? 168) * 3_600_000)

  return db
    .select({
      email: loginAttempts.email,
      outcome: loginAttempts.outcome,
      attempts: sql<string>`count(*)`,
      lastAt: sql<Date>`max(${loginAttempts.createdAt})`,
    })
    .from(loginAttempts)
    .where(
      and(
        gte(loginAttempts.createdAt, since),
        sql`${loginAttempts.outcome} <> 'success'`,
        // Only addresses belonging to this company's members. An address that
        // matched nothing belongs to nobody, and showing it here would let one
        // company watch another's failed sign-ins.
        sql`${loginAttempts.userId} IN (
          SELECT user_id FROM memberships WHERE company_id = ${companyId}
        )`,
      ),
    )
    .groupBy(loginAttempts.email, loginAttempts.outcome)
    .orderBy(desc(sql`max(${loginAttempts.createdAt})`))
    .limit(opts.limit ?? 20)
}
