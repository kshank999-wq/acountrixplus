import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companyProfiles } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { renderInvoicePdf } from '@/modules/pdf/invoice'
import { saveProfile } from '@/modules/studio/service'

/**
 * What the customer actually holds (Phase 75).
 *
 * The invoice PDF carried `companies.name` on the cover, the same string in the
 * footer, and nothing else — no address, no telephone number, no email — on the
 * one document this application produces that a stranger receives and has to
 * pay against. The company had typed all of it into the Design Center.
 */

const AT = new Date('2026-04-01T00:00:00Z')

/**
 * The document's text as a reader sees it.
 *
 * `(` and `)` delimit a PDF string, so the writer escapes them — a telephone
 * number laid out as `(206) 555-0142` is `\(206\) 555-0142` in the bytes.
 * Asserting on the raw file would be asserting on the escaping.
 */
function readable(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/\\([()\\])/g, '$1')
}

async function invoiceFor(fixture: Fixture) {
  const customer = await createCustomer(fixture.ctx, { name: 'Harborview Holdings' })
  const revenue = await fixture.account('4000')

  return createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [
      {
        description: 'Consulting, March',
        quantityMilli: 12_000,
        unitPriceCents: 15_000,
        chartAccountId: revenue.id,
      },
    ],
  })
}

describe('the letterhead on an invoice', () => {
  it('carries the address and the contact details the company filled in', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })

    await saveProfile(fixture.ctx, {
      legalName: 'Ridgeline Construction LLC',
      addressLine1: '412 Cedar Way',
      city: 'Seattle',
      region: 'WA',
      postalCode: '98104',
      phone: '(206) 555-0142',
      email: 'accounts@ridgeline.test',
      website: 'ridgeline.test',
      documentFooter: 'WA contractor licence RIDGEC*781QK',
    })

    const invoice = await invoiceFor(fixture)
    const { bytes } = await renderInvoicePdf(fixture.ctx, invoice.id, AT)
    const body = readable(bytes)

    expect(body).toContain('Ridgeline Construction LLC')
    expect(body).toContain('412 Cedar Way')
    expect(body).toContain('Seattle, WA 98104')
    expect(body).toContain('(206) 555-0142')
    expect(body).toContain('accounts@ridgeline.test')
    expect(body).toContain('ridgeline.test')
  })

  /**
   * `documentFooter` has existed since Phase 4, is described in the schema as
   * "default footer language for generated documents", and reached exactly one
   * thing: the footer of a marketing email. The seeded value is a contractor
   * licence number — the sort of text a trade is required to publish.
   */
  it('prints the footer the company wrote, on the document it was written for', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    await saveProfile(fixture.ctx, { documentFooter: 'WA contractor licence RIDGEC*781QK' })

    const invoice = await invoiceFor(fixture)
    const { bytes } = await renderInvoicePdf(fixture.ctx, invoice.id, AT)

    expect(readable(bytes)).toContain('WA contractor licence RIDGEC*781QK')
  })

  it('names the registered entity and the name the customer knows', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline' })
    await saveProfile(fixture.ctx, { legalName: 'Ridgeline Construction LLC' })

    const invoice = await invoiceFor(fixture)
    const body = readable((await renderInvoicePdf(fixture.ctx, invoice.id, AT)).bytes)

    // The payment has to reach the registered entity; the customer only
    // recognises the trading name. An invoice needs both.
    expect(body).toContain('Ridgeline Construction LLC')
    expect(body).toContain('trading as Ridgeline')
  })

  /** ADR 0074: a cleared box saves `''`, and `''` does not trip `??`. */
  it('falls back to the company when the legal name was cleared', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    await saveProfile(fixture.ctx, { legalName: 'Ridgeline Construction LLC' })

    await db
      .update(companyProfiles)
      .set({ legalName: '' })
      .where(eq(companyProfiles.companyId, fixture.companyId))

    const invoice = await invoiceFor(fixture)
    const body = readable((await renderInvoicePdf(fixture.ctx, invoice.id, AT)).bytes)

    expect(body).toContain('Ridgeline Construction')
    expect(body).not.toContain('trading as')
  })

  /**
   * The letterhead is optional, and its absence must not put an empty band on
   * the page. A company that has filled in nothing gets the invoice it got
   * before this phase.
   */
  it('renders a sound document for a company that has filled in nothing', async () => {
    const fixture = await createCompanyFixture({ name: 'Bare Co' })

    await db.delete(companyProfiles).where(eq(companyProfiles.companyId, fixture.companyId))

    const invoice = await invoiceFor(fixture)
    const { bytes } = await renderInvoicePdf(fixture.ctx, invoice.id, AT)

    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect(readable(bytes)).toContain('Bare Co')
  })
})
