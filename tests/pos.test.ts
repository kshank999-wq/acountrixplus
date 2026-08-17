import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries, journalLines, posDays } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { ModuleDisabledError, setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { postManualEntry } from '@/modules/ledger/journal'
import { POS_ACCOUNTS, planImbalanceCents, summariseDay } from '@/modules/pos/summary'
import { TakingsError, dayDetail, importDay, listDays, tipsPosition } from '@/modules/pos/service'

/**
 * Daily takings (spec §5 Restaurant and E-commerce, Phase 28).
 *
 * Five claims under test:
 *
 *  1. **A day's takings are one entry**, not four hundred.
 *  2. **Gross, not net.** A processor's fee is a cost, and the revenue is
 *     still the full amount the customer paid.
 *  3. **Tips are somebody else's money** — a liability, never revenue.
 *  4. **The till is counted, and the difference is named** rather than plugged.
 *  5. **A day imported twice is imported once**, because the database refuses
 *     the second.
 */

/** A café with the restaurant pack and the module on. */
async function cafe(name = 'Kestrel Coffee'): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name, industry: 'restaurant' })
  await setModuleEnabled(fixture.ctx, 'pos_import', true)
  return fixture
}

/** A plain, balanced day: £1,000 of food, £100 tax, cash only. */
const plainDay = {
  businessDate: '2026-03-10',
  categories: [{ name: 'Food', accountNumber: '4030', amountCents: 100_000 }],
  tenders: [{ kind: 'cash' as const, name: 'Cash', amountCents: 110_000 }],
  taxCents: 10_000,
}

describe('what a day adds up to (Phase 28)', () => {
  it('balances a plain day', () => {
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 100_000 }],
      taxCents: 10_000,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'cash', amountCents: 110_000, feeCents: 0 }],
      countedCashCents: null,
      floatCents: 0,
    })

    expect(planImbalanceCents(plan)).toBe(0)
    expect(plan.netSalesCents).toBe(100_000)
    expect(plan.outOfBalanceCents).toBe(0)
  })

  it('books the gross and the fee separately, never the deposit', () => {
    // £1,000 of sales, £30 of card fees. The processor deposits £970.
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 100_000 }],
      taxCents: 0,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'card', amountCents: 100_000, feeCents: 3_000 }],
      countedCashCents: null,
      floatCents: 0,
    })

    const clearing = plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.processorClearing)
    const fees = plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.processorFees)
    const sales = plan.lines.find((l) => l.accountNumber === '4030')

    // The clearing account takes what actually arrives…
    expect(clearing?.debitCents).toBe(97_000)
    // …the fee is a cost in its own right…
    expect(fees?.debitCents).toBe(3_000)
    // …and revenue is still the whole £1,000.
    expect(sales?.creditCents).toBe(100_000)
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('names a short till instead of plugging cash', () => {
    // The till says £500 taken; £480 is in the drawer, plus a £50 float.
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 50_000 }],
      taxCents: 0,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'cash', amountCents: 50_000, feeCents: 0 }],
      countedCashCents: 53_000,
      floatCents: 5_000,
    })

    expect(plan.overShortCents).toBe(-2_000)

    const cash = plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.cash)
    const overShort = plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.cashOverShort)

    // Cash is banked at what is actually there, and the missing £20 is named.
    expect(cash?.debitCents).toBe(48_000)
    expect(overShort?.debitCents).toBe(2_000)
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('credits Cash Over and Short when the till is over', () => {
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 50_000 }],
      taxCents: 0,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'cash', amountCents: 50_000, feeCents: 0 }],
      countedCashCents: 50_500,
      floatCents: 0,
    })

    expect(plan.overShortCents).toBe(500)
    const overShort = plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.cashOverShort)
    expect(overShort?.creditCents).toBe(500)
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('tells "nobody counted" apart from "counted, and exact"', () => {
    const base = {
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 50_000 }],
      taxCents: 0,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'cash' as const, amountCents: 50_000, feeCents: 0 }],
      floatCents: 0,
    }

    expect(summariseDay({ ...base, countedCashCents: null }).overShortCents).toBeNull()
    expect(summariseDay({ ...base, countedCashCents: 50_000 }).overShortCents).toBe(0)
  })

  it('keeps tips and tax off revenue entirely', () => {
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 100_000 }],
      taxCents: 10_000,
      tipsCents: 8_000,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'card', amountCents: 118_000, feeCents: 0 }],
      countedCashCents: null,
      floatCents: 0,
    })

    expect(
      plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.tipsPayable)?.creditCents,
    ).toBe(8_000)
    expect(
      plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.salesTaxPayable)?.creditCents,
    ).toBe(10_000)
    // Net sales is the sales alone — neither the tax nor the tips is revenue.
    expect(plan.netSalesCents).toBe(100_000)
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('reports discounts and refunds rather than netting them into sales', () => {
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 100_000 }],
      taxCents: 0,
      tipsCents: 0,
      refundsCents: 2_000,
      discountsCents: 4_000,
      tenders: [{ kind: 'cash', amountCents: 94_000, feeCents: 0 }],
      countedCashCents: null,
      floatCents: 0,
    })

    // "We sold £1,000 and gave £40 away" is a different fact from "we sold
    // £960", and only the first one can be managed.
    expect(plan.grossSalesCents).toBe(100_000)
    expect(plan.netSalesCents).toBe(94_000)
    expect(plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.discounts)?.debitCents).toBe(
      4_000,
    )
    expect(plan.lines.find((l) => l.accountNumber === POS_ACCOUNTS.refunds)?.debitCents).toBe(
      2_000,
    )
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('surfaces a source that contradicts itself rather than absorbing it', () => {
    // The tills claim £1,100 but the sales and tax only come to £1,050.
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [{ accountNumber: '4030', amountCents: 100_000 }],
      taxCents: 5_000,
      tipsCents: 0,
      refundsCents: 0,
      discountsCents: 0,
      tenders: [{ kind: 'cash', amountCents: 110_000, feeCents: 0 }],
      countedCashCents: null,
      floatCents: 0,
    })

    expect(plan.outOfBalanceCents).toBe(5_000)
    // …and the entry still balances, because the difference lands in cash
    // rather than being plugged into a revenue account nobody chose.
    expect(planImbalanceCents(plan)).toBe(0)
  })

  it('balances a day with several categories and tenders', () => {
    const plan = summariseDay({
      businessDate: '2026-03-10',
      categories: [
        { accountNumber: '4030', amountCents: 82_345 },
        { accountNumber: '4040', amountCents: 41_233 },
      ],
      taxCents: 12_357,
      tipsCents: 9_811,
      refundsCents: 1_499,
      discountsCents: 3_211,
      tenders: [
        { kind: 'cash', amountCents: 40_000, feeCents: 0 },
        { kind: 'card', amountCents: 90_000, feeCents: 2_611 },
        { kind: 'other', amountCents: 11_036, feeCents: 1_100 },
      ],
      countedCashCents: 41_150,
      floatCents: 1_000,
    })

    expect(planImbalanceCents(plan)).toBe(0)
    expect(plan.overShortCents).toBe(150)
    expect(plan.feeCents).toBe(3_711)
  })
})

