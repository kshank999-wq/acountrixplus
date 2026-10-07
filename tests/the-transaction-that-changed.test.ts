import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactionRevisions,
  bankTransactions,
  journalEntries,
  journalLines,
} from '@/db/schema'
import { createCompanyFixture, addUserWithRole, type Fixture } from './helpers'
import { RegistryError } from '@/modules/errors/registry'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'
import { categorize, splitTransaction } from '@/modules/bookkeeping/transactions'
import { ClosedPeriodError, closePeriod, entryForSource } from '@/modules/ledger/journal'
import { connectInstitution, importTransactions } from '@/modules/banking/sync'
import type { ProviderTransaction } from '@/modules/banking/provider'
import {
  BOOK_AFFECTING_FIELDS,
  DESCRIPTIVE_FIELDS,
  FEED_CHANGE_HOLDS,
  describeHold,
  dispositionFor,
  feedChangeHoldFor,
  feedChangeStands,
  type DerivedState,
  type RevisableValues,
} from '@/modules/banking/revisions'
import {
  applyHeldChange,
  dismissRevision,
  heldRevisionCount,
  heldRevisions,
  revisionsForTransaction,
} from '@/modules/banking/revision-service'

/**
 * What the bank did after we wrote it down (Phase 177).
 *
 * ## The defect these tests exist for
 *
 * `/transactions/sync` returns `added`, `modified` and `removed`. Phase 176's
 * adapter handed the first two over correctly, and `importTransactions` then did
 * `ON CONFLICT DO NOTHING` — so a **modified** transaction was dropped on the
 * floor. The universal case is the one every bank does: a pending transaction
 * posts, and its amount changes by the tip. The inbox kept the pending figure
 * forever, a reconciliation against the real statement did not close, and the
 * difference was the tip.
 *
 * `ON CONFLICT DO UPDATE` is the one-line fix and the wrong one: it would
 * silently rewrite a transaction somebody had already posted to the ledger,
 * possibly in a closed period, under a reconciliation they had certified.
 *
 * So the test that matters most is the pair at the top of *the headline* below —
 * one asserting the figure now follows the bank, and one asserting it does not
 * when something has been built from it. Either alone would pass with the fix
 * half-made in the wrong direction.
 */

const EMPTY_DERIVED: DerivedState = {
  hasPostedEntry: false,
  isReconciled: false,
  isCleared: false,
  isSplit: false,
  isMatched: false,
  isTransferLeg: false,
}

const STORED: RevisableValues = {
  amountCents: -4000,
  postedDate: '2026-08-01',
  description: 'SQ *COFFEE SHOP',
  merchantName: null,
  providerCategory: null,
  pending: true,
}

/** A pending $40 charge settling at $44.20 — the tip. */
const SETTLED: RevisableValues = {
  ...STORED,
  amountCents: -4420,
  pending: false,
}

function feed(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    providerTransactionId: 'txn-coffee',
    providerAccountId: 'test-checking-001',
    postedDate: '2026-08-01',
    amountCents: -4000,
    description: 'SQ *COFFEE SHOP',
    pending: true,
    ...overrides,
  }
}

/**
 * Pushes a feed through the real import path.
 *
 * `importTransactions` and not the mock provider, because these tests are about
 * a *specific* second payload for a *specific* transaction and the mock's feed
 * is generated. The path is otherwise the one `syncConnection` uses — the same
 * insert, the same conflict target, the same revision handling.
 */
async function sync(fixture: Fixture, connectionId: string, transactions: ProviderTransaction[]) {
  return importTransactions(fixture.ctx, {
    connectionId,
    transactions,
    accountByProviderId: new Map([['test-checking-001', { id: fixture.financialAccountId }]]),
  })
}

async function connect(fixture: Fixture): Promise<string> {
  const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })
  return connectionId
}

async function storedRow(fixture: Fixture, providerTransactionId = 'txn-coffee') {
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

/**
 * The constraint a write broke.
 *
 * On the driver error's `cause`, not its message: the message is
 * `Failed query: insert into …` with the parameters appended, so a
 * `toThrow(/my_constraint/)` passes for any rejected insert and fails for the
 * right one. Both uses below were written that way first and both passed
 * against a *different* constraint than they named.
 */
async function constraintBrokenBy(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write
    return undefined
  } catch (error) {
    return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name
  }
}

