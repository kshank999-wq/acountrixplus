import { describe, expect, it } from 'vitest'
import {
  APPROVAL_OFF,
  approvalState,
  describeHeld,
  mayApprove,
  payable,
  splitByApproval,
  type ApprovableBill,
  type ApprovalPolicy,
} from '@/modules/payables/approval'

/**
 * The payment nobody approved (Phase 50).
 *
 * The claim under test: **one person cannot create a supplier, bill it and pay
 * it.** With a single permission they could do all three, nothing recorded who
 * entered the bill, and Phase 49 turned the last step into one click across a
 * whole batch.
 */

const bill = (over: Partial<ApprovableBill> = {}): ApprovableBill => ({
  id: 'bill-1',
  number: 'BILL-1001',
  totalCents: 120_000,
  enteredBy: 'dana',
  approvedBy: null,
  ...over,
})

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  enabled: true,
  thresholdCents: 100_000,
  twoPersonRule: true,
  ...over,
})

describe('whether a bill needs approving', () => {
  /**
   * Off unless somebody turns it on. A sole trader is their own bookkeeper and
   * their own approver, and a system that ships this on has shipped a feature
   * most of its users must immediately switch off.
   */
  it('asks for nothing while approvals are switched off', () => {
    expect(approvalState(bill(), APPROVAL_OFF)).toBe('not_required')
    expect(payable(bill(), APPROVAL_OFF)).toBe(true)
  })

  it('asks for one at or above the threshold', () => {
    expect(approvalState(bill({ totalCents: 99_999 }), policy())).toBe('not_required')
    expect(approvalState(bill({ totalCents: 100_000 }), policy())).toBe('awaiting')
    expect(approvalState(bill({ totalCents: 100_001 }), policy())).toBe('awaiting')
  })

  /**
   * A threshold rather than all-or-nothing, because the point is attention and
   * attention is finite: a rule that stops the week for a £4 parking receipt
   * is a rule somebody approves without reading.
   */
  it('leaves the small ones alone', () => {
    expect(payable(bill({ totalCents: 400 }), policy())).toBe(true)
  })

  it('treats a threshold of zero as every bill', () => {
    expect(approvalState(bill({ totalCents: 1 }), policy({ thresholdCents: 0 }))).toBe('awaiting')
  })

  it('is settled once somebody has approved it', () => {
    expect(approvalState(bill({ approvedBy: 'priya' }), policy())).toBe('approved')
    expect(payable(bill({ approvedBy: 'priya' }), policy())).toBe(true)
  })

  /** Even with approvals off, an approval already given still reads as given. */
  it('does not forget an approval when the policy is switched off', () => {
    expect(approvalState(bill({ approvedBy: 'priya' }), APPROVAL_OFF)).toBe('approved')
  })
})

describe('who may approve', () => {
  /**
   * The substance of the phase. One person creating a supplier, billing it and
   * paying it is how money leaves a business without anybody noticing.
   */
  it('is not the person who entered it', () => {
    const verdict = mayApprove({ bill: bill({ enteredBy: 'dana' }), policy: policy(), actorId: 'dana' })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('somebody else has to approve it')
  })

  it('is anybody else', () => {
    expect(
      mayApprove({ bill: bill({ enteredBy: 'dana' }), policy: policy(), actorId: 'priya' }).ok,
    ).toBe(true)
  })

  /**
   * Separate from the threshold on purpose. A two-person business may want
   * "somebody must approve the big ones" without being able to honour "it may
   * not be the same somebody".
   */
  it('may be the same person when the two-person rule is off', () => {
    expect(
      mayApprove({
        bill: bill({ enteredBy: 'dana' }),
        policy: policy({ twoPersonRule: false }),
        actorId: 'dana',
      }).ok,
    ).toBe(true)
  })

  /**
   * A bill raised before Phase 50, or by the recurring-billing worker, has no
   * `enteredBy`. Refusing those would leave them unapprovable for ever, so the
   * rule has nothing to compare and stands aside.
   */
  it('allows a bill nobody is recorded as having entered', () => {
    expect(
      mayApprove({ bill: bill({ enteredBy: null }), policy: policy(), actorId: 'dana' }).ok,
    ).toBe(true)
  })

  it('refuses to approve one twice', () => {
    const verdict = mayApprove({
      bill: bill({ approvedBy: 'priya' }),
      policy: policy(),
      actorId: 'dana',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('already been approved')
  })

  it('says so when there is nothing to approve', () => {
    const off = mayApprove({ bill: bill(), policy: APPROVAL_OFF, actorId: 'priya' })
    expect(off.ok).toBe(false)
    expect(off.ok === false && off.why).toContain('switched off')

    const small = mayApprove({ bill: bill({ totalCents: 500 }), policy: policy(), actorId: 'priya' })
    expect(small.ok).toBe(false)
    expect(small.ok === false && small.why).toContain('below the amount')
  })
})

describe('a pay run meeting an unapproved bill', () => {
  /**
   * Held back, not refused. Somebody ticking eight bills of which one needs
   * approving should get the seven paid and be told about the eighth —
   * refusing the lot teaches them to switch approvals off, which is the
   * opposite of what the control is for.
   */
  it('pays the rest and holds the one back', () => {
    const split = splitByApproval(
      [
        bill({ id: 'a', number: 'BILL-1001', totalCents: 5_000 }),
        bill({ id: 'b', number: 'BILL-1002', totalCents: 500_000 }),
        bill({ id: 'c', number: 'BILL-1003', totalCents: 900_000, approvedBy: 'priya' }),
      ],
      policy(),
    )

    expect(split.payable.map((row) => row.id)).toEqual(['a', 'c'])
    expect(split.held.map((row) => row.id)).toEqual(['b'])
  })

  it('holds nothing back when approvals are off', () => {
    const split = splitByApproval([bill({ totalCents: 900_000 })], APPROVAL_OFF)
    expect(split.held).toHaveLength(0)
  })

  it('names what it held back and what that comes to', () => {
    const sentence = describeHeld([
      bill({ number: 'BILL-1002', totalCents: 500_000 }),
      bill({ number: 'BILL-1003', totalCents: 250_000 }),
    ])

    expect(sentence).toContain('2 bills')
    expect(sentence).toContain('7500.00')
    expect(sentence).toContain('BILL-1002, BILL-1003')
    expect(sentence).toContain('need approving')
  })

  it('reads correctly for a single bill', () => {
    const sentence = describeHeld([bill({ number: 'BILL-1002', totalCents: 500_000 })])
    expect(sentence).toContain('1 bill ')
    expect(sentence).toContain('was left out')
    expect(sentence).toContain('needs approving')
  })

  it('stops listing after three, and says how many more', () => {
    const sentence = describeHeld([
      bill({ number: 'A' }),
      bill({ number: 'B' }),
      bill({ number: 'C' }),
      bill({ number: 'D' }),
      bill({ number: 'E' }),
    ])

    expect(sentence).toContain('A, B, C and 2 more')
  })

  it('has nothing to say when nothing was held', () => {
    expect(describeHeld([])).toBeNull()
  })
})
