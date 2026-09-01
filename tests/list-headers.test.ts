import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LIST_UNSUBSCRIBE,
  LIST_UNSUBSCRIBE_POST,
  ONE_CLICK,
  isListUnsubscribeUrl,
  listUnsubscribeHeaders,
} from '@/modules/marketing/list-headers'

/**
 * The headers that make a bulk message unsubscribable (Phase 82).
 *
 * `OutboundMessage` carried `unsubscribeUrl` and `unsubscribePostUrl` from
 * Phase 5, and three comments called them headers. No code built one.
 */

const POST_URL = 'https://books.acme.test/api/unsubscribe/abc123'
const PAGE_URL = 'https://books.acme.test/u/abc123'

describe('the header a mail client reads', () => {
  it('names the endpoint, in angle brackets, with the one-click marker', () => {
    expect(listUnsubscribeHeaders({ unsubscribePostUrl: POST_URL })).toEqual({
      [LIST_UNSUBSCRIBE]: `<${POST_URL}>`,
      [LIST_UNSUBSCRIBE_POST]: ONE_CLICK,
    })
  })

  /**
   * The subtler half of the defect. `unsubscribeUrl`'s own doc said it was
   * sent as `List-Unsubscribe` — and RFC 8058 has the client **POST** to that
   * URI, while `/u/:token` is the confirmation page whose entire purpose is
   * not to change state without somebody pressing a button. A client posting
   * there would unsubscribe nobody, and the reader would stay subscribed
   * believing they had left.
   */
  it('is never the confirmation page', () => {
    const headers = listUnsubscribeHeaders({ unsubscribePostUrl: POST_URL })

    expect(headers[LIST_UNSUBSCRIBE]).not.toContain('/u/')
    expect(headers[LIST_UNSUBSCRIBE]).toContain('/api/unsubscribe/')
  })

  it('takes exactly the value RFC 8058 allows, and no other', () => {
    expect(ONE_CLICK).toBe('List-Unsubscribe=One-Click')
  })
})

describe('what may go in the header', () => {
  it('accepts an https endpoint', () => {
    expect(isListUnsubscribeUrl(POST_URL)).toBe(true)
  })

  /**
   * `publicBaseUrl()` is `http://localhost:3000` until `PUBLIC_BASE_URL` is
   * set, so an https-only rule would make the seed and the whole suite throw —
   * a rule about development rather than about email.
   */
  it('accepts localhost over http, because that is not a network hop', () => {
    expect(isListUnsubscribeUrl('http://localhost:3000/api/unsubscribe/abc')).toBe(true)
    expect(isListUnsubscribeUrl('http://127.0.0.1:3000/api/unsubscribe/abc')).toBe(true)
  })

  it('refuses cleartext anywhere else', () => {
    expect(isListUnsubscribeUrl('http://books.acme.test/api/unsubscribe/abc')).toBe(false)
    expect(isListUnsubscribeUrl('http://localhost.evil.test/api/unsubscribe/abc')).toBe(false)
  })

  /** A header is a line. Anything that could end it early ends the guarantee. */
  it('refuses anything that would break or split the header', () => {
    for (const bad of [
      'https://acme.test/a>, <https://evil.test/b',
      'https://acme.test/a\r\nBcc: someone@evil.test',
      'https://acme.test/a\nX-Header: x',
      'https://acme.test/a b',
      'https://acme.test/a,b',
    ]) {
      expect(isListUnsubscribeUrl(bad)).toBe(false)
    }
  })

  it('refuses a scheme that is not http at all', () => {
    expect(isListUnsubscribeUrl('mailto:unsubscribe@acme.test')).toBe(false)
    expect(isListUnsubscribeUrl('javascript:alert(1)')).toBe(false)
    expect(isListUnsubscribeUrl('')).toBe(false)
  })

  /**
   * Throws rather than omitting. A bulk send that quietly loses its
   * unsubscribe header is exactly the failure this module exists to prevent,
   * and it is invisible from the sending end — the mail is filtered, not
   * refused, so nothing comes back.
   */
  it('refuses to build a message it cannot make unsubscribable', () => {
    expect(() =>
      listUnsubscribeHeaders({ unsubscribePostUrl: 'http://books.acme.test/api/unsubscribe/x' }),
    ).toThrow(/https/i)

    expect(() => listUnsubscribeHeaders({ unsubscribePostUrl: PAGE_URL })).not.toThrow()
  })
})

/**
 * The wiring, at both ends. A header nothing attaches and nothing carries
 * would pass every assertion above.
 */
describe('the send path attaches them and the type carries them', () => {
  it('builds them once, in the pipeline, from the POST url', () => {
    const source = readFileSync('src/modules/marketing/campaigns.ts', 'utf8')

    expect(source).toContain('headers: listUnsubscribeHeaders({ unsubscribePostUrl })')
  })

  it('makes every message carry them, so no adapter can forget', () => {
    const source = readFileSync('src/modules/marketing/email-provider.ts', 'utf8')

    // Required, not optional: a `headers?:` would let a second construction
    // site ship without them and typecheck.
    expect(source).toMatch(/^ {2}headers: Record<string, string>$/m)
  })

  /**
   * The transactional channel deliberately has neither field, and must not
   * grow them: an unsubscribe link on a password reset is an offer to stop
   * sending somebody the only mail that can let them back in.
   */
  it('leaves the transactional channel without any of it', () => {
    const source = readFileSync('src/modules/notify/transactional.ts', 'utf8')

    expect(source).not.toContain('listUnsubscribeHeaders')
    expect(source).not.toContain(LIST_UNSUBSCRIBE)
  })
})
