import { describe, expect, it } from 'vitest'
import {
  FULL_BP,
  billStageStands,
  billedSoFar,
  depositStage,
  nextBillable,
  recognisesDeposit,
  scheduleAmounts,
  scheduleStands,
  sovStages,
  type ScheduleStage,
} from '@/modules/crm/billing-schedule'

/**
 * What a won proposal asks to be paid, and when (Phase 154).
 *
 * Pure: no database, no clock. The posting is decided elsewhere — `2500
 * Unearned Revenue` for a deposit, the job's schedule of values for the work —
 * and this file is only about the stages and whether they add up.
 */

/** 50% down, 25% at each of two points. */
const HALF_THEN_QUARTERS: ScheduleStage[] = [
  { label: 'On signing', kind: 'deposit', percentBp: 5_000 },
  { label: 'Frame complete', kind: 'milestone', percentBp: 2_500 },
  { label: 'On handover', kind: 'on-completion', percentBp: 2_500 },
]

describe('the amounts, which must come to the contract', () => {
  it('splits a round contract the obvious way', () => {
    const stages = scheduleAmounts(100_000_00, HALF_THEN_QUARTERS)

    expect(stages.map((stage) => stage.amountCents)).toEqual([5_000_000, 2_500_000, 2_500_000])
  })

  it('reproduces a contract that does not divide, to the cent', () => {
    // ADR 0147's question with an unambiguous answer: the contract is the figure
    // both sides signed and the stages are carved out of it, so the parts have
    // to come back to the whole. 50/25/25 of $100,000.01 cannot be three exact
    // shares, and `splitExactly` puts the odd cent on the stage that lost most
    // to the floor rather than on the last one.
    const contract = 100_000_01
    const stages = scheduleAmounts(contract, HALF_THEN_QUARTERS)

    expect(stages.reduce((sum, stage) => sum + stage.amountCents, 0)).toBe(contract)
    // And no stage is more than a cent from its exact share, which is the
    // property `prorate`'s last-takes-it rule does not have.
    for (const stage of stages) {
      const exact = (contract * stage.percentBp) / FULL_BP
      expect(Math.abs(stage.amountCents - exact), stage.label).toBeLessThanOrEqual(1)
    }
  })

  it('comes to the contract across a range of awkward totals', () => {
    // Measured rather than asserted once (Phase 126). A thirds split is the
    // case a per-stage rounding gets wrong, and it gets it wrong by a cent,
    // which is exactly the size nobody notices until a job will not close.
    const thirds: ScheduleStage[] = [
      { label: 'First', kind: 'milestone', percentBp: 3_333 },
      { label: 'Second', kind: 'milestone', percentBp: 3_333 },
      { label: 'Final', kind: 'on-completion', percentBp: 3_334 },
    ]

    const drifted: number[] = []
    for (let contract = 99_990; contract <= 100_010; contract += 1) {
      const stages = scheduleAmounts(contract, thirds)
      const total = stages.reduce((sum, stage) => sum + stage.amountCents, 0)
      if (total !== contract) drifted.push(contract)
    }

    expect(drifted).toEqual([])
  })

  it('marks the deposit as the one stage that earns nothing', () => {
    const stages = scheduleAmounts(100_000_00, HALF_THEN_QUARTERS)

    expect(stages.map((stage) => stage.earnsRevenue)).toEqual([false, true, true])
  })
})

