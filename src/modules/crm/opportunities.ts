import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  contacts,
  opportunities,
  opportunityActivities,
  organizations,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  ORGANIZATION_FIELDS,
  auditable,
  diffParty,
  normaliseParty,
} from '@/modules/parties/changes'
import { Refusal } from '@/modules/errors'
import {
  assertStageTransition,
  isTerminal,
  requiresLossReason,
  stageLabel,
  STAGE_PROBABILITY,
  type Stage,
} from './pipeline'

/**
 * Opportunity records and pipeline movement (spec §6).
 *
 * Stage changes are recorded twice on purpose: once in the audit log for
 * accountability, and once in `opportunity_activities` as the sales-facing
 * history a person actually reads on the record.
 */

export type CreateOpportunityInput = {
  organizationId: string
  title: string
  primaryContactId?: string | null
  expectedValueCents?: number
  probability?: number
  source?: string | null
  ownerId?: string | null
  expectedCloseDate?: string | null
  stage?: Stage
  notes?: string | null
}

export async function createOpportunity(ctx: ActorContext, input: CreateOpportunityInput) {
  requirePermission(ctx, 'crm:manage')

  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(scoped(ctx, organizations, eq(organizations.id, input.organizationId)))
    .limit(1)

  if (!organization) throw new Error('Organization not found')

  const stage = input.stage ?? 'new_inquiry'

  return db.transaction(async (tx) => {
    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        companyId: ctx.companyId,
        organizationId: input.organizationId,
        primaryContactId: input.primaryContactId ?? null,
        title: input.title,
        stage,
        expectedValueCents: input.expectedValueCents ?? 0,
        probability: input.probability ?? STAGE_PROBABILITY[stage],
        probabilityOverridden: input.probability !== undefined,
        source: input.source ?? null,
        ownerId: input.ownerId ?? ctx.userId,
        expectedCloseDate: input.expectedCloseDate ?? null,
        notes: input.notes ?? null,
      })
      .returning()

    await logActivity(
      ctx,
      opportunity.id,
      { kind: 'created', summary: `Opportunity created at ${stageLabel(stage)}` },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'opportunity.create',
        entityType: 'opportunity',
        entityId: opportunity.id,
        after: { title: opportunity.title, stage, expectedValueCents: opportunity.expectedValueCents },
      },
      tx,
    )

    return opportunity
  })
}

export type StageChangeInput = {
  stage: Stage
  lossReason?: 'price' | 'timing' | 'competitor' | 'no_response' | 'scope' | 'internal_cancellation' | 'other'
  lossNotes?: string
}

/**
 * Moves an opportunity to a new stage (spec §6).
 *
 * Closing as lost or dormant requires a structured reason, because spec §9
 * reports on loss reasons and a free-text field would not aggregate.
 *
 * Marketing eligibility is decided here rather than in Phase 5: at close, the
 * contact's consent is known, so the answer is recorded once instead of being
 * re-derived later against consent that may since have changed.
 */
export async function changeStage(
  ctx: ActorContext,
  opportunityId: string,
  input: StageChangeInput,
) {
  requirePermission(ctx, 'crm:manage')

  const opportunity = await loadOpportunity(ctx, opportunityId)
  assertStageTransition(opportunity.stage, input.stage)

  if (requiresLossReason(input.stage) && !input.lossReason) {
    throw new Refusal(
      `Closing as ${stageLabel(input.stage)} needs a loss reason so it can be reported on.`,
    )
  }

  const closing = isTerminal(input.stage)
  const marketingEligible = closing ? await contactAllowsMarketing(ctx, opportunity) : false

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(opportunities)
      .set({
        stage: input.stage,
        // The probability tracks the stage unless someone has set it by hand.
        // Closing always wins regardless: won and lost are certainties, not
        // estimates, so a stale manual figure must not survive them.
        probability:
          closing || !opportunity.probabilityOverridden
            ? STAGE_PROBABILITY[input.stage]
            : opportunity.probability,
        closedAt: closing ? new Date() : null,
        lossReason: input.stage === 'won' ? null : (input.lossReason ?? null),
        lossNotes: input.stage === 'won' ? null : (input.lossNotes ?? null),
        marketingEligible,
        updatedAt: new Date(),
      })
      .where(
        and(eq(opportunities.id, opportunityId), eq(opportunities.companyId, ctx.companyId)),
      )
      .returning()

    await logActivity(
      ctx,
      opportunityId,
      {
        kind: 'stage_change',
        summary: `${stageLabel(opportunity.stage)} → ${stageLabel(input.stage)}`,
        detail: { from: opportunity.stage, to: input.stage, lossReason: input.lossReason },
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'opportunity.stage_change',
        entityType: 'opportunity',
        entityId: opportunityId,
        before: { stage: opportunity.stage },
        after: { stage: input.stage, lossReason: input.lossReason ?? null, marketingEligible },
      },
      tx,
    )

    return updated
  })
}

