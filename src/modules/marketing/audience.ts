import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { contacts, opportunities, organizations, segments, suppressions } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  isContactable,
  matchesSegment,
  parseDefinition,
  segmentDefinitionSchema,
  type SegmentCandidate,
  type SegmentDefinition,
} from './segments'

/**
 * Segment persistence and evaluation (spec §10).
 *
 * Segments are evaluated on demand rather than materialized: an audience built
 * three weeks ago should reflect who qualifies today, not who qualified then.
 */

/**
 * Loads every contact with the fields a segment can filter on.
 *
 * Opportunity history is derived in SQL so a company with thousands of
 * contacts does not pull its whole pipeline into memory to answer "have we
 * ever won work here".
 */
export async function loadCandidates(companyId: string): Promise<SegmentCandidate[]> {
  const rows = await db
    .select({
      contactId: contacts.id,
      email: contacts.email,
      emailConsent: contacts.emailConsent,
      suppressedAt: contacts.suppressedAt,
      organizationId: contacts.organizationId,
      organizationName: organizations.name,
      lifecycleStage: organizations.lifecycleStage,
      industry: organizations.industry,
      region: organizations.region,
      sizeBand: organizations.sizeBand,
      source: organizations.source,
      isStrategicAccount: organizations.isStrategicAccount,
      tags: organizations.tags,
      wonCount: sql<string>`(
        SELECT count(*) FROM ${opportunities} o
        WHERE o.organization_id = ${organizations.id} AND o.stage = 'won'
      )`,
      openCount: sql<string>`(
        SELECT count(*) FROM ${opportunities} o
        WHERE o.organization_id = ${organizations.id}
          AND o.stage NOT IN ('won', 'lost', 'dormant')
      )`,
      lostCount: sql<string>`(
        SELECT count(*) FROM ${opportunities} o
        WHERE o.organization_id = ${organizations.id} AND o.stage IN ('lost', 'dormant')
      )`,
      eligibleCount: sql<string>`(
        SELECT count(*) FROM ${opportunities} o
        WHERE o.organization_id = ${organizations.id}
          AND o.stage IN ('lost', 'dormant')
          AND o.marketing_eligible = true
      )`,
    })
    .from(contacts)
    .leftJoin(organizations, eq(organizations.id, contacts.organizationId))
    .where(eq(contacts.companyId, companyId))

  return rows.map((row) => ({
    contactId: row.contactId,
    email: row.email,
    emailConsent: row.emailConsent,
    suppressedAt: row.suppressedAt,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    lifecycleStage: row.lifecycleStage,
    industry: row.industry,
    region: row.region,
    sizeBand: row.sizeBand,
    source: row.source,
    isStrategicAccount: row.isStrategicAccount ?? false,
    tags: row.tags ?? [],
    // Most advanced outcome wins: a won deal describes the relationship better
    // than an old loss does.
    opportunityHistory:
      Number(row.wonCount) > 0
        ? 'won'
        : Number(row.openCount) > 0
          ? 'open'
          : Number(row.lostCount) > 0
            ? 'lost'
            : 'none',
    marketingEligible: Number(row.eligibleCount) > 0,
  }))
}

export type AudienceMember = SegmentCandidate & {
  contactable: boolean
  reason?: 'no_email' | 'no_consent' | 'suppressed'
}

/**
 * Evaluates a segment definition into an audience.
 *
 * Non-contactable members are returned too, with a reason — a marketer needs
 * to see that 200 people match but only 40 may be emailed, rather than being
 * shown 40 and left to wonder.
 */
export async function evaluateSegment(
  ctx: ActorContext,
  definition: SegmentDefinition,
): Promise<AudienceMember[]> {
  requirePermission(ctx, 'marketing:view')

  const candidates = await loadCandidates(ctx.companyId)
  const suppressed = await suppressedEmails(ctx.companyId)

  return candidates
    .filter((candidate) => matchesSegment(definition, candidate))
    .map((candidate) => {
      const check = isContactable(candidate)

      // A company-wide suppression outranks the contact's own consent flag.
      if (check.ok && candidate.email && suppressed.has(candidate.email.toLowerCase())) {
        return { ...candidate, contactable: false, reason: 'suppressed' as const }
      }

      return { ...candidate, contactable: check.ok, reason: check.reason }
    })
}

/** Every suppressed address for a company, lower-cased. */
export async function suppressedEmails(companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(eq(suppressions.companyId, companyId))

  return new Set(rows.map((row) => row.email.toLowerCase()))
}

