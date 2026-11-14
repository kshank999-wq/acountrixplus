import { eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { projects } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import { RegistryError } from '@/modules/errors/registry'

/**
 * What state a job is in, and what each state means to the things that read it
 * (Phase 212).
 *
 * ## The nomination, and the sentence in it that was false
 *
 * ADR 0211 nominated *the job that cannot be finished*: `projects.end_date` has
 * no writer, so a job can be created, billed, have its retainage held and its
 * costs coded, and there is no way to say it is over. True. The nomination then
 * said the column *"is read — the register's entry for it names what reads
 * it — so this is not Phase 49's shape and a migration is not the answer"*.
 *
 * The register's entry says `jobs/reports.ts` *"reads the end date into every
 * date range it builds"*. It does not. `jobs/reports.ts` has one `endDate`, and
 * it is a **parameter**:
 *
 * ```ts
 * range: { startDate: string; endDate: string },
 * ```
 *
 * — a caller-supplied window for a ledger query, with no relation to the
 * column. Measured, nothing in `src/` names `projects.endDate` at all. Four
 * projectionless `select()`s fetch it (`jobs/billing.ts`, `jobs/budgets.ts`,
 * `timebilling/billing.ts` and the job page) and no JavaScript looks at the
 * property.
 *
 * That is worth stating precisely, because it is Phase 210's own correction
 * turning round and biting. Phase 210 taught the scan that a projectionless
 * `select()` **is** a read — rightly: the SQL fetches the column. The very next
 * register entry written after that correction then used *"it is read"* as the
 * argument for keeping a column, about a column no reader consults. The
 * correction was right and it created a new way to be wrong, which is the
 * mechanism this file exists to stop being repeated: a column is worth writing
 * because **something is waiting for the answer**, not because a query happens
 * to carry it back.
 *
 * ## What was waiting for the answer
 *
 * Not `end_date`. `status`.
 *
 * `projects.status` is `text(..., { enum: ['active', 'on_hold', 'complete',
 * 'cancelled'] }).notNull().default('active')`, and the only statement that has
 * ever written it is the conversion that creates the job:
 *
 * ```ts
 * status: 'active',
 * ```
 *
 * — the literal that is also its default. So the column has four values and
 * **one of them has ever been reachable**. It is not a candidate in
 * `writerCandidates` because an insert that names a column counts as a writer,
 * and before this phase it was one of 1,169 insert-only columns, the
 * overwhelming majority of which are immutable on purpose.
 *
 * `insertOnlyColumns`' docstring has said since Phase 202 that narrowing that
 * number *"needs a way to say which columns are **state** rather than
 * **record**, and this phase does not have one"*. Here is one, and it is
 * measurable rather than editorial:
 *
 * > A column is **state** when its declared domain holds more than one value.
 * > It is **painted on** when it is insert-only, every write of it is the same
 * > literal, and that literal is its schema default — so no statement anywhere
 * > can make the column differ from what the database would have put there.
 *
 * Measured over the whole schema on the day this phase opened: **1,169
 * insert-only columns, 28 with a domain of more than one value, 4 written only
 * ever as literals, and 1 whose literal is also its default.** The three that survive each survive for a different
 * reason, which is what makes the one finding a finding rather than a quota:
 *
 * | column | domain | written | why it is fine |
 * | --- | --- | --- | --- |
 * | `progress_billings.isRetainageRelease` | 2 | `true` | defaults to `false`, so both values occur — the write *is* the distinction |
 * | `accountant_exports.result` | 2 | `'generated'`, `'held'` | no default; both literals are written |
 * | `refunds.direction` | 2 | `'out'`, `'in'` | no default; both literals are written |
 * | `projects.status` | **4** | `'active'` | its one literal is its default |
 *
 * `paintedStates()` in `source/column-writers.ts` is that measurement, so the
 * number is in a place something reads (Phase 179) and the next one is found by
 * the suite rather than by a nomination.
 *
 * ## The three readers, measured before anything was built
 *
 * ADR 0211 said the thing to measure was *"what else is a finished job supposed
 * to mean?"*, and named three candidates. Each turned out to be a different
 * kind of answer:
 *
 * 1. **Off the WIP schedule.** The reader **exists and is correct**:
 *    `workInProgress` filters to `status === 'active' || status === 'on_hold'`
 *    unless asked for everything. It has never been able to fire.
 * 2. **Out of the timesheet picker.** The reader **does not exist**.
 *    `listProjects` selects `status` and `/time/page.tsx` then does
 *    `projectList.map((project) => ({ id: project.id, name: project.name }))`,
 *    dropping it on the way to the dropdown.
 * 3. **Refused new costs.** The reader **does not exist**.
 *    `assertDimensionsInCompany` in `ledger/journal.ts` — the single chokepoint
 *    every posting passes through — selects `projects.id` and checks only that
 *    the job belongs to the company.
 *
 * ## What the first of those three turns out to be about
 *
 * The WIP filter is not a cosmetic one. `wipSummary` feeds
 * `jobs.propose_wip_entry`, which drafts the period-end adjusting entry against
 * `1160 Costs in Excess of Billings`, `2560 Billings in Excess of Costs` and
 * `4200`. A job's over- or under-billing is **in that draft**.
 *
 * So "complete means off the schedule", taken literally, has a defect in it: an
 * accountant posts the adjustment in June, the job is marked complete in July
 * while still $12,000 underbilled, the job leaves the schedule, and nothing
 * ever proposes the reversal. `1160` carries the twelve thousand for good.
 *
 * The fix is not a refusal on the act. It is that **completion does not take a
 * job off the schedule; being settled does** — which is what a real WIP
 * schedule does anyway, carrying closed-but-unbilled jobs until they clear. So
 * `reportsWip` below means *on the schedule whether or not there is anything to
 * report*, and a job in a state that is off the schedule stays on it while its
 * over/under-billing is non-zero. A closed job that is square drops off, which
 * is what closing it was for.
 *
 * Nothing about that changes any figure today, because today every job is
 * `active` and `reportsWip` is true for it. It changes what happens on the
 * first day a job can be closed, which is this phase.
 *
 * ## One act, three columns
 *
 * `recordEmployment` (Phase 210) is the model and said why: *"a date and a flag
 * that each have their own control are two answers to `has this person left`"*.
 * Here there are three columns — `status`, `end_date` and `notes` — and so one
 * act, with the date derived from the state rather than typed beside it: a
 * terminal state carries an end date and a live state has none. Reopening a job
 * clears the date, because a job with an end date that is running again is the
 * contradiction this would otherwise store.
 */

export type JobStatus = 'active' | 'on_hold' | 'complete' | 'cancelled'

export type JobState = {
  status: JobStatus
  /** What a screen calls it. Lower case: it is rendered inside a sentence. */
  label: string
  /** Carries an end date. A live state has none, and reopening clears it. */
  terminal: boolean
  /** Offered in the picker on a new timesheet. */
  bookable: boolean
  /**
   * On the WIP schedule regardless of whether there is anything to report. A
   * state with `false` here still appears while its over/under-billing is
   * non-zero — see the docstring above for why that is the whole point.
   */
  reportsWip: boolean
  /** A posting may name this job as its dimension. */
  acceptsCosts: boolean
  /** The states this one may be reached from. Empty means it is where jobs start. */
  from: readonly JobStatus[]
  /** The argument for this entry, in the register's own words. */
  because: string
}

/**
 * The four states, each arguing for itself (Phase 101's device).
 *
 * No two entries agree on all four of `terminal`, `bookable`, `reportsWip` and
 * `acceptsCosts`, and the test asserts that: two states a reader cannot tell
 * apart are one state with two names, and the second one is spare. The pairs
 * are close on purpose — `active` and `on_hold` differ only in whether you may
 * book time, `complete` and `cancelled` only in whether a cost may still
 * arrive — and those two distinctions are the entire reason the enum has four
 * members rather than two.
 */
export const JOB_STATES: readonly JobState[] = [
  {
    status: 'active',
    label: 'active',
    terminal: false,
    bookable: true,
    reportsWip: true,
    acceptsCosts: true,
    from: ['on_hold', 'complete', 'cancelled'],
    because:
      'Where every job starts, and where a reopened one returns to. It is reachable from all ' +
      'three others because reopening is the only way back from a terminal state: a job that ' +
      'was closed too early is put back to work and then closed again, rather than being ' +
      'corrected in place, so the audit trail carries both decisions instead of one overwrite.',
  },
  {
    status: 'on_hold',
    label: 'on hold',
    terminal: false,
    bookable: false,
    reportsWip: true,
    acceptsCosts: true,
    from: ['active'],
    because:
      'Work has stopped and the job has not ended: a permit is pending, the client has gone ' +
      'quiet, the site is flooded. It differs from active in exactly one way — nobody should be ' +
      'booking time to it — and in no other, which is the argument for it existing. Costs still ' +
      'arrive, because the plant hire and the site insurance do not stop when the work does, and ' +
      'it stays on the WIP schedule because an unfinished job is precisely what that schedule is ' +
      'about.',
  },
  {
    status: 'complete',
    label: 'complete',
    terminal: true,
    bookable: false,
    reportsWip: false,
    acceptsCosts: true,
    from: ['active', 'on_hold'],
    because:
      'The work is done. Costs are still accepted, because a subcontractor invoices in arrears ' +
      'and a supplier bill for the last delivery arrives after the last day on site — refusing ' +
      'it would push a real cost onto a job that did not incur it, which is worse than a job ' +
      'reappearing on the WIP schedule. And reappear it does: a late cost makes the job ' +
      'under-billed again, which brings it back until somebody bills or writes it off.',
  },
  {
    status: 'cancelled',
    label: 'cancelled',
    terminal: true,
    bookable: false,
    reportsWip: false,
    acceptsCosts: false,
    from: ['active', 'on_hold'],
    because:
      'The job was called off and there is nothing left to do on it. This is the one state that ' +
      'refuses a posting, and it is the only real difference between it and complete: a cost ' +
      'coded to a cancelled job is almost always a mis-keyed dimension, because the work it pays ' +
      'for was never done. Not reachable from complete — a job that finished was not called ' +
      'off — so correcting that mistake means reopening it first, which is a decision somebody ' +
      'makes rather than a status they overwrite.',
  },
]

/** The entry for a status, or a refusal naming it. */
export function jobState(status: string): JobState {
  const found = JOB_STATES.find((state) => state.status === status)
  if (found) return found

  throw new RegistryError({
    registry: 'JOB_STATES',
    key: status,
    message:
      'Add an entry saying whether a job in this state carries an end date, may be booked to, ' +
      'appears on the WIP schedule and accepts a posting. Every one of those four is read by ' +
      'something, so a state nobody has placed would be read as whatever the defaults happen ' +
      'to be.',
  })
}

/** The statuses a timesheet may offer. */
export function bookableStatuses(): JobStatus[] {
  return JOB_STATES.filter((state) => state.bookable).map((state) => state.status)
}

/**
 * Why this transition is refused, or `null` when it is allowed.
 *
 * A sentence rather than a boolean, on Phase 47's rule that a refusal must name
 * something actionable — here, the state you would have to go through first.
 */
export function transitionRefusal(from: string, to: string): string | null {
  const target = jobState(to)
  const current = jobState(from)

  if (from === to) {
    return `This job is already ${target.label}.`
  }

  if (target.from.includes(current.status)) return null

  const through = JOB_STATES.filter(
    (state) => target.from.includes(state.status) && state.from.includes(current.status),
  )

  return (
    `A ${current.label} job cannot be marked ${target.label}.` +
    (through.length > 0
      ? ` Put it back to ${through.map((state) => state.label).join(' or ')} first.`
      : '')
  )
}

export type JobStatusInput = {
  projectId: string
  status: JobStatus
  /**
   * The day a terminal state took effect. Defaults to today, refused in the
   * future, and ignored for a live state, which has no end date by definition.
   */
  effectiveDate?: string
  /**
   * What to leave on the job. Written to `projects.notes`, replacing whatever
   * was there — the previous text is in the audit event, which is where the
   * history of a field belongs rather than in the field itself.
   */
  note?: string | null
}

/**
 * Moves a job from one state to another, with the end date that implies.
 *
 * `jobs:manage` and no module gate. A job is created by CRM conversion whether
 * or not job costing is switched on, so a company using the CRM alone can
 * create jobs it could not then close, and a module gate here would have
 * reproduced the defect this phase is about one level up.
 */
export async function setJobStatus(ctx: ActorContext, input: JobStatusInput) {
  requirePermission(ctx, 'jobs:manage')

  const target = jobState(input.status)
  const today = new Date().toISOString().slice(0, 10)
  const effectiveDate = input.effectiveDate ?? today

  if (target.terminal && effectiveDate > today) {
    throw new Refusal(
      `A job is closed once it has finished. ${effectiveDate} is in the future — come back on ` +
        `the day, or record it as ${today} if the work is already done.`,
    )
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(projects)
      .where(scoped(ctx, projects, eq(projects.id, input.projectId)))
      .limit(1)

    if (!before) throw missing('job')

    const refusal = transitionRefusal(before.status, target.status)
    if (refusal) throw new Refusal(refusal)

    if (target.terminal && before.startDate && effectiveDate < before.startDate) {
      throw new Refusal(
        `${before.code} started on ${before.startDate}, so it cannot have ${target.label === 'cancelled' ? 'been cancelled' : 'finished'} on ${effectiveDate}.`,
      )
    }

    const [job] = await tx
      .update(projects)
      .set({
        status: target.status,
        // Derived, never typed beside the status: a live job has no end date
        // and a terminal one has exactly the day it reached that state.
        endDate: target.terminal ? effectiveDate : null,
        ...(input.note === undefined ? {} : { notes: input.note }),
      })
      .where(scoped(ctx, projects, eq(projects.id, input.projectId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'job.status',
        entityType: 'job',
        entityId: job.id,
        before: { status: before.status, endDate: before.endDate, notes: before.notes },
        after: { status: job.status, endDate: job.endDate, notes: job.notes },
      },
      tx,
    )

    return job
  })
}

/**
 * Refuses a posting that names a job in a state that does not accept one.
 *
 * Called from `assertDimensionsInCompany`, which is the single place every
 * posting's dimensions are checked, so there is one answer to *may this cost be
 * coded here* rather than one per caller.
 *
 * The refusal names the date, because the useful version of this message is not
 * "that job is cancelled" but "that job was cancelled on the 14th of March" —
 * the reader then knows whether they have the wrong job or the wrong month.
 */
export async function assertJobsAcceptCosts(
  ctx: ActorContext,
  projectIds: readonly string[],
  exec: Executor,
) {
  const refusing = JOB_STATES.filter((state) => !state.acceptsCosts).map((state) => state.status)
  if (projectIds.length === 0 || refusing.length === 0) return

  const rows = await exec
    .select({
      code: projects.code,
      status: projects.status,
      endDate: projects.endDate,
    })
    .from(projects)
    .where(scoped(ctx, projects, inArray(projects.id, [...projectIds])))

  for (const row of rows) {
    if (!refusing.includes(row.status as JobStatus)) continue

    const state = jobState(row.status)

    throw new Refusal(
      `${row.code} was ${state.label}${row.endDate ? ` on ${row.endDate}` : ''}, so a cost ` +
        `cannot be coded to it. Reopen the job if the work went ahead after all, or code this ` +
        `to the job it belongs to.`,
    )
  }
}
