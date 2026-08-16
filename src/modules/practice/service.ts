import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  companies,
  memberships,
  practiceEngagements,
  practiceMembers,
  practices,
  users,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { Role } from '@/modules/permissions'

/**
 * Accountant practice mode (spec §14).
 *
 * ## The claim: access is granted, never claimed
 *
 * Whichever side asks for an engagement, the *other* side has to agree. An
 * accountant cannot add themselves to a company's books; a company cannot
 * conscript an accountant. Until both have signed, the engagement grants
 * nothing at all.
 *
 * That rule is enforced in `respondToEngagement`, in one comparison, and
 * `tests/practice.test.ts` asserts both directions of it. The alternative —
 * "the firm adds the client and the client is notified" — is how a support
 * tool ends up able to read every customer's ledger, and more mundanely how
 * one mistyped email address hands a stranger the books.
 *
 * ## And the second claim: one company at a time
 *
 * Since Phase 1 every service has taken an explicit `ActorContext` and there
 * has been no ambient "current company". A practice member is the first human
 * who legitimately belongs to twenty companies at once, and switching between
 * them mints a *new* context rather than a wider one — so every `scoped()`
 * call written over eighteen phases keeps working unchanged.
 */

export class PracticeError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'PracticeError'
  }
}

/** Raised when the side that asked tries to be the side that agrees. */
export class SelfAcceptanceError extends Error {
  readonly status = 403
  constructor(readonly initiatedBy: 'practice' | 'client') {
    super(
      initiatedBy === 'practice'
        ? 'This access was requested by the practice, so the company has to accept it. A firm cannot grant itself the books.'
        : 'This access was offered by the company, so the practice has to accept it.',
    )
    this.name = 'SelfAcceptanceError'
  }
}

// --- The firm ---------------------------------------------------------------

export type Practice = {
  id: string
  name: string
  contactEmail: string | null
  website: string | null
  isActive: boolean
}

/**
 * Creates a firm, with the creator as its owner.
 *
 * Deliberately not gated on any company permission. A practice is not part of
 * a company — it is the other kind of thing in this system, and requiring an
 * `accounting:*` permission at some company would mean an accountant has to be
 * somebody's employee before they can be anybody's accountant.
 */
export async function createPractice(
  input: { userId: string; userName: string; name: string; contactEmail?: string; website?: string },
): Promise<Practice> {
  const name = input.name.trim()
  if (!name) throw new PracticeError('Give the practice a name.')

  return db.transaction(async (tx) => {
    const [practice] = await tx
      .insert(practices)
      .values({
        name,
        contactEmail: input.contactEmail?.trim() || null,
        website: input.website?.trim() || null,
        createdBy: input.userId,
      })
      .returning()

    await tx.insert(practiceMembers).values({
      practiceId: practice.id,
      userId: input.userId,
      practiceRole: 'owner',
      defaultRole: 'accountant',
    })

    return {
      id: practice.id,
      name: practice.name,
      contactEmail: practice.contactEmail,
      website: practice.website,
      isActive: practice.isActive,
    }
  })
}

export type PracticeMembership = {
  practiceId: string
  practiceName: string
  practiceRole: 'owner' | 'staff'
  defaultRole: Role
}

/** The firms this person works at. Usually none, occasionally one. */
export async function practicesFor(
  userId: string,
  exec: Executor = db,
): Promise<PracticeMembership[]> {
  const rows = await exec
    .select({
      practiceId: practices.id,
      practiceName: practices.name,
      practiceRole: practiceMembers.practiceRole,
      defaultRole: practiceMembers.defaultRole,
    })
    .from(practiceMembers)
    .innerJoin(practices, eq(practices.id, practiceMembers.practiceId))
    .where(
      and(
        eq(practiceMembers.userId, userId),
        eq(practiceMembers.isActive, true),
        eq(practices.isActive, true),
      ),
    )

  return rows.map((row) => ({
    practiceId: row.practiceId,
    practiceName: row.practiceName,
    practiceRole: row.practiceRole,
    defaultRole: row.defaultRole as Role,
  }))
}

