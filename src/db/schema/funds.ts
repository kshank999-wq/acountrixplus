import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  bigint,
  boolean,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { customers } from './receivables'
import { journalEntries } from './ledger'
import { dimensionValues } from './dimensions'

/**
 * Fund accounting for nonprofits (spec §5, "Nonprofit — funds/restrictions,
 * grants, donors, program reporting").
 *
 * The `funds` module has been declared since Phase 0, switched on by the
 * nonprofit pack, and has done nothing. So have the nine accounts that pack
 * installs — `3300 Net Assets Without Donor Restrictions`, `3400 Net Assets
 * With Donor Restrictions`, `4500 Contributions and Donations`, `4510 Grant
 * Revenue` and the rest. This is where all of it starts meaning something.
 *
 * ## Nothing here forks the ledger
 *
 * ADR 0007's rule again: extend the common platform, never build a second one.
 * So a contribution is an ordinary journal entry, a pledge is an ordinary
 * receivable, and **programme reporting is Phase 16's dimensional profit and
 * loss** — a fund is a dimension value, and the report that already exists
 * answers the question. There is no per-fund profit and loss in this module,
 * and that absence is deliberate: it means a bill coded to the roof appeal by a
 * bookkeeper who has never opened this screen still lands in the roof appeal's
 * column, and still earns its release.
 *
 * ## What a fund is not
 *
 * It is not a bank account. Restricted money usually sits in the same current
 * account as everything else, and the restriction is a promise about what the
 * charity may do with it rather than a statement about where it is. A model
 * that made a fund an account would force a transfer every time somebody paid
 * a supplier, and would report a charity as solvent that had spent its
 * endowment.
 */

/**
 * What the donor said, and therefore what the charity may do.
 *
 * `perpetual` is an endowment: the principal is never spendable and therefore
 * never releasable, only its income is — and that income belongs to a different
 * fund. See `isReleasable` in `modules/funds/restriction.ts`.
 */
export const fundRestrictionEnum = pgEnum('fund_restriction', [
  'unrestricted',
  'restricted',
  'perpetual',
])

/**
 * A pot of money with a purpose attached.
 *
 * The `dimension_value_id` is the same trick the properties module uses.
 * Creating a fund creates a value in a company-wide "Fund" dimension, and every
 * posting this module makes tags its lines with it. "What has the roof appeal
 * taken in and spent" is then a question Phase 16 already answers, across
 * donations, grants, invoices and anything a bookkeeper coded to the fund by
 * hand.
 *
 * Not null, for the reason it is not null on a property: a fund whose postings
 * cannot be reported on is a fund this module has no reason to hold.
 */
export const funds = pgTable(
  'funds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Short handle used on reports and pickers: "ROOF". */
    code: text('code').notNull(),
    name: text('name').notNull(),

    restriction: fundRestrictionEnum('restriction').notNull().default('restricted'),

    /**
     * What the donor said the money is for, in their words where possible.
     *
     * Free text and deliberately not a taxonomy. The restriction that matters
     * in a dispute is the one written on the gift agreement, and a dropdown
     * that nearly matches it is worse than a sentence that quotes it.
     */
    purpose: text('purpose'),

    /**
     * When a time restriction lapses, if the gift carried one.
     *
     * Advisory: nothing in this module releases a fund because a date passed.
     * A time restriction satisfied by the calendar rather than by spending is a
     * release somebody should look at and post, not one that should appear in
     * the books overnight.
     */
    expiresOn: date('expires_on'),

    dimensionValueId: uuid('dimension_value_id')
      .notNull()
      .references(() => dimensionValues.id, { onDelete: 'restrict' }),

    /**
     * Closed, spent out, or wound up. Kept rather than deleted — last year's
     * appeal is a fact about the books, and deleting the fund would orphan
     * every donation ever received for it.
     */
    isActive: boolean('is_active').notNull().default(true),

    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('funds_company_code_unique').on(t.companyId, t.code),
    companyIdx: index('funds_company_idx').on(t.companyId, t.isActive),
  }),
)

