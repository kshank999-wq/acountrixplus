import type { TransactionalResult } from '../transactional'

/**
 * What every HTTP mail provider has in common (spec §18, §19).
 *
 * ## Why HTTP rather than SMTP
 *
 * The application runs on short-lived serverless invocations. SMTP is a
 * stateful conversation over a long-lived socket — connect, EHLO, STARTTLS,
 * AUTH, MAIL FROM, RCPT TO, DATA — and it wants a connection pool that a
 * function which may be frozen mid-send does not have. Every provider worth
 * using offers a JSON endpoint that is one request, and one request is what
 * this runtime is good at.
 *
 * It also keeps the dependency list where it is. An SMTP client is a library;
 * this is `fetch`.
 *
 * ## The part that matters
 *
 * `retryable` is the only interesting field in a failure. The interface has
 * carried it since Phase 19 and nothing has ever produced a meaningful value,
 * because the only adapter was the mock and the mock always succeeds. Getting
 * it right is the whole reason this file exists rather than the classification
 * being copied into each vendor.
 */

/**
 * How long to wait before giving up on a provider.
 *
 * Short on purpose. A person is sitting on a form waiting to be told their
 * link is on its way, and a provider that has not answered in ten seconds is
 * not about to. Failing fast turns a hang into a retryable failure, which is
 * a better outcome than a serverless timeout that records nothing at all.
 */
const TIMEOUT_MS = 10_000

/**
 * Whether it is worth trying this again.
 *
 * The line is between "the provider could not take it just now" and "the
 * provider understood and said no". Retrying the first costs a few seconds;
 * retrying the second sends the same rejected request forever.
 *
 *  - **429** — rate limited. The canonical retry.
 *  - **408, 5xx** — the provider's problem, not the message's.
 *  - **other 4xx** — a bad key, a malformed address, an unverified sending
 *    domain. None of these get better by asking again.
 */
export function retryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true
  return status >= 500
}

/** A provider that answered, and what it said. */
type Answer = { status: number; body: unknown; raw: string }

/**
 * One JSON request, with a timeout, never throwing.
 *
 * Returns a discriminated result rather than throwing, because every caller
 * has to turn the outcome into a `TransactionalResult` anyway and a thrown
 * network error is not more exceptional than a 500 — both mean "no mail yet,
 * try later".
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ ok: true; answer: Answer } | { ok: false; error: string; retryable: true }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // DNS, TLS, connection reset, or our own timeout. All transient by
    // nature: nothing about the message was rejected, because nothing about
    // the message was read.
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Could not reach the mail provider: ${reason}`, retryable: true }
  }

  const raw = await response.text()
  let body: unknown = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    // A provider that returns HTML on error — a proxy page, usually — is
    // still telling us the status, which is the part the classification
    // needs. Keeping `raw` means the recorded error says what came back.
    body = null
  }

  return { ok: true, answer: { status: response.status, body, raw } }
}

/**
 * Reads a message out of whatever shape the provider returned.
 *
 * Providers disagree about where the human-readable reason lives, and a
 * failure recorded as `[object Object]` is a failure nobody can act on. The
 * raw body is the fallback, truncated, because the point is to be diagnosable
 * rather than complete.
 */
export function errorMessage(answer: Answer, fields: string[]): string {
  if (answer.body && typeof answer.body === 'object') {
    const record = answer.body as Record<string, unknown>
    for (const field of fields) {
      const value = record[field]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  const trimmed = answer.raw.trim()
  if (trimmed) return trimmed.slice(0, 300)
  return `The mail provider returned ${answer.status} with no explanation.`
}

/** Shorthand for the failure half of a `TransactionalResult`. */
export function failed(error: string, retryable: boolean): TransactionalResult {
  return { ok: false, error, retryable }
}

/**
 * Configuration read at construction, refusing when it is missing.
 *
 * A deployment that names a provider and forgets its key should find out when
 * it starts, not when somebody locked out of their books asks for a link. The
 * throw is the point.
 */
export function requiredEnv(name: string, provider: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(
      `TRANSACTIONAL_EMAIL_PROVIDER is "${provider}" but ${name} is not set. ` +
        `Set it, or use TRANSACTIONAL_EMAIL_PROVIDER=mock to keep mail in memory.`,
    )
  }
  return value.trim()
}

/** `Name <email>`, which every provider accepts and several require. */
export function addressLine(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim()
  if (!trimmed) return email
  // Quoted so a comma or angle bracket in a display name cannot invent a
  // second recipient.
  return `"${trimmed.replace(/["\\]/g, '')}" <${email}>`
}
