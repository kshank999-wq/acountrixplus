import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { jobSchedules } from '@/db/schema'
import { enqueue } from './queue'

/**
 * Recurring work.
 *
 * ## Not cron
 *
 * A cron expression is a small language, and the failure mode of a small
 * language nobody validates is that a typo means "never" rather than "error".
 * A schedule that silently never fires is worse than one that cannot express
 * every possible timing, because the second kind is discovered on the day it
 * is written.
 *
 * Four cadences and an hour cover every recurring job this product has. If a
 * real cron requirement appears, it is a column on a table that already exists.
 */

export type Cadence = 'hourly' | 'daily' | 'weekly' | 'monthly'

export type CadenceSpec = {
  cadence: Cadence
  /** UTC hour. Ignored by `hourly`. */
  hourUtc?: number
  /** 0 = Sunday. `weekly` only. */
  dayOfWeek?: number
  /** 1–28. `monthly` only. */
  dayOfMonth?: number
}

/**
 * The next firing strictly after `after`. Pure, and in UTC throughout.
 *
 * **Strictly after** is the property that matters. A function returning a time
 * equal to `after` gives a scheduler that fires the same job forever, because
 * every tick computes a next-run that has already passed. The tests assert
 * this directly rather than trusting the arithmetic.
 *
 * `dayOfMonth` is capped at 28 by a database CHECK rather than clamped here.
 * "The 31st" in February is a question with three defensible answers — the
 * 28th, the 1st of March, or skip — and picking one silently is how a monthly
 * job runs eleven times a year without anybody noticing. Refusing the input is
 * the honest option.
 */
export function nextRunAt(spec: CadenceSpec, after: Date): Date {
  const hour = spec.hourUtc ?? 0

  switch (spec.cadence) {
    case 'hourly': {
      const next = new Date(after)
      next.setUTCMinutes(0, 0, 0)
      next.setUTCHours(next.getUTCHours() + 1)
      return next
    }

    case 'daily': {
      const next = new Date(after)
      next.setUTCHours(hour, 0, 0, 0)
      if (next <= after) next.setUTCDate(next.getUTCDate() + 1)
      return next
    }

    case 'weekly': {
      const target = spec.dayOfWeek ?? 1
      const next = new Date(after)
      next.setUTCHours(hour, 0, 0, 0)

      // Days until the target weekday. Zero means today, which is only usable
      // if today's hour has not passed yet — hence the `|| 7` below.
      const delta = (target - next.getUTCDay() + 7) % 7
      next.setUTCDate(next.getUTCDate() + delta)

      if (next <= after) next.setUTCDate(next.getUTCDate() + 7)
      return next
    }

    case 'monthly': {
      const day = spec.dayOfMonth ?? 1
      const next = new Date(after)
      next.setUTCDate(day)
      next.setUTCHours(hour, 0, 0, 0)

      if (next <= after) {
        // Set to the 1st before moving the month, so a month rollover cannot
        // skip a month: the 31st of a 30-day month rolls forward on its own.
        next.setUTCDate(1)
        next.setUTCMonth(next.getUTCMonth() + 1)
        next.setUTCDate(day)
      }
      return next
    }
  }
}

export type ScheduleInput = CadenceSpec & {
  kind: string
  companyId?: string | null
  payload?: Record<string, unknown>
  /** Defaults to the next firing after now. */
  startAt?: Date
}

/**
 * Creates or updates a schedule.
 *
 * Upserted on (company, kind), because a second "daily review nudge" is never
 * what anybody meant and two of them means the nudge goes out twice.
 */
export async function upsertSchedule(input: ScheduleInput, exec: Executor = db) {
  const now = input.startAt ?? new Date()

  const [schedule] = await exec
    .insert(jobSchedules)
    .values({
      companyId: input.companyId ?? null,
      kind: input.kind,
      payload: input.payload ?? {},
      cadence: input.cadence,
      hourUtc: input.hourUtc ?? 0,
      dayOfWeek: input.dayOfWeek ?? 1,
      dayOfMonth: input.dayOfMonth ?? 1,
      nextRunAt: nextRunAt(input, now),
    })
    .onConflictDoUpdate({
      target: [jobSchedules.companyId, jobSchedules.kind],
      set: {
        payload: input.payload ?? {},
        cadence: input.cadence,
        hourUtc: input.hourUtc ?? 0,
        dayOfWeek: input.dayOfWeek ?? 1,
        dayOfMonth: input.dayOfMonth ?? 1,
        nextRunAt: nextRunAt(input, now),
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning()

  return schedule
}

/**
 * Turns every due schedule into a queued job and advances it.
 *
 * ## Why the dedupe key is the schedule and its firing time
 *
 * Two workers ticking at the same second both see the same due schedule. The
 * key `schedule:<id>:<iso>` makes the second insert a no-op at the database
 * rather than a second copy of the nightly nudge. It also means a schedule
 * whose previous job is still queued does not stack — the key differs per
 * firing, but the *job* dedupe on a still-queued row of the same key holds.
 *
 * The advance happens whether or not the enqueue won the race. A schedule that
 * did not advance because another worker enqueued first would fire again
 * immediately, which is the loop this key exists to prevent.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<{
  fired: number
  skipped: number
}> {
  const due = await db
    .select()
    .from(jobSchedules)
    .where(and(eq(jobSchedules.isActive, true), lte(jobSchedules.nextRunAt, now)))
    .orderBy(asc(jobSchedules.nextRunAt))

  let fired = 0
  let skipped = 0

  for (const schedule of due) {
    const firing = schedule.nextRunAt.toISOString()

    const result = await enqueue({
      kind: schedule.kind,
      companyId: schedule.companyId,
      payload: schedule.payload,
      scheduleId: schedule.id,
      dedupeKey: `schedule:${schedule.id}:${firing}`,
    })

    if (result.enqueued) fired++
    else skipped++

    await db
      .update(jobSchedules)
      .set({
        lastRunAt: now,
        nextRunAt: nextRunAt(
          {
            cadence: schedule.cadence,
            hourUtc: schedule.hourUtc,
            dayOfWeek: schedule.dayOfWeek,
            dayOfMonth: schedule.dayOfMonth,
          },
          now,
        ),
        updatedAt: now,
      })
      .where(eq(jobSchedules.id, schedule.id))
  }

  return { fired, skipped }
}

export async function listSchedules(companyId?: string) {
  return db
    .select()
    .from(jobSchedules)
    .where(
      companyId
        ? sql`${jobSchedules.companyId} = ${companyId} OR ${jobSchedules.companyId} IS NULL`
        : undefined,
    )
    .orderBy(asc(jobSchedules.nextRunAt))
}

export async function setScheduleActive(scheduleId: string, isActive: boolean): Promise<void> {
  await db
    .update(jobSchedules)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(jobSchedules.id, scheduleId))
}
