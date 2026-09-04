import { asc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { paymentApplications, payments, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { missing } from '@/modules/errors/missing'

/**
 * Contractor payment reporting (spec §13: "1099-related vendor data fields as
 * applicable").
 *
 * `vendors.taxId` and `vendors.is1099Vendor` have existed since Phase 2 with a
 * comment saying nothing read them. This is what reads them — the same shape
 * as Phase 7 making `INDUSTRY_MODULES` real.
 *
 * ## What this produces, and what it does not
 *
 * It produces the figure: what a company paid each reportable contractor in a
 * calendar year, and which of them are over the threshold. That is the part
 * that needs the accounting records, and it is the part this system has.
 *
 * It does not produce a form and it does not file one. Naming the report after
 * a specific jurisdiction's form number would be a claim about compliance that
 * this codebase has not earned — spec §19 requires a security review before
 * production use of tax filing. The threshold is a company setting rather than
 * a constant for the same reason: it differs by jurisdiction and changes, and
 * a number baked into a release is a number that is quietly wrong later.
 */

/**
 * The default reporting threshold, in cents.
 *
 * A starting point a company overrides, not an authority. Chosen because it is
 * the long-standing US 1099-NEC threshold and this codebase's demo data is in
 * dollars — a company anywhere else sets its own.
 */
export const DEFAULT_REPORTING_THRESHOLD_CENTS = 60_000

export type ContractorPaymentRow = {
  vendorId: string
  vendorName: string
  /** Whether the company flagged them as reportable. */
  isReportable: boolean
  hasTaxId: boolean
  paidCents: number
  paymentCount: number
  /** Over the threshold *and* flagged. */
  meetsThreshold: boolean
  /**
   * Why this row cannot be reported yet, if it cannot. Empty when it is ready.
   * The point of the report is this column: the figure is the easy part, and
   * the missing tax identifier is what actually stops a filing in January.
   */
  blockers: string[]
}

export type ContractorPaymentReport = {
  year: number
  thresholdCents: number
  rows: ContractorPaymentRow[]
  reportableCount: number
  totalReportableCents: number
  /** Rows over the threshold that are not ready to report. */
  needsAttentionCount: number
}

/**
 * What was paid to each vendor in a calendar year.
 *
 * Counted from **payments actually made**, not from bills raised. A contractor
 * is reported on what they were paid in the year, and an unpaid bill dated
 * December is next year's problem — using bills would overstate the year and
 * understate the next.
 */
export async function contractorPayments(
  ctx: ActorContext,
  opts: { year: number; thresholdCents?: number; includeAllVendors?: boolean },
): Promise<ContractorPaymentReport> {
  requirePermission(ctx, 'tax:view')

  const thresholdCents = opts.thresholdCents ?? DEFAULT_REPORTING_THRESHOLD_CENTS
  const startDate = `${opts.year}-01-01`
  const endDate = `${opts.year}-12-31`

  const rows = await db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.name,
      isReportable: vendors.is1099Vendor,
      taxId: vendors.taxId,
      paidCents: sql<string>`coalesce(sum(${paymentApplications.amountCents}), 0)`,
      paymentCount: sql<string>`count(distinct ${payments.id})`,
    })
    .from(vendors)
    .leftJoin(payments, eq(payments.vendorId, vendors.id))
    .leftJoin(paymentApplications, eq(paymentApplications.paymentId, payments.id))
    .where(
      scoped(
        ctx,
        vendors,
        // The date filter lives here rather than in the join so a vendor with
        // no payments this year still appears — "paid nothing" is an answer,
        // and a vendor silently missing from a year-end report is worse than
        // one showing zero.
        // A voided payment is not money a contractor received, and a 1099 is
        // filed with a tax authority (Phase 52). It stays inside this same
        // expression rather than becoming its own condition, so a vendor with
        // no qualifying payments still appears at zero.
        sql`(${payments.id} IS NULL OR (${payments.paymentDate} BETWEEN ${startDate} AND ${endDate} AND ${payments.kind} = 'disbursement' AND ${payments.status} = 'posted'))`,
      ),
    )
    .groupBy(vendors.id, vendors.name, vendors.is1099Vendor, vendors.taxId)
    .orderBy(asc(vendors.name))

  const mapped: ContractorPaymentRow[] = rows.map((row) => {
    const paidCents = Number(row.paidCents)
    const hasTaxId = Boolean(row.taxId && row.taxId.trim())
    const meetsThreshold = row.isReportable && paidCents >= thresholdCents

    const blockers: string[] = []
    if (meetsThreshold && !hasTaxId) {
      blockers.push('No tax identifier on file.')
    }
    if (!row.isReportable && paidCents >= thresholdCents) {
      blockers.push(
        'Paid over the threshold but not marked reportable — check whether they should be.',
      )
    }

    return {
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      isReportable: row.isReportable,
      hasTaxId,
      paidCents,
      paymentCount: Number(row.paymentCount),
      meetsThreshold,
      blockers,
    }
  })

  const visible = opts.includeAllVendors
    ? mapped
    : mapped.filter((row) => row.isReportable || row.paidCents >= thresholdCents)

  const reportable = visible.filter((row) => row.meetsThreshold)

  return {
    year: opts.year,
    thresholdCents,
    rows: visible,
    reportableCount: reportable.length,
    totalReportableCents: reportable.reduce((sum, row) => sum + row.paidCents, 0),
    needsAttentionCount: visible.filter((row) => row.blockers.length > 0).length,
  }
}

