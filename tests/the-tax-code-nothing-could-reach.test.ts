import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createCompanyFixture } from './helpers'
import { db } from '@/db'
import { documentTaxLines } from '@/db/schema'
import { createCustomer, createInvoice, DocumentError } from '@/modules/receivables/service'
import {
  createTaxCode,
  listTaxCodes,
  quoteDocumentTax,
  salesTaxReturn,
  taxLinesFor,
} from '@/modules/payroll/sales-tax'
import { Refusal } from '@/modules/errors'
import { sourceFiles } from '@/modules/source/isolation-scan'
import { withoutComments } from '@/modules/source/enclosing'
import type { ActorContext } from '@/modules/tenancy/context'

/**
 * The tax code nothing could reach (Phase 209).
 *
 * ## The gap
 *
 * `createTaxCode`, `listTaxCodes`, `priceDocumentTax`, `recordDocumentTax` and
 * `salesTaxReturn` have been complete since Phase 2, and **nothing under
 * `src/app` had ever supplied a tax line.** `taxLines` appeared in no screen and
 * no action; the only writer of `document_tax_lines` was `db/seed.ts`. A company
 * could enter the codes it is registered for, see them listed on the sales tax
 * page, and never attach one to anything.
 *
 * Meanwhile the invoice composer took sales tax as one typed figure, which
 * credits 2200 Sales Tax Payable and records no breakdown at all. So on every
 * invoice the application itself raised, the ledger held the tax and the return
 * reported none of it — and the page prints the variance between those two
 * numbers, beside a warning that blamed the company for it.
 *
 * This is Phase 169's finding one table over: `invoice_lines.item_id` had
 * existed since Phase 14 with no writer but a test, and Phase 169 built the
 * screen that fills it. What let this one survive forty phases longer is that it
 * had **seed data** — the demo writes `document_tax_lines` through
 * `createInvoice`'s own API, so the page, the runbook step and the browser
 * verification all showed a working sales tax return.
 *
 * ## What is asserted here
 *
 * The chain, end to end, through the same function the action uses to build its
 * lines. Not the per-code rounding identity, which is
 * `tests/tax-that-foots-on-the-document.test.ts` and stays there — one register,
 * one home, which is the lesson Phases 204 to 208 paid for four times over.
 */

async function codes(ctx: ActorContext) {
  const city = await createTaxCode(ctx, {
    code: 'CITY',
    name: 'City sales tax',
    jurisdiction: 'Springfield City',
    rateBp: 825,
  })
  const state = await createTaxCode(ctx, {
    code: 'STATE',
    name: 'State sales tax',
    jurisdiction: 'State',
    rateBp: 400,
  })
  return { city, state }
}

/** One invoice line's worth of input, at the amount given. */
function line(chartAccountId: string, unitPriceCents: number) {
  return { chartAccountId, description: 'A day on site', unitPriceCents }
}

const PERIOD = { periodStart: '2026-08-01', periodEnd: '2026-08-31' }

describe('a tax code reaching an invoice', () => {
  it('writes the breakdown, and the return reports what the ledger holds', async () => {
    const fixture = await createCompanyFixture({ name: 'Cascade Supply' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    const { city, state } = await codes(fixture.ctx)

    // Built by `taxLinesFor` from amounts and code ids, which is exactly what
    // `createInvoiceAction` now does with the composer's lines.
    const taxLines = await taxLinesFor(fixture.ctx, [
      { amountCents: 320_000, taxCodeId: city.id },
      { amountCents: 160_000, taxCodeId: state.id },
    ])

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-05',
      lines: [line(revenue.id, 320_000), line(revenue.id, 160_000)],
      taxLines,
    })

    // 8.25% of 320,000 plus 4% of 160,000.
    expect(invoice.taxCents).toBe(26_400 + 6_400)
    expect(invoice.totalCents).toBe(480_000 + 32_800)

    const written = await db
      .select()
      .from(documentTaxLines)
      .where(
        and(
          eq(documentTaxLines.documentId, invoice.id),
          eq(documentTaxLines.documentType, 'invoice'),
        ),
      )

    expect(written).toHaveLength(2)
    // Frozen onto the line, so a later rate change cannot restate the return.
    expect(written.map((row) => row.rateBp).sort((a, b) => a - b)).toEqual([400, 825])

    const report = await salesTaxReturn(fixture.ctx, PERIOD)

    expect(report.lines.map((row) => row.jurisdiction)).toEqual(['Springfield City', 'State'])
    expect(report.totalTaxCollectedCents).toBe(32_800)
    expect(report.totalTaxableCents).toBe(480_000)

    /**
     * The whole point of the phase in one assertion.
     *
     * Both of these were guaranteed wrong for any invoice raised through the
     * application: nothing collected on the return, everything in the account,
     * and a warning saying the sales carried no code.
     */
    expect(report.ledgerBalanceCents).toBe(32_800)
    expect(report.varianceCents).toBe(0)
    expect(report.hasUncodedSales).toBe(false)
  })

  /**
   * The old path, kept and now visibly what it is.
   *
   * A lump total still works for a company that has not set codes up — it is
   * posted, it is owed, and it is in the account. What it is not is on a
   * return, and this says so in numbers rather than leaving it implied.
   */
  it('still takes a typed total, and shows it as uncoded', async () => {
    const fixture = await createCompanyFixture({ name: 'Lump Sum Ltd' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    await codes(fixture.ctx)

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-05',
      lines: [line(revenue.id, 480_000)],
      taxCents: 32_800,
    })

    const report = await salesTaxReturn(fixture.ctx, PERIOD)

    expect(report.totalTaxCollectedCents).toBe(0)
    expect(report.ledgerBalanceCents).toBe(32_800)
    expect(report.varianceCents).toBe(-32_800)
    expect(report.hasUncodedSales).toBe(true)
    expect(report.uncodedSalesCents).toBe(480_000)
  })
})

