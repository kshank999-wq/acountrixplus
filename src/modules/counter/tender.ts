/**
 * What a handful of tenders settles (spec §13).
 *
 * The last thing three consecutive ADRs asked for. Phases 29 and 30 could
 * deliver a service and Phase 31 made that raise a real invoice, but nothing
 * could take the money — which for a salon or a garage is most of the job, and
 * for a customer standing at the desk is all of it.
 *
 * A pure core, with no database and no clock. Here the reason is that the
 * arithmetic is done in front of somebody who is watching, with cash in their
 * hand, and a shop assistant has to be able to say why the drawer says what it
 * says.
 *
 * ## The claims this file makes true
 *
 * **Change is not a transaction.** A customer who hands over $50 for a $36.50
 * bill has paid $36.50. Recording $50 in and $13.50 out would overstate the
 * day's takings and misstate every till reconciliation that reads them. What is
 * recorded is what was *kept*.
 *
 * **You cannot give change on a card.** Change is a cash-only idea. A card
 * charged more than the bill is not generous, it is an error, and the honest
 * thing is to refuse rather than to hand back somebody else's money in notes.
 *
 * **Nothing applies more than is owed.** A tender beyond the bill is change if
 * it is cash and a mistake if it is not.
 */

import { formatCents } from '@/lib/money'
import { DomainError } from '@/modules/errors'

/**
 * How the money arrived.
 *
 * `cash` is singled out throughout this file, and it is the only kind that is.
 * That is not a preference — it is the only tender the shop physically holds
 * and can hand part of back.
 */
export type TenderKind = 'cash' | 'card' | 'gift_card' | 'bank_transfer' | 'cheque' | 'other'

export type Tender = {
  kind: TenderKind
  /** What the customer handed over or the terminal took. Never negative. */
  amountCents: number
  /** A card's last four, a cheque number. Recorded, never interpreted. */
  reference?: string | null
}

export type Settlement = {
  /** What comes off the bill. */
  appliedCents: number
  /**
   * Cash handed back. Never posted anywhere.
   *
   * It is the difference between what was put on the counter and what was
   * kept, and neither number is an accounting event on its own.
   */
  changeCents: number
  /** What the customer still owes after this. Zero on a settled bill. */
  stillDueCents: number
  /** What each tender actually settled, in the order they are applied. */
  applied: Array<{ kind: TenderKind; amountCents: number; reference?: string | null }>
  /** True when the bill is fully paid. */
  settled: boolean
}

/** Raised when the tenders cannot be made to work against the bill. */
export class TenderError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'TenderError'
  }
}

/**
 * Works out what a set of tenders does to a bill.
 *
 * ## Non-cash is applied first, and the order is load-bearing
 *
 * Cash is the only tender that can give change, so it has to be the one left
 * holding any excess. Applying cash first would mean a customer paying $20 cash
 * and $16.50 on a card against a $36.50 bill could end up with the card
 * over-charged and cash handed back — taking money off a card in order to give
 * it back in notes, which is somewhere between a mistake and a way to launder a
 * till.
 *
 * So: every non-cash tender is applied in full, and if together they exceed the
 * bill that is refused rather than resolved. Then cash covers what is left, and
 * whatever cash is over is change.
 */
export function tenderFor(dueCents: number, tenders: Tender[]): Settlement {
  const due = amount(dueCents)

  if (tenders.length === 0) {
    throw new TenderError('No payment was offered.')
  }

  for (const tender of tenders) {
    if (amount(tender.amountCents) === 0) {
      throw new TenderError(`A ${label(tender.kind)} tender of nothing is not a payment.`)
    }
  }

  const nonCash = tenders.filter((tender) => tender.kind !== 'cash')
  const cash = tenders.filter((tender) => tender.kind === 'cash')

  const nonCashCents = nonCash.reduce((sum, tender) => sum + amount(tender.amountCents), 0)
  const cashCents = cash.reduce((sum, tender) => sum + amount(tender.amountCents), 0)

  if (nonCashCents > due) {
    throw new TenderError(
      `That takes ${money(nonCashCents - due)} more than is owed, and change cannot be given on ` +
        `${nonCash.length === 1 ? `a ${label(nonCash[0].kind)}` : 'those'}. ` +
        `Take ${money(due)} instead.`,
    )
  }

  const applied: Settlement['applied'] = nonCash.map((tender) => ({
    kind: tender.kind,
    amountCents: amount(tender.amountCents),
    reference: tender.reference ?? null,
  }))

  // What cash has to cover, and what it hands back.
  const remaining = due - nonCashCents
  const cashApplied = Math.min(cashCents, remaining)
  const changeCents = cashCents - cashApplied

  if (cashApplied > 0) {
    // The cash tenders are collapsed into one applied line. Two twenties and a
    // ten is one payment of fifty; splitting it would make the ledger a record
    // of denominations, which is the till's business and not the books'.
    applied.push({
      kind: 'cash',
      amountCents: cashApplied,
      reference: cash.find((tender) => tender.reference)?.reference ?? null,
    })
  }

  const appliedCents = nonCashCents + cashApplied

  return {
    appliedCents,
    changeCents,
    stillDueCents: due - appliedCents,
    applied,
    settled: appliedCents === due,
  }
}

function label(kind: TenderKind): string {
  return kind === 'gift_card'
    ? 'gift card'
    : kind === 'bank_transfer'
      ? 'bank transfer'
      : kind
}

/**
 * Refusals are read by whoever is at the desk, so they carry the currency the
 * rest of the interface uses. `formatCents` is a formatter, not infrastructure
 * — it keeps no state and asks nothing — so importing it costs this file none
 * of its purity.
 */
function money(cents: number): string {
  return formatCents(cents)
}

/** A figure that is not a number is zero, never `NaN` reaching a journal line. */
function amount(cents: number): number {
  if (!Number.isFinite(cents)) return 0
  return Math.max(0, Math.round(cents))
}