async function requirePracticeOwner(practiceId: string, userId: string, exec: Executor = db) {
  const [member] = await exec
    .select()
    .from(practiceMembers)
    .where(
      and(
        eq(practiceMembers.practiceId, practiceId),
        eq(practiceMembers.userId, userId),
        eq(practiceMembers.isActive, true),
      ),
    )
    .limit(1)

  if (!member) throw new PracticeError('You do not work at that practice.')
  if (member.practiceRole !== 'owner') {
    throw new PracticeError('Only a practice owner can do that.')
  }
  return member
}

/**
 * Adds somebody to the firm — and to every client the firm currently serves.
 *
 * The second half is the point. A firm that hires a bookkeeper on Monday
 * expects them to be able to work on Tuesday, and the alternative is an owner
 * re-inviting them at forty clients one at a time, which nobody does, so
 * instead everybody shares a login. Access still stops at what each client
 * agreed to.
 */
export async function addPracticeMember(
  actor: { userId: string; userName: string },
  input: { practiceId: string; userId: string; practiceRole?: 'owner' | 'staff'; defaultRole?: Role },
): Promise<{ grantedAtClients: number }> {
  return db.transaction(async (tx) => {
    await requirePracticeOwner(input.practiceId, actor.userId, tx)

    await tx
      .insert(practiceMembers)
      .values({
        practiceId: input.practiceId,
        userId: input.userId,
        practiceRole: input.practiceRole ?? 'staff',
        defaultRole: (input.defaultRole ?? 'accountant') as never,
      })
      .onConflictDoUpdate({
        target: [practiceMembers.practiceId, practiceMembers.userId],
        set: {
          isActive: true,
          practiceRole: input.practiceRole ?? 'staff',
          defaultRole: (input.defaultRole ?? 'accountant') as never,
        },
      })

    const grantedAtClients = await grantAtLiveEngagements(
      tx,
      input.practiceId,
      input.userId,
      input.defaultRole ?? 'accountant',
    )

    return { grantedAtClients }
  })
}

/**
 * Removes somebody from the firm, and from every client at once.
 *
 * One revocation, not forty. A person who leaves an accounting firm on Friday
 * should not still be able to read a client's ledger on Monday because
 * somebody forgot one company.
 */
export async function removePracticeMember(
  actor: { userId: string },
  input: { practiceId: string; userId: string },
): Promise<{ revokedAtClients: number }> {
  return db.transaction(async (tx) => {
    await requirePracticeOwner(input.practiceId, actor.userId, tx)

    await tx
      .update(practiceMembers)
      .set({ isActive: false })
      .where(
        and(
          eq(practiceMembers.practiceId, input.practiceId),
          eq(practiceMembers.userId, input.userId),
        ),
      )

    const engagementIds = await tx
      .select({ id: practiceEngagements.id })
      .from(practiceEngagements)
      .where(eq(practiceEngagements.practiceId, input.practiceId))

    if (engagementIds.length === 0) return { revokedAtClients: 0 }

    const removed = await tx
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, input.userId),
          inArray(
            memberships.practiceEngagementId,
            engagementIds.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: memberships.id })

    return { revokedAtClients: removed.length }
  })
}

export async function listPracticeMembers(practiceId: string, userId: string) {
  // Readable by anybody who works there; only owners can change it.
  const [self] = await db
    .select()
    .from(practiceMembers)
    .where(
      and(
        eq(practiceMembers.practiceId, practiceId),
        eq(practiceMembers.userId, userId),
        eq(practiceMembers.isActive, true),
      ),
    )
    .limit(1)

  if (!self) throw new PracticeError('You do not work at that practice.')

  return db
    .select({
      userId: practiceMembers.userId,
      name: users.name,
      email: users.email,
      practiceRole: practiceMembers.practiceRole,
      defaultRole: practiceMembers.defaultRole,
      isActive: practiceMembers.isActive,
    })
    .from(practiceMembers)
    .innerJoin(users, eq(users.id, practiceMembers.userId))
    .where(eq(practiceMembers.practiceId, practiceId))
    .orderBy(desc(practiceMembers.practiceRole), users.name)
}