// ---------------------------------------------------------------------------

describe('the register of grounds', () => {
  it('argues every ground and names a remedy for it', () => {
    /**
     * Phase 101's device, with a second floor Phase 119 adds: a held revision
     * whose ground names no remedy is a transaction that is wrong forever and
     * says so. Every remedy here is a screen that already exists.
     */
    const problems = FEED_CHANGE_HOLDS.flatMap((hold) => feedChangeStands(hold))
    expect(problems).toEqual([])
  })

  it('declares six grounds, counted rather than bounded', () => {
    // Phase 126.
    expect(FEED_CHANGE_HOLDS).toHaveLength(6)
    expect(new Set(FEED_CHANGE_HOLDS.map((hold) => hold.key)).size).toBe(6)
  })

  it('orders them by what has to be undone first', () => {
    /**
     * The order is load-bearing, not cosmetic. A transaction can be reconciled
     * *and* posted *and* split, and the ground reported is the one whose remedy
     * comes first — telling somebody to re-split a transaction a completed
     * reconciliation has locked sends them to a screen that will refuse them.
     *
     * Asserted exactly rather than as a property, because "sorted correctly" is
     * not a thing a reader can check and this list is.
     */
    expect(FEED_CHANGE_HOLDS.map((hold) => hold.key)).toEqual([
      'reconciled',
      'cleared',
      'split',
      'transfer',
      'matched',
      'posted-to-the-ledger',
    ])
  })

  it('throws on a ground nobody declared, naming the ones that exist', () => {
    expect(() => feedChangeHoldFor('pending')).toThrow(RegistryError)

    try {
      feedChangeHoldFor('pending')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('FEED_CHANGE_HOLDS')
      expect((error as RegistryError).message).toContain('posted-to-the-ledger')
    }
  })

  it('splits the fields by whether the books are built from them', () => {
    // The whole mechanism in two lists. `pending` is descriptive and
    // `postedDate` is not, which is the division somebody will want to argue
    // with — a date moves a figure into a different month.
    expect([...BOOK_AFFECTING_FIELDS]).toEqual(['amountCents', 'postedDate'])
    expect([...DESCRIPTIVE_FIELDS]).toEqual([
      'description',
      'merchantName',
      'providerCategory',
      'pending',
    ])
  })
})

