import { pgTable, uuid, text, timestamp, integer, index, check, date } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'

/**
 * Every attempt to hand a client's books to professional software (Phase 158).
 *
 * Exporter spec §12 requires that an export log *"destination, user, client,
 * period, timestamp, adapter version, and result"*, and §15 that *"every export
 * generates an audit log"*.
 *
 * ## Why this is not `data_exports`
 *
 * `data_exports` is the §19 portability log: a customer taking their own data
 * home, recorded because it is the single broadest read anybody can perform.
 * This one records a firm's books being converted into a named professional
 * system's format and sent there. The questions asked of the two rows are
 * different — *who took the ledger* against *which version of which adapter
 * produced the file UltraTax rejected* — and collapsing them would mean a
 * column saying which kind a row is, with half the other columns null.
 *
 * ## A held export is a row
 *
 * The one design decision worth stating. §11 produces red, yellow or green, and
 * red means no file. That event is the most valuable thing in this table:
 * somebody tried to send these books to a tax program and could not, and
 * `exceptionReport` says why in sentences. A log that records only successes
 * cannot answer "did anybody try", which is the first question asked when a
 * filing is late.
 *
 * `accountant_exports_red_is_held` makes the two agree in the database rather
 * than in the code that writes the row: the path that skipped the validation
 * cannot record having skipped it (Phase 116 — a constraint beats a check).
 */
export const accountantExports = pgTable(
  'accountant_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),

    /**
     * A key from `EXPORT_DESTINATIONS`, as text.
     *
     * ADR 0033's rule for registry keys: the register is code, and a foreign key
     * to a table of names pointing at code is a foreign key to something that
     * may not exist.
     */
    destinationKey: text('destination_key').notNull(),

    /**
     * Which adapter wrote it (§6: each adapter independently versioned).
     *
     * A file a vendor rejects six weeks later is explicable only if the row says
     * which version produced it.
     */
    adapterVersion: text('adapter_version').notNull(),

    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),

    /** §11's green / yellow / red, and the report the accountant was shown. */
    readiness: text('readiness', { enum: ['green', 'yellow', 'red'] }).notNull(),
    exceptionCount: integer('exception_count').notNull().default(0),
    /**
     * Stored rather than recomputed, for Phase 156's reason: this describes what
     * somebody was told on a day, and the books have moved since.
     */
    exceptionReport: text('exception_report').notNull(),

    result: text('result', { enum: ['generated', 'held'] }).notNull(),
    /** Null on a held export, because nothing was written. */
    fileCount: integer('file_count'),
    byteCount: integer('byte_count'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('accountant_exports_company_idx').on(t.companyId, t.createdAt),
    period: check('accountant_exports_period', sql`${t.periodEnd} >= ${t.periodStart}`),
    filesMatchResult: check(
      'accountant_exports_files_match_result',
      sql`(${t.result} = 'generated' AND ${t.fileCount} IS NOT NULL AND ${t.fileCount} > 0 AND ${t.byteCount} IS NOT NULL)
          OR (${t.result} = 'held' AND ${t.fileCount} IS NULL AND ${t.byteCount} IS NULL)`,
    ),
    redIsHeld: check(
      'accountant_exports_red_is_held',
      sql`(${t.readiness} = 'red') = (${t.result} = 'held')`,
    ),
  }),
)
