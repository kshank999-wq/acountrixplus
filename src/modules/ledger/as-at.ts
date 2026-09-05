/**
 * What a document owed on a date that is not today (spec §13, §19).
 *
 * ## The defect
 *
 * Every report that compares the ledger with the documents behind it takes an
 * `asOf` date, walks the **ledger** back to it, and then reads the **document**
 * balance as it stands now. `receivables-check.ts` has said so since Phase 31,
 * and given a reason:
 *
 * > invoices do not keep a history of what they were owed on an arbitrary past
 * > date […] reconstructing historical document balances means replaying every
 * > payment application, which is a bigger machine than this check justifies.
 *
 * **That reason is false, and the schema says so.** Every one of the four paths
 * that reduces an invoice or bill balance writes a dated row:
 * `payment_applications` (dated by `payments.payment_date`),
 * `credit_applications.applied_on`, `invoice_write_offs.written_off_on`, and
 * `retainer_applications.applied_on`. It is not a replay; it is four sums.
 *
 * The cost of believing it, measured on the development books — three different
 * answers to "what was owed on 31 March", none of them right:
 *
 * ```
 * as at 2026-03-31:  aging=124194   ledger=364194   subledger=4940069
 * as at 2026-05-31:  aging=1870069  ledger=2543469  subledger=4940069
 * as at 2026-09-03:  aging=5000069  ledger=4940069  subledger=4940069
 * ```
 *
 * The control-account check reported a **$45,758.75 fault** on healthy books
 * for any date but today — the highest severity the register has, from a date
 * picker on the reports page. The aging report was wrong the other way: it
 * showed $1,241.94 outstanding in March because everything settled since reads
 * as settled all along.
 *
 * This is the third time in four phases that a *fault* fired on a legitimate
 * state (Phases 105, 106), and the same conclusion applies: a check that cries
 * wolf is a check somebody turns off.
 *
 * ## What this cannot recover, and says so
 *
 * **A voided document.** Voiding marks the journal entry `void` rather than
 * posting a reversal, and zeroes the document's balance, keeping no date for
 * either. So an invoice voided in July is absent from the March ledger *and*
 * the March subledger — the two still agree, and both are wrong about March in
 * the same way. Fixing that means dating the void, which is a change to how
 * correction works (Phase 51's territory) rather than to how history is read.
 *
 * No database and no clock: this file decides, the reports fetch.
 */

import { formatCents } from '@/lib/money'
import { RegistryError } from '@/modules/errors/registry'

/** A way a document's outstanding balance goes down. */
export type SettlementKind = 'payment' | 'credit_note' | 'write_off' | 'retainer'

export type SettlementPath = {
  kind: SettlementKind
  /** The table that records it. */
  table: string
  /** The column carrying the date it happened — what makes history readable. */
  dateColumn: string
  /** Why this path exists, and what would be lost by forgetting it. */
  because: string
}

/**
 * Every path that reduces a document balance, and where its date lives.
 *
 * Declared rather than left implicit, on the device Phases 70, 101, 105 and 106
 * used: this broke because four paths existed and nothing enumerated them, so a
 * fifth has to answer the question rather than quietly make history wrong.
 *
 * **Recovering a write-off is deliberately absent.** `recoverWriteOff` records
 * the recovery and posts an entry but never touches the document's balance —
 * the invoice stays written off at zero. It is a ledger event, not a document
 * one, and adding it here would restore a balance that never came back.
 */
export const SETTLEMENT_PATHS: readonly SettlementPath[] = [
  {
    kind: 'payment',
    table: 'payment_applications',
    dateColumn: 'payments.payment_date',
    because:
      'Money actually arriving against the document. Dated on the payment rather ' +
      'than the application, because the application row carries no date of its own — ' +
      'which is the detail that made this look unreconstructible.',
  },
  {
    kind: 'credit_note',
    table: 'credit_applications',
    dateColumn: 'applied_on',
    because:
      'A credit note being pointed at a particular invoice. The credit reduced the ' +
      'control account when it was issued (Phase 106); this is the later, separate ' +
      'act of deciding which invoice it settles.',
  },
  {
    kind: 'write_off',
    table: 'invoice_write_offs',
    dateColumn: 'written_off_on',
    because:
      'Giving up on collection. The debt was genuinely outstanding until that date, ' +
      'so an aging report for an earlier month must still show it — which is exactly ' +
      'what somebody looking at a historical aging is trying to see.',
  },
  {
    kind: 'retainer',
    table: 'retainer_applications',
    dateColumn: 'applied_on',
    because:
      "Drawing on money the client had already handed over. The invoice was owed until " +
      'the draw happened, even though the cash arrived before it.',
  },
]

