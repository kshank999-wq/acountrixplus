'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createEmployee,
  createPayrollRun,
  totalsFor,
  voidPayrollRun,
  type PayslipInput,
} from '@/modules/payroll/service'
import { getPayrollProvider } from '@/modules/payroll/provider'
import { recordRemittance } from '@/modules/payroll/remittance'
import { createTaxCode } from '@/modules/payroll/sales-tax'
import { setVendorReporting } from '@/modules/payroll/vendor-reporting'
import { FilingBlockedError, markFiledExternally, prepareFiling } from '@/modules/payroll/workpapers'
import { messageFor } from '@/modules/errors'

/**
 * Server actions for the payroll and tax workspace.
 *
 * Every one of these ends in a service that checks its own permission, so the
 * action layer validates shape and nothing else. The pattern is the same as
 * every other workspace; what is different is that two of them refuse loudly
 * rather than degrading, and the UI is built to show the refusal.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PAYROLL_PATHS = [
  '/payroll',
  '/payroll/people',
  '/payroll/run',
  '/payroll/liabilities',
  '/payroll/workpapers',
]

async function run(
  path: string | string[],
  fn: () => Promise<string | void>,
): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const entry of Array.isArray(path) ? path : [path]) revalidatePath(entry)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

const cents = z.number().int()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31.')

// --- People ----------------------------------------------------------------

const employeeSchema = z.object({
  name: z.string().trim().min(1, 'A worker needs a name.'),
  reference: z.string().trim().optional(),
  email: z.string().trim().email('That is not an email address.').optional().or(z.literal('')),
  workerType: z.enum(['employee', 'contractor']),
  payBasis: z.enum(['salary', 'hourly']),
  baseRateCents: cents.min(0, 'A rate cannot be negative.'),
  // Four characters, never more. The service refuses a longer value too; this
  // is the same rule stated at the edge so the form can say it before a round
  // trip rather than after.
  taxIdLast4: z
    .string()
    .trim()
    .max(4, 'Only the last four digits belong here.')
    .optional()
    .or(z.literal('')),
  startDate: isoDate.optional().or(z.literal('')),
})

export async function createEmployeeAction(input: unknown): Promise<ActionResult> {
  return run(PAYROLL_PATHS, async () => {
    const actor = await requireActor()
    const parsed = employeeSchema.parse(input)

    const employee = await createEmployee(actor, {
      name: parsed.name,
      reference: parsed.reference || undefined,
      email: parsed.email || undefined,
      workerType: parsed.workerType,
      payBasis: parsed.payBasis,
      baseRateCents: parsed.baseRateCents,
      taxIdLast4: parsed.taxIdLast4 || undefined,
      startDate: parsed.startDate || undefined,
    })

    return `${employee.name} added.`
  })
}

// --- Runs ------------------------------------------------------------------

const payslipSchema = z.object({
  employeeId: z.string().uuid(),
  hoursMilli: z.number().int().min(0).optional(),
  lines: z
    .array(
      z.object({
        kind: z.enum([
          'earning',
          'employee_tax',
          'employee_deduction',
          'employer_tax',
          'employer_contribution',
        ]),
        label: z.string().trim().min(1, 'Every payroll line needs a label.'),
        amountCents: cents.min(0, 'Payroll amounts are always positive.'),
        agency: z.string().trim().optional(),
      }),
    )
    .min(1, 'A payslip needs at least one line.'),
})

const runSchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  payDate: isoDate,
  frequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']),
  memo: z.string().trim().optional(),
  sourceReference: z.string().trim().optional(),
  isIllustrative: z.boolean().optional(),
  payslips: z.array(payslipSchema).min(1, 'A payroll run needs at least one payslip.'),
})

/**
 * Works out what a set of figures would post, without posting it.
 *
 * The wizard calls this before the confirm step. Showing somebody the entry
 * their numbers produce is the only way the withholding-is-not-an-expense
 * distinction ever becomes visible — a totals row looks identical either way.
 */
export async function previewPayrollAction(input: unknown): Promise<
  | {
      ok: true
      totals: ReturnType<typeof totalsFor>
      lines: Array<{ account: string; debitCents: number; creditCents: number; memo: string }>
    }
  | { ok: false; error: string }