describe('two figures for one invoice’s tax', () => {
  /**
   * The precedence was backwards and silent (Phase 209).
   *
   * `const taxCents = input.taxCents ?? pricedTax?.totalCents ?? 0` — and `0`
   * is not nullish, so the composer's own `taxCents: parsed.tax || 0` would have
   * beaten every priced line it ever sent. The header would have read nothing
   * while `document_tax_lines` read the lot, which is the one thing `taxLines`'
   * docstring promises cannot happen.
   */
  it('refuses a typed total that disagrees with the codes', async () => {
    const fixture = await createCompanyFixture({ name: 'Two Answers Inc' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    const { city } = await codes(fixture.ctx)

    const taxLines = await taxLinesFor(fixture.ctx, [
      { amountCents: 320_000, taxCodeId: city.id },
    ])

    await expect(
      createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-08-05',
        lines: [line(revenue.id, 320_000)],
        taxCents: 0,
        taxLines,
      }),
    ).rejects.toThrow(DocumentError)

    // Both figures named, so somebody can see which one they meant (Phase 47).
    await expect(
      createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-08-05',
        lines: [line(revenue.id, 320_000)],
        taxCents: 0,
        taxLines,
      }),
    ).rejects.toThrow(/\$0\.00.*\$264\.00/)

    // Nothing was written by the attempt.
    const report = await salesTaxReturn(fixture.ctx, PERIOD)
    expect(report.totalTaxCollectedCents).toBe(0)
    expect(report.ledgerBalanceCents).toBe(0)
  })

  it('allows a total that agrees, because that is not two answers', async () => {
    const fixture = await createCompanyFixture({ name: 'One Answer Ltd' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    const { city } = await codes(fixture.ctx)

    const taxLines = await taxLinesFor(fixture.ctx, [
      { amountCents: 320_000, taxCodeId: city.id },
    ])

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-05',
      lines: [line(revenue.id, 320_000)],
      taxCents: 26_400,
      taxLines,
    })

    expect(invoice.taxCents).toBe(26_400)
  })
})

