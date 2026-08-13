/**
 * Payroll calculation, behind an adapter (spec §13, §19).
 *
 * The sixth use of the pattern — `BankProvider`, `AssetStore`,
 * `EmailProvider`, `AiProvider`, `PushProvider`, and now this. But it is the
 * one where the abstraction is not primarily about swappability.
 *
 * Spec §13 asks for payroll to be modular "due to jurisdictional and
 * compliance complexity". The reason that matters is narrower than
 * architecture: **this codebase must never be the thing that decided how much
 * tax to withhold from somebody's wages.** Withholding depends on
 * jurisdiction, filing status, year-to-date position, benefit elections, and
 * rules that change every year. A wrong figure takes money from a real
 * person's pay packet and exposes their employer to penalties.
 *
 * So the default adapter does not calculate at all. It takes what a payroll
 * bureau already worked out and records it. That is what most small businesses
 * actually do, and it is the only answer this system can give honestly.
 */

export type PayrollLineKind =
  | 'earning'
  | 'employee_tax'
  | 'employee_deduction'
  | 'employer_tax'
  | 'employer_contribution'

export type CalculatedLine = {
  kind: PayrollLineKind
  label: string
  /** Never negative; `kind` carries the direction. */
  amountCents: number
  /** Which agency it is owed to, when it is owed to one. */
  agency?: string
}

export type CalculatedPayslip = {
  employeeId: string
  hoursMilli: number
  lines: CalculatedLine[]
}

export type CalculationRequest = {
  companyId: string
  periodStart: string
  periodEnd: string
  payDate: string
  employees: Array<{
    id: string
    name: string
    payBasis: 'salary' | 'hourly'
    baseRateCents: number
    /** For hourly workers; ignored for salary. */
    hoursMilli?: number
    /** Bonus, commission, or anything else on top, in cents. */
    additionalCents?: number
  }>
}

export type CalculationResult =
  | {
      ok: true
      payslips: CalculatedPayslip[]
      /**
       * True when these figures are illustrative rather than a real
       * calculation. Carried through to the stored run so a report can refuse
       * to present them as real.
       */
      illustrative: boolean
      /** Shown to the person before they post. Never empty for a demo. */
      notice?: string
    }
  | { ok: false; reason: string }

export interface PayrollProvider {
  readonly key: string
  /** Human label for the settings page. */
  readonly label: string
  /**
   * False when the adapter cannot compute and the figures must be entered by
   * hand. The `manual` adapter is the honest case of this.
   */
  readonly calculates: boolean
  isConfigured(): boolean
  calculate(request: CalculationRequest): Promise<CalculationResult>
}

/**
 * The default. Calculates nothing.
 *
 * A bookkeeper runs payroll through their bureau, gets a report, and enters
 * the figures here so the books are right. That is not a degraded mode — it is
 * how the overwhelming majority of small businesses run payroll, and a system
 * that recorded it faithfully and posted a correct journal entry would be
 * useful even if it never gained a calculating adapter at all.
 */
export class ManualPayrollProvider implements PayrollProvider {
  readonly key = 'manual'
  readonly label = 'Entered by hand from a payroll bureau report'
  readonly calculates = false

  isConfigured(): boolean {
    return true
  }

  async calculate(): Promise<CalculationResult> {
    return {
      ok: false,
      reason:
        'This adapter does not calculate payroll. Enter the figures from your payroll ' +
        'provider’s report — the run will be posted exactly as you enter it.',
    }
  }
}

/**
 * Flat illustrative rates, for the demo and the tests.
 *
 * ## Read this before using it for anything
 *
 * These percentages are **invented**. They are round numbers chosen to make a
 * demo legible, they correspond to no jurisdiction, and they are not updated
 * when anything changes anywhere. Every run it produces is stamped
 * `isIllustrative`, every screen that shows one says so, and the reports
 * refuse to fold it into a figure presented as real.
 *
 * It exists so the ledger machinery — the balanced entry, the employer/employee
 * split, the liability accrual, the remittance — can be exercised end to end by
 * the tests without a payroll bureau. It is not a fallback for a company that
 * has not configured a real one, which is why `manual` and not this is the
 * default.
 */
export class IllustrativePayrollProvider implements PayrollProvider {
  readonly key = 'illustrative'
  readonly label = 'Illustrative rates (demo only — not real tax rates)'
  readonly calculates = true

