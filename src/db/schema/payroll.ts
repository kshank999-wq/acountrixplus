import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { journalEntries } from './ledger'
import { projects } from './crm'
import { costCodes } from './jobs'

/**
 * Payroll and tax (spec §13, §19, §20 Phase 8).
 *
 * ## What this module is, and emphatically is not
 *
 * Spec §13: "Sales tax and payroll should use modular/integration architecture
 * due to jurisdictional and compliance complexity."
 *
 * So this is a **bookkeeping system for payroll**, not a payroll engine. It
 * records what a payroll run consisted of, posts the resulting journal entry,
 * tracks what is owed to which agency, and produces the workpapers an
 * accountant needs. It does not decide how much tax to withhold, and it files
 * nothing with anybody.
 *
 * That boundary is not modesty. Withholding depends on jurisdiction, filing
 * status, year-to-date position, benefit elections, and a body of rules that
 * changes annually — and a wrong answer costs a real person real money and
 * exposes their employer to penalties. A number this system invented and
 * presented with the same confidence as a bank balance would be a liability
 * dressed as a feature.
 *
 * Every figure that comes from *outside* a calculation therefore records where
 * it came from: which provider, which version, and whether it was computed or
 * typed in by a person reading a bureau's report.
 */

/** How often a pay schedule runs. Drives period boundaries, nothing else. */
export const payFrequencyEnum = pgEnum('pay_frequency', [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
])

/** Employee or contractor. Contractors are 1099-reportable, not payrolled. */
export const workerTypeEnum = pgEnum('worker_type', ['employee', 'contractor'])

export const payBasisEnum = pgEnum('pay_basis', ['salary', 'hourly'])

/**
 * A worker.
 *
 * Deliberately thin on personal data. A payroll bureau holds the tax file
 * numbers, addresses, and filing statuses; this system holds enough to label a
 * payslip and post an entry. The less of it that lives here, the smaller the
 * consequence of this database being read by somebody who should not.
 */
export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Payroll number as the bureau knows them, for reconciling reports. */
    reference: text('reference'),
    name: text('name').notNull(),
    email: text('email'),
    workerType: workerTypeEnum('worker_type').notNull().default('employee'),
    payBasis: payBasisEnum('pay_basis').notNull().default('salary'),

    /** Annual salary, or the hourly rate, both in cents. */
    baseRateCents: bigint('base_rate_cents', { mode: 'number' }).notNull().default(0),

    /**
     * Last four digits only, for matching a bureau report line to a person.
     *
     * Never the whole identifier. A full national tax number is the single
     * most abusable field a small business database can hold, and nothing this
     * system does needs one — the bureau that files already has it.
     */
    taxIdLast4: text('tax_id_last4'),

    startDate: date('start_date'),
    endDate: date('end_date'),
    isActive: boolean('is_active').notNull().default(true),

    /** Default job costing dimensions for this person's labour (Phase 7). */
    defaultProjectId: uuid('default_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    defaultCostCodeId: uuid('default_cost_code_id').references(() => costCodes.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('employees_company_idx').on(t.companyId, t.isActive),
    referenceUnique: unique('employees_company_reference_unique').on(t.companyId, t.reference),
    last4Length: check(
      'employees_tax_id_last4_length',
      sql`${t.taxIdLast4} IS NULL OR length(${t.taxIdLast4}) <= 4`,
    ),
  }),
)

/** A payroll run's position in its lifecycle. Only `posted` reaches the ledger. */
export const payrollRunStatusEnum = pgEnum('payroll_run_status', [
  'draft',
  'posted',
  'void',
])

/**
 * One payroll run: a pay period, its payslips, and the entry it posted.
 *
 * `sourceProvider` and `sourceReference` are not decoration. When a figure on
 * a statement is questioned two years later, the question is "where did this
 * come from", and the answer has to be a specific bureau report rather than
 * "the software worked it out".
 */
