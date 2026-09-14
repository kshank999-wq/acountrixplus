import { describe, expect, it } from 'vitest'
import { createCompanyFixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { createTaxCode, salesTaxReturn } from '@/modules/payroll/sales-tax'
import { taxAtRate } from '@/modules/payroll/tax-rounding'

/**
 * An invoice whose tax cannot be got back from its own base (Phase 145).
 *
 * ## Skipped on purpose — this is the acceptance test for the wiring pass
 *
 * `priceDocumentTax` is deliberately **not** routed through `taxPerCode`. It is
 * declared in `PENDING_WIRING`, and this file is the definition of done that
 * entry is required to name: unskip it, price through the new core, and it says
 * whether it worked.
 *
 * ## The defect it describes, which is live today
 *
 * `priceDocumentTax` calls `taxOn` once per line and adds the results up. Three
 * lines of $10.00, $20.00 and $33.33 under one 8.25% code are rounded to 83, 165
 * and 275 cents — $5.23 — where the code's own base of $63.33 gives $5.22. The
 * invoice charges the customer a figure that is not its printed base times the
 * printed rate, under a named jurisdiction, and `taxOn`'s own comment says this
 * is the thing not to do.
 *
 * ## What it does not assert
 *
 * That the **return** foots across documents. It cannot: once an invoice has
 * charged a whole number of cents that is the money that moved, and
 * `round(a × r) + round(b × r)` is not `round((a + b) × r)`. The document is the
 * level where the identity is required and the level this repairs, so that is
 * what is asserted here.
 */

describe.skip('an invoice with several lines under one tax code', () => {
  it('charges what its own base and rate come to', async () => {
    const fixture = await createCompanyFixture({ name: 'Cascade Supply' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })

    const cityTax = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 825,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      lines: [{ chartAccountId: revenue.id, description: 'Supplies', unitPriceCents: 63_33 }],
      taxLines: [
        { taxCodeId: cityTax.id, taxableCents: 1_000 },
        { taxCodeId: cityTax.id, taxableCents: 2_000 },
        { taxCodeId: cityTax.id, taxableCents: 3_333 },
      ],
    })

    // 522, not the 523 that three separate roundings come to.
    expect(invoice.taxCents).toBe(taxAtRate(6_333, 825))
    expect(invoice.taxCents).toBe(522)
  })

  it('still splits the charged figure back across the lines it came from', async () => {
    // The breakdown has to sum to the header — that property is already true
    // today and must survive the repair, which is why it is asserted rather
    // than assumed.
    const fixture = await createCompanyFixture({ name: 'Cascade Supply' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })

    const cityTax = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 825,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      lines: [{ chartAccountId: revenue.id, description: 'Supplies', unitPriceCents: 63_33 }],
      taxLines: [
        { taxCodeId: cityTax.id, taxableCents: 1_000 },
        { taxCodeId: cityTax.id, taxableCents: 2_000 },
        { taxCodeId: cityTax.id, taxableCents: 3_333 },
      ],
    })

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    const city = report.lines.find((line) => line.jurisdiction === 'Springfield City')!
    expect(city.taxableCents).toBe(6_333)
    expect(city.taxCollectedCents).toBe(invoice.taxCents)
  })
})

describe.skip('two tax codes on one document', () => {
  it('rounds each on its own base rather than on the document', async () => {
    // Why "round once on the total", which is what `taxOn`'s comment asks for,
    // is not the repair: a return reports per jurisdiction, so each code needs
    // a figure of its own that its own base produces.
    const fixture = await createCompanyFixture({ name: 'Cascade Supply' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })

    const cityTax = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 825,
    })
    const stateTax = await createTaxCode(fixture.ctx, {
      code: 'STATE',
      name: 'State sales tax',
      jurisdiction: 'State',
      rateBp: 875,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      lines: [{ chartAccountId: revenue.id, description: 'Supplies', unitPriceCents: 103_31 }],
      taxLines: [
        { taxCodeId: cityTax.id, taxableCents: 1_000 },
        { taxCodeId: cityTax.id, taxableCents: 2_000 },
        { taxCodeId: cityTax.id, taxableCents: 3_333 },
        { taxCodeId: stateTax.id, taxableCents: 1_999 },
        { taxCodeId: stateTax.id, taxableCents: 1_999 },
      ],
    })

    expect(invoice.taxCents).toBe(taxAtRate(6_333, 825) + taxAtRate(3_998, 875))

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    for (const line of report.lines) {
      expect(line.taxCollectedCents, line.jurisdiction).toBe(
        taxAtRate(line.taxableCents, line.rateBp),
      )
    }
  })
})
