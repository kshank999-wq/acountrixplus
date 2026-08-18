import {
  pgTable,
  uuid,
  text,
  boolean,
  bigint,
  timestamp,
  index,
  unique,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'
import { journalEntries } from './ledger'

/**
 * Cash drawers and the shifts worked on them (spec §5, §13).
 *
 * Phase 32 made the software able to take money at a counter and put it in
 * Undeposited Funds. That is right for a card batch and only half right for a
 * note: a note is in a *drawer*, and a drawer belongs to whoever is standing at
 * it. Until somebody counts it and says so, nobody knows whether what the till
 * says was taken is what is actually there.
 *
 * ## Why a shift rather than a day
 *
 * Phase 28's `pos_import` already handles a day: a till system somewhere else
 * reports one, and the summary is imported. This is the other case — the
 * software *is* the till — and there the unit is a shift, because two people
 * working a morning and an afternoon on the same drawer are two counts and two
 * accountabilities. A day would average them, which is exactly what somebody
 * investigating a short till does not want.
 */

export const shiftStatusEnum = pgEnum('drawer_shift_status', ['open', 'closed'])

export const cashDrawers = pgTable(
  'cash_drawers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** "Front counter", "Bar", "Van 2". What somebody would call it out loud. */
    name: text('name').notNull(),
    /** What it normally opens with, offered as the default float. */
    defaultFloatCents: bigint('default_float_cents', { mode: 'number' }).notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('cash_drawers_company_name_key').on(table.companyId, table.name)],
)

export const drawerShifts = pgTable(
  'drawer_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    drawerId: uuid('drawer_id')
      .notNull()
      .references(() => cashDrawers.id, { onDelete: 'cascade' }),
    status: shiftStatusEnum('status').notNull().default('open'),

    /**
     * Who is accountable, by name at the time.
     *
     * A user reference rather than free text, because "who was on the till"
     * is the first question after a short drawer and an answer that can be
     * typed is an answer that can be typed wrongly.
     */
    openedByUserId: uuid('opened_by_user_id')
      .notNull()
      .references(() => users.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    floatCents: bigint('float_cents', { mode: 'number' }).notNull().default(0),

    closedByUserId: uuid('closed_by_user_id').references(() => users.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * What somebody said was in the drawer. Null while the shift is open.
     *
     * Never derived and never adjusted. The whole value of a Z-reading is that
     * it is a declaration by a person at a moment, and a system that lets it
     * be edited afterwards has a number that proves nothing.
     */
    countedCents: bigint('counted_cents', { mode: 'number' }),
    /** What the till says was taken in cash, kept as a snapshot at close. */
    expectedCents: bigint('expected_cents', { mode: 'number' }),
    overShortCents: bigint('over_short_cents', { mode: 'number' }),
    /** Float left in for the next shift. The rest is banked. */
    floatRetainedCents: bigint('float_retained_cents', { mode: 'number' }),

    /** The entry that put the float in. */
    openingEntryId: uuid('opening_entry_id').references(() => journalEntries.id),
    /** The entry that banked the takings and posted the difference. */
    closingEntryId: uuid('closing_entry_id').references(() => journalEntries.id),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('drawer_shifts_company_opened_idx').on(table.companyId, table.openedAt),
    index('drawer_shifts_drawer_idx').on(table.drawerId, table.status),
  ],
)

/**
 * Money that left an open drawer for something other than banking.
 *
 * A window cleaner paid out of the till is a real expense and a real reason the
 * drawer is light, and a shop that cannot record one will have a short drawer
 * every week it happens. Kept as its own rows rather than a single number so
 * the reason survives — "$40 paid out" is not an answer anybody can act on.
 */
export const drawerPayouts = pgTable(
  'drawer_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => drawerShifts.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Where the cost lands. Chosen when it is recorded, not guessed later. */
    chartAccountId: uuid('chart_account_id').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    recordedByUserId: uuid('recorded_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('drawer_payouts_shift_idx').on(table.shiftId)],
)
