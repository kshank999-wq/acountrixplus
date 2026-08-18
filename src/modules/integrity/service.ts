import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '@/db'
import { integrityFindings, integrityRuns } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { enabledModules } from '@/modules/industry/modules'
import { INTEGRITY_CHECKS, checkByKey, type CheckSeverity } from './register'

/**
 * Running every check the books have, and writing down what they said (spec §19).
 *
 * ## The three outcomes, told apart
 *
 * A check comes back one of three ways, and collapsing any two of them is how
 * a monitoring system stops being one:
 *
 * - **Ran, and agrees.** Nothing to do.
 * - **Ran, and disagrees.** For a `fault`, somebody has to look.
 * - **Did not run.** Either *skipped*, because the module is switched off —
 *   a salon is not asked whether its work in process agrees — or *errored*,
 *   because the check itself threw.
 *
 * The last distinction is the one worth defending. A check that throws and is
 * swallowed looks exactly like a check that passed, and the failure mode of
 * that is a company told its books are fine for six months by a query that has
 * been raising a type error since the day somebody renamed a column. So an
 * error is recorded as its own finding, with `agrees: false` and the message
 * kept, and the run carries a count of them. **"These disagree" and "nobody
 * knows whether these agree" are different problems and are shown as such.**
 *
 * And a skip is not a pass. It is counted separately and never contributes to
 * the "all clear", because a module switched off by accident should not read
 * as a module in good order.
 *
 * ## One check failing does not stop the others
 *
 * Each runs in its own `try`. The alternative — one loop that throws — means
 * the first broken check hides every check after it, which is the worst
 * possible ordering dependency to have in the thing that tells you what is
 * wrong.
 */

export type Finding = {
  key: string
  label: string
  severity: CheckSeverity
  agrees: boolean
  leftCents: number
  rightCents: number
  differenceCents: number
  detail: string | null
  /** Set when the check threw. `agrees` is false and means nothing here. */
  error: string | null
}

export type IntegrityRun = {
  id: string
  asOf: string
  startedAt: Date
  finishedAt: Date | null
  checksRun: number
  checksSkipped: number
  /** Checks that disagree and are meant not to. The number that matters. */
  faults: number
  errors: number
  findings: Finding[]
  /** The keys of every check skipped, so the page can say which. */
  skipped: string[]
}

/**
 * Runs the register against one company and records the result.
 *
 * `asOf` defaults to today. It is passed to every check that takes one so the
 * whole run describes a single moment — a run where the receivables were
 * measured at 23:59 and the inventory at 00:01 would be comparing two
 * different nights and calling it one.
 */
export async function runIntegrityChecks(
  ctx: ActorContext,
  opts: { asOf?: string; persist?: boolean } = {},
): Promise<IntegrityRun> {
  requirePermission(ctx, 'reports:financial')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const persist = opts.persist ?? true
  const modules = await enabledModules(ctx.companyId)

  const startedAt = new Date()
  const findings: Finding[] = []
  const skipped: string[] = []
  let faults = 0
  let errors = 0

  for (const check of INTEGRITY_CHECKS) {
    if (check.module && !modules.has(check.module)) {
      skipped.push(check.key)
      continue
    }

    try {
      const outcome = await check.run(ctx, asOf)
      const differenceCents = outcome.leftCents - outcome.rightCents

      if (!outcome.agrees && check.severity === 'fault') faults += 1

      findings.push({
        key: check.key,
        label: check.label,
        severity: check.severity,
        agrees: outcome.agrees,
        leftCents: outcome.leftCents,
        rightCents: outcome.rightCents,
        differenceCents,
        detail: outcome.detail ?? null,
        error: null,
      })
    } catch (error) {
      errors += 1
      findings.push({
        key: check.key,
        label: check.label,
        severity: check.severity,
        // Not an assertion that they disagree — an admission that the question
        // was not answered. The `error` field is what the screen reads.
        agrees: false,
        leftCents: 0,
        rightCents: 0,
        differenceCents: 0,
        detail: null,
        error: error instanceof Error ? error.message : 'The check did not finish.',
      })
    }
  }

  const finishedAt = new Date()

  // Written after the checks have run, not before. A run row that exists while
  // the checks are still going would be the newest run, and `newlyBroken`
  // would compare tonight against tonight and report nothing.
  let runId = ''

  if (persist) {
    const [row] = await db
      .insert(integrityRuns)
      .values({
        companyId: ctx.companyId,
        asOf,
        startedAt,
        finishedAt,
        checksRun: findings.length,
        checksSkipped: skipped.length,
        faults,
        errors,
      })
      .returning({ id: integrityRuns.id })

    runId = row.id

    if (findings.length > 0) {
      await db.insert(integrityFindings).values(
        findings.map((finding) => ({
          companyId: ctx.companyId,
          runId,
          checkKey: finding.key,
          severity: finding.severity,
          agrees: finding.agrees,
          leftCents: finding.leftCents,
          rightCents: finding.rightCents,
          differenceCents: finding.differenceCents,
          detail: finding.detail,
          error: finding.error,
        })),
      )
    }
  }

  return {
    id: runId,
    asOf,
    startedAt,
    finishedAt,
    checksRun: findings.length,
    checksSkipped: skipped.length,
    faults,
    errors,
    findings,
    skipped,
  }
}

