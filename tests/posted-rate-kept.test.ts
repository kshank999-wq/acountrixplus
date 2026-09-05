import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions } from '@/db/schema'
import { createCompanyFixture, insertTransaction, type Fixture } from './helpers'
import { syncLedgerForTransaction, syncLedgerForTransferPair } from '@/modules/ledger/posting'
import { balanceForAccount } from '@/modules/ledger/balances'
import { cashTieOut, createFinancialAccount, postedAtFace } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'

/**
 * A rate is answered once, against the database (Phase 129).
 *
 * `rateFor` walks backwards to the most recent rate on or before a date, so
 * entering a rate for a day that did not have one changes what an *older*
 * question resolves to. Nothing is edited and nothing is corrected — the table
 * just grew, which is the ordinary way a rate table is kept.
 *
 * Phase 128 left two callers asking that question independently: `buildLines`
 * to post and `cashTieOut` to check. So the check drifted away from a correct
 * ledger, and — because posting is idempotent by voiding and re-posting —
 * re-categorising silently restated the books.
 */

let fixture: Fixture
let expenseId: string
let otherExpenseId: string
const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Rate Keeper Ltd' })
  expenseId = (await fixture.account('6000')).id
  otherExpenseId = (await fixture.account('6100')).id

  // One rate, dated well before anything posts.
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: 1_100_000,
    source: 'manual',
  })
})

async function euroAccount(name = 'Frankfurt Current') {
  return createFinancialAccount(fixture.ctx, { name, kind: 'checking', currency: 'EUR' })
}

async function euroCharge(accountId: string, id: string, amountCents = -50_000) {
  const [tx] = await db
    .insert(bankTransactions)
    .values({
      companyId: fixture.companyId,
      financialAccountId: accountId,
      providerTransactionId: id,
      postedDate: '2026-09-10',
      amountCents,
      description: 'Werkzeug GmbH',
      reviewState: 'categorized',
      chartAccountId: expenseId,
    })
    .returning()
  return tx
}

/** The ordinary act: a rate gets entered for a day that did not have one. */
async function enterSeptemberRate() {
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-09-01',
    rateMillionths: 1_150_000,
    source: 'manual',
  })
}

async function reload(id: string) {
  const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, id))
  return row
}

describe('what a posting writes down', () => {
  it('records the rate it used and what the books took', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-1')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    const row = await reload(tx.id)
    expect(row.rateMillionths).toBe(1_100_000)
    expect(row.functionalAmountCents).toBe(-55_000)
  })

  it('records parity on a domestic account, which is a real answer rather than a blank', async () => {
    const tx = await insertTransaction(fixture, { amountCents: -50_000, description: 'Local' })
    await db
      .update(bankTransactions)
      .set({ reviewState: 'categorized', chartAccountId: expenseId })
      .where(eq(bankTransactions.id, tx.id))
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    const row = await reload(tx.id)
    expect(row.rateMillionths).toBe(1_000_000)
    expect(row.functionalAmountCents).toBe(-50_000)
  })

  it('writes nothing for a transaction that has not posted', async () => {
    const account = await euroAccount()
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-inbox',
        postedDate: '2026-09-10',
        amountCents: -50_000,
        description: 'Still in the inbox',
      })
      .returning()

    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    const row = await reload(tx.id)
    expect(row.rateMillionths).toBeNull()
    expect(row.functionalAmountCents).toBeNull()
  })
})

