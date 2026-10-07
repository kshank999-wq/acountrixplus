import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { invoiceLines, serviceItems } from '@/db/schema'
import { serviceRevenue } from '@/modules/crm/analytics'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { createServiceItem } from '@/modules/studio/service'
import { groupTimeIntoLines } from '@/modules/timebilling/billing'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * One name, and two references that were not (Phase 169).
 *
 * ADR 0168 nominated `service_item_id` on `invoice_lines`, *"which turns the
 * same question on realised revenue rather than on offers"*. Measuring that
 * nomination before building it found three things, each worse than the last:
 *
 * 1. **The column already existed**, as `invoice_lines.item_id`, since Phase
 *    14. Fourth false *reason* in this lineage — and the first written by the
 *    phase that had just spent four paragraphs on the cost of a claim nobody
 *    re-measured.
 * 2. **Phase 168 widened a naming split** it had not noticed: nine tables
 *    already said `item_id`, two said `service_item_id`, and Phase 168 made it
 *    three.
 * 3. **Nothing had ever written it.** Its only caller was
 *    `tests/inventory.test.ts`. So the inventory relief that column exists to
 *    trigger had never fired for a stocked item sold through the invoice
 *    composer, and no report could group revenue by product.
 *
 * And it was one of only two references to `service_items` in the whole schema
 * that was not a foreign key.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Okonjo Builders' })
})

// --- One name --------------------------------------------------------------

describe('one name for one reference', () => {
  it('leaves no column called service_item_id anywhere in the schema', () => {
    /**
     * Measured from the source rather than asserted about three tables, so a
     * fourth added later cannot reintroduce the split quietly.
     *
     * `item_id` wins because it is what nine tables already said, and because
     * it is the better name: `service_items` is the one catalogue of *both*
     * services and stocked goods, so a line selling a stocked product through a
     * column called `service_item_id` was always reading oddly.
     */
    const dir = 'src/db/schema'
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => readFileSync(join(dir, name), 'utf8').includes("'service_item_id'"))

    expect(offenders).toEqual([])
  })

  it('renamed the column rather than adding a second one', async () => {
    // A rename preserves the data; an add-and-backfill would have had to guess.
    const [row] = await db.execute(sql`
      select count(*) filter (where column_name = 'item_id') as item_id,
             count(*) filter (where column_name = 'service_item_id') as old_name
        from information_schema.columns
       where table_name in ('proposal_items', 'time_entries', 'appointments')
    `)

    expect(Number((row as { item_id: string }).item_id)).toBe(3)
    expect(Number((row as { old_name: string }).old_name)).toBe(0)
  })
})

// --- Two references that were not -----------------------------------------

