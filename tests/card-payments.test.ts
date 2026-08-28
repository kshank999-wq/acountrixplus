import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { checkouts, customers, invoices, journalEntries, payouts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { getPaymentSettings, updatePaymentSettings } from '@/modules/payments/settings'
import {
  heldByProcessor,
  importPayouts,
  recentCheckouts,
  settleCheckout,
  startCheckout,
  sweepUnresolvedCheckouts,
  unresolvedCheckouts,
  PaymentError,
} from '@/modules/payments/service'
import { paymentsInTransitPosition } from '@/modules/payments/reporting'
import { unresolvedKind } from '@/modules/payments/reconcile'
import { mockPaymentProvider } from '@/modules/payments/mock-provider'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'

/**
 * Taking money by card (Phase 44).
 *
 * The claim under test: **the money is where the money is**. A card payment is
 * at the processor for days, arrives net of a fee, and lands batched with
 * others — and the ledger says all three of those things rather than pretending
 * the bank was credited on the day of the charge.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Card Co' })
  mockPaymentProvider.reset()
})

/**
 * One customer, several invoices — which is what a business actually has.
 *
 * It made a fresh customer per invoice until Phase 47 added the namesake
 * check, and three tests here failed on the second call. The check was right:
 * two records called Harborview LLC split their balance and their aging in
 * two. Reusing the one that exists is both the fix and the more faithful
 * fixture.
 */
async function anInvoice(cents = 100_000) {
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, fixture.companyId), eq(customers.name, 'Harborview LLC')))
    .limit(1)

  const customer =
    existing ??
    (await createCustomer(fixture.ctx, {
      name: 'Harborview LLC',
      email: 'ap@harborview.test',
    }))

  const sales = await fixture.account('4000')

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ chartAccountId: sales.id, description: 'Kitchen refit', unitPriceCents: cents }],
  })

  return { customer, invoice }
}

/** Switches card payments on, with somewhere for the money to land. */
async function enable() {
  const bank = await createFinancialAccount(fixture.ctx, {
    name: 'Business Checking',
    kind: 'checking',
    mask: '4471',
  })

  await updatePaymentSettings(fixture.ctx, {
    enabled: true,
    payoutFinancialAccountId: bank.id,
  })

  return bank
}

/** Takes a card payment end to end, the way a customer does. */
async function payByCard(invoiceId: string, requestedCents?: number) {
  const started = await startCheckout({ invoiceId, requestedCents })
  const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
  await mockPaymentProvider.confirm(row.providerCheckoutId)
  const settled = await settleCheckout(row.providerCheckoutId)
  return { started, providerCheckoutId: row.providerCheckoutId, settled }
}

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

/**
 * The bank's *own* ledger account.
 *
 * Not `1000`. Phase 40 gives every bank account a ledger account of its own,
 * so the one created here is whatever number was free — looking up 1000 by
 * number reads the standard chart's placeholder and finds nothing, which is
 * exactly the confusion Phase 40 existed to end.
 */
const bankBalance = (chartAccountId: string) =>
  balanceForAccount(fixture.ctx, chartAccountId)

describe('the settings', () => {
  it('are off for a company that has never touched them', async () => {
    const settings = await getPaymentSettings(fixture.companyId)

    expect(settings.enabled).toBe(false)
    expect(settings.payoutFinancialAccountId).toBeNull()
    expect(settings.fee).toEqual({ percentBp: 290, fixedCents: 30 })
  })

  /**
   * Taking a customer's money with nowhere to post the deposit is real money
   * against a ledger that cannot record where it went.
   */
  it('refuse to switch on without somewhere for the money to land', async () => {
    await expect(updatePaymentSettings(fixture.ctx, { enabled: true })).rejects.toBeInstanceOf(
      DomainError,
    )

    const settings = await getPaymentSettings(fixture.companyId)
    expect(settings.enabled).toBe(false)
  })

  it('refuse a fee nobody would have negotiated', async () => {
    await expect(
      updatePaymentSettings(fixture.ctx, { feePercentBp: 5_000 }),
    ).rejects.toBeInstanceOf(DomainError)
    await expect(
      updatePaymentSettings(fixture.ctx, { feeFixedCents: -1 }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('are not something a reader can switch on', async () => {
    const readonly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(
      updatePaymentSettings(readonly, { enabled: true }),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('starting a payment', () => {
  it('refuses while the company has not switched cards on', async () => {
    const { invoice } = await anInvoice()
    await expect(startCheckout({ invoiceId: invoice.id })).rejects.toBeInstanceOf(PaymentError)
  })

  it('offers the whole balance, and records the attempt before sending anybody anywhere', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })

    expect(started.amountCents).toBe(100_000)
    expect(started.url).toContain('/pay/')

    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(row.status).toBe('pending')
    expect(row.grossCents).toBe(100_000)
    expect(row.paymentId).toBeNull()
  })

  it('takes a part payment when the customer asks for one', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id, requestedCents: 40_000 })
    expect(started.amountCents).toBe(40_000)
  })

  /**
   * The amount is decided from the invoice, not accepted from the request. A
   * form field carrying "what I owe" is a form field somebody can edit.
   */
  it('refuses to be asked for more than is outstanding', async () => {
    await enable()
    const { invoice } = await anInvoice()

    await expect(
      startCheckout({ invoiceId: invoice.id, requestedCents: 500_000 }),
    ).rejects.toBeInstanceOf(PaymentError)
  })

  it('refuses a voided invoice', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id))

    await expect(startCheckout({ invoiceId: invoice.id })).rejects.toBeInstanceOf(PaymentError)
  })
})

