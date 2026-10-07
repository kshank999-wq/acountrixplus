import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  bankTransactionRevisions,
  bankTransactions,
  financialAccounts,
  journalEntries,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DERIVED_SOURCE_TYPES } from '@/modules/ledger/posting'
import { syncLedgerForTransaction } from '@/modules/ledger/posting'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import type { ProviderTransaction } from './provider'
import { excludeTransaction } from '@/modules/bookkeeping/transactions'
import {
  describeHold,
  describeRetraction,
  retractionDispositionFor,
  type ChangeKind,
  dispositionFor,
  feedChangeHoldFor,
  type DerivedState,
  type FieldChange,
  type RevisableValues,
} from './revisions'

/**
 * Recording and resolving what a bank feed changed after the fact (Phase 177).
 *
 * The decision is in `revisions.ts`, which is pure. This is the half that reads
 * the derived state out of the database, writes the log, and gives a person the
 * one button that can push a held revision through.
 *
 * ## Why the applying runs under a row lock
 *
 * `importTransactions`'s guarantee has always been that *the database arbitrates
 * duplicates*, so two simultaneous syncs cannot both win. A revision breaks that
 * shape, because deciding whether one is safe means **reading** derived state
 * and then writing — and between the read and the write somebody can categorize
 * the transaction, which is exactly the case the whole module exists to prevent.
 *
 * An optimistic `WHERE amount_cents = <what we read>` would mostly work and
 * would leave a branch nothing can exercise: Phase 121's rule is that a check
 * only ever seen to agree is not a check. So the rows are locked with
 * `FOR UPDATE` instead and the correctness argument is structural. A constraint
 * beats a check (Phase 116).
 */

/** What a sync did about transactions it had already sent. */
export type RevisionOutcome = {
  /** Revisions written onto the transaction. */
  applied: number
  /** Revisions recorded and not applied, because something was derived. */
  held: number
  /** Transactions the feed re-sent unchanged. Counted so "nothing happened" is a measurement. */
  unchanged: number
}

const EMPTY: RevisionOutcome = { applied: 0, held: 0, unchanged: 0 }

/**
 * What goes in `excludeReason` when a feed withdraws a transaction.
 *
 * Named once because it is written on the row and read on a screen, and because
 * it is the only thing distinguishing a withdrawal from somebody's own decision
 * to exclude — `excluded` is one state with two causes, and the reason is where
 * the cause lives.
 */
export const RETRACTED_REASON =
  'Withdrawn by the bank: the provider says this transaction never happened.'

/**
 * The dedup key, named once (Phase 178 added `kind` to it).
 *
 * Spelled out at two insert sites before this phase, which is how the fifth
 * column would have been added to one of them.
 */
const CHANGE_CONFLICT_TARGET = [
  bankTransactionRevisions.companyId,
  bankTransactionRevisions.bankTransactionId,
  bankTransactionRevisions.kind,
  bankTransactionRevisions.amountCents,
  bankTransactionRevisions.postedDate,
  bankTransactionRevisions.pending,
] as const

type StoredRow = typeof bankTransactions.$inferSelect

function storedValues(row: StoredRow): RevisableValues {
  return {
    amountCents: row.amountCents,
    postedDate: row.postedDate,
    description: row.description,
    merchantName: row.merchantName,
    providerCategory: row.providerCategory,
    pending: row.pending,
  }
}

function incomingValues(transaction: ProviderTransaction): RevisableValues {
  return {
    amountCents: transaction.amountCents,
    postedDate: transaction.postedDate,
    description: transaction.description,
    merchantName: transaction.merchantName ?? null,
    providerCategory: transaction.category ?? null,
    pending: transaction.pending,
  }
}

/**
 * What has been derived from a stored row, asked as facts.
 *
 * `reviewState` is not the input to the decision — see `DerivedState` — but it
 * is where three of the six answers live, so it is read here and translated
 * once.
 */
function derivedStateOf(row: StoredRow, postedIds: Set<string>): DerivedState {
  return {
    hasPostedEntry: postedIds.has(row.id),
    isReconciled: row.reviewState === 'reconciled',
    isCleared: row.clearedAt !== null,
    isSplit: row.isSplit,
    isMatched: row.reviewState === 'matched',
    isTransferLeg: row.isTransfer || row.transferPairId !== null,
  }
}

