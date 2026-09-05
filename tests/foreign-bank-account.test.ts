import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, financialAccounts } from '@/db/schema'
import { createCompanyFixture, insertTransaction, type Fixture } from './helpers'
import { syncLedgerForTransaction, syncLedgerForTransferPair } from '@/modules/ledger/posting'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { cashTieOut, createFinancialAccount } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import { Refusal } from '@/modules/errors'
import { RateError } from '@/modules/fx/service'

/**
 * A bank account can be foreign, and the ledger cannot (Phase 128).
 *
 * `financial_accounts.currency` has existed since the banking schema was first
 * written and `createFinancialAccount` genuinely stores it. `bank_transactions`
 * has no currency of its own and inherits the account's — so until this phase
 * `buildLines` put `Math.abs(amountCents)` straight into `debitCents`, and every
 * categorised transaction on a euro account posted euros into a dollar ledger.
 *
 * Phase 127's scan could not see it: `financial_accounts` was missing from a
 * list of currency-bearing tables somebody had typed out by hand.
 */

let fixture: Fixture
let expenseId: string
const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Cross Border Ltd' })
  expenseId = (await fixture.account('6000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-08-01',
    rateMillionths: 1_100_000,
    source: 'manual',
  })
})

async function euroAccount(name = 'Frankfurt Current') {
  return createFinancialAccount(fixture.ctx, { name, kind: 'checking', currency: 'EUR' })
}

/** Categorised, which is what makes a transaction postable. */
async function categorise(transactionId: string, chartAccountId: string) {
  await db
    .update(bankTransactions)
    .set({ reviewState: 'categorized', chartAccountId })
    .where(eq(bankTransactions.id, transactionId))
}

describe('a transaction on a foreign account', () => {
  it('posts what it is worth in the books, not what the statement says', async () => {
    const account = await euroAccount()
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-1',
        postedDate: '2026-08-01',
        amountCents: -50_000,
        description: 'Werkzeug GmbH',
      })
      .returning()

    await categorise(tx.id, expenseId)
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    // €500 at 1.10. The defect in one assertion: this was 50000 before Phase
    // 128 — the euros, posted as if they were dollars, on every categorised
    // transaction of every foreign account since the bank feed was built.
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(55_000)
  })

  it('leaves a domestic account exactly as it was, which is why nobody noticed', async () => {
    const tx = await insertTransaction(fixture, { amountCents: -50_000, description: 'Local' })
    await categorise(tx.id, expenseId)
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    // The rate is 1,000,000 and the multiplication a no-op. Every account
    // anybody had was domestic, so the defect never showed.
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(50_000)
  })

  it('refuses rather than guessing when no rate covers the day it moved', async () => {
    const account = await euroAccount()
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-early',
        // Before the only rate on file. Phase 117's rule, and `rateFor`'s own
        // sentence already tells the person what to do about it.
        postedDate: '2026-01-15',
        amountCents: -50_000,
        description: 'Werkzeug GmbH',
      })
      .returning()

    await categorise(tx.id, expenseId)

    await expect(syncLedgerForTransaction(fixture.ctx, tx.id, db)).rejects.toThrow(RateError)
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(0)
  })

  it('converts a split at the same rate as the transaction it belongs to', async () => {
    const account = await euroAccount()
    const second = (await fixture.account('6100')).id
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-split',
        postedDate: '2026-08-01',
        amountCents: -100_000,
        description: 'Two sites',
        isSplit: true,
        reviewState: 'categorized',
      })
      .returning()

    const { transactionSplits } = await import('@/db/schema')
    await db.insert(transactionSplits).values([
      {
        companyId: fixture.companyId,
        transactionId: tx.id,
        chartAccountId: expenseId,
        amountCents: -60_000,
        sortOrder: 0,
      },
      {
        companyId: fixture.companyId,
        transactionId: tx.id,
        chartAccountId: second,
        amountCents: -40_000,
        sortOrder: 1,
      },
    ])

    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    // €600 and €400 at 1.10, summing to the €1,000 bank line — one rate for
    // the whole movement, so the entry cannot be a cent out against itself.
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(66_000)
    expect(await balanceForAccount(fixture.ctx, second, YEAR)).toBe(44_000)
  })
})

