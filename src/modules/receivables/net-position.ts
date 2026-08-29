/**
 * What a customer actually owes (spec §13, §16).
 *
 * ## The defect this closes, and where it came from
 *
 * Phase 53 gave a customer who overpays a place for the difference to live:
 * held credit, a liability the business owes them. It then left two
 * outward-facing things blind to it, and both were **made wrong by that phase**
 * rather than being wrong before it:
 *
 * - **The chase run** reads invoice balances and nothing else, so it will email
 *   a demand for money to a customer whose money the business is holding. Phase
 *   43's whole design is that these letters go out *without anybody deciding
 *   again* — which is exactly what makes a wrong one serious.
 * - **The statement** computes its closing balance from open invoices, so a
 *   customer holding $600 against a $900 invoice is sent a document claiming
 *   $900 is due. That is a statement the customer can disprove from their own
 *   bank records.
 *
 * ## Why netting here and not in the aging report
 *
 * The aging report is about **receivables**: what is owed to the business, by
 * age, so somebody can see how collectable it is. Held credit is a liability
 * and belongs on the other side of the balance sheet — netting it into aging
 * would hide it, which is precisely the mistake Phase 53 refused to make when
 * it declined to record an overpayment as a negative receivable.
 *
 * A **statement** and a **chase** are different: both are addressed to one
 * customer and both make a claim about what *that customer* should do next.
 * For those, the gross figure is not just unhelpful, it is untrue.
 *
 * Nothing here touches the database or the clock.
 */

import { formatCents } from '@/lib/money'

export type Stance =
  /** They owe the business money, on net. */
  | 'owes_us'
  /** Nothing is due either way. */
  | 'square'
  /** The business owes them, on net. */
  | 'we_owe'

export type NetPosition = {
  /** What their open invoices come to. */
  owedCents: number
  /** What the business is holding for them. */
  heldCents: number
  /**
   * What is actually due, never below zero.
   *
   * Clamped rather than allowed to go negative because "what should this
   * customer pay" has no negative answer — a customer owed money pays nothing,
   * and `stance` carries the fact that the balance runs the other way.
   */
  dueCents: number
  /** What the business would still owe them after their invoices are covered. */
  ourDebtCents: number
  stance: Stance
}

/** What a customer owes once what the business holds for them is netted off. */
export function netPosition(input: {
  owedCents: number
  heldCents: number
}): NetPosition {
  const owedCents = Math.max(0, Math.trunc(input.owedCents))
  const heldCents = Math.max(0, Math.trunc(input.heldCents))

  const dueCents = Math.max(0, owedCents - heldCents)
  const ourDebtCents = Math.max(0, heldCents - owedCents)

  return {
    owedCents,
    heldCents,
    dueCents,
    ourDebtCents,
    stance: dueCents > 0 ? 'owes_us' : ourDebtCents > 0 ? 'we_owe' : 'square',
  }
}

/**
 * Whether one invoice may be chased, given what the business holds.
 *
 * Deliberately decided on the **customer's whole position** rather than
 * invoice by invoice. A customer holding $600 with two $500 invoices open owes
 * $400 on net; chasing the older one for its full $500 is a letter that asks
 * for more than is due, and chasing neither because "$600 covers $500" would
 * leave $400 uncollected for ever.
 *
 * So the rule is: **while the business is holding anything for them, no chase
 * goes out.** Somebody has to decide where that credit belongs first — apply it
 * or refund it — and that decision is a person's, not a scheduler's. Once the
 * credit is nil, chasing resumes with nothing changed.
 */
export function chaseableAgainstCredit(input: { heldCents: number }): boolean {
  return Math.max(0, Math.trunc(input.heldCents)) === 0
}

/**
 * How to describe a customer's position, for a statement or a screen.
 *
 * The currency is passed in rather than assumed, because this sentence is
 * addressed to the customer: a bare `1540.00` on a document asking somebody for
 * money is the kind of ambiguity they ring up about.
 */
export function describeNet(position: NetPosition, currency = 'USD'): string {
  const money = (cents: number) => formatCents(cents, currency)

  switch (position.stance) {
    case 'we_owe':
      return (
        `Nothing is due. We are holding ${money(position.heldCents)} for you, and ` +
        `${money(position.ourDebtCents)} of it is still yours after the invoices above.`
      )
    case 'square':
      return position.heldCents > 0
        ? `Nothing is due — the ${money(position.heldCents)} we were holding covers what was owed.`
        : 'Nothing is due.'
    case 'owes_us':
      return position.heldCents > 0
        ? `${money(position.dueCents)} is due, after the ${money(position.heldCents)} we are holding for you.`
        : `${money(position.dueCents)} is due.`
  }
}
