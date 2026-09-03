import { describe, expect, it } from 'vitest'
import {
  claimCheck,
  lettersFor,
  looksLikeAddress,
  normaliseLogin,
  redemptionCheck,
} from '@/modules/auth/address-change'
import { TOKEN_TTL_MINUTES } from '@/modules/notify/tokens'

/**
 * Changing the address you sign in with (Phase 98).
 *
 * The property that matters most is asserted from several directions: the
 * letter to the address being **left** never carries a link. Moving the
 * recovery address is the first move in taking an account over, and a link in
 * the notice would let whoever holds the old address complete a change they
 * never asked for.
 */

const LINK = 'https://books.example.test/settings/security/confirm?token=abc123def456'

describe('normalising', () => {
  it('matches what signing in matches on', () => {
    expect(normaliseLogin('  Robin@Hartleyco.TEST ')).toBe('robin@hartleyco.test')
  })

  it('is the empty string for nothing at all', () => {
    expect(normaliseLogin(null)).toBe('')
    expect(normaliseLogin(undefined)).toBe('')
    expect(normaliseLogin('   ')).toBe('')
  })

  it('is shallow on purpose, because the letter is the real test', () => {
    expect(looksLikeAddress('robin@hartleyco.test')).toBe(true)
    expect(looksLikeAddress('robin+books@hartleyco.co.uk')).toBe(true)
    expect(looksLikeAddress('robin')).toBe(false)
    expect(looksLikeAddress('robin@hartleyco')).toBe(false)
    expect(looksLikeAddress('robin @hartleyco.test')).toBe(false)
  })
})

describe('making a claim', () => {
  it('accepts an address and hands back the normalised form', () => {
    expect(claimCheck({ current: 'old@x.test', requested: '  New@X.test ' })).toEqual({
      ok: true,
      address: 'new@x.test',
    })
  })

  it('refuses the address already in use by this account', () => {
    // Including when only the case differs, because that is the same address.
    expect(claimCheck({ current: 'robin@x.test', requested: 'ROBIN@x.test' })).toEqual({
      ok: false,
      why: 'That is already the address you sign in with.',
    })
  })

  it('refuses an empty request without pretending it was an address', () => {
    expect(claimCheck({ current: 'a@x.test', requested: '   ' })).toEqual({
      ok: false,
      why: 'Type the address you want to use.',
    })
  })

  it('refuses something that is not an address', () => {
    const verdict = claimCheck({ current: 'a@x.test', requested: 'robin' })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('does not look like an email address')
  })

  it('says nothing about whether the address belongs to somebody else', () => {
    // Deliberate, and the same stance requestPasswordReset already took: a
    // screen that answered would be the one place in the application that
    // confirms whether an account exists.
    expect(claimCheck({ current: 'a@x.test', requested: 'somebody-elses@x.test' })).toEqual({
      ok: true,
      address: 'somebody-elses@x.test',
    })
  })
})

describe('the two letters', () => {
  const letters = lettersFor({
    current: 'Old@Hartleyco.test',
    requested: ' New@Hartleyco.TEST ',
    companyName: 'Hartley & Co',
    url: LINK,
    ttlMinutes: TOKEN_TTL_MINUTES.email_change,
  })

  it('sends the confirmation to the address being claimed', () => {
    expect(letters.confirm.to).toBe('new@hartleyco.test')
    expect(letters.confirm.url).toBe(LINK)
  })

  it('sends the notice to the address being left', () => {
    expect(letters.notice.to).toBe('old@hartleyco.test')
  })

  it('never puts a link in the notice', () => {
    // The property this whole phase turns on.
    expect(letters.notice.url).toBeNull()
    for (const line of letters.notice.body) {
      expect(line).not.toContain(LINK)
      expect(line).not.toContain('token=')
      expect(line).not.toMatch(/https?:\/\//)
    }
  })

  it('tells the old address why it is being told', () => {
    const body = letters.notice.body.join(' ')
    expect(body).toContain('first thing somebody does when they take an account over')
    expect(body).toContain('change your password')
  })

  it('names both addresses in both letters, so neither is a mystery', () => {
    for (const letter of [letters.confirm, letters.notice]) {
      const body = letter.body.join(' ')
      expect(body).toContain('old@hartleyco.test')
      expect(body).toContain('new@hartleyco.test')
    }
  })

  it('says plainly that nothing has changed yet', () => {
    expect(letters.confirm.body.join(' ')).toContain('Nothing changes until you do')
    expect(letters.notice.body.join(' ')).toContain('Nothing has changed yet')
  })

  it('says how long the link lasts, and takes it from the one place that knows', () => {
    // Not a constant of its own. A second number that had to agree with
    // TOKEN_TTL_MINUTES would drift the first time somebody shortened one.
    expect(letters.confirm.body.join(' ')).toContain(
      `${TOKEN_TTL_MINUTES.email_change} minutes`,
    )
  })

  it('goes to two different addresses, always', () => {
    expect(letters.confirm.to).not.toBe(letters.notice.to)
  })
})

describe('completing a claim', () => {
  it('allows one nobody has taken in the meantime', () => {
    expect(
      redemptionCheck({ claimed: 'new@x.test', current: 'old@x.test', takenByAnother: false }),
    ).toEqual({ ok: true })
  })

  it('refuses when somebody registered the address in between', () => {
    // The token proves who asked and for what. It cannot prove the answer is
    // still available an hour later.
    const verdict = redemptionCheck({
      claimed: 'new@x.test',
      current: 'old@x.test',
      takenByAnother: true,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('belongs to another account')
  })

  it('refuses a claim the account has already arrived at by another route', () => {
    const verdict = redemptionCheck({
      claimed: 'New@x.test',
      current: 'new@x.test',
      takenByAnother: false,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('nothing to confirm')
  })
})