/** Which of these transactions currently have a live derived entry. */
async function postedTransactionIds(
  ctx: ActorContext,
  transactionIds: string[],
  exec: Executor,
): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set()

  const rows = await exec
    .select({ sourceId: journalEntries.sourceId })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        inArray(journalEntries.sourceType, [...DERIVED_SOURCE_TYPES]),
        inArray(journalEntries.sourceId, transactionIds),
        eq(journalEntries.status, 'posted'),
      ),
    )

  return new Set(rows.map((row) => row.sourceId).filter((id): id is string => id !== null))
}

/**
 * Compares what a feed re-sent against what is stored, and acts.
 *
 * Called with the transactions `importTransactions` did **not** insert, which
 * under `ON CONFLICT DO NOTHING` is precisely the set the provider had already
 * sent — whatever the provider called them. The adapter's own `added`/`modified`
 * split is deliberately not used: a provider may re-send an `added` transaction,
 * and comparing content is right whether or not the label is.
 */
export async function recordRevisions(
  ctx: ActorContext,
  input: {
    connectionId: string
    /** Keyed by `${financialAccountId}:${providerTransactionId}`. */
    incoming: Map<string, ProviderTransaction>
  },
): Promise<RevisionOutcome> {
  if (input.incoming.size === 0) return EMPTY

  const providerIds = [...new Set([...input.incoming.values()].map((t) => t.providerTransactionId))]

  return db.transaction(async (tx) => {
    /*
      Locked, not re-checked. Everything from here to the commit sees a row
      nobody else can categorize, split or reconcile underneath it.
    */
    const stored = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          inArray(bankTransactions.providerTransactionId, providerIds),
        ),
      )
      .for('update')

    if (stored.length === 0) return EMPTY

    const postedIds = await postedTransactionIds(
      ctx,
      stored.map((row) => row.id),
      tx,
    )

    const outcome = { ...EMPTY }

    for (const row of stored) {
      const transaction = input.incoming.get(`${row.financialAccountId}:${row.providerTransactionId}`)
      if (!transaction) continue

      const incoming = incomingValues(transaction)
      const disposition = dispositionFor({
        stored: storedValues(row),
        incoming,
        derived: derivedStateOf(row, postedIds),
      })

      if (disposition.kind === 'unchanged') {
        outcome.unchanged += 1
        continue
      }

      const previous = {
        previousAmountCents: row.amountCents,
        previousPostedDate: row.postedDate,
        previousPending: row.pending,
      }

      if (disposition.kind === 'hold') {
        await tx
          .insert(bankTransactionRevisions)
          .values({
            companyId: ctx.companyId,
            bankTransactionId: row.id,
            ...incoming,
            ...previous,
            kind: 'revision',
            disposition: 'held',
            holdGround: disposition.ground.key,
            touchesBooks: true,
            raw: transaction.raw ?? null,
          })
          /*
            A held revision the provider keeps re-sending would otherwise make a
            row every five minutes. The unique is on the three fields that can
            hold one open, so a re-send of the same revision is a no-op and a
            genuinely different one is a new row.
          */
          .onConflictDoNothing({ target: [...CHANGE_CONFLICT_TARGET] })

        outcome.held += 1
        continue
      }

      await tx
        .update(bankTransactions)
        .set({ ...incoming, updatedAt: new Date() })
        .where(
          and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.id, row.id)),
        )

      await tx
        .insert(bankTransactionRevisions)
        .values({
          companyId: ctx.companyId,
          bankTransactionId: row.id,
          ...incoming,
          ...previous,
          kind: 'revision',
          disposition: 'applied',
          touchesBooks: disposition.touchesBooks,
          raw: transaction.raw ?? null,
          /*
            `resolvedAt` and not null, because the CHECK says a non-held row has
            one: a revision the feed applied was resolved by the feed, at the
            moment it arrived. `resolvedBy` stays null — nobody decided it.
          */
          resolvedAt: new Date(),
        })
        .onConflictDoNothing({ target: [...CHANGE_CONFLICT_TARGET] })

      outcome.applied += 1
    }

    if (outcome.applied > 0 || outcome.held > 0) {
      await recordAudit(
        ctx,
        {
          action: 'transaction.revise',
          entityType: 'bank_connection',
          entityId: input.connectionId,
          after: { applied: outcome.applied, held: outcome.held },
        },
        tx,
      )
    }

    return outcome
  })
}

