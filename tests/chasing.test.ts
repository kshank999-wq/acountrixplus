import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHASE_POLICY,
  chaseVerdict,
  daysBetween,
  nextChaseDate,
  planChases,
  REFUSAL_LABELS,
  type ChaseableInvoice,
  type ChasePolicy,
} from '@/modules/receivables/chasing'

/**
 * When an overdue invoice gets chased (Phase 43).
 *
 * The two expensive wrong answers are chasing something already settled and
 * chasing daily, so most of what is asserted here is the machine declining to
 * send. A chase that does not go out costs a day; one that goes out to somebody
 * who paid last week costs the customer's belief in every figure after it.
 */

const on: ChasePolicy = { ...DEFAULT_CHASE_POLICY, enabled: true }

/**
 * Domestic by default, so what the customer was invoiced and what it is worth
 * to us are the same number — and stay the same when a test overrides the
 * balance. A foreign invoice overrides both (Phase 61).
 */
const invoice = (over: Partial<ChaseableInvoice> = {}): ChaseableInvoice => {
  const balanceCents = over.balanceCents ?? 120_000
  return {
    id: 'inv-1',
    number: 'INV-1001',
    status: 'open',
    dueDate: '2026-03-31',
    balanceCents,
    functionalBalanceCents: balanceCents,
    sentAt: '2026-03-01',
    sendCount: 1,
    lastPaymentDate: null,
    customerEmail: 'ap@harborview.test',
    ...over,
  }
}

describe('daysBetween', () => {
  it('counts whole days forward', () => {
    expect(daysBetween('2026-03-01', '2026-03-08')).toBe(7)
  })

  it('goes negative when the second date is earlier', () => {
    expect(daysBetween('2026-03-08', '2026-03-01')).toBe(-7)
  })

  it('crosses a month and a leap day without drifting', () => {
    expect(daysBetween('2028-02-27', '2028-03-01')).toBe(3)
  })

  /**
   * Parsed as UTC on purpose. A date arithmetic that respects the server's
   * timezone chases a day early for half the world.
   */
  it('is not moved by the hour of the day', () => {
    expect(daysBetween('2026-03-01', '2026-03-02')).toBe(1)
  })

  it('gives up quietly on something that is not a date', () => {
    expect(daysBetween('never', '2026-03-01')).toBe(0)
  })
})