/**
 * The most recent run, with what it found.
 *
 * Null when nothing has ever run — which the operations page says in as many
 * words, because "no findings" and "never checked" look identical otherwise
 * and only one of them is good news.
 */
export async function latestRun(ctx: ActorContext): Promise<IntegrityRun | null> {
  requirePermission(ctx, 'reports:financial')

  const [run] = await db
    .select()
    .from(integrityRuns)
    .where(scoped(ctx, integrityRuns))
    .orderBy(desc(integrityRuns.startedAt))
    .limit(1)

  if (!run) return null

  const rows = await db
    .select()
    .from(integrityFindings)
    .where(scoped(ctx, integrityFindings, eq(integrityFindings.runId, run.id)))
    .orderBy(integrityFindings.createdAt)

  const found = new Set(rows.map((row) => row.checkKey))

  return {
    id: run.id,
    asOf: run.asOf,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    checksRun: run.checksRun,
    checksSkipped: run.checksSkipped,
    faults: run.faults,
    errors: run.errors,
    findings: rows.map(toFinding),
    skipped: INTEGRITY_CHECKS.filter((check) => !found.has(check.key)).map((check) => check.key),
  }
}

/**
 * One check's story, newest first.
 *
 * This is what answers *when did this start*, which is the first question
 * after being told two things disagree — and the reason the findings are
 * written down at all rather than recomputed on demand.
 */
export async function checkHistory(
  ctx: ActorContext,
  checkKey: string,
  limit = 60,
): Promise<Array<Finding & { asOf: string; at: Date }>> {
  requirePermission(ctx, 'reports:financial')

  const rows = await db
    .select({
      finding: integrityFindings,
      asOf: integrityRuns.asOf,
    })
    .from(integrityFindings)
    .innerJoin(integrityRuns, eq(integrityRuns.id, integrityFindings.runId))
    .where(scoped(ctx, integrityFindings, eq(integrityFindings.checkKey, checkKey)))
    .orderBy(desc(integrityFindings.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    ...toFinding(row.finding),
    asOf: row.asOf,
    at: row.finding.createdAt,
  }))
}

/**
 * The checks that broke *since last time*.
 *
 * The digest rule from Phase 24, applied to the books: something that has been
 * wrong for a week must not send seven notifications, or the eighth is not
 * read. A drift is news on the night it appears; after that it is a number on
 * a page somebody has already been told about.
 *
 * A check that was erroring and now disagrees counts as new, because it is a
 * different thing to know.
 */
export async function newlyBroken(
  ctx: ActorContext,
  run: IntegrityRun,
): Promise<Finding[]> {
  const broken = run.findings.filter(isBroken)
  if (broken.length === 0) return []

  // The newest run that is not this one, named rather than skipped by offset:
  // a dry run was never written down, so `offset(1)` would step over the very
  // run it should be comparing against.
  const [previous] = await db
    .select({ id: integrityRuns.id })
    .from(integrityRuns)
    .where(scoped(ctx, integrityRuns, run.id ? ne(integrityRuns.id, run.id) : undefined))
    .orderBy(desc(integrityRuns.startedAt))
    .limit(1)

  // Nothing to compare against, so everything broken tonight is news. That is
  // the right answer for a first run: a company whose books have never been
  // checked should be told what is wrong with them.
  if (!previous) return broken

  const before = await db
    .select()
    .from(integrityFindings)
    .where(
      scoped(
        ctx,
        integrityFindings,
        and(
          eq(integrityFindings.runId, previous.id),
          inArray(
            integrityFindings.checkKey,
            broken.map((finding) => finding.key),
          ),
        ),
      ),
    )

  const wasBroken = new Map(
    before.map((row) => [row.checkKey, isBroken(toFinding(row)) ? row : null]),
  )

  return broken.filter((finding) => {
    const previousRow = wasBroken.get(finding.key)
    // Not present last night, or present and healthy: this is new.
    if (!previousRow) return true
    // Was erroring and now disagrees, or the reverse. Different news.
    return Boolean(previousRow.error) !== Boolean(finding.error)
  })
}

/** A finding worth telling somebody about: a real fault, or a check that threw. */
export function isBroken(finding: Finding): boolean {
  if (finding.error) return true
  return finding.severity === 'fault' && !finding.agrees
}

/** The register entry a stored finding names, if it still exists. */
export function labelFor(key: string): string {
  return checkByKey(key)?.label ?? key
}

type FindingRow = typeof integrityFindings.$inferSelect

function toFinding(row: FindingRow): Finding {
  return {
    key: row.checkKey,
    label: labelFor(row.checkKey),
    severity: row.severity as CheckSeverity,
    agrees: row.agrees,
    leftCents: row.leftCents,
    rightCents: row.rightCents,
    differenceCents: row.differenceCents,
    detail: row.detail,
    error: row.error,
  }
}

export { INTEGRITY_CHECKS, checkByKey } from './register'
export type { CheckSeverity, IntegrityCheck } from './register'
