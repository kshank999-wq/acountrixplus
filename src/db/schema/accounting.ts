import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  unique,
  index,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { companies } from './tenancy'

/**
 * The conventional account structure required by spec §5. Every company starts
 * with these classes; industry packs add accounts within them rather than
 * inventing a parallel structure.
 */
export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
])

/** How a financial account is held at the institution. */
export const financialAccountKindEnum = pgEnum('financial_account_kind', [
  'checking',
  'savings',
  'credit_card',
  'loan',
  'cash',
  'other',
])

/**
 * Chart of accounts (spec §5). Accounts are tenant-scoped and numbered; the
 * number is unique per company so imports and reports can reference it stably.
 */
export const chartAccounts = pgTable(
  'chart_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    /** Free-form refinement, e.g. "bank", "accounts_receivable", "fixed_asset". */
    subtype: text('subtype'),
    parentId: uuid('parent_id').references((): AnyPgColumn => chartAccounts.id, {
      onDelete: 'set null',
    }),
    description: text('description'),
    /**
     * System accounts are installed by the seed and required for the books to
     * balance (e.g. Uncategorized Expense). They may be renamed but not deleted.
     */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNumberUnique: unique('chart_accounts_company_number_unique').on(t.companyId, t.number),
    companyTypeIdx: index('chart_accounts_company_type_idx').on(t.companyId, t.type),
  }),
)

/**
 * A real bank or credit-card account. Distinct from its chart account: the
 * chart account is where the ledger posts, this is what the aggregator syncs.
 */
export const financialAccounts = pgTable(
  'financial_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** The GL account this account's activity posts to. */
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    bankConnectionId: uuid('bank_connection_id'),
    name: text('name').notNull(),
    /** Last four digits, for display only. Never the full account number. */
    mask: text('mask'),
    kind: financialAccountKindEnum('kind').notNull().default('checking'),
    currency: text('currency').notNull().default('USD'),
    /**
     * Balances in minor units (cents). Money is never stored as a float —
     * spec §19 financial integrity.
     */
    currentBalanceCents: bigint('current_balance_cents', { mode: 'number' })
      .notNull()
      .default(0),
    availableBalanceCents: bigint('available_balance_cents', { mode: 'number' }),
    /** Opaque identifier from the aggregation provider. */
    providerAccountId: text('provider_account_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('financial_accounts_company_idx').on(t.companyId),
    providerUnique: unique('financial_accounts_provider_unique').on(
      t.companyId,
      t.providerAccountId,
    ),
  }),
)