describe('the two that were never foreign keys', () => {
  it('constrains item_id on both invoice and bill lines', async () => {
    /**
     * Of the twelve places this codebase points at `service_items`, these two
     * were the only ones that were not foreign keys — and they are the two that
     * matter most: `item_id` on an invoice line is what tells the invoice to
     * relieve inventory, and what any revenue-by-product report groups on.
     *
     * Phase 116: a constraint beats a check. There is nothing to remember once
     * the database refuses it.
     */
    const rows = await db.execute(sql`
      select conrelid::regclass::text as table_name
        from pg_constraint
       where contype = 'f'
         and conrelid in ('invoice_lines'::regclass, 'bill_lines'::regclass)
         and confrelid = 'service_items'::regclass
    `)

    const tables = (rows as unknown as Array<{ table_name: string }>)
      .map((row) => row.table_name)
      .sort()

    expect(tables).toEqual([
      'bill_lines',
      'invoice_lines',
    ])
  })

  it('refuses a line naming an item that does not exist', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })
    const revenue = await fixture.account('4000')

    const refused = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'A product that is not in the catalogue',
          unitPriceCents: 100_000,
          // A well-formed uuid that names nothing.
          itemId: '00000000-0000-4000-8000-000000000000',
        },
      ],
    }).then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name,
    )

    /*
      `invoice_lines_item_tenant_fk` since **Phase 170**, which replaced this
      single-column key with a composite one carrying the tenant — the whole
      point of that phase.

      This assertion kept the old name for nine phases and nine pushes, and
      Phase 179's full run is what found it. Worth stating plainly: for those
      nine phases nothing was checking that `invoice_lines` refuses an item from
      another company *by this route*. Phase 170's own test covers the same
      ground, so the guarantee held — the check on it did not.
    */
    expect(refused).toBe('invoice_lines_item_tenant_fk')
  })

  it('refuses another company’s catalogue item', async () => {
    /**
     * The case that degraded silently before. The stock path scopes its lookup
     * by company, so a foreign id simply found nothing and the line went
     * through — relieving no stock and attributing revenue to a product the
     * company does not own. The same shape Phase 160 found in `devices` and
     * `security_policies`.
     *
     * ## What this test used to say, and why that matters
     *
     * Written in Phase 169, it ended by asserting the line was **accepted**:
     *
     * > It is accepted, which is the honest finding: the key proves the row
     * > exists and says nothing about whose it is. A tenant predicate on the
     * > insert is the remaining gap and is nominated rather than claimed.
     *
     * **Phase 170 closed that gap**, which is what `invoice_lines_item_tenant_fk`
     * is — a composite key carrying the tenant, so the database refuses a line
     * naming another company's item. The nomination was taken up one phase
     * later and this test kept asserting the gap for nine.
     *
     * It is worth being precise about the shape of that, because it is not a
     * stale number. The assertion was **loudly wrong** from Phase 170 onward:
     * the insert threw, nothing caught it, and the test errored rather than
     * failing a comparison. Nine phases and nine pushes went past it, every one
     * of them running the tests near the code it changed.
     *
     * So this now asserts the protection rather than its absence — and the
     * assertion that was honest in Phase 169 is a quotation above instead of a
     * claim, because deleting it would erase the finding that earned Phase 170.
     */
    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const theirItem = await createServiceItem(other.ctx, {
      name: 'Their framing',
      unitPriceCents: 100_000,
    })

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })
    const revenue = await fixture.account('4000')

    const refused = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Framing',
          unitPriceCents: 100_000,
          itemId: theirItem.id,
        },
      ],
    }).then(
      () => undefined,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name,
    )

    // The database refuses it, by the composite key rather than by a check in
    // the service — a constraint beats a check (Phase 116), and it is the same
    // key that refuses the item which does not exist at all.
    expect(refused).toBe('invoice_lines_item_tenant_fk')

    // And nothing was written, which is the part a caught exception could still
    // have got wrong: the whole invoice rolls back with its line.
    const lines = await db
      .select({ itemId: invoiceLines.itemId })
      .from(invoiceLines)
      .where(eq(invoiceLines.companyId, fixture.companyId))

    expect(lines).toEqual([])

    /*
      What this test actually caught in Phase 169. The first draft of
      `serviceRevenue` joined the catalogue on `id` alone — `scoped(ctx, …)`
      guards the driving table and not the join — so the report came back
      labelled **"Their framing"**, putting another tenant's product name on
      this company's dashboard. `serviceBreakdown`, written in Phase 168, had
      the same unscoped join. Both are scoped.

      **That property still has to hold and this is no longer the way to test
      it.** Phase 170's composite key makes a cross-tenant `item_id`
      unstorable — `company_id` is `NOT NULL` on `invoice_lines`, so a non-null
      `item_id` always has both halves of the key and is always checked — and
      the assertion that used to live here needed the row the key now refuses.

      So the scoping is asserted from the other end, which is reachable: the
      other company raises an invoice against *its own* catalogue item, and this
      company's report must not contain it. An unscoped join leaks exactly that.
    */
    const theirCustomer = await createCustomer(other.ctx, { name: 'Their client' })
    const theirRevenue = await other.account('4000')
    await createInvoice(other.ctx, {
      customerId: theirCustomer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: theirRevenue.id,
          description: 'Their framing',
          unitPriceCents: 100_000,
          itemId: theirItem.id,
        },
      ],
    })

    expect(await serviceRevenue(fixture.ctx)).toEqual([])
    // And it is their revenue, not nobody's — a report that returned nothing
    // for everybody would pass the line above.
    expect((await serviceRevenue(other.ctx)).map((row) => row.label)).toEqual(['Their framing'])
  })

  it('keeps the unmatched-item label, which now accuses rather than reports', async () => {
    /**
     * `serviceRevenue` groups a line whose `item_id` joins nothing under **"Not
     * in this company's catalogue"**, and since Phase 170 that group cannot be
     * produced: the composite key refuses a foreign item and `ON DELETE SET
     * NULL` nulls a deleted one, so a non-null `item_id` always joins.
     *
     * Kept rather than deleted, on Phase 157's rule — *an unused declaration is
     * kept when it accuses and deleted when it excuses.* This one accuses: if
     * that label ever appears on a real report, a cross-tenant reference got
     * stored and the key that was supposed to stop it did not. It is the belt to
     * the constraint's braces.
     *
     * What this test can assert is the reachable half, and writing it found that
     * the two cases have **different labels**, which is the thing that makes
     * keeping the unreachable one worthwhile:
     *
     * - `item_id` null — a line nobody picked a catalogue entry for — groups
     *   under `uncatalogued` / *"Not from the catalogue"*. Ordinary, and the
     *   commonest row on the report.
     * - `item_id` non-null and joining nothing — *"Not in this company's
     *   catalogue"*. Unreachable, and an accusation if it ever appears.
     *
     * The first draft of this test asserted the no-item line was left out
     * entirely. It is not; it is labelled. Worth recording because the mistake
     * is the one the two labels exist to prevent — reading "not catalogued" and
     * "not ours" as one thing.
     */
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })
    const revenue = await fixture.account('4000')

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Labour, no catalogue entry',
          unitPriceCents: 50_000,
        },
      ],
    })

    const rows = await serviceRevenue(fixture.ctx)

    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('uncatalogued')
    expect(rows[0].label).toBe('Not from the catalogue')
    expect(rows[0].invoicedCents).toBe(50_000)

    // And not the accusing one, which is the distinction the two labels carry.
    expect(rows.map((row) => row.label)).not.toContain('Not in this company’s catalogue')
  })

  it('keeps the line when its catalogue item is deleted', async () => {
    // `set null`, matching `vehicles.item_id` and `time_entries.item_id`:
    // deleting a catalogue entry must not be blocked by an invoice raised three
    // years ago, and must not delete the line either.
    const item = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Marine' })
    const revenue = await fixture.account('4000')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Framing',
          unitPriceCents: 100_000,
          itemId: item.id,
        },
      ],
    })

    await db.delete(serviceItems).where(eq(serviceItems.id, item.id))

    const [line] = await db
      .select({ itemId: invoiceLines.itemId, description: invoiceLines.description })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))

    expect(line.description).toBe('Framing')
    expect(line.itemId).toBeNull()
  })
})