describe('capturing one', () => {
  /**
   * The assertion the whole phase exists for. Three entries, and the bank is
   * not one of them yet.
   */
  it('puts the money at the processor, not at the bank', async () => {
    const bank = await enable()
    const { invoice } = await anInvoice()

    const { settled } = await payByCard(invoice.id)
    expect(settled.ok).toBe(true)

    // Gross settles the debt; the customer paid what they were asked for.
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(0)
    expect(after.status).toBe('paid')

    // 1250 carries the gross less the fee — what the processor will send.
    expect(await balanceOf('1250')).toBe(97_070)
    // The fee is a real operating cost on the profit and loss.
    expect(await balanceOf('6850')).toBe(2_930)
    // And the bank has not moved. Nothing has arrived.
    expect(await bankBalance(bank.chartAccountId)).toBe(0)
    // Receivables cleared by the full amount.
    expect(await balanceOf('1100')).toBe(0)
  })

  it('leaves the invoice settled even though less than the gross arrives', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    // Charging the fee back to the customer would leave every card-paid
    // invoice showing 29 dollars owing for ever.
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(0)
  })

  it('records what the processor kept, against the invoice it came from', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    const [row] = await recentCheckouts(fixture.ctx)
    expect(row.status).toBe('succeeded')
    expect(row.grossCents).toBe(100_000)
    expect(row.feeCents).toBe(2_930)
    expect(row.invoiceNumber).toBe(invoice.number)
    expect(row.paidOut).toBe(false)
  })

  /**
   * A customer double-clicking Pay is the ordinary case, not the exceptional
   * one. The unique constraint on `checkouts.payment_id` is what decides.
   */
  it('settling twice records one payment', async () => {
    await enable()
    const { invoice } = await anInvoice()
    const { providerCheckoutId, settled } = await payByCard(invoice.id)

    const again = await settleCheckout(providerCheckoutId)

    expect(again.ok).toBe(true)
    expect(again.ok === true && again.alreadyDone).toBe(true)
    if (again.ok && settled.ok) expect(again.paymentId).toBe(settled.paymentId)

    // And the ledger moved once.
    expect(await balanceOf('1250')).toBe(97_070)
    expect(await balanceOf('6850')).toBe(2_930)
  })

  it('settling concurrently records one payment', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    await mockPaymentProvider.confirm(row.providerCheckoutId)

    const results = await Promise.allSettled([
      settleCheckout(row.providerCheckoutId),
      settleCheckout(row.providerCheckoutId),
      settleCheckout(row.providerCheckoutId),
    ])

    const posted = results.filter(
      (result) => result.status === 'fulfilled' && result.value.ok,
    )
    expect(posted.length).toBeGreaterThan(0)

    // Whatever the race did, the books moved once.
    expect(await balanceOf('1250')).toBe(97_070)
    expect(await balanceOf('1100')).toBe(0)
  })

  it('reports a decline without posting anything', async () => {
    await enable()
    // The mock declines an amount ending in 13 cents.
    const { invoice } = await anInvoice(100_013)

    const { settled } = await payByCard(invoice.id)

    expect(settled.ok).toBe(false)
    expect(settled.ok === false && settled.reason).toContain('declined')

    expect(await balanceOf('1250')).toBe(0)
    expect(await balanceOf('6850')).toBe(0)

    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(100_013)
  })

  /**
   * "The customer tried on Friday and the card was declined" is the single
   * most useful thing a business can know about an unpaid invoice, and it is
   * invisible if only successes are stored.
   */
  it('keeps the failed attempt, with the reason', async () => {
    await enable()
    const { invoice } = await anInvoice(100_013)
    await payByCard(invoice.id)

    const [row] = await recentCheckouts(fixture.ctx)
    expect(row.status).toBe('failed')
    expect(row.failureReason).toContain('declined')
  })

  it('will not settle a checkout the processor has not completed', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))

    const settled = await settleCheckout(row.providerCheckoutId)
    expect(settled.ok).toBe(false)
    expect(settled.ok === false && settled.reason).toContain('not completed')
  })

  /**
   * The balance can move while the customer has the payment page open —
   * somebody banks a cheque. Over-applying would push the invoice negative and
   * put the control account out of agreement with the aging report.
   */
  it('does not over-apply when the invoice was settled while the page was open', async () => {
    await enable()
    const { customer, invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 100_000,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    await mockPaymentProvider.confirm(row.providerCheckoutId)
    const settled = await settleCheckout(row.providerCheckoutId)

    expect(settled.ok).toBe(false)
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(0)
  })
})