/**
 * Acts on the transactions a provider has **withdrawn** (Phase 178).
 *
 * The one of Phase 176's three findings that leaves a wrong row in the books
 * rather than a slow sync: a withdrawn transaction that had been categorised was
 * a posted expense for money that never moved.
 *
 * Same division as a revision, and the same six grounds. What differs is the
 * action — a withdrawal ends in `excludeTransaction`, which sets the row to
 * `excluded` and lets `syncLedgerForTransaction` void whatever it had posted,
 * because `excluded` is not a postable state.
 *
 * ## Why `excluded` and not a seventh review state
 *
 * `excluded` already means "this does not belong in the books" and carries an
 * `excludeReason`. A `retracted` state would behave identically everywhere —
 * every filter, every count, every report — and differ only in what it is
 * *called*, so the distinction belongs in the reason and in this log, which is
 * where it is. A seventh enum value would have rippled through the inbox for no
 * behavioural difference.
 *
 * ## Why this calls `excludeTransaction` rather than writing the row
 *
 * It needs `bookkeeping:categorize` and the importer holds
 * `bookkeeping:import`. Measured rather than assumed: **every role with
 * `import` also has `categorize`** — owner, bookkeeper and accountant — so
 * there is no caller that can reach a sync and not this. `manager` has
 * `categorize` without `import`, which is the harmless direction.
 *
 * A test pins that relationship, because it is the fact this design rests on: a
 * role given `import` without `categorize` would make a retraction throw
 * `PermissionError` in the middle of a sync, and the sentence would be about
 * permissions rather than about the bank.
 */
export async function recordRetractions(
  ctx: ActorContext,
  input: {
    connectionId: string
    /** Provider transaction ids the provider says never happened. */
    providerTransactionIds: string[]
  },
): Promise<RevisionOutcome> {
  if (input.providerTransactionIds.length === 0) return EMPTY

  const outcome = { ...EMPTY }

  /*
    One transaction per withdrawal rather than one for the batch, because
    `excludeTransaction` voids a journal entry and a closed period refuses it —
    and one unreachable month must not roll back the withdrawals that did apply.
    The same argument `bank.sync_all` makes about one dead institution not
    stopping the others.
  */
  for (const providerTransactionId of input.providerTransactionIds) {
    const resolved = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.companyId, ctx.companyId),
            eq(bankTransactions.providerTransactionId, providerTransactionId),
          ),
        )
        .for('update')
        .limit(1)

      // A withdrawal for a transaction never imported is nothing to do, not an
      // error: the provider is entitled to retract something inside a window we
      // never pulled.
      if (!row) return 'absent' as const

      /*
        Already excluded — by a person, or by an earlier tick of this same
        withdrawal. Counted as unchanged rather than re-excluded, so a
        provider that keeps re-sending a withdrawal does not keep writing audit
        entries for a decision that was already made.
      */
      if (row.reviewState === 'excluded') return 'unchanged' as const

      const postedIds = await postedTransactionIds(ctx, [row.id], tx)
      const disposition = retractionDispositionFor(derivedStateOf(row, postedIds))

      const values = {
        companyId: ctx.companyId,
        bankTransactionId: row.id,
        kind: 'retraction' as const,
        /*
          Copied from the stored row, which the CHECK requires: a withdrawal
          carries no new figures, because the provider sends an id and nothing
          else. `previous_*` and the new values are therefore equal by
          construction, and the constraint is what keeps that true of the next
          writer too.
        */
        amountCents: row.amountCents,
        postedDate: row.postedDate,
        description: row.description,
        merchantName: row.merchantName,
        providerCategory: row.providerCategory,
        pending: row.pending,
        previousAmountCents: row.amountCents,
        previousPostedDate: row.postedDate,
        previousPending: row.pending,
        // A withdrawal always touches the books: it either removes a posting or
        // takes a row out of an inbox that should not review it.
        touchesBooks: true,
      }

      if (disposition.kind === 'hold') {
        await tx
          .insert(bankTransactionRevisions)
          .values({ ...values, disposition: 'held', holdGround: disposition.ground.key })
          .onConflictDoNothing({ target: [...CHANGE_CONFLICT_TARGET] })

        return 'held' as const
      }

      await excludeTransaction(ctx, row.id, RETRACTED_REASON, tx)

      await tx
        .insert(bankTransactionRevisions)
        .values({ ...values, disposition: 'applied', resolvedAt: new Date() })
        .onConflictDoNothing({ target: [...CHANGE_CONFLICT_TARGET] })

      await recordAudit(
        ctx,
        {
          action: 'transaction.retract',
          entityType: 'bank_transaction',
          entityId: row.id,
          before: { reviewState: row.reviewState, amountCents: row.amountCents },
          after: { reviewState: 'excluded', excludeReason: RETRACTED_REASON },
        },
        tx,
      )

      return 'applied' as const
    })

    if (resolved === 'applied') outcome.applied += 1
    else if (resolved === 'held') outcome.held += 1
    else if (resolved === 'unchanged') outcome.unchanged += 1
  }

  return outcome
}

