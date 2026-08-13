import { randomUUID } from 'node:crypto'

/**
 * Email delivery (spec §10: "should use a dedicated email delivery provider").
 *
 * The same abstraction shape as the bank provider and the asset store: the
 * marketing domain talks only to this interface, so adopting a real ESP means
 * writing one adapter and changing an environment variable.
 *
 * No adapter is ever asked to decide *whether* someone may be emailed. Consent
 * and suppression are enforced in the send pipeline before a message reaches a
 * provider, so a misconfigured adapter cannot become a compliance failure.
 */

export type OutboundMessage = {
  to: string
  fromName: string
  fromEmail: string
  replyTo?: string | null
  subject: string
  html: string
  text: string
  /**
   * The page a person lands on from the footer link. Sent as the
   * `List-Unsubscribe` header too, which is what mail clients surface as their
   * own unsubscribe button — and what keeps a sender out of the spam folder.
   */
  unsubscribeUrl: string
  /**
   * The RFC 8058 one-click target, paired with
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A mail client POSTs
   * here on the reader's behalf, so it must be the endpoint rather than the
   * confirmation page.
   */
  unsubscribePostUrl: string
  /** Correlates a provider callback back to a recipient row. */
  tags?: Record<string, string>
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean }

export interface EmailProvider {
  readonly key: string
  send(message: OutboundMessage): Promise<SendResult>
}

/**
 * Records messages in memory instead of sending them.
 *
 * The default, so the demo and the tests run with no credentials and no risk
 * of a real send. Every message is kept so a test can assert exactly what
 * would have gone out — including the unsubscribe header.
 */
export class MockEmailProvider implements EmailProvider {
  readonly key = 'mock'
  readonly sent: OutboundMessage[] = []

  /** Addresses that should fail, for exercising the bounce path. */
  private failing = new Set<string>()

  failFor(email: string): void {
    this.failing.add(email.toLowerCase())
  }

  reset(): void {
    this.sent.length = 0
    this.failing.clear()
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.failing.has(message.to.toLowerCase())) {
      return { ok: false, error: 'Mailbox unavailable', retryable: false }
    }

    this.sent.push(message)
    return { ok: true, providerMessageId: `mock-${randomUUID()}` }
  }
}

const providers = new Map<string, EmailProvider>()

export function registerEmailProvider(provider: EmailProvider): void {
  providers.set(provider.key, provider)
}

const mockProvider = new MockEmailProvider()
registerEmailProvider(mockProvider)

/** The shared mock instance, so tests can inspect what was sent. */
export function mockEmailProvider(): MockEmailProvider {
  return mockProvider
}

export function getEmailProvider(key?: string): EmailProvider {
  const resolved = key ?? process.env.EMAIL_PROVIDER ?? 'mock'
  const provider = providers.get(resolved)

  if (!provider) {
    throw new Error(
      `Unknown email provider "${resolved}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }
  return provider
}

/**
 * Base URL for links inside a sent email.
 *
 * Unlike an in-app link, an email link cannot be relative — it is opened days
 * later from a different origin — so this must be configured before a real
 * send. The development fallback keeps the demo working.
 */
export function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
}