// --- Engagements ------------------------------------------------------------

export type Engagement = {
  id: string
  practiceId: string
  practiceName: string
  companyId: string
  companyName: string
  status: 'pending' | 'active' | 'declined' | 'ended'
  initiatedBy: 'practice' | 'client'
  grantedRole: Role
  note: string | null
  requestedAt: Date
  respondedAt: Date | null
  endedAt: Date | null
}

/**
 * A practice asks a company for access.
 *
 * Grants nothing. The company has to accept.
 */
export async function requestEngagement(
  actor: { userId: string; userName: string },
  input: { practiceId: string; companyId: string; grantedRole?: Role; note?: string },
): Promise<{ engagementId: string }> {
  return db.transaction(async (tx) => {
    await requirePracticeOwner(input.practiceId, actor.userId, tx)
    await assertNoLiveEngagement(tx, input.practiceId, input.companyId)

    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1)

    if (!company) throw new PracticeError('That company does not exist.')

    const [engagement] = await tx
      .insert(practiceEngagements)
      .values({
        practiceId: input.practiceId,
        companyId: input.companyId,
        status: 'pending',
        initiatedBy: 'practice',
        grantedRole: (input.grantedRole ?? 'accountant') as never,
        note: input.note?.trim() || null,
        requestedBy: actor.userId,
      })
      .returning({ id: practiceEngagements.id })

    return { engagementId: engagement.id }
  })
}

/**
 * A company offers a practice access.
 *
 * Also grants nothing — the practice has to accept. Symmetry here is not
 * politeness: a firm that finds itself holding books it never agreed to hold
 * has taken on a liability nobody asked it about.
 */
export async function offerEngagement(
  ctx: ActorContext,
  input: { practiceId: string; grantedRole?: Role; note?: string },
): Promise<{ engagementId: string }> {
  requirePermission(ctx, 'company:manage')

  return db.transaction(async (tx) => {
    await assertNoLiveEngagement(tx, input.practiceId, ctx.companyId)

    const [practice] = await tx
      .select({ id: practices.id })
      .from(practices)
      .where(and(eq(practices.id, input.practiceId), eq(practices.isActive, true)))
      .limit(1)

    if (!practice) throw new PracticeError('That practice does not exist.')

    const [engagement] = await tx
      .insert(practiceEngagements)
      .values({
        practiceId: input.practiceId,
        companyId: ctx.companyId,
        status: 'pending',
        initiatedBy: 'client',
        grantedRole: (input.grantedRole ?? 'accountant') as never,
        note: input.note?.trim() || null,
        requestedBy: ctx.userId,
      })
      .returning({ id: practiceEngagements.id })

    await recordAudit(
      ctx,
      {
        action: 'engagement.offer',
        entityType: 'practice_engagement',
        entityId: engagement.id,
        after: { practiceId: input.practiceId, grantedRole: input.grantedRole ?? 'accountant' },
      },
      tx,
    )

    return { engagementId: engagement.id }
  })
}

async function assertNoLiveEngagement(exec: Executor, practiceId: string, companyId: string) {
  const [live] = await exec
    .select({ id: practiceEngagements.id, status: practiceEngagements.status })
    .from(practiceEngagements)
    .where(
      and(
        eq(practiceEngagements.practiceId, practiceId),
        eq(practiceEngagements.companyId, companyId),
        inArray(practiceEngagements.status, ['pending', 'active']),
      ),
    )
    .limit(1)

  if (live) {
    throw new PracticeError(
      live.status === 'active'
        ? 'That practice already has access to this company.'
        : 'There is already a request waiting on a decision.',
    )
  }
}

export type RespondingParty =
  | { side: 'client'; ctx: ActorContext }
  | { side: 'practice'; userId: string; userName: string }

/**
 * Accepts or declines an engagement.
 *
 * ## The claim, in one comparison
 *
 * `engagement.initiatedBy === party.side` is refused. Whoever asked cannot be
 * whoever agrees, and there is no flag, no role and no configuration that
 * turns that off.
 */
