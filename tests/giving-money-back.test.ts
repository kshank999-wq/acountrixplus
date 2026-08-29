import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { refunds, retainers } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { refundCredit } from '@/modules/receivables/customer-credit'
import { receiveRetainer, refundRetainer } from '@/modules/timebilling/billing'
import { setModuleEnabled } from '@/modules/industry/modules'
import { putRate } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'
import { trialBalance } from '@/modules/ledger/balances'
import { mayUse } from '@/modules/receivables/overpayment'

/**
 * The money you gave back at the wrong rate (Phase 67).
 *
 * Two halves of one rule. ADR 0066 named the missing operation — a retainer
 * could not be refunded at all, so an engagement ending with money unearned
 * left a liability nobody could clear. And `refundCredit`, built in Phase 53,
 * posted the face amount with no conversion: refunding a €500 overpayment put
 * 50000 on a dollar ledger and released 50000 of a liability carried at 54175.
 *
 * Both are the same decision, and Phase 66 already made it.
 */

let fixture: Fixture
let revenueId: string

/** 1.0835 when the money arrived; 1.10 when it went back. */
const ARRIVED = 1_083_500
const RETURNED = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Refunds Co', industry: 'professional_services' })
  await setModuleEnabled(fixture.ctx, 'time_billing', true)
  revenueId = (await fixture.account('4000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-04-01',
    rateMillionths: ARRIVED,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: RETURNED,
    source: 'manual',
  })
})

describe('what a refusal says it is refusing', () => {
  /** Phase 65 made a euro holding visible; this made its refusal legible. */
  it('names the currency when it is given one', () => {
    const verdict = mayUse({
      use: 'refund',
      amountCents: 900_000,
      availableCents: 851_500,
      currency: 'EUR',
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.why).toContain('€8,515.00 is held')
      expect(verdict.why).toContain('€9,000.00')
    }
  })

  /** Every caller written before Phase 67 keeps the sentence it had. */
  it('prints the bare figure when it is not', () => {
    const verdict = mayUse({ use: 'refund', amountCents: 90_000, availableCents: 60_000 })

    expect(verdict.ok === false && verdict.why).toContain('600.00 is held')
  })
})

describe('giving a retainer back', () => {
  async function euroRetainer() {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Beratung GmbH' })

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 1_000_000,
      currency: 'EUR',
      financialAccountId: fixture.financialAccountId,
    })

    return { customer, retainer }
  }

  /** The operation ADR 0066 said did not exist. */
  it('can be done at all', async () => {
    const { retainer } = await euroRetainer()

    const result = await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 1_000_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.refundedCents).toBe(1_000_000)
    expect(result.currency).toBe('EUR')
    expect(result.remainingCents).toBe(0)
  })

  /**
   * The substance. €10,000 taken at 1.0835 is carried at $10,835.00; giving it
   * back when the euro is worth 1.10 costs the bank $11,000.00. The $165.00
   * between them is a realised loss — the business is returning money that got
   * more expensive while it held it.
   */
  it('pays what the bank actually gives up, and realises the difference', async () => {
    const { retainer } = await euroRetainer()

    const result = await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 1_000_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.paidCents).toBe(convert(1_000_000, RETURNED))
    expect(result.realisedCents).toBe(
      convert(1_000_000, ARRIVED) - convert(1_000_000, RETURNED),
    )
    expect(result.realisedCents).toBe(-16_500)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)

    // The liability is fully cleared — no cent of somebody else's money left.
    const held = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '2550',
    )?.balanceCents
    expect(held ?? 0).toBe(0)

    // 7100 is other income, so a loss reads negative.
    const fx = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '7100',
    )?.balanceCents
    expect(fx).toBe(-16_500)
  })

  it('records the three amounts a refund is', async () => {
    const { retainer } = await euroRetainer()

    await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 400_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
      reference: 'Wire 8841',
    })

    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.subjectId, retainer.id))

    expect(row.subjectType).toBe('retainer')
    expect(row.direction).toBe('out')
    expect(row.amountCents).toBe(400_000)
    expect(row.carriedCents).toBe(convert(400_000, ARRIVED))
    expect(row.cashCents).toBe(convert(400_000, RETURNED))
    // Going out, the balance debited covers the cash plus the gap (Phase 68).
    expect(row.carriedCents).toBe(row.cashCents + row.realisedCents)
    expect(row.exchangeRateMillionths).toBe(RETURNED)
    expect(row.reference).toBe('Wire 8841')
  })

  it('takes both halves of what is left down together', async () => {
    const { retainer } = await euroRetainer()

    await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 1_000_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    const [row] = await db.select().from(retainers).where(eq(retainers.id, retainer.id))
    expect(row.remainingCents).toBe(0)
    expect(row.functionalRemainingCents).toBe(0)
  })

  it('refuses more than is left, in the client’s own currency', async () => {
    const { retainer } = await euroRetainer()

    await expect(
      refundRetainer(fixture.ctx, {
        retainerId: retainer.id,
        amountCents: 1_500_000,
        financialAccountId: fixture.financialAccountId,
        refundedOn: '2026-06-15',
      }),
    ).rejects.toThrow(/€10,000\.00 is held/)
  })

  /** Domestic behaviour, unchanged and realising nothing. */
  it('gives a domestic retainer back with nothing to realise', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: customer.id,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const result = await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.paidCents).toBe(500_000)
    expect(result.realisedCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)
    expect(
      balances.rows.find(
        (row: { number: string; balanceCents: number }) => row.number === '7100',
      )?.balanceCents ?? 0,
    ).toBe(0)
  })
})

describe('giving an overpayment back', () => {
  async function euroOverpayment() {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      currency: 'EUR',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 400_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-05',
      amountCents: 450_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    return { customer, payment }
  }

  /**
   * The defect. This posted the face amount on both legs, so €500 refunded put
   * 50000 on a dollar ledger and left $41.75 of a liability carried at 54175
   * that nothing would ever clear.
   */
  it('clears the whole liability rather than its face value', async () => {
    const { payment } = await euroOverpayment()

    await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)

    // 2520 Customer Overpayments, emptied.
    const held = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '2520',
    )?.balanceCents
    expect(held ?? 0).toBe(0)
  })

  it('realises the movement between arriving and going back', async () => {
    const { payment } = await euroOverpayment()

    await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    const fx = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '7100',
    )?.balanceCents

    // Held at 1.0835, returned at 1.10 — the euro got dearer, so a loss.
    expect(fx).toBeLessThan(0)
  })

  it('leaves a domestic refund byte for byte what it was', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 100_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-05',
      amountCents: 130_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const result = await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.refundedCents).toBe(30_000)
    expect(result.remainingCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)
    expect(
      balances.rows.find(
        (row: { number: string; balanceCents: number }) => row.number === '7100',
      )?.balanceCents ?? 0,
    ).toBe(0)
  })
})
