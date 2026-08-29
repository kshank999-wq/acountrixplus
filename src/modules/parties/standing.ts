/**
 * Where a customer or supplier actually stands (spec §6, §13, §16).
 *
 * ## The defects this closes
 *
 * The customers and suppliers screen (Phase 45) shows a **Balance** column, and
 * it was wrong in two ways for a business using it today.
 *
 * **It added currencies together.** `listCustomerSummaries` summed
 * `invoices.balance_cents` — the *document* amount — so a customer with a €2,500
 * invoice was shown "$2,500.00", and one holding both a $1,000 and a €2,500
 * invoice was shown "$3,500.00". Phase 35 named this exactly when it fixed the
 * same bug in `customersWithBalances`: adding face amounts produces "3,500 of
 * nothing with a dollar sign in front of it". It fixed that query and left this
 * one alone.
 *
 * **It could not see held credit.** Phase 53 gave an overpayment somewhere to
 * live and Phase 54 netted it off the statement and the chase. This screen — the
 * one somebody opens when the customer rings — still showed the gross, which is
 * the figure Phase 54 established is untrue when addressed to one party. Both
 * ADR 0053 and ADR 0054 named this screen as the follow-up.
 *
 * ## Why this composes `netPosition` instead of computing a net
 *
 * "What does this party owe on net" already has an answer, in
 * `receivables/net-position.ts`, decided in Phase 54. A second implementation
 * here would be two answers to one question — the exact defect Phase 51 refused
 * to create for corrections and Phase 53 refused for refunds. So this module
 * adds only what is genuinely new: **how late it is, and how to say so.**
 *
 * ## Why age belongs on this screen at all
 *
 * "Owes you $9,400" is not an actionable sentence. "Owes you $9,400, and the
 * oldest of it fell due 106 days ago" is — and this is the screen somebody is
 * looking at when they decide whether to ring. The aging *report* answers the
 * portfolio question (how collectable is the book); this answers the question
 * about one party, which is a different one.
 *
 * Nothing here touches the database or the clock. `asOf` is passed in.
 */

import { netPosition, type NetPosition } from '@/modules/receivables/net-position'
import { formatCents } from '@/lib/money'

/** How urgently somebody should be doing something about this party. */
export type StandingBand =
  /** Nothing owed, or the credit covers it. */
  | 'settled'
  /** Owed, but nothing has fallen due yet. */
  | 'current'
  /** Something is past its due date. */
  | 'overdue'
  /** Past due by more than ninety days, which is a different conversation. */
  | 'long_overdue'

export type PartyStanding = {
  position: NetPosition
  /**
   * Days past the oldest unpaid due date, or null when nothing is due yet or
   * nothing is owed. Never negative: "due in 12 days" is `current`, and a
   * negative overdue count is a number nobody reads correctly.
   */
  daysOverdue: number | null
  band: StandingBand
  /** One line for the screen, in the party's own terms. */
  note: string
}

/**
 * What a party's account comes to, and how late it is.
 *
 * `owedCents` and `heldCents` must both already be in the **home currency**.
 * This function cannot check that, and the reason the screen was wrong was that
 * its caller passed face amounts — so the callers convert, and the tests pin it.
 */
export function partyStanding(input: {
  /** What their open documents come to, in the home currency. */
  owedCents: number
  /** What is held against them — customer credit, or an unspent vendor credit. */
  heldCents: number
  /** The due date of the oldest thing still unpaid, if anything is. */
  oldestDueDate: string | null
  asOf: string
  /** Changes only the wording: a supplier is owed *by* us. */
  side?: 'customer' | 'vendor'
  currency?: string
}): PartyStanding {
  const position = netPosition({ owedCents: input.owedCents, heldCents: input.heldCents })
  const side = input.side ?? 'customer'
  const currency = input.currency ?? 'USD'

  const daysOverdue = overdueDays(input.oldestDueDate, input.asOf)

  /**
   * Banded on the **net**, not the gross. A customer with a $900 invoice 200
   * days old and $900 of their money sitting in `2520` is not somebody to chase
   * — they are somebody whose credit needs applying, and colouring that row red
   * sends a person to have the wrong conversation.
   */
  const band: StandingBand =
    position.dueCents === 0
      ? 'settled'
      : daysOverdue === null
        ? 'current'
        : daysOverdue > 90
          ? 'long_overdue'
          : 'overdue'

  return { position, daysOverdue, band, note: describe({ position, daysOverdue, side, currency }) }
}

/** Whole days past `dueDate`, or null when it is not past yet. */
function overdueDays(dueDate: string | null, asOf: string): number | null {
  if (!dueDate) return null

  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const now = Date.parse(`${asOf}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(now)) return null

  const days = Math.floor((now - due) / 86_400_000)
  return days > 0 ? days : null
}

function describe(input: {
  position: NetPosition
  daysOverdue: number | null
  side: 'customer' | 'vendor'
  currency: string
}): string {
  const { position, daysOverdue, side } = input
  const money = (cents: number) => formatCents(cents, input.currency)

  if (position.stance === 'we_owe') {
    return side === 'customer'
      ? `We are holding ${money(position.heldCents)} for them — ${money(position.ourDebtCents)} more than they owe.`
      : `They hold ${money(position.ourDebtCents)} of our credit against nothing owed.`
  }

  if (position.dueCents === 0) {
    return position.heldCents > 0
      ? `Nothing due — the ${money(position.heldCents)} held covers it.`
      : 'Nothing owed.'
  }

  const held = position.heldCents > 0 ? `, after ${money(position.heldCents)} held` : ''
  const late = daysOverdue === null ? '' : `, oldest ${daysOverdue} days overdue`
  const verb = side === 'customer' ? 'They owe' : 'We owe'

  return `${verb} ${money(position.dueCents)}${held}${late}.`
}
