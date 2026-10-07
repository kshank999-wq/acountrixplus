import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactionRevisions, bankTransactions } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { ROLE_PERMISSIONS, type Role } from '@/modules/permissions'
import { categorize, splitTransaction } from '@/modules/bookkeeping/transactions'
import { ClosedPeriodError, closePeriod, entryForSource } from '@/modules/ledger/journal'
import { connectInstitution, importTransactions } from '@/modules/banking/sync'
import type { ProviderTransaction } from '@/modules/banking/provider'
import {
  CHANGE_KINDS,
  FEED_CHANGE_HOLDS,
  describeRetraction,
  feedChangeHoldFor,
  feedChangeStands,
  retractionDispositionFor,
  type DerivedState,
} from '@/modules/banking/revisions'
import {
  RETRACTED_REASON,
  applyHeldChange,
  dismissRevision,
  heldRevisionCount,
  heldRevisions,
  revisionsForTransaction,
} from '@/modules/banking/revision-service'

/**
 * The transaction the bank took back (Phase 178).
 *
 * ADR 0177's nomination, and the last of Phase 176's three findings.
 * `/transactions/sync` returns `added`, `modified` **and `removed`**. Phase 177
 * fixed what happens to a modified one; a removed one had nowhere to go,
 * because `TransactionPage` carried transactions and a cursor and no way to say
 * *this one was retracted*.
 *
 * So the adapter read the field and dropped it. A withdrawn transaction stayed
 * in the inbox — and if it had been categorised, **the books asserted an expense
 * for money that never moved.** That is the one of the three findings that
 * leaves a wrong row in the books rather than merely a slow sync, which is why
 * it was nominated ahead of the other two.
 */

const EMPTY_DERIVED: DerivedState = {
  hasPostedEntry: false,
  isReconciled: false,
  isCleared: false,
  isSplit: false,
  isMatched: false,
  isTransferLeg: false,
}

function feed(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTransactionId: 'txn-hold',
    providerAccountId: 'test-checking-001',
    postedDate: '2026-08-01',
    amountCents: -4000,
    description: 'HOTEL AUTHORISATION',
    pending: true,
    ...overrides,
  }
}

async function sync(
  fixture: Fixture,
  connectionId: string,
  input: { transactions?: ProviderTransaction[]; retracted?: string[] },
) {
  return importTransactions(fixture.ctx, {
    connectionId,
    transactions: input.transactions ?? [],
    retracted: input.retracted,
    accountByProviderId: new Map([['test-checking-001', { id: fixture.financialAccountId }]]),
  })
}

async function connect(fixture: Fixture): Promise<string> {
  const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })
  return connectionId
}

async function storedRow(fixture: Fixture, providerTransactionId = 'txn-hold') {
  const [row] = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, fixture.companyId),
        eq(bankTransactions.providerTransactionId, providerTransactionId),
      ),
    )
    .limit(1)

  return row
}

function constraintBrokenBy(write: Promise<unknown>): Promise<string | undefined> {
  return write.then(
    () => undefined,
    (error: { cause?: { constraint_name?: string } }) => error.cause?.constraint_name,
  )
}

// ---------------------------------------------------------------------------

describe('one register, two remedies', () => {
  it('gives every ground a distinct remedy for each kind', () => {
    /**
     * The grounds are the same six facts for both kinds — something has been
     * derived from the stored figure — so there is one register and one
     * `applies` predicate per ground. Two registers would have been two copies
     * of six predicates.
     *
     * What differs is the remedy, and `feedChangeStands` now refuses an entry
     * whose retraction remedy is its revision remedy copied across. That check
     * is the point: identical text would pass a length floor and still send
     * somebody to press a button that is not there.
     */
    expect(FEED_CHANGE_HOLDS.flatMap((hold) => feedChangeStands(hold))).toEqual([])
    expect([...CHANGE_KINDS]).toEqual(['revision', 'retraction'])

    for (const hold of FEED_CHANGE_HOLDS) {
      expect(hold.remedy.retraction, hold.key).not.toBe(hold.remedy.revision)
    }
  })

  it('catches a remedy copied from the other kind', () => {
    // Phase 121, applied to the check itself: a rule only ever seen to agree is
    // not a rule. So here is the thing it refuses.
    // Long enough to clear the length floor, so the duplicate check is what
    // fires rather than the one before it — a fixture that tripped the shorter
    // rule would have proved nothing about this one.
    const sameWords =
      'Open the transaction and re-split it at the new total, because the splits are the ' +
      'decision and only the person who made it knows where the difference goes.'

    const copied = {
      ...feedChangeHoldFor('split'),
      remedy: { revision: sameWords, retraction: sameWords },
    }

    expect(sameWords.length).toBeGreaterThan(80)

    expect(feedChangeStands(copied)).toEqual([
      expect.stringContaining('word for word its revision remedy'),
    ])
  })

  it('still declares six grounds in the same order', () => {
    // Unchanged by this phase, and asserted again because the order is what
    // decides which remedy somebody is shown — for either kind.
    expect(FEED_CHANGE_HOLDS.map((hold) => hold.key)).toEqual([
      'reconciled',
      'cleared',
      'split',
      'transfer',
      'matched',
      'posted-to-the-ledger',
    ])
  })
})

