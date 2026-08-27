import type { TransactionalMessage, TransactionalProvider, TransactionalResult } from '../transactional'
import { addressLine, errorMessage, failed, postJson, requiredEnv, retryableStatus } from './http'

/**
 * Postmark (spec §19).
 *
 * The second adapter, and the reason there are two. Postmark disagrees with
 * the conventional shape in ways that would have been invisible with only one
 * implementation to write against:
 *
 *  - It answers **200 with an `ErrorCode`** for some rejections, so the status
 *    line alone does not tell you whether the mail was accepted.
 *  - It uses a **header token** rather than a bearer, and **capitalised** body
 *    fields.
 *  - It wants a **message stream**, and sending transactional mail down a
 *    broadcast stream is a deliverability mistake rather than an error.
 *
 * An interface with a single implementation is a guess about what varies. This
 * is the evidence.
 */
export class PostmarkProvider implements TransactionalProvider {
  readonly key = 'postmark'

  private readonly token: string
  private readonly endpoint: string
  private readonly stream: string

  constructor(options: { token?: string; endpoint?: string; stream?: string } = {}) {
    this.token = options.token ?? requiredEnv('POSTMARK_SERVER_TOKEN', 'postmark')
    this.endpoint = options.endpoint ?? 'https://api.postmarkapp.com/email'
    // Postmark separates transactional from broadcast streams and applies
    // different reputation handling to each. A password reset belongs in the
    // transactional one, which is what "outbound" is by default.
    this.stream = options.stream ?? process.env.POSTMARK_MESSAGE_STREAM?.trim() ?? 'outbound'
  }

  async send(message: TransactionalMessage): Promise<TransactionalResult> {
    const result = await postJson(
      this.endpoint,
      { 'x-postmark-server-token': this.token },
      {
        From: addressLine(message.fromName, message.fromEmail),
        To: addressLine(message.toName, message.to),
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
        MessageStream: this.stream,
        /*
         * Postmark's own categorisation, set to what the message is rather
         * than who it is for, for the reason given in the Resend adapter.
         */
        Tag: message.kind,
      },
    )

    if (!result.ok) return failed(result.error, result.retryable)

    const { answer } = result
    const body = (answer.body ?? {}) as { ErrorCode?: unknown; Message?: unknown; MessageID?: unknown }

    if (answer.status < 200 || answer.status >= 300) {
      return failed(
        `Postmark refused the message (${answer.status}): ${errorMessage(answer, ['Message'])}`,
        retryableStatus(answer.status),
      )
    }

    /*
     * The case the status line hides. A 200 with a non-zero ErrorCode is a
     * rejection — an inactive recipient, a sending address that is not
     * verified — and treating 200 as success would record a send that never
     * happened.
     */
    if (typeof body.ErrorCode === 'number' && body.ErrorCode !== 0) {
      return failed(
        `Postmark refused the message (code ${body.ErrorCode}): ${errorMessage(answer, ['Message'])}`,
        // 429 is Postmark's rate-limit code and the only one worth repeating.
        // The rest describe the message or the account, and will say the same
        // thing tomorrow.
        body.ErrorCode === 429,
      )
    }

    const id = body.MessageID
    if (typeof id !== 'string' || !id) {
      return failed('Postmark accepted the message but returned no id.', true)
    }

    return { ok: true, providerMessageId: id }
  }
}
