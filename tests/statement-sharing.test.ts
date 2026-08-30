import { describe, expect, it } from 'vitest'
import {
  customerFacingStatement,
  sendability,
  statementSubject,
  statementSummaryLine,
  type StatementFacts,
} from '@/modules/receivables/statement-sharing'

/**
 * What a customer holding a statement link may see (Phase 55).
 *
 * The claim under test: **a statement is a claim about a moment, and the
 * customer sees the moment it was frozen at.** Copying Phase 42's live invoice
 * page would have meant the two parties could never be looking at the same
 * document, which is the only job a statement has.
 */

const COMPANY = {
  name: 'Ridgeline Construction',
  email: 'accounts@ridgeline.test',
  phone: '555 0100',
  address: ['1 Quarry Road', 'Bellingham, WA 98225'],
  tradingName: null,
  website: null,
  footer: null,
}

const CUSTOMER = { name: 'Meridian Facilities Ltd', email: 'ap@meridian.test' }

function aStatement(over: Partial<StatementFacts> = {}): StatementFacts {
  return {
    kind: 'open_item',
    periodStart: null,
    asOfDate: '2026-06-30',
    openingBalanceCents: 0,
    closingBalanceCents: 90_000,
    heldCreditCents: 60_000,
    dueCents: 30_000,
    positionNote: '$300.00 is due, after the $600.00 we are holding for you.',
    sentAt: null,
    sendCount: 0,
    ...over,
  }
}

describe('what the customer is shown', () => {
  it('shows the figures as they were frozen, not as they are now', () => {
    const view = customerFacingStatement({
      statement: aStatement(),
      lines: [],
      customer: CUSTOMER,
      company: COMPANY,
      currency: 'USD',
    })

    expect(view.asOfDate).toBe('2026-06-30')
    expect(view.closingBalanceCents).toBe(90_000)
    expect(view.heldCreditCents).toBe(60_000)
    expect(view.dueCents).toBe(30_000)
    expect(view.isFrozen).toBe(true)
  })

  /**
   * The allowlist. A subtraction leaks by default: the next phase adds an
   * internal note to the frozen figures and it lands on a stranger's screen.
   */
  it('carries nothing it was not asked for', () => {
    const view = customerFacingStatement({
      statement: {
        ...aStatement(),
        // Whatever else a future phase freezes onto the row.
        ...({ internalNote: 'chase hard, they always pay late' } as object),
      } as StatementFacts,
      lines: [
        {
          date: '2026-01-01',
          kind: 'invoice',
          reference: 'INV-1001',
          description: 'Invoice INV-1001',
          amountCents: 90_000,
          runningBalanceCents: 90_000,
          ...({ costCodeId: 'secret', marginBp: 4200 } as object),
        },
      ],
      customer: CUSTOMER,
      company: COMPANY,
      currency: 'USD',
    })

    expect(view).not.toHaveProperty('internalNote')
    expect(view.lines[0]).not.toHaveProperty('costCodeId')
    expect(view.lines[0]).not.toHaveProperty('marginBp')
    expect(view.lines[0].reference).toBe('INV-1001')
  })

  /**
   * A statement saved before Phase 54 has no netting frozen on it. It meant the
   * gross when it was written, and it still means the gross.
   */
  it('reads an older statement as its gross', () => {
    const view = customerFacingStatement({
      statement: aStatement({
        heldCreditCents: undefined,
        dueCents: undefined,
        positionNote: undefined,
      }),
      lines: [],
      customer: CUSTOMER,
      company: COMPANY,
      currency: 'USD',
    })

    expect(view.heldCreditCents).toBe(0)
    expect(view.dueCents).toBe(90_000)
    expect(view.positionNote).toBeNull()
  })
})