describe('a rate entered after a transaction posted', () => {
  it('does not restate the books when the transaction is re-categorised', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-recat')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(55_000)

    await enterSeptemberRate()

    // Somebody moves it to a different expense account. Nothing about the money
    // changed — but before Phase 129 this re-derived the rate and quietly
    // turned $550 of cost into $575, with no correction record anywhere.
    await db
      .update(bankTransactions)
      .set({ chartAccountId: otherExpenseId })
      .where(eq(bankTransactions.id, tx.id))
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, otherExpenseId, YEAR)).toBe(55_000)
    expect((await reload(tx.id)).rateMillionths).toBe(1_100_000)
  })

  it('is stable however many times the transaction is re-posted', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-repeat')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)
    await enterSeptemberRate()

    for (let i = 0; i < 3; i += 1) {
      await syncLedgerForTransaction(fixture.ctx, tx.id, db)
    }

    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(55_000)
  })

  it('leaves the nightly check agreeing, because both sides read the same fact', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-tie')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    await enterSeptemberRate()

    // Measured before Phase 129: feed -50000, books -57500, ledger -55000,
    // difference -2500 — the check wrong and the ledger right, for a reason
    // nothing in the audit trail could explain.
    const row = (await cashTieOut(fixture.ctx)).find((r) => r.financialAccountId === account.id)!
    expect(row.feedCents).toBe(-50_000)
    expect(row.feedFunctionalCents).toBe(-55_000)
    expect(row.ledgerCents).toBe(-55_000)
    expect(row.differenceCents).toBe(0)
  })

  it('still applies to a transaction that posts for the first time afterwards', async () => {
    // The new rate is not ignored — it is the right answer for anything that
    // has not been answered yet. Only a posting already made is fixed.
    const account = await euroAccount()
    await enterSeptemberRate()
    const tx = await euroCharge(account.id, 'eur-later')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    expect((await reload(tx.id)).rateMillionths).toBe(1_150_000)
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(57_500)
  })
})

describe('both legs of a transfer', () => {
  it('carry the rate, so neither can be re-derived apart from the other', async () => {
    const first = await euroAccount('Frankfurt One')
    const second = await euroAccount('Frankfurt Two')
    const [out] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: first.id,
        providerTransactionId: 'eu-out',
        postedDate: '2026-09-10',
        amountCents: -50_000,
        description: 'Sweep',
        reviewState: 'categorized',
      })
      .returning()
    const [into] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: second.id,
        providerTransactionId: 'eu-in',
        postedDate: '2026-09-10',
        amountCents: 50_000,
        description: 'Sweep',
        reviewState: 'categorized',
      })
      .returning()

    await syncLedgerForTransferPair(fixture.ctx, out.id, into.id, db)

    const left = await reload(out.id)
    const right = await reload(into.id)
    expect(left.rateMillionths).toBe(1_100_000)
    expect(right.rateMillionths).toBe(1_100_000)
    // Signed the way each statement reads it, so a tie-out can add them up.
    expect(left.functionalAmountCents).toBe(-55_000)
    expect(right.functionalAmountCents).toBe(55_000)
  })
})

describe('what was posted at its face value', () => {
  it('finds a foreign transaction whose books value equals its statement value', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-legacy')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    // What every foreign transaction looked like before Phase 128: euros in a
    // dollar ledger as though they were dollars. Written straight onto the row,
    // because that is what the backfill records for real history.
    await db
      .update(bankTransactions)
      .set({ functionalAmountCents: -50_000, rateMillionths: 1_000_000 })
      .where(eq(bankTransactions.id, tx.id))

    const found = await postedAtFace(fixture.ctx)
    expect(found.map((row) => row.transactionId)).toEqual([tx.id])
    expect(found[0].currency).toBe('EUR')
    expect(found[0].amountCents).toBe(-50_000)
  })

  it('leaves a correctly converted transaction alone', async () => {
    const account = await euroAccount()
    const tx = await euroCharge(account.id, 'eur-fine')
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    expect(await postedAtFace(fixture.ctx)).toEqual([])
  })

  it('never accuses a domestic account, where the two are equal by definition', async () => {
    const tx = await insertTransaction(fixture, { amountCents: -50_000, description: 'Local' })
    await db
      .update(bankTransactions)
      .set({ reviewState: 'categorized', chartAccountId: expenseId })
      .where(eq(bankTransactions.id, tx.id))
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    expect(await postedAtFace(fixture.ctx)).toEqual([])
  })
})