describe('which stages the job may be told about', () => {
  it('keeps the deposit off the schedule of values', () => {
    // The one thing `sovStages` exists to say. A schedule of values is what the
    // job will earn; a deposit is money held before it earns anything. On the
    // SOV it would make the contract value the work plus money that is not work,
    // so every WIP report would show the job overbilled by the deposit from the
    // day it was signed.
    const stages = scheduleAmounts(100_000_00, HALF_THEN_QUARTERS)
    const sov = sovStages(stages)

    expect(sov.map((stage) => stage.label)).toEqual(['Frame complete', 'On handover'])
    // And the SOV is the contract less the deposit, not the contract.
    expect(sov.reduce((sum, stage) => sum + stage.amountCents, 0)).toBe(5_000_000)
  })

  it('finds the deposit, and says so when there is none', () => {
    const withDeposit = scheduleAmounts(100_000_00, HALF_THEN_QUARTERS)
    expect(depositStage(withDeposit)?.amountCents).toBe(5_000_000)

    const noDeposit = scheduleAmounts(100_000_00, [
      { label: 'Halfway', kind: 'milestone', percentBp: 5_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])
    expect(depositStage(noDeposit)).toBeNull()
    // Everything earns, so the whole contract is on the schedule of values.
    expect(sovStages(noDeposit).reduce((sum, s) => sum + s.amountCents, 0)).toBe(100_000_00)
  })
})

describe('what a schedule has to be before anybody is billed from it', () => {
  it('accepts the ordinary one', () => {
    expect(scheduleStands(HALF_THEN_QUARTERS)).toEqual({ ok: true })
  })

  it('refuses no schedule at all', () => {
    const verdict = scheduleStands([])
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/nothing about when any of it is invoiced/)
  })

  it('refuses stages that do not come to the contract, and says which way', () => {
    // Both directions, because they are different mistakes with different
    // consequences and a single "must total 100%" would tell the reader neither.
    const short = scheduleStands([
      { label: 'On signing', kind: 'deposit', percentBp: 3_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 6_000 },
    ])
    expect(short.ok).toBe(false)
    expect(short.ok === false && short.why).toMatch(/90\.00% of the contract/)
    expect(short.ok === false && short.why).toMatch(/done and never invoiced/)

    const over = scheduleStands([
      { label: 'On signing', kind: 'deposit', percentBp: 5_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 6_000 },
    ])
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.why).toMatch(/billed 10\.00% more than they agreed to/)
  })

  it('refuses a second deposit', () => {
    const verdict = scheduleStands([
      { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
      { label: 'On approval', kind: 'deposit', percentBp: 2_500 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ])

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/two balances to relieve/)
  })

  it('refuses a contract that is nothing but deposit', () => {
    // A liability that never earns anything and never clears.
    const verdict = scheduleStands([{ label: 'All of it', kind: 'deposit', percentBp: FULL_BP }])

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/never earns any of it/)
  })

  it('refuses two final stages', () => {
    const verdict = scheduleStands([
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
      { label: 'On sign-off', kind: 'on-completion', percentBp: 5_000 },
    ])

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/billed twice for its last payment/)
  })

  it('refuses an unnamed stage', () => {
    const verdict = scheduleStands([
      { label: 'On signing', kind: 'deposit', percentBp: 5_000 },
      { label: '   ', kind: 'on-completion', percentBp: 5_000 },
    ])

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/client sees these/)
  })

  it('refuses a negative or fractional share', () => {
    const negative = scheduleStands([
      { label: 'Discount', kind: 'milestone', percentBp: -1_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 11_000 },
    ])
    expect(negative.ok).toBe(false)
    expect(negative.ok === false && negative.why).toMatch(/belongs on a credit note/)

    const fractional = scheduleStands([
      { label: 'Half-ish', kind: 'milestone', percentBp: 5_000.5 },
      { label: 'On handover', kind: 'on-completion', percentBp: 4_999.5 },
    ])
    expect(fractional.ok).toBe(false)
  })

  it('accepts a schedule with no deposit, which is most of them', () => {
    // The refusals are about shapes that cannot be billed, not about insisting
    // on a deposit. Most proposals do not take one.
    expect(
      scheduleStands([
        { label: 'Halfway', kind: 'milestone', percentBp: 5_000 },
        { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
      ]),
    ).toEqual({ ok: true })
  })

  it('accepts a schedule with no final stage', () => {
    // Nothing requires one. A retainer-style engagement billed in equal monthly
    // milestones has no completion event, and refusing it would be refusing the
    // shape rather than the arithmetic.
    expect(
      scheduleStands([
        { label: 'Month 1', kind: 'milestone', percentBp: 2_500 },
        { label: 'Month 2', kind: 'milestone', percentBp: 2_500 },
        { label: 'Month 3', kind: 'milestone', percentBp: 2_500 },
        { label: 'Month 4', kind: 'milestone', percentBp: 2_500 },
      ]),
    ).toEqual({ ok: true })
  })
})