/**
 * Reopens a closed opportunity, which is the only way out of a terminal stage.
 *
 * Deliberately explicit rather than allowing a stage edit: a won opportunity
 * has already created a client and a job, and reopening should be a decision
 * someone made on purpose.
 */
export async function reopenOpportunity(ctx: ActorContext, opportunityId: string, stage: Stage) {
  requirePermission(ctx, 'crm:manage')

  const opportunity = await loadOpportunity(ctx, opportunityId)
  if (!isTerminal(opportunity.stage)) {
    throw new Refusal('That opportunity is not closed.')
  }
  if (isTerminal(stage)) {
    throw new Refusal('Reopen to an active stage, not another closed one.')
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(opportunities)
      .set({
        stage,
        // Reopening discards the certainty a close imposed and returns the
        // probability to tracking the stage.
        probability: STAGE_PROBABILITY[stage],
        probabilityOverridden: false,
        closedAt: null,
        lossReason: null,
        lossNotes: null,
        marketingEligible: false,
        updatedAt: new Date(),
      })
      .where(
        and(eq(opportunities.id, opportunityId), eq(opportunities.companyId, ctx.companyId)),
      )
      .returning()

    await logActivity(
      ctx,
      opportunityId,
      {
        kind: 'reopened',
        summary: `Reopened from ${stageLabel(opportunity.stage)} to ${stageLabel(stage)}`,
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'opportunity.reopen',
        entityType: 'opportunity',
        entityId: opportunityId,
        before: { stage: opportunity.stage },
        after: { stage },
      },
      tx,
    )

    return updated
  })
}

export async function updateOpportunity(
  ctx: ActorContext,
  opportunityId: string,
  input: Partial<Pick<CreateOpportunityInput, 'title' | 'expectedValueCents' | 'probability' | 'source' | 'ownerId' | 'expectedCloseDate' | 'notes' | 'primaryContactId'>>,
) {
  requirePermission(ctx, 'crm:manage')

  const opportunity = await loadOpportunity(ctx, opportunityId)

  if (input.probability !== undefined && (input.probability < 0 || input.probability > 100)) {
    throw new Refusal('Probability must be between 0 and 100.')
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(opportunities)
      .set({
        ...input,
        // Setting a probability by hand stops it tracking the stage default.
        ...(input.probability !== undefined ? { probabilityOverridden: true } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(opportunities.id, opportunityId), eq(opportunities.companyId, ctx.companyId)),
      )
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'opportunity.update',
        entityType: 'opportunity',
        entityId: opportunityId,
        before: {
          title: opportunity.title,
          expectedValueCents: opportunity.expectedValueCents,
          probability: opportunity.probability,
        },
        after: input as Record<string, unknown>,
      },
      tx,
    )

    return updated
  })
}

/** Whether a closed opportunity's contact may be marketed to (spec §6, §10). */
async function contactAllowsMarketing(
  ctx: ActorContext,
  opportunity: typeof opportunities.$inferSelect,
): Promise<boolean> {
  if (!opportunity.primaryContactId) return false

  const [contact] = await db
    .select()
    .from(contacts)
    .where(scoped(ctx, contacts, eq(contacts.id, opportunity.primaryContactId)))
    .limit(1)

  if (!contact) return false
  // Suppression always wins, and only explicit consent qualifies.
  if (contact.suppressedAt) return false
  return contact.emailConsent === 'subscribed'
}

/** Appends to the sales-facing activity history (spec §6). */
export async function logActivity(
  ctx: ActorContext,
  opportunityId: string,
  input: { kind: string; summary: string; detail?: Record<string, unknown> },
  exec: Executor = db,
) {
  await exec.insert(opportunityActivities).values({
    companyId: ctx.companyId,
    opportunityId,
    kind: input.kind,
    summary: input.summary,
    detail: input.detail ?? null,
    createdBy: ctx.userId,
    actorName: ctx.userName,
  })
}

