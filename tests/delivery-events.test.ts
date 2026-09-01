import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  advanceStatus,
  outcomeFor,
  type RecipientStatus,
} from '@/modules/marketing/delivery-events'
import { recordDeliveryEvent } from '@/modules/marketing/delivery'
import { mockEmailProvider } from '@/modules/marketing/email-provider'

/**
 * What a delivery callback means (Phase 83).
 *
 * `sendStep` called a refused API call a bounce and put the provider's error
 * into `skipReason`. A real bounce — the receiving server rejecting a message
 * the provider accepted — had no path into this application at all, though the
 * schema had been storing `provider_message_id` "for reconciling delivery
 * webhooks later" since Phase 5.
 */

describe('what an outcome means for the address', () => {
  it('suppresses on a hard bounce, because the mailbox does not exist', () => {
    expect(outcomeFor({ kind: 'bounced', bounce: 'hard' })).toEqual({
      status: 'bounced',
      event: 'bounce',
      suppress: 'bounce',
    })
  })

  /**
   * The judgement this core exists to make. A full mailbox is temporary, and
   * suppressing on it silences a real customer for a bad afternoon — worse
   * than one wasted send.
   */
  it('records a soft bounce and leaves the address alone', () => {
    expect(outcomeFor({ kind: 'bounced', bounce: 'soft' })).toMatchObject({
      status: 'bounced',
      suppress: null,
    })
  })

  it('treats a bounce a provider will not classify as soft', () => {
    expect(outcomeFor({ kind: 'bounced' }).suppress).toBeNull()
  })

  it('always suppresses a complaint', () => {
    expect(outcomeFor({ kind: 'complained' })).toEqual({
      status: 'complained',
      event: 'complaint',
      suppress: 'complaint',
    })
  })

  it('does nothing to the address on a delivery', () => {
    expect(outcomeFor({ kind: 'delivered' })).toEqual({
      status: 'delivered',
      event: 'delivered',
      suppress: null,
    })
  })
})

/**
 * Webhooks arrive out of order. A `delivered` landing after a click is one slow
 * hop, not a regression, and a row that churns on every provider retry is a row
 * whose history is noise.
 */
describe('a late callback does not rewind what is already known', () => {
  it('moves a recipient forward through the engagement story', () => {
    expect(advanceStatus('sent', 'delivered')).toBe('delivered')
    expect(advanceStatus('pending', 'delivered')).toBe('delivered')
  })

  it('refuses to move one backwards', () => {
    expect(advanceStatus('clicked', 'delivered')).toBeNull()
    expect(advanceStatus('opened', 'delivered')).toBeNull()
  })

  it('says nothing changed when the status is already right', () => {
    expect(advanceStatus('delivered', 'delivered')).toBeNull()
  })

  /**
   * A complaint after a click is not a regression — it is somebody who read the
   * message and objected, which is the more important fact.
   */
  it('lets a fact about the address beat any engagement step', () => {
    expect(advanceStatus('clicked', 'complained')).toBe('complained')
    expect(advanceStatus('opened', 'bounced')).toBe('bounced')
  })

  it('never moves one off a terminal fact', () => {
    for (const terminal of ['bounced', 'complained', 'unsubscribed', 'skipped', 'failed']) {
      expect(advanceStatus(terminal as RecipientStatus, 'delivered')).toBeNull()
    }
  })
})

describe('translating a provider callback', () => {
  it('reads the shape an adapter is expected to produce', () => {
    const parsed = mockEmailProvider().parseDeliveryEvents([
      { type: 'bounced', bounce: 'hard', messageId: 'mock-1' },
      { type: 'complained', recipientId: 'r-2' },
      { type: 'delivered', messageId: 'mock-3' },
    ])

    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      providerMessageId: 'mock-1',
      recipientId: null,
      event: { kind: 'bounced', bounce: 'hard' },
    })
    expect(parsed[1].recipientId).toBe('r-2')
  })

  it('drops anything it does not recognise rather than guessing', () => {
    expect(mockEmailProvider().parseDeliveryEvents([{ type: 'nonsense' }, null, 7])).toEqual([])
    expect(mockEmailProvider().parseDeliveryEvents('not an object')).toEqual([])
  })
})

/**
 * The endpoint is the fifth entry point that carries no session, and the only
 * one not reached from a link in an email.
 */
describe('the callback endpoint', () => {
  const source = readFileSync('src/app/api/email/events/route.ts', 'utf8')

  it('refuses everything when no secret is configured', () => {
    expect(source).toContain('if (!secret) return false')
  })

  it('compares the bearer token in constant time', () => {
    expect(source).toContain('timingSafeEqual')
  })

  /** A provider that gets errors back turns the webhook off. */
  it('answers 200 even when nothing matched', () => {
    expect(source).toContain('NextResponse.json({ ok: true, recorded, unknown })')
  })
})

describe('recording what the provider said', () => {
  it('is quiet about a message it has never heard of', async () => {
    await expect(
      recordDeliveryEvent({
        providerMessageId: 'mock-nothing',
        event: { kind: 'bounced', bounce: 'hard' },
      }),
    ).resolves.toEqual({ ok: false, reason: 'unknown_message' })
  })
})

/**
 * The distinction the whole phase is about, asserted where a real send makes
 * it: `sendStep` used to call this a bounce.
 */
describe('a provider that will not take the message', () => {
  it('is a send failure rather than a bounce, and does not suppress', async () => {
    const source = readFileSync('src/modules/marketing/campaigns.ts', 'utf8')

    expect(source).toContain("status: 'failed', failureReason: result.error")
    expect(source).not.toContain("status: 'bounced', skipReason: result.error")
  })

  it('leaves skipReason for the question it answers', () => {
    const schema = readFileSync('src/db/schema/marketing.ts', 'utf8')

    expect(schema).toContain("failureReason: text('failure_reason')")
    expect(schema).toContain(
      '/** Why a recipient was skipped: "no_consent", "suppressed", "no_email". */',
    )
  })
})
