import { pgTable, uuid, text, boolean, bigint, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { companies } from './tenancy'

/**
 * What the nightly check found (spec §19).
 *
 * ## Why this is stored rather than recomputed
 *
 * Every reconciliation in this codebase answers "do these agree *now*". None
 * of them can answer the first question anybody asks after being told they do
 * not: **when did this start?**
 *
 * That question is what decides whether somebody is looking for a bad deploy
 * on Tuesday or a data import last March, and it cannot be recomputed. The
 * balances are as at a date; the *documents* are as they stand today. Phase 31
 * named that limitation and it has not gone away — reconstructing what the
 * subledger said on an arbitrary past date would mean replaying every payment
 * application. Writing down what the check said each night is cheap and
 * answers the question exactly.
 *
 * ## Two tables, and the second one is why
 *
 * A run happens whether or not anything is wrong. Without the run row, a
 * company with no findings is indistinguishable from a company where the
 * scheduled job stopped firing three weeks ago — and that is the failure this
 * whole phase exists to prevent, reproduced one level up.
 */

export const integrityRuns = pgTable(
  'integrity_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** The date the checks were run *as at*, not when the job fired. */
    asOf: text('as_of').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** How many of the register's checks actually ran. */
    checksRun: integer('checks_run').notNull().default(0),
    /** Skipped because the module is switched off. Not the same as passing. */
    checksSkipped: integer('checks_skipped').notNull().default(0),
    /** Checks whose two sides disagree and are meant not to. */
    faults: integer('faults').notNull().default(0),
    /** Checks that threw. A broken check must not look like a clean one. */
    errors: integer('errors').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('integrity_runs_company_started_idx').on(table.companyId, table.startedAt)],
)

export const integrityFindings = pgTable(
  'integrity_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => integrityRuns.id, { onDelete: 'cascade' }),
    /**
     * The register key, not a foreign key.
     *
     * The register is code, and deliberately: a check is a function, and a
     * table of them would be a table of names pointing at functions that may
     * not exist. Storing the key means a finding survives a check being
     * retired — it reads as an unknown key rather than disappearing, which is
     * the honest outcome for a historical record.
     */
    checkKey: text('check_key').notNull(),
    /** 'fault' or 'position', copied from the register at run time. */
    severity: text('severity').notNull(),
    agrees: boolean('agrees').notNull(),
    /** The subledger, register or document side. */
    leftCents: bigint('left_cents', { mode: 'number' }).notNull().default(0),
    /** What the ledger said. */
    rightCents: bigint('right_cents', { mode: 'number' }).notNull().default(0),
    differenceCents: bigint('difference_cents', { mode: 'number' }).notNull().default(0),
    /** Names, counts, offending documents — whatever a total cannot say. */
    detail: text('detail'),
    /**
     * Set when the check itself threw.
     *
     * `agrees` is false alongside it, because a check that could not run has
     * not proved anything. The two are told apart on screen: "these disagree"
     * and "nobody knows whether these agree" are different problems.
     */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('integrity_findings_run_idx').on(table.runId),
    // The index the history query uses: one check's story, newest first.
    index('integrity_findings_company_key_idx').on(
      table.companyId,
      table.checkKey,
      table.createdAt,
    ),
  ],
)
