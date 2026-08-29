import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createCustomer, createInvoice, createVendor } from '@/modules/receivables/service'
import { currencyChoices, putRate, quoteDocument } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'

/**
 * The euro invoice you could not raise (Phase 64).
 *
 * ADR 0063 named this itself: four phases taught every screen downstream to
 * handle a foreign document, and there was still no way to make one. These are
 * the two questions the composer asks before anybody commits — what may be
 * chosen, and what it would book at.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string

const RATE = 1_083_500

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Quoting Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id
})

describe('what the composer may offer', () => {
  /**
   * The honest starting state. A company that has never recorded a rate can
   * only post in its own money, and offering EUR would be a choice that cannot
   * be taken — Phase 47's defect, a refusal behind a button.
   */
  it('offers only the company’s own currency until a rate exists', async () => {
    const choices = await currencyChoices(fixture.ctx)

    expect(choices.homeCurrency).toBe('USD')
    expect(choices.offerable).toEqual(['USD'])
  })

  it('offers a currency as soon as one rate is on file for it', async () => {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-06-01',
      rateMillionths: RATE,
      source: 'manual',
    })

    const choices = await currencyChoices(fixture.ctx)
    expect(choices.offerable).toEqual(['USD', 'EUR'])
  })

  it('offers a currency once however many rates it has', async () => {
    for (const rateDate of ['2026-06-01', '2026-07-01', '2026-08-01']) {
      await putRate(fixture.ctx, {
        baseCurrency: 'EUR',
        rateDate,
        rateMillionths: RATE,
        source: 'manual',
      })
    }

    expect((await currencyChoices(fixture.ctx)).offerable).toEqual(['USD', 'EUR'])
  })
})

describe('what a document would book at', () => {
  beforeEach(async () => {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-06-01',
      rateMillionths: RATE,
      source: 'manual',
    })
  })

  it('says nothing about a domestic document', async () => {
    const result = await quoteDocument(fixture.ctx, {
      lineCents: [400_000],
      currency: 'USD',
      issueDate: '2026-06-15',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.quote.foreign).toBe(false)
      expect(result.quote.note).toBeNull()
    }
  })

  it('says what a foreign one books at, and at what rate', async () => {
    const result = await quoteDocument(fixture.ctx, {
      lineCents: [400_000],
      currency: 'EUR',
      issueDate: '2026-06-15',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.quote.functionalTotalCents).toBe(convert(400_000, RATE))
      expect(result.quote.note).toContain('€4,000.00 books as $4,334.00')
      // Dated a fortnight before the document, because that is the rate on
      // file — and the composer is the only place anybody will be told.
      expect(result.quote.note).toContain('the rate of 2026-06-01')
    }
  })

  /**
   * The refusal, reported rather than thrown. The composer needs it as an
   * answer it can put on the row (Phase 47), not as an exception that would
   * surface only once somebody pressed the button.
   */
  it('reports a missing rate instead of throwing', async () => {
    const result = await quoteDocument(fixture.ctx, {
      lineCents: [400_000],
      currency: 'EUR',
      // Before any rate exists: `rateFor` walks backwards and finds nothing.
      issueDate: '2026-01-15',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('No EUR/USD rate on file for 2026-01-15')
    }
  })

  /**
   * The substance: the preview has to be the number that lands. If these two
   * ever disagreed, the composer would be quietly lying at the one moment the
   * rate can still be questioned.
   */
  it('previews exactly what the invoice then posts', async () => {
    const lineCents = [33_333, 33_333, 33_333]

    const quoted = await quoteDocument(fixture.ctx, {
      lineCents,
      currency: 'EUR',
      issueDate: '2026-06-15',
    })

    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      dueDate: '2026-07-15',
      currency: 'EUR',
      lines: lineCents.map((cents) => ({
        chartAccountId: revenueId,
        description: 'Work',
        unitPriceCents: cents,
      })),
    })

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))

    expect(quoted.ok).toBe(true)
    if (quoted.ok) {
      expect(quoted.quote.totalCents).toBe(row.totalCents)
      expect(quoted.quote.functionalTotalCents).toBe(row.functionalBalanceCents)
    }
  })

  it('quotes a bill the same way it quotes an invoice', async () => {
    const quoted = await quoteDocument(fixture.ctx, {
      lineCents: [250_000],
      currency: 'EUR',
      issueDate: '2026-06-15',
    })

    const vendor = await createVendor(fixture.ctx, { name: 'Bremen Hafenbau GmbH' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-15',
      dueDate: '2026-07-15',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 250_000 }],
    })

    expect(quoted.ok).toBe(true)
    if (quoted.ok) {
      expect(quoted.quote.totalCents).toBe(bill.totalCents)
      expect(quoted.quote.functionalTotalCents).toBe(bill.functionalBalanceCents)
    }
  })

  it('counts tax into both halves of the quote', async () => {
    const result = await quoteDocument(fixture.ctx, {
      lineCents: [100_000],
      taxCents: 8_750,
      currency: 'EUR',
      issueDate: '2026-06-15',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.quote.totalCents).toBe(108_750)
      expect(result.quote.functionalTotalCents).toBe(
        convert(100_000, RATE) + convert(8_750, RATE),
      )
    }
  })
})