describe('whether a withdrawal may be acted on', () => {
  it('applies when nothing was built from the row', () => {
    expect(retractionDispositionFor(EMPTY_DERIVED)).toEqual({ kind: 'apply' })
  })

  it('holds on each of the six grounds, and on the first of them', () => {
    /**
     * Every ground, individually, because a `retractionDispositionFor` that
     * only looked at `hasPostedEntry` would pass a test exercising the common
     * case and silently exclude a reconciled transaction.
     */
    const grounds: [keyof DerivedState, string][] = [
      ['hasPostedEntry', 'posted-to-the-ledger'],
      ['isReconciled', 'reconciled'],
      ['isCleared', 'cleared'],
      ['isSplit', 'split'],
      ['isMatched', 'matched'],
      ['isTransferLeg', 'transfer'],
    ]

    for (const [fact, key] of grounds) {
      const verdict = retractionDispositionFor({ ...EMPTY_DERIVED, [fact]: true })
      if (verdict.kind !== 'hold') expect.unreachable(`${fact} should hold`)
      expect(verdict.ground.key, fact).toBe(key)
    }

    // And when several apply, the one whose remedy comes first.
    const several = retractionDispositionFor({
      hasPostedEntry: true,
      isReconciled: true,
      isCleared: true,
      isSplit: true,
      isMatched: true,
      isTransferLeg: true,
    })
    if (several.kind !== 'hold') expect.unreachable()
    expect(several.ground.key).toBe('reconciled')
  })

  it('has no unchanged case and no descriptive escape hatch', () => {
    /**
     * The asymmetry against a revision, stated as a test. A revision can be
     * harmless — a merchant name settling moves no ledger figure, so it applies
     * even to a reconciled transaction. A withdrawal never is: it always ends
     * with a posting that should not exist or a row in an inbox that should not
     * be reviewed.
     *
     * So `retractionDispositionFor` takes only the derived state. There is no
     * field comparison to make, because a withdrawal is not a different figure
     * — it is the absence of one.
     */
    expect(retractionDispositionFor).toHaveLength(1)

    const sentence = describeRetraction(-4000, feedChangeHoldFor('posted-to-the-ledger'))
    // Names the amount being taken back once, not as a from/to pair — "changed
    // the amount from -40.00 to -40.00" is true and useless.
    expect(sentence).toContain('-40.00')
    expect(sentence).toContain('never moved')
    expect(sentence).toContain(feedChangeHoldFor('posted-to-the-ledger').remedy.retraction)
  })
})

