import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoiceWriteOffs, deposits } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { writeOffInvoice, recoverWriteOff, badDebtSummary } from '@/modules/receivables/credits'
import { createDeposit, undepositedReceipts } from '@/modules/banking/deposits'
import { putRate } from '@/modules/fx/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { Refusal } from '@/modules/errors'

/**
 * The ledger carries the company's own money (Phase 127).
 *
 * `tests/ledger-postings.test.ts` reads the source and stops a third instance.
 * This one proves the two that were there, against a real database, in the
 * arithmetic somebody would actually notice:
 *
 *  1. **A fully recovered write-off leaves nothing behind.** It left $250 on a
 *     €2,500 debt, because the write-off posted the functional loss and the
 *     recovery posted the face amount.
 *  2. **Banking a receipt clears exactly what it put in Undeposited Funds.**
 *     It left $50 of a €500 receipt, for the mirror-image reason.
 */

let fixture: Fixture
let customerId: string
let revenueId: string
let badDebtId: string
let undepositedId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Ledger Co' })
  revenueId = (await fixture.account('4000')).id
  badDebtId = (await accountByNumber(fixture.ctx.companyId, '6025'))!.id
  undepositedId = (await accountByNumber(fixture.ctx.companyId, '1200'))!.id
  customerId = (await createCustomer(fixture.ctx, { name: 'Bremen GmbH' })).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: 1_100_000,
    source: 'manual',
  })
})

const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

async function aEuroInvoice(unitPriceCents = 250_000) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency: 'EUR',
    lines: [
      { chartAccountId: revenueId, description: 'Work', quantityMilli: 1000, unitPriceCents },
    ],
  })
}

describe('recovering a written-off debt', () => {
  it('keeps the loss the books actually took, not the invoice’s own amount', async () => {
    const invoice = await aEuroInvoice()
    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })

    // €2,500 at 1.10. The face amount is what the customer owed; the loss is
    // what the books were carrying for it.
    expect(writeOff.amountCents).toBe(250_000)
    expect(writeOff.currency).toBe('EUR')
    expect(writeOff.functionalAmountCents).toBe(275_000)
    expect(await balanceForAccount(fixture.ctx, badDebtId, YEAR)).toBe(275_000)
  })

  it('leaves nothing on the books after a full recovery', async () => {
    const invoice = await aEuroInvoice()
    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-11-15',
      amountCents: 250_000,
      financialAccountId: fixture.financialAccountId,
    })

    // The defect in one assertion: this was 25000 before Phase 127 — $250 of
    // bad-debt expense on a debt that had been recovered in full, on every
    // profit and loss from then on.
    expect(await balanceForAccount(fixture.ctx, badDebtId, YEAR)).toBe(0)
  })

  it('takes a part recovery off at the rate the write-off was carried at', async () => {
    const invoice = await aEuroInvoice()
    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-11-15',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })

    // €1,000 of €2,500 recovered: $1,100 off a $2,750 loss, leaving $1,650.
    expect(await balanceForAccount(fixture.ctx, badDebtId, YEAR)).toBe(165_000)

    const [row] = await db
      .select()
      .from(invoiceWriteOffs)
      .where(eq(invoiceWriteOffs.id, writeOff.id))
    expect(row.recoveredCents).toBe(100_000)
    expect(row.functionalRecoveredCents).toBe(110_000)
  })

  it('makes the bad-debt report agree with the profit and loss', async () => {
    const invoice = await aEuroInvoice()
    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })
    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-11-15',
      amountCents: 250_000,
      financialAccountId: fixture.financialAccountId,
    })

    const summary = await badDebtSummary(fixture.ctx, YEAR)

    // ADR 0125 recorded this as unfixable without the column: it summed face
    // amounts across currencies and printed one symbol. Both figures are the
    // books' money now, and `netCents` agrees with the account balance above —
    // it read 0 before while the ledger carried $250, which is the same defect
    // wearing the other hat.
    expect(summary.writtenOffCents).toBe(275_000)
    expect(summary.recoveredCents).toBe(275_000)
    expect(summary.netCents).toBe(await balanceForAccount(fixture.ctx, badDebtId, YEAR))
  })

  it('tells somebody how much was written off in the currency it was in', async () => {
    const invoice = await aEuroInvoice()
    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })

    await expect(
      recoverWriteOff(fixture.ctx, writeOff.id, {
        recoveredOn: '2026-11-15',
        amountCents: 300_000,
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/€2,500\.00 was written off/)
  })
})

describe('banking a foreign receipt', () => {
  async function aEuroReceipt(amountCents = 50_000) {
    const invoice = await aEuroInvoice(amountCents)
    // No `financialAccountId`: the money has arrived but has not been taken to
    // a bank, so it waits in Undeposited Funds until a deposit batches it.
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId,
      paymentDate: '2026-06-01',
      amountCents,
      applications: [{ invoiceId: invoice.id, amountCents }],
    })
    return undepositedReceipts(fixture.ctx)
  }

  it('clears exactly what the receipt put into Undeposited Funds', async () => {
    const waiting = await aEuroReceipt()
    expect(waiting).toHaveLength(1)

    // €500 at 1.10 — what `recordPayment` debited.
    expect(await balanceForAccount(fixture.ctx, undepositedId, YEAR)).toBe(55_000)

    await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-06-05',
      items: [{ paymentId: waiting[0].id }],
    })

    // The defect in one assertion: this was 5000 before Phase 127 — $50 in a
    // clearing account that nothing could ever clear, and `banking.cash_tie_out`
    // disagreeing every night with no traceable cause.
    expect(await balanceForAccount(fixture.ctx, undepositedId, YEAR)).toBe(0)
  })

  it('records both figures on the deposit, and what they are in', async () => {
    const waiting = await aEuroReceipt()
    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-06-05',
      items: [{ paymentId: waiting[0].id }],
    })

    const [row] = await db.select().from(deposits).where(eq(deposits.id, deposit.id))
    expect(row.currency).toBe('EUR')
    expect(row.receiptsCents).toBe(50_000)
    expect(row.functionalReceiptsCents).toBe(55_000)
    expect(row.totalCents).toBe(50_000)
    expect(row.functionalTotalCents).toBe(55_000)
  })

  it('refuses a typed line beside foreign receipts rather than adding it to them', async () => {
    const waiting = await aEuroReceipt()

    // Found by this phase's own scanner on its first run: `otherCents` is a
    // chart-account amount, which has no currency, and it was being added
    // straight into a euro total. Phase 123's refusal, on the line beside the
    // one it was written for.
    await expect(
      createDeposit(fixture.ctx, {
        financialAccountId: fixture.financialAccountId,
        depositDate: '2026-06-05',
        items: [{ paymentId: waiting[0].id }, { chartAccountId: revenueId, amountCents: -500 }],
      }),
    ).rejects.toThrow(Refusal)
  })
})