  /** Invented. Not any jurisdiction's rates. See the class docs. */
  private static readonly RATES = {
    employeeIncomeTaxBp: 1500,
    employeeSocialBp: 620,
    employerSocialBp: 620,
    employerUnemploymentBp: 60,
  }

  isConfigured(): boolean {
    return true
  }

  async calculate(request: CalculationRequest): Promise<CalculationResult> {
    const payslips = request.employees.map((employee) => {
      const gross = grossFor(employee, request)
      const rates = IllustrativePayrollProvider.RATES

      const lines: CalculatedLine[] = [
        { kind: 'earning', label: employee.payBasis === 'hourly' ? 'Hourly pay' : 'Salary', amountCents: gross },
        {
          kind: 'employee_tax',
          label: 'Income tax withheld',
          amountCents: bp(gross, rates.employeeIncomeTaxBp),
          agency: 'Revenue authority',
        },
        {
          kind: 'employee_tax',
          label: 'Social contribution withheld',
          amountCents: bp(gross, rates.employeeSocialBp),
          agency: 'Revenue authority',
        },
        {
          kind: 'employer_tax',
          label: 'Employer social contribution',
          amountCents: bp(gross, rates.employerSocialBp),
          agency: 'Revenue authority',
        },
        {
          kind: 'employer_tax',
          label: 'Employer unemployment contribution',
          amountCents: bp(gross, rates.employerUnemploymentBp),
          agency: 'Unemployment fund',
        },
      ]

      return {
        employeeId: employee.id,
        hoursMilli: employee.hoursMilli ?? 0,
        lines: lines.filter((line) => line.amountCents > 0),
      }
    })

    return {
      ok: true,
      payslips,
      illustrative: true,
      notice:
        'These figures use invented flat rates for demonstration. They are not the tax rates ' +
        'of any jurisdiction and must not be used to pay anybody.',
    }
  }
}

/** Rounds a basis-point share of an amount, half-up, in integer cents. */
function bp(amountCents: number, rateBp: number): number {
  return Math.round((amountCents * rateBp) / 10_000)
}

/** Gross for one employee for one period. */
function grossFor(
  employee: CalculationRequest['employees'][number],
  request: CalculationRequest,
): number {
  const additional = employee.additionalCents ?? 0

  if (employee.payBasis === 'hourly') {
    return Math.round((employee.baseRateCents * (employee.hoursMilli ?? 0)) / 1000) + additional
  }

  // Salary is annual; divide by the number of periods in a year.
  return Math.round(employee.baseRateCents / periodsPerYear(request)) + additional
}

/**
 * How many pay periods a year, inferred from the period length.
 *
 * Inferred rather than passed, so a run whose dates say "a fortnight" cannot
 * be paid at a monthly rate because a dropdown said monthly.
 */
function periodsPerYear(request: CalculationRequest): number {
  const days =
    Math.round(
      (Date.parse(`${request.periodEnd}T00:00:00Z`) -
        Date.parse(`${request.periodStart}T00:00:00Z`)) /
        86_400_000,
    ) + 1

  if (days <= 8) return 52
  if (days <= 16) return 26
  if (days <= 17) return 24
  return 12
}

const providers = new Map<string, PayrollProvider>()

export function registerPayrollProvider(provider: PayrollProvider): void {
  providers.set(provider.key, provider)
}

registerPayrollProvider(new ManualPayrollProvider())
registerPayrollProvider(new IllustrativePayrollProvider())

/**
 * The adapter in use.
 *
 * Unlike every other registry in this codebase, there is **no fallback**. The
 * others degrade to a mock when the real one is unconfigured, because sending
 * no email is better than crashing. Here, silently substituting one source of
 * payroll figures for another is the failure — so an unknown key throws.
 */
export function getPayrollProvider(key?: string): PayrollProvider {
  const requested = key ?? process.env.PAYROLL_PROVIDER ?? 'manual'
  const provider = providers.get(requested)

  if (!provider) {
    throw new Error(
      `Unknown payroll provider "${requested}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }

  return provider
}

export function payrollProviderStatus() {
  return [...providers.values()].map((provider) => ({
    key: provider.key,
    label: provider.label,
    calculates: provider.calculates,
    configured: provider.isConfigured(),
  }))
}