describe('what a feed may rewrite', () => {
  it('says nothing happened when the feed re-sends what we hold', () => {
    // The commonest outcome by far, and the one the dedup guarantee was built
    // for. It must stay free.
    expect(dispositionFor({ stored: STORED, incoming: STORED, derived: EMPTY_DERIVED })).toEqual({
      kind: 'unchanged',
    })
  })

  it('applies an amount change to a row nothing was built from', () => {
    const disposition = dispositionFor({
      stored: STORED,
      incoming: SETTLED,
      derived: EMPTY_DERIVED,
    })

    expect(disposition.kind).toBe('apply')
    // The default falls *this* way on purpose: the row is a copy of the feed,
    // and the feed is the authority on what the bank did. The holds are the
    // exceptions.
    if (disposition.kind !== 'apply') expect.unreachable()
    expect(disposition.touchesBooks).toBe(true)
    expect(disposition.changes.map((change) => change.field)).toEqual(['amountCents', 'pending'])
  })

  it('applies a descriptive change even to a reconciled, posted transaction', () => {
    /**
     * The asymmetry that makes the split worth having. A provider settling a
     * merchant name from `SQ *COFFEE` to `Coffee Shop`, or flipping `pending`
     * with the amount unchanged, has told us something harmless — no ledger
     * figure moves, so holding it would be a queue of nothing for somebody to
     * clear.
     */
    const disposition = dispositionFor({
      stored: STORED,
      incoming: { ...STORED, merchantName: 'Coffee Shop', pending: false },
      derived: {
        hasPostedEntry: true,
        isReconciled: true,
        isCleared: true,
        isSplit: true,
        isMatched: true,
        isTransferLeg: true,
      },
    })

    expect(disposition.kind).toBe('apply')
    if (disposition.kind !== 'apply') expect.unreachable()
    expect(disposition.touchesBooks).toBe(false)
  })

  it('holds an amount change on a posted transaction', () => {
    const disposition = dispositionFor({
      stored: STORED,
      incoming: SETTLED,
      derived: { ...EMPTY_DERIVED, hasPostedEntry: true },
    })

    expect(disposition.kind).toBe('hold')
    if (disposition.kind !== 'hold') expect.unreachable()
    expect(disposition.ground.key).toBe('posted-to-the-ledger')
  })

  it('holds a date change too, because a date moves a figure into another month', () => {
    const disposition = dispositionFor({
      stored: STORED,
      incoming: { ...STORED, postedDate: '2026-09-01' },
      derived: { ...EMPTY_DERIVED, hasPostedEntry: true },
    })

    expect(disposition.kind).toBe('hold')
  })

  it('reports the ground whose remedy comes first', () => {
    const disposition = dispositionFor({
      stored: STORED,
      incoming: SETTLED,
      derived: {
        hasPostedEntry: true,
        isReconciled: true,
        isCleared: true,
        isSplit: true,
        isMatched: true,
        isTransferLeg: true,
      },
    })

    if (disposition.kind !== 'hold') expect.unreachable()
    expect(disposition.ground.key).toBe('reconciled')
    // `.remedy.revision` since Phase 178 gave each ground a remedy per kind,
    // because a withdrawal's remedy ends in a different button.
    expect(disposition.ground.remedy.revision).toContain('Reopen the reconciliation')
  })

  it('distinguishes cleared in an open session from reconciled', () => {
    /**
     * Two different people in two different situations. `cleared` is somebody
     * sitting in front of a difference they are trying to close, and the
     * remedy is "finish the session". `reconciled` is a certificate that has
     * been signed, and the remedy is "reopen it".
     *
     * Both directions, because a `cleared` ground that also fired on reconciled
     * rows would send everybody to the wrong screen and still pass a test that
     * only checked one.
     */
    const open = dispositionFor({
      stored: STORED,
      incoming: SETTLED,
      derived: { ...EMPTY_DERIVED, isCleared: true },
    })
    if (open.kind !== 'hold') expect.unreachable()
    expect(open.ground.key).toBe('cleared')

    const certified = dispositionFor({
      stored: STORED,
      incoming: SETTLED,
      derived: { ...EMPTY_DERIVED, isCleared: true, isReconciled: true },
    })
    if (certified.kind !== 'hold') expect.unreachable()
    expect(certified.ground.key).toBe('reconciled')
  })

  it('treats a merchant name the provider stopped sending as a change', () => {
    /**
     * `null` and `''` are different and so are `null` and a name. A provider
     * that stops sending a merchant name has told us it no longer knows one,
     * and silently keeping the old value would be this module inventing data.
     */
    const disposition = dispositionFor({
      stored: { ...STORED, merchantName: 'Coffee Shop' },
      incoming: { ...STORED, merchantName: null },
      derived: EMPTY_DERIVED,
    })

    expect(disposition.kind).toBe('apply')
    if (disposition.kind !== 'apply') expect.unreachable()
    expect(disposition.changes).toEqual([
      { field: 'merchantName', from: 'Coffee Shop', to: null },
    ])
  })

  it('writes one sentence naming both figures and the remedy', () => {
    const ground = feedChangeHoldFor('posted-to-the-ledger')
    const sentence = describeHold(
      [{ field: 'amountCents', from: -4000, to: -4420 }],
      ground,
    )

    // Signed the way the statement reads it, and with no currency symbol: a
    // bank transaction has no currency of its own, it inherits the account's.
    expect(sentence).toContain('-40.00')
    expect(sentence).toContain('-44.20')
    expect(sentence).toContain(ground.remedy.revision)
  })
})

// ---------------------------------------------------------------------------

