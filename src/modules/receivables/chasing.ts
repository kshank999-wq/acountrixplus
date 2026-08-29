/**
 * Deciding whether an invoice is due a chase today (spec §13, §24).
 *
 * ## Why a business needs this and cannot do it
 *
 * Getting paid is the thing a small business is worst at, and the reason is
 * not that they do not know who owes them. It is that chasing is a job nobody
 * has, that has to happen on a Tuesday when something else is on fire, and
 * that feels rude. So it does not happen, and an invoice that went out in
 * March is still open in July because nobody said anything after the first
 * email.
 *
 * Phase 42 built the send: the wording, the reminder flag, the count, the
 * delivery record. Phase 10 built the worker. What was missing is the only
 * hard part — **when**.
 *
 * ## The two expensive wrong answers
 *
 * - **Chasing something already settled.** The worst outcome by a distance.
 *   A customer who paid last week and gets a demand this week does not think
 *   "their software is confused", they think "these people do not know what I
 *   owe them", and every figure the business ever sends them is doubted after
 *   that. So the rule is not "chase what is overdue" — it is *chase only what
 *   is open, unsettled, not written off, and actually sent*.
 * - **Chasing too often.** Daily reminders are how a sender gets blocked, and
 *   they train a customer to ignore the address the invoice came from. A
 *   cadence with a ceiling ends the sequence and hands the problem to a person,
 *   which is where a debt that has survived four polite emails belongs.
 *
 * Nothing here touches the database or the clock. `asOf` is passed in.
 */

// The one import this module has, and it is another pure one: the rule about
// not chasing somebody whose money you are holding is documented where it is
// decided (Phase 54), rather than restated here as a bare comparison.
import { chaseableAgainstCredit } from './net-position'

/** How a company wants its invoices chased. */
export type ChasePolicy = {
  /**
   * Off unless somebody turns it on.
   *
   * The default has to be off: this sends email to *their customers* over
   * *their* name, and a feature that starts doing that because a deployment
   * happened is one nobody consented to.
   */
  enabled: boolean
  /**
   * Days after the due date before the first chase.
   *
   * Zero means the day it falls due. Negative would be chasing before the
   * money is late, which is a different letter and not this one.
   */
  firstAfterDays: number
  /** Days between chases after the first. */
  everyDays: number
  /**
   * How many chases an invoice gets before this stops and it becomes
   * somebody's job. An invoice chased for ever is a relationship ending by
   * automation.
   */
  maxChases: number
  /**
   * Nothing below this is chased.
   *
   * A £2 balance left by a rounding difference is not worth an email, and
   * chasing one makes the business look worse than writing it off.
   */
  minimumBalanceCents: number
  /**
   * Days of quiet after a payment lands.
   *
   * Somebody who part-paid yesterday has engaged. Chasing them the next
   * morning reads as not having noticed.
   */
  quietDaysAfterPayment: number
}

export const DEFAULT_CHASE_POLICY: ChasePolicy = {
  enabled: false,
  firstAfterDays: 3,
  everyDays: 14,
  maxChases: 3,
  minimumBalanceCents: 500,
  quietDaysAfterPayment: 5,
}

/** What this module needs to know about an invoice. Nothing more. */
export type ChaseableInvoice = {
  id: string
  number: string
  status: string
  dueDate: string
  balanceCents: number
  /** Null when it has never been sent. You cannot remind somebody of nothing. */
  sentAt: string | null
  /** Phase 42's counter: the first send is one, so a chase is the second. */
  sendCount: number
  /** When money last landed against it, if it ever has. */
  lastPaymentDate: string | null
  /**
   * Where a chase would go, if anywhere.
   *
   * Checked here rather than left to the send, so the preview cannot promise a
   * chase the send will then refuse. A screen that lists an invoice as going
   * out today and then does not send it is worse than one that never listed it.
   */
  customerEmail: string | null
  /**
   * What the business is holding for this customer, across all their receipts
   * (Phase 54). Optional so every existing caller keeps compiling and reads as
   * "nothing held", which is what it was before Phase 53 made otherwise
   * possible.
   */
  heldCreditCents?: number
}

export type ChaseVerdict =
  | {
      chase: true
      /** 1 for the first chase, 2 for the second. Decides the tone. */
      stage: number
      daysOverdue: number
    }
  | { chase: false; reason: ChaseRefusal }