describe('the payout', () => {
  it('moves the money to the bank as one entry, whatever it settles', async () => {
    const bank = await enable()
    const first = await anInvoice(100_000)
    const second = await anInvoice(50_000)

    await payByCard(first.invoice.id)
    await payByCard(second.invoice.id)

    // $97,070 + $48,520 held at the processor.
    expect(await balanceOf('1250')).toBe(145_590)

    const result = await importPayouts(fixture.ctx)

    expect(result.imported).toBe(1)
    expect(result.postedCents).toBe(145_590)
    expect(result.discrepancies).toEqual([])

    // The clearing account is empty and the bank holds the net.
    expect(await balanceOf('1250')).toBe(0)
    expect(await bankBalance(bank.chartAccountId)).toBe(145_590)
  })

  /**
   * One entry against one statement line is the whole reason the clearing
   * account exists. Two payments, one deposit, one journal entry.
   */
  it('posts one journal entry for a batch of two', async () => {
    await enable()
    const first = await anInvoice(100_000)
    const second = await anInvoice(50_000)
    await payByCard(first.invoice.id)
    await payByCard(second.invoice.id)

    await importPayouts(fixture.ctx)

    const [batch] = await db.select().from(payouts).where(eq(payouts.companyId, fixture.companyId))
    expect(batch.journalEntryId).not.toBeNull()
    expect(batch.amountCents).toBe(145_590)
    expect(batch.expectedCents).toBe(145_590)
    expect(batch.differenceCents).toBe(0)
  })

  it('importing twice deposits once', async () => {
    const bank = await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    const first = await importPayouts(fixture.ctx)
    // The mock has nothing left unswept, so the second run finds no batch at
    // all — and even if it reported the same one, the unique constraint would
    // skip it rather than post a second deposit.
    const second = await importPayouts(fixture.ctx)

    expect(first.imported).toBe(1)
    expect(second.imported).toBe(0)
    expect(await bankBalance(bank.chartAccountId)).toBe(97_070)
  })

  it('refuses to import with nowhere to put the money', async () => {
    const bank = await createFinancialAccount(fixture.ctx, { name: 'Checking', kind: 'checking' })
    await updatePaymentSettings(fixture.ctx, { enabled: true, payoutFinancialAccountId: bank.id })
    await updatePaymentSettings(fixture.ctx, {
      enabled: false,
      payoutFinancialAccountId: null,
    })

    await expect(importPayouts(fixture.ctx)).rejects.toBeInstanceOf(PaymentError)
  })

  /**
   * The defect browser verification caught.
   *
   * The mock announced a batch arriving in two days and the import posted it
   * immediately, so the bank ledger showed money that was not there — the
   * exact error this phase exists to prevent, committed at the last step
   * instead of the first.
   */
  it('will not deposit money that has not arrived', async () => {
    const bank = await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    // The batch is real and paid, but its arrival date is still ahead.
    const yesterday = '2020-01-01'
    const result = await importPayouts(fixture.ctx, { asOf: yesterday })

    expect(result.imported).toBe(0)
    expect(result.notYetArrived).toBe(1)

    // The money stays where it truthfully is: at the processor.
    expect(await bankBalance(bank.chartAccountId)).toBe(0)
    expect(await balanceOf('1250')).toBe(97_070)

    const rows = await db.select().from(payouts).where(eq(payouts.companyId, fixture.companyId))
    expect(rows).toHaveLength(0)
  })

  it('is quiet when the processor has sent nothing', async () => {
    await enable()
    const result = await importPayouts(fixture.ctx)

    expect(result.imported).toBe(0)
    expect(result.postedCents).toBe(0)
  })
})