describe('the headline', () => {
  it('excludes a withdrawn transaction nothing was built from', async () => {
    /**
     * **The defect, asserted.** Before this phase the adapter read Plaid's
     * `removed` list and dropped it, so a hotel authorisation that expired
     * stayed in the inbox forever, waiting to be categorised into books it did
     * not belong in.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)

    await sync(fixture, connectionId, { transactions: [feed()] })
    expect((await storedRow(fixture)).reviewState).toBe('new')

    const second = await sync(fixture, connectionId, { retracted: ['txn-hold'] })

    expect(second.retractionsApplied).toBe(1)
    expect(second.retractionsHeld).toBe(0)

    const row = await storedRow(fixture)
    expect(row.reviewState).toBe('excluded')
    // `excluded` and not a seventh review state, with the cause in the reason:
    // a `retracted` state would behave identically in every filter, count and
    // report and differ only in what it was called.
    expect(row.excludeReason).toBe(RETRACTED_REASON)
    expect(row.excludeReason).toContain('never happened')

    // The row survives rather than being deleted, because a reconciliation has
    // to be able to explain itself.
    expect(row.amountCents).toBe(-4000)

    const [logged] = await revisionsForTransaction(fixture.ctx, row.id)
    expect(logged.kind).toBe('retraction')
    expect(logged.disposition).toBe('applied')
    expect(logged.resolvedBy).toBeNull()
  })

  it('holds a withdrawal once the transaction has posted, and leaves the entry standing', async () => {
    /**
     * The other half. Voiding a posted entry is a change to the books, and the
     * feed does not get to make it — the same division Phase 177 drew for a
     * changed figure.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)

    const before = await entryForSource(fixture.ctx, 'bank_transaction', row.id)
    expect(before).not.toBeNull()

    const second = await sync(fixture, connectionId, { retracted: ['txn-hold'] })
    expect(second.retractionsApplied).toBe(0)
    expect(second.retractionsHeld).toBe(1)

    // Nothing moved: not the row, not the entry.
    const after = await storedRow(fixture)
    expect(after.reviewState).toBe('categorized')
    expect(after.excludeReason).toBeNull()

    const entry = await entryForSource(fixture.ctx, 'bank_transaction', row.id)
    expect(entry?.id).toBe(before!.id)
    expect(entry?.status).toBe('posted')

    const [held] = await heldRevisions(fixture.ctx)
    expect(held.kind).toBe('retraction')
    expect(held.holdGround).toBe('posted-to-the-ledger')
    // The retraction remedy, not the revision one — this is where picking the
    // wrong of the two would tell somebody to apply a figure that does not
    // exist.
    expect(held.remedy).toContain('posts nothing in its place')
    expect(held.applyable).toBe(true)
  })

  it('acts on a withdrawal in a sync that imported nothing at all', async () => {
    /**
     * The defect this phase very nearly shipped. `importTransactions` returns
     * early when it has no rows to write, and the first draft returned zeros
     * from there — so a sync carrying an empty `transactions` list and one
     * withdrawal did nothing.
     *
     * That is a real shape, not a contrived one: a pending authorisation
     * expiring in a window where nothing else moved. Phase 177's own defect,
     * one function away from the fix for it.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const summary = await sync(fixture, connectionId, {
      transactions: [],
      retracted: ['txn-hold'],
    })

    expect(summary.imported).toBe(0)
    expect(summary.retractionsApplied).toBe(1)
    expect((await storedRow(fixture)).reviewState).toBe('excluded')
  })

  it('says nothing about a withdrawal for a transaction it never imported', async () => {
    // Not an error. A provider is entitled to retract something inside a window
    // nobody ever pulled, and a sync that threw for it would stop a whole feed
    // over a transaction that does not exist here.
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)

    const summary = await sync(fixture, connectionId, { retracted: ['txn-never-seen'] })

    expect(summary.retractionsApplied).toBe(0)
    expect(summary.retractionsHeld).toBe(0)
  })

  it('treats a source that says nothing as different from one that says none', async () => {
    /**
     * `retracted` is optional on `TransactionPage` and absent for the CSV
     * importer, because a file has no way to withdraw anything. `undefined` is
     * "this source does not say" and `[]` is "nothing was withdrawn", and
     * conflating them would have let a CSV import look like a feed asserting
     * every transaction still stands.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const silent = await sync(fixture, connectionId, { transactions: [feed()] })
    expect(silent.retractionsApplied).toBe(0)
    expect((await storedRow(fixture)).reviewState).toBe('new')
  })
})

describe('what a person does about a held withdrawal', () => {
  async function postedAndRetracted() {
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)
    await sync(fixture, connectionId, { retracted: ['txn-hold'] })

    return { fixture, connectionId, transactionId: row.id }
  }

  it('excludes it and voids the entry, posting nothing in its place', async () => {
    const { fixture, transactionId } = await postedAndRetracted()
    const [held] = await heldRevisions(fixture.ctx)

    const result = await applyHeldChange(fixture.ctx, held.id)

    // The flag the revision path does not set, and the reason there is one
    // entry point: the decision is shared and only the act differs.
    expect(result.excluded).toBe(true)
    expect(result.reposted).toBe(false)

    const row = await storedRow(fixture)
    expect(row.reviewState).toBe('excluded')
    expect(row.excludeReason).toBe(RETRACTED_REASON)

    // `excluded` is not a postable state, so `syncLedgerForTransaction` voids
    // what it had and posts nothing. No live entry at all — not a new one for
    // zero.
    expect(await entryForSource(fixture.ctx, 'bank_transaction', transactionId)).toBeNull()

    const [logged] = await revisionsForTransaction(fixture.ctx, transactionId)
    expect(logged.disposition).toBe('applied')
    expect(logged.resolvedBy).toBe(fixture.userId)
    expect(await heldRevisionCount(fixture.ctx)).toBe(0)
  })

  it('refuses a closed period, and leaves the entry where it was', async () => {
    /**
     * Voiding changes the books, so `voidJournalEntry` calls `assertPeriodOpen`
     * — which is why this works without a second rule here. The assertion that
     * matters is the second one: the row is still `categorized`, because the
     * exclusion and the void are one database transaction.
     */
    const { fixture, transactionId } = await postedAndRetracted()
    const [held] = await heldRevisions(fixture.ctx)

    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(ClosedPeriodError)

    const row = await storedRow(fixture)
    expect(row.reviewState).toBe('categorized')
    expect(row.excludeReason).toBeNull()
    expect(await entryForSource(fixture.ctx, 'bank_transaction', transactionId)).not.toBeNull()
    expect(await heldRevisionCount(fixture.ctx)).toBe(1)
  })

  it('refuses a ground that needs something undone first, with the retraction remedy', async () => {
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const row = await storedRow(fixture)
    const meals = await fixture.account('6400')
    const office = await fixture.account('6100')
    await splitTransaction(fixture.ctx, row.id, [
      { chartAccountId: meals.id, amountCents: -3000 },
      { chartAccountId: office.id, amountCents: -1000 },
    ])

    await sync(fixture, connectionId, { retracted: ['txn-hold'] })

    const [held] = await heldRevisions(fixture.ctx)
    expect(held.holdGround).toBe('split')
    expect(held.applyable).toBe(false)
    // "Remove the splits, then exclude" — not "re-split it at the new total",
    // which is the revision remedy and would be nonsense here: there is no new
    // total.
    expect(held.remedy).toContain('Remove the splits')
    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(/Remove the splits/)

    expect((await storedRow(fixture)).reviewState).toBe('categorized')
  })

  it('records that the transaction stands, and why', async () => {
    const { fixture, transactionId } = await postedAndRetracted()
    const [held] = await heldRevisions(fixture.ctx)

    await dismissRevision(
      fixture.ctx,
      held.id,
      'The charge did clear — the bank withdrew it in error and re-sent it',
    )

    const [logged] = await revisionsForTransaction(fixture.ctx, transactionId)
    expect(logged.disposition).toBe('dismissed')
    expect(logged.resolutionNote).toContain('withdrew it in error')

    // The entry stands, which is what dismissing means here.
    expect(await entryForSource(fixture.ctx, 'bank_transaction', transactionId)).not.toBeNull()
    expect((await storedRow(fixture)).reviewState).toBe('categorized')
  })

  it('treats a transaction somebody already excluded as settled', async () => {
    /**
     * A person reaching the same conclusion first. The withdrawal is satisfied,
     * so it is counted as unchanged rather than re-excluded — otherwise a
     * provider re-sending a withdrawal every five minutes would write an audit
     * entry every five minutes for a decision already made.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })
    const row = await storedRow(fixture)

    await db
      .update(bankTransactions)
      .set({ reviewState: 'excluded', excludeReason: 'Personal, not the business' })
      .where(eq(bankTransactions.id, row.id))

    const summary = await sync(fixture, connectionId, { retracted: ['txn-hold'] })

    expect(summary.retractionsApplied).toBe(0)
    expect(summary.retractionsHeld).toBe(0)
    // And their reason survives, rather than being overwritten with the bank's.
    expect((await storedRow(fixture)).excludeReason).toBe('Personal, not the business')
    expect(await revisionsForTransaction(fixture.ctx, row.id)).toEqual([])
  })
})

describe('the permission this design rests on', () => {
  it('gives categorize to every role that can import', () => {
    /**
     * `recordRetractions` calls `excludeTransaction`, which needs
     * `bookkeeping:categorize`, from a sync that needs `bookkeeping:import`.
     * That is only safe because of a fact about the role matrix, so the fact is
     * pinned here rather than assumed.
     *
     * A role given `import` without `categorize` would make a withdrawal throw
     * `PermissionError` in the middle of a sync, and the sentence a person saw
     * would be about permissions rather than about the bank. This test is what
     * would say so.
     *
     * The reverse is harmless and real: `manager` categorizes and cannot import.
     */
    const offenders = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) => {
      const held = ROLE_PERMISSIONS[role] as readonly string[]
      return held.includes('bookkeeping:import') && !held.includes('bookkeeping:categorize')
    })

    expect(offenders).toEqual([])

    // Measured, not assumed: the three that can import, and one that cannot.
    const importers = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((role) =>
      (ROLE_PERMISSIONS[role] as readonly string[]).includes('bookkeeping:import'),
    )
    expect(importers.sort()).toEqual(['accountant', 'bookkeeper', 'owner'])
    expect(
      (ROLE_PERMISSIONS.manager as readonly string[]).includes('bookkeeping:import'),
    ).toBe(false)
  })
})