describe('an exempt code', () => {
  /**
   * The flag that no arithmetic read (Phase 209).
   *
   * `is_exempt` was written by one form, printed by one register, and consulted
   * by nothing that computes a figure — so a code marked exempt at 8.25%
   * charged 8.25%, while the checkbox beside it said *"sales tracked, no tax
   * charged"*. Neither census could see it: the column has a writer and a
   * reader. Nothing in the suite had ever created one.
   */
  it('cannot be created with a rate', async () => {
    const fixture = await createCompanyFixture({ name: 'Exempt Co' })

    await expect(
      createTaxCode(fixture.ctx, {
        code: 'RESALE',
        name: 'Sold for resale',
        jurisdiction: 'City',
        rateBp: 825,
        isExempt: true,
      }),
    ).rejects.toThrow(Refusal)

    // The refusal names both ways out (Phase 47).
    await expect(
      createTaxCode(fixture.ctx, {
        code: 'RESALE',
        name: 'Sold for resale',
        jurisdiction: 'City',
        rateBp: 825,
        isExempt: true,
      }),
    ).rejects.toThrow(/8\.25%/)
  })

  it('reports its sales as exempt and charges nothing', async () => {
    const fixture = await createCompanyFixture({ name: 'Exempt Co' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    const { city } = await codes(fixture.ctx)

    const resale = await createTaxCode(fixture.ctx, {
      code: 'RESALE',
      name: 'Sold for resale',
      jurisdiction: 'City',
      rateBp: 0,
      isExempt: true,
    })

    // Routed by the code, not asked of the caller — which is only safe because
    // an exempt code has no rate, so the two fields cannot disagree about what
    // was charged.
    const taxLines = await taxLinesFor(fixture.ctx, [
      { amountCents: 320_000, taxCodeId: city.id },
      { amountCents: 60_000, taxCodeId: resale.id },
    ])

    expect(taxLines).toEqual([
      { taxCodeId: city.id, taxableCents: 320_000, exemptCents: 0 },
      { taxCodeId: resale.id, taxableCents: 0, exemptCents: 60_000 },
    ])

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-05',
      lines: [line(revenue.id, 320_000), line(revenue.id, 60_000)],
      taxLines,
    })

    expect(invoice.taxCents).toBe(26_400)

    const report = await salesTaxReturn(fixture.ctx, PERIOD)

    // §13 asks for both, and an exempt sale is a sale somebody billed rather
    // than a figure hung on another code's line.
    expect(report.totalTaxableCents).toBe(320_000)
    expect(report.totalExemptCents).toBe(60_000)
    expect(report.totalTaxCollectedCents).toBe(26_400)
  })

  /** A line under no code at all is simply not a tax line. */
  it('leaves an uncoded line out of the breakdown', async () => {
    const fixture = await createCompanyFixture({ name: 'Partly Coded Ltd' })
    const { city } = await codes(fixture.ctx)

    expect(
      await taxLinesFor(fixture.ctx, [
        { amountCents: 320_000, taxCodeId: city.id },
        { amountCents: 100_000, taxCodeId: null },
        { amountCents: 50_000 },
      ]),
    ).toEqual([{ taxCodeId: city.id, taxableCents: 320_000, exemptCents: 0 }])

    expect(await taxLinesFor(fixture.ctx, [{ amountCents: 100_000 }])).toEqual([])
  })
})

describe('what the composer is told before it commits', () => {
  /**
   * The quote is the posting's own arithmetic (Phase 209).
   *
   * Asked of the server for the reason `quoteDocument` is (Phase 64): the
   * rounding is once per code on the code's combined base, and a composer that
   * worked it out in the browser would be a second answer to what the invoice
   * charged — the defect Phase 145 found in the core itself.
   *
   * The identity between the two is what is asserted. That `taxPerCode` is the
   * right arithmetic is `tests/tax-that-foots-on-the-document.test.ts`, and
   * asserting it twice would be the duplication Phases 204 to 208 kept paying
   * for.
   */
  it('quotes the figure the invoice will actually charge', async () => {
    const fixture = await createCompanyFixture({ name: 'Quoted Ltd' })
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bracken & Co' })
    const { city } = await codes(fixture.ctx)

    // Two lines under one code, where per-line rounding gives 166 and the
    // code's own base gives 165.
    const composed = [
      { amountCents: 1_000, taxCodeId: city.id },
      { amountCents: 1_000, taxCodeId: city.id },
    ]

    const quoted = await quoteDocumentTax(fixture.ctx, composed)

    expect(quoted.byCode).toEqual([
      {
        code: 'CITY',
        jurisdiction: 'Springfield City',
        rateBp: 825,
        taxableCents: 2_000,
        exemptCents: 0,
        taxCents: 165,
      },
    ])

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-05',
      lines: [line(revenue.id, 1_000), line(revenue.id, 1_000)],
      taxLines: await taxLinesFor(fixture.ctx, composed),
    })

    expect(invoice.taxCents).toBe(quoted.totalCents)
  })

  it('says nothing when no line carries a code', async () => {
    const fixture = await createCompanyFixture({ name: 'Uncoded Ltd' })

    expect(await quoteDocumentTax(fixture.ctx, [{ amountCents: 100_000 }])).toEqual({
      totalCents: 0,
      byCode: [],
    })
  })

  /**
   * `tax:view`, which is not the same permission as raising an invoice.
   *
   * A reader without it is given `null` rather than an empty list, so the
   * composer hides the picker *and* makes no claim about what the invoice is
   * taxed under. An empty list would have hidden the control and still implied
   * there was nothing to choose.
   */
  it('is refused to a role that may not see the company’s codes', async () => {
    const fixture = await createCompanyFixture({ name: 'Scoped Ltd', role: 'sales' })

    await expect(quoteDocumentTax(fixture.ctx, [{ amountCents: 1_000 }])).rejects.toThrow()
  })
})

