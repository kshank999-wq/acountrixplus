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
    kind: 'jobs.propose_wip_entry',
    cadence: 'monthly',
    hourUtc: 2,
    dayOfMonth: 1,
    why: 'After a month closes. Proposes a draft; posting stays a decision.',
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

/** Why each schedule exists, for the operations page. */
export const SCHEDULE_REASONS: Record<string, string> = Object.fromEntries(
  [...COMPANY_SCHEDULES, ...GLOBAL_SCHEDULES].map((entry) => [entry.kind, entry.why]),
)