export type HeldRevision = {
  id: string
  transactionId: string
  accountName: string
  /**
   * The account's currency, carried so a screen does not stamp a dollar sign on
   * a euro account. A bank transaction has no currency of its own — it inherits
   * the account's — and formatting it as USD would be the panel asserting a
   * fact it never checked.
   */
  currency: string
  description: string
  seenAt: Date
  /** What the bank asserted: different figures, or that it never happened. */
  kind: ChangeKind
  holdGround: string
  /** The register's own argument and remedy, resolved through `feedChangeHoldFor`. */
  because: string
  /**
   * The remedy **for this kind**, not the whole record.
   *
   * Resolved here rather than in the screen, because picking the wrong one of
   * the two is the mistake that sends somebody to apply a figure that does not
   * exist — and a screen holding both would be the one place able to make it.
   */
  remedy: string
  /** One sentence naming the change and what to undo. */
  summary: string
  fromAmountCents: number
  toAmountCents: number
  fromPostedDate: string
  toPostedDate: string
  /** True when this ground is the one the inbox's Apply button can push through. */
  applyable: boolean
}

/**
 * The ground `applyHeldRevision` can resolve on its own.
 *
 * The other five need something undone first — a reconciliation reopened, a
 * split redone, a pair unlinked, a match broken — and every one of those is a
 * screen that already exists. This one is the commonest and the only one where
 * the remedy *is* "apply it", because voiding and re-posting the derived entry
 * is exactly what `syncLedgerForTransaction` does.
 */
const APPLYABLE_GROUND = 'posted-to-the-ledger'

export async function heldRevisions(ctx: ActorContext): Promise<HeldRevision[]> {
  requirePermission(ctx, 'bookkeeping:view')

  const rows = await db
    .select({
      revision: bankTransactionRevisions,
      accountName: financialAccounts.name,
      currency: financialAccounts.currency,
    })
    .from(bankTransactionRevisions)
    .innerJoin(bankTransactions, and(
      eq(bankTransactions.companyId, bankTransactionRevisions.companyId),
      eq(bankTransactions.id, bankTransactionRevisions.bankTransactionId),
    ))
    .innerJoin(financialAccounts, and(
      eq(financialAccounts.companyId, bankTransactions.companyId),
      eq(financialAccounts.id, bankTransactions.financialAccountId),
    ))
    .where(
      scoped(
        ctx,
        bankTransactionRevisions,
        eq(bankTransactionRevisions.disposition, 'held'),
      ),
    )
    .orderBy(desc(bankTransactionRevisions.seenAt))

  return rows.map(({ revision, accountName, currency }) => {
    // Throws a `RegistryError` for a ground nobody declared, which is the check
    // the text column does not have.
    const ground = feedChangeHoldFor(revision.holdGround!)

    const changes: FieldChange[] = []
    if (revision.previousAmountCents !== revision.amountCents) {
      changes.push({
        field: 'amountCents',
        from: revision.previousAmountCents,
        to: revision.amountCents,
      })
    }
    if (revision.previousPostedDate !== revision.postedDate) {
      changes.push({
        field: 'postedDate',
        from: revision.previousPostedDate,
        to: revision.postedDate,
      })
    }

    return {
      id: revision.id,
      transactionId: revision.bankTransactionId,
      accountName,
      currency,
      description: revision.description,
      seenAt: revision.seenAt,
      kind: revision.kind,
      holdGround: ground.key,
      because: ground.because,
      remedy: ground.remedy[revision.kind],
      summary:
        revision.kind === 'retraction'
          ? describeRetraction(revision.amountCents, ground)
          : describeHold(changes, ground),
      fromAmountCents: revision.previousAmountCents,
      toAmountCents: revision.amountCents,
      fromPostedDate: revision.previousPostedDate,
      toPostedDate: revision.postedDate,
      /*
        The same ground for both kinds, and for the same reason: it is the only
        one whose remedy *is* the button. A revision re-posts the entry at the
        new figure; a retraction voids it and posts nothing. Everything else
        needs something undone on a screen that already exists.
      */
      applyable: ground.key === APPLYABLE_GROUND,
    }
  })
}

