import { describe, expect, it } from 'vitest'
import {
  DETAIL_LIMIT,
  OUTCOMES,
  SWITCHED_OFF,
  bodyFor,
  decisionFor,
  explain,
  isSilence,
  truncateDetail,
  type Channel,
  type DecisionInput,
  type Outcome,
} from '@/modules/mobile/decision'

/**
 * The notification decision core (Phase 90).
 *
 * The properties worth holding are about what the log is *for*: it answers
 * "why did I not get told about that", so every way of not being told has to be
 * distinguishable, and no row may exist that the question cannot be asked of.
 */

const COMPANY = '11111111-1111-4111-8111-111111111111'
const PRACTICE = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

function pushInput(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    audience: { kind: 'company', companyId: COMPANY },
    userId: USER,
    topic: 'invoice_paid',
    channel: 'push',
    outcome: 'sent',
    title: 'Kestrel Joinery paid £1,200.00',
    body: 'Invoice INV-0042.',
    url: '/accounting',
    provider: 'mock',
    ...over,
  }
}

function mailInput(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    audience: { kind: 'practice', practiceId: PRACTICE },
    userId: USER,
    topic: 'practice_brief',
    channel: 'mail',
    outcome: 'sent',
    title: 'Two clients need a look',
    provider: 'mail',
    ...over,
  }
}

describe('decisionFor: the audience', () => {
  it('files a company topic under the company, with no practice', () => {
    const row = decisionFor(pushInput())
    expect(row.companyId).toBe(COMPANY)
    expect(row.practiceId).toBeNull()
  })

  it('files a practice topic under the practice, with no company', () => {
    const row = decisionFor(mailInput())
    expect(row.practiceId).toBe(PRACTICE)
    // The whole reason the column had to become nullable: a firm's brief is
    // about no single client, and naming one would put it on that client's
    // record.
    expect(row.companyId).toBeNull()
  })

  it('refuses a company topic filed against a practice', () => {
    // A row nothing will ever find is worse than no row: somebody reading their
    // company history would not see it, and nobody reads the firm's.
    expect(() =>
      decisionFor(pushInput({ audience: { kind: 'practice', practiceId: PRACTICE } })),
    ).toThrow(/company topic/)
  })

  it('refuses the firm brief filed against a company', () => {
    expect(() =>
      decisionFor(mailInput({ audience: { kind: 'company', companyId: COMPANY } })),
    ).toThrow(/practice topic/)
  })
})

describe('decisionFor: the body is stored only when nothing else stores it', () => {
  it('keeps a push body, which exists nowhere else', () => {
    expect(decisionFor(pushInput()).body).toBe('Invoice INV-0042.')
  })

  it('discards a mail body, which is already in transactional_messages', () => {
    // Two copies of one text is the defect: an edit to the wording fixes one
    // and leaves the other lying.
    const row = decisionFor(mailInput({ body: 'Ridgeline Construction, Kestrel Joinery.' }))
    expect(row.body).toBeNull()
  })

  it('records the channel, so a null body is not ambiguous', () => {
    // Without this a reader cannot tell "the text is in the other table" from
    // "there was no text".
    expect(decisionFor(mailInput()).channel).toBe('mail')
    expect(decisionFor(pushInput({ body: null })).channel).toBe('push')
  })
})

describe('decisionFor: the shapes it refuses', () => {
  it('refuses no_subscription on the mail channel', () => {
    // A letter is addressed by construction — the address comes from the
    // roster — so this outcome would be hiding a different failure.
    expect(() => decisionFor(mailInput({ outcome: 'no_subscription' }))).toThrow(
      /addressed by construction/,
    )
  })

  it('allows no_subscription on push, which is what it is for', () => {
    expect(decisionFor(pushInput({ outcome: 'no_subscription' })).outcome).toBe(
      'no_subscription',
    )
  })

  it('refuses a blank title', () => {
    // The title is the only thing a person scanning their history reads.
    expect(() => decisionFor(pushInput({ title: '   ' }))).toThrow(/title/)
  })

  it('trims a title rather than storing the whitespace', () => {
    expect(decisionFor(pushInput({ title: '  Two clients need a look  ' })).title).toBe(
      'Two clients need a look',
    )
  })
})