describe('a day is one entry, imported once (Phase 28)', () => {
  it('posts a whole day as a single journal entry', async () => {
    const fixture = await cafe()

    const result = await importDay(fixture.ctx, plainDay)
    expect(result.created).toBe(true)

    const entries = await db
      .select({ id: journalEntries.id, source: journalEntries.source })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'takings'),
        ),
      )

    expect(entries).toHaveLength(1)

    const lines = await db
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entries[0].id))

    // Cash, food sales, sales tax. Three lines for a day of trading.
    expect(lines).toHaveLength(3)
  })

  it('refuses the same day and source a second time', async () => {
    const fixture = await cafe()

    const first = await importDay(fixture.ctx, plainDay)
    const second = await importDay(fixture.ctx, plainDay)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)

    const rows = await db
      .select({ id: posDays.id })
      .from(posDays)
      .where(eq(posDays.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)

    // And critically: revenue was not doubled. Balances come back on their
    // normal side, so a credit-normal revenue account reads positive.
    const food = await accountByNumber(fixture.companyId, '4030')
    expect(await balanceForAccount(fixture.ctx, food!.id)).toBe(100_000)
  })

  it('survives two importers racing for the same day', async () => {
    const fixture = await cafe()

    const [a, b] = await Promise.all([
      importDay(fixture.ctx, plainDay),
      importDay(fixture.ctx, plainDay),
    ])

    // Exactly one of them created it, whichever won.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)

    const rows = await db
      .select({ id: posDays.id })
      .from(posDays)
      .where(eq(posDays.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)
  })

  it('lets a till and a marketplace both report the same day', async () => {
    const fixture = await cafe()

    await importDay(fixture.ctx, { ...plainDay, source: 'register' })
    const second = await importDay(fixture.ctx, {
      ...plainDay,
      source: 'marketplace',
      categories: [{ name: 'Delivery', accountNumber: '4030', amountCents: 40_000 }],
      tenders: [{ kind: 'other', name: 'Deliveroo', amountCents: 40_000, feeCents: 12_000 }],
      taxCents: 0,
    })

    expect(second.created).toBe(true)
    expect(await listDays(fixture.ctx)).toHaveLength(2)
  })

  it('installs the accounts it posts to, even off the restaurant pack', async () => {
    const fixture = await createCompanyFixture({ name: 'Market Stall', industry: 'general' })
    await setModuleEnabled(fixture.ctx, 'pos_import', true)

    await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Sales', accountNumber: '4000', amountCents: 20_000 }],
      tenders: [{ kind: 'cash', name: 'Cash', amountCents: 20_000 }],
    })

    for (const number of [
      POS_ACCOUNTS.processorClearing,
      POS_ACCOUNTS.tipsPayable,
      POS_ACCOUNTS.refunds,
      POS_ACCOUNTS.processorFees,
      POS_ACCOUNTS.cashOverShort,
    ]) {
      expect(await accountByNumber(fixture.companyId, number)).toBeTruthy()
    }
  })

  it('refuses a category pointed at an account that does not exist', async () => {
    const fixture = await cafe()

    await expect(
      importDay(fixture.ctx, {
        businessDate: '2026-03-10',
        categories: [{ name: 'Mystery', accountNumber: '9999', amountCents: 10_000 }],
        tenders: [{ kind: 'cash', name: 'Cash', amountCents: 10_000 }],
      }),
    ).rejects.toThrow(TakingsError)

    // Nothing was half-posted: the whole import rolled back.
    const rows = await db
      .select({ id: posDays.id })
      .from(posDays)
      .where(eq(posDays.companyId, fixture.companyId))
    expect(rows).toHaveLength(0)
  })

  it('refuses a day with nothing in it', async () => {
    const fixture = await cafe()

    await expect(
      importDay(fixture.ctx, { businessDate: '2026-03-10', categories: [], tenders: [] }),
    ).rejects.toThrow(TakingsError)
  })

  it('refuses to import when the module is off', async () => {
    const fixture = await createCompanyFixture({ name: 'No Till Ltd', industry: 'general' })

    await expect(
      importDay(fixture.ctx, {
        businessDate: '2026-03-10',
        categories: [{ name: 'Sales', accountNumber: '4000', amountCents: 100 }],
        tenders: [{ kind: 'cash', name: 'Cash', amountCents: 100 }],
      }),
    ).rejects.toThrow(ModuleDisabledError)
  })

  it('refuses to import without the journal permission', async () => {
    const fixture = await cafe()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(importDay(readonly, plainDay)).rejects.toThrow(PermissionError)
  })

  it('records what was sold and how it was paid for', async () => {
    const fixture = await cafe()

    const result = await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [
        { name: 'Food', accountNumber: '4030', amountCents: 60_000 },
        { name: 'Coffee', accountNumber: '4040', amountCents: 40_000 },
      ],
      tenders: [
        { kind: 'cash', name: 'Cash', amountCents: 30_000 },
        { kind: 'card', name: 'Visa', amountCents: 70_000, feeCents: 1_400 },
      ],
    })

    const detail = await dayDetail(fixture.ctx, result.id)
    expect(detail.categories.map((row) => row.name)).toEqual(['Food', 'Coffee'])
    expect(detail.tenders.map((row) => row.name)).toEqual(['Visa', 'Cash'])
    expect(detail.tenders.find((row) => row.name === 'Visa')?.feeCents).toBe(1_400)
  })

  it('keeps one café’s days off another’s books', async () => {
    const ours = await cafe('Ours')
    const theirs = await cafe('Theirs')

    await importDay(ours.ctx, plainDay)

    expect(await listDays(theirs.ctx)).toHaveLength(0)
    expect(await listDays(ours.ctx)).toHaveLength(1)
  })
})