describe('what the log refuses to become', () => {
  it('writes one row however many times a withdrawal is re-sent', async () => {
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)

    for (let tick = 0; tick < 5; tick += 1) {
      await sync(fixture, connectionId, { retracted: ['txn-hold'] })
    }

    expect(await revisionsForTransaction(fixture.ctx, row.id)).toHaveLength(1)
    expect(await heldRevisionCount(fixture.ctx)).toBe(1)
  })

  it('keeps a withdrawal distinct from a revision carrying the same figures', async () => {
    /**
     * The collision that put `kind` in the unique key, and it is not
     * hypothetical. A revision **applied** at -4420 writes a row with those
     * figures; a later withdrawal of that same transaction copies them, because
     * a withdrawal has no figures of its own.
     *
     * Without `kind` in the key the withdrawal would conflict with the applied
     * revision and `onConflictDoNothing` would drop it — the feed would have
     * said "this never happened" and the log would have said nothing.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })

    // Applied, because nothing has been built from it yet.
    await sync(fixture, connectionId, {
      transactions: [feed({ amountCents: -4420, pending: false })],
    })
    const row = await storedRow(fixture)
    expect(row.amountCents).toBe(-4420)

    const summary = await sync(fixture, connectionId, { retracted: ['txn-hold'] })
    expect(summary.retractionsApplied).toBe(1)

    const logged = await revisionsForTransaction(fixture.ctx, row.id)
    expect(logged).toHaveLength(2)
    expect(logged.map((entry) => entry.kind).sort()).toEqual(['retraction', 'revision'])
    // Both carry -4420, which is exactly why the key needs the kind.
    expect(logged.every((entry) => entry.amountCents === -4420)).toBe(true)
  })

  it('refuses a retraction that smuggles a figure change in', async () => {
    /**
     * A withdrawal carries no new figures — Plaid sends an id and nothing else
     * — so the new-value columns are copied from the stored row and equal the
     * previous ones by construction.
     *
     * "By construction" is a property of today's writer. As a constraint it
     * stops a future one bypassing the whole revision path: the holds, the
     * re-post, the closed-period refusal.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, { transactions: [feed()] })
    const row = await storedRow(fixture)

    const base = {
      companyId: fixture.companyId,
      bankTransactionId: row.id,
      postedDate: '2026-08-01',
      description: 'x',
      pending: true,
      previousAmountCents: -4000,
      previousPostedDate: '2026-08-01',
      previousPending: true,
      touchesBooks: true,
      disposition: 'applied' as const,
      resolvedAt: new Date(),
    }

    expect(
      await constraintBrokenBy(
        db.insert(bankTransactionRevisions).values({
          ...base,
          kind: 'retraction',
          amountCents: -9999,
        }),
      ),
    ).toBe('bank_transaction_revisions_retraction_check')

    // The same figures as a retraction are fine, and a revision may differ —
    // both directions, so the CHECK is a check rather than a ban.
    expect(
      await constraintBrokenBy(
        db
          .insert(bankTransactionRevisions)
          .values({ ...base, kind: 'retraction', amountCents: -4000 }),
      ),
    ).toBeUndefined()

    expect(
      await constraintBrokenBy(
        db
          .insert(bankTransactionRevisions)
          .values({ ...base, kind: 'revision', amountCents: -9999 }),
      ),
    ).toBeUndefined()
  })
})
