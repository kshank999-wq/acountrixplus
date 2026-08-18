import { pgTable, uuid, text, date, bigint, timestamp, unique, index } from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'

/**
 * Exchange rates, as facts with a date and a source (spec §19).
 *
 * ## Why a table rather than a call to somebody's API
 *
 * A rate used to post a journal entry has to still be there in three years when
 * somebody asks why that entry says what it says. An application that fetched
 * a rate at the moment of posting and kept only the result can answer *what*
 * but never *from where* — and "the rate we used" is exactly the sort of thing
 * an auditor asks about, because it is the one number in a foreign transaction
 * that nobody outside the business can check.
 *
 * So rates are stored, with the day they apply to and where they came from. A
 * feed can fill this table; a person can type into it; the ledger neither knows
 * nor cares which happened, only that the row was there when it posted.
 *
 * ## A missing rate is a refusal, not a 1.0
 *
 * There is deliberately no fallback. A conversion with no rate on file stops,
 * and says which pair and which day it wanted. The alternative — quietly using
 * parity — turns a €4,000 invoice into a $4,000 one, and nothing downstream
 * ever looks wrong enough for anybody to notice.
 */

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** What is being converted from — the document's currency. */
    baseCurrency: text('base_currency').notNull(),
    /** What it is converted into — the company's functional currency. */
    quoteCurrency: text('quote_currency').notNull(),
    /** The day this rate applies to. */
    rateDate: date('rate_date').notNull(),

    /**
     * Millionths. 1.083500 is stored as 1_083_500.
     *
     * An integer for the reason every amount in this codebase is one: a rate is
     * a multiplier on money, and floating point has no business anywhere near
     * money (ADR 0002). Six decimal places is what published feeds carry.
     */
    rateMillionths: bigint('rate_millionths', { mode: 'number' }).notNull(),

    /**
     * Where it came from. "ECB", "typed by Priya", "opening balance import".
     *
     * Free text on purpose: the useful answer varies, and an enum would force
     * every real provenance into one of four boxes chosen before any of them
     * existed.
     */
    source: text('source').notNull().default('entered'),

    enteredByUserId: uuid('entered_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One rate per pair per day. A second one for the same day is a correction,
    // and a correction should replace rather than sit alongside — two rows and
    // no rule for choosing between them is how two entries on one day get
    // posted at different rates.
    unique('exchange_rates_company_pair_date_key').on(
      table.companyId,
      table.baseCurrency,
      table.quoteCurrency,
      table.rateDate,
    ),
    // The index the "rate on or before this date" lookup walks backwards on.
    index('exchange_rates_lookup_idx').on(
      table.companyId,
      table.baseCurrency,
      table.quoteCurrency,
      table.rateDate,
    ),
  ],
)
