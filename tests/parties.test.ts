import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, customers, invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
  updateCustomer,
  updateVendor,
} from '@/modules/receivables/service'
import {
  listCustomerSummaries,
  listVendorSummaries,
  setCustomerActive,
  setVendorActive,
} from '@/modules/parties/service'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'

/**
 * The people a business trades with (Phase 45).
 *
 * The claim under test: **a record can be corrected without rewriting the
 * books**. A name change reaches every document that names them; a change of
 * payment terms reaches none of them.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Parties Co' })
})

async function aCustomer(over: Record<string, unknown> = {}) {
  return createCustomer(fixture.ctx, {
    name: 'Harborview LLC',
    email: 'ap@harborview.test',
    ...over,
  })
}

async function anInvoiceFor(customerId: string, cents = 120_000) {
  const sales = await fixture.account('4000')
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ chartAccountId: sales.id, description: 'Kitchen refit', unitPriceCents: cents }],
  })
}

describe('creating one', () => {
  /**
   * `modules/pdf/invoice.ts` has read `customer.addressLine1` since Phase 21
   * and nothing ever wrote it, so every invoice PDF carried a blank billing
   * address. The PDF needed no change — only somewhere to type it.
   */
  it('takes the address the invoice PDF has always read', async () => {
    const customer = await aCustomer({
      addressLine1: '4 Mill Lane',
      city: 'Bristol',
      postalCode: 'BS1 4TT',
    })

    expect(customer.addressLine1).toBe('4 Mill Lane')
    expect(customer.city).toBe('Bristol')
    expect(customer.postalCode).toBe('BS1 4TT')
  })

  /**
   * The find that named this task. `modules/pdf/invoice.ts` has composed a
   * "Billed to" block from `addressLine1`, `city` and `postalCode` since
   * Phase 21, and no code path has ever written any of the three — so every
   * invoice PDF this application produced carried a billing address of just
   * the customer's name. The PDF needed no change at all; it needed somewhere
   * to type.
   */
  it('the invoice PDF prints the address, now that one can be entered', async () => {
    const { renderInvoicePdf } = await import('@/modules/pdf/invoice')

    const customer = await aCustomer({
      addressLine1: '4 Mill Lane',
      city: 'Bristol',
      postalCode: 'BS1 4TT',
    })
    const invoice = await anInvoiceFor(customer.id)

    const { bytes } = await renderInvoicePdf(fixture.ctx, invoice.id, new Date('2026-04-01T00:00:00Z'))
    const body = bytes.toString('latin1')

    expect(body).toContain('4 Mill Lane')
    expect(body).toContain('Bristol')
    expect(body).toContain('BS1 4TT')
  })

  it('stores an emptied field as nothing rather than as an empty string', async () => {
    // Otherwise every `is not null` check downstream — the PDF's address
    // block, the chase decision's "has an email" — reads a blank as a value.
    const customer = await aCustomer({ email: '   ', phone: '' })

    expect(customer.email).toBeNull()
    expect(customer.phone).toBeNull()
  })

  it('takes a vendor’s tax details at creation', async () => {
    const vendor = await createVendor(fixture.ctx, {
      name: 'Foxglove Cabinetry',
      taxId: '12-3456789',
      is1099Vendor: true,
      city: 'Bath',
    })

    expect(vendor.taxId).toBe('12-3456789')
    expect(vendor.is1099Vendor).toBe(true)
    expect(vendor.city).toBe('Bath')
  })
})

