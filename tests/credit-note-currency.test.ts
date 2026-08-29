import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { creditNotes, invoices, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
} from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { applyCredit, createCreditNote } from '@/modules/receivables/credits'
import {
  applyVendorCredit,
  createVendorCredit,
} from '@/modules/receivables/vendor-credits'
import { convert } from '@/modules/fx/rates'

/**
 * The euro invoice you could not credit (Phase 63).
 *
 * `refuseForeign` stopped this dead from Phase 35 until now, so a business
 * invoicing in euro could not issue a credit note to a euro customer at all.
 * The refusal was honest — it declined to guess how to convert a multi-line
 * document — but the document engine had already decided that when it raised
 * the invoice, and reversing a document by different arithmetic than raised it
 * is the drift the refusal was guarding against.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string

/** 1.0835, chosen so line-by-line rounding is visible. */
const RATE = 1_083_500

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Credits Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: RATE,
    source: 'manual',
  })
})

async function aEuroInvoice(customerId: string, cents: number) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })
}

describe('crediting a euro invoice', () => {
  it('can be done at all', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('EUR')
    expect(row.totalCents).toBe(50_000)
  })

  /** Inherited, never chosen: the customer's ledger shows €500 against it. */
  it('takes the currency of the invoice it credits', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('EUR')
    expect(row.exchangeRateMillionths).toBe(RATE)
    expect(row.functionalTotalCents).toBe(convert(50_000, RATE))
  })

  /** Standalone — a goodwill gesture before the next invoice exists. */
  it('is in the company’s own currency when it credits nothing', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      lines: [{ chartAccountId: revenueId, description: 'Goodwill', unitPriceCents: 10_000 }],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('USD')
    expect(row.exchangeRateMillionths).toBe(1_000_000)
    expect(row.functionalTotalCents).toBe(10_000)
  })

  /**
   * The substance: the ledger is in the company's currency, and the entry has
   * to balance against the stored functional total exactly rather than to
   * within a cent. Three lines at a rate with four decimals is where converting
   * the total instead would show.
   */
  it('posts the ledger in the company’s currency, line by line', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [
        { chartAccountId: revenueId, description: 'One', unitPriceCents: 33_333 },
        { chartAccountId: revenueId, description: 'Two', unitPriceCents: 33_333 },
        { chartAccountId: revenueId, description: 'Three', unitPriceCents: 33_333 },
      ],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    const expected = 3 * convert(33_333, RATE)
    expect(row.functionalTotalCents).toBe(expected)

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, row.journalEntryId!))

    const debits = lines.reduce((sum, line) => sum + line.debitCents, 0)
    const credits = lines.reduce((sum, line) => sum + line.creditCents, 0)

    expect(debits).toBe(credits)
    expect(credits).toBe(expected)
  })

  it('takes the euro balance down in euro, and the ledger down at the invoice’s rate', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 50_000,
      appliedOn: '2026-06-16',
    })

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.balanceCents).toBe(350_000)
    // Relieved at the invoice's own rate, which is what keeps the control
    // account agreeing with the subledger.
    expect(row.functionalBalanceCents).toBe(convert(350_000, RATE))
  })

  /**
   * Found in the browser, not here: the credit note's `remaining_cents` went to
   * zero and `functional_remaining_cents` did not, so the receivables screen
   * offered $4,334.00 of credit that had already been spent.
   *
   * Both halves of what is left have to move together, or the note's own two
   * columns stop agreeing — the same defect this phase exists to close, one
   * column over.
   */
  it('spends both halves of what is left, not just the face amount', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 20_000,
      appliedOn: '2026-06-16',
    })

    const [part] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(part.remainingCents).toBe(30_000)
    expect(part.functionalRemainingCents).toBe(
      convert(50_000, RATE) - convert(20_000, RATE),
    )

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 30_000,
      appliedOn: '2026-06-17',
    })

    // Spent to the cent on both sides. The last application takes whatever
    // functional remainder is left, so rounding cannot strand one.
    const [done] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(done.remainingCents).toBe(0)
    expect(done.functionalRemainingCents).toBe(0)
    expect(done.status).toBe('applied')
  })

  /** The UI's own path: `applyImmediately` returns what it wrote, not what it read. */
  it('reports both halves spent when it applies itself on issue', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await aEuroInvoice(customer.id, 400_000)

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      applyImmediately: true,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    expect(note.remainingCents).toBe(0)
    expect(note.functionalRemainingCents).toBe(0)

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.remainingCents).toBe(0)
    expect(row.functionalRemainingCents).toBe(0)
  })
})

describe('a credit that does not match the document', () => {
  /** Phase 62's rule, one document over. */
  it('is refused, and says which document to raise it against', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const euro = await aEuroInvoice(customer.id, 400_000)
    const dollars = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 120_000 }],
    })

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: euro.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    await expect(
      applyCredit(fixture.ctx, {
        creditNoteId: note.id,
        invoiceId: dollars.id,
        amountCents: 50_000,
        appliedOn: '2026-06-16',
      }),
    ).rejects.toThrow(/is in EUR and .* is in USD/)
  })
})

describe('crediting a euro bill', () => {
  it('can be done, and posts in the company’s currency', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Bremen Hafenbau GmbH' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 400_000 }],
    })

    const note = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-15',
      billId: bill.id,
      lines: [{ chartAccountId: expenseId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('EUR')
    expect(row.functionalTotalCents).toBe(convert(50_000, RATE))

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, row.journalEntryId!))

    expect(lines.reduce((sum, line) => sum + line.debitCents, 0)).toBe(
      convert(50_000, RATE),
    )
  })

  it('spends against the euro bill it was raised on', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Bremen Hafenbau GmbH' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 400_000 }],
    })

    const note = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-15',
      billId: bill.id,
      lines: [{ chartAccountId: expenseId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    const result = await applyVendorCredit(fixture.ctx, {
      creditNoteId: note.id,
      billId: bill.id,
      amountCents: 50_000,
      appliedOn: '2026-06-16',
    })

    expect(result.creditRemainingCents).toBe(0)
    expect(result.creditFunctionalRemainingCents).toBe(0)

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.functionalRemainingCents).toBe(0)
  })
})

describe('an ordinary domestic credit note', () => {
  it('is byte for byte what it always was', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 200_000 }],
    })

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Returned', unitPriceCents: 50_000 }],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('USD')
    expect(row.totalCents).toBe(50_000)
    expect(row.functionalTotalCents).toBe(50_000)
    expect(row.exchangeRateMillionths).toBe(1_000_000)
  })
})