/** Money in the hand, or a promise of it. */
export const contributionKindEnum = pgEnum('contribution_kind', [
  /** Cash, card, bank transfer — the money is here. */
  'gift',
  /**
   * An unconditional promise to give.
   *
   * Recognised as revenue when promised rather than when received, because
   * that is what it is: a receivable. A charity told in December that it will
   * receive £50,000 in March has £50,000 of revenue in December and £50,000 it
   * cannot spend yet, and a model that waited for the cheque would report the
   * year it was promised as the worse year.
   */
  'pledge',
])

/**
 * One gift, grant or promise, to one fund.
 *
 * The donor is a `customers` row rather than a party type of its own, for the
 * reason a tenant is: the nonprofit pack's terminology map already renames
 * "Customer" to "Donor" on screen, and a second party table would mean a
 * pledge could not use the receivables ledger — exactly the fork ADR 0007
 * forbids.
 */
export const contributions = pgTable(
  'contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    fundId: uuid('fund_id')
      .notNull()
      .references(() => funds.id, { onDelete: 'restrict' }),

    /** Null is an anonymous gift, which is most of a collection tin. */
    donorId: uuid('donor_id').references(() => customers.id, { onDelete: 'set null' }),

    kind: contributionKindEnum('kind').notNull().default('gift'),

    /** When it was given or promised — the date revenue is recognised. */
    receivedOn: date('received_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),

    /**
     * How much of a pledge has actually arrived.
     *
     * Only ever moves for a pledge; a gift is settled the moment it is
     * recorded. Kept here as well as in the ledger because "which promises are
     * outstanding" is the fundraiser's question and it should not require
     * reading journal lines.
     */
    receivedCents: bigint('received_cents', { mode: 'number' }).notNull().default(0),

    reference: text('reference'),
    memo: text('memo'),

    /** The entry that recognised the revenue. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fundIdx: index('contributions_fund_idx').on(t.companyId, t.fundId, t.receivedOn),
    donorIdx: index('contributions_donor_idx').on(t.companyId, t.donorId),
    amountPositive: check('contributions_amount_positive', sql`${t.amountCents} > 0`),
    receivedWithinAmount: check(
      'contributions_received_within_amount',
      sql`${t.receivedCents} >= 0 AND ${t.receivedCents} <= ${t.amountCents}`,
    ),
  }),
)

/**
 * One period's release of restriction on one fund.
 *
 * `unique(fund_id, period_start)` is the whole safety property, and it is the
 * same one Phase 23 used for rent: **two people pressing the button at the same
 * moment produce one release, because the database refuses the second.** The
 * amount is recomputed from journal lines every run rather than accumulated
 * here — a stored counter is a second answer to a question the ledger already
 * answers, and Phase 20 taught what happens when the two disagree.
 */
export const fundReleases = pgTable(
  'fund_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    fundId: uuid('fund_id')
      .notNull()
      .references(() => funds.id, { onDelete: 'cascade' }),

    /** `YYYY-MM-01`. Releases are monthly, like the rent run. */
    periodStart: date('period_start').notNull(),

    /** What was spent against the fund in the period. */
    spentCents: bigint('spent_cents', { mode: 'number' }).notNull(),
    /** What the restriction actually released — never more than was given. */
    releasedCents: bigint('released_cents', { mode: 'number' }).notNull(),
    /**
     * Spending the fund could not cover.
     *
     * Recorded rather than derived because it is a fact about a decision taken
     * on a particular day. Recomputing it later from today's balances would
     * quietly forgive an overspend that a subsequent donation happened to
     * cover, and that overspend is precisely what an auditor is asking about.
     */
    shortfallCents: bigint('shortfall_cents', { mode: 'number' }).notNull().default(0),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUnique: unique('fund_releases_fund_period_unique').on(t.fundId, t.periodStart),
    companyIdx: index('fund_releases_company_idx').on(t.companyId, t.periodStart),
    amountsNotNegative: check(
      'fund_releases_amounts_not_negative',
      sql`${t.spentCents} >= 0 AND ${t.releasedCents} >= 0 AND ${t.shortfallCents} >= 0`,
    ),
  }),
)