/** How many revisions are waiting on somebody. For the inbox's counts. */
export async function heldRevisionCount(ctx: ActorContext): Promise<number> {
  requirePermission(ctx, 'bookkeeping:view')

  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(bankTransactionRevisions)
    .where(
      scoped(ctx, bankTransactionRevisions, eq(bankTransactionRevisions.disposition, 'held')),
    )

  return row?.total ?? 0
}

async function loadHeld(ctx: ActorContext, revisionId: string, exec: Executor) {
  const [revision] = await exec
    .select()
    .from(bankTransactionRevisions)
    .where(scoped(ctx, bankTransactionRevisions, eq(bankTransactionRevisions.id, revisionId)))
    .limit(1)

  if (!revision) throw missing('revision')

  if (revision.disposition !== 'held') {
    throw new Refusal(
      `This revision was already ${revision.disposition}. The bank feed records every change it ` +
        'made, so the history stays readable — there is nothing left to decide on this one.',
    )
  }

  return revision
}

/**
 * Does what the bank said, and brings the ledger with it.
 *
 * One entry point for both kinds (Phase 178), dispatching on `kind` rather than
 * two exported functions — because two would be two places for the
 * re-decide-before-acting step to live, and the one that got it wrong would be
 * the one that silently rewrote a posted figure. The *action* differs, the
 * decision does not.
 *
 * The permission is `bookkeeping:categorize` rather than `bookkeeping:import`,
 * because what this does is change a posted figure or void a posted entry.
 * Importing a feed is clerical; deciding that the books should now say $44.20,
 * or nothing at all, is the categorizing decision — and it is refused outright
 * in a closed period by the same `ClosedPeriodError` that refuses recategorizing
 * one.
 */
