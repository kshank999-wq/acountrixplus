import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bills, invoices, serviceItems } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createVendor } from '@/modules/receivables/service'
import { receiveStock } from '@/modules/inventory/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import {
  commitOpenDocumentImport,
  planOpenDocumentImport,
} from '@/modules/importing/opening-balances'

/**
 * A control account and the subledger behind it, pulled apart from both sides
 * (Phase 117).
 *
 * ADR 0031 wrote down what this failure looks like:
 *
 * > The balance sheet says £365 is owed; the aging report says nothing is owed;
 * > both are internally consistent, and neither mentions the other.
 *
 * It found the split coming from the **ledger** side — appointments and repair
 * orders posting `Dr 1100` with no invoice behind it. Two more were live:
 *
 * - **From the ledger side again.** `receiveStock` takes its credit account
 *   from the caller and refused nothing, so this repository's own seed credited
 *   `2000 Accounts Payable` on four receipts. Kestrel Fabrication owed $3,030
 *   on its balance sheet and $0.00 on its payables report; Ashgrove Motors
 *   $180.00 against $0.00.
 * - **From the subledger side.** `insertOpeningInvoice` and
 *   `insertOpeningBill` never set the functional columns, so every document the
 *   migration wizard created was worth **zero** to everything that reads them —
 *   the control-account check, the aging report, statements, chasing.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Thornbury Works', industry: 'retail' })
})

describe('stock cannot be received against a control account', () => {
  const anItem = async () => {
    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Steel sheet, 2mm',
        unit: 'sheet',
        unitPriceCents: 6_000,
        isInventoried: true,
        chartAccountId: (await fixture.account('4000')).id,
        inventoryAccountId: (await fixture.account('1400')).id,
      })
      .returning()

    return item.id
  }

  it('refuses Accounts Payable, naming it and saying where it should go', async () => {
    // What the seed did four times. Before this phase it succeeded, and left
    // money on the balance sheet with no bill, no supplier and no due date.
    const payable = await fixture.account('2000')

    await expect(
      receiveStock(fixture.ctx, {
        itemId: await anItem(),
        quantityMilli: 10_000,
        unitCostCents: 4_000,
        receivedOn: '2026-02-10',
        creditAccountId: payable.id,
      }),
    ).rejects.toThrow(/2000 Accounts Payable/)
  })

  it('still receives against Goods Received Not Invoiced', async () => {
    // The purchase-order path's account, and the one the refusal points at.
    const grni = await fixture.account('2050')

    const { costCents } = await receiveStock(fixture.ctx, {
      itemId: await anItem(),
      quantityMilli: 10_000,
      unitCostCents: 4_000,
      receivedOn: '2026-02-10',
      creditAccountId: grni.id,
    })

    expect(costCents).toBe(40_000)
  })

  it('leaves both control accounts agreeing afterwards', async () => {
    const grni = await fixture.account('2050')
    await receiveStock(fixture.ctx, {
      itemId: await anItem(),
      quantityMilli: 10_000,
      unitCostCents: 4_000,
      receivedOn: '2026-02-10',
      creditAccountId: grni.id,
    })

    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })
    expect(report.agrees).toBe(true)
  })
})

describe('what the migration wizard brings across', () => {
  const importDocuments = async (kind: 'open_invoices' | 'open_bills', text: string) => {
    const plan = await planOpenDocumentImport(fixture.ctx, { kind, text })
    expect(plan.canCommit, JSON.stringify(plan.counts)).toBe(true)
    return commitOpenDocumentImport(fixture.ctx, kind, plan)
  }

  it('gives an imported invoice the value the rest of the system reads', async () => {
    // Before this phase both functional columns defaulted to zero, so the
    // control-account check, the aging report, statements and chasing all
    // valued a migrated invoice at nothing. An opening balance carries no
    // currency of its own, so the rate is one and the two figures coincide.
    await createCustomer(fixture.ctx, { name: 'Halewood Joinery' })
    await importDocuments(
      'open_invoices',
      'Customer,Invoice No,Date,Due Date,Open Balance\nHalewood Joinery,INV-9001,01/15/2026,02/14/2026,"5,200.00"',
    )

    const [row] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))

    expect(row.balanceCents).toBe(520_000)
    expect(row.functionalBalanceCents).toBe(520_000)
    expect(row.functionalTotalCents).toBe(520_000)
  })

  it('gives an imported bill the same', async () => {
    await createVendor(fixture.ctx, { name: 'Pennine Timber' })
    await importDocuments(
      'open_bills',
      'Vendor,Bill No,Date,Open Balance\nPennine Timber,B-9001,01/20/2026,"1,400.00"',
    )

    const [row] = await db.select().from(bills).where(eq(bills.companyId, fixture.companyId))

    expect(row.balanceCents).toBe(140_000)
    expect(row.functionalBalanceCents).toBe(140_000)
    expect(row.functionalTotalCents).toBe(140_000)
  })

  it('leaves a migrated company reconciling on its first day', async () => {
    // The consequence, and the reason this mattered: before the repair a
    // company that migrated in had receivables on its balance sheet, an aging
    // report showing nothing, and a nightly fault it could do nothing about.
    await createCustomer(fixture.ctx, { name: 'Halewood Joinery' })
    await createVendor(fixture.ctx, { name: 'Pennine Timber' })

    await importDocuments(
      'open_invoices',
      'Customer,Invoice No,Date,Due Date,Open Balance\nHalewood Joinery,INV-9001,01/15/2026,02/14/2026,"5,200.00"',
    )
    await importDocuments(
      'open_bills',
      'Vendor,Bill No,Date,Open Balance\nPennine Timber,B-9001,01/20/2026,"1,400.00"',
    )

    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })

    expect(report.receivables.ledgerCents).toBe(520_000)
    expect(report.receivables.subledgerCents).toBe(520_000)
    expect(report.payables.ledgerCents).toBe(140_000)
    expect(report.payables.subledgerCents).toBe(140_000)
    expect(report.agrees).toBe(true)
  })
})
