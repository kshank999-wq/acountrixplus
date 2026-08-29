import { describe, expect, it } from 'vitest'
import {
  chaseableAgainstCredit,
  describeNet,
  netPosition,
} from '@/modules/receivables/net-position'

/**
 * What a customer actually owes (Phase 54).
 *
 * The claim under test: **a customer whose money the business is holding is
 * not chased for money, and is not sent a statement claiming the gross.**
 * Phase 53 created held credit and left both blind to it.
 */

describe('netting held credit against what is owed', () => {
  it('leaves an ordinary debt alone', () => {
    const position = netPosition({ owedCents: 90_000, heldCents: 0 })

    expect(position.dueCents).toBe(90_000)
    expect(position.ourDebtCents).toBe(0)
    expect(position.stance).toBe('owes_us')
  })

  it('reduces what is due by what is held', () => {
    const position = netPosition({ owedCents: 90_000, heldCents: 60_000 })

    expect(position.dueCents).toBe(30_000)
    expect(position.stance).toBe('owes_us')
  })

  it('reads as square when the credit covers it exactly', () => {
    const position = netPosition({ owedCents: 60_000, heldCents: 60_000 })

    expect(position.dueCents).toBe(0)
    expect(position.ourDebtCents).toBe(0)
    expect(position.stance).toBe('square')
  })

  /**
   * Clamped rather than allowed to go negative: "what should this customer
   * pay" has no negative answer. The fact that the balance runs the other way
   * is carried by `stance` and `ourDebtCents`.
   */
  it('never asks for a negative amount', () => {
    const position = netPosition({ owedCents: 40_000, heldCents: 100_000 })

    expect(position.dueCents).toBe(0)
    expect(position.ourDebtCents).toBe(60_000)
    expect(position.stance).toBe('we_owe')
  })

  it('reads as we_owe when there is nothing owed at all', () => {
    const position = netPosition({ owedCents: 0, heldCents: 50_000 })

    expect(position.stance).toBe('we_owe')
    expect(position.ourDebtCents).toBe(50_000)
  })

  it('reads as square when there is nothing either way', () => {
    expect(netPosition({ owedCents: 0, heldCents: 0 }).stance).toBe('square')
  })

  it('treats nonsense as nothing rather than propagating it', () => {
    const position = netPosition({ owedCents: -500, heldCents: -200 })
    expect(position).toMatchObject({ owedCents: 0, heldCents: 0, dueCents: 0, stance: 'square' })
  })
})

describe('whether a chase may go out', () => {
  it('allows one when nothing is held', () => {
    expect(chaseableAgainstCredit({ heldCents: 0 })).toBe(true)
  })

  /**
   * The substance of the phase. Phase 43's design is that these letters go out
   * *without anybody deciding again*, which is exactly what makes a wrong one
   * serious — the customer receives a demand for money the business is sitting
   * on.
   */
  it('refuses one while anything is held', () => {
    expect(chaseableAgainstCredit({ heldCents: 100 })).toBe(false)
  })

  /**
   * Decided on the customer's whole position rather than invoice by invoice.
   * A customer holding $600 with two $500 invoices owes $400 on net; chasing
   * the older one for its full $500 asks for more than is due, and chasing
   * neither would leave $400 uncollected for ever. So nothing goes out until
   * somebody decides where the credit belongs — which is a person's call.
   */
  it('refuses even when the credit is smaller than the invoice', () => {
    expect(chaseableAgainstCredit({ heldCents: 100 })).toBe(false)
  })
})

describe('telling the customer where they stand', () => {
  it('says what is due, plainly, when nothing is held', () => {
    const sentence = describeNet(netPosition({ owedCents: 90_000, heldCents: 0 }))
    expect(sentence).toBe('$900.00 is due.')
  })

  it('names the credit when it reduces the bill', () => {
    const sentence = describeNet(netPosition({ owedCents: 90_000, heldCents: 60_000 }))

    expect(sentence).toContain('$300.00 is due')
    expect(sentence).toContain('$600.00 we are holding')
  })

  it('says nothing is due when the credit covers it', () => {
    const sentence = describeNet(netPosition({ owedCents: 60_000, heldCents: 60_000 }))

    expect(sentence).toContain('Nothing is due')
    expect(sentence).toContain('covers what was owed')
  })

  /** And says so out loud when the business is the one in debt. */
  it('says what is still theirs when the business owes them', () => {
    const sentence = describeNet(netPosition({ owedCents: 40_000, heldCents: 100_000 }))

    expect(sentence).toContain('Nothing is due')
    expect(sentence).toContain('$600.00 of it is still yours')
  })

  it('is brief when there is nothing at all', () => {
    expect(describeNet(netPosition({ owedCents: 0, heldCents: 0 }))).toBe('Nothing is due.')
  })
})
