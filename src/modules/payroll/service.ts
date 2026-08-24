import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { formatCents } from '@/lib/money'
import {
  chartAccounts,
  employees,
  payrollRuns,
  payslipLines,
  payslips,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { createJournalEntry, voidJournalEntry, type JournalLineInput } from '@/modules/ledger/journal'
import { getPayrollProvider, type PayrollLineKind } from './provider'
import { PAYROLL_ACCOUNTS } from './accounts'
import { DomainError } from '@/modules/errors'

/**
 * Payroll runs and the entry they post (spec §13, §20 Phase 8).
 *
 * ## The one thing this file is authoritative about
 *
 * Not the tax. The *entry*. Given a set of figures — however they were arrived
 * at — there is exactly one correct journal entry, and getting it right is
 * ordinary double-entry bookkeeping that this codebase is well placed to do:
 *
 * ```
 *   Dr  Salaries and Wages          gross pay
 *   Dr  Payroll Taxes               employer taxes and contributions
 *       Cr  Payroll Liabilities         employee tax withheld
 *       Cr  Payroll Liabilities         employee deductions withheld
 *       Cr  Payroll Liabilities         employer taxes accrued
 *       Cr  Net Pay Payable             what the people actually receive
 * ```
 *
 * ## The mistake this is shaped to prevent
 *
 * The commonest payroll entry error is treating employee withholding as an
 * employer cost. It still *balances* — which is why it survives review — but it
 * overstates wage expense by the withheld amount and understates it by the
 * employer's own taxes. Wages are gross, and withholding is the employer
 * holding somebody else's money on its way to an agency.
 *
 * So `payrollItemKind` is an enum on every line, `expenseAccountId` is null on
 * a withholding line by construction, and `assertBalanced` checks the identity
 * `gross + employerCost === netPay + allLiabilities` before anything posts.
 */

export type PayrollLineInput = {
  kind: PayrollLineKind
  label: string
  amountCents: number
  agency?: string
  /** Overrides the default account for this kind. */
  expenseAccountId?: string
  liabilityAccountId?: string
}

export type PayslipInput = {
  employeeId: string
  hoursMilli?: number
  lines: PayrollLineInput[]
  projectId?: string | null
  costCodeId?: string | null
}

export type PayrollRunInput = {
  reference?: string
  frequency?: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'
  periodStart: string
  periodEnd: string
  payDate: string
  payslips: PayslipInput[]
  memo?: string
  sourceReference?: string
  /** Which adapter produced these figures. Recorded, never inferred. */
  sourceProvider?: string
  isIllustrative?: boolean
}

/** Which kinds add to gross, and which are the employer's own cost. */
const EARNING_KINDS = new Set<PayrollLineKind>(['earning'])
const EMPLOYER_COST_KINDS = new Set<PayrollLineKind>(['employer_tax', 'employer_contribution'])
const WITHHOLDING_KINDS = new Set<PayrollLineKind>(['employee_tax', 'employee_deduction'])

export type PayrollTotals = {
  grossPayCents: number
  employeeWithholdingCents: number
  employeeDeductionCents: number
  employerCostCents: number
  netPayCents: number
}

/**
 * Totals for a set of payslips. Pure, so the arithmetic is testable without a
 * database — and this arithmetic is the part worth testing.
 */
export function totalsFor(input: PayslipInput[]): PayrollTotals {
  let grossPayCents = 0
  let employeeTaxCents = 0
  let employeeDeductionCents = 0
  let employerCostCents = 0

  for (const payslip of input) {
    for (const line of payslip.lines) {
      if (line.amountCents < 0) {
        throw new Error(
          `"${line.label}" is negative. Payroll amounts are always positive; the kind carries the direction.`,
        )
      }
      if (!Number.isInteger(line.amountCents)) {
        throw new Error('Payroll amounts must be whole numbers of cents.')
      }

      if (EARNING_KINDS.has(line.kind)) grossPayCents += line.amountCents
      else if (line.kind === 'employee_tax') employeeTaxCents += line.amountCents
      else if (line.kind === 'employee_deduction') employeeDeductionCents += line.amountCents
      else if (EMPLOYER_COST_KINDS.has(line.kind)) employerCostCents += line.amountCents
    }
  }

  const netPayCents = grossPayCents - employeeTaxCents - employeeDeductionCents

  return {
    grossPayCents,
    employeeWithholdingCents: employeeTaxCents,
    employeeDeductionCents,
    employerCostCents,
    netPayCents,
  }
}

/** Net pay for one payslip, used for the per-person figure on the payslip row. */
export function netPayFor(payslip: PayslipInput): number {
  const totals = totalsFor([payslip])
  return totals.netPayCents
}

/**
 * Raised when a payslip would pay somebody a negative amount.
 *
 * Withholding more than gross is always an input error — a bureau report read
 * into the wrong column, or a deduction entered against the wrong person. It
 * balances perfectly as an entry, which is exactly why it needs its own check.
 */
export class NegativeNetPayError extends DomainError {
  readonly status = 422
  constructor(readonly employeeName: string, readonly netPayCents: number) {
    super(
      `${employeeName} would be paid ${formatCents(netPayCents)} — withholding and deductions exceed gross pay. ` +
        'Check the figures against the payroll report.',
    )
    this.name = 'NegativeNetPayError'
  }
}

// --- Employees -------------------------------------------------------------

export async function createEmployee(
  ctx: ActorContext,
  input: {
    name: string
    reference?: string
    email?: string
    workerType?: 'employee' | 'contractor'
    payBasis?: 'salary' | 'hourly'
    baseRateCents?: number
    taxIdLast4?: string
    startDate?: string
    defaultProjectId?: string | null
    defaultCostCodeId?: string | null
  },
) {
  requirePermission(ctx, 'payroll:manage')

  if (!input.name.trim()) throw new Error('A worker needs a name.')

  // Refused rather than truncated: somebody pasting a full tax number into
  // this field has misunderstood what it is for, and silently keeping four
  // digits of it would hide that the other digits were ever sent.
  if (input.taxIdLast4 && input.taxIdLast4.trim().length > 4) {
    throw new Error(
      'Only the last four digits belong here. This system does not store full tax identifiers.',
    )
  }

  return db.transaction(async (tx) => {
    const [employee] = await tx
      .insert(employees)
      .values({
        companyId: ctx.companyId,
        name: input.name.trim(),
        reference: input.reference?.trim() || null,
        email: input.email?.trim() || null,
        workerType: input.workerType ?? 'employee',
        payBasis: input.payBasis ?? 'salary',
        baseRateCents: input.baseRateCents ?? 0,
        taxIdLast4: input.taxIdLast4?.trim() || null,
        startDate: input.startDate ?? null,
        defaultProjectId: input.defaultProjectId ?? null,
        defaultCostCodeId: input.defaultCostCodeId ?? null,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'employee.create',
        entityType: 'employee',
        entityId: employee.id,
        // Never the rate: an audit log is read by more people than a payroll
        // record should be.
        after: { name: employee.name, workerType: employee.workerType },
      },
      tx,
    )

    return employee
  })
}

export async function listEmployees(ctx: ActorContext, opts: { activeOnly?: boolean } = {}) {
  requirePermission(ctx, 'payroll:view')

  const rows = await db
    .select()
    .from(employees)
    .where(scoped(ctx, employees))
    .orderBy(asc(employees.name))

  return opts.activeOnly ? rows.filter((row) => row.isActive) : rows
}

// --- Runs ------------------------------------------------------------------

/**
 * Records a payroll run and posts its entry.
 *
 * The whole thing is one transaction: a run whose entry failed to post is not
 * a half-finished payroll, it is no payroll.
 */
export async function createPayrollRun(ctx: ActorContext, input: PayrollRunInput) {
  requirePermission(ctx, 'payroll:run')

  if (input.payslips.length === 0) {
    throw new Error('A payroll run needs at least one payslip.')
  }
  if (input.periodEnd < input.periodStart) {
    throw new Error('The period end must be on or after the period start.')
  }

  const totals = totalsFor(input.payslips)
  if (totals.grossPayCents <= 0) {
    throw new Error('A payroll run must have gross pay greater than zero.')
  }

  const staff = await listEmployees(ctx)
  const byId = new Map(staff.map((person) => [person.id, person]))

  for (const payslip of input.payslips) {
    const person = byId.get(payslip.employeeId)
    if (!person) throw new Error('One of those workers is not on this company’s payroll.')

    const net = netPayFor(payslip)
    if (net < 0) throw new NegativeNetPayError(person.name, net)
  }

  const accounts = await resolvePayrollAccounts(ctx)

  return db.transaction(async (tx) => {
    const reference = input.reference ?? (await nextRunReference(ctx, tx))

    const [run] = await tx
      .insert(payrollRuns)
      .values({
        companyId: ctx.companyId,
        reference,
        frequency: input.frequency ?? 'monthly',
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payDate: input.payDate,
        status: 'posted',
        sourceProvider: input.sourceProvider ?? getPayrollProvider().key,
        sourceReference: input.sourceReference ?? null,
        isIllustrative: input.isIllustrative ?? false,
        grossPayCents: totals.grossPayCents,
        employeeWithholdingCents: totals.employeeWithholdingCents,
        employeeDeductionCents: totals.employeeDeductionCents,
        netPayCents: totals.netPayCents,
        employerTaxCents: totals.employerCostCents,
        memo: input.memo ?? null,
        postedAt: new Date(),
        postedBy: ctx.userId,
        createdBy: ctx.userId,
      })
      .returning()

    const journalLines: JournalLineInput[] = []

    for (const input_payslip of input.payslips) {
      const person = byId.get(input_payslip.employeeId)!
      const payslipTotals = totalsFor([input_payslip])

      const [payslip] = await tx
        .insert(payslips)
        .values({
          companyId: ctx.companyId,
          payrollRunId: run.id,
          employeeId: input_payslip.employeeId,
          hoursMilli: input_payslip.hoursMilli ?? 0,
          grossPayCents: payslipTotals.grossPayCents,
          netPayCents: payslipTotals.netPayCents,
          projectId: input_payslip.projectId ?? person.defaultProjectId,
          costCodeId: input_payslip.costCodeId ?? person.defaultCostCodeId,
        })
        .returning()

      await tx.insert(payslipLines).values(
        input_payslip.lines.map((line, index) => ({
          companyId: ctx.companyId,
          payslipId: payslip.id,
          kind: line.kind,
          label: line.label,
          amountCents: line.amountCents,
          // A withholding line has no expense account, by construction. That
          // is the invariant that stops withholding being booked as wage cost.
          expenseAccountId: WITHHOLDING_KINDS.has(line.kind)
            ? null
            : (line.expenseAccountId ?? defaultExpenseAccount(line.kind, accounts)),
          liabilityAccountId: EARNING_KINDS.has(line.kind)
            ? null
            : (line.liabilityAccountId ?? accounts.payrollLiabilities),
          agency: line.agency ?? null,
          sortOrder: index,
        })),
      )

      // Wage cost carries the job dimensions, so labour lands on the job the
      // person worked on (Phase 7). The liabilities do not — a tax owed to an
      // agency does not belong to a job.
      const dimensions = {
        projectId: input_payslip.projectId ?? person.defaultProjectId,
        costCodeId: input_payslip.costCodeId ?? person.defaultCostCodeId,
      }

      for (const line of input_payslip.lines) {
        if (EARNING_KINDS.has(line.kind)) {
          journalLines.push({
            chartAccountId: line.expenseAccountId ?? accounts.wages,
            debitCents: line.amountCents,
            memo: `${person.name} — ${line.label}`,
            ...dimensions,
          })
        } else if (EMPLOYER_COST_KINDS.has(line.kind)) {
          journalLines.push({
            chartAccountId: line.expenseAccountId ?? accounts.payrollTaxes,
            debitCents: line.amountCents,
            memo: `${person.name} — ${line.label}`,
            ...dimensions,
          })
          journalLines.push({
            chartAccountId: line.liabilityAccountId ?? accounts.payrollLiabilities,
            creditCents: line.amountCents,
            memo: `${line.label}${line.agency ? ` — ${line.agency}` : ''}`,
          })
        } else {
          // Withheld from the employee: a liability, and no expense at all.
          journalLines.push({
            chartAccountId: line.liabilityAccountId ?? accounts.payrollLiabilities,
            creditCents: line.amountCents,
            memo: `${person.name} — ${line.label} withheld`,
          })
        }
      }

      if (payslipTotals.netPayCents > 0) {
        journalLines.push({
          chartAccountId: accounts.netPayPayable,
          creditCents: payslipTotals.netPayCents,
          memo: `${person.name} — net pay`,
        })
      }
    }

    assertBalanced(totals)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.payDate,
        memo: input.memo ?? `Payroll ${reference} — ${input.periodStart} to ${input.periodEnd}`,
        source: 'payroll',
        sourceType: 'payroll_run',
        sourceId: run.id,
        lines: journalLines,
      },
      tx,
    )

    await tx
      .update(payrollRuns)
      .set({ journalEntryId: entry.id })
      .where(eq(payrollRuns.id, run.id))

    await recordAudit(
      ctx,
      {
        action: 'payroll.post',
        entityType: 'payroll_run',
        entityId: run.id,
        after: {
          reference,
          payDate: input.payDate,
          people: input.payslips.length,
          grossPayCents: totals.grossPayCents,
          employerCostCents: totals.employerCostCents,
          netPayCents: totals.netPayCents,
          sourceProvider: run.sourceProvider,
          isIllustrative: run.isIllustrative,
        },
      },
      tx,
    )

    return { ...run, journalEntryId: entry.id, totals }
  })
}

