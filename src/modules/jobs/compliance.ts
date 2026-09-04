import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { complianceDocuments, subcontractors, vendors } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { Refusal } from '@/modules/errors'
import {
  COMPLIANCE_LABELS,
  documentStatus,
  EXPIRY_WARNING_DAYS,
  REQUIRED_KINDS,
  type ComplianceKind,
  type DocumentStatus,
} from './vocabulary'

/**
 * Subcontractor compliance (spec §5 "subcontractors").
 *
 * The problem this solves is not filing. It is that an insurance certificate
 * which lapsed three weeks ago is *worse* than one that was never collected:
 * the folder still has a certificate in it, so nobody looks. A compliance
 * record without an expiry date and a warning window is a filing cabinet with
 * extra steps.
 *
 * So every status here is derived from `expiresOn` against a date, never
 * stored. A stored status would be correct on the day it was written and wrong
 * every day after.
 */

export {
  COMPLIANCE_LABELS,
  documentStatus,
  EXPIRY_WARNING_DAYS,
  REQUIRED_KINDS,
  type ComplianceKind,
  type DocumentStatus,
} from './vocabulary'

export type SubcontractorSummary = {
  id: string
  vendorId: string
  vendorName: string
  trade: string | null
  licenseNumber: string | null
  defaultRetainageBp: number
  holdPayments: boolean
  isActive: boolean
  documents: Array<{
    id: string
    kind: ComplianceKind
    reference: string | null
    carrier: string | null
    coverageAmountCents: number | null
    issuedOn: string | null
    expiresOn: string | null
    projectId: string | null
    status: DocumentStatus
  }>
  /** Required kinds with no document on file at all. */
  missingKinds: ComplianceKind[]
  expiredCount: number
  expiringCount: number
  /** True when anything required is missing or expired. */
  hasProblem: boolean
}

export async function createSubcontractor(
  ctx: ActorContext,
  input: {
    vendorId: string
    trade?: string
    licenseNumber?: string
    defaultRetainageBp?: number
    notes?: string
  },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw new Error('Vendor not found')

  const defaultRetainageBp = input.defaultRetainageBp ?? 0
  if (defaultRetainageBp < 0 || defaultRetainageBp > 10_000) {
    throw new Refusal('Retainage must be between 0% and 100%.')
  }

  return db.transaction(async (tx) => {
    const [sub] = await tx
      .insert(subcontractors)
      .values({
        companyId: ctx.companyId,
        vendorId: input.vendorId,
        trade: input.trade ?? null,
        licenseNumber: input.licenseNumber ?? null,
        defaultRetainageBp,
        notes: input.notes ?? null,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'subcontractor.create',
        entityType: 'subcontractor',
        entityId: sub.id,
        after: { vendor: vendor.name, trade: sub.trade, defaultRetainageBp },
      },
      tx,
    )

    return sub
  })
}

export async function updateSubcontractor(
  ctx: ActorContext,
  subcontractorId: string,
  input: {
    trade?: string | null
    licenseNumber?: string | null
    defaultRetainageBp?: number
    holdPayments?: boolean
    isActive?: boolean
    notes?: string | null
  },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  if (
    input.defaultRetainageBp !== undefined &&
    (input.defaultRetainageBp < 0 || input.defaultRetainageBp > 10_000)
  ) {
    throw new Refusal('Retainage must be between 0% and 100%.')
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(subcontractors)
      .where(
        and(
          eq(subcontractors.id, subcontractorId),
          eq(subcontractors.companyId, ctx.companyId),
        ),
      )
      .limit(1)

    if (!before) throw new Error('Subcontractor not found')

    await tx
      .update(subcontractors)
      .set({
        ...(input.trade !== undefined ? { trade: input.trade } : {}),
        ...(input.licenseNumber !== undefined ? { licenseNumber: input.licenseNumber } : {}),
        ...(input.defaultRetainageBp !== undefined
          ? { defaultRetainageBp: input.defaultRetainageBp }
          : {}),
        ...(input.holdPayments !== undefined ? { holdPayments: input.holdPayments } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      })
      .where(eq(subcontractors.id, subcontractorId))

    await recordAudit(
      ctx,
      {
        action: 'subcontractor.update',
        entityType: 'subcontractor',
        entityId: subcontractorId,
        before: { holdPayments: before.holdPayments, isActive: before.isActive },
        after: input as Record<string, unknown>,
      },
      tx,
    )
  })
}

