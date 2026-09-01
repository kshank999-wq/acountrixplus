import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DESTINATION_PARAM,
  SIGNATURE_PARAM,
  destinationWasSent,
  signDestination,
  trackedLink,
} from '@/modules/marketing/click-links'
import { sign, signatureMatches, signingSecret } from '@/lib/signing'
import { safeUrl } from '@/modules/design/urls'

/**
 * The open redirect three comments said was not one (Phase 81).
 *
 * `recordClick` put the destination through `safeUrl` and called that
 * open-redirect safety. `safeUrl` confines a link to `http(s)` and `mailto` —
 * which stops a `javascript:` target, and says nothing about *which* https
 * destination, which is the entire question.
 */

const SENT = 'https://example.com/spring-offer'
const PHISHING = 'https://phishing.test/sign-in'
const TRACK = 'https://books.acme.test/api/track/abc123'

describe('a destination this application actually sent', () => {
  it('verifies the link it built', () => {
    const link = trackedLink(TRACK, SENT)
    const url = new URL(link)

    expect(url.searchParams.get(DESTINATION_PARAM)).toBe(SENT)
    expect(
      destinationWasSent(
        url.searchParams.get(DESTINATION_PARAM)!,
        url.searchParams.get(SIGNATURE_PARAM),
      ),
    ).toBe(true)
  })

  /**
   * The one that matters. Every assurance the old code gave was true of this
   * URL: it is `https`, it parses, `safeUrl` returns it unchanged.
   */
  it('refuses a destination nobody signed, however safe its scheme', () => {
    expect(safeUrl(PHISHING)).toBe(PHISHING)
    expect(destinationWasSent(PHISHING, null)).toBe(false)
    expect(destinationWasSent(PHISHING, signDestination(SENT))).toBe(false)
  })

  it('refuses a signature for a different destination, and a truncated one', () => {
    const signature = signDestination(SENT)

    expect(destinationWasSent(SENT, signature)).toBe(true)
    expect(destinationWasSent(`${SENT}?extra=1`, signature)).toBe(false)
    expect(destinationWasSent(SENT, signature.slice(0, -1))).toBe(false)
    expect(destinationWasSent(SENT, '')).toBe(false)
  })

  /**
   * A link in an email delivered before this phase carries no `s` at all. It
   * gets the same answer as a forged one, which is the cost of closing this.
   */
  it('refuses a link from before the signature existed', () => {
    const old = `${TRACK}?u=${encodeURIComponent(SENT)}`
    const url = new URL(old)

    expect(url.searchParams.get(SIGNATURE_PARAM)).toBeNull()
    expect(destinationWasSent(SENT, url.searchParams.get(SIGNATURE_PARAM))).toBe(false)
  })

  it('carries a destination with its own query string without merging the two', () => {
    const destination = 'https://example.com/book?ref=spring&utm_source=email'
    const url = new URL(trackedLink(TRACK, destination))

    expect(url.searchParams.get(DESTINATION_PARAM)).toBe(destination)
    expect(destinationWasSent(destination, url.searchParams.get(SIGNATURE_PARAM))).toBe(true)
  })

  /**
   * The link is signed after `safeUrl` has run, and `recordClick` runs
   * `safeUrl` again on what comes back. The two only agree because it is
   * idempotent, so that is asserted rather than assumed.
   */
  it('survives the round trip through safeUrl', () => {
    for (const value of [SENT, 'https://example.com/a b', 'example.com/book']) {
      const once = safeUrl(value)
      expect(safeUrl(once)).toBe(once)
      expect(destinationWasSent(once, signDestination(once))).toBe(true)
    }
  })
})

describe('the signing secret', () => {
  /**
   * The session cookie signs with the bare secret and must keep doing so —
   * a suffix would invalidate every cookie in a browser, and a refactor is not
   * a logout.
   */
  it('is unsuffixed for the session cookie and separated for everything else', () => {
    expect(signingSecret()).not.toContain(':')
    expect(signingSecret('mfa-challenge')).toBe(`${signingSecret()}:mfa-challenge`)
    expect(signingSecret('click-destination')).not.toBe(signingSecret('mfa-challenge'))
  })

  it('will not let one purpose’s signature be presented as another’s', () => {
    const payload = 'the-same-bytes'

    expect(signatureMatches(payload, sign(payload, 'mfa-challenge'), 'mfa-challenge')).toBe(true)
    expect(signatureMatches(payload, sign(payload, 'mfa-challenge'), 'click-destination')).toBe(
      false,
    )
    expect(signatureMatches(payload, sign(payload), 'mfa-challenge')).toBe(false)
  })

  it('refuses a signature of the wrong length rather than throwing', () => {
    expect(signatureMatches('x', 'short')).toBe(false)
    expect(signatureMatches('x', '')).toBe(false)
  })

  /**
   * Three modules read `SESSION_SECRET` the same way and a fourth was about to.
   * `secret-box` is deliberately not among them — it reads `ENCRYPTION_KEY`,
   * because an encryption key and a signing key should not be one value.
   */
  it('is read in one place now', () => {
    for (const file of [
      'src/modules/auth/session.ts',
      'src/modules/auth/challenge.ts',
      'src/modules/marketing/click-links.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('process.env.SESSION_SECRET')
    }

    expect(readFileSync('src/modules/auth/secret-box.ts', 'utf8')).toContain(
      'process.env.ENCRYPTION_KEY',
    )
  })
})

/**
 * `BARE_DOMAIN`'s tail is `.*`, so anything after the first `/` was accepted
 * whole and prefixed. Both sinks escape today — React for the document page,
 * `escapeHtml` for the email — so this was never exploitable; but a function
 * that returns a link target should return a link.
 */
describe('safeUrl returns something that is a URL', () => {
  it('percent-encodes what cannot appear in one', () => {
    expect(safeUrl('evil.com/x" onmouseover="alert(1)')).toBe(
      'https://evil.com/x%22%20onmouseover=%22alert(1)',
    )
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b')
  })

  it('refuses what the parser cannot make sense of at all', () => {
    expect(safeUrl('https://exa mple.com')).toBe('#')
    expect(safeUrl('https://')).toBe('#')
  })

  it('still refuses the schemes it always refused', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
    expect(safeUrl('data:text/html,<script>')).toBe('#')
    expect(safeUrl('  JavaScript:alert(1)')).toBe('#')
  })

  it('leaves an ordinary link alone', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeUrl('mailto:a@b.test')).toBe('mailto:a@b.test')
    expect(safeUrl('example.com/book')).toBe('https://example.com/book')
  })
})

/**
 * The wiring, asserted at the two ends rather than only in the middle: a
 * signature nothing mints and nothing checks would pass every test above.
 */
describe('the send path signs and the click path verifies', () => {
  it('builds every tracked link through the signer', () => {
    const source = readFileSync('src/modules/marketing/campaigns.ts', 'utf8')

    expect(source).toContain('trackedLink(trackUrl, url)')
    expect(source).not.toContain('?u=${encodeURIComponent(url)}')
  })

  it('reads the signature off the request and hands it to the recorder', () => {
    const source = readFileSync('src/app/api/track/[token]/route.ts', 'utf8')

    expect(source).toContain('searchParams.get(SIGNATURE_PARAM)')
    expect(source).toContain('recordClick(token, destination, signature, meta)')
  })

  it('checks it before deciding where to send the reader', () => {
    const source = readFileSync('src/modules/marketing/engagement.ts', 'utf8')

    expect(source).toContain('if (!destinationWasSent(rawUrl, signature)) return { ok: false }')
  })
})
