/**
 * The difference between an error written for a person and one that escaped.
 *
 * ## Why this exists
 *
 * Every server action in `src/app/actions` ended a `catch` with
 *
 * ```ts
 * return { error: error instanceof Error ? error.message : 'Could not …' }
 * ```
 *
 * which returns *whatever went wrong* to the browser. For the 49 errors this
 * codebase throws deliberately — `FundError`, `PermissionError`,
 * `CloseBlockedError` — that is exactly right: they were written to be read by
 * the person who hit them, and several took a whole phase to word well.
 *
 * For anything else it is a leak and a dead end at the same time. A registration
 * against an unreachable database put this on screen:
 *
 * ```
 * Failed query: select "id", "email", "password_hash", "name", "created_at"
 * from "users" where "users"."email" = $1 limit $2 params: ken@example.com,1
 * ```
 *
 * Three things wrong with it. It publishes the table and column names. It echoes
 * the address that was typed into the form. And it does not say what actually
 * broke — postgres.js puts that on the `cause`, which never reached the screen,
 * so the one fact that would have ended the problem in a minute
 * (`ENOTFOUND db.….supabase.co`) was the one fact missing.
 *
 * ## Deny by default
 *
 * The rule is not "hide errors that look like database errors" — that is a
 * blocklist, and the next driver, provider or parser throws something not on
 * it. An error reaches a person only if it is a `DomainError`. Everything else
 * gets a generic sentence, and the real thing is logged where operators can
 * read it.
 */

/**
 * An error whose message is meant for whoever hit it.
 *
 * Extended by every deliberate refusal in `src/modules`. Carries no behaviour:
 * it exists so `messageFor` can tell "the period is closed" apart from a
 * connection reset.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

/**
 * A refusal whose sentence is the whole point of it (Phase 119).
 *
 * ## Why one class and not twenty-four
 *
 * Sixty classes already extend `DomainError`, and every one of them exists so
 * that *something can catch it by type* — `ClosedPeriodError` is caught,
 * `IdempotencyConflictError` is caught, `PermissionError` is caught. That is a
 * good reason to name an error, and none of it applies here.
 *
 * The 192 refusals this replaces were `throw new Error(...)`. Nothing could
 * catch them by type, because they had no type; nothing ever wanted to. Their
 * entire job was to be **read by the person who hit them**, and `messageFor`'s
 * deny-by-default (ADR 0074) meant not one of them ever was:
 *
 * ```
 * That is a vendor credit. It cannot be applied to an invoice.
 *   → "Something went wrong."
 * ```
 *
 * So the defect was never "the wrong class". It was that a sentence written for
 * a reader carried nothing saying so. Inventing twenty-four module classes to
 * fix that would add twenty-four things to import and nothing to catch — the
 * ceremony of a type system without the use of one.
 *
 * `Refusal` says the one thing that was missing: **this sentence is for
 * whoever hit it.** Use it for anything a person can cause and act on. Keep a
 * bare `Error` for what only an operator can act on — a missing environment
 * variable, an unregistered key, an invariant that means the code is wrong
 * rather than the input — because hiding those is what ADR 0074 is for.
 */
export class Refusal extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/**
 * Logged rather than shown, with enough context to find it.
 *
 * `cause` is walked explicitly because that is where the useful sentence
 * usually lives — postgres.js wraps a connection failure in a "Failed query"
 * whose own message names only the SQL.
 */
export function logUnexpected(error: unknown, context: string): void {
  const parts: string[] = [`[error] ${context}:`]

  if (error instanceof Error) {
    parts.push(`${error.name}: ${error.message}`)
    let cause: unknown = error.cause
    let depth = 0
    while (cause instanceof Error && depth < 5) {
      parts.push(`\n  caused by ${cause.name}: ${cause.message}`)
      const code = (cause as { code?: unknown }).code
      if (typeof code === 'string') parts.push(` (${code})`)
      cause = cause.cause
      depth += 1
    }
    if (error.stack) parts.push(`\n${error.stack}`)
  } else {
    parts.push(String(error))
  }

  console.error(parts.join(''))
}

/**
 * What to put in front of somebody after a `catch`.
 *
 * `fallback` is the sentence for "this operation failed", written by the caller
 * because only the caller knows what was being attempted.
 *
 * ```ts
 * catch (error) {
 *   return { error: messageFor(error, 'Could not create the company.') }
 * }
 * ```
 */
export function messageFor(error: unknown, fallback: string): string {
  if (error instanceof DomainError) return error.message

  logUnexpected(error, fallback)
  return fallback
}
