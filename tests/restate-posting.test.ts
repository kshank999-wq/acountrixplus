import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, journalEntries, transactionSplits } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { syncLedgerForTransaction } from '@/modules/ledger/posting'
import { restatePosting } from '@/modules/ledger/restate'
import { balanceForAccount } from '@/modules/ledger/balances'
import { cashTieOut, createFinancialAccount, postedAtFace } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import { DomainError } from '@/modules/errors'

/**
 * The repair three ADRs declined to build (Phase 130).
 *
 * ADR 0127, 0128 and 0129 each end by saying a repair is a dated correction and
 * then not building one. A restatement is a **second entry** carrying the
 * difference: the original stays where it is, because rewriting it is exactly
 * what Phase 129 stopped.
 */

let fixture: Fixture
let expenseId: string
let otherExpenseId: string
const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Restate Ltd' })
  expenseId = (await fixture.account('6000')).id
  otherExpenseId = (await fixture.account('6100')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: 1_000_000,
    source: 'manual',
  })
})

/**
 * A euro account whose rate is parity, so a posting lands at its face value —
 * which is exactly what every foreign transaction looked like before Phase 128,
 * and what this phase exists to put right.
 */
async function faceValuePosting(amountCents = -80_000) {
  const account = await createFinancialAccount(fixture.ctx, {
    name: 'Frankfurt Current',
    kind: 'checking',
    currency: 'EUR',
  })

  const [tx] = await db
    .insert(bankTransactions)
    .values({
      companyId: fixture.companyId,
      financialAccountId: account.id,
      providerTransactionId: `eur-${Math.abs(amountCents)}`,
      postedDate: '2026-08-02',
      amountCents,
      description: 'Hardware Handel',
      reviewState: 'categorized',
      chartAccountId: expenseId,
    })
    .returning()

  await syncLedgerForTransaction(fixture.ctx, tx.id, db)
  return { account, tx }
}

async function liveEntries(transactionId: string) {
  return db
    .select({ id: journalEntries.id, sourceType: journalEntries.sourceType })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, fixture.companyId),
        eq(journalEntries.sourceId, transactionId),
        isNull(journalEntries.voidedAt),
      ),
    )
}

async function reload(id: string) {
  const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, id))
  return row
}

describe('restating a posting that went in at its face value', () => {
  it('posts the difference and leaves the original alone', async () => {
    const { tx } = await faceValuePosting()
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(80_000)

    const result = await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 1_100_000,
      reason: 'Posted at parity before the August rate was entered.',
      correctionDate: '2026-09-05',
    })

    // €800 should have been $880. The correcting entry carries the $80.
    expect(result.deltaCents).toBe(8_000)
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(88_000)

    // Two live entries: the original, untouched, and the correction beside it.
    const entries = await liveEntries(tx.id)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.sourceType).sort()).toEqual([
      'bank_transaction',
      'bank_transaction_restatement',
    ])
  })

  it('moves the stored pair, so the books and the row agree afterwards', async () => {
    const { account, tx } = await faceValuePosting()

    await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 1_100_000,
      reason: 'Posted at parity before the August rate was entered.',
      correctionDate: '2026-09-05',
    })

    const row = await reload(tx.id)
    expect(row.rateMillionths).toBe(1_100_000)
    expect(row.functionalAmountCents).toBe(-88_000)

    // The tie-out keeps agreeing: the ledger and the stored twin moved by the
    // same delta, which is the point of updating the pair.
    const tie = (await cashTieOut(fixture.ctx)).find((r) => r.financialAccountId === account.id)!
    expect(tie.feedFunctionalCents).toBe(-88_000)
    expect(tie.ledgerCents).toBe(-88_000)
    expect(tie.differenceCents).toBe(0)
  })

  it('stops the check reporting it', async () => {
    const { tx } = await faceValuePosting()
    expect(await postedAtFace(fixture.ctx)).toHaveLength(1)

    await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 1_100_000,
      reason: 'Posted at parity before the August rate was entered.',
      correctionDate: '2026-09-05',
    })

    expect(await postedAtFace(fixture.ctx)).toEqual([])
  })

  it('can take a figure down as well as up', async () => {
    const { tx } = await faceValuePosting()

    const result = await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 900_000,
      reason: 'The euro was weaker that day than the entered rate implied.',
      correctionDate: '2026-09-05',
    })

    expect(result.deltaCents).toBe(-8_000)
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(72_000)
  })

  it('allocates across a split, part by part', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Frankfurt Split',
      kind: 'checking',
      currency: 'EUR',
    })
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-split',
        postedDate: '2026-08-02',
        amountCents: -100_000,
        description: 'Two sites',
        isSplit: true,
        reviewState: 'categorized',
      })
      .returning()

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
        chartAccountId: otherExpenseId,
        amountCents: -40_000,
        sortOrder: 1,
      },
    ])
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 1_100_000,
      reason: 'Posted at parity before the August rate was entered.',
      correctionDate: '2026-09-05',
    })

    // Each part scaled and the bank line taking their sum — Phase 35's rule,
    // so the entry cannot be a cent out against itself.
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(66_000)
    expect(await balanceForAccount(fixture.ctx, otherExpenseId, YEAR)).toBe(44_000)
  })
})

