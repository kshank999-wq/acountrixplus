import { describe, expect, it } from 'vitest'
import {
  adviseOutcome,
  batchStatus,
  batchSucceeded,
  nameList,
  payRunOutcome,
} from '@/modules/payables/batch'

/**
 * The pay run that half-happened (Phase 59).
 *
 * The claim under test: **a run where some suppliers were paid is a success
 * with a warning, not a failure.** Phase 49 reported it as a failure and threw
 * away the list of who had already been paid, so a business was told nothing
 * happened while money had left its bank.
 */

describe('how much of a batch worked', () => {
  it('is complete when nothing failed', () => {
    expect(batchStatus(3, 0)).toBe('complete')
  })

  it('is partial when some of each', () => {
    expect(batchStatus(2, 1)).toBe('partial')
  })

  it('is nothing when none got through', () => {
    expect(batchStatus(0, 3)).toBe('nothing')
  })

  /** An empty batch did nothing, which is not the same as failing. */
  it('is nothing when there was nothing to do', () => {
    expect(batchStatus(0, 0)).toBe('nothing')
  })

  it('counts a partial batch as having succeeded', () => {
    expect(batchSucceeded('partial')).toBe(true)
    expect(batchSucceeded('complete')).toBe(true)
    expect(batchSucceeded('nothing')).toBe(false)
  })
})

describe('naming who', () => {
  it('says nothing about nobody', () => {
    expect(nameList([])).toBe('')
  })

  it('says one name plainly', () => {
    expect(nameList(['Cascade'])).toBe('Cascade')
  })

  it('joins the last with an and', () => {
    expect(nameList(['Cascade', 'Delta'])).toBe('Cascade and Delta')
    expect(nameList(['Cascade', 'Delta', 'Supply Depot'])).toBe(
      'Cascade, Delta and Supply Depot',
    )
  })

  /** A person acting on this does not need forty names in a notice. */
  it('stops counting past a handful', () => {
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })
})

const supplier = (vendorId: string, vendorName: string, amountCents: number, billCount = 1) => ({
  vendorId,
  vendorName,
  amountCents,
  billCount,
})

describe('what a pay run did', () => {
  it('reports a clean run as a clean run', () => {
    const result = payRunOutcome({
      paid: [supplier('v1', 'Cascade', 250_000, 2), supplier('v2', 'Delta', 71_800)],
      failed: [],
    })

    expect(result.status).toBe('complete')
    expect(result.paidCents).toBe(321_800)
    expect(result.billsSettled).toBe(3)
    expect(result.message).toBe(
      '$3,218.00 paid — 2 payments, one per supplier, settling 3 bills.',
    )
  })

  /**
   * The case the previous code got wrong, and the reason for the phase.
   *
   * Money left the bank for Cascade. Reporting this as a failure — which is
   * what `catch` did — tells a person to try again, ring the supplier, or key
   * it into the bank by hand.
   */
  it('leads with the money that went, when only some of it did', () => {
    const result = payRunOutcome({
      paid: [supplier('v1', 'Cascade', 250_000, 2)],
      failed: [
        { vendorId: 'v2', vendorName: 'Delta', error: 'the period is closed' },
      ],
      attemptedCentsByVendor: { v2: 71_800 },
    })

    expect(result.status).toBe('partial')
    expect(result.paidCents).toBe(250_000)
    expect(result.unpaidCents).toBe(71_800)

    // The money that moved comes first, before the apology.
    expect(result.message.startsWith('$2,500.00 paid')).toBe(true)
    expect(result.message).toContain('Delta (the period is closed)')
    expect(result.message).toContain('$718.00 still owed')
    expect(result.message).toContain('do not send it again')
  })

  /** A count tells nobody which supplier to ring. */
  it('names every supplier that failed, not just how many', () => {
    const result = payRunOutcome({
      paid: [supplier('v1', 'Cascade', 250_000)],
      failed: [
        { vendorId: 'v2', vendorName: 'Delta', error: 'no bank account' },
        { vendorId: 'v3', vendorName: 'Supply Depot', error: 'the period is closed' },
      ],
    })

    expect(result.message).toContain('Delta (no bank account)')
    expect(result.message).toContain('Supply Depot (the period is closed)')
    expect(result.message).toContain('2 suppliers could not be paid')
  })

  it('says plainly when no money moved at all', () => {
    const result = payRunOutcome({
      paid: [],
      failed: [{ vendorId: 'v1', vendorName: 'Cascade', error: 'the period is closed' }],
    })

    expect(result.status).toBe('nothing')
    expect(result.paidCents).toBe(0)
    expect(result.message).toBe('Nothing was paid. Cascade (the period is closed).')
    expect(result.message).not.toContain('do not send it again')
  })

  it('handles a run with nothing in it', () => {
    const result = payRunOutcome({ paid: [], failed: [] })

    expect(result.status).toBe('nothing')
    expect(result.message).toBe('Nothing was paid, because nothing was selected.')
  })

  /** Without the attempted figures there is simply no claim to make. */
  it('omits the unpaid total rather than guessing it', () => {
    const result = payRunOutcome({
      paid: [supplier('v1', 'Cascade', 250_000)],
      failed: [{ vendorId: 'v2', vendorName: 'Delta', error: 'the period is closed' }],
    })

    expect(result.unpaidCents).toBe(0)
    expect(result.message).not.toContain('still owed')
  })

  it('gets the singulars right for a run of one', () => {
    const result = payRunOutcome({ paid: [supplier('v1', 'Cascade', 100_00)], failed: [] })

    expect(result.message).toContain('1 payment,')
    expect(result.message).toContain('settling 1 bill.')
  })
})

describe('what advising a run did', () => {
  it('names who was told', () => {
    const result = adviseOutcome({
      sent: [
        { vendorId: 'v1', vendorName: 'Cascade', to: 'ar@cascade.test' },
        { vendorId: 'v2', vendorName: 'Delta', to: 'ap@delta.test' },
      ],
      failed: [],
    })

    expect(result.status).toBe('complete')
    expect(result.message).toBe('Advice sent to 2 suppliers: Cascade and Delta.')
  })

  /**
   * The common case, because a supplier with no address on file is ordinary.
   * A batch that stopped at the first one would leave the rest of a run
   * silently unadvised — the failure Phase 58's own refusal invites.
   */
  it('tells the rest, and says who was missed', () => {
    const result = adviseOutcome({
      sent: [{ vendorId: 'v1', vendorName: 'Cascade', to: 'ar@cascade.test' }],
      failed: [
        {
          vendorId: 'v2',
          vendorName: 'Delta',
          error: 'Delta has no email address on file.',
        },
      ],
    })

    expect(result.status).toBe('partial')
    expect(result.message).toContain('Advice sent to 1 of 2 suppliers')
    expect(result.message).toContain('Delta could not be told')
    expect(result.message).toContain('Get link')
  })

  it('says so when nobody could be told', () => {
    const result = adviseOutcome({
      sent: [],
      failed: [
        { vendorId: 'v1', vendorName: 'Cascade', error: 'Cascade has no email address on file.' },
      ],
    })

    expect(result.status).toBe('nothing')
    expect(result.message).toContain('Nobody could be told')
  })

  it('says so when the run paid nobody in the first place', () => {
    const result = adviseOutcome({ sent: [], failed: [] })

    expect(result.status).toBe('nothing')
    expect(result.message).toBe('There is nobody to tell: this run paid no suppliers.')
  })
})