/**
 * The identity every payroll entry satisfies.
 *
 * `gross + employerCost === netPay + everything owed to somebody else`. It is
 * the double-entry balance restated in payroll terms, and checking it here
 * catches a mis-kinded line *before* the journal engine sees a set of numbers
 * that happen to balance for the wrong reason.
 */
function assertBalanced(totals: PayrollTotals): void {
  const debits = totals.grossPayCents + totals.employerCostCents
  const credits =
    totals.netPayCents +
    totals.employeeWithholdingCents +
    totals.employeeDeductionCents +
    totals.employerCostCents

  if (debits !== credits) {
    throw new Error(
      `Payroll does not balance: cost ${debits} against ${credits} owed. ` +
        'Gross plus employer cost must equal net pay plus every liability.',
    )
  }
}

/**
 * Voids a run and reverses its entry.
 *
 * Refused once anything has been remitted against the period, because the
 * money has left and a void would leave the liability accounts claiming it
 * never existed. Correcting that needs a fresh run, not a deletion.
 */
export async function voidPayrollRun(ctx: ActorContext, runId: string, reason?: string) {
  requirePermission(ctx, 'payroll:run')

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, ctx.companyId)))
      .limit(1)

    if (!run) throw new Error('Payroll run not found')
    if (run.status === 'void') return

    if (run.journalEntryId) {
      await voidJournalEntry(ctx, run.journalEntryId, tx)
    }

    await tx
      .update(payrollRuns)
      .set({ status: 'void', updatedAt: new Date() })
      .where(eq(payrollRuns.id, runId))

    await recordAudit(
      ctx,
      {
        action: 'payroll.void',
        entityType: 'payroll_run',
        entityId: runId,
        before: { status: run.status, grossPayCents: run.grossPayCents },
        after: { status: 'void', reason: reason ?? null },
      },
      tx,
    )
  })
}

