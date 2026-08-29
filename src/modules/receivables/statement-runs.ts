/**
 * Deciding who is due a statement this month (spec §13, §24).
 *
 * ## Why this is its own phase
 *
 * Phase 55 made a statement sendable and said, in its own ADR, that a scheduler
 * which emails every customer without anybody deciding again is *"the feature
 * that most deserves its own phase, with its own preview screen, rather than
 * being tacked onto this one."* This is that phase.
 *
 * Sending statements is a month-end ritual that a small business either does on
 * one afternoon or does not do at all. It is the single highest-leverage
 * collections act there is — most late payment is not refusal, it is an invoice
 * that fell behind a filing cabinet — and it is exactly the kind of repetitive,
 * unurgent job that never happens.
 *
 * ## How this differs from the chase run, and why it matters
 *
 * Phase 43's chase run **sends documents that already exist**. This run
 * **creates one and then sends it**: a statement has to be saved first, because
 * saving is what freezes the figures (Phase 11), and frozen figures are the
 * whole point of the document (Phase 55).
 *
 * That difference has a consequence worth stating: a send that fails still
 * leaves a saved statement behind. That is correct rather than untidy — the
 * saved row is the evidence of what was about to go out, which is precisely
 * what `saveStatement` has existed for since Phase 11.
 *
 * ## Once per period, not once per day
 *
 * A daily worker must not send a customer thirty statements a month. The rule
 * is Phase 37's, in the same words it used for recurring billing: **a period is
 * billed exactly once**. Here the period is the month, and what makes it
 * idempotent is asking when this customer was last *sent* one — a question
 * Phase 55 made answerable by finally writing `sent_at`.
 *
 * Nothing here touches the database or the clock. `asOf` is passed in.
 */

/** How a company wants its statements sent. */
export type StatementPolicy = {
  /**
   * Off unless somebody turns it on.
   *
   * The same default, and the same reason, as chasing: this sends email to
   * *their customers* over *their* name, and a feature that starts doing that
   * because a deployment happened is one nobody consented to.
   */
  enabled: boolean
  /**
   * Which day of the month the run goes out on.
   *
   * Capped at 28 so every month has one. "The 31st" is a date that does not
   * exist in seven months of the year, and a schedule that silently skips
   * February is worse than one that runs on the 28th.
   */
  dayOfMonth: number
  /** Open-item lists what is unpaid; balance-forward carries a total in and out. */
  kind: 'open_item' | 'balance_forward'
  /**
   * Nothing below this is sent.
   *
   * A statement for $2 of rounding is not worth the customer's attention, and
   * sending one makes the business look automated rather than attentive. Held
   * credit is exempt from this floor — see `hasSomethingToSay`.
   */
  minimumBalanceCents: number
  /**
   * Days of quiet after a statement was last sent, however it was sent.
   *
   * Somebody who sent one by hand on the 29th does not want the run sending
   * another on the 1st. Counted from the last send rather than from the last
   * *run*, so a manual send counts.
   */
  quietDays: number
}

export const DEFAULT_STATEMENT_POLICY: StatementPolicy = {
  enabled: false,
  dayOfMonth: 1,
  kind: 'open_item',
  minimumBalanceCents: 500,
  quietDays: 20,
}

/** What this module needs to know about a customer. Nothing more. */
export type StatementCandidate = {
  customerId: string
  customerName: string
  /** Open documents in the home currency (Phase 56). */
  balanceCents: number
  /** What the business is holding for them (Phase 53). */
  heldCreditCents: number
  /** Where a statement would go, if anywhere. */
  customerEmail: string | null
  /** When they were last sent one, by anybody, by any means. Null if never. */
  lastSentDate: string | null
}

export type StatementRefusal =
  /** The company has not switched statement runs on. */
  | 'policy_off'
  /** Not the day of the month the policy names. */
  | 'not_the_day'
  /** Nothing owed and nothing held — there is no document to send. */
  | 'nothing_to_say'
  /** Owed, but under the floor worth sending. */
  | 'too_small'
  /** Nowhere to send it. */
  | 'no_email'
  /** They have had one recently, whether from a run or from a person. */
  | 'sent_recently'

export type StatementVerdict =
  | { send: true; balanceCents: number; heldCreditCents: number }
  | { send: false; reason: StatementRefusal }

export const STATEMENT_REFUSAL_LABELS: Record<StatementRefusal, string> = {
  policy_off: 'statement runs are switched off',
  not_the_day: 'not the day of the month for the run',
  nothing_to_say: 'nothing owed and nothing held',
  too_small: 'below the amount worth sending',
  no_email: 'no email address on file',
  sent_recently: 'sent a statement recently',
}

/**
 * Whether a customer has anything a statement could tell them.
 *
 * Deliberately **not** "do they owe us money". Phase 54 established that a
 * customer who owes nothing but whose money the business is holding has
 * something to be told, and that it is the more important half — they are owed
 * a refund or an application, and only the business knows it. So held credit
 * makes a statement worth sending on its own, and is exempt from the minimum:
 * a floor exists to stop trivial *demands*, and this is not a demand.
 */
