import { sign, signatureMatches } from '@/lib/signing'

/**
 * Tracked links, and the destination they are allowed to reach (Phase 81).
 *
 * ## The open redirect three comments said was not one
 *
 * Every link in a campaign email is rewritten to `/api/track/:token?u=<url>`
 * so a click is recorded. The destination arrives from the query string, and
 * `recordClick` put it through `safeUrl` before following it — under three
 * separate assurances that this closed an open redirect:
 *
 * > an attacker who forges a tracking link must not be able to turn it into an
 * > open redirect to a phishing page                       — `engagement.ts`
 *
 * > a tracking link must never become an open redirect just because the token
 * > did not resolve                                          — the route
 *
 * > re-validates the click destination, so a forged link is not an open
 * > redirect                                    — the name of the test for it
 *
 * `safeUrl` confines a link to `http(s)` and `mailto`. That stops a
 * `javascript:` target, which is stored XSS — a real and different problem. It
 * says nothing whatsoever about **which** https destination, and an open
 * redirect is entirely a question of which. `?u=https://phishing.test` passed
 * all three.
 *
 * The test is the clearest evidence: it asserts that `javascript:alert(1)` is
 * refused and `https://example.com/read` is accepted, and calls that
 * open-redirect safety. Scheme safety was being read as destination safety.
 *
 * The token needed is a recipient's, which is in the URL of every link in
 * every campaign email that recipient received — so anybody on a company's
 * mailing list could mint a link that begins with that company's real domain
 * and ends anywhere.
 *
 * ## What decides it now
 *
 * The destination is signed when the link is built and verified when it is
 * followed. A URL nobody sent is a URL nobody signed, and the redirect does
 * not happen. Stateless, so no lookup joins the click path, and exact, so a
 * destination carrying merge fields resolved per recipient still verifies —
 * it is signed after resolution, as the thing actually put in the letter.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * Domain separation, so a click signature cannot be presented as a session
 * cookie or an MFA challenge.
 */
const PURPOSE = 'click-destination'

/** The parameter names, so the builder and the reader cannot disagree. */
export const DESTINATION_PARAM = 'u'
export const SIGNATURE_PARAM = 's'

/**
 * The signature this application would mint for one destination.
 *
 * The whole digest. An earlier draft truncated it to save characters in a link
 * a mail client might wrap — and `signatureMatches` compares against the full
 * one, so nothing verified at all. A shortened signature is a second answer to
 * how long a signature is, and the saving was sixteen characters.
 */
export function signDestination(url: string): string {
  return sign(url, PURPOSE)
}

/**
 * Whether a destination is one this application actually sent.
 *
 * Constant-time, and false for a missing signature rather than throwing — a
 * link from an email delivered before Phase 81 carries none, and the right
 * answer for it is the same as for a forged one.
 */
export function destinationWasSent(url: string, signature: string | null): boolean {
  if (!signature) return false
  return signatureMatches(url, signature, PURPOSE)
}

/**
 * The link that goes in the letter.
 *
 * `trackUrl` is the recipient's own `/api/track/:token`. The destination is
 * encoded rather than appended raw, because a destination with its own query
 * string would otherwise merge into this one.
 */
export function trackedLink(trackUrl: string, url: string): string {
  const parameters = new URLSearchParams({
    [DESTINATION_PARAM]: url,
    [SIGNATURE_PARAM]: signDestination(url),
  })

  return `${trackUrl}?${parameters.toString()}`
}