export async function recordComplianceDocument(
  ctx: ActorContext,
  input: {
    subcontractorId: string
    kind: ComplianceKind
    reference?: string
    carrier?: string
    coverageAmountCents?: number
    issuedOn?: string
    expiresOn?: string | null
    projectId?: string | null
    assetId?: string | null
    notes?: string
  },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  const [sub] = await db
    .select()
    .from(subcontractors)
    .where(scoped(ctx, subcontractors, eq(subcontractors.id, input.subcontractorId)))
    .limit(1)

  if (!sub) throw new Error('Subcontractor not found')

  if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) {
    throw new Refusal('A document cannot expire before it was issued.')
  }

  return db.transaction(async (tx) => {
    const [document] = await tx
      .insert(complianceDocuments)
      .values({
        companyId: ctx.companyId,
        subcontractorId: input.subcontractorId,
        kind: input.kind,
        reference: input.reference ?? null,
        carrier: input.carrier ?? null,
        coverageAmountCents: input.coverageAmountCents ?? null,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        projectId: input.projectId ?? null,
        assetId: input.assetId ?? null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'compliance_document.record',
        entityType: 'compliance_document',
        entityId: document.id,
        after: {
          kind: input.kind,
          expiresOn: input.expiresOn ?? null,
          carrier: input.carrier ?? null,
        },
      },
      tx,
    )

    return document
  })
}

/**
 * Every subcontractor with their documents and derived status.
 *
 * One query per table rather than a join per sub: a general contractor has
 * tens of subs, not thousands, and assembling in memory keeps the status
 * derivation in one readable place.
 */
export async function subcontractorSummaries(
  ctx: ActorContext,
  opts: { asOfDate?: string; activeOnly?: boolean } = {},
): Promise<SubcontractorSummary[]> {
  requirePermission(ctx, 'jobs:view')

  const asOfDate = opts.asOfDate ?? new Date().toISOString().slice(0, 10)

  const subs = await db
    .select({
      id: subcontractors.id,
      vendorId: subcontractors.vendorId,
      vendorName: vendors.name,
      trade: subcontractors.trade,
      licenseNumber: subcontractors.licenseNumber,
      defaultRetainageBp: subcontractors.defaultRetainageBp,
      holdPayments: subcontractors.holdPayments,
      isActive: subcontractors.isActive,
    })
    .from(subcontractors)
    .innerJoin(vendors, eq(vendors.id, subcontractors.vendorId))
    .where(scoped(ctx, subcontractors))
    .orderBy(asc(vendors.name))

  const visible = opts.activeOnly ? subs.filter((sub) => sub.isActive) : subs
  if (visible.length === 0) return []

  const documents = await db
    .select()
    .from(complianceDocuments)
    .where(scoped(ctx, complianceDocuments))
    .orderBy(asc(complianceDocuments.kind), asc(complianceDocuments.expiresOn))

  const bySub = new Map<string, typeof documents>()
  for (const document of documents) {
    const list = bySub.get(document.subcontractorId) ?? []
    list.push(document)
    bySub.set(document.subcontractorId, list)
  }

  return visible.map((sub) => {
    const own = (bySub.get(sub.id) ?? []).map((document) => ({
      id: document.id,
      kind: document.kind as ComplianceKind,
      reference: document.reference,
      carrier: document.carrier,
      coverageAmountCents: document.coverageAmountCents,
      issuedOn: document.issuedOn,
      expiresOn: document.expiresOn,
      projectId: document.projectId,
      status: documentStatus(document.expiresOn, asOfDate),
    }))

    const kindsOnFile = new Set(own.map((document) => document.kind))
    const missingKinds = REQUIRED_KINDS.filter((kind) => !kindsOnFile.has(kind))

    // A kind counts as expired only when *every* document of that kind has
    // expired — a renewed certificate filed alongside the old one is current
    // cover, and flagging it would train people to ignore the flag.
    const expiredKinds = [...kindsOnFile].filter((kind) =>
      own
        .filter((document) => document.kind === kind)
        .every((document) => document.status === 'expired'),
    )
    const expiringKinds = [...kindsOnFile].filter(
      (kind) =>
        !expiredKinds.includes(kind) &&
        own
          .filter((document) => document.kind === kind)
          .every((document) => document.status !== 'valid' && document.status !== 'no_expiry'),
    )

    const requiredExpired = expiredKinds.filter((kind) =>
      REQUIRED_KINDS.includes(kind as ComplianceKind),
    )

    return {
      ...sub,
      documents: own,
      missingKinds,
      expiredCount: expiredKinds.length,
      expiringCount: expiringKinds.length,
      hasProblem: missingKinds.length > 0 || requiredExpired.length > 0,
    }
  })
}