export async function respondToEngagement(
  party: RespondingParty,
  input: { engagementId: string; accept: boolean },
): Promise<{ status: 'active' | 'declined'; membershipsGranted: number }> {
  return db.transaction(async (tx) => {
    const [engagement] = await tx
      .select()
      .from(practiceEngagements)
      .where(eq(practiceEngagements.id, input.engagementId))
      .limit(1)

    if (!engagement) throw new PracticeError('That request does not exist.')
    if (engagement.status !== 'pending') {
      throw new PracticeError('That request has already been settled.')
    }

    // The whole rule.
    if (engagement.initiatedBy === party.side) {
      throw new SelfAcceptanceError(engagement.initiatedBy)
    }

    // …and the responder must actually be that side.
    const responderId =
      party.side === 'client' ? party.ctx.userId : party.userId

    if (party.side === 'client') {
      requirePermission(party.ctx, 'company:manage')
      if (party.ctx.companyId !== engagement.companyId) {
        throw new PracticeError('That request is for a different company.')
      }
    } else {
      await requirePracticeOwner(engagement.practiceId, party.userId, tx)
    }

    if (!input.accept) {
      await tx
        .update(practiceEngagements)
        .set({ status: 'declined', respondedAt: new Date(), respondedBy: responderId })
        .where(eq(practiceEngagements.id, engagement.id))

      return { status: 'declined' as const, membershipsGranted: 0 }
    }

    await tx
      .update(practiceEngagements)
      .set({ status: 'active', respondedAt: new Date(), respondedBy: responderId })
      .where(eq(practiceEngagements.id, engagement.id))

    const staff = await tx
      .select({ userId: practiceMembers.userId, defaultRole: practiceMembers.defaultRole })
      .from(practiceMembers)
      .where(
        and(
          eq(practiceMembers.practiceId, engagement.practiceId),
          eq(practiceMembers.isActive, true),
        ),
      )

    let granted = 0
    for (const member of staff) {
      if (await grantMembership(tx, engagement, member.userId, member.defaultRole as Role)) {
        granted += 1
      }
    }

    return { status: 'active' as const, membershipsGranted: granted }
  })
}

/**
 * Grants one person a membership at every client the firm currently serves.
 *
 * Exported so the invitation flow can call it: somebody who joins a firm by
 * accepting an emailed link should reach the same clients as somebody the
 * owner added by hand, and two implementations of that rule is how the two
 * paths come to differ.
 */
export async function grantAtLiveEngagements(
  tx: Executor,
  practiceId: string,
  userId: string,
  defaultRole: Role,
): Promise<number> {
  const live = await tx
    .select()
    .from(practiceEngagements)
    .where(
      and(
        eq(practiceEngagements.practiceId, practiceId),
        eq(practiceEngagements.status, 'active'),
      ),
    )

  let granted = 0
  for (const engagement of live) {
    if (await grantMembership(tx, engagement, userId, defaultRole)) granted += 1
  }
  return granted
}

/**
 * Gives one practice member a membership at one client.
 *
 * Returns false when the person already has a membership of their own at that
 * company — somebody who both works at the firm and was hired directly by the
 * client. Their own grant is not the engagement's to overwrite, and it is not
 * the engagement's to take away when the engagement ends either.
 */
async function grantMembership(
  tx: Executor,
  engagement: { id: string; companyId: string; grantedRole: string },
  userId: string,
  defaultRole: Role,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: memberships.id, engagementId: memberships.practiceEngagementId })
    .from(memberships)
    .where(and(eq(memberships.companyId, engagement.companyId), eq(memberships.userId, userId)))
    .limit(1)

  if (existing && existing.engagementId === null) return false

  // The client's decision caps the firm's. A member whose default role is
  // `owner` still arrives as whatever the company agreed to.
  const role = narrowerOf(defaultRole, engagement.grantedRole as Role)

  await tx
    .insert(memberships)
    .values({
      companyId: engagement.companyId,
      userId,
      role: role as never,
      practiceEngagementId: engagement.id,
    })
    .onConflictDoUpdate({
      target: [memberships.companyId, memberships.userId],
      set: { role: role as never, isActive: true, practiceEngagementId: engagement.id },
    })

  return true
}