export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    reference: text('reference').notNull(),
    frequency: payFrequencyEnum('frequency').notNull().default('monthly'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** The date the entry posts under, which is the pay date, not period end. */
    payDate: date('pay_date').notNull(),

    status: payrollRunStatusEnum('status').notNull().default('draft'),

    /** Which adapter produced these figures: `manual`, `illustrative`, … */
    sourceProvider: text('source_provider').notNull().default('manual'),
    /** The bureau's own report id, so a figure can be traced to its source. */
    sourceReference: text('source_reference'),
    /**
     * True when the figures came from the illustrative adapter rather than a
     * real payroll calculation. Stored on the row rather than inferred, so a
     * report can refuse to present demo numbers as real ones.
     */
    isIllustrative: boolean('is_illustrative').notNull().default(false),

    /** Totals, all in cents. Derived from the payslips and stored for reports. */
    grossPayCents: bigint('gross_pay_cents', { mode: 'number' }).notNull().default(0),
    employeeWithholdingCents: bigint('employee_withholding_cents', { mode: 'number' })
      .notNull()
      .default(0),
    employeeDeductionCents: bigint('employee_deduction_cents', { mode: 'number' })
      .notNull()
      .default(0),
    netPayCents: bigint('net_pay_cents', { mode: 'number' }).notNull().default(0),
    /** The employer's own cost on top of gross — never withheld from anyone. */
    employerTaxCents: bigint('employer_tax_cents', { mode: 'number' }).notNull().default(0),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    memo: text('memo'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referenceUnique: unique('payroll_runs_company_reference_unique').on(
      t.companyId,
      t.reference,
    ),
    periodIdx: index('payroll_runs_period_idx').on(t.companyId, t.payDate),
    periodOrder: check('payroll_runs_period_order', sql`${t.periodEnd} >= ${t.periodStart}`),
  }),
)

/** One person's pay for one run. */
export const payslips = pgTable(
  'payslips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    payrollRunId: uuid('payroll_run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),

    /** Thousandths of an hour, so 7.5 hours is 7500. */
    hoursMilli: bigint('hours_milli', { mode: 'number' }).notNull().default(0),
    grossPayCents: bigint('gross_pay_cents', { mode: 'number' }).notNull().default(0),
    netPayCents: bigint('net_pay_cents', { mode: 'number' }).notNull().default(0),

    /** Job costing dimensions for this person's labour on this run. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('payslips_run_idx').on(t.payrollRunId),
    employeeIdx: index('payslips_employee_idx').on(t.companyId, t.employeeId),
    onePerRun: unique('payslips_run_employee_unique').on(t.payrollRunId, t.employeeId),
  }),
)

/**
 * Who bears a payroll line: the employee (withheld from their gross) or the
 * employer (an additional cost).
 *
 * This distinction is the one a payroll journal entry most often gets wrong,
 * and getting it wrong overstates or understates wage cost while still
 * balancing — so it is an enum rather than a convention.
 */
export const payrollItemKindEnum = pgEnum('payroll_item_kind', [
  /** Adds to gross pay: salary, hourly, overtime, bonus. */
  'earning',
  /** Withheld from the employee and owed to an agency. */
  'employee_tax',
  /** Withheld from the employee and owed to somebody else: pension, union. */
  'employee_deduction',
  /** The employer's own tax, on top of gross. */
  'employer_tax',
  /** The employer's own contribution, on top of gross. */
  'employer_contribution',
])

/**
 * A line on a payslip.
 *
 * Every line names the account it posts to and the liability it creates, so
 * the journal entry is derived from the payslip rather than assembled by a
 * rule somewhere that has to be kept in step with it.
 */
export const payslipLines = pgTable(
  'payslip_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    payslipId: uuid('payslip_id')
      .notNull()
      .references(() => payslips.id, { onDelete: 'cascade' }),

    kind: payrollItemKindEnum('kind').notNull(),
    /** What appears on the payslip: "Income tax", "Pension", "Overtime". */
    label: text('label').notNull(),
    /** Never negative; `kind` carries the direction. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),

    /** The expense account an earning or employer cost is charged to. */
    expenseAccountId: uuid('expense_account_id').references(() => chartAccounts.id, {
      onDelete: 'restrict',
    }),
    /** The liability account a withholding or employer tax accrues into. */
    liabilityAccountId: uuid('liability_account_id').references(() => chartAccounts.id, {
      onDelete: 'restrict',
    }),

    /** The agency this is owed to, for the remittance list. */
    agency: text('agency'),

    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    payslipIdx: index('payslip_lines_payslip_idx').on(t.payslipId),
    nonNegative: check('payslip_lines_non_negative', sql`${t.amountCents} >= 0`),
  }),
)

/**
 * A remittance: money sent to an agency against an accrued liability.
 *
 * Records that a payment was made. It does not make the payment and it does
 * not file the return that accompanies it — see the module docs.
 */