// --- Revenue by product, realised -----------------------------------------

describe('revenue by service, from a column nothing had ever written', () => {
  async function anInvoice(
    lines: Array<{ description: string; unitPriceCents: number; itemId?: string | null }>,
    opts: { currency?: string; issueDate?: string } = {},
  ) {
    const customer = await createCustomer(fixture.ctx, {
      name: `Client ${Math.random().toString(36).slice(2, 8)}`,
    })
    const revenue = await fixture.account('4000')

    return createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: opts.issueDate ?? '2026-06-01',
      currency: opts.currency,
      lines: lines.map((line) => ({
        chartAccountId: revenue.id,
        description: line.description,
        unitPriceCents: line.unitPriceCents,
        itemId: line.itemId ?? null,
      })),
    })
  }

  it('groups invoiced value by the item sold', async () => {
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      code: 'FRM',
      unitPriceCents: 200_000,
    })
    const roofing = await createServiceItem(fixture.ctx, {
      name: 'Roofing',
      code: 'ROF',
      unitPriceCents: 400_000,
    })

    await anInvoice([
      { description: 'Framing', unitPriceCents: 200_000, itemId: framing.id },
      { description: 'Roofing', unitPriceCents: 400_000, itemId: roofing.id },
    ])

    const rows = await serviceRevenue(fixture.ctx)

    expect(rows).toHaveLength(2)
    expect(rows[0].label).toBe('Roofing')
    expect(rows[0].code).toBe('ROF')
    expect(rows[0].invoicedCents).toBe(400_000)
    // Two thirds of 600,000.
    expect(rows[0].shareBp).toBe(6667)
    expect(rows[1].invoicedCents).toBe(200_000)
  })

  it('reports the lines that name no item rather than dropping them', async () => {
    // The same constraint `serviceBreakdown` honours: a report whose total
    // disagrees with the ledger is worse than one with an awkward row in it.
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    await anInvoice([
      { description: 'Framing', unitPriceCents: 100_000, itemId: framing.id },
      { description: 'A day on site', unitPriceCents: 50_000 },
    ])

    const rows = await serviceRevenue(fixture.ctx)
    const uncatalogued = rows.find((row) => row.key === 'uncatalogued')

    expect(uncatalogued?.label).toBe('Not from the catalogue')
    expect(uncatalogued?.invoicedCents).toBe(50_000)
    expect(rows.reduce((sum, row) => sum + row.invoicedCents, 0)).toBe(150_000)
  })

  it('leaves a void invoice out', async () => {
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })
    const invoice = await anInvoice([
      { description: 'Framing', unitPriceCents: 100_000, itemId: framing.id },
    ])

    const { invoices } = await import('@/db/schema')
    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id))

    expect(await serviceRevenue(fixture.ctx)).toEqual([])
  })

  it('respects the date range it is given', async () => {
    const framing = await createServiceItem(fixture.ctx, {
      name: 'Framing',
      unitPriceCents: 100_000,
    })

    await anInvoice(
      [{ description: 'Framing', unitPriceCents: 100_000, itemId: framing.id }],
      { issueDate: '2026-01-15' },
    )
    await anInvoice(
      [{ description: 'Framing', unitPriceCents: 300_000, itemId: framing.id }],
      { issueDate: '2026-06-15' },
    )

    const firstHalf = await serviceRevenue(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    })

    expect(firstHalf).toHaveLength(1)
    expect(firstHalf[0].invoicedCents).toBe(100_000)
  })
})