describe('whether it may be sent', () => {
  it('sends to the address on file', () => {
    const verdict = sendability({ statement: aStatement(), customer: CUSTOMER })

    expect(verdict).toEqual({ ok: true, to: 'ap@meridian.test', isResend: false })
  })

  it('prefers an address typed into the form', () => {
    const verdict = sendability({
      statement: aStatement(),
      customer: CUSTOMER,
      override: 'someone.else@meridian.test',
    })

    expect(verdict.ok && verdict.to).toBe('someone.else@meridian.test')
  })

  /**
   * The refusal that mattered before this phase existed: a customer with no
   * address was silently given a `sent_to` of null and a screen that looked
   * like a send.
   */
  it('says who to add an address against', () => {
    const verdict = sendability({
      statement: aStatement(),
      customer: { name: 'Meridian Facilities Ltd', email: null },
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('Meridian Facilities Ltd')
    expect(verdict.ok === false && verdict.reason).toContain('Get link')
  })

  it('refuses a statement with nothing on it', () => {
    const verdict = sendability({
      statement: aStatement({ closingBalanceCents: 0, heldCreditCents: 0 }),
      customer: CUSTOMER,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('nothing on this statement')
  })

  /**
   * But a customer who owes nothing and whose money the business is holding
   * has something to be told — and it is the half they care about (Phase 54).
   */
  it('sends one that owes nothing but holds their money', () => {
    const verdict = sendability({
      statement: aStatement({ closingBalanceCents: 0, heldCreditCents: 60_000 }),
      customer: CUSTOMER,
    })

    expect(verdict.ok).toBe(true)
  })

  it('knows a resend from a first send', () => {
    const first = sendability({ statement: aStatement(), customer: CUSTOMER })
    const again = sendability({
      statement: aStatement({ sendCount: 1, sentAt: new Date('2026-07-01') }),
      customer: CUSTOMER,
    })

    expect(first.ok && first.isResend).toBe(false)
    expect(again.ok && again.isResend).toBe(true)
  })

  it('refuses something that is not an address', () => {
    const verdict = sendability({
      statement: aStatement(),
      customer: CUSTOMER,
      override: 'meridian.test',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('not an email address')
  })
})

describe('what the letter says', () => {
  it('names the date, because a statement is about a moment', () => {
    expect(
      statementSubject({
        companyName: 'Ridgeline Construction',
        asOfDate: '2026-06-30',
        isResend: false,
      }),
    ).toBe('Statement to 2026-06-30 from Ridgeline Construction')
  })

  it('says so when it has been sent before', () => {
    expect(
      statementSubject({
        companyName: 'Ridgeline Construction',
        asOfDate: '2026-06-30',
        isResend: true,
      }),
    ).toContain('(resent)')
  })

  /**
   * The covering line reads off the same netted figures the page shows. A
   * customer told one number in the email and another on the page rings up,
   * which is the outcome the phase exists to avoid.
   */
  it('leads with what is actually due, not the gross', () => {
    const line = statementSummaryLine({
      statement: { asOfDate: '2026-06-30', dueCents: 30_000, heldCreditCents: 60_000, currency: 'USD' },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('$300.00 due')
    expect(line).toContain('$600.00 we are holding')
    expect(line).not.toContain('$900.00')
  })

  it('says nothing is due when nothing is', () => {
    const line = statementSummaryLine({
      statement: { asOfDate: '2026-06-30', dueCents: 0, heldCreditCents: 0, currency: 'USD' },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('Nothing is due')
  })

  it('names the credit when that is the whole news', () => {
    const line = statementSummaryLine({
      statement: { asOfDate: '2026-06-30', dueCents: 0, heldCreditCents: 60_000, currency: 'USD' },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('Nothing is due')
    expect(line).toContain('$600.00 for you')
  })

  it('speaks the customer’s currency', () => {
    const line = statementSummaryLine({
      statement: { asOfDate: '2026-06-30', dueCents: 30_000, heldCreditCents: 0, currency: 'EUR' },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('€300.00')
  })
})