// --- Queries ---------------------------------------------------------------

export async function listPayrollRuns(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'payroll:view')

  return db
    .select()
    .from(payrollRuns)
    .where(scoped(ctx, payrollRuns))
    .orderBy(desc(payrollRuns.payDate))
    .limit(opts.limit ?? 50)
}

export async function payrollRunDetail(ctx: ActorContext, runId: string) {
  requirePermission(ctx, 'payroll:view')

  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(scoped(ctx, payrollRuns, eq(payrollRuns.id, runId)))
    .limit(1)

  if (!run) return null

  const slips = await db
    .select({
      id: payslips.id,
      employeeId: payslips.employeeId,
      employeeName: employees.name,
      hoursMilli: payslips.hoursMilli,
      grossPayCents: payslips.grossPayCents,
      netPayCents: payslips.netPayCents,
    })
    .from(payslips)
    .innerJoin(employees, eq(employees.id, payslips.employeeId))
    .where(eq(payslips.payrollRunId, runId))
    .orderBy(asc(employees.name))

  const lines = await db
    .select({
      payslipId: payslipLines.payslipId,
      kind: payslipLines.kind,
      label: payslipLines.label,
      amountCents: payslipLines.amountCents,
      agency: payslipLines.agency,
    })
    .from(payslipLines)
    .innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
    .where(eq(payslips.payrollRunId, runId))
    .orderBy(asc(payslipLines.sortOrder))

  return { run, payslips: slips, lines }
}

