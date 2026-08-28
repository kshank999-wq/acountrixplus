/**
 * The payment nobody approved (spec §13, §14, §19).
 *
 * ## What one person could do
 *
 * With a single permission — `accounting:journal` — one person could:
 *
 * 1. create a supplier (Phase 45),
 * 2. enter a bill to it (Phase 41),
 * 3. and pay it (Phase 49).
 *
 * Nothing recorded who entered the bill, nothing asked anybody else, and
 * Phase 49 turned the last step into one click across a whole batch. That is
 * the fictitious-supplier fraud, and it is the control most small-business
 * theft actually exploits — not a clever exploit, just nobody looking.
 *
 * Spec §14 separates Bookkeeper from Accountant/Controller, but that split does
 * not help here: a bookkeeper cannot enter a bill at all (`createBill` wants
 * `accounting:journal`), so everybody who *can* enter one is also senior enough
 * to approve one. What separates the two is therefore the two-person rule —
 * not the bill you entered yourself — and what was missing for it was anywhere
 * in the record to say who entered a bill.
 *
 * ## The costly wrong answer
 *
 * Not "an unapproved bill sat for a day" — that is a delay. It is **making a
 * business that does not want this unable to pay anybody.** A sole trader is
 * their own bookkeeper and their own approver, and a two-person rule would
 * simply stop them working; a system that ships this switched on has shipped
 * a system most of its users must immediately disable.
 *
 * So it is **off by default**, has a threshold the company sets, and the
 * two-person rule is separate from the threshold — because "somebody must
 * approve big ones" and "it may not be the same somebody" are two different
 * decisions and a business may want the first without the second.
 *
 * Nothing here touches the database or the clock.
 */

/** What a company has decided about approving bills before paying them. */
export type ApprovalPolicy = {
  /**
   * Off unless somebody turns it on.
   *
   * A sole trader is their own bookkeeper and their own approver. Shipping
   * this on would ship a feature most users must immediately switch off.
   */
  enabled: boolean
  /**
   * Bills at or above this need an approval. Zero means every bill.
   *
   * A threshold rather than all-or-nothing because the point is attention, and
   * attention is finite: a rule that stops the week for a £4 parking receipt
   * is a rule somebody approves without reading, which is worse than no rule.
   */
  thresholdCents: number
  /**
   * Whether the approver may be the person who entered it.
   *
   * Separate from the threshold on purpose. "Somebody must approve the big
   * ones" and "it may not be the same somebody" are two decisions, and a
   * two-person business wanting the first cannot always honour the second.
   */
  twoPersonRule: boolean
}

/**
 * What a company that has never said anything gets.
 *
 * The threshold is zero because with `enabled: false` nothing reads it — but
 * see `STARTING_POLICY` below, because that zero is a trap for anything that
 * writes.
 */
export const APPROVAL_OFF: ApprovalPolicy = {
  enabled: false,
  thresholdCents: 0,
  twoPersonRule: true,
}

/**
 * What to start from when a company turns approvals on for the first time.
 *
 * **Found in the browser.** Switching the control on wrote `APPROVAL_OFF` as
 * its baseline, so the saved threshold was **zero** — meaning every bill,
 * including a £4 parking receipt, now needed a second person. That is exactly
 * the failure this module warns about two paragraphs up: a rule that stops the
 * week for trivia is a rule somebody approves without reading, which is worse
 * than no rule at all. And it quietly overrode the £1,000 the schema had
 * chosen as its default.
 *
 * `APPROVAL_OFF` is the right answer for a *read* and the wrong seed for a
 * *write*, so the two are now separate constants.
 */
export const STARTING_POLICY: ApprovalPolicy = {
  enabled: false,
  thresholdCents: 100_000,
  twoPersonRule: true,
}

/** A bill as this module needs to see it. */
export type ApprovableBill = {
  id: string
  number: string
  totalCents: number
  /** Who entered it. Null on bills raised before Phase 50, and by the system. */
  enteredBy: string | null
  approvedBy: string | null
}

export type ApprovalState =
  /** The policy does not ask for one. */
  | 'not_required'
  /** It has one. */
  | 'approved'
  /** It needs one and has not got one. */
  | 'awaiting'

/** Whether this bill needs an approval, and whether it has one. */
export function approvalState(bill: ApprovableBill, policy: ApprovalPolicy): ApprovalState {
  if (bill.approvedBy) return 'approved'
  if (!policy.enabled) return 'not_required'
  // At or above. A threshold of 100 means a bill for exactly 100 needs one —
  // "over £1,000 needs approval" is how people say "£1,000 and up", and the
  // off-by-one lands on the boundary somebody chose deliberately.
  if (bill.totalCents < policy.thresholdCents) return 'not_required'
  return 'awaiting'
}

/** Whether a pay run may include this bill. */
export function payable(bill: ApprovableBill, policy: ApprovalPolicy): boolean {
  return approvalState(bill, policy) !== 'awaiting'
}

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; why: string }

/**
 * Whether this person may approve this bill.
 *
 * The two-person rule is the substance. Everything else here is bookkeeping
 * about whether an approval is wanted at all.
 */
export function mayApprove(input: {
  bill: ApprovableBill
  policy: ApprovalPolicy
  /** Who is pressing the button. */
  actorId: string
}): ApprovalVerdict {
  const { bill, policy, actorId } = input

  if (bill.approvedBy) {
    return { ok: false, why: `${bill.number} has already been approved.` }
  }

  if (!policy.enabled) {
    return {
      ok: false,
      why: 'Approvals are switched off, so there is nothing to approve.',
    }
  }

  if (bill.totalCents < policy.thresholdCents) {
    return {
      ok: false,
      why: `${bill.number} is below the amount that needs approving, so it can be paid as it is.`,
    }
  }

  if (policy.twoPersonRule && bill.enteredBy && bill.enteredBy === actorId) {
    return {
      ok: false,
      why:
        `You entered ${bill.number}, so somebody else has to approve it. That is the whole ` +
        'point of the rule — one person creating a supplier, billing it and paying it is how ' +
        'money leaves a business without anybody noticing.',
    }
  }

  return { ok: true }
}

export type RunSplit<T> = {
  /** Bills the run may pay. */
  payable: T[]
  /** Bills held back, waiting for somebody to approve them. */
  held: T[]
}

/**
 * Splits a chosen set into what may be paid and what is waiting.
 *
 * A pay run **holds back** rather than refusing outright. Somebody ticking
 * eight bills of which one needs approving should get the seven paid and be
 * told about the eighth — refusing the lot teaches them to switch approvals
 * off, which is the opposite of what the control is for.
 */
export function splitByApproval<T extends ApprovableBill>(
  bills: T[],
  policy: ApprovalPolicy,
): RunSplit<T> {
  const split: RunSplit<T> = { payable: [], held: [] }

  for (const bill of bills) {
    if (payable(bill, policy)) split.payable.push(bill)
    else split.held.push(bill)
  }

  return split
}

/** What to tell somebody about the ones held back, or null when none were. */
export function describeHeld(held: ApprovableBill[]): string | null {
  if (held.length === 0) return null

  const total = held.reduce((sum, bill) => sum + bill.totalCents, 0)
  const names = held
    .slice(0, 3)
    .map((bill) => bill.number)
    .join(', ')
  const more = held.length > 3 ? ` and ${held.length - 3} more` : ''

  return (
    `${held.length} bill${held.length === 1 ? '' : 's'} worth ${(total / 100).toFixed(2)} ` +
    `${held.length === 1 ? 'was' : 'were'} left out — ${names}${more} ` +
    `${held.length === 1 ? 'needs' : 'need'} approving first.`
  )
}
