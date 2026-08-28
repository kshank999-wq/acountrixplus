import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { goodsReceipts, serviceItems } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { setModuleEnabled } from '@/modules/industry/modules'
import { createBill, createVendor, DocumentError } from '@/modules/receivables/service'
import { receiveGoods, unbilledReceipts } from '@/modules/inventory/purchasing'
import { billReceipts, unbilledReceiptValue } from '@/modules/payables/receipt-billing'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { runIntegrityChecks } from '@/modules/integrity/service'

/**
 * The bill for goods you already have (Phase 48).
 *
 * The claim under test: **the cost is recognised once.** Receiving stock debits
 * Inventory and credits Goods Received Not Invoiced; the supplier's bill debits
 * that account and credits Accounts Payable. Until this phase the bill could
 * not name 2050 at all — it is a liability and a bill line may only name an
 * expense, COGS or asset account — so the cost went in twice and 2050 grew for
 * ever with nothing able to debit it.
 */

let fixture: Fixture
let itemId: string
let vendorId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Yard Co', industry: 'retail' })
  await setModuleEnabled(fixture.ctx, 'inventory', true)

  const revenue = await fixture.account('4000')
  const [item] = await db
    .insert(serviceItems)
    .values({
      companyId: fixture.companyId,
      code: 'TIMBER',
      name: 'Timber',
      unit: 'm',
      unitPriceCents: 4_000,
      unitCostCents: 2_000,
      isInventoried: true,
      chartAccountId: revenue.id,
    })
    .returning()

  itemId = item.id
  vendorId = (await createVendor(fixture.ctx, { name: 'Cascade Timber' })).id
})

/** Takes delivery of `quantity` metres at `unitCost`, and returns the receipt. */
async function aDelivery(quantityMilli = 5_000, unitCostCents = 2_000, on = '2026-08-03') {
  const receipt = await receiveGoods(fixture.ctx, {
    vendorId,
    receivedOn: on,
    lines: [{ itemId, quantityMilli, unitCostCents }],
  })

  return receipt
}

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

describe('taking delivery', () => {
  it('puts the goods on the shelf and the debt in the clearing account', async () => {
    await aDelivery()

    expect(await balanceOf('1400')).toBe(10_000)
    // Signed in the account's normal direction, so a liability holding a
    // credit balance reads positive.
    expect(await balanceOf('2050')).toBe(10_000)
  })
})

describe('billing what arrived', () => {
  /**
   * The whole phase in one assertion. Before it, this bill had to be coded to
   * Inventory or an expense — so 1400 read 20,000 for 10,000 of timber, and
   * 2050 stayed at 10,000 for ever.
   */
  it('recognises the cost once', async () => {
    const receipt = await aDelivery()

    const result = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
      vendorReference: 'INV-88',
    })

    expect(result.clearedCents).toBe(10_000)
    expect(result.varianceCents).toBe(0)
    expect(result.notice).toBeNull()

    // The timber is on the shelf once, the clearing account is empty, and the
    // supplier is owed.
    expect(await balanceOf('1400')).toBe(10_000)
    expect(await balanceOf('2050')).toBe(0)
    expect(await balanceOf('2000')).toBe(10_000)
  })

  it('marks the delivery billed, so it stops asking to be', async () => {
    const receipt = await aDelivery()
    expect(await unbilledReceipts(fixture.ctx)).toHaveLength(1)

    await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
    })

    expect(await unbilledReceipts(fixture.ctx)).toHaveLength(0)
    const [row] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.id, receipt.id))
    expect(row.billId).not.toBeNull()
  })

  it('settles several deliveries on one invoice', async () => {
    const first = await aDelivery(5_000, 2_000, '2026-08-03')
    const second = await aDelivery(3_000, 2_000, '2026-08-05')

    const result = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [first.id, second.id],
      billedCents: 16_000,
      issueDate: '2026-08-07',
    })

    expect(result.clearedCents).toBe(16_000)
    expect(await balanceOf('2050')).toBe(0)
  })
})