describe('the nightly check that compares the two', () => {
  it('sets the feed beside the ledger in the same currency', async () => {
    const account = await euroAccount()
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-tie',
        postedDate: '2026-08-01',
        amountCents: -50_000,
        description: 'Werkzeug GmbH',
      })
      .returning()

    await categorise(tx.id, expenseId)
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    const row = (await cashTieOut(fixture.ctx)).find((r) => r.financialAccountId === account.id)!

    // What the bank says, in the bank's money; what the books say, in ours;
    // and the difference computed between two figures that are the same kind
    // of number. Before Phase 128 both sides read -50000 and agreed — which
    // is the only reason a euros-into-a-dollar-ledger posting survived.
    expect(row.currency).toBe('EUR')
    expect(row.feedCents).toBe(-50_000)
    expect(row.feedFunctionalCents).toBe(-55_000)
    expect(row.ledgerCents).toBe(-55_000)
    expect(row.differenceCents).toBe(0)
  })

  it('says it cannot tell, rather than agreeing, when a day has no rate', async () => {
    const account = await euroAccount()
    await db.insert(bankTransactions).values({
      companyId: fixture.companyId,
      financialAccountId: account.id,
      providerTransactionId: 'eur-norate',
      // Before the only rate on file, and categorised — so it counts towards
      // the feed and could never have reached the ledger.
      postedDate: '2026-01-15',
      amountCents: -50_000,
      description: 'Werkzeug GmbH',
      reviewState: 'categorized',
      chartAccountId: expenseId,
    })

    const row = (await cashTieOut(fixture.ctx)).find((r) => r.financialAccountId === account.id)!

    expect(row.feedFunctionalCents).toBeNull()
    expect(row.differenceCents).toBeNull()
    expect(row.unconvertibleCount).toBe(1)
  })

  it('leaves a domestic account byte-for-byte what it was', async () => {
    const tx = await insertTransaction(fixture, { amountCents: -50_000, description: 'Local' })
    await categorise(tx.id, expenseId)
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    const row = (await cashTieOut(fixture.ctx)).find(
      (r) => r.financialAccountId === fixture.financialAccountId,
    )!

    expect(row.feedCents).toBe(-50_000)
    expect(row.feedFunctionalCents).toBe(-50_000)
    expect(row.differenceCents).toBe(0)
    expect(row.unconvertibleCount).toBe(0)
  })
})

describe('a transfer between two accounts', () => {
  it('refuses when they are held in different currencies', async () => {
    const euros = await euroAccount()
    const [out] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: fixture.financialAccountId,
        providerTransactionId: 'xfer-out',
        postedDate: '2026-08-01',
        amountCents: -50_000,
        description: 'To Frankfurt',
        reviewState: 'categorized',
      })
      .returning()
    const [into] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: euros.id,
        providerTransactionId: 'xfer-in',
        postedDate: '2026-08-01',
        amountCents: 45_000,
        description: 'From checking',
        reviewState: 'categorized',
      })
      .returning()

    // Not a transfer at all: the bank takes one amount out and puts a
    // different one in, and the difference is a realised gain nobody has
    // decided to recognise. Phase 123's answer for a mixed-currency deposit.
    await expect(
      syncLedgerForTransferPair(fixture.ctx, out.id, into.id, db),
    ).rejects.toThrow(Refusal)
  })

  it('converts once for both legs when they agree', async () => {
    const first = await euroAccount('Frankfurt One')
    const secondAccount = await euroAccount('Frankfurt Two')
    const [out] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: first.id,
        providerTransactionId: 'eu-out',
        postedDate: '2026-08-01',
        amountCents: -50_000,
        description: 'Sweep',
        reviewState: 'categorized',
      })
      .returning()
    const [into] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: secondAccount.id,
        providerTransactionId: 'eu-in',
        postedDate: '2026-08-01',
        amountCents: 50_000,
        description: 'Sweep',
        reviewState: 'categorized',
      })
      .returning()

    const result = await syncLedgerForTransferPair(fixture.ctx, out.id, into.id, db)
    expect(result.posted).toBe(true)

    const [destination] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, secondAccount.id))

    // €500 at 1.10 into the receiving account's ledger account.
    expect(await balanceForAccount(fixture.ctx, destination.chartAccountId, YEAR)).toBe(55_000)
  })
})
