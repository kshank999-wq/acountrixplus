/**
 * What a bank feed is allowed to rewrite (Phase 177).
 *
 * ## The defect
 *
 * `/transactions/sync` returns `added`, `modified` and `removed`. Phase 176's
 * adapter hands the first two over correctly, and then:
 *
 * ```ts
 * .onConflictDoNothing({ target: [companyId, financialAccountId, providerTransactionId] })
 * ```
 *
 * So a **modified** transaction is dropped. The universal case is the one every
 * bank does — a pending transaction posts, and its amount changes by the tip, or
 * the FX rate, or the fuel hold settling. The inbox keeps the pending figure
 * forever, a reconciliation against the real statement does not close, and the
 * difference is the tip.
 *
 * Idempotency was built as *"do nothing on conflict"* when the only conflict was
 * a repeated import of the same window, and it was right for that. `modified`
 * makes "already present" stop meaning "already correct".
 *
 * ## Why `onConflictDoUpdate` is the wrong fix
 *
 * It is the one-line change, and it would silently rewrite the amount of a
 * transaction somebody has already categorized and **posted to the ledger** —
 * possibly inside a closed period, under a reconciliation they have already
 * certified. This codebase settled that question three ADRs running and
 * `ledger/restate.ts` states the settlement:
 *
 * > **A second entry, not a re-post.** The original stays where it is.
 * > Rewriting it is the defect Phase 129 stopped, and it would make a period
 * > somebody has already reported on change without saying so.
 *
 * ## The division
 *
 * A `bank_transactions` row is two things at once, and the fix is to stop
 * treating them as one:
 *
 * - **A copy of the feed.** Nothing has been derived from it. Keeping the copy
 *   accurate is not editing history, because there is no history yet. **Apply.**
 * - **The source of something.** A posted journal entry, splits that sum to it,
 *   a match against an invoice, a reconciliation that cleared it. Changing the
 *   amount under any of those makes the derived thing disagree with its source.
 *   **Hold it, and tell a person what to undo first.**
 *
 * Every hold names a remedy, because Phase 119's rule is that a refusal a
 * person cannot act on is a dead end. Each remedy here is a path that already
 * exists: reopen the reconciliation, re-split, unmatch, recategorize — and
 * recategorizing is what re-posts at the new figure, refused by
 * `ClosedPeriodError` if the month is shut.
 *
 * ## Pure
 *
 * No database and no clock. The ledger fact — *is there a posted entry* — comes
 * in as an argument rather than being queried here, which is what lets the whole
 * decision table be tested without writing a transaction, and what stops a
 * second copy of the rule appearing beside the first.
 */

import { RegistryError } from '@/modules/errors/registry'

/**
 * The fields a provider may revise, split by whether the books care.
 *
 * The split is the whole mechanism. A provider that settles a merchant name
 * from `SQ *COFFEE` to `Coffee Shop`, or flips `pending` to false with the
 * amount unchanged, has told us something harmless — that applies in place even
 * on a transaction that posted months ago, because no ledger figure moves.
 *
 * `amountCents` and `postedDate` are different in kind: they are what the entry
 * was built from, and what a reconciliation was certified against.
 */
export const BOOK_AFFECTING_FIELDS = ['amountCents', 'postedDate'] as const

/** Everything else a revision can carry. Never a reason to hold. */
export const DESCRIPTIVE_FIELDS = [
  'description',
  'merchantName',
  'providerCategory',
  'pending',
] as const

export type BookAffectingField = (typeof BOOK_AFFECTING_FIELDS)[number]
export type DescriptiveField = (typeof DESCRIPTIVE_FIELDS)[number]
export type RevisableField = BookAffectingField | DescriptiveField

/** What a feed sent, and what we hold. The shape both sides are compared in. */
export type RevisableValues = {
  amountCents: number
  postedDate: string
  description: string
  merchantName: string | null
  providerCategory: string | null
  pending: boolean
}

/**
 * What has been derived from the stored row, as facts rather than as a state
 * name.
 *
 * `reviewState` is deliberately *not* the input. A transaction can be
 * `categorized` with no live entry (it was voided), and `new` while cleared in
 * an open reconciliation. The questions below are the ones that actually decide,
 * and asking them directly is what keeps this table from encoding a second,
 * slightly-wrong copy of the review state machine.
 */
export type DerivedState = {
  /** A live, non-void journal entry built from this row. */
  hasPostedEntry: boolean
  /** A completed reconciliation has certified it. */
  isReconciled: boolean
  /** Ticked in a reconciliation that is still open. */
  isCleared: boolean
  /** Splits exist and sum to the stored amount. */
  isSplit: boolean
  /** Matched against a document — an invoice payment, a bill payment. */
  isMatched: boolean
  /** Paired with the other leg of a transfer. */
  isTransferLeg: boolean
}