describe('the clearing account, checked', () => {
  it('agrees on an empty company', async () => {
    const position = await paymentsInTransitPosition(fixture.ctx)
    expect(position.agrees).toBe(true)
    expect(position.differenceCents).toBe(0)
  })

  it('agrees while money is held, and after it is paid out', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    const held = await paymentsInTransitPosition(fixture.ctx)
    expect(held.owedCents).toBe(97_070)
    expect(held.ledgerCents).toBe(97_070)
    expect(held.agrees).toBe(true)

    await importPayouts(fixture.ctx)

    const cleared = await paymentsInTransitPosition(fixture.ctx)
    expect(cleared.owedCents).toBe(0)
    expect(cleared.ledgerCents).toBe(0)
    expect(cleared.agrees).toBe(true)
  })

  /**
   * The failure this check exists to catch: money taken at the processor that
   * never reached these books. Simulated by removing the posting, since a real
   * one would be a crash between capture and post.
   */
  it('reports a difference when the ledger is missing a capture', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await payByCard(invoice.id)

    // Void the capture's entry, leaving the checkout row behind. A real
    // occurrence is a process that died between claiming and posting.
    await db
      .update(journalEntries)
      .set({ status: 'void' })
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.sourceType, 'payment'),
        ),
      )

    const position = await paymentsInTransitPosition(fixture.ctx)
    expect(position.owedCents).toBe(97_070)
    expect(position.ledgerCents).not.toBe(97_070)
    expect(position.agrees).toBe(false)
    expect(position.differenceCents).toBeGreaterThan(0)
  })

  it('counts only what has not been swept', async () => {
    await enable()
    const first = await anInvoice(100_000)
    await payByCard(first.invoice.id)
    await importPayouts(fixture.ctx)

    const second = await anInvoice(50_000)
    await payByCard(second.invoice.id)

    // Only the second is still at the processor.
    expect(await heldByProcessor(fixture.companyId)).toBe(48_520)
  })
})

