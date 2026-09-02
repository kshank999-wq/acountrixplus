import { describe, expect, it } from 'vitest'
import {
  BODY_LIMIT,
  OMITTED_LINK,
  holdsALink,
  keptBodyFor,
} from '@/modules/notify/keeping'

/**
 * What of a letter is worth keeping (Phase 91).
 *
 * The property that matters most is the one asserted last: **no letter this
 * application composes leaves a link in the store**. It is asserted over the
 * shape of every kind rather than over the ones somebody remembered, because a
 * rule that has to be remembered per kind is a rule that will be forgotten.
 */

describe('keptBodyFor', () => {
  it('keeps what the letter said', () => {
    const kept = keptBodyFor({
      body: ['Two of your clients need a look.', 'Ridgeline Construction, Kestrel Joinery.'],
    })

    expect(kept).toBe(
      'Two of your clients need a look.\n\nRidgeline Construction, Kestrel Joinery.',
    )
  })

  it('never keeps what the letter granted', () => {
    // The whole reason this module exists: `renderText` appends `action.url`,
    // and that URL is a single-use sign-in token here.
    const kept = keptBodyFor({
      body: ['Somebody asked to reset your password.'],
      action: { label: 'Choose a new password', url: 'https://app.test/reset/tok_abcdef123456' },
    })

    expect(kept).not.toContain('tok_abcdef123456')
    expect(kept).not.toContain('https://')
    expect(holdsALink(kept)).toBe(false)
  })

  it('keeps the label in the link’s place', () => {
    // So a person re-reading can see the letter offered them somewhere to go.
    // They cannot go there; that is the point.
    const kept = keptBodyFor({
      body: ['Your invoice is ready.'],
      action: { label: 'View the invoice', url: 'https://app.test/i/signed-blob' },
    })

    expect(kept).toContain(`View the invoice: ${OMITTED_LINK}`)
  })

  it('keeps the footnote, which is small print rather than a capability', () => {
    const kept = keptBodyFor({
      body: ['Two of your clients need a look.'],
      footnote: 'Sent to everybody at your firm.',
    })

    expect(kept?.endsWith('Sent to everybody at your firm.')).toBe(true)
  })

  it('mirrors renderText paragraph for paragraph', () => {
    // A stored letter that reads differently from the one that arrived is
    // worse than no stored letter: a person comparing them would conclude one
    // had been tampered with. Same order, same blank line between parts.
    const kept = keptBodyFor({
      body: ['One.', 'Two.'],
      action: { label: 'Go', url: 'https://app.test/x' },
      footnote: 'Small print.',
    })

    expect(kept).toBe(`One.\n\nTwo.\n\nGo: ${OMITTED_LINK}\n\nSmall print.`)
  })

  it('drops blank paragraphs rather than storing gaps', () => {
    expect(keptBodyFor({ body: ['One.', '   ', '', 'Two.'] })).toBe('One.\n\nTwo.')
  })

  it('is null when a letter said nothing', () => {
    // Absent rather than an empty string, so a screen renders nothing rather
    // than a blank panel that looks like a bug.
    expect(keptBodyFor({ body: [] })).toBeNull()
    expect(keptBodyFor({ body: ['  '], footnote: '  ' })).toBeNull()
  })

  it('is null when only whitespace and no action survive', () => {
    expect(keptBodyFor({ body: [''], action: null, footnote: null })).toBeNull()
  })

  it('bounds a letter somebody typed', () => {
    const kept = keptBodyFor({ body: ['x'.repeat(BODY_LIMIT + 5_000)] })
    expect(kept).toHaveLength(BODY_LIMIT)
  })
})

describe('holdsALink', () => {
  it('recognises a link in either scheme, and nothing in none', () => {
    expect(holdsALink('go to https://app.test/x')).toBe(true)
    expect(holdsALink('go to HTTP://app.test/x')).toBe(true)
    expect(holdsALink('go to the roster')).toBe(false)
    expect(holdsALink(null)).toBe(false)
  })
})

describe('the rule holds for every letter this application composes', () => {
  /**
   * One case per `TransactionalKind`, shaped like the real send — each of them
   * carries an action, and each of those URLs is a capability: a reset token, a
   * join token, a signed document link, or a page behind the firm's own login.
   *
   * Asserted as a set rather than one at a time, because the failure this
   * guards against is somebody adding a ninth kind that stores its token.
   */
  const letters = [
    { kind: 'password_reset', url: 'https://app.test/reset/tok_reset' },
    { kind: 'company_invitation', url: 'https://app.test/invite/tok_company' },
    { kind: 'practice_invitation', url: 'https://app.test/invite/tok_practice' },
    { kind: 'security_alert', url: 'https://app.test/settings/security' },
    { kind: 'invoice', url: 'https://app.test/i/signed_invoice' },
    { kind: 'statement', url: 'https://app.test/s/signed_statement' },
    { kind: 'remittance', url: 'https://app.test/r/signed_remittance' },
    { kind: 'practice_brief', url: 'https://app.test/practice' },
  ]

  it('stores no link, whichever kind it was', () => {
    for (const letter of letters) {
      const kept = keptBodyFor({
        body: [`A letter of kind ${letter.kind}.`],
        action: { label: 'Open it', url: letter.url },
        footnote: 'Small print.',
      })

      expect(holdsALink(kept), `${letter.kind} kept a link`).toBe(false)
      // The whole URL, not merely the scheme — and asserted as the URL rather
      // than as its last path segment, which for the settings page is the bare
      // word "security" and appears legitimately in the letter's own text.
      expect(kept, `${letter.kind} kept its URL`).not.toContain(letter.url)
    }
  })

  it('keeps no token, for the kinds whose link is a credential', () => {
    // The four that carry one. A plain page behind a login is not a token, so
    // asserting over all eight here would be asserting nothing for half.
    const withTokens = letters.filter((letter) => letter.url.includes('tok_'))
    expect(withTokens).toHaveLength(3)

    for (const letter of [...withTokens, { kind: 'invoice', url: 'https://app.test/i/signed_invoice' }]) {
      const kept = keptBodyFor({
        body: ['Here is the thing you asked for.'],
        action: { label: 'Open it', url: letter.url },
      })

      const secret = letter.url.split('/').pop()!
      expect(kept, `${letter.kind} kept ${secret}`).not.toContain(secret)
    }
  })

  it('still keeps something readable for every one of them', () => {
    // The other half: a rule that strips everything is safe and useless.
    for (const letter of letters) {
      const kept = keptBodyFor({
        body: [`A letter of kind ${letter.kind}.`],
        action: { label: 'Open it', url: letter.url },
      })

      expect(kept).toContain(letter.kind)
      expect(kept).toContain('Open it')
    }
  })
})
