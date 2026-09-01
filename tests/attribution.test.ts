import { describe, expect, it } from 'vitest'
import {
  culpritPhrase,
  worstOffender,
  type CampaignSending,
} from '@/modules/marketing/attribution'
import { MIN_VOLUME, wasAccepted } from '@/modules/marketing/reputation'

/**
 * Which send put the domain in trouble (Phase 85).
 *
 * Phase 84's verdict is company-wide and the cause almost never is. The
 * judgement being tested here is that a culprit is a *counterfactual* — would
 * we still be over the line without this send — and not simply the worst rate
 * in the window, which will usually belong to the smallest campaign in it.
 */

function campaign(
  name: string,
  accepted: number,
  bounced: number,
  complained = 0,
): CampaignSending {
  return { campaignId: `id-${name}`, name, accepted, bounced, complained }
}

describe('nothing to attribute', () => {
  it('says nothing when the company is fine', () => {
    const counts = { accepted: 2_000, bounced: 4, complained: 0 }

    expect(worstOffender(counts, [campaign('Newsletter', 2_000, 4)])).toBeNull()
  })

  /** Below the floor there is no verdict to explain. */
  it('says nothing when there is not enough volume for a verdict', () => {
    const counts = { accepted: MIN_VOLUME - 1, bounced: 40, complained: 0 }

    expect(worstOffender(counts, [campaign('Tiny', MIN_VOLUME - 1, 40)])).toBeNull()
  })

  it('says nothing when there are no campaigns to blame', () => {
    expect(worstOffender({ accepted: 1_000, bounced: 60, complained: 0 }, [])).toBeNull()
  })
})

describe('a culprit is a counterfactual, not a maximum', () => {
  /**
   * The whole point. The worst *rate* in a window usually belongs to the
   * smallest campaign in it — three bounces out of eight is 37% and moves a
   * four-thousand-message week by nothing at all.
   */
  it('does not name the tiny campaign with the terrible rate', () => {
    const counts = { accepted: 2_008, bounced: 123, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Cold list', 1_000, 120), // 12% — 1.2 points of the 6.1% total
      campaign('Newsletter', 1_000, 0),
      campaign('Tiny test', 8, 3), // 37.5% and utterly irrelevant
    ])!

    expect(culprit.name).toBe('Cold list')
  })

  it('names the send that, removed, brings the rest back under the line', () => {
    const counts = { accepted: 2_000, bounced: 110, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Conference badges', 1_000, 100), // 10%
      campaign('Newsletter', 1_000, 10), // 1%
    ])!

    expect(culprit.name).toBe('Conference badges')
    expect(culprit.bounceRateBp).toBe(1_000)
    expect(culprit.withoutItBounceRateBp).toBe(100)
    expect(culprit.explainsIt).toBe(true)
  })

  /**
   * A campaign can be the largest single contributor and still not the story.
   * Telling somebody to stop one send when the list is broadly rotten is worse
   * than telling them nothing.
   */
  it('admits when the worst offender is not the whole story', () => {
    const counts = { accepted: 2_000, bounced: 140, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Cold list', 1_000, 100), // 10%
      campaign('Newsletter', 1_000, 40), // 4% — still over the watch line
    ])!

    expect(culprit.name).toBe('Cold list')
    expect(culprit.explainsIt).toBe(false)
    expect(culprit.withoutItBounceRateBp).toBe(400)
  })
})

describe('when there is no culprit', () => {
  /**
   * A uniformly bad list has no culprit. The biggest campaign in it is the
   * biggest campaign, not the cause, and a name is a claim.
   */
  it('names nobody when every campaign is the same', () => {
    const counts = { accepted: 3_000, bounced: 180, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('One', 1_000, 60),
      campaign('Two', 1_000, 60),
      campaign('Three', 1_000, 60),
    ])

    expect(culprit).toBeNull()
  })

  /**
   * Found by a browser check, not by this file. Being worse than the company's
   * own rate is a weak bar: two equally bad campaigns plus a little clean
   * traffic makes *both* of them worse than the average they are pulling up,
   * so one always got named — and removing it moved the rate from 11.9% to
   * 11.8%. Naming a campaign says "stop this and it gets better".
   */
  it('names nobody when stopping one would barely help', () => {
    const counts = { accepted: 403, bounced: 48, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Conference badges', 200, 24), // 12%
      campaign('Newsletter', 200, 24), // 12%
      campaign('Still worth a conversation', 1, 0),
      campaign('Year-end planning note', 2, 0),
    ])

    // Both are fractionally above the 11.9% average and neither is the cause.
    expect(culprit).toBeNull()
  })

  it('still names one when stopping it would genuinely help', () => {
    const counts = { accepted: 403, bounced: 26, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Conference badges', 200, 24), // 12%
      campaign('Newsletter', 200, 2), // 1%
      campaign('Year-end planning note', 3, 0),
    ])!

    // 6.5% down to 1.0% is worth telling somebody about.
    expect(culprit.name).toBe('Conference badges')
    expect(culprit.explainsIt).toBe(true)
  })

  it('never names a campaign better than the company average', () => {
    const counts = { accepted: 2_000, bounced: 120, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('Cold list', 1_500, 118),
      campaign('Newsletter', 500, 2),
    ])!

    expect(culprit.name).toBe('Cold list')
  })

  it('ignores a campaign nothing was accepted for', () => {
    const counts = { accepted: 1_000, bounced: 60, complained: 0 }
    const culprit = worstOffender(counts, [
      campaign('All skipped', 0, 0),
      campaign('Cold list', 1_000, 60),
    ])

    // The only real campaign *is* the company, so it cannot be worse than it.
    expect(culprit).toBeNull()
  })
})