describe('which stage may be billed, and when the deposit is earned', () => {
  const priced = (invoiced: Array<string | null>) =>
    scheduleAmounts(2_000_000, [
      { label: 'On signing', kind: 'deposit', percentBp: 2_500 },
      { label: 'Frame complete', kind: 'milestone', percentBp: 2_500 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ]).map((stage, index) => ({ ...stage, invoiceId: invoiced[index] ?? null }))

  it('bills the first unbilled stage', () => {
    expect(billStageStands(priced([]), 0)).toEqual({ ok: true })
    expect(nextBillable(priced([]))?.label).toBe('On signing')
    expect(nextBillable(priced(['inv-1']))?.label).toBe('Frame complete')
    expect(nextBillable(priced(['inv-1', 'inv-2', 'inv-3']))).toBeNull()
  })

  it('refuses a stage already invoiced', () => {
    const verdict = billStageStands(priced(['inv-1']), 0)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/charge the client twice/)
  })

  it('refuses a stage whose predecessor is unbilled, and names it', () => {
    // Order is a decision: billing the handover first is either a mistake or a
    // change to the contract, and the refusal says which stage to bill instead
    // rather than just "not allowed" (Phase 119).
    const verdict = billStageStands(priced([]), 2)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/“On signing” comes before “On handover”/)
  })

  it('refuses a stage that is not on the schedule', () => {
    const verdict = billStageStands(priced([]), 7)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/not on this contract/)
  })

  it('counts what has been invoiced', () => {
    expect(billedSoFar(priced([]))).toBe(0)
    expect(billedSoFar(priced(['inv-1']))).toBe(500_000)
    expect(billedSoFar(priced(['inv-1', 'inv-2', 'inv-3']))).toBe(2_000_000)
  })

  it('earns the deposit on the last stage and not before', () => {
    const billed = priced(['inv-1', 'inv-2'])

    expect(recognisesDeposit(billed, 0)).toBe(false)
    expect(recognisesDeposit(billed, 1)).toBe(false)
    // The last stage that is not the deposit: billing it completes the contract,
    // so what the deposit was held against has been delivered.
    expect(recognisesDeposit(billed, 2)).toBe(true)
  })

  it('earns nothing when the deposit has not been billed', () => {
    // Nothing is held, so there is nothing to recognise — and recognising it
    // would credit revenue against a liability that was never raised.
    expect(recognisesDeposit(priced([null, 'inv-2']), 2)).toBe(false)
  })

  it('earns nothing on a contract with no deposit', () => {
    const noDeposit = scheduleAmounts(1_000_000, [
      { label: 'Halfway', kind: 'milestone', percentBp: 5_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 5_000 },
    ]).map((stage) => ({ ...stage, invoiceId: null }))

    expect(recognisesDeposit(noDeposit, 1)).toBe(false)
  })

  it('earns it on the last stage of a deposit-plus-one contract', () => {
    // The smallest contract that can hold a deposit: one stage of work, so the
    // first milestone is also the last and recognition happens there.
    const two = scheduleAmounts(1_000_000, [
      { label: 'On signing', kind: 'deposit', percentBp: 3_000 },
      { label: 'On handover', kind: 'on-completion', percentBp: 7_000 },
    ]).map((stage, index) => ({ ...stage, invoiceId: index === 0 ? 'inv-1' : null }))

    expect(recognisesDeposit(two, 1)).toBe(true)
  })
})
