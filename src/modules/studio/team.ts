import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { teamMembers } from '@/db/schema'
import type { Block } from '@/modules/design/blocks'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * The firm's people (spec §15, Phase 183).
 *
 * §15's second bullet lists `team bios` between the service catalog and the
 * company's certifications. ADR 0173 measured it as having nothing behind it,
 * and the measurement held: `company_profiles.credentials` covers licences,
 * certifications, insurance and memberships, and a bio had no column anywhere.
 *
 * ## Why these are not `users`
 *
 * A bio is marketing copy about a person, not an account. Hanging it off
 * `memberships` is wrong in both directions — a founding principal who never
 * signs in still goes on the capability statement, and a bookkeeper with a login
 * does not. `userId` is optional so a bio can *name* the account it describes
 * where there is one, which is what a future "write your own bio" screen needs
 * without making every bio an account.
 *
 * ## Retired, not deleted
 *
 * The clause library's argument, which applies exactly: a proposal sent last
 * year named the people who were going to do the work, and somebody leaving must
 * not change what a client was shown. The `team` block stores member ids, so
 * deleting the row would either break an old document or silently drop a name
 * from it.
 *
 * `retireMember` is therefore the operation, and a real delete is only offered
 * for a member no document names — which is a question the block's ids make
 * answerable and a `jsonb` array would not have.
 */

/** How many people a firm may list. Generous; a bound rather than a judgement. */
export const MAX_TEAM_MEMBERS = 100

export type TeamMemberInput = {
  name: string
  title?: string | null
  bio?: string | null
  qualifications?: string | null
  email?: string | null
  phone?: string | null
  headshotAssetId?: string | null
}

const trimmed = (value: string | null | undefined) => value?.trim() || null

export async function addTeamMember(
  ctx: ActorContext,
  input: TeamMemberInput,
): Promise<{ id: string }> {
  requirePermission(ctx, 'company:manage')

  const name = input.name.trim()
  if (!name) {
    // Checked here as well as by the CHECK, so the person gets a sentence
    // rather than a constraint name. The constraint is what makes it true.
    throw new Refusal('A team member needs a name.')
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(scoped(ctx, teamMembers))

  if (total >= MAX_TEAM_MEMBERS) {
    throw new Refusal(
      `This company already lists ${MAX_TEAM_MEMBERS} people, which is as many as the directory ` +
        'holds. Retire somebody who has left — retiring keeps them on the proposals that named ' +
        'them.',
    )
  }

  const [row] = await db
    .insert(teamMembers)
    .values({
      companyId: ctx.companyId,
      name,
      title: trimmed(input.title),
      bio: trimmed(input.bio),
      qualifications: trimmed(input.qualifications),
      email: trimmed(input.email),
      phone: trimmed(input.phone),
      headshotAssetId: input.headshotAssetId ?? null,
      // Appended rather than inserted: somebody decides the order, and the
      // default for a new person is "last" rather than "wherever".
      sortOrder: total,
    })
    .returning({ id: teamMembers.id })

  await recordAudit(ctx, {
    action: 'team_member.create',
    entityType: 'team_member',
    entityId: row.id,
    after: { name, title: trimmed(input.title) },
  })

  return { id: row.id }
}

export async function updateTeamMember(
  ctx: ActorContext,
  memberId: string,
  input: Partial<TeamMemberInput>,
): Promise<void> {
  requirePermission(ctx, 'company:manage')

  const member = await loadMember(ctx, memberId)

  if (input.name !== undefined && !input.name.trim()) {
    throw new Refusal('A team member needs a name.')
  }

  await db
    .update(teamMembers)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.title !== undefined ? { title: trimmed(input.title) } : {}),
      ...(input.bio !== undefined ? { bio: trimmed(input.bio) } : {}),
      ...(input.qualifications !== undefined
        ? { qualifications: trimmed(input.qualifications) }
        : {}),
      ...(input.email !== undefined ? { email: trimmed(input.email) } : {}),
      ...(input.phone !== undefined ? { phone: trimmed(input.phone) } : {}),
      ...(input.headshotAssetId !== undefined
        ? { headshotAssetId: input.headshotAssetId }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(teamMembers.companyId, ctx.companyId), eq(teamMembers.id, memberId)))

  await recordAudit(ctx, {
    action: 'team_member.update',
    entityType: 'team_member',
    entityId: memberId,
    before: { name: member.name, title: member.title },
    after: { name: input.name?.trim() ?? member.name },
  })
}

/**
 * Takes somebody out of the directory without taking them off old documents.
 *
 * The operation, rather than a delete. A proposal that named them keeps naming
 * them, because the block holds the id and the row survives — which is the whole
 * reason this is a table.
 */
export async function retireTeamMember(ctx: ActorContext, memberId: string): Promise<void> {
  requirePermission(ctx, 'company:manage')

  const member = await loadMember(ctx, memberId)
  if (!member.isActive) {
    throw new Refusal(`${member.name} is already retired from the team directory.`)
  }

  await db
    .update(teamMembers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(teamMembers.companyId, ctx.companyId), eq(teamMembers.id, memberId)))

  await recordAudit(ctx, {
    action: 'team_member.retire',
    entityType: 'team_member',
    entityId: memberId,
    before: { isActive: true },
    after: { isActive: false },
  })
}

