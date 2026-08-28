import { upsertSchedule } from './schedules'

/**
 * The schedules a company gets.
 *
 * Installed on demand rather than at registration, because a company that
 * signed up before this phase existed should get them too, and a backfill
 * migration that enqueues work is a migration that can send email.
 *
 * ## Why these hours
 *
 * Spread rather than all at midnight. Every schedule firing at 00:00 UTC means
 * every company's nightly work lands in the same minute, and the first thing
 * that breaks under that is the thing least able to complain — a mail provider
 * rate limit, silently.
 */
export type ScheduleDefault = {
  kind: string
  cadence: 'hourly' | 'daily' | 'weekly' | 'monthly'
  hourUtc?: number
  dayOfMonth?: number
  /** Shown on the operations page. */
  why: string
}

export const COMPANY_SCHEDULES: ScheduleDefault[] = [
  {
    kind: 'campaign.send_due',
    cadence: 'hourly',
    why: 'Hourly, because a campaign scheduled for 2pm going out at midnight is not scheduling.',
  },
  {
    kind: 'bank.sync_all',
    cadence: 'daily',
    hourUtc: 5,
    why: 'Before the working day, so the inbox is current when somebody opens it.',
  },
  {
    kind: 'mobile.nudge_review',
    cadence: 'daily',
    hourUtc: 8,
    why: 'Morning, once. A nudge that arrives at 3am is a notification switched off.',
  },
  {
    kind: 'payroll.remittance_due',
    cadence: 'monthly',
    hourUtc: 9,
    dayOfMonth: 5,
    why: 'Early in the month, while there is still time to pay it.',
  },
  {
    kind: 'accounting.run_recurring',
    cadence: 'daily',
    hourUtc: 1,
    why: 'Daily, so a template dated the 1st posts on the 1st rather than whenever somebody looks.',
  },
  {
    kind: 'jobs.propose_wip_entry',
    cadence: 'monthly',
    hourUtc: 2,
    dayOfMonth: 1,
    why: 'After a month closes. Proposes a draft; posting stays a decision.',
  },
  // --- Phase 24 -------------------------------------------------------------
  {
    kind: 'engagement.chase_overdue',
    cadence: 'daily',
    hourUtc: 8,
    why: 'Morning, once, with a count. A promise made on a call is chased without anybody opening a page.',
  },
  {
    kind: 'properties.run_rent',
    cadence: 'monthly',
    hourUtc: 6,
    dayOfMonth: 1,
    why: 'The 1st, before the working day. Skips companies that let no property; billing twice bills once.',
  },
  {
    kind: 'ops.failure_digest',
    cadence: 'daily',
    hourUtc: 7,
    why: 'Once a day, and silent when there is nothing wrong — which is what makes it worth reading.',
  },
  // --- Phase 37 -------------------------------------------------------------
  {
    kind: 'billing.run_schedules',
    cadence: 'daily',
    hourUtc: 5,
    why:
      'Daily rather than monthly, because a weekly arrangement and one on the 15th are both ' +
      'real and a monthly job would bill one four times at once and the other late. Before the ' +
      'working day, so a retainer client is billed on the 1st whether or not anybody thought ' +
      'about it. Firing twice bills once — the occurrence row decides.',
  },
  // --- Phase 33 -------------------------------------------------------------
  {
    kind: 'books.integrity_check',
    cadence: 'daily',
    hourUtc: 2,
    why:
      'Every reconciliation the books have, run by the machine rather than only when somebody ' +
      'opens a page. At 2am, after the recurring entries have posted, so the day it checks is ' +
      'complete. Tells somebody only about what broke since last night.',
  },
  // --- Phase 43 -------------------------------------------------------------
  {
    kind: 'receivables.chase_overdue',
    cadence: 'daily',
    hourUtc: 9,
    why:
      'Mid-morning, once. A chase that lands at 3am reads as automated and one that lands ' +
      'twice reads as harassment. Daily rather than weekly because the cadence is the ' +
      "company's to set and a weekly job could only honour multiples of seven. Does nothing " +
      'at all unless somebody has switched chasing on — it emails their customers, not them.',
  },
]

