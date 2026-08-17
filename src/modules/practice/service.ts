import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  companies,
  engagementAssignments,
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
  /** Whole firm, or only the assigned (Phase 25). */
  staffing: 'whole_firm' | 'assigned_only'
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

    // One decision point (Phase 25). An engagement accepted while already
    // staffed `assigned_only` grants only the assigned, which is what lets a
    // firm decide who is on a client's books before the client says yes.
    const { granted } = await reconcileEngagementMemberships(tx, engagement)

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
 *
 * Since Phase 25 this reconciles rather than grants, which is what makes
 * joining a firm stop meaning "reach every client": an engagement staffed
 * `assigned_only` will not entitle the newcomer, so `reconcile` grants them
 * nothing there and the count comes back lower.
 */
export async function grantAtLiveEngagements(
  tx: Executor,
  practiceId: string,
  userId: string,
  _defaultRole: Role,
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
    const result = await reconcileEngagementMemberships(tx, engagement)
    if (result.entitled.includes(userId)) granted += 1
  }
  return granted
}

export type EngagementRow = typeof practiceEngagements.$inferSelect

/**
 * Who the firm's arrangement says should be on this client's books.
 *
 * The one place that decides, and every path goes through it — accepting an
 * engagement, somebody joining the firm, an assignment made or withdrawn, the
 * staffing mode changed. Four call sites deciding this separately is four
 * chances for "who can see these books" to be answered differently, and the
 * one that matters is whichever ran last.
 *
 * Roles resolve in one direction only: an assignment may narrow a member's
 * default, and the engagement's cap narrows whatever comes out. Nothing here
 * can widen anything, which is why the client's decision is safe to store once
 * and never re-check.
 */
export async function entitledStaff(
  tx: Executor,
  engagement: Pick<EngagementRow, 'id' | 'practiceId' | 'grantedRole' | 'staffing'>,
): Promise<Array<{ userId: string; role: Role }>> {
  const [members, assignments] = await Promise.all([
    tx
      .select({ userId: practiceMembers.userId, defaultRole: practiceMembers.defaultRole })
      .from(practiceMembers)
      .where(
        and(
          eq(practiceMembers.practiceId, engagement.practiceId),
          eq(practiceMembers.isActive, true),
        ),
      ),
    tx
      .select({ userId: engagementAssignments.userId, role: engagementAssignments.role })
      .from(engagementAssignments)
      .where(eq(engagementAssignments.engagementId, engagement.id)),
  ])

  const assigned = new Map(assignments.map((row) => [row.userId, row.role]))

  // An assignment for somebody who has left the firm entitles nobody. The row
  // is left alone rather than deleted — removing a member already removes
  // their memberships, and a stale assignment row that grants nothing is
  // better than one deleted by a path that was not asked to.
  const eligible =
    engagement.staffing === 'assigned_only'
      ? members.filter((member) => assigned.has(member.userId))
      : members

  return eligible.map((member) => {
    const override = assigned.get(member.userId) ?? null
    const wanted = (override ?? member.defaultRole) as Role
    return { userId: member.userId, role: narrowerOf(wanted, engagement.grantedRole as Role) }
  })
}

/**
 * Makes the memberships match the arrangement.
 *
 * Grants what should exist, and removes what this engagement created for
 * somebody who is no longer entitled. Only ever touches rows carrying this
 * engagement's id — a person the client hired directly keeps their own
 * membership, which is the same rule `grantMembership` and `endEngagement`
 * already follow and the reason both check.
 *
 * Revocation takes effect on the **next request**, because `resolveSession`
 * re-reads the membership every time (Phase 13). Nobody keeps access until a
 * session expires.
 */
export async function reconcileEngagementMemberships(
  tx: Executor,
  engagement: Pick<EngagementRow, 'id' | 'companyId' | 'practiceId' | 'grantedRole' | 'staffing'>,
): Promise<{ entitled: string[]; granted: number; revoked: number }> {
  const entitled = await entitledStaff(tx, engagement)
  const keep = new Set(entitled.map((row) => row.userId))

  // Read before writing, so `granted` can mean *newly* granted. Counting the
  // writes instead would report "2 people granted" on a reconcile that gave
  // one person access and rewrote an unchanged row for somebody who already
  // had it — and the number a permissions screen shows has to be the number of
  // people whose access actually changed.
  const existing = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.practiceEngagementId, engagement.id))

  const held = new Map(existing.map((row) => [row.userId, row.role as Role]))

  let granted = 0
  for (const row of entitled) {
    const before = held.get(row.userId)
    const wrote = await grantMembership(tx, engagement, row.userId, row.role)
    if (wrote && before !== row.role) granted += 1
  }

  const stale = existing.filter((row) => !keep.has(row.userId))

  let revoked = 0
  if (stale.length > 0) {
    const removed = await tx
      .delete(memberships)
      .where(
        inArray(
          memberships.id,
          stale.map((row) => row.id),
        ),
      )
      .returning({ id: memberships.id })

    revoked = removed.length
  }

  return { entitled: [...keep], granted, revoked }
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
      staffing: practiceEngagements.staffing,
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
  /**
   * How the firm staffs this engagement (Phase 25).
   *
   * Shown to the client because it is the difference between "everybody at
   * Hartley & Co can read your ledger" and "these two people can" — and the
   * client cannot tell those apart from a list of names alone.
   */
  viaStaffing: 'whole_firm' | 'assigned_only' | null
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
      staffing: practiceEngagements.staffing,
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
    viaStaffing: row.staffing,
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