describe('what the books say afterwards (Phase 28)', () => {
  it('shows the gross as revenue and the fee as a cost', async () => {
    const fixture = await cafe()

    await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Food', accountNumber: '4030', amountCents: 100_000 }],
      tenders: [{ kind: 'card', name: 'Visa', amountCents: 100_000, feeCents: 3_000 }],
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // Revenue is the full £1,000 the customers paid, not the £970 banked.
    expect(pl.revenue.totalCents).toBe(100_000)

    const clearing = await accountByNumber(fixture.companyId, POS_ACCOUNTS.processorClearing)
    const fees = await accountByNumber(fixture.companyId, POS_ACCOUNTS.processorFees)

    expect(await balanceForAccount(fixture.ctx, clearing!.id)).toBe(97_000)
    expect(await balanceForAccount(fixture.ctx, fees!.id)).toBe(3_000)
  })

  it('keeps tips off the profit and loss entirely', async () => {
    const fixture = await cafe()

    await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Food', accountNumber: '4030', amountCents: 100_000 }],
      tenders: [{ kind: 'card', name: 'Visa', amountCents: 115_000 }],
      tipsCents: 15_000,
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The tips are in the building but they are not the café's.
    expect(pl.revenue.totalCents).toBe(100_000)

    const tips = await accountByNumber(fixture.companyId, POS_ACCOUNTS.tipsPayable)
    // A liability read on its normal side: £150 owed, sitting outside the P&L.
    expect(await balanceForAccount(fixture.ctx, tips!.id)).toBe(15_000)
  })

  it('says what is still owed to staff, and what has been paid out', async () => {
    const fixture = await cafe()

    await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Food', accountNumber: '4030', amountCents: 100_000 }],
      tenders: [{ kind: 'card', name: 'Visa', amountCents: 115_000 }],
      tipsCents: 15_000,
    })

    const before = await tipsPosition(fixture.ctx)
    expect(before.collectedCents).toBe(15_000)
    expect(before.ledgerCents).toBe(15_000)
    expect(before.paidOutCents).toBe(0)
    expect(before.agrees).toBe(true)

    // Payroll pays £100 of it out — through no part of this module.
    const tips = await accountByNumber(fixture.companyId, POS_ACCOUNTS.tipsPayable)
    const bank = await accountByNumber(fixture.companyId, '1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-25',
      memo: 'Tips paid out with wages',
      lines: [
        { chartAccountId: tips!.id, debitCents: 10_000 },
        { chartAccountId: bank!.id, creditCents: 10_000 },
      ],
    })

    const after = await tipsPosition(fixture.ctx)
    expect(after.collectedCents).toBe(15_000)
    expect(after.ledgerCents).toBe(5_000)
    expect(after.paidOutCents).toBe(10_000)
    // Disagreement here is not a fault — it is the point of the number.
    expect(after.agrees).toBe(false)
  })

  it('banks the counted cash and puts the shortfall where somebody will see it', async () => {
    const fixture = await cafe()

    await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Food', accountNumber: '4030', amountCents: 50_000 }],
      tenders: [{ kind: 'cash', name: 'Cash', amountCents: 50_000 }],
      countedCashCents: 49_000,
      floatCents: 0,
    })

    const cash = await accountByNumber(fixture.companyId, POS_ACCOUNTS.cash)
    const overShort = await accountByNumber(fixture.companyId, POS_ACCOUNTS.cashOverShort)

    expect(await balanceForAccount(fixture.ctx, cash!.id)).toBe(49_000)
    expect(await balanceForAccount(fixture.ctx, overShort!.id)).toBe(1_000)

    const [day] = await listDays(fixture.ctx)
    expect(day.overShortCents).toBe(-1_000)
  })

  it('records a source that disagrees with itself without refusing the day', async () => {
    const fixture = await cafe()

    const result = await importDay(fixture.ctx, {
      businessDate: '2026-03-10',
      categories: [{ name: 'Food', accountNumber: '4030', amountCents: 100_000 }],
      tenders: [{ kind: 'cash', name: 'Cash', amountCents: 105_000 }],
    })

    // The day still posts — refusing would mean the books cannot record
    // something the business did — and the contradiction is on the row.
    expect(result.created).toBe(true)

    const [day] = await listDays(fixture.ctx)
    expect(day.outOfBalanceCents).toBe(5_000)

    // And it is not absorbed into cash or revenue on the way past. Cash is
    // debited with every penny the till says it took, food sales are credited
    // with every penny that was sold, and the £50 nobody can explain sits in
    // suspense with its own name on it.
    const cash = await accountByNumber(fixture.companyId, POS_ACCOUNTS.cash)
    const food = await accountByNumber(fixture.companyId, '4030')
    const suspense = await accountByNumber(fixture.companyId, POS_ACCOUNTS.suspense)

    expect(await balanceForAccount(fixture.ctx, cash!.id)).toBe(105_000)
    expect(await balanceForAccount(fixture.ctx, food!.id)).toBe(100_000)
    // Credit-normal on a debit-normal account: the asset is negative because
    // the till holds money the day cannot account for.
    expect(await balanceForAccount(fixture.ctx, suspense!.id)).toBe(-5_000)
  })
})