/**
 * Why an invoice is not being chased.
 *
 * Named rather than a sentence so the preview screen can group them — "14 not
 * chased because they are not due yet" is a useful line, and fourteen
 * sentences are not.
 */
export type ChaseRefusal =
  | 'policy_off'
  | 'not_open'
  | 'settled'
  | 'never_sent'
  | 'no_address'
  | 'not_due_yet'
  | 'too_soon'
  | 'enough_already'
  | 'too_small'
  | 'just_paid'
  /**
   * The business is holding money for this customer (Phase 54).
   *
   * Phase 53 gave an overpayment somewhere to live and left this run blind to
   * it, so a customer who had sent too much would receive a demand for money
   * the business was sitting on — sent by a scheduler, without anybody
   * deciding again.
   */
  | 'holding_their_money'

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.floor((b - a) / 86_400_000)
}

/**
 * Whether this invoice gets a chase today.
 *
 * The order of the refusals is deliberate: the ones that are about the invoice
 * being wrong to chase at all come before the ones about timing, so the reason
 * reported is the most useful one. An invoice that is both settled and not due
 * yet reports `settled`.
 */
export function chaseVerdict(input: {
  invoice: ChaseableInvoice
  policy: ChasePolicy
  asOf: string
}): ChaseVerdict {
  const { invoice, policy, asOf } = input

  if (!policy.enabled) return { chase: false, reason: 'policy_off' }

  // `open` and `partial` are the only states that mean money is outstanding
  // and somebody still intends to collect it. Written off, void, draft and
  // paid are all excluded, and each for its own reason — a written-off debt
  // has been given up on, and chasing it contradicts the decision.
  if (invoice.status !== 'open' && invoice.status !== 'partial') {
    return { chase: false, reason: 'not_open' }
  }

  if (invoice.balanceCents <= 0) return { chase: false, reason: 'settled' }

  /**
   * Nothing goes out while the business is holding this customer's money.
   *
   * Placed here, among the reasons it is *wrong to chase at all*, rather than
   * with the timing ones: a letter asking for money you are sitting on is not
   * early, it is incorrect. And it is decided on the customer's whole position
   * rather than this invoice, because somebody has to say where that credit
   * belongs — apply it or refund it — and that is a person's decision, not a
   * scheduler's.
   */
  if (!chaseableAgainstCredit({ heldCents: invoice.heldCreditCents ?? 0 })) {
    return { chase: false, reason: 'holding_their_money' }
  }

  // You cannot remind somebody of something you never told them. The first
  // contact is a person's decision — a robot introducing itself with a demand
  // is not how a business opens a relationship.
  if (!invoice.sentAt) return { chase: false, reason: 'never_sent' }

  // Somebody sent this by pasting the share link into their own email, and the
  // customer record still has no address. There is nowhere for a chase to go.
  if (!invoice.customerEmail?.trim()) return { chase: false, reason: 'no_address' }

  if (invoice.balanceCents < policy.minimumBalanceCents) {
    return { chase: false, reason: 'too_small' }
  }

  if (invoice.lastPaymentDate) {
    const sincePayment = daysBetween(invoice.lastPaymentDate, asOf)
    if (sincePayment < policy.quietDaysAfterPayment) {
      return { chase: false, reason: 'just_paid' }
    }
  }

  const daysOverdue = daysBetween(invoice.dueDate, asOf)
  if (daysOverdue < policy.firstAfterDays) return { chase: false, reason: 'not_due_yet' }

  // The first send is not a chase. `sendCount` counts every letter, so the
  // chases so far are one fewer.
  const chasesSoFar = Math.max(0, invoice.sendCount - 1)
  if (chasesSoFar >= policy.maxChases) return { chase: false, reason: 'enough_already' }

  // Due for chase number n once n × everyDays have passed beyond the first
  // window. Computed from the due date rather than from the last send, so a
  // schedule that missed a day catches up rather than sliding for ever.
  const dueOnDay = policy.firstAfterDays + chasesSoFar * policy.everyDays
  if (daysOverdue < dueOnDay) return { chase: false, reason: 'too_soon' }

  // ...and never sooner than the gap, whatever the anchor says.
  //
  // The anchor alone is not enough, and the case that proves it is the one
  // that matters most: a company switches chasing on with a year of unpaid
  // invoices behind it. Every anchored date for every stage is already in the
  // past, so the first run sends chase one, the second sends chase two, and
  // the whole sequence a person thought would take six weeks arrives in three
  // minutes. The scheduler's at-least-once guarantee produces the same thing
  // on any invoice far enough past due.
  //
  // So the two rules are both required and they answer different questions.
  // The anchor decides *which* chase is owed; the gap decides whether enough
  // silence has passed to send anything at all.
  const sinceLastSend = daysBetween(invoice.sentAt, asOf)
  const gapRequired = chasesSoFar === 0 ? policy.firstAfterDays : policy.everyDays
  if (sinceLastSend < gapRequired) return { chase: false, reason: 'too_soon' }

  return { chase: true, stage: chasesSoFar + 1, daysOverdue }
}