describe('when the invoice and the delivery disagree', () => {
  /**
   * Phase 14's comment said the difference should stay in 2050 "as a visible
   * residue". It is not visible: a residue there is indistinguishable from a
   * delivery nobody has billed, and a clearing account that cannot be
   * reconciled to a list is a suspense account with a nicer name.
   */
  it('clears what went in and puts the difference on the profit and loss', async () => {
    const receipt = await aDelivery()

    const result = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 10_400,
      issueDate: '2026-08-07',
    })

    expect(result.clearedCents).toBe(10_000)
    expect(result.varianceCents).toBe(400)

    // The timber is still carried at what it was taken in at.
    expect(await balanceOf('1400')).toBe(10_000)
    // The clearing account is empty, not holding a residue.
    expect(await balanceOf('2050')).toBe(0)
    // The difference is a cost of buying, where somebody will see it.
    expect(await balanceOf('5450')).toBe(400)
    // And the supplier is owed what they asked for.
    expect(await balanceOf('2000')).toBe(10_400)
  })

  /**
   * The other direction needs a *credit* to variance, and a bill line is always
   * a debit — `journal_lines_single_side` refuses a negative one, correctly.
   * That is why the difference is its own entry rather than a second bill line.
   */
  it('handles an undercharge the same way, in the other direction', async () => {
    const receipt = await aDelivery()

    const result = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 9_600,
      issueDate: '2026-08-07',
    })

    expect(result.varianceCents).toBe(-400)
    expect(await balanceOf('1400')).toBe(10_000)
    expect(await balanceOf('2050')).toBe(0)
    expect(await balanceOf('5450')).toBe(-400)
    expect(await balanceOf('2000')).toBe(9_600)
  })

  it('is quiet about a rounding difference and speaks up about a real one', async () => {
    const small = await aDelivery(5_000, 2_000, '2026-08-03')
    const quiet = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [small.id],
      billedCents: 10_030,
      issueDate: '2026-08-07',
    })
    expect(quiet.varianceCents).toBe(30)
    expect(quiet.notice).toBeNull()

    const big = await aDelivery(5_000, 2_000, '2026-08-10')
    const loud = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [big.id],
      billedCents: 11_000,
      issueDate: '2026-08-14',
    })
    expect(loud.notice).toContain('purchase price variance')
  })
})

describe('what it refuses', () => {
  it('will not bill a delivery twice', async () => {
    const receipt = await aDelivery()
    await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
    })

    await expect(
      billReceipts(fixture.ctx, {
        vendorId,
        receiptIds: [receipt.id],
        billedCents: 10_000,
        issueDate: '2026-08-09',
      }),
    ).rejects.toThrow(DocumentError)

    // And nothing was posted the second time.
    expect(await balanceOf('2050')).toBe(0)
    expect(await balanceOf('2000')).toBe(10_000)
  })

  it('will not put one supplier’s delivery on another’s invoice', async () => {
    const receipt = await aDelivery()
    const other = (await createVendor(fixture.ctx, { name: 'Harbour Plant Hire' })).id

    await expect(
      billReceipts(fixture.ctx, {
        vendorId: other,
        receiptIds: [receipt.id],
        billedCents: 10_000,
        issueDate: '2026-08-07',
      }),
    ).rejects.toThrow(DocumentError)
  })

  it('will not bill a delivery that is not on these books', async () => {
    await expect(
      billReceipts(fixture.ctx, {
        vendorId,
        receiptIds: ['00000000-0000-0000-0000-000000000000'],
        billedCents: 10_000,
        issueDate: '2026-08-07',
      }),
    ).rejects.toThrow(DocumentError)
  })

  it('needs somebody who may post to the ledger', async () => {
    const receipt = await aDelivery()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(
      billReceipts(readonly, {
        vendorId,
        receiptIds: [receipt.id],
        billedCents: 10_000,
        issueDate: '2026-08-07',
      }),
    ).rejects.toThrow()
  })
})