// --- Who is on which client's books (Phase 25) -------------------------------

/**
 * Loads an engagement a practice owner is entitled to change.
 *
 * Only a practice owner, and only their own firm's engagement. The client does
 * not choose which of the firm's people work on their books — they chose the
 * firm and capped its role, and picking staff is the firm's job. What the
 * client keeps is the cap, and the ability to end the whole thing.
 */
async function engagementForOwner(
  tx: Executor,
  engagementId: string,
  userId: string,
): Promise<EngagementRow> {
  const [engagement] = await tx
    .select()
    .from(practiceEngagements)
    .where(eq(practiceEngagements.id, engagementId))
    .limit(1)

  if (!engagement) throw new PracticeError('That engagement does not exist.')
  await requirePracticeOwner(engagement.practiceId, userId, tx)
  return engagement
}

export type StaffingRow = {
  userId: string
  name: string
  email: string
  practiceRole: string
  defaultRole: Role
  /** True when this person is named on this engagement. */
  isAssigned: boolean
  /** The assignment's narrower role, when one was set. */
  assignedRole: Role | null
  /** What they would actually hold at the client, after every narrowing. */
  effectiveRole: Role | null
  note: string | null
}

/**
 * Everybody at the firm, and where each of them stands on this client.
 *
 * The whole firm rather than the assigned, because the screen this feeds is
 * for *changing* the answer — a list of the people already on it cannot show
 * you who else there is.
 */
export async function staffingFor(
  engagementId: string,
  userId: string,
): Promise<{ engagement: EngagementRow; staff: StaffingRow[] }> {
  const engagement = await engagementForOwner(db, engagementId, userId)

  const [members, assignments] = await Promise.all([
    db
      .select({
        userId: practiceMembers.userId,
        name: users.name,
        email: users.email,
        practiceRole: practiceMembers.practiceRole,
        defaultRole: practiceMembers.defaultRole,
      })
      .from(practiceMembers)
      .innerJoin(users, eq(users.id, practiceMembers.userId))
      .where(
        and(
          eq(practiceMembers.practiceId, engagement.practiceId),
          eq(practiceMembers.isActive, true),
        ),
      )
      .orderBy(asc(users.name)),
    db
      .select({
        userId: engagementAssignments.userId,
        role: engagementAssignments.role,
        note: engagementAssignments.note,
      })
      .from(engagementAssignments)
      .where(eq(engagementAssignments.engagementId, engagementId)),
  ])

  const assigned = new Map(assignments.map((row) => [row.userId, row]))

  return {
    engagement,
    staff: members.map((member) => {
      const assignment = assigned.get(member.userId)
      const entitled = engagement.staffing === 'whole_firm' || assignment !== undefined
      const wanted = (assignment?.role ?? member.defaultRole) as Role

      return {
        userId: member.userId,
        name: member.name,
        email: member.email,
        practiceRole: member.practiceRole,
        defaultRole: member.defaultRole as Role,
        isAssigned: assignment !== undefined,
        assignedRole: (assignment?.role ?? null) as Role | null,
        effectiveRole: entitled ? narrowerOf(wanted, engagement.grantedRole as Role) : null,
        note: assignment?.note ?? null,
      }
    }),
  }
}

/**
 * Puts somebody on a client, or changes the role they hold there.
 *
 * Takes effect immediately under `assigned_only`. Under `whole_firm` it grants
 * nothing new — they already had access — but it still records the assignment,
 * which is how a firm builds the list *before* it tightens the mode rather
 * than during the outage that would otherwise follow.
 */