describe('what a restatement refuses', () => {
  it('refuses without a reason, in the words that asked for one', async () => {
    const { tx } = await faceValuePosting()

    await expect(
      restatePosting(fixture.ctx, {
        transactionId: tx.id,
        toRateMillionths: 1_100_000,
        reason: '   ',
        correctionDate: '2026-09-05',
      }),
    ).rejects.toThrow(/Say why/)
  })

  it('refuses a transaction that never posted, and says what to do instead', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Frankfurt Inbox',
      kind: 'checking',
      currency: 'EUR',
    })
    const [tx] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: account.id,
        providerTransactionId: 'eur-inbox',
        postedDate: '2026-08-02',
        amountCents: -80_000,
        description: 'Still waiting',
      })
      .returning()

    await expect(
      restatePosting(fixture.ctx, {
        transactionId: tx.id,
        toRateMillionths: 1_100_000,
        reason: 'Nothing to correct.',
        correctionDate: '2026-09-05',
      }),
    ).rejects.toThrow(/Categorise it/)
  })

  it('refuses a rate that leaves the books exactly where they are', async () => {
    const { tx } = await faceValuePosting()

    await expect(
      restatePosting(fixture.ctx, {
        transactionId: tx.id,
        toRateMillionths: 1_000_000,
        reason: 'No change at all.',
        correctionDate: '2026-09-05',
      }),
    ).rejects.toThrow(DomainError)
  })
})

describe('a restatement and a later re-categorisation', () => {
  it('does not count the difference twice', async () => {
    const { tx } = await faceValuePosting()

    await restatePosting(fixture.ctx, {
      transactionId: tx.id,
      toRateMillionths: 1_100_000,
      reason: 'Posted at parity before the August rate was entered.',
      correctionDate: '2026-09-05',
    })
    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(88_000)

    // Somebody moves it to a different account. The rebuilt entry already
    // carries the restated rate — Phase 129 keeps it — so the correcting entry
    // must go with the original or the $80 lands twice.
    await db
      .update(bankTransactions)
      .set({ chartAccountId: otherExpenseId })
      .where(eq(bankTransactions.id, tx.id))
    await syncLedgerForTransaction(fixture.ctx, tx.id, db)

    expect(await balanceForAccount(fixture.ctx, expenseId, YEAR)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, otherExpenseId, YEAR)).toBe(88_000)

    // One live entry again: the rebuilt posting, at the restated rate.
    expect(await liveEntries(tx.id)).toHaveLength(1)
  })
})