export type RevisionHold = {
  key: string
  /** Why a feed may not rewrite this silently, argued. */
  because: string
  /** What a person does about it. A path that already exists. */
  remedy: string
  /** True when this ground applies. */
  applies: (derived: DerivedState) => boolean
}

/**
 * The grounds for holding a revision, **ordered by what has to be undone
 * first.**
 *
 * The order is load-bearing rather than cosmetic: a transaction can be
 * reconciled *and* posted *and* split, and the ground reported is the one whose
 * remedy comes first. Telling somebody to re-split a transaction that a
 * completed reconciliation has locked sends them to a screen that will refuse
 * them.
 */
export const REVISION_HOLDS: readonly RevisionHold[] = [
  {
    key: 'reconciled',
    because:
      'A completed reconciliation is somebody certifying that the books agree with the bank ' +
      'statement on a given day for a given balance. Letting a feed change the amount afterwards ' +
      'would retroactively falsify that certificate — the cleared balance they signed off would ' +
      'no longer be the sum of what they cleared, and nothing would say when it stopped being so. ' +
      'This is the same reason `assertEditable` refuses a person the same change, and a feed has ' +
      'strictly less standing than a person.',
    remedy:
      'Reopen the reconciliation (Reconciliation → the account → Reopen, which needs ' +
      '`reconciliation:reopen`), apply the revision, then complete it again against the real ' +
      'statement.',
    applies: (derived) => derived.isReconciled,
  },
  {
    key: 'cleared',
    because:
      'Ticked in a reconciliation that is still open, which means somebody is sitting in front of ' +
      'a difference they are trying to close. Changing a cleared amount underneath them moves the ' +
      'cleared balance and therefore the difference, so the number they are chasing changes while ' +
      'they chase it — and the feed is the last place they would look for the reason. Held until ' +
      'the session is finished, because a revision is not urgent and a reconciliation in progress ' +
      'is.',
    remedy:
      'Finish or abandon the open reconciliation first, then apply the revision. If the statement ' +
      'itself shows the revised figure, untick the line, apply, and tick it again.',
    applies: (derived) => derived.isCleared && !derived.isReconciled,
  },
  {
    key: 'split',
    because:
      'Splits carry the accounts and the amounts, and they sum to the transaction. Changing the ' +
      'total without changing them leaves a transaction whose parts do not add up to it — which ' +
      'is not a disagreement the ledger can represent, since the derived entry is built from the ' +
      'splits. Dividing the difference automatically is the one thing that must not happen here: ' +
      'the extra $4.20 on a split restaurant bill is the tip, and this module cannot know which ' +
      'line it belongs on.',
    remedy:
      'Open the transaction and re-split it at the new total. The splits are the decision; only ' +
      'the person who made it knows where the difference goes.',
    applies: (derived) => derived.isSplit,
  },
  {
    key: 'transfer',
    because:
      'A transfer is two bank transactions that are one movement of money, and the pair posts a ' +
      'single entry through `syncLedgerForTransferPair`. Revising one leg leaves the two sides ' +
      'disagreeing about how much moved, which is a state the pair has no way to post from — and ' +
      'the other leg is on a different account, usually at a different institution, so the feed ' +
      'that revised this one has no idea the other exists.',
    remedy:
      'Unlink the transfer pair, apply the revision to each leg as its own bank sends it, then ' +
      'pair them again.',
    applies: (derived) => derived.isTransferLeg,
  },
  {
    key: 'matched',
    because:
      'Matched means this bank movement *is* a document — a customer paying invoice 1042, a ' +
      'payment going out against a bill. The amount is what tied them together and what the ' +
      'receivable was relieved by, so revising it would leave an invoice recorded as settled by a ' +
      'figure that no longer exists. The subledger and the bank would then disagree by the ' +
      'revision, which is precisely the reconciliation this product is for.',
    remedy:
      'Unmatch the transaction, apply the revision, then match it again — or, if the bank is right ' +
      'and the document was wrong, correct the document and let the match follow it.',
    applies: (derived) => derived.isMatched,
  },
  {
    key: 'posted-to-the-ledger',
    because:
      'The last and commonest ground, and the mildest: there is a live journal entry built from ' +
      'this row and nothing else has been done to it. Applying the revision needs that entry ' +
      'voided and re-posted at the new figure, which is a change to the books — and if the month ' +
      'is closed it is a change to a period somebody has already reported on. That decision is a ' +
      "person's, and `ClosedPeriodError` is what refuses it when it should be refused. Held " +
      'rather than applied because a feed silently moving a posted figure is the defect this whole ' +
      'module exists to stop.',
    remedy:
      'Apply the revision from the inbox, which voids the entry and re-posts it at the new amount. ' +
      'A closed period refuses this — reopen it, or leave the revision held and correct the ' +
      'difference with a dated entry instead.',
    applies: (derived) => derived.hasPostedEntry,
  },
]