/**
 * Whether a sub is clear to be paid, and why not.
 *
 * Returns a reason rather than throwing, because this is advice by default:
 * `holdPayments` is what actually blocks, and it is a decision a person makes.
 * Software that silently refuses to pay a subcontractor because a form is a
 * day out of date is software that gets worked around.
 */
export async function paymentCheck(
  ctx: ActorContext,
  vendorId: string,
  opts: { asOfDate?: string } = {},
): Promise<{ clear: boolean; blocked: boolean; reasons: string[] }> {
  requirePermission(ctx, 'jobs:view')

  const summaries = await subcontractorSummaries(ctx, opts)
  const sub = summaries.find((row) => row.vendorId === vendorId)

  // Not a tracked subcontractor: an ordinary vendor, nothing to check.
  if (!sub) return { clear: true, blocked: false, reasons: [] }

  const reasons: string[] = []
  for (const kind of sub.missingKinds) {
    reasons.push(`No ${COMPLIANCE_LABELS[kind].toLowerCase()} on file.`)
  }
  for (const document of sub.documents) {
    if (document.status === 'expired' && REQUIRED_KINDS.includes(document.kind)) {
      reasons.push(`${COMPLIANCE_LABELS[document.kind]} expired on ${document.expiresOn}.`)
    }
  }
  if (sub.holdPayments) {
    reasons.push('Payments to this subcontractor are on hold.')
  }

  return { clear: reasons.length === 0, blocked: sub.holdPayments, reasons }
}

/** Documents expiring soon or already expired, newest expiry first. */
export async function expiringDocuments(
  ctx: ActorContext,
  opts: { asOfDate?: string; withinDays?: number } = {},
) {
  const asOfDate = opts.asOfDate ?? new Date().toISOString().slice(0, 10)
  const withinDays = opts.withinDays ?? EXPIRY_WARNING_DAYS

  const summaries = await subcontractorSummaries(ctx, { asOfDate, activeOnly: true })

  return summaries
    .flatMap((sub) =>
      sub.documents
        .filter((document) => {
          const status = documentStatus(document.expiresOn, asOfDate, withinDays)
          return status === 'expired' || status === 'expiring'
        })
        .map((document) => ({
          subcontractorId: sub.id,
          vendorName: sub.vendorName,
          kind: document.kind,
          expiresOn: document.expiresOn,
          status: documentStatus(document.expiresOn, asOfDate, withinDays),
        })),
    )
    .sort((a, b) => (a.expiresOn ?? '').localeCompare(b.expiresOn ?? ''))
}