describe('chaseVerdict — what is never chased', () => {
  it('sends nothing at all while the policy is off', () => {
    // The default. Nothing goes to a customer because a deployment happened.
    const verdict = chaseVerdict({ invoice: invoice(), policy: DEFAULT_CHASE_POLICY, asOf: '2026-06-01' })
    expect(verdict).toEqual({ chase: false, reason: 'policy_off' })
  })

  /**
   * The assertion this whole module exists to make. A customer who paid and
   * then gets a demand stops believing the next figure too.
   */
  it('never chases an invoice with nothing outstanding', () => {
    const verdict = chaseVerdict({
      invoice: invoice({ balanceCents: 0, status: 'open' }),
      policy: on,
      asOf: '2026-09-01',
    })
    expect(verdict).toEqual({ chase: false, reason: 'settled' })
  })

  it('never chases a paid, void, draft or written-off invoice', () => {
    for (const status of ['paid', 'void', 'draft', 'written_off']) {
      const verdict = chaseVerdict({ invoice: invoice({ status }), policy: on, asOf: '2026-09-01' })
      expect(verdict).toEqual({ chase: false, reason: 'not_open' })
    }
  })

  it('never chases one the customer was never sent', () => {
    // You cannot remind somebody of something you never told them.
    const verdict = chaseVerdict({
      invoice: invoice({ sentAt: null, sendCount: 0 }),
      policy: on,
      asOf: '2026-09-01',
    })
    expect(verdict).toEqual({ chase: false, reason: 'never_sent' })
  })

  /**
   * Checked here rather than left to the send, so a preview cannot list an
   * invoice as going out today and then quietly not send it.
   */
  it('never chases a customer it has no address for', () => {
    // Reachable: somebody shared the link by hand, so `sentAt` is set while
    // the customer record still has no email.
    for (const email of [null, '', '   ']) {
      expect(chaseVerdict({ invoice: invoice({ customerEmail: email }), policy: on, asOf: '2026-09-01' })).toEqual({
        chase: false,
        reason: 'no_address',
      })
    }
  })

  it('leaves a balance too small to be worth an email', () => {
    const verdict = chaseVerdict({ invoice: invoice({ balanceCents: 199 }), policy: on, asOf: '2026-09-01' })
    expect(verdict).toEqual({ chase: false, reason: 'too_small' })
  })

  it('buys quiet with a recent payment', () => {
    // Somebody who part-paid yesterday has engaged. Chasing the next morning
    // reads as not having noticed.
    const verdict = chaseVerdict({
      invoice: invoice({ status: 'partial', balanceCents: 40_000, lastPaymentDate: '2026-08-30' }),
      policy: on,
      asOf: '2026-09-01',
    })
    expect(verdict).toEqual({ chase: false, reason: 'just_paid' })
  })

  it('resumes once the quiet period is over', () => {
    const verdict = chaseVerdict({
      invoice: invoice({ status: 'partial', balanceCents: 40_000, lastPaymentDate: '2026-08-20' }),
      policy: on,
      asOf: '2026-09-01',
    })
    expect(verdict.chase).toBe(true)
  })

  /**
   * The refusal reported is the most useful one. An invoice that is both
   * settled and not yet due says `settled`, because that is the fact somebody
   * reading the preview needs.
   */
  it('reports the reason it is wrong to chase before the reason it is early', () => {
    const verdict = chaseVerdict({
      invoice: invoice({ balanceCents: 0, dueDate: '2027-01-01' }),
      policy: on,
      asOf: '2026-04-05',
    })
    expect(verdict).toEqual({ chase: false, reason: 'settled' })
  })
})