export async function activityFor(ctx: ActorContext, opportunityId: string) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(opportunityActivities)
    .where(
      scoped(ctx, opportunityActivities, eq(opportunityActivities.opportunityId, opportunityId)),
    )
    .orderBy(desc(opportunityActivities.occurredAt))
}

async function loadOpportunity(ctx: ActorContext, opportunityId: string) {
  const [opportunity] = await db
    .select()
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  if (!opportunity) throw new Error('Opportunity not found')
  return opportunity
}

export async function getOpportunity(ctx: ActorContext, opportunityId: string) {
  requirePermission(ctx, 'crm:view')

  const [row] = await db
    .select({
      opportunity: opportunities,
      organizationName: organizations.name,
      organizationId: organizations.id,
    })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  return row ?? null
}

/** Pipeline listing, optionally filtered by stage. */
export async function listOpportunities(
  ctx: ActorContext,
  opts: { stages?: Stage[]; ownerId?: string; limit?: number } = {},
) {
  requirePermission(ctx, 'crm:view')

  return db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      stage: opportunities.stage,
      expectedValueCents: opportunities.expectedValueCents,
      probability: opportunities.probability,
      source: opportunities.source,
      ownerId: opportunities.ownerId,
      expectedCloseDate: opportunities.expectedCloseDate,
      closedAt: opportunities.closedAt,
      lossReason: opportunities.lossReason,
      organizationId: opportunities.organizationId,
      organizationName: organizations.name,
      updatedAt: opportunities.updatedAt,
    })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(
      scoped(
        ctx,
        opportunities,
        opts.stages ? inArray(opportunities.stage, opts.stages) : undefined,
        opts.ownerId ? eq(opportunities.ownerId, opts.ownerId) : undefined,
      ),
    )
    .orderBy(desc(opportunities.updatedAt))
    .limit(opts.limit ?? 300)
}

/** Count of opportunities per stage, for the pipeline board headers. */
export async function stageCounts(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      stage: opportunities.stage,
      total: sql<string>`count(*)`,
      valueCents: sql<string>`coalesce(sum(${opportunities.expectedValueCents}), 0)`,
    })
    .from(opportunities)
    .where(scoped(ctx, opportunities))
    .groupBy(opportunities.stage)

  const counts: Record<string, { count: number; valueCents: number }> = {}
  for (const row of rows) {
    counts[row.stage] = { count: Number(row.total), valueCents: Number(row.valueCents) }
  }
  return counts
}

// --- Organizations and contacts -------------------------------------------

export async function createOrganization(
  ctx: ActorContext,
  input: {
    name: string
    lifecycleStage?: 'lead' | 'prospect' | 'active_client' | 'former_client' | 'vendor' | 'strategic_target'
    email?: string
    phone?: string
    website?: string
    industry?: string
    source?: string
    /**
     * The whole address, since Phase 78. `organizations` has had all six
     * columns since Phase 3 and this took two of them, so a client's street and
     * postcode could not be entered at all — and Phase 77 freezes that address
     * into every agreement they sign.
     */
    addressLine1?: string
    addressLine2?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
    isStrategicAccount?: boolean
    ownerId?: string | null
  },
  exec: Executor = db,
) {
  requirePermission(ctx, 'crm:manage')

  const [organization] = await exec
    .insert(organizations)
    .values({
      companyId: ctx.companyId,
      name: input.name,
      lifecycleStage: input.lifecycleStage ?? 'lead',
      email: input.email ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      industry: input.industry ?? null,
      source: input.source ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      isStrategicAccount: input.isStrategicAccount ?? false,
      ownerId: input.ownerId ?? ctx.userId,
    })
    .returning()

  await recordAudit(
    ctx,
    {
      action: 'organization.create',
      entityType: 'organization',
      entityId: organization.id,
      after: { name: organization.name, lifecycleStage: organization.lifecycleStage },
    },
    exec,
  )

  return organization
}

/** One organisation, for the correction screen. See `customerById`. */
export async function organizationById(ctx: ActorContext, organizationId: string) {
  requirePermission(ctx, 'crm:view')

  const [row] = await db
    .select()
    .from(organizations)
    .where(scoped(ctx, organizations, eq(organizations.id, organizationId)))
    .limit(1)

  if (!row) throw new Refusal('That organization is not on these books.')
  return row
}