describe('complaints and bounces are not the same size of problem', () => {
  /**
   * A tenth of a per cent of complaints is as serious as two per cent of
   * bounces. Ranking on raw basis points would let a small bounce movement
   * outvote a large complaint one every time.
   */
  it('weighs each against its own threshold', () => {
    const counts = { accepted: 2_000, bounced: 50, complained: 8 }
    const culprit = worstOffender(counts, [
      // 4% bounces: two watch-widths of bounce movement.
      campaign('Bouncy', 1_000, 40, 0),
      // 0.8% complaints: eight watch-widths of complaint movement.
      campaign('Unwanted', 1_000, 10, 8),
    ])!

    expect(culprit.name).toBe('Unwanted')
    expect(culprit.complaintRateBp).toBe(80)
  })
})

describe('what it says out loud', () => {
  it('says nothing about nobody', () => {
    expect(culpritPhrase(null)).toBeNull()
  })

  it('leads with the campaign when it explains the whole thing', () => {
    const culprit = worstOffender({ accepted: 2_000, bounced: 110, complained: 0 }, [
      campaign('Conference badges', 1_000, 100),
      campaign('Newsletter', 1_000, 10),
    ])

    expect(culpritPhrase(culprit)).toBe(
      'Mostly "Conference badges" — 10.0% of it bounced, and without it the rest is fine',
    )
  })

  it('hedges when it does not', () => {
    const culprit = worstOffender({ accepted: 2_000, bounced: 140, complained: 0 }, [
      campaign('Cold list', 1_000, 100),
      campaign('Newsletter', 1_000, 40),
    ])

    expect(culpritPhrase(culprit)).toBe(
      'Worst is "Cold list" — 10.0% of it bounced, though it is not the whole story',
    )
  })

  it('names the spam complaint when that is the worse half', () => {
    const culprit = worstOffender({ accepted: 2_000, bounced: 50, complained: 8 }, [
      campaign('Bouncy', 1_000, 40, 0),
      campaign('Unwanted', 1_000, 10, 8),
    ])

    expect(culpritPhrase(culprit)).toContain('0.8% marked it as spam')
  })
})

/**
 * The defect found while building the attribution query: three definitions of
 * "what did we send", in one file, disagreeing.
 *
 * The rule itself is here; that the three queries actually agree is asserted
 * against real rows in `marketing.test.ts`, where a fixture with one recipient
 * of every status can be counted three ways and compared. A grep of the source
 * would pass on a comment.
 */
describe('one definition of what a provider accepted', () => {
  it('counts a bounce as sent and a send failure as not', () => {
    // A bounce was accepted and then rejected downstream, so it belongs in the
    // denominator — a bounce rate computed against sends that excluded the
    // bounces flatters itself by exactly the thing being measured. A `failed`
    // row never reached a provider at all.
    expect(wasAccepted('bounced')).toBe(true)
    expect(wasAccepted('complained')).toBe(true)
    expect(wasAccepted('failed')).toBe(false)
    expect(wasAccepted('skipped')).toBe(false)
    expect(wasAccepted('pending')).toBe(false)
  })

  /**
   * An allow-list, so a status added to the enum and forgotten here falls out
   * of the denominator and makes every rate look worse than it is. The
   * deny-list it replaced failed the other way — quietly enlarging the
   * denominator and hiding a real problem — and Phase 84 exists because the
   * missed alarm is the expensive mistake.
   */
  it('does not accept a status it has never heard of', () => {
    expect(wasAccepted('quarantined')).toBe(false)
  })
})