/** What to call each refusal on a screen. */
export const REFUSAL_LABELS: Record<ChaseRefusal, string> = {
  policy_off: 'chasing is switched off',
  not_open: 'not an open invoice',
  settled: 'nothing outstanding',
  never_sent: 'never sent to the customer',
  no_address: 'the customer has no email address',
  not_due_yet: 'not overdue yet',
  too_soon: 'chased recently',
  enough_already: 'chased as often as the policy allows',
  too_small: 'below the amount worth chasing',
  just_paid: 'paid something recently',
  holding_their_money: 'we are holding credit for this customer',
}

/**
 * Splits a set of invoices into what goes out today and what does not.
 *
 * Returned together rather than filtered, because the useful screen is not
 * "here are three emails" — it is "three go out, and here is why the other
 * forty do not", which is the only way somebody decides to trust this enough
 * to switch it on.
 */
export function planChases(input: {
  invoices: ChaseableInvoice[]
  policy: ChasePolicy
  asOf: string
}): {
  due: Array<{ invoice: ChaseableInvoice; stage: number; daysOverdue: number }>
  held: Array<{ invoice: ChaseableInvoice; reason: ChaseRefusal }>
  heldCounts: Record<ChaseRefusal, number>
} {
  const due: Array<{ invoice: ChaseableInvoice; stage: number; daysOverdue: number }> = []
  const held: Array<{ invoice: ChaseableInvoice; reason: ChaseRefusal }> = []
  const heldCounts = Object.fromEntries(
    Object.keys(REFUSAL_LABELS).map((key) => [key, 0]),
  ) as Record<ChaseRefusal, number>

  for (const invoice of input.invoices) {
    const verdict = chaseVerdict({ invoice, policy: input.policy, asOf: input.asOf })
    if (verdict.chase) {
      due.push({ invoice, stage: verdict.stage, daysOverdue: verdict.daysOverdue })
    } else {
      held.push({ invoice, reason: verdict.reason })
      heldCounts[verdict.reason] += 1
    }
  }

  // Oldest debt first. When a run is capped, the ones that have been waiting
  // longest are the ones worth the send.
  due.sort((a, b) => b.daysOverdue - a.daysOverdue)

  return { due, held, heldCounts }
}

/**
 * When this invoice is next due a chase, or null if it never is.
 *
 * For the preview: "nothing today, four on the 12th" is what makes somebody
 * comfortable turning this on, and it is a different question from "is it due
 * now".
 */
export function nextChaseDate(input: {
  invoice: ChaseableInvoice
  policy: ChasePolicy
}): string | null {
  const { invoice, policy } = input

  if (!policy.enabled) return null
  if (invoice.status !== 'open' && invoice.status !== 'partial') return null
  if (invoice.balanceCents <= 0) return null
  if (!invoice.sentAt) return null
  if (!invoice.customerEmail?.trim()) return null
  if (invoice.balanceCents < policy.minimumBalanceCents) return null

  const chasesSoFar = Math.max(0, invoice.sendCount - 1)
  if (chasesSoFar >= policy.maxChases) return null

  const dueOnDay = policy.firstAfterDays + chasesSoFar * policy.everyDays
  const due = Date.parse(`${invoice.dueDate}T00:00:00Z`)
  const lastSend = Date.parse(`${invoice.sentAt}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(lastSend)) return null

  // The later of the two rules `chaseVerdict` applies. Naming only the anchor
  // would promise a date the run then refuses, and a preview that is wrong
  // about the date is a preview nobody trusts about anything else either.
  const gapRequired = chasesSoFar === 0 ? policy.firstAfterDays : policy.everyDays
  const earliest = Math.max(due + dueOnDay * 86_400_000, lastSend + gapRequired * 86_400_000)

  return new Date(earliest).toISOString().slice(0, 10)
}
