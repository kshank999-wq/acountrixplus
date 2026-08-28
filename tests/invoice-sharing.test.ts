import { describe, expect, it } from 'vitest'
import {
  customerFacingInvoice,
  invoiceSubject,
  sendability,
  type CompanyFacts,
  type InvoiceFacts,
  type LineFacts,
} from '@/modules/receivables/sharing'

/**
 * What a customer holding a link may see (Phase 42).
 *
 * The pure half. The page is unauthenticated — whoever has the link is looking
 * at it — so the interesting assertions are about what does *not* come out.
 */

const invoice = (over: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  number: 'INV-1001',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  status: 'open',
  currency: 'USD',
  subtotalCents: 120_000,
  taxCents: 0,
  totalCents: 120_000,
  balanceCents: 120_000,
  memo: 'Thank you.',
  ...over,
})

const line: LineFacts = {
  description: 'Kitchen refit, week one',
  quantityMilli: 3000,
  unitPriceCents: 40_000,
  amountCents: 120_000,
}

const company: CompanyFacts = {
  name: 'Ridgeline Construction',
  email: 'accounts@ridgeline.test',
  phone: '555 0100',
  addressLine: '4 Mill Lane',
}

const customer = { name: 'Harborview LLC', email: 'ap@harborview.test' }

describe('customerFacingInvoice', () => {
  it('shows the customer what they need to pay', () => {
    const view = customerFacingInvoice({
      invoice: invoice(),
      lines: [line],
      customer,
      company,
      asOf: '2026-03-15',
    })

    expect(view.number).toBe('INV-1001')
    expect(view.totalCents).toBe(120_000)
    expect(view.balanceCents).toBe(120_000)
    expect(view.customerName).toBe('Harborview LLC')
    expect(view.lines).toHaveLength(1)
  })

  /**
   * The assertion the whole module exists for. Built as an allowlist, so a
   * field added to the invoice in a later phase cannot appear on a stranger's
   * screen because nobody remembered to remove it.
   */
  it('carries nothing beyond the fields it names, even when handed more', () => {
    const view = customerFacingInvoice({
      invoice: {
        ...invoice(),
        // The kind of thing a later phase adds and nobody thinks about.
        internalNotes: 'Chase hard, they always pay late',
        marginBp: 4200,
        costCodeId: 'cc-1',
        createdBy: 'user-1',
      } as InvoiceFacts,
      lines: [{ ...line, projectId: 'job-1', costCodeId: 'cc-1' } as LineFacts],
      customer,
      company,
      asOf: '2026-03-15',
    })

    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain('Chase hard')
    expect(serialised).not.toContain('marginBp')
    expect(serialised).not.toContain('costCodeId')
    expect(serialised).not.toContain('createdBy')
    expect(serialised).not.toContain('job-1')
  })

  it('does not leak the customer’s own email back onto the page', () => {
    // The page is reached by a link that anybody may forward. Reprinting the
    // address it was sent to hands one more thing to whoever has it.
    const view = customerFacingInvoice({
      invoice: invoice(),
      lines: [line],
      customer,
      company,
      asOf: '2026-03-15',
    })

    expect(JSON.stringify(view)).not.toContain('ap@harborview.test')
  })

  it('says what is paid and what is left', () => {
    const view = customerFacingInvoice({
      invoice: invoice({ balanceCents: 20_000 }),
      lines: [line],
      customer,
      company,
      asOf: '2026-03-15',
    })

    expect(view.paidCents).toBe(100_000)
    expect(view.balanceCents).toBe(20_000)
    expect(view.isSettled).toBe(false)
  })

  it('reads as settled when nothing is left', () => {
    const view = customerFacingInvoice({
      invoice: invoice({ balanceCents: 0 }),
      lines: [line],
      customer,
      company,
      asOf: '2027-01-01',
    })

    expect(view.isSettled).toBe(true)
    // Settled is never overdue, whatever the date says.
    expect(view.isOverdue).toBe(false)
  })

  it('reads as overdue only once the due date has passed with money outstanding', () => {
    const base = { lines: [line], customer, company }

    expect(customerFacingInvoice({ ...base, invoice: invoice(), asOf: '2026-03-30' }).isOverdue).toBe(
      false,
    )
    expect(customerFacingInvoice({ ...base, invoice: invoice(), asOf: '2026-04-01' }).isOverdue).toBe(
      true,
    )
  })

  it('never shows a negative balance', () => {
    // An over-application elsewhere is not the customer's problem to read.
    const view = customerFacingInvoice({
      invoice: invoice({ balanceCents: -500 }),
      lines: [line],
      customer,
      company,
      asOf: '2026-03-15',
    })

    expect(view.balanceCents).toBe(0)
    expect(view.paidCents).toBe(120_000)
  })
})

describe('sendability', () => {
  it('sends to the address on file', () => {
    expect(sendability({ invoice: invoice(), customer })).toEqual({
      ok: true,
      to: 'ap@harborview.test',
    })
  })

  it('prefers an address typed on the form', () => {
    const result = sendability({ invoice: invoice(), customer, override: 'boss@harborview.test' })
    expect(result).toEqual({ ok: true, to: 'boss@harborview.test' })
  })

  /**
   * "Send" that appears to work and does nothing is the worst outcome here:
   * the business believes the customer has been asked for the money.
   */
  it('refuses, with the sentence to show, when there is nowhere to send it', () => {
    const result = sendability({ invoice: invoice(), customer: { name: 'Nobody', email: null } })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('no email address')
    expect(result.ok === false && result.reason).toContain('Get link')
  })

  it('refuses a voided invoice', () => {
    const result = sendability({ invoice: invoice({ status: 'void' }), customer })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('voided')
  })

  it('refuses a draft', () => {
    const result = sendability({ invoice: invoice({ status: 'draft' }), customer })
    expect(result.ok).toBe(false)
  })

  it('refuses an invoice worth nothing', () => {
    const result = sendability({ invoice: invoice({ totalCents: 0 }), customer })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('nothing on this invoice')
  })

  /**
   * A settled invoice still sends: a receipt is a real thing to want, and the
   * page says it is settled.
   */
  it('still sends one that has been paid', () => {
    expect(sendability({ invoice: invoice({ balanceCents: 0, status: 'paid' }), customer }).ok).toBe(
      true,
    )
  })

  it('rejects something that is plainly not an address, and nothing subtler', () => {
    expect(sendability({ invoice: invoice(), customer, override: 'not-an-address' }).ok).toBe(false)
    expect(sendability({ invoice: invoice(), customer, override: '@nope' }).ok).toBe(false)

    // Deliberately permissive: the provider is the authority on deliverability,
    // and a clever regex refuses real addresses.
    expect(sendability({ invoice: invoice(), customer, override: 'a+b@c.example' }).ok).toBe(true)
    expect(sendability({ invoice: invoice(), customer, override: "o'brien@c.example" }).ok).toBe(true)
  })

  it('trims what somebody pasted', () => {
    const result = sendability({ invoice: invoice(), customer, override: '  ap@harborview.test  ' })
    expect(result).toEqual({ ok: true, to: 'ap@harborview.test' })
  })
})

describe('invoiceSubject', () => {
  it('names the company and the invoice', () => {
    expect(invoiceSubject({ companyName: 'Ridgeline', number: 'INV-1001', isReminder: false })).toBe(
      'Invoice INV-1001 from Ridgeline',
    )
  })

  it('says so when it is the second time of asking', () => {
    expect(invoiceSubject({ companyName: 'Ridgeline', number: 'INV-1001', isReminder: true })).toBe(
      'Reminder: invoice INV-1001 from Ridgeline',
    )
  })
})