describe('the headline', () => {
  it('follows the bank when a pending transaction settles at a different amount', async () => {
    /**
     * **The defect, asserted.** Before this phase the second sync returned
     * `duplicates: 1` and the row kept `-4000` — the pending figure — forever.
     * A reconciliation against the real statement would then be out by exactly
     * $4.20, with nothing anywhere saying why.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)

    const first = await sync(fixture, connectionId, [feed()])
    expect(first.imported).toBe(1)

    const second = await sync(fixture, connectionId, [
      feed({ amountCents: -4420, pending: false, merchantName: 'Coffee Shop' }),
    ])

    // Not an import, and no longer a bare duplicate either.
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(second.revisionsApplied).toBe(1)
    expect(second.revisionsHeld).toBe(0)

    const row = await storedRow(fixture)
    expect(row.amountCents).toBe(-4420)
    expect(row.pending).toBe(false)
    expect(row.merchantName).toBe('Coffee Shop')

    // And there is one row left behind saying the bank did it, which is what
    // makes this an audit trail rather than a silent overwrite in the other
    // direction.
    const revisions = await revisionsForTransaction(fixture.ctx, row.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0].disposition).toBe('applied')
    expect(revisions[0].previousAmountCents).toBe(-4000)
    expect(revisions[0].amountCents).toBe(-4420)
    expect(revisions[0].touchesBooks).toBe(true)
    // Nobody decided it — the bank did.
    expect(revisions[0].resolvedBy).toBeNull()
    expect(revisions[0].resolvedAt).not.toBeNull()
  })

  it('does not follow the bank once the transaction has posted', async () => {
    /**
     * The other half, and the reason `onConflictDoUpdate` was the wrong fix.
     * The journal entry was built from `-4000`; rewriting the row to `-4420`
     * without touching the entry would leave the bank transaction and its own
     * derived posting disagreeing, with no record of when they started to.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)

    const entryBefore = await entryForSource(fixture.ctx, 'bank_transaction', row.id)
    expect(entryBefore).not.toBeNull()

    const second = await sync(fixture, connectionId, [
      feed({ amountCents: -4420, pending: false }),
    ])

    expect(second.revisionsApplied).toBe(0)
    expect(second.revisionsHeld).toBe(1)

    // The row did not move.
    const after = await storedRow(fixture)
    expect(after.amountCents).toBe(-4000)

    // Nor did the books.
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryBefore!.id))
    expect(lines.some((line) => Math.abs(line.debitCents - 4000) === 0)).toBe(true)

    const [revision] = await revisionsForTransaction(fixture.ctx, row.id)
    expect(revision.disposition).toBe('held')
    expect(revision.holdGround).toBe('posted-to-the-ledger')
  })

  it('leaves the dedup guarantee exactly where it was', async () => {
    /**
     * The property this function has carried since Phase 1 and must not have
     * lost: re-importing the same window writes nothing. `onConflictDoNothing`
     * is untouched; what changed is that "the insert declined it" stopped being
     * the end of the story.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)

    await sync(fixture, connectionId, [feed()])
    const repeat = await sync(fixture, connectionId, [feed()])

    expect(repeat.imported).toBe(0)
    expect(repeat.duplicates).toBe(1)
    expect(repeat.revisionsApplied).toBe(0)
    expect(repeat.revisionsHeld).toBe(0)

    // An identical re-send writes no revision row at all, which is what keeps
    // the log readable rather than one entry per worker tick forever.
    const row = await storedRow(fixture)
    expect(await revisionsForTransaction(fixture.ctx, row.id)).toEqual([])
  })
})

describe('what a person can do about a held one', () => {
  async function postedAndRevised() {
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)
    await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])

    return { fixture, connectionId, transactionId: row.id }
  }

  it('shows it with the remedy rather than the register key', async () => {
    const { fixture, transactionId } = await postedAndRevised()

    const held = await heldRevisions(fixture.ctx)

    expect(held).toHaveLength(1)
    expect(await heldRevisionCount(fixture.ctx)).toBe(1)
    expect(held[0].transactionId).toBe(transactionId)
    expect(held[0].fromAmountCents).toBe(-4000)
    expect(held[0].toAmountCents).toBe(-4420)
    expect(held[0].accountName).toBe('Business Checking')
    // The account's own currency, so a screen does not stamp a dollar sign on a
    // euro account.
    expect(held[0].currency).toBe('USD')
    // `posted-to-the-ledger` says nothing to a person; the remedy names a
    // screen (Phase 119).
    expect(held[0].remedy).toContain('voids the entry and re-posts')
    expect(held[0].applyable).toBe(true)
  })

  it('applies it and re-posts the entry at the new amount', async () => {
    const { fixture, transactionId } = await postedAndRevised()
    const [held] = await heldRevisions(fixture.ctx)

    const result = await applyHeldChange(fixture.ctx, held.id)
    expect(result.reposted).toBe(true)

    const row = await storedRow(fixture)
    expect(row.amountCents).toBe(-4420)

    // One live entry, carrying the new figure. `syncLedgerForTransaction` voids
    // the old one rather than stacking a second — the difference must not be
    // counted twice.
    const entry = await entryForSource(fixture.ctx, 'bank_transaction', transactionId)
    expect(entry).not.toBeNull()
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry!.id))
    expect(lines.some((line) => line.debitCents === 4420)).toBe(true)

    const live = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.sourceId, transactionId),
          eq(journalEntries.status, 'posted'),
        ),
      )
    expect(live).toHaveLength(1)

    const [revision] = await revisionsForTransaction(fixture.ctx, transactionId)
    expect(revision.disposition).toBe('applied')
    expect(revision.holdGround).toBeNull()
    // A person decided this one, unlike the ones the feed applies.
    expect(revision.resolvedBy).toBe(fixture.userId)

    expect(await heldRevisions(fixture.ctx)).toEqual([])
  })

  it('refuses to apply the same revision twice', async () => {
    const { fixture } = await postedAndRevised()
    const [held] = await heldRevisions(fixture.ctx)

    await applyHeldChange(fixture.ctx, held.id)
    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(/already applied/)
  })

  it('records why the stored figure stands, and insists on a reason', async () => {
    const { fixture, transactionId } = await postedAndRevised()
    const [held] = await heldRevisions(fixture.ctx)

    // A dismissal is the books disagreeing with the bank on purpose. In a year
    // the note is the only thing that will explain it.
    await expect(dismissRevision(fixture.ctx, held.id, '  ')).rejects.toThrow(/Say why/)

    await dismissRevision(fixture.ctx, held.id, 'Duplicate charge, the bank reversed it separately')

    const [revision] = await revisionsForTransaction(fixture.ctx, transactionId)
    expect(revision.disposition).toBe('dismissed')
    expect(revision.resolutionNote).toContain('reversed it separately')
    expect(revision.resolvedBy).toBe(fixture.userId)

    // And the row kept its figure.
    expect((await storedRow(fixture)).amountCents).toBe(-4000)
    expect(await heldRevisionCount(fixture.ctx)).toBe(0)
  })

  it('refuses a closed period, and rolls the amount back with it', async () => {
    /**
     * The case that makes the hold worth the machinery. Applying means voiding
     * and re-posting, and re-posting into a month somebody has already reported
     * on is refused by `ClosedPeriodError` — the same error that refuses a
     * person recategorizing it.
     *
     * The assertion that matters is the second one: the row's amount is back to
     * `-4000`. The update runs *before* the re-post, so without the whole thing
     * being one database transaction the bank transaction would carry `-4420`
     * while the ledger carried `-4000` and nothing would have reported a
     * failure that mattered.
     */
    const { fixture } = await postedAndRevised()
    const [held] = await heldRevisions(fixture.ctx)

    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(ClosedPeriodError)

    expect((await storedRow(fixture)).amountCents).toBe(-4000)
    // Still held, so it is still in front of somebody.
    expect(await heldRevisionCount(fixture.ctx)).toBe(1)
  })

  it('needs the categorizing permission, not the importing one', async () => {
    /**
     * Importing a feed is clerical. Deciding the books should now say $44.20 is
     * the categorizing decision, so it takes the categorizing permission — a
     * `readonly` role can see the held list and cannot resolve it.
     */
    const { fixture } = await postedAndRevised()
    const [held] = await heldRevisions(fixture.ctx)

    const readonly = await addUserWithRole(fixture, 'readonly')

    expect(await heldRevisionCount(readonly)).toBe(1)
    await expect(applyHeldChange(readonly, held.id)).rejects.toThrow(PermissionError)
    await expect(dismissRevision(readonly, held.id, 'no reason')).rejects.toThrow(PermissionError)
  })
})

