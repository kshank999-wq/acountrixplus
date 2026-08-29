import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATEMENT_POLICY,
  clampDayOfMonth,
  hasSomethingToSay,
  isRunDay,
  planStatements,
  statementVerdict,
  STATEMENT_REFUSAL_LABELS,
  type StatementCandidate,
  type StatementPolicy,
} from '@/modules/receivables/statement-runs'

/**
 * Who is due a statement this month (Phase 57).
 *
 * The claim under test: **a statement run goes out on a day somebody chose, to
 * customers who have something to be told, once per period** — and every
 * customer it skips has a reason a person can read.
 */

const on: StatementPolicy = { ...DEFAULT_STATEMENT_POLICY, enabled: true, dayOfMonth: 1 }

function candidate(over: Partial<StatementCandidate> = {}): StatementCandidate {
  return {
    customerId: 'c1',
    customerName: 'Meridian Facilities Ltd',
    balanceCents: 90_000,
    heldCreditCents: 0,
    customerEmail: 'ap@meridian.test',
    lastSentDate: null,
    ...over,
  }
}

const verdictFor = (over: Partial<StatementCandidate> = {}, policy = on, asOf = '2026-07-01') =>
  statementVerdict({ candidate: candidate(over), policy, asOf })

describe('the policy is off until somebody says otherwise', () => {
  /**
   * The most important assertion in the phase, and the same one Phase 43 makes:
   * this emails people who are not users of the system, over a company's name,
   * with nobody present.
   */
  it('defaults to off', () => {
    expect(DEFAULT_STATEMENT_POLICY.enabled).toBe(false)
  })

  it('sends nothing at all while it is off', () => {
    const verdict = verdictFor({}, { ...on, enabled: false })

    expect(verdict).toEqual({ send: false, reason: 'policy_off' })
  })
})

describe('the day it runs', () => {
  it('goes out on the day the policy names', () => {
    expect(isRunDay({ dayOfMonth: 1 }, '2026-07-01')).toBe(true)
    expect(isRunDay({ dayOfMonth: 15 }, '2026-07-15')).toBe(true)
  })

  it('does nothing on any other day', () => {
    expect(verdictFor({}, on, '2026-07-02')).toEqual({ send: false, reason: 'not_the_day' })
  })

  /**
   * "The 31st" does not exist in seven months of the year. A schedule that
   * silently skips February is worse than one that runs on the 28th.
   */
  it('holds the day inside a range every month has', () => {
    expect(clampDayOfMonth(31)).toBe(28)
    expect(clampDayOfMonth(0)).toBe(1)
    expect(clampDayOfMonth(-4)).toBe(1)
    expect(clampDayOfMonth(15)).toBe(15)
  })

  it('runs on the 28th for a policy that asked for the 31st', () => {
    expect(isRunDay({ dayOfMonth: 31 }, '2026-02-28')).toBe(true)
    expect(isRunDay({ dayOfMonth: 31 }, '2026-01-31')).toBe(false)
  })
})

describe('having something to say', () => {
  it('is true when they owe something', () => {
    expect(hasSomethingToSay({ balanceCents: 90_000, heldCreditCents: 0 })).toBe(true)
  })

  /**
   * The substance of the phase's inclusion rule, and Phase 54's argument
   * applied to a schedule: a customer who owes nothing but whose money the
   * business is holding is owed either a refund or an application, and only the
   * business knows it.
   */
  it('is true when the business is holding their money, even owing nothing', () => {
    expect(hasSomethingToSay({ balanceCents: 0, heldCreditCents: 60_000 })).toBe(true)
  })

  it('is false when there is nothing either way', () => {
    expect(hasSomethingToSay({ balanceCents: 0, heldCreditCents: 0 })).toBe(false)
  })

  it('refuses a customer with a clean account', () => {
    expect(verdictFor({ balanceCents: 0 })).toEqual({ send: false, reason: 'nothing_to_say' })
  })
})

describe('the floor', () => {
  it('skips a trivial balance', () => {
    expect(verdictFor({ balanceCents: 200 })).toEqual({ send: false, reason: 'too_small' })
  })

  it('sends one exactly at the floor', () => {
    expect(verdictFor({ balanceCents: 500 }).send).toBe(true)
  })

  /**
   * The floor stops trivial *demands*. Money the business is holding is not a
   * demand, so it is exempt — a customer owed $6 should still be told.
   */
  it('does not apply to held credit', () => {
    expect(verdictFor({ balanceCents: 0, heldCreditCents: 600 }).send).toBe(true)
  })

  it('does not apply when a small balance sits beside held credit', () => {
    expect(verdictFor({ balanceCents: 200, heldCreditCents: 600 }).send).toBe(true)
  })
})

describe('where it would go', () => {
  it('refuses a customer with no address', () => {
    expect(verdictFor({ customerEmail: null })).toEqual({ send: false, reason: 'no_email' })
  })

  it('refuses an address that is only whitespace', () => {
    expect(verdictFor({ customerEmail: '   ' })).toEqual({ send: false, reason: 'no_email' })
  })
})