export function revisionHoldFor(key: string): RevisionHold {
  const found = REVISION_HOLDS.find((hold) => hold.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'REVISION_HOLDS',
    key,
    message:
      `No revision hold is declared as "${key}". This register is the list of reasons a bank ` +
      'feed may not silently rewrite a transaction, and every entry carries the remedy a person ' +
      'acts on — so a lookup answering `undefined` would report a held revision with no way out ' +
      `of it. Declared: ${REVISION_HOLDS.map((hold) => hold.key).join(', ')}.`,
  })
}

/** One field the feed changed, with both values, for a person to read. */
export type FieldChange = {
  field: RevisableField
  from: string | number | boolean | null
  to: string | number | boolean | null
}

export type Disposition =
  /** The feed sent what we already hold. The commonest outcome by far. */
  | { kind: 'unchanged' }
  /** Safe to write onto the row. */
  | { kind: 'apply'; changes: FieldChange[]; touchesBooks: boolean }
  /** Not safe. The ground names what to undo. */
  | { kind: 'hold'; changes: FieldChange[]; ground: RevisionHold }

const ALL_FIELDS: readonly RevisableField[] = [...BOOK_AFFECTING_FIELDS, ...DESCRIPTIVE_FIELDS]

function changesBetween(stored: RevisableValues, incoming: RevisableValues): FieldChange[] {
  const changes: FieldChange[] = []

  for (const field of ALL_FIELDS) {
    const from = stored[field]
    const to = incoming[field]

    /*
      `!==` on primitives only, which is all these are. A null and an empty
      string are *different* here and deliberately so: a provider that stops
      sending a merchant name has told us it no longer knows one, and silently
      keeping the old one would be this module inventing data.
    */
    if (from !== to) changes.push({ field, from, to })
  }

  return changes
}

/**
 * Whether a feed's revision may be written onto the stored row.
 *
 * Note which way the default falls. A transaction with no derived state applies
 * *everything*, including a changed amount, because the row is a copy of the
 * feed and the feed is the authority on what the bank did. The holds are the
 * exceptions, and each one exists because something else now depends on the
 * stored figure.
 */
export function dispositionFor(input: {
  stored: RevisableValues
  incoming: RevisableValues
  derived: DerivedState
}): Disposition {
  const changes = changesBetween(input.stored, input.incoming)
  if (changes.length === 0) return { kind: 'unchanged' }

  const touchesBooks = changes.some((change) =>
    (BOOK_AFFECTING_FIELDS as readonly string[]).includes(change.field),
  )

  /*
    A descriptive-only revision applies whatever has been derived from the row,
    and the posted entry is deliberately *not* re-posted for it. The entry's memo
    records what it was posted with; rewriting it afterwards to match a settled
    merchant name would be editing history to no purpose, which is the thing
    `restate.ts` refuses to do for a figure that actually matters.
  */
  if (!touchesBooks) return { kind: 'apply', changes, touchesBooks: false }

  const ground = REVISION_HOLDS.find((hold) => hold.applies(input.derived))
  if (ground) return { kind: 'hold', changes, ground }

  return { kind: 'apply', changes, touchesBooks: true }
}

/**
 * One sentence a person reads, naming the change and what to undo.
 *
 * Built here rather than in the screen so the same words reach a job result, an
 * audit entry and the inbox — ADR 0135's rule that a false sentence is exactly
 * as long as a true one, applied to a sentence that is about to be written three
 * times.
 */
export function describeHold(changes: FieldChange[], ground: RevisionHold): string {
  const parts = changes
    .filter((change) => (BOOK_AFFECTING_FIELDS as readonly string[]).includes(change.field))
    .map((change) =>
      change.field === 'amountCents'
        ? `the amount from ${formatCents(change.from as number)} to ${formatCents(change.to as number)}`
        : `the date from ${String(change.from)} to ${String(change.to)}`,
    )

  return `The bank changed ${joinWords(parts)}, and this was not applied: ${ground.remedy}`
}

/** Minor units as a signed decimal. No currency symbol — the account owns that. */
function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

function joinWords(parts: string[]): string {
  if (parts.length === 0) return 'something'
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function revisionStands(hold: RevisionHold): string[] {
  const problems: string[] = []

  if (hold.because.length < 240) {
    problems.push(
      `${hold.key} does not argue itself. Every entry here stops a bank feed from correcting ` +
        'itself, so the argument has to say what breaks if it did — otherwise the next person ' +
        'reading it cannot tell a real invariant from a cautious guess.',
    )
  }

  if (hold.remedy.length < 80) {
    problems.push(
      `${hold.key} names no remedy a person can act on (Phase 119). A held revision with no way ` +
        'out of it is a transaction that is wrong forever and says so.',
    )
  }

  return problems
}