describe('the grounds that need something undone first', () => {
  it('holds a split transaction and refuses to divide the difference', async () => {
    /**
     * The one thing that must not happen automatically. The extra $4.20 on a
     * split restaurant bill is the tip, and nothing here can know which line it
     * belongs on — so the refusal sends the person who made the split back to
     * remake it.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    const meals = await fixture.account('6400')
    const office = await fixture.account('6100')
    await splitTransaction(fixture.ctx, row.id, [
      { chartAccountId: meals.id, amountCents: -3000 },
      { chartAccountId: office.id, amountCents: -1000 },
    ])

    const second = await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])
    expect(second.revisionsHeld).toBe(1)

    const [held] = await heldRevisions(fixture.ctx)
    expect(held.holdGround).toBe('split')
    // Absent rather than disabled in the panel, because the thing to do is on
    // another screen.
    expect(held.applyable).toBe(false)
    expect(held.remedy).toContain('re-split it')

    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(/re-split/)
    // And the splits still sum to what they summed to.
    expect((await storedRow(fixture)).amountCents).toBe(-4000)
  })

  it('holds a reconciled transaction and sends them to reopen it', async () => {
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    /*
      Set directly rather than by driving a reconciliation to completion: what
      the decision reads is the state, and this test is about the hold. The
      reconciliation flow has its own suite.
    */
    await db
      .update(bankTransactions)
      .set({ reviewState: 'reconciled', clearedAt: new Date() })
      .where(eq(bankTransactions.id, row.id))

    await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])

    const [held] = await heldRevisions(fixture.ctx)
    expect(held.holdGround).toBe('reconciled')
    expect(held.applyable).toBe(false)
    await expect(applyHeldChange(fixture.ctx, held.id)).rejects.toThrow(/Reopen the reconciliation/)
  })

  it('applies a held revision once the ground is gone', async () => {
    /**
     * What makes the remedy more than advice. The disposition is **re-decided**
     * at apply time rather than trusted from sync time, so a revision held last
     * week on `reconciled` applies today because somebody did what the remedy
     * said.
     *
     * Without this the register would be a list of dead ends, which is the
     * shape Phase 119 is about.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    await db
      .update(bankTransactions)
      .set({ reviewState: 'reconciled', clearedAt: new Date() })
      .where(eq(bankTransactions.id, row.id))

    await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])
    const [held] = await heldRevisions(fixture.ctx)
    expect(held.holdGround).toBe('reconciled')

    // The remedy, done.
    await db
      .update(bankTransactions)
      .set({ reviewState: 'new', clearedAt: null })
      .where(eq(bankTransactions.id, row.id))

    await applyHeldChange(fixture.ctx, held.id)

    expect((await storedRow(fixture)).amountCents).toBe(-4420)
  })
})

describe('what the log refuses to become', () => {
  it('writes one row however many times the provider re-sends a held revision', async () => {
    /**
     * The worker runs every five minutes. A held revision the provider keeps
     * re-sending would otherwise write 288 identical rows a day, which is how a
     * log stops being readable and therefore stops being read.
     *
     * Enforced by a unique constraint on the three fields that can hold a
     * revision open, not by a check in the service — a constraint beats a check
     * (Phase 116).
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)

    for (let tick = 0; tick < 5; tick += 1) {
      await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])
    }

    expect(await revisionsForTransaction(fixture.ctx, row.id)).toHaveLength(1)
    expect(await heldRevisionCount(fixture.ctx)).toBe(1)
  })

  it('writes a second row when the bank revises it again, differently', async () => {
    // The other direction, so the unique above is a check rather than a ceiling:
    // $40 pending, $42 pending, $44.20 posted is three facts and the path is
    // what somebody reconciling wants to see.
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])

    const row = await storedRow(fixture)
    const expense = await fixture.account('6400')
    await categorize(fixture.ctx, row.id, expense.id)

    await sync(fixture, connectionId, [feed({ amountCents: -4200 })])
    await sync(fixture, connectionId, [feed({ amountCents: -4420, pending: false })])

    const revisions = await revisionsForTransaction(fixture.ctx, row.id)
    expect(revisions).toHaveLength(2)
    // A numeric comparator, because `Array.sort` compares stringified values by
    // default and `"-4200" < "-4420"` — which is how the first draft of this
    // assertion passed with the two figures the wrong way round.
    expect(revisions.map((revision) => revision.amountCents).sort((a, b) => a - b)).toEqual([
      -4420,
      -4200,
    ])
    // Both record what was stored when they arrived, which stays `-4000`
    // because neither was applied.
    expect(revisions.every((revision) => revision.previousAmountCents === -4000)).toBe(true)
  })

  it('cannot say held without a ground, or resolved without a time', async () => {
    /**
     * Both CHECKs, both in the direction that matters: a row claiming `held`
     * with no ground is a held revision with no remedy, which is the one thing
     * `feedChangeStands` exists to stop the register doing — and a constraint is
     * what stops a future writer doing it anyway.
     */
    const fixture = await createCompanyFixture()
    const connectionId = await connect(fixture)
    await sync(fixture, connectionId, [feed()])
    const row = await storedRow(fixture)

    const base = {
      companyId: fixture.companyId,
      bankTransactionId: row.id,
      amountCents: -4420,
      postedDate: '2026-08-01',
      description: 'x',
      pending: false,
      previousAmountCents: -4000,
      previousPostedDate: '2026-08-01',
      previousPending: true,
      touchesBooks: true,
      // Required with no default since Phase 178: a writer that does not say
      // which kind it means has not thought about it, and the typecheck is what
      // said so when `kind` arrived.
      kind: 'revision' as const,
    }

    expect(
      await constraintBrokenBy(
        db.insert(bankTransactionRevisions).values({ ...base, disposition: 'held' }),
      ),
    ).toBe('bank_transaction_revisions_ground_check')

    expect(
      await constraintBrokenBy(
        db.insert(bankTransactionRevisions).values({
          ...base,
          disposition: 'applied',
          amountCents: -4421,
        }),
      ),
    ).toBe('bank_transaction_revisions_resolved_check')
  })
})