describe('the check nobody had', () => {
  /**
   * Nothing watched 2050 before this phase, which is how the demo grew $28,700
   * in an account the application could not debit.
   */
  it('agrees while every delivery is either billed or in the account', async () => {
    await aDelivery()
    const second = await aDelivery(3_000, 2_000, '2026-08-05')
    await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [second.id],
      billedCents: 6_000,
      issueDate: '2026-08-07',
    })

    const unbilled = await unbilledReceiptValue(fixture.ctx)
    expect(unbilled).toEqual({ count: 1, totalCents: 10_000 })

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row) => row.key === 'inventory.goods_received')

    expect(finding).toBeDefined()
    expect(finding!.agrees).toBe(true)
    expect(finding!.leftCents).toBe(10_000)
    expect(finding!.rightCents).toBe(10_000)
  })

  /**
   * The failure the check exists for, written the way it actually happened:
   * a bill coded somewhere other than the clearing account, leaving the
   * delivery in 2050 for ever.
   */
  it('fails when a delivery is billed to the wrong account', async () => {
    const receipt = await aDelivery()

    // Exactly what the old path did: a bill coded to an expense account
    // instead of to the clearing account, and the delivery marked billed.
    const expense = await fixture.account('6350')
    const wrong = await createBill(fixture.ctx, {
      vendorId,
      issueDate: '2026-08-07',
      lines: [
        { chartAccountId: expense.id, description: 'Timber', unitPriceCents: 10_000 },
      ],
    })

    await db
      .update(goodsReceipts)
      .set({ billId: wrong.id })
      .where(eq(goodsReceipts.id, receipt.id))

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row) => row.key === 'inventory.goods_received')

    expect(finding!.agrees).toBe(false)
    expect(finding!.leftCents).toBe(0)
    expect(finding!.rightCents).toBe(10_000)
    expect(finding!.detail).toContain('the account carries')
    // A fault, because nothing legitimately moves these two apart.
    expect(run.faults).toBeGreaterThan(0)
  })
})

describe('two identical deliveries', () => {
  /**
   * Found while probing Phase 47 against Phase 48.
   *
   * A supplier delivers the same order twice in a week and sends two invoices.
   * Phase 47 refuses a second bill for the same supplier, same amount, within a
   * fortnight unless somebody says "it is a different bill" — and `billReceipts`
   * had no way to say it. So the second delivery could be received and never
   * billed, which puts back the very balance this phase exists to clear.
   *
   * The resemblance rule is right and stays. What was missing is that choosing
   * a *different delivery* is already the answer to the question it asks: these
   * are two bills because they are for two deliveries, and the deliveries are
   * named on the bill.
   */
  it('can both be billed, because the deliveries say they are different', async () => {
    const first = await aDelivery(5_000, 2_000, '2026-08-03')
    const second = await aDelivery(5_000, 2_000, '2026-08-06')

    await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [first.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
    })

    const later = await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [second.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
    })

    expect(later.clearedCents).toBe(10_000)
    expect(await balanceOf('2050')).toBe(0)
    expect(await unbilledReceipts(fixture.ctx)).toHaveLength(0)
  })

  /**
   * And the protection Phase 47 exists for is untouched: the *same* delivery
   * cannot be billed twice, whatever the amounts look like.
   */
  it('still cannot bill one delivery twice', async () => {
    const receipt = await aDelivery()
    await billReceipts(fixture.ctx, {
      vendorId,
      receiptIds: [receipt.id],
      billedCents: 10_000,
      issueDate: '2026-08-07',
    })

    await expect(
      billReceipts(fixture.ctx, {
        vendorId,
        receiptIds: [receipt.id],
        billedCents: 10_000,
        issueDate: '2026-08-07',
      }),
    ).rejects.toThrow(DocumentError)
  })
})
