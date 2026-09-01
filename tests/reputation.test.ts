import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOUNCE_URGENT_BP,
  BOUNCE_WATCH_BP,
  COMPLAINT_URGENT_BP,
  COMPLAINT_WATCH_BP,
  MIN_VOLUME,
  REPUTATION_WINDOW_DAYS,
  sendingHealth,
} from '@/modules/marketing/reputation'

/**
 * Whether a company's mail is still welcome (Phase 84).
 *
 * Phase 83 made a bounce a real thing and the rate measurable. Nothing watched
 * it — and it is the one failure in this application that gets worse while
 * nobody does anything, because a mailbox provider scores a sender over weeks.
 */

/** Enough sends that a rate means something. */
const VOLUME = 1_000

function counts(bounced: number, complained = 0) {
  return { accepted: VOLUME, bounced, complained }
}

describe('a rate needs a denominator', () => {
  /**
   * One bad address in a ten-recipient campaign is a 10% bounce rate and means
   * nothing at all. Waking somebody for it teaches them to ignore the digest.
   */
  it('says nothing at all below the volume floor', () => {
    expect(sendingHealth({ accepted: 10, bounced: 1, complained: 1 })).toBeNull()
    expect(sendingHealth({ accepted: MIN_VOLUME - 1, bounced: 99, complained: 99 })).toBeNull()
  })

  /**
   * `null` rather than a calm `ok`. "We have not sent enough to know" and "we
   * have sent plenty and it is fine" are different answers, and returning the
   * second when you mean the first is lying quietly.
   */
  it('starts answering at the floor', () => {
    const verdict = sendingHealth({ accepted: MIN_VOLUME, bounced: 0, complained: 0 })

    expect(verdict).not.toBeNull()
    expect(verdict!.level).toBe('ok')
    expect(verdict!.concern).toBeNull()
  })
})

describe('the bounce rate', () => {
  it('is quiet under two per cent', () => {
    const verdict = sendingHealth(counts(19))!

    expect(verdict.bounceRateBp).toBe(190)
    expect(verdict.level).toBe('ok')
  })

  it('watches from two per cent, before anything bad has happened', () => {
    const verdict = sendingHealth(counts(BOUNCE_WATCH_BP / 10_000 * VOLUME))!

    expect(verdict.level).toBe('watch')
    expect(verdict.concern).toBe('2.0% of mail is bouncing')
  })

  it('is urgent from five, which is where suspensions start', () => {
    const verdict = sendingHealth(counts(BOUNCE_URGENT_BP / 10_000 * VOLUME))!

    expect(verdict.level).toBe('urgent')
    expect(verdict.concern).toBe('5.0% of mail is bouncing')
  })
})

describe('the complaint rate', () => {
  /** Google asks senders to stay under 0.1% and caps them at 0.3%. */
  it('watches at a tenth of a per cent', () => {
    const verdict = sendingHealth({ accepted: VOLUME, bounced: 0, complained: 1 })!

    expect(verdict.complaintRateBp).toBe(COMPLAINT_WATCH_BP)
    expect(verdict.level).toBe('watch')
    expect(verdict.concern).toBe('0.1% of readers marked it as spam')
  })

  it('is urgent at the ceiling', () => {
    const verdict = sendingHealth({ accepted: VOLUME, bounced: 0, complained: 3 })!

    expect(verdict.complaintRateBp).toBe(COMPLAINT_URGENT_BP)
    expect(verdict.level).toBe('urgent')
  })

  it('is reported to a decimal, since whole per cent rounds it to nothing', () => {
    expect(sendingHealth({ accepted: VOLUME, bounced: 0, complained: 2 })!.concern).toBe(
      '0.2% of readers marked it as spam',
    )
  })
})

describe('when both are wrong at once', () => {
  it('names both', () => {
    const verdict = sendingHealth({ accepted: VOLUME, bounced: 30, complained: 2 })!

    expect(verdict.concern).toBe(
      '3.0% of mail is bouncing, and 0.2% of readers marked it as spam',
    )
  })

  /** A merely-watchable complaint rate must not calm an urgent bounce rate. */
  it('never talks itself down', () => {
    const verdict = sendingHealth({ accepted: VOLUME, bounced: 60, complained: 1 })!

    expect(verdict.level).toBe('urgent')
  })
})

/**
 * The window is longer than the digest's own, deliberately: a bounce arrives
 * hours or days after the send, so a rate over the last twenty-four hours of
 * sends misses the bounces those sends are about to produce.
 */
describe('the window', () => {
  it('is a week, not a day', () => {
    expect(REPUTATION_WINDOW_DAYS).toBe(7)

    const source = readFileSync('src/modules/worker/health.ts', 'utf8')
    expect(source).toContain('REPUTATION_WINDOW_DAYS * 24 * 60 * 60 * 1000')
  })

  it('counts what a provider accepted, not what was skipped or never sent', () => {
    const source = readFileSync('src/modules/marketing/analytics.ts', 'utf8')

    expect(source).toContain("NOT IN ('pending', 'skipped', 'failed')")
  })
})

/**
 * Phase 24's rule was "nothing at all when the count is zero". A reputation
 * going bad is not a count of things that failed — nothing failed, which is
 * exactly what makes it easy to miss.
 */
describe('the digest speaks for a reason that is not a count', () => {
  const health = readFileSync('src/modules/worker/health.ts', 'utf8')
  const handler = readFileSync('src/modules/worker/handlers/health.ts', 'utf8')

  it('asks whether there is anything worth saying', () => {
    expect(health).toContain(
      "worthSaying: total > 0 || (sending !== null && sending.level !== 'ok')",
    )
    expect(handler).toContain('if (!state.worthSaying)')
  })

  it('still says nothing on a quiet day', () => {
    // The silence Phase 24 bought is the thing that makes the noise mean
    // something, so an `ok` verdict must not become a daily "all fine".
    expect(sendingHealth({ accepted: 100_000, bounced: 0, complained: 0 })!.concern).toBeNull()
  })

  it('leads with the sending problem when it is the urgent one', () => {
    expect(handler).toContain("if (state.sending.level === 'urgent') parts.unshift(phrase)")
  })
})