> {
  try {
    await requireActor()
    const parsed = runSchema.parse(input)
    const payslips: PayslipInput[] = parsed.payslips
    const totals = totalsFor(payslips)

    // Grouped by the account each kind lands on, which is the shape the
    // journal entry takes. Names rather than ids: this is for reading.
    const lines = [
      {
        account: '6500 Salaries and Wages',
        debitCents: totals.grossPayCents,
        creditCents: 0,
        memo: 'Gross pay — the whole of it, before anything is withheld.',
      },
      {
        account: '6550 Payroll Taxes',
        debitCents: totals.employerCostCents,
        creditCents: 0,
        memo: 'The employer’s own taxes and contributions, on top of gross.',
      },
      {
        account: '2300 Payroll Liabilities',
        debitCents: 0,
        creditCents:
          totals.employeeWithholdingCents +
          totals.employeeDeductionCents +
          totals.employerCostCents,
        memo: 'Withheld from pay and accrued by the employer, owed to agencies.',
      },
      {
        account: '2350 Net Pay Payable',
        debitCents: 0,
        creditCents: totals.netPayCents,
        memo: 'What the people actually receive.',
      },
    ].filter((line) => line.debitCents > 0 || line.creditCents > 0)

    return { ok: true, totals, lines }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Those figures could not be read.'),
    }
  }
}

export async function postPayrollRunAction(input: unknown): Promise<ActionResult> {
  return run([...PAYROLL_PATHS, '/accounting'], async () => {
    const actor = await requireActor()
    const parsed = runSchema.parse(input)

    const posted = await createPayrollRun(actor, {
      frequency: parsed.frequency,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      payDate: parsed.payDate,
      memo: parsed.memo || undefined,
      sourceReference: parsed.sourceReference || undefined,
      isIllustrative: parsed.isIllustrative ?? false,
      payslips: parsed.payslips,
    })

    return `${posted.reference} posted — ${parsed.payslips.length} ${parsed.payslips.length === 1 ? 'payslip' : 'payslips'}, entry balanced.`
  })
}

export async function voidPayrollRunAction(runId: string, reason: string): Promise<ActionResult> {
  return run([...PAYROLL_PATHS, '/accounting'], async () => {
    const actor = await requireActor()
    await voidPayrollRun(actor, z.string().uuid().parse(runId), reason.trim() || undefined)
    return 'Run voided and its entry reversed.'
  })
}

/**
 * Asks the configured adapter for figures.
 *
 * Returns the adapter's refusal verbatim when it does not calculate, because
 * that refusal is the honest answer and paraphrasing it into "unavailable"
 * would make it look like a fault.
 */
export async function calculatePayrollAction(input: {
  periodStart: string
  periodEnd: string
  payDate: string
  providerKey?: string
  employees: Array<{
    id: string
    name: string
    payBasis: 'salary' | 'hourly'
    baseRateCents: number
    hoursMilli?: number
    additionalCents?: number
  }>
}): Promise<
  | { ok: true; payslips: PayslipInput[]; illustrative: boolean; notice?: string }
  | { ok: false; error: string }
> {
  try {
    const actor = await requireActor()
    const provider = getPayrollProvider(input.providerKey)

    const result = await provider.calculate({
      companyId: actor.companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payDate: input.payDate,
      employees: input.employees,
    })

    if (!result.ok) return { ok: false, error: result.reason }

    return {
      ok: true,
      payslips: result.payslips.map((slip) => ({
        employeeId: slip.employeeId,
        hoursMilli: slip.hoursMilli,
        lines: slip.lines,
      })),
      illustrative: result.illustrative,
      notice: result.notice,
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'The payroll adapter could not be reached.'),
    }
  }
}

// --- Remittances -----------------------------------------------------------

const remittanceSchema = z.object({
  kind: z.enum(['payroll', 'sales_tax']),
  agency: z.string().trim().min(1, 'Say which agency this went to.'),
  periodStart: isoDate,
  periodEnd: isoDate,
  paidOn: isoDate,
  amountCents: cents.positive('A remittance must be greater than zero.'),
  liabilityAccountId: z.string().uuid(),
  financialAccountId: z.string().uuid('Choose the bank account it was paid from.'),
  reference: z.string().trim().optional(),
})

