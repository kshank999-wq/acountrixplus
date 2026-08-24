import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  companies,
  memberships,
  practiceEngagements,
  practiceMembers,
  practices,
  sessions,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import type { ActorContext } from '@/modules/tenancy/context'
import type { Role } from '@/modules/permissions'
import { DomainError } from '@/modules/errors'

/**
 * Switching between the companies one person can reach (spec §14).
 *
 * ## Switching mints a new context, never a wider one
 *
 * The session names exactly one company. Changing it replaces that name; it
 * does not add a second. Every `scoped()` call written across eighteen phases
 * keeps working unchanged, because none of them ever asked "which companies
 * may I see" — they asked "which company am I in", and there is still exactly
 * one answer.
 *
 * The alternative, a context carrying a *set* of company ids, would mean every
 * query in the application had to be re-read to decide whether it meant one or
 * many. That is a review of several hundred call sites where a single missed
 * one leaks a client's ledger to another client's accountant.
 */

export type ReachableCompany = {
  id: string
  name: string
  industry: string
  role: Role
  /** Null when this person works at the company itself. */
  viaPracticeName: string | null
  isCurrent: boolean
}

/**
 * Every company this person can open, and how.
 *
 * Keyed off `memberships`, which is the only thing that grants access —
 * engagements grant memberships and then step out of the way, so there is one
 * answer to "can this person see these books" rather than two that can
 * disagree.
 */
export async function reachableCompanies(
  userId: string,
  currentCompanyId: string | null,
): Promise<ReachableCompany[]> {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      industry: companies.industry,
      role: memberships.role,
      practiceName: practices.name,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .leftJoin(practiceEngagements, eq(practiceEngagements.id, memberships.practiceEngagementId))
    .leftJoin(practices, eq(practices.id, practiceEngagements.practiceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)))
    .orderBy(companies.name)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    industry: row.industry,
    role: row.role as Role,
    viaPracticeName: row.practiceName,
    isCurrent: row.id === currentCompanyId,
  }))
}

export class NoSuchCompanyError extends DomainError {
  readonly status = 404
  constructor() {
    // Reported as not-found rather than forbidden, for the same reason
    // `TenantIsolationError` is: confirming that a company id exists but is
    // out of reach is itself a leak.
    super('That company is not one you can open.')
    this.name = 'NoSuchCompanyError'
  }
}

/**
 * Points a session at a different company.
 *
 * The membership is checked here **and** re-checked by `resolveSession` on
 * every subsequent request. The check here gives a decent error; the one in
 * `resolveSession` is the one that matters, because it is what makes ending an
 * engagement take effect on the next click rather than whenever a session
 * happens to expire.
 */
export async function switchCompany(
  actor: { userId: string; userName: string; sessionId: string; ipAddress?: string | null; userAgent?: string | null },
  companyId: string,
): Promise<{ companyId: string; companyName: string; role: Role }> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({
        role: memberships.role,
        overrides: memberships.permissionOverrides,
        companyName: companies.name,
        engagementId: memberships.practiceEngagementId,
        practiceName: practices.name,
      })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .leftJoin(practiceEngagements, eq(practiceEngagements.id, memberships.practiceEngagementId))
      .leftJoin(practices, eq(practices.id, practiceEngagements.practiceId))
      .where(
        and(
          eq(memberships.companyId, companyId),
          eq(memberships.userId, actor.userId),
          eq(memberships.isActive, true),
        ),
      )
      .limit(1)

    if (!membership) throw new NoSuchCompanyError()

    await tx
      .update(sessions)
      .set({ activeCompanyId: companyId })
      .where(and(eq(sessions.id, actor.sessionId), eq(sessions.userId, actor.userId)))

    // Recorded in the company being *entered*. "Who opened our books, and
    // when" is the client's question — putting it in the accountant's own
    // company would file it where the person it concerns cannot read it.
    await recordAudit(
      {
        userId: actor.userId,
        userName: actor.userName,
        companyId,
        role: membership.role as Role,
        overrides: membership.overrides,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        viaPractice: membership.practiceName,
      },
      {
        action: 'company.switch',
        entityType: 'company',
        entityId: companyId,
        after: { role: membership.role, viaPractice: membership.practiceName },
      },
      tx,
    )

    return {
      companyId,
      companyName: membership.companyName,
      role: membership.role as Role,
    }
  })
}