export async function createSegment(
  ctx: ActorContext,
  input: { name: string; description?: string; definition: unknown },
) {
  requirePermission(ctx, 'marketing:manage')

  const definition = segmentDefinitionSchema.parse(input.definition)

  return db.transaction(async (tx) => {
    const [segment] = await tx
      .insert(segments)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        description: input.description ?? null,
        definition,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'segment.create',
        entityType: 'segment',
        entityId: segment.id,
        after: { name: segment.name, ruleCount: definition.rules.length },
      },
      tx,
    )

    return segment
  })
}

export async function updateSegment(
  ctx: ActorContext,
  segmentId: string,
  input: { name?: string; description?: string; definition?: unknown },
) {
  requirePermission(ctx, 'marketing:manage')

  const definition =
    input.definition === undefined ? undefined : segmentDefinitionSchema.parse(input.definition)

  return db.transaction(async (tx) => {
    const [segment] = await tx
      .update(segments)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(definition ? { definition } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(segments.id, segmentId), eq(segments.companyId, ctx.companyId)))
      .returning()

    if (!segment) throw new Error('Segment not found')

    await recordAudit(
      ctx,
      {
        action: 'segment.update',
        entityType: 'segment',
        entityId: segment.id,
        after: { name: segment.name },
      },
      tx,
    )

    return segment
  })
}

export async function listSegments(ctx: ActorContext) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select()
    .from(segments)
    .where(scoped(ctx, segments))
    .orderBy(asc(segments.name))
}

export async function getSegment(ctx: ActorContext, segmentId: string) {
  requirePermission(ctx, 'marketing:view')

  const [segment] = await db
    .select()
    .from(segments)
    .where(scoped(ctx, segments, eq(segments.id, segmentId)))
    .limit(1)

  return segment ?? null
}

/** Headline counts for a segment, for the builder's live preview. */
export async function segmentSummary(ctx: ActorContext, definition: SegmentDefinition) {
  const audience = await evaluateSegment(ctx, definition)

  return {
    total: audience.length,
    contactable: audience.filter((member) => member.contactable).length,
    noConsent: audience.filter((member) => member.reason === 'no_consent').length,
    suppressed: audience.filter((member) => member.reason === 'suppressed').length,
    noEmail: audience.filter((member) => member.reason === 'no_email').length,
  }
}

// --- Suppression -----------------------------------------------------------

/**
 * Adds an address to the company-wide suppression list.
 *
 * Idempotent, and it also marks any matching contacts suppressed so the CRM
 * shows the same truth the send pipeline enforces.
 */
export async function suppressEmail(
  companyId: string,
  email: string,
  input: { reason: string; campaignId?: string | null; notes?: string },
) {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return

  await db.transaction(async (tx) => {
    await tx
      .insert(suppressions)
      .values({
        companyId,
        email: normalized,
        reason: input.reason,
        campaignId: input.campaignId ?? null,
        notes: input.notes ?? null,
      })
      .onConflictDoNothing()

    await tx
      .update(contacts)
      .set({ suppressedAt: new Date(), emailConsent: 'unsubscribed', updatedAt: new Date() })
      .where(
        and(
          eq(contacts.companyId, companyId),
          sql`lower(${contacts.email}) = ${normalized}`,
        ),
      )
  })
}

export async function listSuppressions(ctx: ActorContext, limit = 100) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select()
    .from(suppressions)
    .where(scoped(ctx, suppressions))
    .orderBy(desc(suppressions.createdAt))
    .limit(limit)
}

/** Removes a suppression, for a person who asks to be re-subscribed. */
export async function unsuppressEmail(ctx: ActorContext, email: string) {
  requirePermission(ctx, 'marketing:manage')

  const normalized = email.trim().toLowerCase()

  await db.transaction(async (tx) => {
    await tx
      .delete(suppressions)
      .where(
        and(eq(suppressions.companyId, ctx.companyId), eq(suppressions.email, normalized)),
      )

    // Consent is not restored — that is the person's to give, not ours to
    // assume. Only the hard block is lifted.
    await tx
      .update(contacts)
      .set({ suppressedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.companyId, ctx.companyId),
          sql`lower(${contacts.email}) = ${normalized}`,
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'suppression.remove',
        entityType: 'suppression',
        entityId: null,
        after: { email: normalized },
      },
      tx,
    )
  })
}

export { parseDefinition }
