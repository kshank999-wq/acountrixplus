import { describe, expect, it } from 'vitest'
import { trendFor, type Reading } from '@/modules/marketing/trend'
import { MIN_VOLUME, REPUTATION_WINDOW_DAYS } from '@/modules/marketing/reputation'

/**
 * Whether it is getting better or worse (Phase 86).
 *
 * The judgement being tested is that **consecutive readings are not two
 * measurements**: the rate is a rolling seven-day window, so today and
 * yesterday share six of their seven days. A comparison has to reach back a
 * full window before the two cohorts stop overlapping.
 */

function reading(takenOn: string, bounced: number, complained = 0): Reading {
  return { takenOn, accepted: 1_000, bounced, complained }
}

describe('there is nothing to compare against', () => {
  it('says nothing with no history', () => {
    expect(trendFor([])).toBeNull()
    expect(trendFor([reading('2026-09-01', 10)])).toBeNull()
  })

  /**
   * "We do not know yet" and "it is steady" are different answers, and the
   * first must not be reported as the second — the rule `sendingHealth`
   * already follows for the rate itself.
   */
  it('says nothing when the history does not reach back a whole window', () => {
    const trend = trendFor([
      reading('2026-09-01', 10),
      reading('2026-09-04', 60),
      reading('2026-09-06', 60),
    ])

    // Six days is still two overlapping seven-day cohorts.
    expect(trend).toBeNull()
  })

  it('starts answering at exactly one window', () => {
    const trend = trendFor([reading('2026-09-01', 10), reading('2026-09-08', 60)])

    expect(trend).not.toBeNull()
    expect(trend!.spanDays).toBe(REPUTATION_WINDOW_DAYS)
  })

  /** A reading taken when the company had not sent enough is not a baseline. */
  it('ignores readings below the volume floor', () => {
    const trend = trendFor([
      { takenOn: '2026-09-01', accepted: MIN_VOLUME - 1, bounced: 40, complained: 0 },
      reading('2026-09-10', 10),
    ])

    expect(trend).toBeNull()
  })
})

describe('the direction', () => {
  it('is worsening when the rate has climbed', () => {
    const trend = trendFor([reading('2026-09-01', 10), reading('2026-09-08', 60)])!

    expect(trend.direction).toBe('worsening')
    expect(trend.thenBounceRateBp).toBe(100)
    expect(trend.nowBounceRateBp).toBe(600)
    expect(trend.summary).toBe('bounces up from 1.0% to 6.0% over 7 days')
  })

  /**
   * The reading that makes this worth building. 3% that was 6% last week is a
   * list somebody has already cleaned, and telling them to clean it again is
   * telling them to undo their own fix.
   */
  it('is improving when somebody has already fixed it', () => {
    const trend = trendFor([reading('2026-09-01', 60), reading('2026-09-08', 30)])!

    expect(trend.direction).toBe('improving')
    expect(trend.summary).toBe('bounces down from 6.0% to 3.0% over 7 days')
  })

  /** Two windows of ordinary churn differ without anything having changed. */
  it('is steady when the move is too small to mean anything', () => {
    const trend = trendFor([reading('2026-09-01', 30), reading('2026-09-08', 38)])!

    expect(trend.direction).toBe('steady')
    expect(trend.summary).toBeNull()
  })
})

describe('which reading it compares against', () => {
  /**
   * Not the oldest available: a company with a year of history should be
   * compared against last week, not against last January.
   */
  it('picks the most recent reading a full window old', () => {
    const trend = trendFor([
      reading('2026-01-01', 5),
      reading('2026-08-20', 60),
      reading('2026-09-01', 20),
      reading('2026-09-10', 60),
    ])!

    expect(trend.thenTakenOn).toBe('2026-09-01')
    expect(trend.spanDays).toBe(9)
    expect(trend.direction).toBe('worsening')
  })

  /**
   * The worker misses days. A candidate *older* than a window is still two
   * non-overlapping cohorts; a nearer one is not, so reaching further back is
   * the safe direction to fail in.
   */
  it('reaches further back when the worker missed days', () => {
    const trend = trendFor([
      reading('2026-09-01', 10),
      reading('2026-09-12', 60), // nothing between: the worker was down
    ])!

    expect(trend.thenTakenOn).toBe('2026-09-01')
    expect(trend.spanDays).toBe(11)
  })

  it('does not care what order the readings arrive in', () => {
    const inOrder = trendFor([
      reading('2026-09-01', 10),
      reading('2026-09-05', 30),
      reading('2026-09-08', 60),
    ])

    const jumbled = trendFor([
      reading('2026-09-08', 60),
      reading('2026-09-01', 10),
      reading('2026-09-05', 30),
    ])

    expect(jumbled).toEqual(inOrder)
    expect(jumbled!.thenTakenOn).toBe('2026-09-01')
  })
})

describe('complaints and bounces are not the same size of move', () => {
  /**
   * A tenth of a point of complaints is as serious as two points of bounces.
   * Adding raw basis points would let bounce noise drown a real complaint
   * movement — the currency Phase 85 ranks culprits in.
   */
  it('names the rate that moved further in its own terms', () => {
    const trend = trendFor([
      { takenOn: '2026-09-01', accepted: 1_000, bounced: 30, complained: 0 },
      { takenOn: '2026-09-08', accepted: 1_000, bounced: 40, complained: 4 },
    ])!

    // Bounces moved half a width; complaints moved four.
    expect(trend.direction).toBe('worsening')
    expect(trend.summary).toBe('spam complaints up from 0.0% to 0.4% over 7 days')
  })

  it('will not call it steady because one rate improved as the other got worse', () => {
    const trend = trendFor([
      { takenOn: '2026-09-01', accepted: 1_000, bounced: 60, complained: 0 },
      { takenOn: '2026-09-08', accepted: 1_000, bounced: 20, complained: 5 },
    ])!

    // Bounces down two widths, complaints up five: on balance, worse.
    expect(trend.direction).toBe('worsening')
  })
})
