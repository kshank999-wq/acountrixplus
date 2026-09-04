import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { createDeposit, undepositedReceipts } from '@/modules/banking/deposits'
import { putRate } from '@/modules/fx/service'
import { messageFor } from '@/modules/errors'

/**
 * A paying-in slip is in one currency (Phase 123).
 *
 * `createDeposit` summed `payments.amount_cents` across the receipts being
 * banked and debited the bank with the total. `payments.amount_cents` is the
 * face amount, and the one face column with **no functional twin at all** —
 * Phase 122 named it "the easiest to add up by mistake" and then could not see
 * this one, because the addition is a `reduce` and its scanner read `sum()`.
 *
 * So a €500 and a $500 receipt banked together debited the bank "1000" and
 * credited Undeposited Funds "1000", in company currency, and
 * `banking.cash_tie_out` reported a difference the next morning with nothing
 * to trace it back to.
 */

let fixture: Fixture
let bankId: string
let customerId: string
let revenueId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Deposits Co' })
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '1188',
    })
  ).id
  customerId = (await createCustomer(fixture.ctx, { name: 'Harborview LLC' })).id
  revenueId = (await fixture.account('4000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-08-01',
    rateMillionths: 1_083_500,
    source: 'manual',
  })
})

/**
 * A receipt held in Undeposited Funds — no `financialAccountId` given.
 *
 * A payment takes its currency from the documents it settles (`documentCurrency`),
 * not from an argument, so a foreign receipt means a foreign invoice to settle.
 * Applying and banking are orthogonal: the receipt clears the invoice on the AR
 * side while the cash still waits in Undeposited Funds for a paying-in slip.
 */
async function held(amountCents: number, currency?: string) {
  const invoice = await createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-08-01',
    dueDate: '2026-09-01',
    ...(currency ? { currency } : {}),
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: amountCents }],
  })

  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-08-15',
    amountCents,
    applications: [{ invoiceId: invoice.id, amountCents }],
  })
}

describe('banking receipts that are not in one currency', () => {
  it('refuses, rather than banking a total in no currency', async () => {
    const dollars = await held(50_000)
    const euros = await held(50_000, 'EUR')

    await expect(
      createDeposit(fixture.ctx, {
        financialAccountId: bankId,
        depositDate: '2026-08-16',
        items: [{ paymentId: dollars.id }, { paymentId: euros.id }],
      }),
    ).rejects.toThrow(/EUR and USD/)
  })

  it('says it in a sentence a person can act on', async () => {
    const dollars = await held(50_000)
    const euros = await held(50_000, 'EUR')

    const error = await createDeposit(fixture.ctx, {
      financialAccountId: bankId,
      depositDate: '2026-08-16',
      items: [{ paymentId: dollars.id }, { paymentId: euros.id }],
    }).catch((e) => e)

    // Phase 119/120: a Refusal reaches the person rather than being replaced
    // with "Something went wrong."
    const shown = messageFor(error, 'Something went wrong.')
    expect(shown).not.toBe('Something went wrong.')
    expect(shown).toMatch(/bank each currency separately/i)
  })

  it('banks them happily one currency at a time', async () => {
    const first = await held(50_000, 'EUR')
    const second = await held(30_000, 'EUR')

    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: bankId,
      depositDate: '2026-08-16',
      items: [{ paymentId: first.id }, { paymentId: second.id }],
    })

    expect(deposit.receiptsCents).toBe(80_000)
    // And the receipts are gone from the waiting list, so the refusal is not
    // quietly blocking the ordinary case.
    const waiting = await undepositedReceipts(fixture.ctx)
    expect(waiting.map((row) => row.id)).not.toContain(first.id)
  })

  it('still banks a single receipt, whatever currency it is in', async () => {
    const euros = await held(50_000, 'EUR')

    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: bankId,
      depositDate: '2026-08-16',
      items: [{ paymentId: euros.id }],
    })

    expect(deposit.receiptsCents).toBe(50_000)
  })
})