/** The paths, by kind, so a caller cannot invent one. */
export function pathFor(kind: SettlementKind): SettlementPath {
  const path = SETTLEMENT_PATHS.find((entry) => entry.kind === kind)
  if (!path) {
    throw new RegistryError({
      registry: 'SETTLEMENT_PATHS',
      key: kind,
      message: `Nothing declares how a ${kind} settles a document.`,
    })
  }
  return path
}

/** One dated reduction of a document's balance. */
export type Settlement = {
  kind: SettlementKind
  /** ISO date it happened. */
  on: string
  /** In the document's own currency. Always positive. */
  cents: number
  /** In the company's own currency. Always positive. */
  functionalCents: number
}

export type AsAtBalance = {
  balanceCents: number
  functionalBalanceCents: number
  /**
   * What was put back to get here, largest first.
   *
   * Empty when nothing settled after the date asked about, which is every
   * document on a report asked about today.
   */
  undone: Array<{ kind: SettlementKind; cents: number; functionalCents: number }>
}

/**
 * What the document owed on `asOf`, from what it owes now and what has settled
 * since.
 *
 * A settlement **on** `asOf` counts as already having happened: a payment dated
 * 31 March is money received on 31 March, so a report as at 31 March shows the
 * invoice already reduced by it. Strictly after, and only after, is undone.
 */
export function balanceAsAt(
  now: { balanceCents: number; functionalBalanceCents: number },
  settlements: Settlement[],
  asOf: string,
): AsAtBalance {
  const after = settlements.filter((settlement) => settlement.on > asOf)

  const byKind = new Map<SettlementKind, { cents: number; functionalCents: number }>()
  for (const settlement of after) {
    const existing = byKind.get(settlement.kind) ?? { cents: 0, functionalCents: 0 }
    existing.cents += settlement.cents
    existing.functionalCents += settlement.functionalCents
    byKind.set(settlement.kind, existing)
  }

  const undone = [...byKind.entries()]
    .map(([kind, sums]) => ({ kind, ...sums }))
    .sort((a, b) => b.functionalCents - a.functionalCents || a.kind.localeCompare(b.kind))

  return {
    balanceCents: now.balanceCents + undone.reduce((sum, entry) => sum + entry.cents, 0),
    functionalBalanceCents:
      now.functionalBalanceCents +
      undone.reduce((sum, entry) => sum + entry.functionalCents, 0),
    undone,
  }
}

/**
 * Whether the document was an obligation on that date.
 *
 * Two conditions, and the second is the one that was missing: it must have been
 * **issued** by then, and it must still have owed something. A document issued
 * later did not exist; one whose restored balance is nil was already settled.
 */
export function wasOpenAt(
  document: { issueDate: string },
  balance: AsAtBalance,
  asOf: string,
): boolean {
  return document.issueDate <= asOf && balance.functionalBalanceCents !== 0
}

const KIND_WORDS: Record<SettlementKind, string> = {
  payment: 'paid',
  credit_note: 'credited',
  write_off: 'written off',
  retainer: 'drawn from a retainer',
}

/**
 * What was put back, for a reader who wants to know why this figure is not the
 * one on the document today.
 *
 * Undefined when nothing was undone, which keeps a report asked about today
 * exactly as quiet as it was before this phase.
 */
export function describeRestoration(
  balance: AsAtBalance,
  currency = 'USD',
): string | undefined {
  if (balance.undone.length === 0) return undefined

  const parts = balance.undone.map(
    (entry) => `${formatCents(entry.functionalCents, currency)} ${KIND_WORDS[entry.kind]}`,
  )
  return `Since then: ${parts.join(', ')}`
}