/**
 * Marks a vendor as reportable and records their identifier.
 *
 * The identifier is stored whole here, unlike an employee's — a contractor
 * report needs the full number and there is nowhere else it lives. That is a
 * real difference in exposure, and it is why this needs `tax:manage` rather
 * than the `accounting:view` that creating a vendor needs.
 */
export async function setVendorReporting(
  ctx: ActorContext,
  vendorId: string,
  input: { isReportable: boolean; taxId?: string | null },
) {
  requirePermission(ctx, 'tax:manage')

  const { recordAudit } = await import('@/modules/audit')

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(vendors)
      .where(scoped(ctx, vendors, eq(vendors.id, vendorId)))
      .limit(1)

    if (!before) throw missing('vendor')

    await tx
      .update(vendors)
      .set({
        is1099Vendor: input.isReportable,
        ...(input.taxId !== undefined ? { taxId: input.taxId?.trim() || null } : {}),
      })
      .where(eq(vendors.id, vendorId))

    await recordAudit(
      ctx,
      {
        action: 'vendor.create',
        entityType: 'vendor',
        entityId: vendorId,
        before: { isReportable: before.is1099Vendor, hadTaxId: Boolean(before.taxId) },
        // The identifier itself never goes in the audit log. Recording that one
        // was set is the useful fact; recording what it was would put a tax
        // number in a table read by everyone with `audit:view`.
        after: { isReportable: input.isReportable, hasTaxId: Boolean(input.taxId) },
      },
      tx,
    )
  })
}

/** Vendor payments in a period, for the workpaper drill-down. */
export async function vendorPaymentDetail(
  ctx: ActorContext,
  vendorId: string,
  range: { startDate: string; endDate: string },
) {
  requirePermission(ctx, 'tax:view')

  return db
    .select({
      paymentId: payments.id,
      paymentDate: payments.paymentDate,
      amountCents: paymentApplications.amountCents,
      reference: payments.reference,
      memo: payments.memo,
    })
    .from(payments)
    .innerJoin(paymentApplications, eq(paymentApplications.paymentId, payments.id))
    .where(
      scoped(
        ctx,
        payments,
        eq(payments.vendorId, vendorId),
        eq(payments.kind, 'disbursement'),
        eq(payments.status, 'posted'),
        gte(payments.paymentDate, range.startDate),
        lte(payments.paymentDate, range.endDate),
      ),
    )
    .orderBy(asc(payments.paymentDate))
}
