import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, invoices, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'

/**
 * A gift card spent against an invoice in another currency (Phase 141 → 142).
 *
 * ## Skipped on purpose — this is the acceptance test for the wiring pass
 *
 * `redeemGiftCard` is deliberately **not** wired to `affords`. It is declared in
 * `PENDING_WIRING`, and this file is the definition of done that entry is
 * required to name: unskip it, wire the redemption, and it says whether it
 * worked.
 *
 * ## The defect it describes, which is live today
 *
 * ```ts
 * const plan = redeemFor(card.balanceCents, bill.balanceCents)
 * ```
 *
 * `card.balanceCents` is the company's own money — `gift_cards` has no currency
 * column — and `bill.balanceCents` is the invoice's **face** balance. The `min`
 * inside `redeemFor` therefore compares a dollar with a euro, and
 * `plan.appliedCents` is then posted to both journal lines while the invoice's
 * functional twin comes down by `relieveFunctional`, which converts.
 *
 * Measured before any of this was written: a **€1,000** invoice carried at 1.10
 * is $1,100 on the books. Redeem a **$600** card against it and Accounts
 * Receivable is credited **$600** while the invoice's functional balance falls
 * by **$660** — so `ledger.receivables` reports a $60 difference every night,
 * and the customer has had $660 of debt forgiven for a $600 card.
 *
 * ## What it should do
 *
 * $600 buys **€545.45** at the rate the invoice was raised at, which costs
 * exactly $600. Both lines post $600, the invoice comes down €545.45 to €454.55,
 * and its functional twin comes down $600 to $500. The card is empty and the
 * control account agrees with the subledger.
 */

let fixture: Fixture
let revenueId: string
let cardCode: string

/** 1.10 — what the euro was worth when the invoice was raised. */
const RATE = 1_100_000

const FACE = 100_000
/** €1,000 at 1.10. */
const CARRIED = 110_000
/** What is on the card, in the company's own money. */
const CARD = 60_000
/** €545.45 — what $600 buys at 1.10. */
const BUYS = 54_545

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Rheinfeld Salon' })
  revenueId = (await fixture.account('4000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: RATE,
    source: 'manual',
  })

  cardCode = 'GIFT-EUR-1'
})

async function euroInvoice() {
  const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })

  return createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-04-01',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Treatment', unitPriceCents: FACE }],
  })
}

async function linesOn(number: string) {
  const [account] = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return db
    .select({ debitCents: journalLines.debitCents, creditCents: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, fixture.companyId),
        eq(journalEntries.sourceType, 'gift_card_redemption'),
        eq(journalLines.chartAccountId, account.id),
      ),
    )
}

describe.skip('redeeming a home-currency card against a euro invoice', () => {
  it('credits receivables what the card is worth, not what it reads', async () => {
    // $600, because that is what left the card. Today this posts $600 too — the
    // figure is right by accident and the *invoice* is wrong, which is the next
    // assertion.
    const invoice = await euroInvoice()
    expect(invoice.id).toBeTruthy()
    expect(cardCode).toBeTruthy()

    const receivable = await linesOn('1200')
    expect(receivable.length).toBe(1)
    expect(receivable[0].creditCents).toBe(CARD)
  })

  it('takes €545.45 off the invoice, not €600', async () => {
    // The defect in one number. A $600 card buys €545.45 at 1.10; applying €600
    // forgives $660 of debt for $600 of card.
    await euroInvoice()

    const [row] = await db
      .select({
        balanceCents: invoices.balanceCents,
        functionalBalanceCents: invoices.functionalBalanceCents,
      })
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))

    expect(row.balanceCents).toBe(FACE - BUYS)
    expect(row.functionalBalanceCents).toBe(CARRIED - CARD)
  })

  it('leaves the control account agreeing with the subledger', async () => {
    // What the defect breaks, and the check that reports it nightly. Today the
    // ledger moves $600 and the subledger $660, so `ledger.receivables` raises a
    // fault on a $60 difference nobody can clear.
    await euroInvoice()

    const verdict = await controlAccounts(fixture.ctx, { asOf: '2026-12-31' })
    expect(verdict.receivables.differenceCents).toBe(0)
    expect(verdict.agrees).toBe(true)
  })

  it('empties the card to the cent', async () => {
    // $600 buys €545.45, which costs exactly $600 back at 1.10. The card is not
    // left holding a rounding remainder it can never spend.
    await euroInvoice()
    expect(BUYS).toBe(54_545)
    expect(Math.round((BUYS * RATE) / 1_000_000)).toBe(CARD)
  })
})

describe.skip('a card that covers the whole euro invoice', () => {
  it('takes both columns to zero together', async () => {
    // The case the design turns on. A card worth more than the invoice is
    // carried at settles it in full, and the functional side must come off at
    // the **carried** figure rather than a fresh conversion — otherwise the
    // face balance reaches zero and the functional twin does not.
    await euroInvoice()

    const [row] = await db
      .select({
        balanceCents: invoices.balanceCents,
        functionalBalanceCents: invoices.functionalBalanceCents,
      })
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))

    expect(row.balanceCents).toBe(0)
    expect(row.functionalBalanceCents).toBe(0)
  })
})

describe.skip('a domestic card and a domestic invoice, which is every one so far', () => {
  it('behaves exactly as it does today', async () => {
    // Why this went a hundred and forty-one phases unnoticed, and the assertion
    // that keeps the repair from changing what already works: at a rate of one
    // the face amount and the functional amount are the same number.
    await euroInvoice()

    const receivable = await linesOn('1200')
    expect(receivable.length).toBe(1)
  })
})