/**
 * The narrower of two roles, by how much of the books each can reach.
 *
 * Not an ordering of importance — `sales` and `bookkeeper` are not comparable
 * on any single axis — but of ledger reach, which is what an engagement is
 * about. When neither strictly contains the other the engagement's cap wins,
 * because it is the client's decision.
 */
export function narrowerOf(memberRole: Role, cap: Role): Role {
  const reach: Record<Role, number> = {
    owner: 6,
    manager: 5,
    accountant: 4,
    bookkeeper: 3,
    marketing: 2,
    sales: 2,
    readonly: 1,
  }

  return reach[memberRole] <= reach[cap] ? memberRole : cap
}

/**
 * Ends an engagement, from either side.
 *
 * Removes exactly the memberships this engagement created, found by name.
 * Revocation takes effect on the **next request** rather than when a session
 * expires, because `resolveSession` re-reads the membership every time — a
 * decision made in Phase 13 and this is what it was for.
 */
export async function endEngagement(
  party: RespondingParty,
  input: { engagementId: string; reason?: string },
): Promise<{ membershipsRemoved: number }> {
  return db.transaction(async (tx) => {
    const [engagement] = await tx
      .select()
      .from(practiceEngagements)
      .where(eq(practiceEngagements.id, input.engagementId))
      .limit(1)

    if (!engagement) throw new PracticeError('That engagement does not exist.')
    if (engagement.status !== 'active' && engagement.status !== 'pending') {
      throw new PracticeError('That engagement has already ended.')
    }

    // Either side may end it, without the other's agreement. Deliberately
    // asymmetric with starting one: a client must never need their
    // accountant's permission to take their books back.
    const actorId = party.side === 'client' ? party.ctx.userId : party.userId

    if (party.side === 'client') {
      requirePermission(party.ctx, 'company:manage')
      if (party.ctx.companyId !== engagement.companyId) {
        throw new PracticeError('That engagement is for a different company.')
      }
    } else {
      await requirePracticeOwner(engagement.practiceId, party.userId, tx)
    }

    const removed = await tx
      .delete(memberships)
      .where(eq(memberships.practiceEngagementId, engagement.id))
      .returning({ id: memberships.id })

    await tx
      .update(practiceEngagements)
      .set({
        status: 'ended',
        endedAt: new Date(),
        endedBy: actorId,
        endedReason: input.reason?.trim() || null,
        // The check constraint ties `responded` to `pending`; an engagement
        // ended before it was ever answered still needs one.
        respondedAt: engagement.respondedAt ?? new Date(),
        respondedBy: engagement.respondedBy ?? actorId,
      })
      .where(eq(practiceEngagements.id, engagement.id))

    if (party.side === 'client') {
      await recordAudit(
        party.ctx,
        {
          action: 'engagement.end',
          entityType: 'practice_engagement',
          entityId: engagement.id,
          after: { membershipsRemoved: removed.length, reason: input.reason ?? null },
        },
        tx,
      )
    }

    return { membershipsRemoved: removed.length }
  })
}

/** Every engagement of one practice, newest first. */
export async function engagementsForPractice(
  practiceId: string,
  userId: string,
): Promise<Engagement[]> {
  const [self] = await db
    .select()
    .from(practiceMembers)
    .where(
      and(
        eq(practiceMembers.practiceId, practiceId),
        eq(practiceMembers.userId, userId),
        eq(practiceMembers.isActive, true),
      ),
    )
    .limit(1)

  if (!self) throw new PracticeError('You do not work at that practice.')

  return listEngagements(eq(practiceEngagements.practiceId, practiceId))
}

/** Every engagement touching one company. Read by the client's access page. */
export async function engagementsForCompany(ctx: ActorContext): Promise<Engagement[]> {
  requirePermission(ctx, 'accounting:view')
  return listEngagements(eq(practiceEngagements.companyId, ctx.companyId))
}