describe('the screen that was missing', () => {
  const action = readFileSync('src/app/actions/documents.ts', 'utf8')
  const page = readFileSync('src/app/accounting/invoices/page.tsx', 'utf8')
  const board = readFileSync('src/app/accounting/invoices/board.tsx', 'utf8')

  /**
   * The measurement that found this phase.
   *
   * ADR 0208 nominated the four remaining `activeOnly` opt-in defaults, headed
   * by `listEmployees` on the grounds that a departed employee could appear in
   * a payroll run picker. Read: `listEmployees` has three callers — the people
   * register, `createPayrollRun`'s validation and the run page — and the run
   * page passes the flag. All eight call sites across the four functions were
   * already correct, so the unsafe default had never once been taken.
   *
   * What the reading did turn up was `listTaxCodes` with **one** caller, a
   * register, and no picker anywhere — which is how this phase was found.
   */
  it('offers a tax code on an invoice line', () => {
    expect(action).toContain('taxCodeId: uuid.optional()')
    expect(action).toContain('taxLinesFor')
    expect(board).toContain('tax code')
    expect(board).toContain('quoteDocumentTaxAction')
  })

  it('reads the codes active-only, and as a list or null', () => {
    expect(page).toContain("listTaxCodes(actor, { activeOnly: true })")
    expect(page).toContain("can(actor, 'tax:view')")
    expect(board).toContain('taxCodes: TaxCode[] | null')
  })

  /**
   * `taxLines` reaches the core from a screen now.
   *
   * The literal absence of this string under `src/app` is what the gap *was*,
   * so its presence is the one assertion that would have failed in every one of
   * the 208 phases before this.
   */
  it('passes a breakdown from the composer to the core', () => {
    expect(action).toContain('taxLines:')
  })

  /** One tax on the form: the typed box is gone when the lines carry codes. */
  it('does not offer a typed total beside a breakdown', () => {
    expect(board).toContain('coded ?')
    expect(board).toContain("tax: coded ? '' : tax")
  })
})

describe('the flag that filters on a column nothing can set', () => {
  /**
   * What measuring ADR 0208's nomination actually found (Phase 209).
   *
   * The nomination's headline was that *"an employee who has left appearing in
   * a payroll run picker is the same class of defect as a closed bank account
   * on a refund"*. The run page already passes `activeOnly: true`. But
   * `employees` has **one insert and no update anywhere**, so `is_active` and
   * `end_date` have no writer and an employee cannot be recorded as having
   * left: the flag is passed correctly and does nothing. `tax_codes` is the
   * same, which is why this phase's new picker says so in its own comment.
   *
   * So the nominated defect is real and the nominated cause is wrong — the
   * eighth consecutive phase whose nomination changed under measurement, and
   * the first where what changed was the *mechanism* rather than the count or
   * the premise.
   *
   * **Neither is a column census finding**, and that is the part worth pinning.
   * A column is a candidate only when something *names* it as `table.column`,
   * and both list functions select every row and filter in JavaScript on
   * `row.isActive` — so the string the scan looks for is never written. Phase
   * 202 narrowed this register's default exclusion and closed *"all six
   * `isActive` switches"* it exposed; these two were never exposed at all.
   *
   * Asserted as source rather than described, so a retire control arriving
   * makes this red instead of leaving the declaration quietly false.
   */
  it('has no way to retire a tax code or an employee', () => {
    const everySource = sourceFiles('src/modules')
      .concat(sourceFiles('src/app'))
      .map((file) => withoutComments(readFileSync(file, 'utf8')))
      .join('\n')

    expect(everySource).not.toContain('.update(taxCodes)')
    expect(everySource).not.toContain('.update(employees)')

    // And the filter really is in JavaScript, which is why the scan cannot see
    // the columns those updates would have written.
    expect(everySource).toContain('opts.activeOnly ? rows.filter((row) => row.isActive) : rows')
    expect(everySource).not.toContain('taxCodes.isActive')
    expect(everySource).not.toContain('employees.isActive')
  })
})

describe('the codes a composer may be offered', () => {
  it('leaves a retired code off the picker and keeps it on the register', async () => {
    const fixture = await createCompanyFixture({ name: 'Retired Code Ltd' })
    const { city } = await codes(fixture.ctx)

    // Retired straight in the table: the register has no retire control, which
    // is a separate gap and is declared rather than quietly fixed here.
    await db.execute(sql`update tax_codes set is_active = false where id = ${city.id}`)

    expect((await listTaxCodes(fixture.ctx)).map((row) => row.code).sort()).toEqual([
      'CITY',
      'STATE',
    ])
    expect(
      (await listTaxCodes(fixture.ctx, { activeOnly: true })).map((row) => row.code),
    ).toEqual(['STATE'])
  })
})