describe('decisionFor: defaults', () => {
  it('turns every absent optional into an explicit null', () => {
    const row = decisionFor(mailInput())
    expect(row.body).toBeNull()
    expect(row.url).toBeNull()
    expect(row.detail).toBeNull()
    expect(row.subscriptionId).toBeNull()
  })

  it('carries the subscription that was actually written to', () => {
    const id = '44444444-4444-4444-8444-444444444444'
    expect(decisionFor(pushInput({ subscriptionId: id })).subscriptionId).toBe(id)
  })
})

describe('truncateDetail', () => {
  it('keeps a short complaint whole', () => {
    expect(truncateDetail('410 Gone')).toBe('410 Gone')
  })

  it('bounds a long one', () => {
    const detail = truncateDetail('x'.repeat(DETAIL_LIMIT + 200))
    expect(detail).toHaveLength(DETAIL_LIMIT)
  })

  it('treats whitespace as nothing said', () => {
    // Otherwise `explain` would render "It did not arrive:  " — a colon and a
    // space, which reads as a truncated sentence rather than as no reason.
    expect(truncateDetail('   ')).toBeNull()
    expect(truncateDetail(null)).toBeNull()
  })
})

describe('bodyFor', () => {
  it('is the rule, on its own', () => {
    expect(bodyFor('push', 'text')).toBe('text')
    expect(bodyFor('mail', 'text')).toBeNull()
  })
})

describe('isSilence', () => {
  it('separates the one arrival from the three ways of not arriving', () => {
    const silent = OUTCOMES.filter(isSilence)
    expect(silent).toEqual(['suppressed', 'failed', 'no_subscription'])
  })
})

describe('explain', () => {
  it('says where a sent message went', () => {
    expect(explain({ channel: 'mail', outcome: 'sent', detail: null })).toBe(
      'Sent to your inbox.',
    )
    expect(explain({ channel: 'push', outcome: 'sent', detail: null })).toBe(
      'Sent to your phone.',
    )
  })

  it('answers the question the table exists for', () => {
    // The Phase 90 case: somebody switched the brief off in March and cannot,
    // in July, work out why they hear nothing.
    expect(explain({ channel: 'mail', outcome: 'suppressed', detail: SWITCHED_OFF })).toBe(
      SWITCHED_OFF,
    )
  })

  it('prefers a specific reason to the generic one', () => {
    expect(
      explain({ channel: 'push', outcome: 'suppressed', detail: 'Quiet hours.' }),
    ).toBe('Quiet hours.')
  })

  it('falls back when a suppression recorded no reason', () => {
    expect(explain({ channel: 'push', outcome: 'suppressed', detail: null })).toBe(
      SWITCHED_OFF,
    )
  })

  it('distinguishes a failure from a refusal', () => {
    // Three different support conversations, which is the entire value of
    // keeping the outcomes apart.
    const failed = explain({ channel: 'mail', outcome: 'failed', detail: '550 rejected' })
    const nowhere = explain({ channel: 'push', outcome: 'no_subscription', detail: null })
    const off = explain({ channel: 'push', outcome: 'suppressed', detail: null })

    expect(failed).toContain('550 rejected')
    expect(nowhere).toContain('Nowhere to send it')
    expect(new Set([failed, nowhere, off]).size).toBe(3)
  })

  it('says something readable when a provider gave no reason', () => {
    expect(explain({ channel: 'mail', outcome: 'failed', detail: null })).toBe(
      'It did not arrive, and the provider gave no reason.',
    )
  })

  it('has a sentence for every outcome on every channel', () => {
    // A row the question cannot be asked of should not be constructible.
    for (const channel of ['push', 'mail'] as Channel[]) {
      for (const outcome of OUTCOMES as Outcome[]) {
        const sentence = explain({ channel, outcome, detail: null })
        expect(sentence.length).toBeGreaterThan(0)
        expect(sentence).not.toContain('undefined')
      }
    }
  })
})
