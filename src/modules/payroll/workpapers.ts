import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { formatCents } from '@/lib/money'
import { taxFilings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { profitAndLoss } from '@/modules/ledger/reports'
import { trialBalance } from '@/modules/ledger/balances'
import { payrollSummary } from './service'
import { liabilityPositions, remittancesInPeriod } from './remittance'
import { salesTaxReturn } from './sales-tax'
import { contractorPayments } from './vendor-reporting'
import { DomainError, Refusal } from '@/modules/errors'

/**
 * Tax workpapers (spec §13: "tax-workpaper-friendly reports").
 *
 * ## What makes a report workpaper-friendly
 *
 * Not formatting. An accountant preparing a return needs three things from a
 * set of books, and most software gives them the first two:
 *
 *  1. The figures.
 *  2. The trail from each figure back to the transactions behind it.
 *  3. **An honest account of what is wrong with them.**
 *
 * The third is what this module is actually for. Every pack it produces
 * carries an `exceptions` list, and the list is the point: sales with no tax
 * code, a liability account whose movement does not reconcile, contractors
 * over the threshold with no identifier on file, payroll figures that came
 * from the illustrative adapter. An accountant finds those anyway — in January,
 * under time pressure, by hand. Producing them in the pack turns a discovery
 * into a checklist.
 */

export type Exception = {
  severity: 'blocker' | 'warning'
  area: 'payroll' | 'sales_tax' | 'contractors' | 'ledger'
  message: string
}

export type WorkpaperPack = {
  periodStart: string
  periodEnd: string
  preparedAt: string

  ledger: {
    isBalanced: boolean
    totalDebitCents: number
    totalCreditCents: number
    revenueCents: number
    costOfSalesCents: number
    operatingExpenseCents: number
    netIncomeCents: number
  }

  payroll: Awaited<ReturnType<typeof payrollSummary>>
  liabilities: Awaited<ReturnType<typeof liabilityPositions>>
  remittances: { count: number; totalCents: number }
  salesTax: Awaited<ReturnType<typeof salesTaxReturn>>
  contractors: Awaited<ReturnType<typeof contractorPayments>>

  /** What an accountant should look at before relying on any of the above. */
  exceptions: Exception[]
}

/**
 * Assembles the period pack.
 *
 * Every figure is read through the existing report services rather than
 * re-queried, so a workpaper and the statement it accompanies cannot disagree.
 * That is the same discipline Phase 7 applied to job costing: the pack is a
 * different arrangement of the ledger, never a second source for it.
 */
export async function workpaperPack(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<WorkpaperPack> {
  requirePermission(ctx, 'tax:view')
  requirePermission(ctx, 'reports:financial')

  const [balances, pl, payroll, liabilities, remittances, salesTax, contractors] =
    await Promise.all([
      trialBalance(ctx, { endDate: range.endDate }),
      profitAndLoss(ctx, range),
      payrollSummary(ctx, range),
      liabilityPositions(ctx, { asOfDate: range.endDate }),
      remittancesInPeriod(ctx, range),
      salesTaxReturn(ctx, { periodStart: range.startDate, periodEnd: range.endDate }),
      contractorPayments(ctx, { year: Number(range.endDate.slice(0, 4)) }),
    ])

  const exceptions: Exception[] = []

  // --- Ledger ---
  if (!balances.isBalanced) {
    exceptions.push({
      severity: 'blocker',
      area: 'ledger',
      message: `The trial balance is out by ${formatCents(balances.totalDebitCents - balances.totalCreditCents)}. Nothing else in this pack can be relied on until that is explained.`,
    })
  }

  // --- Payroll ---
  if (payroll.illustrativeRuns > 0) {
    exceptions.push({
      severity: 'blocker',
      area: 'payroll',
      message: `${payroll.illustrativeRuns} of ${payroll.runs} payroll runs in this period used the illustrative adapter. Those figures are demonstration numbers, not real withholding, and must not be filed against.`,
    })
  }

  const payrollLiability = liabilities.find((entry) => entry.accountNumber === '2300')
  if (payrollLiability && payrollLiability.balanceCents < 0) {
    exceptions.push({
      severity: 'blocker',
      area: 'payroll',
      message: `Payroll Liabilities is negative (${formatCents(payrollLiability.balanceCents)}), which means more has been remitted than was ever accrued.`,
    })
  }

  const netPayPayable = liabilities.find((entry) => entry.accountNumber === '2350')
  if (netPayPayable && netPayPayable.balanceCents > 0) {
    exceptions.push({
      severity: 'warning',
      area: 'payroll',
      message: `${formatCents(netPayPayable.balanceCents)} sits in Net Pay Payable at period end — wages posted but not recorded as paid out. Expected mid-period; worth explaining at year end.`,
    })
  }

  // --- Sales tax ---
  if (salesTax.hasUncodedSales) {
    exceptions.push({
      severity: 'warning',
      area: 'sales_tax',
      message: `${formatCents(salesTax.uncodedSalesCents)} of invoiced sales in this period carry no tax code, so they appear on no jurisdiction's return.`,
    })
  }

  if (salesTax.varianceCents !== 0 && salesTax.totalTaxCollectedCents > 0) {
    exceptions.push({
      severity: 'warning',
      area: 'sales_tax',
      message: `Tax collected in the period (${formatCents(salesTax.totalTaxCollectedCents)}) differs from the Sales Tax Payable balance (${formatCents(salesTax.ledgerBalanceCents)}) by ${formatCents(salesTax.varianceCents)}. Usually an earlier period is unremitted — confirm rather than assume.`,
    })
  }

  // --- Contractors ---
  for (const row of contractors.rows) {
    for (const blocker of row.blockers) {
      exceptions.push({
        severity: row.meetsThreshold ? 'blocker' : 'warning',
        area: 'contractors',
        message: `${row.vendorName}: ${blocker}`,
      })
    }
  }

  return {
    periodStart: range.startDate,
    periodEnd: range.endDate,
    preparedAt: new Date().toISOString(),
    ledger: {
      isBalanced: balances.isBalanced,
      totalDebitCents: balances.totalDebitCents,
      totalCreditCents: balances.totalCreditCents,
      revenueCents: pl.revenue.totalCents,
      costOfSalesCents: pl.costOfSales.totalCents,
      operatingExpenseCents: pl.operatingExpenses.totalCents,
      netIncomeCents: pl.netIncomeCents,
    },
    payroll,
    liabilities,
    remittances: {
      count: remittances.length,
      totalCents: remittances.reduce((sum, row) => sum + row.amountCents, 0),
    },
    salesTax,
    contractors,
    exceptions,
  }
}

/**
 * Freezes a set of figures as a prepared filing.
 *
 * Refuses when the pack has a blocker. That is the one place this module
 * actually stops somebody, and it is deliberate: preparing a return from books
 * that do not balance, or from illustrative payroll figures, is not a judgement
 * call an accountant should have to make against a system that let them.
 */
export async function prepareFiling(
  ctx: ActorContext,
  input: {
    kind: 'sales_tax' | 'payroll' | 'contractor'
    jurisdiction?: string
    periodStart: string
    periodEnd: string
    figures: Record<string, unknown>
    /** Set to override a blocker, with the reason recorded. */
    overrideReason?: string
  },
) {
  requirePermission(ctx, 'tax:manage')

  const pack = await workpaperPack(ctx, {
    startDate: input.periodStart,
    endDate: input.periodEnd,
  })

  const blockers = pack.exceptions.filter((exception) => exception.severity === 'blocker')

  if (blockers.length > 0 && !input.overrideReason) {
    throw new FilingBlockedError(blockers)
  }

  return db.transaction(async (tx) => {
    const [filing] = await tx
      .insert(taxFilings)
      .values({
        companyId: ctx.companyId,
        kind: input.kind,
        jurisdiction: input.jurisdiction ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        figures: {
          ...input.figures,
          // The exceptions travel with the figures. A return questioned later
          // should show what was known to be wrong at the time it was prepared.
          exceptions: pack.exceptions,
          overrideReason: input.overrideReason ?? null,
        },
        status: 'prepared',
        preparedBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [
          taxFilings.companyId,
          taxFilings.kind,
          taxFilings.jurisdiction,
          taxFilings.periodStart,
          taxFilings.periodEnd,
        ],
        set: {
          figures: {
            ...input.figures,
            exceptions: pack.exceptions,
            overrideReason: input.overrideReason ?? null,
          },
          preparedBy: ctx.userId,
          updatedAt: new Date(),
        },
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'filing.prepare',
        entityType: 'tax_filing',
        entityId: filing.id,
        after: {
          kind: input.kind,
          jurisdiction: input.jurisdiction ?? null,
          period: `${input.periodStart}..${input.periodEnd}`,
          blockersOverridden: blockers.length,
          overrideReason: input.overrideReason ?? null,
        },
      },
      tx,
    )

    return filing
  })
}

/** Raised when a filing would be prepared from books with a known problem. */
export class FilingBlockedError extends DomainError {
  readonly status = 409
  constructor(readonly blockers: Exception[]) {
    super(
      `This period has ${blockers.length} unresolved ${blockers.length === 1 ? 'problem' : 'problems'}: ` +
        blockers.map((blocker) => blocker.message).join(' '),
    )
    this.name = 'FilingBlockedError'
  }
}

/**
 * Records that a person filed a return somewhere else.
 *
 * There is no `file()` in this module and there is not going to be one without
 * the security review spec §19 requires. What the system can honestly hold is
 * the fact that a human says they filed it, when, and with what reference —
 * which is what an audit trail actually needs.
 */
export async function markFiledExternally(
  ctx: ActorContext,
  filingId: string,
  input: { filedOn: string; note: string },
) {
  requirePermission(ctx, 'tax:manage')

  if (!input.note.trim()) {
    throw new Refusal('Say where it was filed and with what reference.')
  }

  return db.transaction(async (tx) => {
    const [filing] = await tx
      .select()
      .from(taxFilings)
      .where(scoped(ctx, taxFilings, eq(taxFilings.id, filingId)))
      .limit(1)

    if (!filing) throw new Error('Filing not found')

    await tx
      .update(taxFilings)
      .set({
        status: 'filed_externally',
        filedOn: input.filedOn,
        filedNote: input.note.trim(),
        updatedAt: new Date(),
      })
      .where(eq(taxFilings.id, filingId))

    await recordAudit(
      ctx,
      {
        action: 'filing.mark_filed',
        entityType: 'tax_filing',
        entityId: filingId,
        before: { status: filing.status },
        after: { status: 'filed_externally', filedOn: input.filedOn, note: input.note.trim() },
      },
      tx,
    )
  })
}

export async function listFilings(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'tax:view')

  return db
    .select()
    .from(taxFilings)
    .where(scoped(ctx, taxFilings))
    .orderBy(taxFilings.periodEnd)
    .limit(opts.limit ?? 50)
}
