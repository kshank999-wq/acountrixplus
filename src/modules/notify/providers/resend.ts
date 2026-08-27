import type { TransactionalMessage, TransactionalProvider, TransactionalResult } from '../transactional'
import { addressLine, errorMessage, failed, postJson, requiredEnv, retryableStatus } from './http'

/**
 * Resend (spec §19).
 *
 * Chosen as one of the two shipped adapters because its failure shape is the
 * conventional one — a non-2xx status with a JSON body — which makes it the
 * useful contrast to Postmark, whose success can carry an error.
 */
export class ResendProvider implements TransactionalProvider {
  readonly key = 'resend'

  private readonly apiKey: string
  private readonly endpoint: string

  constructor(options: { apiKey?: string; endpoint?: string } = {}) {
    this.apiKey = options.apiKey ?? requiredEnv('RESEND_API_KEY', 'resend')
    this.endpoint = options.endpoint ?? 'https://api.resend.com/emails'
  }

  async send(message: TransactionalMessage): Promise<TransactionalResult> {
    const result = await postJson(
      this.endpoint,
      { authorization: `Bearer ${this.apiKey}` },
      {
        from: addressLine(message.fromName, message.fromEmail),
        to: [addressLine(message.toName, message.to)],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        /*
         * Tagged with what the message is, never who it is for. A provider
         * dashboard is a place to see that password resets are failing; it is
         * not somewhere a customer list belongs.
         */
        tags: [{ name: 'kind', value: message.kind }],
      },
    )

    if (!result.ok) return failed(result.error, result.retryable)

    const { answer } = result
    if (answer.status < 200 || answer.status >= 300) {
      return failed(
        `Resend refused the message (${answer.status}): ${errorMessage(answer, ['message', 'name'])}`,
        retryableStatus(answer.status),
      )
    }

    const id = (answer.body as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) {
      // Accepted but unidentifiable. Treated as a failure rather than
      // inventing an id: a message id nobody can look up is worse than an
      // honest gap, and this is retryable because a duplicate reset link is a
      // smaller problem than none.
      return failed('Resend accepted the message but returned no id.', true)
    }

    return { ok: true, providerMessageId: id }
  }
}