export async function restoreTeamMember(ctx: ActorContext, memberId: string): Promise<void> {
  requirePermission(ctx, 'company:manage')

  await loadMember(ctx, memberId)

  await db
    .update(teamMembers)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(teamMembers.companyId, ctx.companyId), eq(teamMembers.id, memberId)))

  await recordAudit(ctx, {
    action: 'team_member.restore',
    entityType: 'team_member',
    entityId: memberId,
    after: { isActive: true },
  })
}

/**
 * Puts the directory in an order somebody chose.
 *
 * Takes the whole list rather than a move: two members swapping places is one
 * decision, and an endpoint that moved one of them would need the caller to
 * send the second request or leave the order wrong.
 */
export async function reorderTeamMembers(ctx: ActorContext, orderedIds: string[]): Promise<void> {
  requirePermission(ctx, 'company:manage')

  const mine = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(scoped(ctx, teamMembers))

  const known = new Set(mine.map((row) => row.id))
  const unknown = orderedIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Refusal(
      'That order names somebody who is not on this company\'s team, so nothing was changed. ' +
        'Reload the page — the list has probably been edited in another window.',
    )
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(teamMembers)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(and(eq(teamMembers.companyId, ctx.companyId), eq(teamMembers.id, id)))
    }
  })
}

async function loadMember(ctx: ActorContext, memberId: string, exec: Executor = db) {
  const [member] = await exec
    .select()
    .from(teamMembers)
    .where(scoped(ctx, teamMembers, eq(teamMembers.id, memberId)))
    .limit(1)

  if (!member) throw missing('teamMember')
  return member
}

/**
 * The directory.
 *
 * `company:view` rather than `company:manage`: a bio is the company talking
 * about itself, and anybody who can see the brand kit can see who is on the
 * team. Retired members are included only when asked for, because the common
 * read is "who do we put on this proposal".
 */
export async function listTeamMembers(
  ctx: ActorContext,
  opts: { includeRetired?: boolean } = {},
) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(teamMembers)
    .where(
      scoped(ctx, teamMembers, opts.includeRetired ? undefined : eq(teamMembers.isActive, true)),
    )
    .orderBy(asc(teamMembers.sortOrder), asc(teamMembers.name))
}

/** What a `team` block renders. The block holds ids; this resolves them. */
export type RenderedTeamMember = {
  id: string
  name: string
  title: string | null
  bio: string | null
  qualifications: string | null
  headshotAssetId: string | null
  /**
   * Carried into the renderers, which is not decoration.
   *
   * `selectTeam` needs it: a document's pool holds the active directory **and**
   * any retired person a block names by id, so a block with an empty selection
   * has to be able to tell those apart. Without this column the default
   * selection would quietly include somebody who left.
   */
  isActive: boolean
}

const RENDER_COLUMNS = {
  id: teamMembers.id,
  name: teamMembers.name,
  title: teamMembers.title,
  bio: teamMembers.bio,
  qualifications: teamMembers.qualifications,
  headshotAssetId: teamMembers.headshotAssetId,
  isActive: teamMembers.isActive,
}

/**
 * Every member a document could need, in one read.
 *
 * The **pool**, not a selection: the active directory plus any retired person a
 * block names by id. Retired members are included exactly because they were
 * named — a proposal sent last year still names the people who were going to do
 * the work, which is the whole reason `retireTeamMember` exists rather than a
 * delete.
 *
 * One read for the document rather than one per block, and one shape for all
 * four renderers. `selectTeam` then does the choosing, so the page, the PDF and
 * the email cannot disagree about who a block means.
 */
export async function teamForDocument(
  companyId: string,
  blocks: Block[],
  exec: Executor = db,
): Promise<RenderedTeamMember[]> {
  const named = teamIdsInBlocks(blocks)

  const rows = await exec
    .select(RENDER_COLUMNS)
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.companyId, companyId),
        named.length > 0
          ? or(eq(teamMembers.isActive, true), inArray(teamMembers.id, named))
          : eq(teamMembers.isActive, true),
      ),
    )
    .orderBy(asc(teamMembers.sortOrder), asc(teamMembers.name))

  return rows
}

/**
 * The ids every `team` block in a document names.
 *
 * Deduplicated, because two blocks naming the same principal is one row to
 * read. A block naming nobody contributes nothing here and is served by the
 * active directory the pool always carries.
 */
export function teamIdsInBlocks(blocks: Block[]): string[] {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'team') continue
    for (const id of block.memberIds) ids.add(id)
  }
  return [...ids]
}

/**
 * Who one block means, out of the document's pool.
 *
 * Pure, and shared by the page, the PDF and the email — three renderers reading
 * `memberIds` themselves is how one document becomes three documents, which is
 * the mistake the table block made in Phase 181 and the comment above
 * `TableBlock` already warns about.
 *
 * A named selection comes back **in the block's order**, not the directory's: an
 * author listing two people has said who leads this pitch, and the firm's
 * standing order is a different fact. A member whose row is gone drops out
 * rather than shifting the rest.
 */
export function selectTeam(pool: RenderedTeamMember[], memberIds: string[]): RenderedTeamMember[] {
  if (memberIds.length === 0) return pool.filter((member) => member.isActive)

  const byId = new Map(pool.map((member) => [member.id, member]))
  return memberIds.flatMap((id) => {
    const member = byId.get(id)
    return member ? [member] : []
  })
}