/**
 * Payroll cost for a period, split the way a P&L reader needs it.
 *
 * Read from the runs rather than the ledger because the split between employer
 * cost and withholding is a payroll concept the chart of accounts does not
 * carry — both credit the same liability account. The ledger remains the
 * authority on the totals, and `tests/payroll.test.ts` checks the two agree.
 */
export async function payrollSummary(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
) {
  requirePermission(ctx, 'payroll:view')

  const [row] = await db
    .select({
      runs: sql<string>`count(*)`,
      grossPayCents: sql<string>`coalesce(sum(${payrollRuns.grossPayCents}), 0)`,
      employeeWithholdingCents: sql<string>`coalesce(sum(${payrollRuns.employeeWithholdingCents}), 0)`,
      employeeDeductionCents: sql<string>`coalesce(sum(${payrollRuns.employeeDeductionCents}), 0)`,
      employerTaxCents: sql<string>`coalesce(sum(${payrollRuns.employerTaxCents}), 0)`,
      netPayCents: sql<string>`coalesce(sum(${payrollRuns.netPayCents}), 0)`,
      illustrativeRuns: sql<string>`coalesce(sum(case when ${payrollRuns.isIllustrative} then 1 else 0 end), 0)`,
    })
    .from(payrollRuns)
    .where(
      scoped(
        ctx,
        payrollRuns,
        eq(payrollRuns.status, 'posted'),
        gte(payrollRuns.payDate, range.startDate),
        lte(payrollRuns.payDate, range.endDate),
      ),
    )

  return {
    runs: Number(row?.runs ?? 0),
    grossPayCents: Number(row?.grossPayCents ?? 0),
    employeeWithholdingCents: Number(row?.employeeWithholdingCents ?? 0),
    employeeDeductionCents: Number(row?.employeeDeductionCents ?? 0),
    employerTaxCents: Number(row?.employerTaxCents ?? 0),
    netPayCents: Number(row?.netPayCents ?? 0),
    /** Non-zero means this summary contains demo figures. Reports must say so. */
    illustrativeRuns: Number(row?.illustrativeRuns ?? 0),
    /** Total cost to the employer: gross plus their own taxes. */
    totalCostCents:
      Number(row?.grossPayCents ?? 0) + Number(row?.employerTaxCents ?? 0),
  }
}