export async function assignToEngagement(
  actorUserId: string,
  input: { engagementId: string; userId: string; role?: Role | null; note?: string | null },
): Promise<{ granted: number; revoked: number }> {
  return db.transaction(async (tx) => {
    const engagement = await engagementForOwner(tx, input.engagementId, actorUserId)

    const [member] = await tx
      .select({ id: practiceMembers.id })
      .from(practiceMembers)
      .where(
        and(
          eq(practiceMembers.practiceId, engagement.practiceId),
          eq(practiceMembers.userId, input.userId),
          eq(practiceMembers.isActive, true),
        ),
      )
      .limit(1)

    if (!member) throw new PracticeError('That person does not work at this firm.')

    await tx
      .insert(engagementAssignments)
      .values({
        engagementId: input.engagementId,
        userId: input.userId,
        role: (input.role ?? null) as never,
        note: input.note?.trim() || null,
        assignedBy: actorUserId,
      })
      .onConflictDoUpdate({
        target: [engagementAssignments.engagementId, engagementAssignments.userId],
        set: {
          role: (input.role ?? null) as never,
          note: input.note?.trim() || null,
          assignedBy: actorUserId,
          assignedAt: new Date(),
        },
      })

    // An engagement that has not been accepted has no memberships to make
    // match; the assignment is recorded and takes effect when it is.
    if (engagement.status !== 'active') return { granted: 0, revoked: 0 }

    const result = await reconcileEngagementMemberships(tx, engagement)
    return { granted: result.granted, revoked: result.revoked }
  })
}

/**
 * Takes somebody off a client.
 *
 * Under `assigned_only` their membership goes in the same transaction, and
 * `resolveSession` re-reads on the next request — so somebody removed while
 * looking at the books loses them on their next click rather than when a
 * session happens to expire.
 */
export async function unassignFromEngagement(
  actorUserId: string,
  input: { engagementId: string; userId: string },
): Promise<{ revoked: number }> {
  return db.transaction(async (tx) => {
    const engagement = await engagementForOwner(tx, input.engagementId, actorUserId)

    const removed = await tx
      .delete(engagementAssignments)
      .where(
        and(
          eq(engagementAssignments.engagementId, input.engagementId),
          eq(engagementAssignments.userId, input.userId),
        ),
      )
      .returning({ id: engagementAssignments.id })

    if (removed.length === 0) throw new PracticeError('They are not assigned to that client.')
    if (engagement.status !== 'active') return { revoked: 0 }

    const result = await reconcileEngagementMemberships(tx, engagement)
    return { revoked: result.revoked }
  })
}

/**
 * What changing the staffing mode would do, without doing it.
 *
 * Shown before the button, because the difference between "this tightens
 * access" and "this locks four people out of a client mid-close" is a number,
 * and a permissions change nobody could see coming is one somebody reverses in
 * a panic.
 */
export async function staffingChangePreview(
  engagementId: string,
  userId: string,
  staffing: 'whole_firm' | 'assigned_only',
): Promise<{ wouldGrant: number; wouldRevoke: number; assigned: number }> {
  const engagement = await engagementForOwner(db, engagementId, userId)

  const entitled = await entitledStaff(db, { ...engagement, staffing })
  const keep = new Set(entitled.map((row) => row.userId))

  const existing = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.practiceEngagementId, engagementId))

  const held = new Set(existing.map((row) => row.userId))

  return {
    wouldGrant: entitled.filter((row) => !held.has(row.userId)).length,
    wouldRevoke: existing.filter((row) => !keep.has(row.userId)).length,
    assigned: keep.size,
  }
}

/**
 * Switches an engagement between whole-firm and assigned-only.
 *
 * Refuses to leave a live client with nobody. A firm that has accepted
 * responsibility for a set of books and then locks itself out of them has not
 * tightened its security — it has created an incident, and the way out is a
 * client who now has to go and re-invite the firm they already engaged.
 */
export async function setEngagementStaffing(
  actorUserId: string,
  input: { engagementId: string; staffing: 'whole_firm' | 'assigned_only' },
): Promise<{ granted: number; revoked: number; staffing: string }> {
  return db.transaction(async (tx) => {
    const engagement = await engagementForOwner(tx, input.engagementId, actorUserId)

    const next = { ...engagement, staffing: input.staffing }
    const entitled = await entitledStaff(tx, next)

    if (engagement.status === 'active' && entitled.length === 0) {
      throw new PracticeError(
        'Assign somebody to this client first — switching now would leave nobody at the firm able to open their books.',
      )
    }

    await tx
      .update(practiceEngagements)
      .set({ staffing: input.staffing })
      .where(eq(practiceEngagements.id, input.engagementId))

    if (engagement.status !== 'active') {
      return { granted: 0, revoked: 0, staffing: input.staffing }
    }

    const result = await reconcileEngagementMemberships(tx, next)
    return { granted: result.granted, revoked: result.revoked, staffing: input.staffing }
  })
}