describe('chaseVerdict — timing', () => {
  it('waits out the grace days after the due date', () => {
    const base = { invoice: invoice(), policy: on }

    // Due 31 March, first chase after three days.
    expect(chaseVerdict({ ...base, asOf: '2026-03-31' })).toEqual({
      chase: false,
      reason: 'not_due_yet',
    })
    expect(chaseVerdict({ ...base, asOf: '2026-04-02' })).toEqual({
      chase: false,
      reason: 'not_due_yet',
    })
    expect(chaseVerdict({ ...base, asOf: '2026-04-03' })).toEqual({
      chase: true,
      stage: 1,
      daysOverdue: 3,
    })
  })

  it('chases the day it falls due when the policy says zero', () => {
    const verdict = chaseVerdict({
      invoice: invoice(),
      policy: { ...on, firstAfterDays: 0 },
      asOf: '2026-03-31',
    })
    expect(verdict).toEqual({ chase: true, stage: 1, daysOverdue: 0 })
  })

  it('holds its tongue between chases', () => {
    // One chase already sent (sendCount 2: the original plus one chase).
    const chased = invoice({ sendCount: 2 })

    expect(chaseVerdict({ invoice: chased, policy: on, asOf: '2026-04-10' })).toEqual({
      chase: false,
      reason: 'too_soon',
    })
    expect(chaseVerdict({ invoice: chased, policy: on, asOf: '2026-04-17' })).toEqual({
      chase: true,
      stage: 2,
      daysOverdue: 17,
    })
  })

  /**
   * The cadence is measured from the due date, not from the last send. A worker
   * that misses Tuesday catches up on Wednesday instead of sliding the whole
   * schedule a day later every time something goes wrong.
   */
  it('catches up rather than sliding when a day is missed', () => {
    const chased = invoice({ sendCount: 2 })

    // Due on day 17. The run did not happen until day 19; it still goes,
    // and the next one is still anchored to the due date.
    expect(chaseVerdict({ invoice: chased, policy: on, asOf: '2026-04-19' })).toEqual({
      chase: true,
      stage: 2,
      daysOverdue: 19,
    })
    expect(nextChaseDate({ invoice: { ...chased, sendCount: 3 }, policy: on })).toBe('2026-05-01')
  })

  /**
   * The defect the run caught, pinned here.
   *
   * A company switches chasing on with a year of unpaid invoices behind it.
   * Every anchored date for every stage is already in the past, so on the
   * anchor alone the first run sends chase one, the next sends chase two, and
   * a sequence meant to take six weeks arrives in three minutes. The gap since
   * the last send is what stops it.
   */
  it('does not fire the whole sequence at once on a long-overdue invoice', () => {
    const ancient = invoice({ dueDate: '2025-01-01' })

    // Chase one goes out today, five hundred days late.
    expect(chaseVerdict({ invoice: ancient, policy: on, asOf: '2026-06-01' })).toMatchObject({
      chase: true,
      stage: 1,
    })

    // The send stamped today's date and moved the count. Tomorrow's run is
    // past every anchor and still says nothing.
    const chased = { ...ancient, sendCount: 2, sentAt: '2026-06-01' }
    expect(chaseVerdict({ invoice: chased, policy: on, asOf: '2026-06-02' })).toEqual({
      chase: false,
      reason: 'too_soon',
    })
    expect(chaseVerdict({ invoice: chased, policy: on, asOf: '2026-06-15' })).toMatchObject({
      chase: true,
      stage: 2,
    })
  })

  it('re-running the same day sends nothing the second time', () => {
    // The scheduler promises at least once, so this happens rather than might.
    const sentToday = invoice({ dueDate: '2026-01-01', sendCount: 2, sentAt: '2026-06-01' })
    expect(chaseVerdict({ invoice: sentToday, policy: on, asOf: '2026-06-01' })).toEqual({
      chase: false,
      reason: 'too_soon',
    })
  })

  it('ends the sequence at the ceiling and leaves it to a person', () => {
    // Three chases sent: the original plus three.
    const exhausted = invoice({ sendCount: 4 })
    expect(chaseVerdict({ invoice: exhausted, policy: on, asOf: '2027-01-01' })).toEqual({
      chase: false,
      reason: 'enough_already',
    })
  })

  it('counts the first send as a send, not as a chase', () => {
    // sendCount 1 means it has been sent once and never chased, so the next
    // letter is chase one.
    expect(chaseVerdict({ invoice: invoice({ sendCount: 1 }), policy: on, asOf: '2026-04-03' })).toEqual({
      chase: true,
      stage: 1,
      daysOverdue: 3,
    })
  })

  it('does not run off the end when the count is somehow lower than the sends', () => {
    // A row written before Phase 42's counter existed has sentAt and no count.
    expect(chaseVerdict({ invoice: invoice({ sendCount: 0 }), policy: on, asOf: '2026-04-03' })).toEqual({
      chase: true,
      stage: 1,
      daysOverdue: 3,
    })
  })

  it('walks a whole sequence to its end', () => {
    const stages: Array<{ asOf: string; sendCount: number }> = [
      { asOf: '2026-04-03', sendCount: 1 },
      { asOf: '2026-04-17', sendCount: 2 },
      { asOf: '2026-05-01', sendCount: 3 },
    ]

    stages.forEach((step, index) => {
      const verdict = chaseVerdict({
        invoice: invoice({ sendCount: step.sendCount }),
        policy: on,
        asOf: step.asOf,
      })
      expect(verdict).toMatchObject({ chase: true, stage: index + 1 })
    })

    expect(
      chaseVerdict({ invoice: invoice({ sendCount: 4 }), policy: on, asOf: '2026-05-15' }),
    ).toEqual({ chase: false, reason: 'enough_already' })
  })
})