export type ClientWorkItem = {
  companyId: string
  companyName: string
  industry: string
  role: Role
  engagementId: string
  /** Bank transactions waiting to be categorized. The universal backlog. */
  awaitingReview: number
  /** The oldest of them, which is what says whether the backlog is stale. */
  oldestAwaiting: string | null
  lastActivityAt: Date | null
}

/**
 * The firm's work queue across its clients.
 *
 * ## The one query in the application that crosses tenants
 *
 * Everything else takes an `ActorContext` naming one company and filters by
 * it. This cannot: the whole value of practice mode is seeing forty clients at
 * once, and a page that made an accountant click into each one to find out
 * whether there is anything to do is a page nobody opens.
 *
 * So it is built to be impossible to point anywhere else. The company set is
 * derived **inside this function** from the caller's own live engagements at
 * the practice they are asking about, and there is no parameter that can widen
 * it. It also returns counts rather than rows — an accountant with a backlog
 * to triage needs a number, not a list of somebody else's transactions on a
 * page they have not entered yet.
 *
 * `requirePracticeMembership` is checked first: asking for a practice you do
 * not work at returns nothing rather than everything.
 */
export async function practiceWorkQueue(
  userId: string,
  practiceId: string,
): Promise<ClientWorkItem[]> {
  // Membership at the practice, checked before anything is read. A gate
  // rather than a filter: a practice id somebody guessed returns nothing,
  // not another firm's client roster.
  const [self] = await db
    .select({ id: practiceMembers.id })
    .from(practiceMembers)
    .where(
      and(
        eq(practiceMembers.practiceId, practiceId),
        eq(practiceMembers.userId, userId),
        eq(practiceMembers.isActive, true),
      ),
    )
    .limit(1)

  if (!self) return []

  const clients = await db
    .select({
      companyId: companies.id,
      companyName: companies.name,
      industry: companies.industry,
      role: memberships.role,
      engagementId: practiceEngagements.id,
    })
    .from(memberships)
    .innerJoin(
      practiceEngagements,
      eq(practiceEngagements.id, memberships.practiceEngagementId),
    )
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(
      and(
        // The caller's own memberships, granted by this practice's own live
        // engagements. Both halves are required: the first stops one firm
        // reading another's roster, the second stops a former member of this
        // firm reading its current one.
        eq(memberships.userId, userId),
        eq(memberships.isActive, true),
        eq(practiceEngagements.practiceId, practiceId),
        eq(practiceEngagements.status, 'active'),
      ),
    )
    .orderBy(companies.name)

  if (clients.length === 0) return []

  // Counted per client rather than in one grouped query over every company:
  // the grouped version is the one that, with a filter typo, returns every
  // company in the database. This one cannot, because each query names a
  // company that was already proven reachable above.
  return Promise.all(
    clients.map(async (client) => {
      const [pending] = await db
        .select({
          count: sql<string>`count(*)`,
          oldest: sql<string | null>`min(${bankTransactions.postedDate})`,
          latest: sql<Date | null>`max(${bankTransactions.createdAt})`,
        })
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.companyId, client.companyId),
            // Everything a person still has to decide about. `excluded` and
            // `reconciled` are decisions somebody already made.
            inArray(bankTransactions.reviewState, ['new', 'suggested', 'needs_review']),
          ),
        )

      return {
        companyId: client.companyId,
        companyName: client.companyName,
        industry: client.industry,
        role: client.role as Role,
        engagementId: client.engagementId as string,
        awaitingReview: Number(pending?.count ?? 0),
        oldestAwaiting: pending?.oldest ?? null,
        lastActivityAt: pending?.latest ?? null,
      }
    }),
  )
}

/** Companies this person belongs to directly, for the "my own books" case. */
export async function ownCompanyCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.isActive, true),
        isNull(memberships.practiceEngagementId),
      ),
    )

  return Number(row?.count ?? 0)
}
