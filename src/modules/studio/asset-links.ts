import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  assetLinks,
  assets,
  campaigns,
  contacts,
  customers,
  opportunities,
  organizations,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import {
  ASSET_SUBJECTS,
  assetSubjectFor,
  subjectAssignment,
  subjectOf,
  type AssetSubjectKind,
  type AssetSubjectRef,
} from './asset-subjects'

/**
 * Associating a creative asset with the record it is about (Phase 180, §8).
 *
 * ## What this module does not do
 *
 * It does not prove the subject exists, and it does not prove the subject is
 * the caller's. Both are composite foreign keys carrying the tenant, so the
 * database refuses a link to another company's campaign and a link to a uuid
 * that names nothing — and a check here would be a second copy of the rule,
 * which Phase 116's device says is the thing to avoid rather than the thing to
 * add.
 *
 * It is worth being precise about the difference from `modules/evidence`, which
 * *does* carry that proof in `requireSubject`. There the reference is
 * polymorphic and has no key, so the code is the only thing that can check. The
 * check is not duplicated here because here it is not needed, and that
 * asymmetry is the whole argument of the migration.
 *
 * What is left is the two things the database cannot do: refuse the act to
 * somebody without the permission, and turn the driver's constraint violation
 * into a sentence a person can act on (Phase 119).
 */

/** How many links one record may carry, so a bulk mistake is bounded. */
export const MAX_LINKS_PER_SUBJECT = 200

const SUBJECT_COLUMNS = {
  campaign: assetLinks.campaignId,
  contact: assetLinks.contactId,
  organization: assetLinks.organizationId,
  opportunity: assetLinks.opportunityId,
  customer: assetLinks.customerId,
} as const satisfies Record<AssetSubjectKind, unknown>

/**
 * Turns the database's refusal into a sentence about the record.
 *
 * Every one of these is a real state a person can reach from a screen, and the
 * driver's own message names a constraint rather than a thing. The constraint
 * name is on the error's `cause`, not its message — which is the detail that
 * made two assertions in Phase 177 pass against the wrong constraint.
 */
function explain(error: unknown, ref: AssetSubjectRef): never {
  const constraint = (error as { cause?: { constraint_name?: string } }).cause?.constraint_name
  const subject = assetSubjectFor(ref.kind)

  if (constraint === `asset_links_${ref.kind === 'organization' ? 'organization' : ref.kind}_fkey`) {
    throw new Refusal(
      `That ${subject.label.toLowerCase()} is not on this company's books, so nothing can be ` +
        'associated with it. It may have been deleted, or the link may have come from another ' +
        'window that is now out of date.',
    )
  }

  if (constraint === 'asset_links_asset_fkey') {
    throw new Refusal(
      'That asset no longer exists. Re-upload it and associate the new one — a link cannot ' +
        'outlive the file it points at.',
    )
  }

  if (constraint?.endsWith('_unique')) {
    throw new Refusal(
      `That asset is already associated with this ${subject.label.toLowerCase()}. ` +
        'Nothing was changed.',
    )
  }

  throw error
}

/**
 * Associates an asset with one record.
 *
 * `marketing:manage` for every kind, because attaching a flyer to a contact is
 * a studio act wherever the contact lives — a person who may edit a CRM record
 * is not thereby the person who decides which collateral belongs on it.
 */
export async function linkAsset(
  ctx: ActorContext,
  input: { assetId: string; subject: AssetSubjectRef; note?: string },
): Promise<{ linkId: string }> {
  const subject = assetSubjectFor(input.subject.kind)
  requirePermission(ctx, subject.manage)

  const existing = await countForSubject(ctx, input.subject)
  if (existing >= MAX_LINKS_PER_SUBJECT) {
    throw new Refusal(
      `This ${subject.label.toLowerCase()} already has ${MAX_LINKS_PER_SUBJECT} associated ` +
        'assets, which is as many as a record is allowed. Associating everything with everything ' +
        'is the same as associating nothing — detach what is no longer relevant first.',
    )
  }

  try {
    const [row] = await db
      .insert(assetLinks)
      .values({
        companyId: ctx.companyId,
        assetId: input.assetId,
        ...subjectAssignment(input.subject),
        note: input.note?.trim() || null,
        linkedBy: ctx.userId,
      })
      .returning({ id: assetLinks.id })

    await recordAudit(ctx, {
      action: 'asset.associate',
      entityType: 'asset',
      entityId: input.assetId,
      after: { subject: input.subject.kind, subjectId: input.subject.id, note: input.note ?? null },
    })

    return { linkId: row.id }
  } catch (error) {
    explain(error, input.subject)
  }
}