describe('correcting one', () => {
  /**
   * The gap this phase closes. A typo in an email meant that customer could
   * never be sent an invoice or a reminder, for ever, and the only escape was
   * a second record that split their history in two.
   */
  it('fixes a typo that would otherwise be permanent', async () => {
    const customer = await aCustomer({ email: 'ap@harboview.test' })

    const fixed = await updateCustomer(fixture.ctx, customer.id, {
      email: 'ap@harborview.test',
    })

    expect(fixed.email).toBe('ap@harborview.test')
  })

  it('changes only what it was asked about', async () => {
    const customer = await aCustomer({ phone: '555 0100', addressLine1: '4 Mill Lane' })

    const after = await updateCustomer(fixture.ctx, customer.id, { email: 'new@harborview.test' })

    // The commonest way an edit screen destroys data is blanking the columns
    // its form did not include.
    expect(after.phone).toBe('555 0100')
    expect(after.addressLine1).toBe('4 Mill Lane')
    expect(after.name).toBe('Harborview LLC')
  })

  /**
   * A name is a description. A document showing a stale spelling is showing
   * something that was never true — the same live-record argument ADR 0042
   * made about the balance.
   */
  it('renaming reaches every document that names them', async () => {
    const customer = await aCustomer()
    await anInvoiceFor(customer.id)

    await updateCustomer(fixture.ctx, customer.id, { name: 'Harborview Developments Ltd' })

    const [summary] = await listCustomerSummaries(fixture.ctx)
    expect(summary.name).toBe('Harborview Developments Ltd')
    expect(summary.documentCount).toBe(1)
  })

  /**
   * Payment terms are a default. The due date on an invoice already raised is
   * a fact somebody was told, and changing the default must not move it.
   */
  it('changing the terms does not move a due date already given', async () => {
    const customer = await aCustomer()
    const invoice = await anInvoiceFor(customer.id)

    await updateCustomer(fixture.ctx, customer.id, { paymentTermsDays: 90 })

    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.dueDate).toBe('2026-03-31')
  })

  it('refuses to leave somebody without a name', async () => {
    const customer = await aCustomer()
    await expect(
      updateCustomer(fixture.ctx, customer.id, { name: '   ' }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('refuses negative payment terms', async () => {
    const customer = await aCustomer()
    await expect(
      updateCustomer(fixture.ctx, customer.id, { paymentTermsDays: -5 }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('will not reach into another company’s records', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const theirs = await createCustomer(other.ctx, { name: 'Theirs' })

    await expect(
      updateCustomer(fixture.ctx, theirs.id, { name: 'Mine now' }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('is not something a reader can do', async () => {
    const customer = await aCustomer()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(
      updateCustomer(readonly, customer.id, { name: 'X' }),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('the audit trail', () => {
  /**
   * Changing a vendor's details is the commonest invoice-fraud vector a small
   * business meets: an email saying "our bank has changed", a quiet edit, and
   * the next payment run goes to a stranger. Before *and* after, which is the
   * whole reason to prefer an update over a delete and recreate.
   */
  it('records what a vendor’s details were, as well as what they became', async () => {
    const vendor = await createVendor(fixture.ctx, {
      name: 'Foxglove Cabinetry',
      email: 'accounts@foxglove.test',
    })

    await updateVendor(fixture.ctx, vendor.id, { email: 'payments@f0xglove.test' })

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, fixture.companyId), eq(auditEvents.action, 'vendor.update')),
      )

    expect(event).toBeDefined()
    expect(event.before).toMatchObject({ email: 'accounts@foxglove.test' })
    expect(event.after).toMatchObject({ email: 'payments@f0xglove.test' })
    expect(event.userId).toBe(fixture.ctx.userId)
  })

  /**
   * An untouched form saved is not a change. Writing one anyway fills the log
   * with noise and buries the edit that mattered.
   */
  it('writes nothing when nothing changed', async () => {
    const customer = await aCustomer()
    await updateCustomer(fixture.ctx, customer.id, {
      name: 'Harborview LLC',
      email: 'ap@harborview.test',
    })

    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, fixture.companyId), eq(auditEvents.action, 'customer.update')),
      )

    expect(events).toHaveLength(0)
  })

  it('records only the fields that moved', async () => {
    const customer = await aCustomer({ phone: '555 0100' })
    await updateCustomer(fixture.ctx, customer.id, {
      name: 'Harborview LLC',
      phone: '555 0200',
    })

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, fixture.companyId), eq(auditEvents.action, 'customer.update')),
      )

    expect(Object.keys(event.after as object)).toEqual(['phone'])
  })
})

describe('the list', () => {
  it('says what each of them owes and how much they have traded', async () => {
    const quiet = await createCustomer(fixture.ctx, { name: 'Aardvark Ltd' })
    const busy = await aCustomer()
    await anInvoiceFor(busy.id, 120_000)

    const summaries = await listCustomerSummaries(fixture.ctx)

    // Alphabetical, so a list of four hundred is navigable.
    expect(summaries.map((row) => row.name)).toEqual(['Aardvark Ltd', 'Harborview LLC'])

    const busyRow = summaries.find((row) => row.id === busy.id)!
    expect(busyRow.balanceCents).toBe(120_000)
    expect(busyRow.openDocuments).toBe(1)

    const quietRow = summaries.find((row) => row.id === quiet.id)!
    expect(quietRow.balanceCents).toBe(0)
    expect(quietRow.documentCount).toBe(0)
  })

  it('shows a vendor’s reporting position', async () => {
    await createVendor(fixture.ctx, {
      name: 'Foxglove Cabinetry',
      taxId: '12-3456789',
      is1099Vendor: true,
    })

    const [vendor] = await listVendorSummaries(fixture.ctx)
    expect(vendor.is1099Vendor).toBe(true)
    expect(vendor.taxId).toBe('12-3456789')
  })

  it('does not show another company’s people', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    await createCustomer(other.ctx, { name: 'Theirs' })
    await aCustomer()

    const mine = await listCustomerSummaries(fixture.ctx)
    expect(mine.map((row) => row.name)).toEqual(['Harborview LLC'])
  })
})

describe('one client, one record', () => {
  /**
   * The defect found by reseeding onto the new screen: the demo showed two
   * customers both called "Harborview Development LLC".
   *
   * `convertWonOpportunity` deduplicated only against a customer already
   * linked to the organization, so a client invoiced *before* they were won in
   * the CRM — the ordinary order of events for a repeat customer — got a
   * second record. Two records for one client split their aging, their
   * statement and their balance, and until this phase no screen existed on
   * which anybody could see it had happened.
   */
  it('adopts the accounting-side customer rather than making a second', async () => {
    const { createOrganization, createOpportunity } = await import('@/modules/crm/opportunities')
    const { convertWonOpportunity } = await import('@/modules/crm/conversion')

    // Invoiced first, on the accounting side, with no CRM link at all.
    const existing = await aCustomer({ name: 'Harborview Development LLC' })
    await anInvoiceFor(existing.id)

    const organization = await createOrganization(fixture.ctx, {
      name: 'Harborview Development LLC',
    })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Phase two',
      expectedValueCents: 500_000,
      stage: 'won',
    })
    await convertWonOpportunity(fixture.ctx, opportunity.id, { createInvoice: false })

    const summaries = await listCustomerSummaries(fixture.ctx)
    const named = summaries.filter((row) => row.name === 'Harborview Development LLC')

    expect(named).toHaveLength(1)
    // And it is the original, so the invoice raised before the win is still
    // theirs rather than stranded on an abandoned record.
    expect(named[0].id).toBe(existing.id)
    expect(named[0].documentCount).toBe(1)
  })

  /** A different client who happens to share a name is left alone. */
  it('does not adopt a customer already linked to another organization', async () => {
    const { createOrganization, createOpportunity } = await import('@/modules/crm/opportunities')
    const { convertWonOpportunity } = await import('@/modules/crm/conversion')

    const first = await createOrganization(fixture.ctx, { name: 'Delta Ltd' })
    const firstOpportunity = await createOpportunity(fixture.ctx, {
      organizationId: first.id,
      title: 'One',
      expectedValueCents: 100_000,
      stage: 'won',
    })
    await convertWonOpportunity(fixture.ctx, firstOpportunity.id, { createInvoice: false })

    const second = await createOrganization(fixture.ctx, { name: 'Delta Ltd' })
    const secondOpportunity = await createOpportunity(fixture.ctx, {
      organizationId: second.id,
      title: 'Two',
      expectedValueCents: 100_000,
      stage: 'won',
    })
    await convertWonOpportunity(fixture.ctx, secondOpportunity.id, { createInvoice: false })

    const named = (await listCustomerSummaries(fixture.ctx)).filter(
      (row) => row.name === 'Delta Ltd',
    )
    expect(named).toHaveLength(2)
  })
})

describe('retiring one', () => {
  it('archives somebody with nothing outstanding', async () => {
    const customer = await aCustomer()
    const result = await setCustomerActive(fixture.ctx, customer.id, false)

    expect(result.isActive).toBe(false)

    // Archived, not deleted: the record is still there.
    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id))
    expect(row).toBeDefined()
    expect(row.isActive).toBe(false)
  })

  /**
   * A customer hidden from every picker while still owing money is a debt
   * nobody will chase. The books stay right and the business quietly stops
   * collecting, which is the worst kind of wrong.
   */
  it('refuses while money is outstanding', async () => {
    const customer = await aCustomer()
    await anInvoiceFor(customer.id)

    await expect(
      setCustomerActive(fixture.ctx, customer.id, false),
    ).rejects.toBeInstanceOf(DomainError)

    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id))
    expect(row.isActive).toBe(true)
  })

  it('allows it once the debt is settled', async () => {
    const customer = await aCustomer()
    const invoice = await anInvoiceFor(customer.id)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 120_000,
      applications: [{ invoiceId: invoice.id, amountCents: 120_000 }],
    })

    const result = await setCustomerActive(fixture.ctx, customer.id, false)
    expect(result.isActive).toBe(false)
  })

  it('brings somebody back', async () => {
    const customer = await aCustomer()
    await setCustomerActive(fixture.ctx, customer.id, false)

    const result = await setCustomerActive(fixture.ctx, customer.id, true)
    expect(result.isActive).toBe(true)
  })

  it('refuses a vendor with a bill still open', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Foxglove Cabinetry' })
    const expense = await fixture.account('6400')

    const { createBill } = await import('@/modules/receivables/service')
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: expense.id, description: 'Materials', unitPriceCents: 40_000 }],
    })

    await expect(setVendorActive(fixture.ctx, vendor.id, false)).rejects.toBeInstanceOf(DomainError)
  })
})