describe('the payment nobody came back from', () => {
  /**
   * The hole Phase 46 closed, and the reason the check needed a third number.
   *
   * The customer pays and closes the tab. The processor has the money; our
   * checkout is still `pending`, so nothing posted. `heldByProcessor` counts
   * only `succeeded` rows, so the processor side reads zero — and the ledger
   * side reads zero because nothing posted. Before this phase the subtraction
   * compared nothing against nothing and reported agreement, while the money
   * sat unrecorded and Phase 43 chased the customer for an invoice they had
   * paid. Two zeroes agreeing is not the same as nothing being wrong.
   */
  it('is counted by the clearing-account check, which no subtraction could do', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))

    // Money really moved at the processor. Nobody told us.
    await mockPaymentProvider.confirm(row.providerCheckoutId)

    // A day later, nobody having come back.
    const asOf = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const position = await paymentsInTransitPosition(fixture.ctx, asOf.slice(0, 10))

    // Both sides of the subtraction still read zero...
    expect(position.owedCents).toBe(0)
    expect(position.ledgerCents).toBe(0)
    expect(position.differenceCents).toBe(0)
    // ...and the check no longer calls that agreement.
    expect(position.unresolvedCount).toBe(1)
    expect(position.unresolvedCents).toBe(100_000)
    expect(position.agrees).toBe(false)
  })

  /**
   * What the sweep is for: the money comes back onto the books without
   * anybody noticing it was missing.
   */
  it('is recovered by the sweep, invoice and all', async () => {
    await enable()
    const { invoice } = await anInvoice()

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    await mockPaymentProvider.confirm(row.providerCheckoutId)

    const summary = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(summary.settled).toBe(1)
    expect(summary.investigate).toBe(0)

    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(0)
    expect(await balanceOf('1250')).toBe(97_070)

    // And the check is clean again.
    const position = await paymentsInTransitPosition(fixture.ctx)
    expect(position.agrees).toBe(true)
  })

  it('leaves one the customer is still looking at alone', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await startCheckout({ invoiceId: invoice.id })

    const summary = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(summary.waiting).toBe(1)
    expect(summary.settled).toBe(0)
    expect(summary.expired).toBe(0)
  })

  it('expires one that was started and abandoned', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await startCheckout({ invoiceId: invoice.id })

    // Two days on, with the processor still saying pending.
    const asOf = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const summary = await sweepUnresolvedCheckouts(fixture.ctx, { asOf })

    expect(summary.expired).toBe(1)

    const [row] = await db.select().from(checkouts).where(eq(checkouts.invoiceId, invoice.id))
    expect(row.status).toBe('expired')

    // Nothing was charged, so the invoice is untouched.
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(100_000)
  })

  /**
   * The assertion the phase turns on. An outage at the processor must never
   * become a customer's money written off — so an unknown is counted for a
   * person and resolves nothing in either direction.
   */
  it('never writes off one the processor cannot account for', async () => {
    await enable()
    const { invoice } = await anInvoice()
    await startCheckout({ invoiceId: invoice.id })

    // The processor loses its record — which is exactly what the mock does
    // across a restart, and what a real one does during an outage.
    mockPaymentProvider.reset()

    const asOf = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const summary = await sweepUnresolvedCheckouts(fixture.ctx, { asOf })

    expect(summary.investigate).toBe(1)
    expect(summary.expired).toBe(0)
    expect(summary.failed).toBe(0)

    // Left exactly as it was, so a later answer can still settle it.
    const [row] = await db.select().from(checkouts).where(eq(checkouts.invoiceId, invoice.id))
    expect(row.status).toBe('pending')
  })

  it('records the decline the processor reports', async () => {
    await enable()
    // The mock declines an amount ending in 13 cents.
    const { invoice } = await anInvoice(100_013)
    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    await mockPaymentProvider.confirm(row.providerCheckoutId)

    const summary = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(summary.failed).toBe(1)
    const [after] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(after.status).toBe('failed')
  })

  it('sweeping twice settles once', async () => {
    await enable()
    const { invoice } = await anInvoice()
    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    await mockPaymentProvider.confirm(row.providerCheckoutId)

    const first = await sweepUnresolvedCheckouts(fixture.ctx)
    const second = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(first.settled).toBe(1)
    expect(second.considered).toBe(0)
    expect(await balanceOf('1250')).toBe(97_070)
  })

  it('is quiet on a company with nothing outstanding', async () => {
    await enable()
    const summary = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(summary).toMatchObject({ considered: 0, settled: 0, investigate: 0 })
  })

  /**
   * Browser verification found the finding evaporating. The sweep announced
   * "1 the processor cannot account for — somebody needs to look" into a
   * notice that was gone on reload, and the row it meant was left sitting
   * beside the abandoned ones under copy saying most of these are harmless.
   * An answer nobody can see an hour later is an answer the sweep did not get.
   */
  it('writes down what the processor said, so the finding outlives the run', async () => {
    await enable()
    const { invoice } = await anInvoice()
    const started = await startCheckout({ invoiceId: invoice.id })

    const before = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(before[0].lastReportedStatus).toBeNull()
    expect(before[0].lastCheckedAt).toBeNull()

    // The processor forgets — a restart, an outage, the wrong credentials.
    mockPaymentProvider.reset()
    const summary = await sweepUnresolvedCheckouts(fixture.ctx)

    expect(summary.investigate).toBe(1)

    const [after] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(after.status).toBe('pending')
    expect(after.lastReportedStatus).toBe('unknown')
    expect(after.lastCheckedAt).not.toBeNull()

    // And the screen can find it: it is unresolved, and it is the kind that
    // needs a person rather than the kind that needs patience.
    const open = await unresolvedCheckouts(
      fixture.companyId,
      new Date(Date.now() + 3 * 86_400_000).toISOString(),
    )
    expect(open).toHaveLength(1)
    expect(unresolvedKind(open[0].lastReportedStatus)).toBe('unaccounted')
  })

  it('records the ordinary answer too, so "not yet asked" stays distinguishable', async () => {
    await enable()
    const { invoice } = await anInvoice()
    const started = await startCheckout({ invoiceId: invoice.id })

    await sweepUnresolvedCheckouts(fixture.ctx)

    const [after] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(after.lastReportedStatus).toBe('pending')
    expect(unresolvedKind(after.lastReportedStatus)).toBe('unanswered')
  })
})