export async function applyHeldChange(
  ctx: ActorContext,
  revisionId: string,
): Promise<{ transactionId: string; reposted: boolean; excluded: boolean }> {
  requirePermission(ctx, 'bookkeeping:categorize')

  return db.transaction(async (tx) => {
    const revision = await loadHeld(ctx, revisionId, tx)

    const [row] = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          eq(bankTransactions.id, revision.bankTransactionId),
        ),
      )
      .for('update')
      .limit(1)

    if (!row) throw missing('transaction')

    /*
      Re-decided rather than trusted. A change held last Tuesday on `reconciled`
      may be held on nothing at all today, because somebody reopened the
      reconciliation — which is what the remedy told them to do. Re-running the
      same pure function is what makes the remedy work, and what stops this path
      from being a second, more permissive copy of the rule.
    */
    const postedIds = await postedTransactionIds(ctx, [row.id], tx)

    if (revision.kind === 'retraction') {
      const verdict = retractionDispositionFor(derivedStateOf(row, postedIds))

      if (verdict.kind === 'hold' && verdict.ground.key !== APPLYABLE_GROUND) {
        throw new Refusal(verdict.ground.remedy.retraction)
      }

      /*
        `excludeTransaction` and not a direct write: it is the one path that
        sets the state, records the reason, and lets
        `syncLedgerForTransaction` void whatever was posted — and a closed
        period refuses the void inside this transaction, so nothing moves.

        It also refuses a reconciled transaction through `assertEditable`,
        which is the `reconciled` ground enforced a second time by the code
        that would do the damage. Belt and braces on purpose: the ground is
        read from a stored string, and this is not.
      */
      await excludeTransaction(ctx, row.id, RETRACTED_REASON, tx)

      await tx
        .update(bankTransactionRevisions)
        .set({
          disposition: 'applied',
          holdGround: null,
          resolvedAt: new Date(),
          resolvedBy: ctx.userId,
        })
        .where(
          and(
            eq(bankTransactionRevisions.companyId, ctx.companyId),
            eq(bankTransactionRevisions.id, revision.id),
          ),
        )

      await recordAudit(
        ctx,
        {
          action: 'transaction.retract',
          entityType: 'bank_transaction',
          entityId: row.id,
          before: { reviewState: row.reviewState, amountCents: row.amountCents },
          after: { reviewState: 'excluded', excludeReason: RETRACTED_REASON },
        },
        tx,
      )

      return { transactionId: row.id, reposted: false, excluded: true }
    }

    const disposition = dispositionFor({
      stored: storedValues(row),
      incoming: {
        amountCents: revision.amountCents,
        postedDate: revision.postedDate,
        description: revision.description,
        merchantName: revision.merchantName,
        providerCategory: revision.providerCategory,
        pending: revision.pending,
      },
      derived: derivedStateOf(row, postedIds),
    })

    if (disposition.kind === 'unchanged') {
      throw new Refusal(
        'This transaction already carries the figures the bank sent, so there is nothing to ' +
          'apply. Dismiss the revision to clear it from the list.',
      )
    }

    if (disposition.kind === 'hold' && disposition.ground.key !== APPLYABLE_GROUND) {
      // Phase 119: the refusal is the remedy. Nothing here can do it for them,
      // and every one of these is a screen that exists.
      throw new Refusal(disposition.ground.remedy.revision)
    }

    await tx
      .update(bankTransactions)
      .set({
        amountCents: revision.amountCents,
        postedDate: revision.postedDate,
        description: revision.description,
        merchantName: revision.merchantName,
        providerCategory: revision.providerCategory,
        pending: revision.pending,
        updatedAt: new Date(),
      })
      .where(
        and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.id, row.id)),
      )

    /*
      Voids the old entry and posts a fresh one from the row's new state, at the
      rate already recorded — Phase 129's rule that a re-post must not restate
      its own FX. A closed period throws here, inside this transaction, so the
      row's new amount rolls back with it and the revision stays held.
    */
    const posted = disposition.kind === 'hold'
      ? await syncLedgerForTransaction(ctx, row.id, tx)
      : { posted: false }

    await tx
      .update(bankTransactionRevisions)
      .set({
        disposition: 'applied',
        holdGround: null,
        resolvedAt: new Date(),
        resolvedBy: ctx.userId,
      })
      .where(
        and(
          eq(bankTransactionRevisions.companyId, ctx.companyId),
          eq(bankTransactionRevisions.id, revision.id),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.revise',
        entityType: 'bank_transaction',
        entityId: row.id,
        before: { amountCents: row.amountCents, postedDate: row.postedDate },
        after: { amountCents: revision.amountCents, postedDate: revision.postedDate },
      },
      tx,
    )

    return { transactionId: row.id, reposted: posted.posted, excluded: false }
  })
}

/**
 * Records that the stored figure stands.
 *
 * Takes a note and insists on one, because this is the decision that leaves the
 * books disagreeing with the feed on purpose — and the only thing that makes
 * that defensible later is somebody having written down why.
 */
export async function dismissRevision(
  ctx: ActorContext,
  revisionId: string,
  note: string,
): Promise<void> {
  requirePermission(ctx, 'bookkeeping:categorize')

  const reason = note.trim()
  if (reason.length < 4) {
    throw new Refusal(
      'Say why the stored figure stands. A dismissed revision is the books disagreeing with the ' +
        'bank on purpose, and in a year the note is the only thing that will explain it.',
    )
  }

  await db.transaction(async (tx) => {
    const revision = await loadHeld(ctx, revisionId, tx)

    await tx
      .update(bankTransactionRevisions)
      .set({
        disposition: 'dismissed',
        holdGround: null,
        resolvedAt: new Date(),
        resolvedBy: ctx.userId,
        resolutionNote: reason,
      })
      .where(
        and(
          eq(bankTransactionRevisions.companyId, ctx.companyId),
          eq(bankTransactionRevisions.id, revision.id),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.revision_dismiss',
        entityType: 'bank_transaction',
        entityId: revision.bankTransactionId,
        after: { note: reason, heldOn: revision.holdGround },
      },
      tx,
    )
  })
}

/** Every revision a transaction has ever had, newest first. For its history panel. */
export async function revisionsForTransaction(ctx: ActorContext, transactionId: string) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select()
    .from(bankTransactionRevisions)
    .where(
      scoped(
        ctx,
        bankTransactionRevisions,
        eq(bankTransactionRevisions.bankTransactionId, transactionId),
      ),
    )
    .orderBy(desc(bankTransactionRevisions.seenAt))
}
