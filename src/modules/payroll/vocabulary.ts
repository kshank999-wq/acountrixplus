import type { PayrollLineKind } from './provider'

/**
 * Labels for payroll line kinds, in a module a client component can import.
 *
 * The same seam as `@/modules/jobs/vocabulary`: the services in this folder
 * reach the database, and a `'use client'` file that imports one drags the
 * driver into the browser bundle. Words are not data, so they live here.
 */
export const PAYROLL_KIND_LABELS: Record<PayrollLineKind, string> = {
  earning: 'Earning',
  employee_tax: 'Withheld from pay — tax',
  employee_deduction: 'Withheld from pay — deduction',
  employer_tax: 'Employer tax',
  employer_contribution: 'Employer contribution',
}

/**
 * Which side of the entry each kind lands on.
 *
 * Stated once, here, so the run wizard can show somebody what their figures
 * will do to the books before they post — the misunderstanding this whole
 * module is shaped around is that withholding is an employer cost, and a
 * screen that only shows totals never corrects it.
 */
export const PAYROLL_KIND_EFFECT: Record<PayrollLineKind, string> = {
  earning: 'Debits wage expense, and adds to gross pay.',
  employee_tax: 'Credits a liability. No expense — this is the employee’s money in transit.',
  employee_deduction: 'Credits a liability. No expense — withheld from what the employee earned.',
  employer_tax: 'Debits payroll tax expense and credits a liability. A cost on top of gross.',
  employer_contribution: 'Debits payroll tax expense and credits a liability. A cost on top of gross.',
}

export const PAYROLL_KINDS: PayrollLineKind[] = [
  'earning',
  'employee_tax',
  'employee_deduction',
  'employer_tax',
  'employer_contribution',
]

/** Whether a kind is money the employer spends, as opposed to money it holds. */
export function isEmployerCost(kind: PayrollLineKind): boolean {
  return kind === 'earning' || kind === 'employer_tax' || kind === 'employer_contribution'
}