export async function unlinkAsset(ctx: ActorContext, linkId: string): Promise<void> {
  const [link] = await db
    .select()
    .from(assetLinks)
    .where(scoped(ctx, assetLinks, eq(assetLinks.id, linkId)))
    .limit(1)

  if (!link) throw missing('assetLink')

  // Read first, then check: which kind it is decides which permission applies,
  // and the kind is on the row rather than in the request.
  const ref = subjectOf(link)
  requirePermission(ctx, assetSubjectFor(ref.kind).manage)

  await db
    .delete(assetLinks)
    .where(and(eq(assetLinks.companyId, ctx.companyId), eq(assetLinks.id, linkId)))

  await recordAudit(ctx, {
    action: 'asset.disassociate',
    entityType: 'asset',
    entityId: link.assetId,
    before: { subject: ref.kind, subjectId: ref.id, note: link.note },
  })
}

async function countForSubject(ctx: ActorContext, ref: AssetSubjectRef): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(assetLinks)
    .where(scoped(ctx, assetLinks, eq(SUBJECT_COLUMNS[ref.kind], ref.id)))

  return row?.total ?? 0
}

export type AssociatedAsset = {
  linkId: string
  assetId: string
  filename: string
  kind: string
  contentType: string
  sizeBytes: number
  note: string | null
  linkedAt: Date
}

/**
 * What has been sent to, or made for, one record — §8's question.
 *
 * The permission is the *subject's* `view` and not the studio's: somebody who
 * cannot see an opportunity has no business seeing what was sent against it,
 * and the asset list is a description of the relationship rather than of the
 * files.
 */
export async function assetsForSubject(
  ctx: ActorContext,
  ref: AssetSubjectRef,
): Promise<AssociatedAsset[]> {
  requirePermission(ctx, assetSubjectFor(ref.kind).view)

  const rows = await db
    .select({
      linkId: assetLinks.id,
      assetId: assets.id,
      filename: assets.filename,
      kind: assets.kind,
      contentType: assets.contentType,
      sizeBytes: assets.sizeBytes,
      note: assetLinks.note,
      linkedAt: assetLinks.createdAt,
    })
    .from(assetLinks)
    .innerJoin(
      assets,
      /*
        Joined on the tenant as well as the id. The composite key already makes
        a cross-tenant pair unstorable, so this cannot change the result today —
        it is here because Phase 169 shipped two unscoped joins that put another
        company's product name on a dashboard, and a join written the safe way
        costs nothing and survives the constraint being dropped.
      */
      and(eq(assets.companyId, assetLinks.companyId), eq(assets.id, assetLinks.assetId)),
    )
    .where(scoped(ctx, assetLinks, eq(SUBJECT_COLUMNS[ref.kind], ref.id)))
    .orderBy(desc(assetLinks.createdAt))

  return rows.map((row) => ({ ...row, kind: String(row.kind) }))
}

export type AssetAssociation = {
  linkId: string
  kind: AssetSubjectKind
  label: string
  subjectId: string
  /** What to call the record on screen. Null when the subject has no name. */
  describe: string | null
  note: string | null
}

/**
 * The other direction: every record one asset is on.
 *
 * Five joins rather than one, which is the cost of the five-column design and
 * is worth paying here: the alternative was a polymorphic `subject_id` with no
 * key, and five left joins on indexed columns against a table with at most
 * `MAX_LINKS_PER_SUBJECT` rows per record is not the query to optimise for.
 *
 * `crm:view` and not each subject's own permission, deliberately and narrowly:
 * this answers "where has this file been used", which is a question about the
 * asset. A caller who cannot see opportunities still sees that the asset is on
 * one — the label — and the subject's own screen is what refuses them the
 * detail.
 */