/**
 * Corrects an organisation (Phase 78).
 *
 * ## Why this did not exist
 *
 * Phase 45 asked what it means to change a party record, built the vocabulary
 * for it — `PartyField`, `diffParty`, `describeChanges` — and gave `customers`
 * and `vendors` a correction screen. The CRM's own record of **who the client
 * is** never got one. There was no update service, no action, and no form: an
 * organisation created with a typo at lead intake kept it for ever, and the
 * only escape was a second record, which splits its opportunities, its
 * proposals and its timeline in two.
 *
 * `'organization.update'` has been in the audit action union since Phase 3.
 * Nothing has ever written it. The vocabulary anticipated this service and the
 * service never arrived.
 *
 * Phase 77 raised the stakes: an organisation's name and address are now frozen
 * into every agreement it signs, so a typo does not merely persist — it is
 * copied into the record of a contract and kept there deliberately.
 *
 * Gated on `crm:manage`, like creating one. A partial input, so a form showing
 * six of thirteen fields cannot blank the other seven.
 */
export async function updateOrganization(
  ctx: ActorContext,
  organizationId: string,
  input: Partial<{
    name: string
    email: string | null
    phone: string | null
    website: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    country: string | null
    industry: string | null
    lifecycleStage: (typeof organizations.$inferSelect)['lifecycleStage']
    source: string | null
    isStrategicAccount: boolean
    ownerId: string | null
  }>,
) {
  requirePermission(ctx, 'crm:manage')

  const [before] = await db
    .select()
    .from(organizations)
    .where(scoped(ctx, organizations, eq(organizations.id, organizationId)))
    .limit(1)

  if (!before) throw new Refusal('That organization is not on these books.')

  if (input.name !== undefined && !input.name.trim()) {
    throw new Refusal('An organization needs a name.')
  }

  const changes = diffParty({ fields: ORGANIZATION_FIELDS, before, after: input })

  // An untouched form saved is not a change — the same rule `updateCustomer`
  // applies, and for the same reason: an audit log full of empty saves buries
  // the one edit that mattered. `isStrategicAccount` and `ownerId` are not on
  // the field registry, so they are checked separately.
  const untouched =
    changes.length === 0 &&
    input.isStrategicAccount === undefined &&
    input.ownerId === undefined

  if (untouched) return before

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(organizations)
      .set({ ...normaliseParty(input), updatedAt: new Date() })
      .where(scoped(ctx, organizations, eq(organizations.id, organizationId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'organization.update',
        entityType: 'organization',
        entityId: organizationId,
        before: auditable(changes, 'from'),
        after: auditable(changes, 'to'),
      },
      tx,
    )

    return updated
  })
}

export async function createContact(
  ctx: ActorContext,
  input: {
    organizationId?: string | null
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
    title?: string
    isPrimary?: boolean
    emailConsent?: 'unknown' | 'subscribed' | 'unsubscribed' | 'bounced' | 'complained'
    consentSource?: string
  },
  exec: Executor = db,
) {
  requirePermission(ctx, 'crm:manage')

  const [contact] = await exec
    .insert(contacts)
    .values({
      companyId: ctx.companyId,
      organizationId: input.organizationId ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      title: input.title ?? null,
      isPrimary: input.isPrimary ?? false,
      emailConsent: input.emailConsent ?? 'unknown',
      consentSource: input.consentSource ?? null,
      consentAt: input.emailConsent === 'subscribed' ? new Date() : null,
    })
    .returning()

  return contact
}

export async function listOrganizations(
  ctx: ActorContext,
  opts: { limit?: number; strategicOnly?: boolean } = {},
) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(organizations)
    .where(
      scoped(
        ctx,
        organizations,
        opts.strategicOnly ? eq(organizations.isStrategicAccount, true) : undefined,
      ),
    )
    .orderBy(asc(organizations.name))
    .limit(opts.limit ?? 200)
}

export async function listContacts(ctx: ActorContext, organizationId?: string) {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(contacts)
    .where(
      scoped(
        ctx,
        contacts,
        organizationId ? eq(contacts.organizationId, organizationId) : undefined,
      ),
    )
    .orderBy(asc(contacts.lastName), asc(contacts.firstName))
}
