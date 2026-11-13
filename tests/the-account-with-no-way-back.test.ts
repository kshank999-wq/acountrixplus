import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  MAINTAINED_ACCOUNTS,
  maintainedAccount,
  refusalFor,
  refusedAccountIds,
} from '@/modules/coa/maintained'
import { INDUSTRY_ACCOUNTS, STANDARD_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { INDUSTRY_PACKS } from '@/modules/coa/industry'
import { FALSIFIERS } from '@/modules/integrity/falsifiable'
import { INTEGRITY_CHECKS } from '@/modules/integrity/register'
import { runIntegrityChecks } from '@/modules/integrity/service'
import { createBill, createVendor, createInvoice, createCustomer } from '@/modules/receivables/service'
import { documentLineAccounts } from '@/modules/receivables/open-documents'
import { registerAsset } from '@/modules/assets/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { setModuleEnabled } from '@/modules/industry/modules'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'
import { receiveStock, setItemPostingAccounts } from '@/modules/inventory/service'
import { receiveGoods } from '@/modules/inventory/purchasing'
import { billReceipts } from '@/modules/payables/receipt-billing'
import { stockCarryingAccountIds } from '@/modules/inventory/accounts'
import { categorizableAccounts } from '@/modules/coa/service'
import { DRAWER_ACCOUNTS } from '@/modules/drawer/service'
import { APPOINTMENT_ACCOUNTS } from '@/modules/appointments/service'
import { POS_ACCOUNTS } from '@/modules/pos/summary'
import { sourceFiles, readableSource } from '@/modules/source/isolation-scan'
import { withoutComments } from '@/modules/source/enclosing'
import { COLUMN_WRITERS } from '@/modules/source/column-writers'

/**
 * The account with no way back (Phase 211).
 *
 * ADR 0210 nominated `bill_lines.item_id` — a column with no writer — and said
 * to measure where what arrived should be recorded before building a picker.
 * The answer was *the receipt line*, which already has one, so the column was
 * dropped and the question turned into a different one: what happens today
 * when a business buys stock and codes the supplier's bill to Inventory?
 *
 * Measured: `inventory.lots` reports a **fault**, and receiving the goods
 * properly afterwards doubles the difference instead of closing it. Two more
 * accounts on the same dropdown were the same shape, one was not, and the
 * class the two existing lists were each trying to describe had fifteen
 * members between them and four in one list and two in the other.
 */


/**
 * A stocked item, inserted directly.
 *
 * `createServiceItem`'s input does not carry `isInventoried` — the flag is set
 * by the inventory screens — and `tests/inventory.test.ts` does the same thing
 * for the same reason.
 */
const aStockedItem = async (fixture: Fixture, code: string) => {
  const [item] = await db
    .insert(serviceItems)
    .values({
      companyId: fixture.companyId,
      code,
      name: code,
      unitPriceCents: 2_000,
      unitCostCents: 1_000,
      isInventoried: true,
    })
    .returning()

  return item
}

const faultKeys = new Set(
  INTEGRITY_CHECKS.filter((check) => check.severity === 'fault').map((check) => check.key),
)

describe('the class, against the checks that define it', () => {
  it('answers for every account a falsifier names', () => {
    /*
      The self-maintaining half of this phase.

      `FALSIFIERS` already records, per check, that the one act which breaks it
      is "post a manual journal entry against <account>". That makes it the
      list of accounts whose balance is somebody else's to maintain — so a new
      check cannot be added without this register having to say whether a
      person can reach its account from a document line.
    */
    const watched = FALSIFIERS.filter((row) => row.account !== null)
    expect(watched.length).toBeGreaterThan(10)

    for (const falsifier of watched) {
      const entry = maintainedAccount(falsifier.account as string)
      expect(entry, `${falsifier.key} names ${falsifier.account}`).toBeDefined()
    }
  })

  it('names a real check, or says it has none', () => {
    const keys = new Set(INTEGRITY_CHECKS.map((check) => check.key))

    for (const entry of MAINTAINED_ACCOUNTS) {
      if (entry.watchedBy === null) {
        // Exactly one, and it is the gap Phase 48 was bitten by: a clearing
        // account with no check on it. Declared here rather than left to be
        // discovered (Phase 139).
        expect(entry.number).toBe(SYSTEM_ACCOUNTS.undepositedFunds)
        continue
      }

      expect(keys.has(entry.watchedBy), `${entry.number} -> ${entry.watchedBy}`).toBe(true)
    }

    expect(MAINTAINED_ACCOUNTS.filter((row) => row.watchedBy === null)).toHaveLength(1)
  })

  it('tells anybody it refuses what to do instead', () => {
    // Phase 47's rule. A refusal that names nothing actionable teaches people
    // to code the line somewhere worse.
    for (const entry of MAINTAINED_ACCOUNTS) {
      if (entry.documentLine) {
        expect(entry.instead, entry.number).toBeNull()
        continue
      }

      expect(entry.instead, entry.number).toBeTruthy()
      expect((entry.instead as string).length, entry.number).toBeGreaterThan(10)
    }
  })

  it('argues for each entry rather than listing it', () => {
    for (const entry of MAINTAINED_ACCOUNTS) {
      expect(entry.because.length, entry.number).toBeGreaterThan(80)
      expect(entry.maintainedBy.length, entry.number).toBeGreaterThan(20)
    }
  })

  it('carries the numbers its modules define, not copies of them', () => {
    // Four of the accounts belong to industry packs and are declared in their
    // own modules, where SYSTEM_ACCOUNTS cannot reach them. Pinned so the
    // register cannot drift away from the thing it describes.
    expect(maintainedAccount(DRAWER_ACCOUNTS.cashInDrawers)).toBeDefined()
    expect(maintainedAccount(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBeDefined()
    expect(maintainedAccount(APPOINTMENT_ACCOUNTS.practitionerPayable)).toBeDefined()
    expect(maintainedAccount(POS_ACCOUNTS.tipsPayable)).toBeDefined()
  })

  it('offers exactly one of them on a document line', () => {
    // The control, named. Everything else on this register is refused, and
    // `1500` is on it to carry the argument for why it is not — which is the
    // part a reader needs and the part a deny-list cannot hold.
    expect(MAINTAINED_ACCOUNTS.filter((row) => row.documentLine).map((row) => row.number)).toEqual([
      SYSTEM_ACCOUNTS.fixedAssets,
    ])
  })

  it('tells the truth about what else protects each one', () => {
    /*
      `alsoProtectedBy` is the field that makes this register more than a
      deny-list: eight of these accounts were kept off the composer by a filter
      about what a *cost* is, and two by a filter about what *cash* is, and
      nothing anywhere said that fourteen fault-severity checks were leaning on
      them. A claim in prose that nothing reads is a claim nothing corrects
      (Phase 179), so each one is checked against the charts here.
    */
    const subtypes = new Map<string, string | null | undefined>([
      ...STANDARD_ACCOUNTS.map(
        (row) => [row.number, row.subtype] as [string, string | null | undefined],
      ),
      ...Object.values(INDUSTRY_PACKS).flatMap((pack) =>
        pack.accounts.map((row) => [row.number, row.subtype] as [string, string | null | undefined]),
      ),
    ])
    const types = new Map<string, string>([
      ...STANDARD_ACCOUNTS.map((row) => [row.number, row.type] as [string, string]),
      ...Object.values(INDUSTRY_PACKS).flatMap((pack) =>
        pack.accounts.map((row) => [row.number, row.type] as [string, string]),
      ),
    ])

    const byType = MAINTAINED_ACCOUNTS.filter((row) => row.alsoProtectedBy?.includes('type filter'))
    const byCash = MAINTAINED_ACCOUNTS.filter((row) => row.alsoProtectedBy?.includes('cash filter'))
    const bySubtype = MAINTAINED_ACCOUNTS.filter((row) =>
      row.alsoProtectedBy?.includes('subtype: '),
    )

    expect(byType).toHaveLength(8)
    expect(byCash).toHaveLength(2)
    expect(bySubtype).toHaveLength(2)

    for (const entry of byType) expect(types.get(entry.number), entry.number).toBe('liability')
    for (const entry of byCash) {
      if (subtypes.has(entry.number)) {
        expect(['bank', 'cash', 'credit_card'], entry.number).toContain(subtypes.get(entry.number))
        continue
      }

      /*
        1060 is in no chart template. Its own module says why — "1060 is in no
        industry pack, because until now nothing in this application held cash
        in a till" — and installs it on first use, so the only place its
        subtype exists is the code that creates it.
      */
      expect(entry.number).toBe(DRAWER_ACCOUNTS.cashInDrawers)
      const installer = withoutComments(
        readFileSync('src/modules/drawer/service.ts', 'utf8'),
      )
      expect(installer).toContain("subtype: 'cash'")
    }
    for (const entry of bySubtype) {
      expect(subtypes.get(entry.number), entry.number).toBe('inventory')
    }

    // And the three this phase found: nothing but the register holds them.
    expect(
      MAINTAINED_ACCOUNTS.filter(
        (row) => !row.documentLine && row.alsoProtectedBy === null,
      ).map((row) => row.number),
    ).toContain(SYSTEM_ACCOUNTS.paymentsInTransit)
  })

  it('names only accounts that exist in some chart', () => {
    /*
      The stale number this phase found by reading.

      `assets.register` declared that it compares "Σ register cost and
      depreciation against 1500 and **1590**". Accumulated depreciation has
      been 1510 since the first chart was written. A number in prose that
      nothing reads is a number nothing corrects (Phase 179), so every number
      in every `compares` string is now checked against the charts.
    */
    const inSomeChart = new Set<string>([
      ...STANDARD_ACCOUNTS.map((row) => row.number),
      ...Object.values(INDUSTRY_PACKS).flatMap((pack) => pack.accounts.map((row) => row.number)),
      ...Object.values(DRAWER_ACCOUNTS),
      ...Object.values(POS_ACCOUNTS),
      ...Object.values(APPOINTMENT_ACCOUNTS),
    ])

    for (const check of INTEGRITY_CHECKS) {
      for (const number of check.compares.match(/\b[1-9]\d{3}\b/g) ?? []) {
        expect(inSomeChart.has(number), `${check.key} names ${number}`).toBe(true)
      }
    }

    for (const entry of MAINTAINED_ACCOUNTS) {
      expect(inSomeChart.has(entry.number), entry.number).toBe(true)
    }
  })
})

describe('against the database', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Foundry Co', industry: 'manufacturing' })
    await setModuleEnabled(fixture.ctx, 'inventory', true)
    await setModuleEnabled(fixture.ctx, 'manufacturing', true)
  })

  const brokenNow = async () => {
    const run = await runIntegrityChecks(fixture.ctx, { persist: false })
    return new Set(run.findings.filter((finding) => !finding.agrees).map((finding) => finding.key))
  }

  const bill = async (chartAccountId: string, reference: string, cents = 100_000) =>
    createBill(fixture.ctx, {
      vendorId: (await aSupplier()).id,
      vendorReference: reference,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId, description: 'Something bought', unitPriceCents: cents }],
    })

  let supplier: { id: string } | null = null
  const aSupplier = async () => {
    supplier ??= await createVendor(fixture.ctx, { name: 'Kestrel Supply' })
    return supplier
  }

  beforeEach(() => {
    supplier = null
  })

  describe('nothing the composer offers can break a fault check', () => {
    /**
     * The measurement, as an assertion.
     *
     * Every account the bill composer offers, coded onto its own $1,000 bill,
     * with every check run after each one. Before this phase four of them
     * raised a fault; three of those had no way back.
     *
     * Written as a loop over whatever the picker offers rather than as four
     * named cases, so an account added to the chart — or a type added to the
     * composer's `wanted` list — fails here rather than in somebody's books.
     */
    it('on a bill, with Fixed Assets the one exception and the reason it is', async () => {
      const offered = await documentLineAccounts(fixture.ctx, 'vendor')
      expect(offered.length).toBeGreaterThan(20)

      const already = await brokenNow()
      const broke: Array<{ number: string; keys: string[] }> = []

      for (const [index, account] of offered.entries()) {
        await bill(account.id, `KS-${index}`)

        const now = await brokenNow()
        const fresh = [...now].filter((key) => !already.has(key) && faultKeys.has(key))
        for (const key of fresh) already.add(key)

        if (fresh.length > 0) broke.push({ number: account.number, keys: fresh })
      }

      expect(broke).toEqual([
        { number: SYSTEM_ACCOUNTS.fixedAssets, keys: ['assets.register'] },
      ])
    }, 120_000)

    it('on an invoice, where the type filter had already done the work', async () => {
      const offered = await documentLineAccounts(fixture.ctx, 'customer')
      const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

      const already = await brokenNow()

      for (const account of offered) {
        await createInvoice(fixture.ctx, {
          customerId: customer.id,
          issueDate: '2026-03-01',
          dueDate: '2026-03-31',
          lines: [
            { chartAccountId: account.id, description: 'Work', unitPriceCents: 100_000 },
          ],
        })
      }

      const now = await brokenNow()
      expect([...now].filter((key) => !already.has(key) && faultKeys.has(key))).toEqual([])
    }, 120_000)
  })

  describe('the control, which is why Fixed Assets stays on the list', () => {
    it('registering the asset closes what the bill opened', async () => {
      const fixedAssets = await fixture.account(SYSTEM_ACCOUNTS.fixedAssets)
      const vendor = await aSupplier()

      const before = await brokenNow()
      expect(before.has('assets.register')).toBe(false)

      await bill(fixedAssets.id, 'TRUCK-1', 4_000_000)
      expect([...(await brokenNow())]).toContain('assets.register')

      /*
        No `postAcquisitionCreditAccountId`, which is the whole point:
        `RegisterAssetInput` says it is "left unset for the normal case, where
        a supplier bill already coded the cost to Fixed Assets and posting it
        again would put the truck on the balance sheet twice". So the bill line
        is the intended path, the fault between the two acts is a to-do, and
        the check's own `meaning` names the remedy.
      */
      await registerAsset(fixture.ctx, {
        name: 'Flatbed truck',
        costCents: 4_000_000,
        lifeMonths: 60,
        acquiredDate: '2026-03-01',
        vendorId: vendor.id,
      })

      expect((await brokenNow()).has('assets.register')).toBe(false)
    }, 60_000)
  })

  describe('the account with no way back', () => {
    it('doubles the difference when the goods are then received properly', async () => {
      /*
        The claim this phase is named for, proved through a journal entry
        because the bill line that used to do it is now refused — which is
        also the honest form of the claim: the damage is in the books, not in
        the composer, and `FALSIFIERS` already says a hand-written entry at
        1400 is what breaks this check.
      */
      const inventory = await fixture.account(SYSTEM_ACCOUNTS.inventory)
      const payable = await fixture.account(SYSTEM_ACCOUNTS.accountsPayable)
      const item = await aStockedItem(fixture, 'TIMBER')

      await createJournalEntry(
        fixture.ctx,
        {
          entryDate: '2026-03-01',
          memo: 'Stock bought, coded straight to Inventory',
          lines: [
            { chartAccountId: inventory.id, debitCents: 1_000_000 },
            { chartAccountId: payable.id, creditCents: 1_000_000 },
          ],
        },
        db,
      )

      const run = await runIntegrityChecks(fixture.ctx, { persist: false })
      const opened = run.findings.find((finding) => finding.key === 'inventory.lots')
      expect(opened?.agrees).toBe(false)
      expect(opened?.leftCents).toBe(0)
      expect(opened?.rightCents).toBe(1_000_000)

      await receiveGoods(fixture.ctx, {
        vendorId: (await aSupplier()).id,
        receivedOn: '2026-03-01',
        lines: [{ itemId: item.id, quantityMilli: 1_000_000, unitCostCents: 1_000 }],
      })

      const after = await runIntegrityChecks(fixture.ctx, { persist: false })
      const still = after.findings.find((finding) => finding.key === 'inventory.lots')

      // Doing the right thing afterwards made it worse: the receipt posts its
      // own debit to the same account, so the subledger catches up to where
      // the ledger was and the ledger moves the same distance again.
      expect(still?.agrees).toBe(false)
      expect(still?.leftCents).toBe(1_000_000)
      expect(still?.rightCents).toBe(2_000_000)
    }, 60_000)
  })

  describe('the refusal, and the picker that agrees with it', () => {
    const cases = [
      { number: SYSTEM_ACCOUNTS.inventory, says: 'Purchasing' },
      { number: SYSTEM_ACCOUNTS.paymentsInTransit, says: 'checkout' },
      { number: INDUSTRY_ACCOUNTS.workInProcess, says: 'work order' },
      { number: '1440', says: 'Purchasing' },
    ]

    for (const { number, says } of cases) {
      it(`refuses a bill line coded to ${number}, and does not offer it either`, async () => {
        const account = await fixture.account(number)

        const offered = await documentLineAccounts(fixture.ctx, 'vendor')
        expect(offered.map((row) => row.number)).not.toContain(number)

        await expect(bill(account.id, `REF-${number}`)).rejects.toThrow(says)
      })
    }

    it('refuses an account an item names, which no number could have caught', async () => {
      /*
        `setItemPostingAccounts` deliberately does not type-check the choice —
        "the accounts are not validated by type here" — and
        `reconcileInventory` compares the lots against every account an item
        names. So the class is not a list of numbers and not a subtype either,
        on books where somebody has filed stock somewhere unusual.
      */
      const prepaid = await fixture.account('1300')
      const item = await aStockedItem(fixture, 'ODD')

      const before = await documentLineAccounts(fixture.ctx, 'vendor')
      expect(before.map((row) => row.number)).toContain('1300')

      await setItemPostingAccounts(fixture.ctx, {
        itemId: item.id,
        inventoryAccountId: prepaid.id,
        cogsAccountId: null,
      })

      const after = await documentLineAccounts(fixture.ctx, 'vendor')
      expect(after.map((row) => row.number)).not.toContain('1300')
      expect(await stockCarryingAccountIds(fixture.ctx)).toContain(prepaid.id)

      await expect(bill(prepaid.id, 'ODD-1')).rejects.toThrow('carries stock')
    })

    it('offers and accepts exactly the same accounts', async () => {
      /*
        The pair that cannot be allowed to drift, which is what the register is
        for: before this phase the picker kept a list of four and the stock
        receipt kept a list of two, and the three accounts neither had were
        reachable from a dropdown.
      */
      const refused = await refusedAccountIds(fixture.ctx, 'documentLine')
      const offered = await documentLineAccounts(fixture.ctx, 'vendor')

      for (const account of offered) expect(refused.has(account.id)).toBe(false)
    })
  })

  describe('the one licence the register names', () => {
    it('lets a delivery be billed, and refuses the same line typed by hand', async () => {
      const vendor = await aSupplier()
      const item = await aStockedItem(fixture, 'TIMBER')

      const receipt = await receiveGoods(fixture.ctx, {
        vendorId: vendor.id,
        receivedOn: '2026-03-01',
        lines: [{ itemId: item.id, quantityMilli: 10_000, unitCostCents: 1_000 }],
      })

      const result = await billReceipts(fixture.ctx, {
        vendorId: vendor.id,
        receiptIds: [receipt.id],
        billedCents: 10_000,
        issueDate: '2026-03-05',
        vendorReference: 'KS-DELIVERY-1',
      })

      expect(result.clearedCents).toBe(10_000)

      const grni = await fixture.account(SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced)
      await expect(bill(grni.id, 'BY-HAND-1', 10_000)).rejects.toThrow('Bill the delivery')
    }, 60_000)

    it('is held by exactly the places the register names', () => {
      /*
        The flag is a licence, so the thing worth asserting is who holds it.

        Two acts, because the suite produced the second one inside this phase:
        the measurement asked what the pickers offer and the invoice picker
        offers revenue only, so it reported the invoice side clean — while two
        modules raise a deposit invoice credited to the retainer account for a
        correct reason, through no picker at all.

        `readableSource` blanks string literals as well as comments, which is
        right for counting queries and useless for finding one — so this reads
        the file and strips only the prose.
      */
      const holders = (act: string) =>
        sourceFiles('src').filter((file) =>
          new RegExp(`actingAs:\\s*'${act}'`).test(withoutComments(readFileSync(file, 'utf8'))),
        )

      expect(holders('receipt_clearance')).toEqual(['src/modules/payables/receipt-billing.ts'])
      expect(holders('deposit_billing').sort()).toEqual([
        'src/modules/crm/conversion.ts',
        'src/modules/crm/stage-invoicing.ts',
      ])

      // And no act is declared that nothing holds, which is how a licence
      // outlives the thing it was for (Phase 185).
      const declared = (withoutComments(
        readFileSync('src/modules/coa/maintained.ts', 'utf8'),
      ).match(/export type MaintainingAct = (.+)/) ?? ['', ''])[1]

      for (const act of declared.match(/'(\w+)'/g) ?? []) {
        expect(holders(act.replaceAll("'", '')).length, act).toBeGreaterThan(0)
      }
    })
  })

  describe('the receipt side of the same register', () => {
    const credit = async (number: string, itemId: string) => {
      const account = await fixture.account(number)
      return receiveStock(fixture.ctx, {
        itemId,
        quantityMilli: 1_000,
        unitCostCents: 500,
        receivedOn: '2026-03-01',
        creditAccountId: account.id,
      })
    }

    let itemId = ''

    beforeEach(async () => {
      const item = await aStockedItem(fixture, 'BOLT')
      itemId = item.id
    })

    it('refuses the account the stock is going into', async () => {
      // 1400 has an entry of its own, so the refusal is the entry's argument
      // rather than the subtype rule's sentence — which is the better message
      // of the two and the reason an explicit entry wins.
      await expect(credit(SYSTEM_ACCOUNTS.inventory, itemId)).rejects.toThrow(
        'Σ open lots must equal this account',
      )
    })

    it('refuses a stock account this chart invented a name for', async () => {
      await expect(credit('1440', itemId)).rejects.toThrow('carries stock')
    })

    it('still permits the three a receipt legitimately credits', async () => {
      // The clearing account a purchase uses, the work in process a finished
      // run credits, and a bank account for stock bought outright. Each is an
      // entry in the register saying so, which is why one flag per account
      // would have been wrong.
      await credit(SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced, itemId)
      await credit(INDUSTRY_ACCOUNTS.workInProcess, itemId)
      await credit(SYSTEM_ACCOUNTS.openingBalanceEquity, itemId)
    })
  })

  describe('the categoriser, which was safe for a reason nothing recorded', () => {
    it('offers no asset account at all, so no clearing account among them', async () => {
      /*
        Pinned rather than guarded (Phase 139 — a register that says what it
        does not cover). `categorizableAccounts` filters to revenue, cost and
        expense types, which keeps every watched account off the bank feed's
        dropdown as a side effect of a rule about what a *category* is. It is
        the third membership of this class in the codebase and the only one
        that was already complete, by accident.
      */
      const offered = await categorizableAccounts(fixture.ctx)
      expect(offered.length).toBeGreaterThan(10)
      expect(offered.some((account) => account.type === 'asset')).toBe(false)
      expect(offered.some((account) => account.type === 'liability')).toBe(false)

      for (const entry of MAINTAINED_ACCOUNTS) {
        if (entry.documentLine) continue
        expect(offered.map((account) => account.number)).not.toContain(entry.number)
      }
    })
  })
})