describe('planChases', () => {
  const invoices: ChaseableInvoice[] = [
    invoice({ id: 'a', number: 'INV-1', dueDate: '2026-04-01' }),
    invoice({ id: 'b', number: 'INV-2', dueDate: '2026-01-01' }),
    invoice({ id: 'c', number: 'INV-3', status: 'paid' }),
    invoice({ id: 'd', number: 'INV-4', sentAt: null, sendCount: 0 }),
    invoice({ id: 'e', number: 'INV-5', dueDate: '2027-01-01' }),
  ]

  it('splits what goes out from what does not, with a reason for each', () => {
    const plan = planChases({ invoices, policy: on, asOf: '2026-06-01' })

    expect(plan.due.map((row) => row.invoice.id)).toEqual(['b', 'a'])
    expect(plan.held.map((row) => row.reason).sort()).toEqual(['never_sent', 'not_due_yet', 'not_open'])
  })

  it('puts the oldest debt first, because a capped run should send those', () => {
    const plan = planChases({ invoices, policy: on, asOf: '2026-06-01' })
    expect(plan.due[0]?.invoice.number).toBe('INV-2')
    expect(plan.due[0]!.daysOverdue).toBeGreaterThan(plan.due[1]!.daysOverdue)
  })

  it('counts the refusals so a screen can say "14 are not due yet"', () => {
    const plan = planChases({ invoices, policy: on, asOf: '2026-06-01' })

    expect(plan.heldCounts.not_open).toBe(1)
    expect(plan.heldCounts.never_sent).toBe(1)
    expect(plan.heldCounts.not_due_yet).toBe(1)
    expect(plan.heldCounts.settled).toBe(0)
  })

  it('holds everything, with a reason, while the policy is off', () => {
    const plan = planChases({ invoices, policy: DEFAULT_CHASE_POLICY, asOf: '2026-06-01' })

    expect(plan.due).toHaveLength(0)
    expect(plan.heldCounts.policy_off).toBe(invoices.length)
  })

  it('has a label for every reason it can give', () => {
    // A screen that renders a raw enum is a screen nobody trusts enough to
    // switch this on.
    const plan = planChases({ invoices, policy: on, asOf: '2026-06-01' })
    for (const row of plan.held) {
      expect(REFUSAL_LABELS[row.reason]).toBeTruthy()
    }
  })

  it('copes with nothing to do', () => {
    const plan = planChases({ invoices: [], policy: on, asOf: '2026-06-01' })
    expect(plan.due).toEqual([])
    expect(plan.held).toEqual([])
    expect(plan.heldCounts.too_soon).toBe(0)
  })
})

describe('nextChaseDate', () => {
  it('names the day the first chase falls due', () => {
    expect(nextChaseDate({ invoice: invoice(), policy: on })).toBe('2026-04-03')
  })

  it('names the day the next one falls due after that', () => {
    expect(nextChaseDate({ invoice: invoice({ sendCount: 2 }), policy: on })).toBe('2026-04-17')
  })

  it('answers null when there will never be one', () => {
    expect(nextChaseDate({ invoice: invoice(), policy: DEFAULT_CHASE_POLICY })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ status: 'void' }), policy: on })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ balanceCents: 0 }), policy: on })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ sentAt: null }), policy: on })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ customerEmail: null }), policy: on })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ sendCount: 4 }), policy: on })).toBeNull()
    expect(nextChaseDate({ invoice: invoice({ balanceCents: 100 }), policy: on })).toBeNull()
  })

  /**
   * A date already past is the honest answer: it says the chase is owed now,
   * which is what the preview should show rather than inventing a future day.
   */
  it('gives a date in the past when one is already owed', () => {
    // Due 1 January, and the letter went out on 1 March. Three days after the
    // letter, not three days after the due date — the second is a day the run
    // would refuse, and a preview naming it would be lying.
    expect(nextChaseDate({ invoice: invoice({ dueDate: '2026-01-01' }), policy: on })).toBe('2026-03-04')
  })

  it('never names a day before the last letter has had its silence', () => {
    const justSent = invoice({ dueDate: '2025-01-01', sentAt: '2026-06-01', sendCount: 2 })
    expect(nextChaseDate({ invoice: justSent, policy: on })).toBe('2026-06-15')
  })
})