/** Housekeeping that spans every tenant. */
export const GLOBAL_SCHEDULES: ScheduleDefault[] = [
  {
    kind: 'housekeeping.prune_idempotency_keys',
    cadence: 'daily',
    hourUtc: 3,
    why: 'Keys expire after 14 days; this is what actually deletes them.',
  },
  {
    kind: 'housekeeping.prune_jobs',
    cadence: 'daily',
    hourUtc: 4,
    why: 'Succeeded and cancelled jobs older than a fortnight. Dead ones are never swept.',
  },
  {
    kind: 'housekeeping.retention',
    cadence: 'daily',
    hourUtc: 3,
    why: 'Everything the retention policy no longer keeps. Nine tables, one ranged delete each.',
  },
]

/** Installs the standard schedules for one company. Safe to call repeatedly. */
export async function installCompanySchedules(companyId: string): Promise<number> {
  for (const schedule of COMPANY_SCHEDULES) {
    await upsertSchedule({ ...schedule, companyId })
  }
  return COMPANY_SCHEDULES.length
}

/**
 * Installs the global housekeeping schedules.
 *
 * `companyId: null`, and the unique index is on (company, kind) — Postgres
 * treats nulls as distinct in a unique constraint, so calling this twice would
 * create two rows rather than upserting. Guarded by reading first, which is
 * safe here because it runs at deploy time rather than in a hot path.
 */
export async function installGlobalSchedules(): Promise<number> {
  const { listSchedules } = await import('./schedules')
  const existing = new Set((await listSchedules()).map((row) => row.kind))

  let installed = 0

  for (const schedule of GLOBAL_SCHEDULES) {
    if (existing.has(schedule.kind)) continue
    await upsertSchedule({ ...schedule, companyId: null })
    installed++
  }

  return installed
}

/**
 * Gives every company the schedules it is missing (Phase 33).
 *
 * ## The defect this closes
 *
 * The comment at the top of this file has said since Phase 10 that schedules
 * are *"installed on demand rather than at registration, because a company
 * that signed up before this phase existed should get them too"*. Nothing
 * demanded them. `installCompanySchedules` was called from `src/db/seed.ts`
 * and from nowhere else, and `registerCompany` never touched schedules at all.
 *
 * The consequence: **no company created through the sign-up form ever had a
 * single schedule**, so no bank sync, no campaign send, no rent run, no
 * remittance reminder, no failure digest and no nightly books check has ever
 * fired for one. Every scheduled feature since Phase 10 worked in the demo and
 * in tests, and silently did nothing in production — the exact shape of
 * failure Phase 33 exists to catch, in Phase 33's own supporting machinery.
 *
 * Found while checking whether "the books are checked nightly" was true.
 *
 * ## Why here rather than at registration
 *
 * Registration alone would leave every existing company without them, and a
 * backfill migration that installs schedules is a migration that starts
 * sending email. Topping up from the worker's tick fixes both at once and
 * needs no bootstrap: it is two reads, writes only what is missing, and is
 * safe to run every tick because `upsertSchedule` is keyed on (company, kind).
 */
export async function ensureSchedules(): Promise<{ installed: number }> {
  const { listSchedules } = await import('./schedules')
  const { db } = await import('@/db')
  const { companies } = await import('@/db/schema')

  const [rows, existing] = await Promise.all([
    db.select({ id: companies.id }).from(companies),
    listSchedules(),
  ])

  const have = new Set(existing.map((row) => `${row.companyId ?? ''}:${row.kind}`))
  let installed = 0

  for (const company of rows) {
    for (const schedule of COMPANY_SCHEDULES) {
      if (have.has(`${company.id}:${schedule.kind}`)) continue
      await upsertSchedule({ ...schedule, companyId: company.id })
      installed++
    }
  }

  for (const schedule of GLOBAL_SCHEDULES) {
    if (have.has(`:${schedule.kind}`)) continue
    await upsertSchedule({ ...schedule, companyId: null })
    installed++
  }

  return { installed }
}

/** Why each schedule exists, for the operations page. */
export const SCHEDULE_REASONS: Record<string, string> = Object.fromEntries(
  [...COMPANY_SCHEDULES, ...GLOBAL_SCHEDULES].map((entry) => [entry.kind, entry.why]),
)
