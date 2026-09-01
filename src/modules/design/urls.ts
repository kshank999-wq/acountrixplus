/**
 * URL safety for author-supplied links (spec §8, §19).
 *
 * Button targets, video links, and QR values all end up somewhere a person or
 * a scanner will follow: an `href` on a public page, or an encoded code on
 * printed collateral. A `javascript:` or `data:` target in either place is a
 * stored-XSS vector, so both are confined to schemes that cannot execute.
 *
 * Shared by the renderer and the QR encoder so the two can never disagree
 * about what counts as safe.
 */

const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i
/** What people actually type when they mean a website. */
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/

/**
 * A link target confined to http(s) and mailto. Anything else becomes `#`.
 *
 * **Normalised through the URL parser since Phase 81.** `BARE_DOMAIN`'s tail is
 * `.*`, so `evil.com/x" onmouseover=` matched it and came back as
 * `https://evil.com/x" onmouseover=` — prefixed rather than refused, and not a
 * URL. Both sinks escape today, so it was never exploitable; but a function
 * whose whole job is to return a safe link target should not return something
 * that is not a link, and the next sink might not escape.
 *
 * The parser percent-encodes what does not belong in a URL, so the quote comes
 * back as `%22` whatever the sink does with it. Anything it cannot parse at all
 * is refused rather than repaired.
 */
export function safeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return '#'

  const candidate = SAFE_SCHEME.test(trimmed)
    ? trimmed
    : BARE_DOMAIN.test(trimmed)
      ? `https://${trimmed}`
      : null

  if (!candidate) return '#'

  try {
    return new URL(candidate).href
  } catch {
    return '#'
  }
}

/**
 * A QR payload.
 *
 * Returns null rather than `#` when the value is unusable — a QR code that
 * scans to nothing is worse than no code at all, so the block is dropped.
 * Plain text is allowed: a QR code carrying a phone number or an address is
 * legitimate, and only URL-shaped values are normalized.
 */
export function safeQrValue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // Long enough to be worth encoding, short enough to stay scannable.
  if (trimmed.length > 1_000) return null

  if (SAFE_SCHEME.test(trimmed) || /^(tel:|sms:|geo:)/i.test(trimmed)) return trimmed
  if (BARE_DOMAIN.test(trimmed)) return `https://${trimmed}`

  // Anything with a scheme we do not recognise is refused; bare text is fine.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  return trimmed
}