export async function subjectsForAsset(
  ctx: ActorContext,
  assetId: string,
): Promise<AssetAssociation[]> {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      linkId: assetLinks.id,
      campaignId: assetLinks.campaignId,
      contactId: assetLinks.contactId,
      organizationId: assetLinks.organizationId,
      opportunityId: assetLinks.opportunityId,
      customerId: assetLinks.customerId,
      note: assetLinks.note,
      campaignName: campaigns.name,
      /*
        A contact has `first_name` and `last_name` and no `name`, and an
        opportunity has `title`. Spelled out rather than assumed: the first draft
        of this query asked both for `.name` and the typecheck refused it, which
        is the compiler doing what a `describe` column in a register would
        otherwise have had to be kept in step with by hand.
      */
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      organizationName: organizations.name,
      opportunityName: opportunities.title,
      customerName: customers.name,
    })
    .from(assetLinks)
    .leftJoin(
      campaigns,
      and(eq(campaigns.companyId, assetLinks.companyId), eq(campaigns.id, assetLinks.campaignId)),
    )
    .leftJoin(
      contacts,
      and(eq(contacts.companyId, assetLinks.companyId), eq(contacts.id, assetLinks.contactId)),
    )
    .leftJoin(
      organizations,
      and(
        eq(organizations.companyId, assetLinks.companyId),
        eq(organizations.id, assetLinks.organizationId),
      ),
    )
    .leftJoin(
      opportunities,
      and(
        eq(opportunities.companyId, assetLinks.companyId),
        eq(opportunities.id, assetLinks.opportunityId),
      ),
    )
    .leftJoin(
      customers,
      and(eq(customers.companyId, assetLinks.companyId), eq(customers.id, assetLinks.customerId)),
    )
    .where(scoped(ctx, assetLinks, eq(assetLinks.assetId, assetId)))
    .orderBy(desc(assetLinks.createdAt))

  const describe: Record<AssetSubjectKind, (row: (typeof rows)[number]) => string | null> = {
    campaign: (row) => row.campaignName,
    // Joined from two columns, and trimmed to null rather than to a space: a
    // contact with neither name is a record somebody half-created, and "" on a
    // screen reads as a rendering bug rather than as missing data.
    contact: (row) => [row.contactFirstName, row.contactLastName].filter(Boolean).join(' ') || null,
    organization: (row) => row.organizationName,
    opportunity: (row) => row.opportunityName,
    customer: (row) => row.customerName,
  }

  return rows.map((row) => {
    const ref = subjectOf(row)
    return {
      linkId: row.linkId,
      kind: ref.kind,
      label: assetSubjectFor(ref.kind).label,
      subjectId: ref.id,
      describe: describe[ref.kind](row),
      note: row.note,
    }
  })
}

/**
 * How many assets each of several records carries, for a list screen.
 *
 * One query rather than one per row, because the natural caller is a table of
 * organisations and the natural mistake is a count inside the loop.
 */
export async function assetCountsForSubjects(
  ctx: ActorContext,
  kind: AssetSubjectKind,
  subjectIds: string[],
): Promise<Map<string, number>> {
  requirePermission(ctx, assetSubjectFor(kind).view)
  if (subjectIds.length === 0) return new Map()

  const column = SUBJECT_COLUMNS[kind]

  const rows = await db
    .select({ subjectId: column, total: sql<number>`count(*)::int` })
    .from(assetLinks)
    .where(scoped(ctx, assetLinks, inArray(column, subjectIds)))
    .groupBy(column)

  return new Map(
    rows
      .filter((row): row is { subjectId: string; total: number } => row.subjectId !== null)
      .map((row) => [row.subjectId, row.total]),
  )
}

/** The five kinds, for a picker. Ordered as §8 names them. */
export function associableKinds(): { kind: AssetSubjectKind; label: string }[] {
  return ASSET_SUBJECTS.map((subject) => ({ kind: subject.kind, label: subject.label }))
}