describe('the item on the wrong document', () => {
  it('is gone from the schema, and from the census that found it', () => {
    const schema = readFileSync('src/db/schema/receivables.ts', 'utf8')
    const billLines = schema.slice(
      schema.indexOf("export const billLines"),
      schema.indexOf('export const payRuns'),
    )

    expect(billLines).not.toContain("uuid('item_id')")
    // The argument stays where the column was, because the next person to
    // wonder why a bill line has no item will look here first.
    expect(billLines).toContain('goods_receipt_lines.item_id')

    expect(
      COLUMN_WRITERS.some((row) => row.table === 'bill_lines'),
    ).toBe(false)
  })

  it('leaves the receipt line as the one place what arrived is recorded', () => {
    const inventory = readFileSync('src/db/schema/inventory.ts', 'utf8')
    expect(inventory).toContain("itemId: uuid('item_id')")

    const purchasing = readableSource('src/modules/inventory/purchasing.ts')
    expect(purchasing).toContain('itemId: line.itemId')
  })

  it('declares thirteen findings over fifteen columns', () => {
    // Was fourteen over sixteen when Phase 210 wrote the register. This
    // phase did not fix one: it established that the sixteenth was never a
    // defect, which is a different thing and the reason the count moves.
    const findings = COLUMN_WRITERS.filter((row) => row.verdict === 'unwritable')

    expect(findings).toHaveLength(13)
    expect(findings.reduce((total, row) => total + row.columns.length, 0)).toBe(15)
    expect(findings.every((row) => row.writtenBy === '')).toBe(true)
  })
})

describe('what one act may name and another may not', () => {
  it('is answered per act, not by one flag', () => {
    // Two entries disagree with themselves across the two acts, and both
    // disagreements are load-bearing: a goods receipt must credit 2050 and a
    // finished manufacturing run must credit 1450, while a person typing a
    // bill must name neither.
    const split = MAINTAINED_ACCOUNTS.filter((row) => row.documentLine !== row.stockReceipt)

    expect(split.map((row) => row.number).sort()).toEqual([
      SYSTEM_ACCOUNTS.defaultChecking,
      INDUSTRY_ACCOUNTS.workInProcess,
      SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced,
    ].sort())
  })

  it('tells a receipt and a document line different things to do', () => {
    const account = { number: SYSTEM_ACCOUNTS.accountsPayable, name: 'Accounts Payable' }

    expect(refusalFor(account, 'documentLine')).toContain('Enter the bill')
    // The receipt's remedy is the same sentence for the whole class, so it
    // lives at the call site rather than fifteen times in the register.
    expect(refusalFor(account, 'stockReceipt')).not.toContain('Enter the bill')
  })
})
