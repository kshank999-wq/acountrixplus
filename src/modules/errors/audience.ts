/**
 * Who a thrown message was written for (Phase 119).
 *
 * ## The defect
 *
 * ADR 0074 settled how errors reach a screen: `DomainError` is shown, and
 * **everything else is logged and replaced with the caller's fallback**, so a
 * driver error can never publish table names or echo somebody's email back at
 * them. Deny by default, and right.
 *
 * What was never finished is the other half. Forty-three of the forty-four
 * server actions call `messageFor`, and the module layer under them throws
 * `new Error(...)` **298 times**. Measured across `src/modules`, with the
 * containing function's name searched for anywhere in `src/app`:
 *
 * ```
 * exported functions throwing a person-facing plain Error   103
 *   ...of those, reachable from src/app                      80
 *   sentences in those functions that never reach a person  144
 * ```
 *
 * Sentences like *"That is a vendor credit. It cannot be applied to an
 * invoice."*, *"That change order was rejected. Raise a new one instead."*,
 * *"A cost code needs the job it belongs to. Choose a job as well."* — each
 * written by somebody who knew exactly what the reader needed to do next, each
 * arriving on screen as **"Something went wrong."**
 *
 * Phase 118 hit this live: `ChartError extends Error` made all four of that
 * phase's refusals unreadable, and thirty-three passing tests could not see it,
 * because a test calls the service directly and asserts on the thrown message.
 * The test suite is exactly the wrong instrument for this defect.
 *
 * ## Why a classifier rather than a rule about types
 *
 * "No bare `throw new Error` in `src/modules`" would be simple and wrong. Some
 * of those 298 are for an operator and must stay hidden: a missing
 * `ENCRYPTION_KEY`, an unregistered provider key, an invariant that means the
 * code is broken rather than the input. Hiding those is the point of ADR 0074.
 *
 * So the question is not *what type was thrown* but **who the sentence was
 * written for**, and that is decidable from the sentence itself. A message
 * written for a person is a sentence: it starts with a capital, ends in a full
 * stop or a question mark, and addresses the reader. A message written for an
 * operator is a fragment naming a thing — `Customer not found`, `Unknown bank
 * provider "x"` — with no capital-to-full-stop shape, because nobody writes
 * prose for a log line.
 *
 * This is a heuristic, and it is stated as one. Its job is to be the tripwire's
 * rule, so `tests/refusal-audience.test.ts` can fail the moment somebody writes
 * a new refusal that will never be read.
 */

export type Audience =
  /** Written for whoever hit it, and useless in a log. */
  | 'person'
  /** Written for whoever maintains this, and unsafe or meaningless on a screen. */
  | 'operator'

/**
 * What makes a thrown message a sentence somebody was meant to read.
 *
 * Each rule carries the argument for itself, on the Phase 101 device — a bare
 * list of regular expressions is a fact that looks the same whether it is right
 * or wrong.
 */
export type AudienceRule = {
  name: string
  because: string
  /** True when this rule says the message was written for a person. */
  holds: (message: string) => boolean
}

export const AUDIENCE_RULES: readonly AudienceRule[] = [
  {
    name: 'opens like a sentence',
    because:
      'Prose for a reader starts with a capital. A log fragment names a thing and starts ' +
      'wherever the identifier does, so this separates "That invoice is voided." from ' +
      '"invoices.balance_cents out of range".',
    holds: (message) => /^[A-Z“"']/.test(message.trim()),
  },
  {
    name: 'closes like a sentence',
    because:
      'A full stop or a question mark is the mark of something written to be read out. ' +
      'Nobody punctuates a log line, so its absence is the strongest single signal that a ' +
      'message was never meant for a screen.',
    holds: (message) => /[.?”"']$/.test(message.trim()),
  },
  {
    name: 'says more than a name',
    because:
      'A message of one or two words is a label, not an explanation — "Not found" tells a ' +
      'person nothing they did not already know. Three words is the floor for a sentence ' +
      'that says what is wrong and what would fix it.',
    holds: (message) => message.trim().split(/\s+/).length >= 3,
  },
]

/**
 * Who this message was written for.
 *
 * Every rule must hold for a message to count as person-facing: the rules are
 * *evidence that somebody wrote prose*, and any one of them alone is too easy
 * to satisfy by accident.
 */
export function audienceOf(message: string): Audience {
  return AUDIENCE_RULES.every((rule) => rule.holds(message)) ? 'person' : 'operator'
}

/**
 * Bare `throw new Error` sites that carry a person-facing sentence and are
 * nonetheless allowed to stay.
 *
 * Empty on purpose, and it is meant to stay that way. It exists so that a
 * future case with a real argument has somewhere to make it — in prose, next to
 * the exception — rather than being smuggled in by weakening the rules above.
 * A refusal a person cannot read is not a refusal; it is a dead end with a
 * sentence wasted on it.
 */
export const ALLOWED_BARE_REFUSALS: readonly {
  file: string
  message: string
  because: string
}[] = []