export function hasSomethingToSay(candidate: {
  balanceCents: number
  heldCreditCents: number
}): boolean {
  return candidate.balanceCents > 0 || candidate.heldCreditCents > 0
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.floor((b - a) / 86_400_000)
}

/** Whether `asOf` is the day the policy runs on. */
export function isRunDay(policy: Pick<StatementPolicy, 'dayOfMonth'>, asOf: string): boolean {
  const day = Number(asOf.slice(8, 10))
  if (!Number.isFinite(day)) return false

  return day === clampDayOfMonth(policy.dayOfMonth)
}

/** The policy's day, held inside a range every month actually has. */
export function clampDayOfMonth(day: number): number {
  if (!Number.isFinite(day)) return 1
  return Math.min(28, Math.max(1, Math.trunc(day)))
}

/**
 * Whether this customer gets a statement today, and if not, why not.
 *
 * The order is deliberate and matches Phase 43's: the reasons that are about
 * *the company* come first, then the ones about *this customer*, so a preview
 * on a company that has not switched the feature on says so once rather than
 * saying "no email address" against four hundred rows.
 */
export function statementVerdict(input: {
  candidate: StatementCandidate
  policy: StatementPolicy
  asOf: string
  /**
   * Skip the day check entirely (the preview passes this).
   *
   * The day is a **scheduling** question; everything below it is an
   * **eligibility** question, and the preview only wants the second. Forcing
   * `dayOfMonth` to today instead looks equivalent and is not: `isRunDay`
   * clamps the policy's day to 28, so on the 29th, 30th and 31st the forced day
   * never matches and every row reads "not the day" — which browser
   * verification found it doing, on the 29th, under a heading promising to show
   * what would go out.
   */
  ignoreRunDay?: boolean
}): StatementVerdict {
  const { candidate, policy } = input

  if (!policy.enabled) return { send: false, reason: 'policy_off' }
  if (!input.ignoreRunDay && !isRunDay(policy, input.asOf)) {
    return { send: false, reason: 'not_the_day' }
  }

  if (!hasSomethingToSay(candidate)) return { send: false, reason: 'nothing_to_say' }

  /**
   * The floor applies to what they **owe**, not to what is held. A customer
   * owed $600 by the business is worth telling however small the debt, because
   * they cannot know about it and the business can.
   */
  if (candidate.heldCreditCents === 0 && candidate.balanceCents < policy.minimumBalanceCents) {
    return { send: false, reason: 'too_small' }
  }

  if (!candidate.customerEmail?.trim()) return { send: false, reason: 'no_email' }

  if (
    candidate.lastSentDate &&
    daysBetween(candidate.lastSentDate, input.asOf) < policy.quietDays
  ) {
    return { send: false, reason: 'sent_recently' }
  }

  return {
    send: true,
    balanceCents: candidate.balanceCents,
    heldCreditCents: candidate.heldCreditCents,
  }
}

/**
 * What a run today would do, over a whole book of customers.
 *
 * Returns both halves — what goes and what does not, with a reason each —
 * because the preview screen's job is to answer "why is this customer not
 * getting one", which is the question somebody has before they switch it on.
 */
export function planStatements(input: {
  candidates: StatementCandidate[]
  policy: StatementPolicy
  asOf: string
  /** Skip the day check — see `statementVerdict`. The preview passes this. */
  ignoreRunDay?: boolean
}): {
  due: Array<{ candidate: StatementCandidate; balanceCents: number; heldCreditCents: number }>
  held: Array<{ candidate: StatementCandidate; reason: StatementRefusal }>
  heldCounts: Record<StatementRefusal, number>
} {
  const due: Array<{
    candidate: StatementCandidate
    balanceCents: number
    heldCreditCents: number
  }> = []
  const held: Array<{ candidate: StatementCandidate; reason: StatementRefusal }> = []
  const heldCounts = Object.fromEntries(
    Object.keys(STATEMENT_REFUSAL_LABELS).map((key) => [key, 0]),
  ) as Record<StatementRefusal, number>

  for (const candidate of input.candidates) {
    const verdict = statementVerdict({
      candidate,
      policy: input.policy,
      asOf: input.asOf,
      ignoreRunDay: input.ignoreRunDay,
    })

    if (verdict.send) {
      due.push({
        candidate,
        balanceCents: verdict.balanceCents,
        heldCreditCents: verdict.heldCreditCents,
      })
    } else {
      held.push({ candidate, reason: verdict.reason })
      heldCounts[verdict.reason] += 1
    }
  }

  // Oldest debt first would need an age this module is not given; largest first
  // is the useful order when a cap is about to cut the list, because the
  // statements worth sending most are the ones with the most money on them.
  due.sort((a, b) => b.balanceCents - a.balanceCents)

  return { due, held, heldCounts }
}