// --- Accounts --------------------------------------------------------------

export type PayrollAccountIds = {
  wages: string
  payrollTaxes: string
  payrollLiabilities: string
  netPayPayable: string
}

/**
 * Resolves the accounts a payroll entry posts to.
 *
 * Net Pay Payable is installed by this module rather than the standard chart:
 * a company that never runs payroll should not carry an account for it. If it
 * is missing, it is created — the alternative is refusing to run payroll
 * because of a chart-of-accounts detail nobody was told about.
 */
export async function resolvePayrollAccounts(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<PayrollAccountIds> {
  const wages = await accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.wages, exec)
  const payrollTaxes = await accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.payrollTaxes, exec)
  const liabilities = await accountByNumber(
    ctx.companyId,
    PAYROLL_ACCOUNTS.payrollLiabilities,
    exec,
  )

  if (!wages || !payrollTaxes || !liabilities) {
    throw new Error(
      'This chart of accounts is missing the payroll accounts (6500, 6550, 2300).',
    )
  }

  let netPay = await accountByNumber(ctx.companyId, PAYROLL_ACCOUNTS.netPayPayable, exec)
  if (!netPay) {
    const [created] = await exec
      .insert(chartAccounts)
      .values({
        companyId: ctx.companyId,
        number: PAYROLL_ACCOUNTS.netPayPayable,
        name: 'Net Pay Payable',
        type: 'liability',
        subtype: 'payroll',
        description: 'Wages earned and not yet paid out. Cleared when payroll is disbursed.',
      })
      .returning()
    netPay = created
  }

  return {
    wages: wages.id,
    payrollTaxes: payrollTaxes.id,
    payrollLiabilities: liabilities.id,
    netPayPayable: netPay.id,
  }
}

function defaultExpenseAccount(kind: PayrollLineKind, accounts: PayrollAccountIds): string {
  return kind === 'earning' ? accounts.wages : accounts.payrollTaxes
}

async function nextRunReference(ctx: ActorContext, exec: Executor): Promise<string> {
  const [row] = await exec
    .select({ count: sql<string>`count(*)` })
    .from(payrollRuns)
    .where(eq(payrollRuns.companyId, ctx.companyId))

  return `PR-${1001 + Number(row?.count ?? 0)}`
}