export async function recordRemittanceAction(input: unknown): Promise<ActionResult> {
  return run([...PAYROLL_PATHS, '/payroll/sales-tax', '/accounting'], async () => {
    const actor = await requireActor()
    const parsed = remittanceSchema.parse(input)

    await recordRemittance(actor, {
      ...parsed,
      reference: parsed.reference || undefined,
    })

    return 'Remittance recorded and the liability cleared.'
  })
}

// --- Sales tax -------------------------------------------------------------

const taxCodeSchema = z.object({
  code: z.string().trim().min(1, 'A tax code needs a code.'),
  name: z.string().trim().min(1, 'A tax code needs a name.'),
  jurisdiction: z.string().trim().min(1, 'A tax code needs a jurisdiction.'),
  rateBp: z
    .number()
    .int()
    .min(0, 'A tax rate cannot be negative.')
    .max(10_000, 'A tax rate must be between 0% and 100%.'),
  isExempt: z.boolean().optional(),
  effectiveFrom: isoDate.optional().or(z.literal('')),
})

export async function createTaxCodeAction(input: unknown): Promise<ActionResult> {
  return run('/payroll/sales-tax', async () => {
    const actor = await requireActor()
    const parsed = taxCodeSchema.parse(input)

    const created = await createTaxCode(actor, {
      ...parsed,
      effectiveFrom: parsed.effectiveFrom || undefined,
    })

    return `${created.code} added for ${created.jurisdiction}.`
  })
}

// --- Contractors -----------------------------------------------------------

const vendorReportingSchema = z.object({
  vendorId: z.string().uuid(),
  isReportable: z.boolean(),
  taxId: z.string().trim().optional(),
})

export async function setVendorReportingAction(input: unknown): Promise<ActionResult> {
  return run('/payroll/contractors', async () => {
    const actor = await requireActor()
    const parsed = vendorReportingSchema.parse(input)

    await setVendorReporting(actor, parsed.vendorId, {
      isReportable: parsed.isReportable,
      // `undefined` leaves the stored identifier alone; an empty string clears
      // it. The two are different intentions and the service honours both.
      taxId: parsed.taxId === undefined ? undefined : parsed.taxId || null,
    })

    return parsed.isReportable ? 'Marked reportable.' : 'No longer marked reportable.'
  })
}

// --- Filings ---------------------------------------------------------------

const filingSchema = z.object({
  kind: z.enum(['sales_tax', 'payroll', 'contractor']),
  jurisdiction: z.string().trim().optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  figures: z.record(z.string(), z.unknown()).optional(),
  overrideReason: z.string().trim().optional(),
})

export async function prepareFilingAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = filingSchema.parse(input)

    await prepareFiling(actor, {
      kind: parsed.kind,
      jurisdiction: parsed.jurisdiction || undefined,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      figures: parsed.figures ?? {},
      overrideReason: parsed.overrideReason || undefined,
    })

    revalidatePath('/payroll/workpapers')
    return {
      ok: true,
      message: parsed.overrideReason
        ? 'Prepared, with the override and every exception recorded against it.'
        : 'Prepared. The figures and the exceptions found are frozen against this period.',
    }
  } catch (error) {
    // A blocked filing is not a failure to communicate around: the whole point
    // is that somebody sees exactly what is wrong before they decide.
    if (error instanceof FilingBlockedError) {
      return { ok: false, error: error.message }
    }
    return {
      ok: false,
      error: messageFor(error, 'That filing could not be prepared.'),
    }
  }
}

const markFiledSchema = z.object({
  filingId: z.string().uuid(),
  filedOn: isoDate,
  note: z.string().trim().min(1, 'Say where it was filed and with what reference.'),
})

export async function markFiledExternallyAction(input: unknown): Promise<ActionResult> {
  return run('/payroll/workpapers', async () => {
    const actor = await requireActor()
    const parsed = markFiledSchema.parse(input)

    await markFiledExternally(actor, parsed.filingId, {
      filedOn: parsed.filedOn,
      note: parsed.note,
    })

    return 'Recorded as filed elsewhere.'
  })
}
