import { describe, expect, it } from 'vitest'
import {
  EMPTY_SWEEP,
  STALE_AFTER_DAYS,
  daysBetween,
  describeSweep,
  needsAttention,
  sweepDecision,
  unresolvedKind,
  type ReportedStatus,
  type SweepableCheckout,
} from '@/modules/payments/reconcile'

/**
 * Finding out what happened to a payment nobody came back from (Phase 46).
 *
 * The claim under test: **an unknown is never resolved**. Expiring a checkout
 * the processor cannot account for writes off a customer's money in silence,
 * and no later answer reopens it.
 */

const checkout = (over: Partial<SweepableCheckout> = {}): SweepableCheckout => ({
  id: 'co-1',
  status: 'pending',
  expiresAt: '2026-03-01T11:00:00.000Z',
  createdAt: '2026-03-01T10:00:00.000Z',
  ...over,
})

const decide = (reported: ReportedStatus, asOf: string, over: Partial<SweepableCheckout> = {}) =>
  sweepDecision({ checkout: checkout(over), reported, asOf })

describe('sweepDecision', () => {
  /**
   * The whole point of the sweep. The customer paid and closed the tab; the
   * processor has the money and our books do not.
   */
  it('settles a payment the processor took', () => {
    const verdict = decide('succeeded', '2026-03-01T10:30:00.000Z')

    expect(verdict.action).toBe('settle')
    expect(verdict.why).toContain('had not reached these books')
  })

  /**
   * The processor holds the money, so its answer beats our own record — even
   * one we had already given up on.
   */
  it('settles one we had written off, if the processor says it went through', () => {
    expect(decide('succeeded', '2027-01-01T00:00:00.000Z', { status: 'expired' }).action).toBe(
      'settle',
    )
    expect(decide('succeeded', '2027-01-01T00:00:00.000Z', { status: 'failed' }).action).toBe(
      'settle',
    )
  })

  it('records a decline and stops asking', () => {
    expect(decide('failed', '2026-03-01T10:30:00.000Z').action).toBe('mark_failed')
  })

  it('waits while the customer is still on the processor’s page', () => {
    const verdict = decide('pending', '2026-03-01T10:30:00.000Z')

    expect(verdict.action).toBe('wait')
    expect(verdict.why).toContain('Still with the customer')
  })

  it('expires one that was started and never completed', () => {
    const verdict = decide('pending', '2026-03-01T11:00:01.000Z')

    expect(verdict.action).toBe('expire')
    expect(verdict.why).toContain('took nothing')
  })

  it('does not expire a second before the deadline', () => {
    expect(decide('pending', '2026-03-01T11:00:00.000Z').action).toBe('wait')
  })

  /**
   * The assertion this module exists for. An outage at the processor must not
   * become a customer's money written off, so an unknown resolves nothing in
   * either direction and goes to a person.
   */
  it('never resolves one the processor cannot account for', () => {
    for (const asOf of ['2026-03-01T10:30:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const verdict = decide('unknown', asOf)
      expect(verdict.action).toBe('investigate')
      expect(verdict.why).toContain('Somebody needs to look')
    }
  })

  it('gives a checkout with no stated expiry a generous window', () => {
    const noExpiry = { expiresAt: null, createdAt: '2026-03-01T10:00:00.000Z' }

    // Well inside the window.
    expect(decide('pending', '2026-03-01T20:00:00.000Z', noExpiry).action).toBe('wait')
    // A day later, and it is stale.
    expect(decide('pending', '2026-03-02T10:00:01.000Z', noExpiry).action).toBe('expire')
    expect(STALE_AFTER_DAYS).toBe(1)
  })

  it('copes with a date it cannot read rather than expiring on it', () => {
    // A garbled timestamp must not become "abandoned". Waiting costs a day;
    // expiring costs a payment.
    const verdict = decide('pending', 'not-a-date', { expiresAt: null, createdAt: 'nonsense' })
    expect(verdict.action).toBe('wait')
  })
})

describe('daysBetween', () => {
  it('counts whole days between timestamps', () => {
    expect(daysBetween('2026-03-01T10:00:00.000Z', '2026-03-04T10:00:00.000Z')).toBe(3)
  })

  it('goes negative backwards, and gives up quietly on nonsense', () => {
    expect(daysBetween('2026-03-04T10:00:00.000Z', '2026-03-01T10:00:00.000Z')).toBe(-3)
    expect(daysBetween('nope', '2026-03-01T10:00:00.000Z')).toBe(0)
  })
})

describe('describeSweep', () => {
  /**
   * Null on a quiet run rather than "0 recovered". A job announcing nothing
   * every hour is one whose output nobody reads by the afternoon.
   */
  it('says nothing when nothing happened', () => {
    expect(describeSweep(EMPTY_SWEEP)).toBeNull()
    expect(describeSweep({ ...EMPTY_SWEEP, waiting: 12 })).toBeNull()
  })

  it('names what it found', () => {
    expect(describeSweep({ ...EMPTY_SWEEP, settled: 1 })).toBe('1 payment recovered.')
    expect(describeSweep({ ...EMPTY_SWEEP, settled: 3 })).toBe('3 payments recovered.')
    expect(describeSweep({ ...EMPTY_SWEEP, settled: 2, expired: 5 })).toBe(
      '2 payments recovered, 5 abandoned.',
    )
  })

  it('spells out the one that needs a person', () => {
    const sentence = describeSweep({ ...EMPTY_SWEEP, investigate: 2 })
    expect(sentence).toContain('cannot account for')
    expect(sentence).toContain('somebody needs to look')
  })
})

describe('needsAttention', () => {
  /**
   * A recovered payment is the sweep working and an expired one is a customer
   * changing their mind. Waking somebody for either teaches them to ignore the
   * alert that matters.
   */
  it('is only the ones the processor cannot account for', () => {
    expect(needsAttention({ ...EMPTY_SWEEP, settled: 9, expired: 4, failed: 2 })).toBe(false)
    expect(needsAttention({ ...EMPTY_SWEEP, investigate: 1 })).toBe(true)
    expect(needsAttention(EMPTY_SWEEP)).toBe(false)
  })
})

describe('unresolvedKind', () => {
  /**
   * Browser verification found the sweep announcing "somebody needs to look"
   * into a toast, and the row it meant sitting in a list whose own copy says
   * most of these are customers who changed their mind. The two situations are
   * the same shape and need opposite responses, so the screen has to be able
   * to tell them apart from stored data rather than from a message that is
   * gone on the next reload.
   */
  it('separates a payment the processor cannot account for from an abandoned one', () => {
    expect(unresolvedKind('unknown')).toBe('unaccounted')
    expect(unresolvedKind('pending')).toBe('unanswered')
    expect(unresolvedKind('failed')).toBe('unanswered')
  })

  it('says when nothing has been asked yet rather than guessing', () => {
    expect(unresolvedKind(null)).toBe('unasked')
    expect(unresolvedKind(undefined)).toBe('unasked')
    expect(unresolvedKind('')).toBe('unasked')
  })
})