describe('once per period', () => {
  /**
   * A daily worker must not send thirty statements a month. Phase 37's rule in
   * its own words: a period is billed exactly once.
   */
  it('holds one sent inside the quiet window', () => {
    expect(verdictFor({ lastSentDate: '2026-06-20' })).toEqual({
      send: false,
      reason: 'sent_recently',
    })
  })

  it('sends once the quiet window has passed', () => {
    expect(verdictFor({ lastSentDate: '2026-06-01' }).send).toBe(true)
  })

  /**
   * Counted from the last *send*, not the last run — so a statement somebody
   * sent by hand on the 29th stops the run sending another on the 1st.
   */
  it('counts a manual send too', () => {
    expect(verdictFor({ lastSentDate: '2026-06-29' }, on, '2026-07-01').send).toBe(false)
  })

  it('sends to somebody who has never had one', () => {
    expect(verdictFor({ lastSentDate: null }).send).toBe(true)
  })
})

describe('planning a whole book', () => {
  it('splits what goes from what does not, with a reason each', () => {
    const plan = planStatements({
      candidates: [
        candidate({ customerId: 'a', balanceCents: 90_000 }),
        candidate({ customerId: 'b', balanceCents: 0, heldCreditCents: 0 }),
        candidate({ customerId: 'c', balanceCents: 50_000, customerEmail: null }),
        candidate({ customerId: 'd', balanceCents: 100, heldCreditCents: 0 }),
      ],
      policy: on,
      asOf: '2026-07-01',
    })

    expect(plan.due.map((row) => row.candidate.customerId)).toEqual(['a'])
    expect(plan.held.map((row) => row.reason).sort()).toEqual([
      'no_email',
      'nothing_to_say',
      'too_small',
    ])
    expect(plan.heldCounts.no_email).toBe(1)
    expect(plan.heldCounts.nothing_to_say).toBe(1)
  })

  /**
   * Largest first, because a cap is about to cut this list and the statements
   * worth sending most are the ones with the most money on them.
   */
  it('puts the biggest debts first', () => {
    const plan = planStatements({
      candidates: [
        candidate({ customerId: 'small', balanceCents: 10_000 }),
        candidate({ customerId: 'big', balanceCents: 900_000 }),
        candidate({ customerId: 'middle', balanceCents: 50_000 }),
      ],
      policy: on,
      asOf: '2026-07-01',
    })

    expect(plan.due.map((row) => row.candidate.customerId)).toEqual(['big', 'middle', 'small'])
  })

  it('counts every reason, including the zeroes', () => {
    const plan = planStatements({ candidates: [], policy: on, asOf: '2026-07-01' })

    expect(Object.keys(plan.heldCounts).sort()).toEqual(
      Object.keys(STATEMENT_REFUSAL_LABELS).sort(),
    )
    expect(Object.values(plan.heldCounts).every((n) => n === 0)).toBe(true)
  })

  /**
   * Off is the answer for every row, not a mixture — the preview should say
   * "this is switched off" once, not "no email address" four hundred times.
   */
  it('says the same thing about everybody when the policy is off', () => {
    const plan = planStatements({
      candidates: [candidate({ customerId: 'a' }), candidate({ customerId: 'b', balanceCents: 0 })],
      policy: { ...on, enabled: false },
      asOf: '2026-07-01',
    })

    expect(plan.due).toHaveLength(0)
    expect(plan.held.every((row) => row.reason === 'policy_off')).toBe(true)
  })

  /**
   * The day is a scheduling question; everything after it is an eligibility
   * one. The preview wants only the second, and forcing `dayOfMonth` to today
   * is *not* equivalent to skipping the check — `isRunDay` clamps to 28, so on
   * the 29th, 30th and 31st a forced day never matches. Browser verification
   * found exactly that, on the 29th.
   */
  it('can be asked to ignore the day, and still applies every other rule', () => {
    const plan = planStatements({
      candidates: [
        candidate({ customerId: 'owes' }),
        candidate({ customerId: 'nothing', balanceCents: 0 }),
      ],
      policy: on,
      // The 29th: a day `clampDayOfMonth` can never return.
      asOf: '2026-07-29',
      ignoreRunDay: true,
    })

    expect(plan.due.map((row) => row.candidate.customerId)).toEqual(['owes'])
    expect(plan.held.map((row) => row.reason)).toEqual(['nothing_to_say'])
  })

  it('still refuses everybody on the 29th when the day is not ignored', () => {
    const plan = planStatements({
      candidates: [candidate()],
      policy: on,
      asOf: '2026-07-29',
    })

    expect(plan.due).toHaveLength(0)
    expect(plan.held[0].reason).toBe('not_the_day')
  })

  /** Ignoring the day does not ignore the switch. */
  it('still says switched off when it is off, day ignored or not', () => {
    const plan = planStatements({
      candidates: [candidate()],
      policy: { ...on, enabled: false },
      asOf: '2026-07-29',
      ignoreRunDay: true,
    })

    expect(plan.held[0].reason).toBe('policy_off')
  })

  it('has a sentence for every refusal it can produce', () => {
    for (const label of Object.values(STATEMENT_REFUSAL_LABELS)) {
      expect(label.length).toBeGreaterThan(0)
    }
  })
})
