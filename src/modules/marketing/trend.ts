import {
  BOUNCE_WATCH_BP,
  COMPLAINT_WATCH_BP,
  MIN_VOLUME,
  REPUTATION_WINDOW_DAYS,
} from './reputation'

/**
 * Whether it is getting better or worse (Phase 86).
 *
 * ## The number written down where nobody reads it
 *
 * Phase 84 measures a sending reputation and Phase 85 attributes it. Both
 * answer *how bad is it now*. Neither answers the question a reputation metric
 * exists for, which is **is this getting better or worse** — and those call for
 * different actions. 3% that was 1% last week is a domain sliding; 3% that was
 * 6% last week is a list somebody already cleaned, and telling them to clean it
 * again is telling them to undo their own fix.
 *
 * There is almost a history already, which is what makes this worth a phase
 * rather than a feature. The digest runs daily, `background_jobs.result` is
 * never swept, and since Phase 84 it has recorded the verdict on every run. But
 * it records the **level** and not the rate, so 2.1% and 4.9% are both the
 * string `watch`; the quiet-day early return omits sending entirely, so the
 * record is blank on exactly the days that would be the baseline; and nothing
 * anywhere reads it. The number was written down every night, in a column
 * nobody reads, without the number in it.
 *
 * ## The judgement: consecutive readings are not two measurements
 *
 * The obvious comparison is today against yesterday, and it is close to
 * meaningless. The rate is measured over a **rolling seven-day window**, so
 * today's reading and yesterday's share six of their seven days. A day-on-day
 * difference is one day of new mail moving an average of seven, which is small
 * by construction and says nothing about direction.
 *
 * So a reading is compared against one a **full window** old. Those two cohorts
 * do not overlap at all: one is the mail sent last week, the other the mail
 * sent this week, and the difference between them is a real difference between
 * two populations rather than an artefact of a sliding average.
 *
 * Nothing here touches the database or the clock.
 */

/** One day's counts, as the snapshot stored them. */
export type Reading = {
  /** The day the snapshot was taken, `YYYY-MM-DD`. */
  takenOn: string
  accepted: number
  bounced: number
  complained: number
}

export type Direction = 'improving' | 'worsening' | 'steady'

export type Trend = {
  direction: Direction
  /** The reading being judged, and the one a window earlier. */
  nowBounceRateBp: number
  nowComplaintRateBp: number
  thenBounceRateBp: number
  thenComplaintRateBp: number
  thenTakenOn: string
  /** Days between the two readings. A window, or as close as history allows. */
  spanDays: number
  /** What to say, or null when there is nothing worth saying. */
  summary: string | null
}

/**
 * How much a rate has to move before it is a direction rather than a wobble.
 *
 * Half a watch threshold: one point of bounces, or five hundredths of a point
 * of complaints. Below that the honest answer is `steady`, because two windows
 * of ordinary list churn differ by that much without anything having changed.
 */
const MATERIAL_CHANGE = 0.5

function rateBp(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 10_000)
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / (24 * 60 * 60 * 1000))
}

function asPercent(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`
}

/**
 * The direction of travel, or `null` when there is nothing to compare against.
 *
 * Null for a company with no history yet, one whose older readings are all
 * below the volume floor, and one whose history does not reach back far enough
 * for two non-overlapping windows. "We do not know yet" and "it is steady" are
 * different answers, and the first must not be reported as the second — the
 * same rule `sendingHealth` follows for the rate itself.
 *
 * `readings` may arrive in any order and may have gaps; days the worker did not
 * run simply are not there.
 */
export function trendFor(readings: readonly Reading[]): Trend | null {
  const usable = readings
    .filter((reading) => reading.accepted >= MIN_VOLUME)
    .slice()
    .sort((a, b) => (a.takenOn < b.takenOn ? -1 : a.takenOn > b.takenOn ? 1 : 0))

  if (usable.length < 2) return null

  const now = usable[usable.length - 1]

  /*
    The most recent reading that is at least a full window older than `now`.

    Not simply the oldest available: a company with a year of history should be
    compared against last week, not against last January. And not the reading
    nearest to exactly seven days ago either — the worker may have missed days,
    and a candidate *older* than a window is still two non-overlapping cohorts
    while a nearer one is not.
  */
  const then = usable
    .slice(0, -1)
    .reverse()
    .find((reading) => daysBetween(reading.takenOn, now.takenOn) >= REPUTATION_WINDOW_DAYS)

  if (!then) return null

  const nowBounceRateBp = rateBp(now.bounced, now.accepted)
  const nowComplaintRateBp = rateBp(now.complained, now.accepted)
  const thenBounceRateBp = rateBp(then.bounced, then.accepted)
  const thenComplaintRateBp = rateBp(then.complained, then.accepted)

  /*
    Movement in watch-threshold widths, so the two rates are comparable. A tenth
    of a point of complaints is as serious as two points of bounces, and adding
    raw basis points would let bounce noise drown a real complaint movement —
    the same currency Phase 85 ranks culprits in.
  */
  const movement =
    (nowBounceRateBp - thenBounceRateBp) / BOUNCE_WATCH_BP +
    (nowComplaintRateBp - thenComplaintRateBp) / COMPLAINT_WATCH_BP

  const direction: Direction =
    movement >= MATERIAL_CHANGE ? 'worsening' : movement <= -MATERIAL_CHANGE ? 'improving' : 'steady'

  const spanDays = daysBetween(then.takenOn, now.takenOn)

  return {
    direction,
    nowBounceRateBp,
    nowComplaintRateBp,
    thenBounceRateBp,
    thenComplaintRateBp,
    thenTakenOn: then.takenOn,
    spanDays,
    summary: summarise(direction, {
      nowBounceRateBp,
      thenBounceRateBp,
      nowComplaintRateBp,
      thenComplaintRateBp,
      spanDays,
    }),
  }
}

function summarise(
  direction: Direction,
  parts: {
    nowBounceRateBp: number
    thenBounceRateBp: number
    nowComplaintRateBp: number
    thenComplaintRateBp: number
    spanDays: number
  },
): string | null {
  if (direction === 'steady') return null

  // Whichever rate moved further in its own threshold's terms is the one worth
  // naming; saying both makes a sentence nobody finishes reading.
  const bounceMove =
    Math.abs(parts.nowBounceRateBp - parts.thenBounceRateBp) / BOUNCE_WATCH_BP
  const complaintMove =
    Math.abs(parts.nowComplaintRateBp - parts.thenComplaintRateBp) / COMPLAINT_WATCH_BP

  const [label, then, now] =
    complaintMove > bounceMove
      ? ['spam complaints', parts.thenComplaintRateBp, parts.nowComplaintRateBp]
      : ['bounces', parts.thenBounceRateBp, parts.nowBounceRateBp]

  const verb = direction === 'worsening' ? 'up' : 'down'

  return `${label} ${verb} from ${asPercent(then as number)} to ${asPercent(now as number)} over ${parts.spanDays} days`
}
