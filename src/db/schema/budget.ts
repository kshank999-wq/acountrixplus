import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  unique,
  index,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'

/**
 * What a business planned to earn and spend (spec §13).
 *
 * ## A budget is not a second ledger
 *
 * Nothing in these two tables ever becomes a journal line. A budget is a
 * statement of intent, and the moment it starts posting entries it stops being
 * comparable to the actuals it exists to be compared against — the actuals
 * would include it.
 *
 * That sounds obvious and is the mistake worth naming, because every other
 * amount in this schema *does* post. `budget_lines` is the first table holding
 * money that the trial balance has never heard of, and it must stay that way.
 *
 * ## Why a month is the grain
 *
 * Not a quarter, because a business that misses January and catches up in
 * March has had a problem that a quarterly budget hides. Not a day, because
 * nobody plans a Tuesday.
 *
 * A month also happens to be what every accounting package a customer might be
 * arriving from uses, which matters for an import that does not exist yet but
 * would be miserable to retrofit.
 *
 * ## Several budgets per year, on purpose
 *
 * "Approved" and "Revised" and "What if we hire two people" are all real, and a
 * business that can only hold one plan is one that overwrites the number it
 * agreed with its bank. The uniqueness is on *name within a year*, so a
 * revision is a new budget rather than an edit to the one people signed.
 */

export const budgetStatusEnum = pgEnum('budget_status', ['draft', 'approved', 'archived'])

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** "2026 Approved", "2026 Revised — after the Bremen contract". */
    name: text('name').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),

    /**
     * `draft` while it is being built, `approved` once somebody has agreed it,
     * `archived` when a later revision supersedes it.
     *
     * Approval is not a lock: a plan somebody keeps adjusting is a plan, and
     * refusing to let them would send the adjusting into a spreadsheet where
     * nothing can compare it to anything. What approval does is name which of
     * several budgets the reports mean when nobody says.
     */
    status: budgetStatusEnum('status').notNull().default('draft'),

    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('budgets_company_year_name_key').on(table.companyId, table.fiscalYear, table.name),
    index('budgets_company_year_idx').on(table.companyId, table.fiscalYear),
  ],
)

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'cascade' }),

    /** 1–12. A fiscal year that does not start in January is a follow-up. */
    month: integer('month').notNull(),

    /**
     * In the account's **normal** direction, the same convention
     * `balanceForAccount` returns and the P&L displays.
     *
     * Storing it signed against debits-positive instead would mean every
     * revenue budget was entered as a negative number by somebody who thinks
     * of it as income, which is a data-entry trap with no upside.
     */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One figure per account per month per budget. Two rows for the same cell
    // is not a correction, it is an ambiguity — and unlike a rate (Phase 35)
    // there is no sensible "most recent wins", because a budget is edited by
    // whoever has the screen open.
    unique('budget_lines_budget_account_month_key').on(
      table.budgetId,
      table.chartAccountId,
      table.month,
    ),
    index('budget_lines_budget_idx').on(table.budgetId),
    // Month 13 is not a month. The service checks it too, for a message
    // somebody can act on — but a bound the database does not know is one that
    // a future import, a fixture, or a `psql` session can walk straight past.
    check('budget_lines_month_range', sql`${table.month} BETWEEN 1 AND 12`),
  ],
)