// --- The time entry that knew, and the line that forgot -------------------

describe('a time entry names the service, and now so does its invoice line', () => {
  const entry = (overrides: Partial<Parameters<typeof groupTimeIntoLines>[0][number]> = {}) => ({
    id: crypto.randomUUID(),
    userId: 'user-1',
    personName: 'Rivera',
    workedOn: '2026-06-01',
    minutes: 60,
    description: 'Site visit',
    itemId: null as string | null,
    rateCents: 10_000,
    amountCents: 10_000,
    rateSource: 'person' as const,
    ...overrides,
  })

  it('carries the item when every entry in the line agrees', () => {
    const [line] = groupTimeIntoLines(
      [entry({ itemId: 'svc-framing' }), entry({ itemId: 'svc-framing' })],
      'service',
    )

    expect(line.itemId).toBe('svc-framing')
  })

  it('names nothing when a line blends two services', () => {
    /**
     * The honest answer for a mixed group. Grouped by person or by day one line
     * can hold two different services, and naming either would attribute the
     * whole line's revenue to one of them — the same defect as grouping by a
     * typed description, arriving from the other direction.
     */
    const [line] = groupTimeIntoLines(
      [entry({ itemId: 'svc-framing' }), entry({ itemId: 'svc-roofing' })],
      'person',
    )

    expect(line.itemId).toBeNull()
  })

  it('names nothing when some entries name no service at all', () => {
    const [line] = groupTimeIntoLines(
      [entry({ itemId: 'svc-framing' }), entry({ itemId: null })],
      'person',
    )

    expect(line.itemId).toBeNull()
  })

  it('still sums to the same total however it is grouped', () => {
    // The property the module was built around, re-asserted because this phase
    // touched the grouping function.
    const rows = [
      entry({ itemId: 'svc-framing', amountCents: 10_000 }),
      entry({ itemId: 'svc-roofing', amountCents: 25_000 }),
    ]

    for (const grouping of ['person', 'day', 'service', 'single'] as const) {
      const total = groupTimeIntoLines(rows, grouping).reduce(
        (sum, line) => sum + line.amountCents,
        0,
      )
      expect(total, grouping).toBe(35_000)
    }
  })
})