describe('whose transaction it was', () => {
  it('keeps one company’s revisions out of another’s list', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const connectionId = await connect(alpha)
    await sync(alpha, connectionId, [feed()])
    const row = await storedRow(alpha)
    const expense = await alpha.account('6400')
    await categorize(alpha.ctx, row.id, expense.id)
    await sync(alpha, connectionId, [feed({ amountCents: -4420, pending: false })])

    expect(await heldRevisionCount(alpha.ctx)).toBe(1)
    expect(await heldRevisionCount(beta.ctx)).toBe(0)
    expect(await heldRevisions(beta.ctx)).toEqual([])

    // And the id, handed over, resolves to nothing rather than to Alpha's row.
    const [held] = await heldRevisions(alpha.ctx)
    await expect(applyHeldChange(beta.ctx, held.id)).rejects.toThrow(DomainError)
    await expect(revisionsForTransaction(beta.ctx, row.id)).resolves.toEqual([])
  })

  it('is refused by the database, not only by the query', async () => {
    /**
     * Phase 170's device on this phase's own table. A single-column reference to
     * `bank_transactions (id)` would let a revision row point at another
     * company's transaction and the database would not care — the guard would be
     * the `scoped()` call alone, and Phase 163's finding is that an unscoped
     * path returns zero rows and reports success.
     *
     * The composite key makes it a refusal. Asserted in both directions, because
     * a key that refused everything would pass the first half.
     */
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const connectionId = await connect(alpha)
    await sync(alpha, connectionId, [feed()])
    const alphaRow = await storedRow(alpha)

    const revision = {
      amountCents: -4420,
      postedDate: '2026-08-01',
      description: 'x',
      pending: false,
      previousAmountCents: -4000,
      previousPostedDate: '2026-08-01',
      previousPending: true,
      touchesBooks: true,
      kind: 'revision' as const,
      disposition: 'applied' as const,
      resolvedAt: new Date(),
    }

    // Beta claiming Alpha's transaction.
    expect(
      await constraintBrokenBy(
        db.insert(bankTransactionRevisions).values({
          ...revision,
          companyId: beta.companyId,
          bankTransactionId: alphaRow.id,
        }),
      ),
    ).toBe('bank_transaction_revisions_transaction_fkey')

    // Alpha claiming its own, which must still work.
    await expect(
      db.insert(bankTransactionRevisions).values({
        ...revision,
        companyId: alpha.companyId,
        bankTransactionId: alphaRow.id,
      }),
    ).resolves.toBeDefined()
  })
})
