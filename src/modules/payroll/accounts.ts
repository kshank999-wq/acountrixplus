/**
 * Account numbers payroll and tax look up (spec §13).
 *
 * Kept apart from `SYSTEM_ACCOUNTS` and `INDUSTRY_ACCOUNTS` for the same
 * reason those are kept apart from each other: these are the accounts *this
 * module* needs, and a company that never runs payroll should not be asked to
 * carry them. Only `netPayPayable` is created on demand; the rest are in the
 * standard chart already.
 */
export const PAYROLL_ACCOUNTS = {
  /** 6500 — gross wages. Always gross, never net (see `service.ts`). */
  wages: '6500',
  /** 6550 — the employer's own payroll taxes. Never employee withholding. */
  payrollTaxes: '6550',
  /** 2300 — everything withheld or accrued and owed to an agency. */
  payrollLiabilities: '2300',
  /** 2350 — earned and not yet disbursed. Created on first payroll run. */
  netPayPayable: '2350',
  /** 2200 — sales tax collected and owed. */
  salesTaxPayable: '2200',
} as const