export const taxRemittances = pgTable(
  'tax_remittances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** payroll | sales_tax — which kind of liability this clears. */
    kind: text('kind').notNull(),
    agency: text('agency').notNull(),
    /** The period the remittance covers, for tying to a filed return. */
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    paidOn: date('paid_on').notNull(),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    liabilityAccountId: uuid('liability_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    financialAccountId: uuid('financial_account_id')
      .notNull()
      .references(() => financialAccounts.id, { onDelete: 'restrict' }),

    /** The confirmation number from whoever actually took the money. */
    reference: text('reference'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('tax_remittances_company_idx').on(t.companyId, t.paidOn),
    positive: check('tax_remittances_positive', sql`${t.amountCents} > 0`),
  }),
)

/**
 * A sales tax code: a named rate the company itself maintains.
 *
 * Rates are **the company's own data**, never a table shipped with the
 * software. A rate table in a release goes stale the moment a jurisdiction
 * changes, and stale-but-authoritative-looking is the worst possible state for
 * a number somebody is about to remit against.
 */
export const taxCodes = pgTable(
  'tax_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The jurisdiction this remits to, which is what the return is filed with. */
    jurisdiction: text('jurisdiction').notNull(),

    /** Basis points: 8.25% is 825. Integer, like every other ratio here. */
    rateBp: integer('rate_bp').notNull().default(0),
    /** True for a zero-rated or exempt code, which still belongs on a return. */
    isExempt: boolean('is_exempt').notNull().default(false),

    liabilityAccountId: uuid('liability_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),

    /** Effective dates, so a rate change does not rewrite history. */
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('tax_codes_company_code_unique').on(t.companyId, t.code),
    companyIdx: index('tax_codes_company_idx').on(t.companyId, t.isActive),
    rateRange: check('tax_codes_rate_range', sql`${t.rateBp} >= 0 AND ${t.rateBp} <= 10000`),
  }),
)

/**
 * What a document's tax came from.
 *
 * `invoices.taxCents` already existed and stays the authority on the total.
 * This records the breakdown by code, so a return can report per jurisdiction
 * without re-deriving it from a single lump figure that cannot be split.
 */
export const documentTaxLines = pgTable(
  'document_tax_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** invoice | bill. Text rather than an FK so one table serves both. */
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    documentDate: date('document_date').notNull(),

    taxCodeId: uuid('tax_code_id')
      .notNull()
      .references(() => taxCodes.id, { onDelete: 'restrict' }),

    /** The amount the rate was applied to. */
    taxableCents: bigint('taxable_cents', { mode: 'number' }).notNull().default(0),
    /** Sales that were exempt under this code, which a return still reports. */
    exemptCents: bigint('exempt_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    /** The rate as applied, kept so a later rate change cannot rewrite it. */
    rateBp: integer('rate_bp').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    documentIdx: index('document_tax_lines_document_idx').on(t.documentType, t.documentId),
    periodIdx: index('document_tax_lines_period_idx').on(t.companyId, t.documentDate),
  }),
)

/**
 * A prepared filing: figures assembled for a return, and the fact that a
 * person marked it as filed elsewhere.
 *
 * There is no integration behind this and deliberately so. Spec §19 requires a
 * security review before production use of tax filing, and this codebase has
 * not had one. What it can honestly offer is the arithmetic and an audit trail
 * of who prepared it and who says they filed it.
 */
export const taxFilings = pgTable(
  'tax_filings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** sales_tax | payroll | 1099 */
    kind: text('kind').notNull(),
    jurisdiction: text('jurisdiction'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),

    /** The computed figures, frozen at preparation. */
    figures: jsonb('figures').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * prepared | filed_externally
     *
     * There is no `filed` — this system never files, so a status claiming it
     * did would be a lie the database told.
     */
    status: text('status').notNull().default('prepared'),
    /** What the person did with it, and where. Free text, deliberately. */
    filedNote: text('filed_note'),
    filedOn: date('filed_on'),

    preparedBy: uuid('prepared_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUnique: unique('tax_filings_period_unique').on(
      t.companyId,
      t.kind,
      t.jurisdiction,
      t.periodStart,
      t.periodEnd,
    ),
    companyIdx: index('tax_filings_company_idx').on(t.companyId, t.kind, t.periodEnd),
  }),
)
