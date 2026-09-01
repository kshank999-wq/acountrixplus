/**
 * The headers that make a bulk message unsubscribable (Phase 82).
 *
 * ## Three comments, and nothing that builds one
 *
 * `OutboundMessage` has carried `unsubscribeUrl` and `unsubscribePostUrl`
 * since Phase 5, and three places say what they are for:
 *
 * > Sent as the `List-Unsubscribe` header too, which is what mail clients
 * > surface as their own unsubscribe button — and what keeps a sender out of
 * > the spam folder.                            — the field's own doc
 *
 * > Every message is kept so a test can assert exactly what would have gone
 * > out — **including the unsubscribe header**.  — `MockEmailProvider`
 *
 * > This is also the target of the `List-Unsubscribe` header, and RFC 8058
 * > specifies exactly this.                      — the POST route
 *
 * No code anywhere built a header from either field. They were two strings on
 * a type, described as headers by prose, and the only provider in the tree
 * pushes the message onto an array. The same shape as Phases 79, 80 and 81: a
 * promise stated in a comment and kept by nothing.
 *
 * It is the promise that decides whether the mail arrives at all. Gmail and
 * Yahoo have required one-click unsubscribe from bulk senders since February
 * 2024; a campaign without these headers is filtered, and the company sending
 * it sees a delivery rate fall with no message saying why.
 *
 * ## And the two comments disagree
 *
 * Worth more than the missing header. The field doc on `unsubscribeUrl` says
 * it is sent as `List-Unsubscribe`. It must not be. RFC 8058 has the mail
 * client **POST** to the URI in that header, and `unsubscribeUrl` is the
 * confirmation *page* — a page whose whole purpose, stated in its own comment,
 * is that it does not change state without a person pressing a button. A
 * client posting to it would unsubscribe nobody, and the reader who pressed
 * their mail client's button would stay subscribed.
 *
 * `unsubscribePostUrl`'s doc has it right: "it must be the endpoint rather
 * than the confirmation page." So the header names the endpoint, and the page
 * stays where it belongs — in the footer of the letter, for a person to click.
 *
 * Nothing here touches the database or the clock.
 */

/** The header a mail client reads, and the one that tells it to POST. */
export const LIST_UNSUBSCRIBE = 'List-Unsubscribe'
export const LIST_UNSUBSCRIBE_POST = 'List-Unsubscribe-Post'

/** RFC 8058 §3.1: the only value this header is allowed to take. */
export const ONE_CLICK = 'List-Unsubscribe=One-Click'

/**
 * Whether a URL can go in a `List-Unsubscribe` header.
 *
 * Two rules, for two different reasons.
 *
 * **No header-breaking characters.** The header is a set of angle-bracketed
 * URIs, so `<`, `>`, a comma or a newline would either be misparsed or split
 * the header outright — the classic injection shape.
 *
 * **`https`, except on localhost.** A one-click POST carries the decision to
 * stop mailing somebody and is not something to send over cleartext. But
 * `publicBaseUrl()` is `http://localhost:3000` until `PUBLIC_BASE_URL` is set,
 * and a rule that made the seed and the whole test suite throw would be a rule
 * about development rather than about email. Localhost is not a network hop.
 */
export function isListUnsubscribeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (/[<>,\r\n\s]/.test(trimmed)) return false

  if (/^https:\/\//i.test(trimmed)) return true
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(trimmed)
}

/**
 * The headers for one outbound bulk message.
 *
 * Returns them rather than setting them, so the send pipeline attaches them
 * once and **every adapter passes them through verbatim** — including one
 * written years from now against an ESP nobody has picked yet. An adapter that
 * has to rediscover RFC 8058 is an adapter that will ship without it.
 *
 * Throws rather than omitting on a URL that cannot be put in a header: a bulk
 * send that quietly loses its unsubscribe header is the failure this whole
 * module exists to prevent, and it is invisible from the sending end.
 */
export function listUnsubscribeHeaders(input: {
  /** The RFC 8058 one-click target. **Not** the confirmation page. */
  unsubscribePostUrl: string
}): Record<string, string> {
  if (!isListUnsubscribeUrl(input.unsubscribePostUrl)) {
    throw new Error(
      'unsubscribePostUrl must be an https URL (or a localhost one in development) ' +
        `with no header-breaking characters: ${input.unsubscribePostUrl}`,
    )
  }

  return {
    [LIST_UNSUBSCRIBE]: `<${input.unsubscribePostUrl}>`,
    [LIST_UNSUBSCRIBE_POST]: ONE_CLICK,
  }
}
