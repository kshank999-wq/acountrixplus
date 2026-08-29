import { randomUUID } from 'node:crypto'
import { buildTransactionalProvider } from './providers'

/**
 * Transactional email (spec §19, §14).
 *
 * ## A password reset is not marketing
 *
 * The marketing pipeline built in Phase 5 does two things before a message
 * reaches a provider: it checks consent, and it checks the suppression list.
 * Both are correct for a campaign and catastrophic for a password reset —
 * somebody who unsubscribed from the newsletter in March must still be able to
 * get back into their own books in August.
 *
 * So this is a separate channel with a separate message type, and the type is
 * where the distinction is enforced rather than in a comment. `OutboundMessage`
 * **requires** `unsubscribeUrl` and `unsubscribePostUrl`; a
 * `TransactionalMessage` has neither field to put them in. You cannot
 * accidentally send a campaign down this pipe, and you cannot accidentally
 * attach an unsubscribe link to a password reset — which would be an offer to
 * stop sending somebody the only mail that can let them in.
 *
 * The reverse abuse is the one regulators care about, and the type stops that
 * too: nothing marketing-shaped can be sent through here to dodge an
 * unsubscribe, because a `TransactionalMessage` carries no campaign, no
 * segment, and no recipient row to attribute engagement to.
 */

export type TransactionalKind =
  | 'password_reset'
  | 'company_invitation'
  | 'practice_invitation'
  | 'security_alert'
  /**
   * An invoice, sent to the customer who owes it (Phase 42).
   *
   * Transactional rather than marketing, and the distinction is the one this
   * module's header draws: it carries no unsubscribe link, because a business
   * asking to be paid is not making an offer somebody can decline. A customer
   * who does not want it should be sent it on paper, not silenced.
   */
  | 'invoice'
  /**
   * A statement of account, sent to the customer it is about (Phase 55).
   *
   * Its own kind rather than folded into `invoice`, because the two are rate
   * limited on different shapes. A business legitimately sends thirty invoices
   * in a minute to thirty addresses; it sends one customer one statement a
   * month. Sharing a bucket would let a month-end statement run exhaust the
   * allowance that stops the same customer being mailed the same invoice over
   * and over.
   */
  | 'statement'
  /**
   * A remittance advice, sent to a supplier who has just been paid (Phase 58).
   *
   * Its own kind because it is the only transactional message addressed to
   * somebody the business *owes* rather than somebody who owes it, and because
   * the rate limit belongs to a different shape: a pay run legitimately sends
   * fifty of these in a minute to fifty addresses, but one supplier gets one
   * per payment.
   */
  | 'remittance'

export type TransactionalMessage = {
  to: string
  toName?: string | null
  fromName: string
  fromEmail: string
  replyTo?: string | null
  subject: string
  html: string
  text: string
  /** What this message is. Recorded, and used for rate limiting. */
  kind: TransactionalKind
  /** Correlates a provider callback back to the row that caused the send. */
  reference?: string | null
}

export type TransactionalResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean }

export interface TransactionalProvider {
  readonly key: string
  send(message: TransactionalMessage): Promise<TransactionalResult>
}

/**
 * Records messages in memory instead of sending them.
 *
 * The default, so the demo and the tests run with no credentials and no risk
 * of a real send. Every message is kept so a test can assert exactly what
 * would have gone out — including that it carries no unsubscribe link.
 */
export class MockTransactionalProvider implements TransactionalProvider {
  readonly key = 'mock'
  readonly sent: TransactionalMessage[] = []

  /** Addresses that should fail, for exercising the bounce path. */
  readonly failing = new Set<string>()

  async send(message: TransactionalMessage): Promise<TransactionalResult> {
    if (this.failing.has(message.to.toLowerCase())) {
      return { ok: false, error: 'Mailbox does not exist', retryable: false }
    }

    this.sent.push(message)

    // Printed, because the token is hashed the moment it is stored and this is
    // the only place anybody can read it. Without this, a developer who clicks
    // "forgot my password" on their own dev server has genuinely locked
    // themselves out: the link exists, and nothing anywhere can show it to
    // them. Never in tests, where it would bury the output, and never in
    // production, where the real adapter is the one that runs.
    if (process.env.NODE_ENV === 'development') {
      const link = message.text.match(/https?:\/\/\S+/)?.[0]
      console.log(
        `\n[mail] ${message.kind} → ${message.to}: ${message.subject}` +
          (link ? `\n[mail] ${link}\n` : '\n'),
      )
    }

    return { ok: true, providerMessageId: `mock-${randomUUID()}` }
  }

  /** The most recent message to an address, for tests and the dev console. */
  lastTo(email: string): TransactionalMessage | undefined {
    const wanted = email.toLowerCase()
    return [...this.sent].reverse().find((message) => message.to.toLowerCase() === wanted)
  }

  reset() {
    this.sent.length = 0
    this.failing.clear()
  }
}

let registered: TransactionalProvider | null = null
const mock = new MockTransactionalProvider()

/** Swaps the provider. The seam spec §18 asks for, one adapter and one variable. */
export function registerTransactionalProvider(provider: TransactionalProvider): void {
  registered = provider
}

export function mockTransactionalProvider(): MockTransactionalProvider {
  return mock
}

/**
 * The constructed adapter, kept because building one reads the environment and
 * validates it. Keyed so a test that changes the variable gets the provider it
 * asked for rather than the one before it.
 */
let resolved: { key: string; provider: TransactionalProvider } | null = null

/** Drops the memoised adapter. For tests that move between providers. */
export function resetTransactionalProvider(): void {
  registered = null
  resolved = null
}

export function getTransactionalProvider(): TransactionalProvider {
  if (registered) return registered

  // `|| 'mock'` rather than `??`, because a variable set to the empty string is
  // not unset. Every hosting panel lets you save a blank value, and treating
  // that as a provider named "" fails every send with an error about an unknown
  // provider rather than doing the obvious thing.
  const key = process.env.TRANSACTIONAL_EMAIL_PROVIDER?.trim() || 'mock'
  if (key === 'mock') return mock

  if (resolved?.key === key) return resolved.provider

  // Throws for an unknown name, and throws for a known one whose credentials
  // are missing. Named rather than silently falling back: a deployment that
  // thinks it configured a real sender and is actually dropping every password
  // reset into memory is the kind of thing discovered by a support ticket.
  const provider = buildTransactionalProvider(key)
  resolved = { key, provider }
  return provider
}

/**
 * Who transactional mail comes from.
 *
 * Deliberately not the company's own brand kit. A password reset that arrives
 * looking like it came from Ridgeline Construction rather than from the
 * application is one a person cannot distinguish from a phishing attempt made
 * by somebody who knows where they work.
 */
export function transactionalSender(): { fromName: string; fromEmail: string } {
  return {
    fromName: process.env.TRANSACTIONAL_FROM_NAME ?? 'Accountrix Plus',
    fromEmail: process.env.TRANSACTIONAL_FROM_EMAIL ?? 'no-reply@accountrixplus.test',
  }
}

/** Base URL for links in transactional mail. */
export function appBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}