async function listEngagements(where: ReturnType<typeof eq>): Promise<Engagement[]> {
  const rows = await db
    .select({
      id: practiceEngagements.id,
      practiceId: practiceEngagements.practiceId,
      practiceName: practices.name,
      companyId: practiceEngagements.companyId,
      companyName: companies.name,
      status: practiceEngagements.status,
      initiatedBy: practiceEngagements.initiatedBy,
      grantedRole: practiceEngagements.grantedRole,
      note: practiceEngagements.note,
      requestedAt: practiceEngagements.requestedAt,
      respondedAt: practiceEngagements.respondedAt,
      endedAt: practiceEngagements.endedAt,
    })
    .from(practiceEngagements)
    .innerJoin(practices, eq(practices.id, practiceEngagements.practiceId))
    .innerJoin(companies, eq(companies.id, practiceEngagements.companyId))
    .where(where)
    .orderBy(desc(practiceEngagements.requestedAt))

  return rows.map((row) => ({ ...row, grantedRole: row.grantedRole as Role }))
}

// --- Who can reach these books ---------------------------------------------

export type AccessHolder = {
  userId: string
  name: string
  email: string
  role: Role
  /** Null when they work at the company itself. */
  viaPracticeName: string | null
  viaEngagementId: string | null
  isActive: boolean
}

/**
 * Everybody who can open this company's books, and how they got in.
 *
 * The page a client should be able to reach in one click and read in ten
 * seconds. An access list that does not distinguish "our bookkeeper" from
 * "somebody at the firm we used two years ago" is a list nobody audits.
 */
export async function whoHasAccess(ctx: ActorContext): Promise<AccessHolder[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      userId: memberships.userId,
      name: users.name,
      email: users.email,
      role: memberships.role,
      isActive: memberships.isActive,
      engagementId: memberships.practiceEngagementId,
      practiceName: practices.name,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(practiceEngagements, eq(practiceEngagements.id, memberships.practiceEngagementId))
    .leftJoin(practices, eq(practices.id, practiceEngagements.practiceId))
    .where(scoped(ctx, memberships))
    .orderBy(users.name)

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    viaPracticeName: row.practiceName,
    viaEngagementId: row.engagementId,
    isActive: row.isActive,
  }))
}

/** Practices this person could be offered an engagement with, by name. */
export async function findPracticesByName(query: string): Promise<Practice[]> {
  const term = query.trim()
  if (term.length < 2) return []

  const rows = await db
    .select()
    .from(practices)
    .where(and(eq(practices.isActive, true), sql`${practices.name} ILIKE ${'%' + term + '%'}`))
    .limit(10)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    contactEmail: row.contactEmail,
    website: row.website,
    isActive: row.isActive,
  }))
}

/** Pending requests this person can answer on behalf of their practice. */
export async function pendingForPractice(practiceId: string): Promise<Engagement[]> {
  return listEngagements(
    and(
      eq(practiceEngagements.practiceId, practiceId),
      eq(practiceEngagements.status, 'pending'),
    ) as never,
  )
}

/** True when this membership came from an engagement rather than a hire. */
export async function isPracticeMembership(
  companyId: string,
  userId: string,
): Promise<{ via: string | null }> {
  const [row] = await db
    .select({ practiceName: practices.name })
    .from(memberships)
    .leftJoin(practiceEngagements, eq(practiceEngagements.id, memberships.practiceEngagementId))
    .leftJoin(practices, eq(practices.id, practiceEngagements.practiceId))
    .where(
      and(
        eq(memberships.companyId, companyId),
        eq(memberships.userId, userId),
        sql`${memberships.practiceEngagementId} IS NOT NULL`,
      ),
    )
    .limit(1)

  return { via: row?.practiceName ?? null }
}

/** Memberships with no engagement — the company's own people. */
export async function directMemberCount(companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), isNull(memberships.practiceEngagementId)))

  return Number(row?.count ?? 0)
}
