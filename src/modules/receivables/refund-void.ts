import { formatCents } from '@/lib/money'
import { isClosed, type ClosedPeriod } from './payment-void'

/**
 * Taking a refund back (spec §13, §16, Phase 69).
 *
 * ## What was missing
 *
 * All three of them. Phase 67 built `refundRetainer` and fixed `refundCredit`,
 * Phase 68 added `refundVendorCredit`, and ADR 0068 recorded the gap left over:
 *
 * > **A recovery cannot be voided**, the same gap ADR 0067 left for refunds.
 * > Phase 52 taught payments to unwind; none of the three refunds can.
 *
 * A refund is the easiest thing in the system to key wrongly — it is entered
 * from a bank line, in somebody else's currency, on a day somebody chooses.
 * €500 typed as €5,000, or the right amount against the wrong credit, was
 * permanent: the balance shows spent, the ledger shows the money gone, and the
 * only move left is a hand-posted journal that fixes the ledger and leaves
 * `refunds` still claiming it happened.
 *
 * This is the same sentence Phase 51 wrote and Phase 52 answered for payments,
 * one operation further along.
 *
 * ## Why a reversal needs no exchange rate
 *
 * This is the decision the phase exists to make, and it is a **refusal to look
 * anything up**.
 *
 * A reversal is not a new economic event. It does not say "the money came back
 * today at today's rate" — it says *the refund did not happen*. So it puts back
 * exactly the three amounts the row already carries, and the realised gain or
 * loss unwinds to the cent rather than being recomputed into a second, slightly
 * different figure.
 *
 * That is only possible because Phase 68 stored `carried`, `cash` and
 * `realised` instead of deriving them. A reversal that had to re-derive would
 * need the rate on the original day, would round independently, and would leave
 * a few cents of permanent noise in `7100` every time somebody corrected a
 * typo.
 *
 * ## What cannot be refused here
 *
 * There is deliberately **no ceiling check**. Putting back what a refund took
 * can never overfill the balance it came from, because
 * `total = applied + refunded + remaining` holds by construction — the face
 * amount only ever goes down, and `relieveFunctional` keeps the functional half
 * in step. A refusal for a case that cannot arise is a refusal somebody has to
 * read and reason about for ever.
 *
 * Nothing here touches the database or the clock.
 */

export type RefundSubject = 'retainer' | 'payment' | 'credit_note'

export type VoidableRefund = {
  id: string
  subjectType: RefundSubject
  /** The retainer, payment or credit note the money goes back into. */
  subjectId: string
  /** 'out' — the business handed money back. 'in' — the business got it back. */
  direction: 'out' | 'in'
  refundedOn: string
  /** In the other party's currency. */
  amountCents: number
  currency: string
  /** Functional, off the balance that was cleared. */
  carriedCents: number
  /** Functional, through the bank. */
  cashCents: number
  /** Positive was a gain. */
  realisedCents: number
  voidedAt: string | null
  reference: string | null
}

export type RefundTies = {
  /**
   * Whether the retainer, payment or credit note this refund came out of has
   * itself been cancelled since.
   */
  subjectVoided: boolean
  /** What to call it in the refusal — "VC-1004", "the retainer", the payment's reference. */
  subjectLabel: string
}

export type VoidRefundVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a refund may be taken back.
 *
 * Three refusals, each naming a record that would be left saying something
 * untrue — Phase 52's shape, where every refusal points at the thing that has
 * the money now and at a button that exists.
 */
export function refundVoidability(input: {
  refund: VoidableRefund
  ties: RefundTies
  closedPeriods: ClosedPeriod[]
  today: string
}): VoidRefundVerdict {
  const { refund, ties, closedPeriods } = input

  if (refund.voidedAt) {
    return { ok: false, why: 'That refund has already been taken back.' }
  }

  if (ties.subjectVoided) {
    return {
      ok: false,
      why:
        `${ties.subjectLabel} has been voided since this refund was recorded. Putting the money ` +
        'back would leave a cancelled record holding a balance somebody could spend.',
    }
  }

  /**
   * Phase 92's guard, reached through Phase 52's function rather than a second
   * copy of the date arithmetic. A closed period is somebody's signed-off
   * figure; the correction belongs in the open one as its own entry.
   */
  if (isClosed(refund.refundedOn, closedPeriods)) {
    return {
      ok: false,
      why:
        `That refund is dated ${refund.refundedOn}, which falls in a closed period. Post a ` +
        'correcting entry in the open one instead, so the change is visible rather than ' +
        'retrospective.',
    }
  }

  return { ok: true }
}

export type Reversal = {
  /** Goes back onto the retainer, payment or credit note, in its own currency. */
  balanceCents: number
  /** Goes back onto the account that was carrying it, in the company's money. */
  carriedCents: number
  /** Comes back out of — or into — the bank. */
  cashCents: number
  /** The realised gain or loss, unwound. */
  realisedCents: number
  /** The opposite of the refund's, which is what makes the entry mirror it. */
  direction: 'out' | 'in'
}

/**
 * What putting a refund back moves.
 *
 * Every figure is read off the row. Nothing is converted, nothing is rounded,
 * and there is no rate argument to pass — see the note above on why that is the
 * whole point rather than an omission.
 */
export function reversalOf(refund: VoidableRefund): Reversal {
  return {
    balanceCents: refund.amountCents,
    carriedCents: refund.carriedCents,
    cashCents: refund.cashCents,
    // `0 - x` rather than `-x`: unary minus on zero gives `-0`, which is a
    // different value from `0` to `Object.is` and to anything that round-trips
    // it. A domestic reversal realises nothing, and it should say so in the
    // ordinary way.
    realisedCents: 0 - refund.realisedCents,
    direction: refund.direction === 'out' ? 'in' : 'out',
  }
}

/**
 * What to tell somebody who has just done it.
 *
 * In the party's currency for what they get back, and the company's for the
 * exchange movement — the split Phase 61 settled and every phase since has
 * kept: a party is owed in theirs, and a gain or loss is ours.
 */
export function describeReversal(refund: VoidableRefund): string {
  const back = formatCents(refund.amountCents, refund.currency)
  const where =
    refund.direction === 'out'
      ? `${back} is owed again`
      : `${back} is available again`

  const realised =
    refund.realisedCents === 0
      ? ''
      : ` The ${formatCents(Math.abs(refund.realisedCents))} exchange ` +
        `${refund.realisedCents > 0 ? 'gain' : 'loss'} it realised is unwound.`

  return `Refund taken back. ${where}.${realised}`
}
