import { describe, expect, it } from 'vitest'
import { mayPostToBank } from '@/modules/fx/bank-side'

/**
 * The currency the money is in, and the currency the account is in (Phase 136).
 *
 * No database, no clock. Phase 133 asked one question — is the **account**
 * foreign? — where there are two, because it never saw the money.
 *
 * Measured: `mayPostToBank` took `accountCurrency` and `homeCurrency` and
 * nothing else, and nothing in `importPayouts` compared the payout's currency
 * to the account's. So two situations got the same refusal, and they are not
 * the same situation at all.
 */

const HOME = 'USD'

describe('when the money and the account agree', () => {
  it('lets a euro payout into a euro account through', () => {
    // The bank feed's shape, and the feed has done this correctly since Phase
    // 128: `bank_transactions` inherits its currency from `financial_accounts`,
    // so the money *is* the account's currency. €96.80 really landed, the
    // statement will say so, and the ledger takes the converted figure.
    //
    // Phase 133 refused this, and ADRs 0131, 0132, 0134 and 0135 each recorded
    // it as still open.
    expect(
      mayPostToBank({
        accountName: 'Frankfurt Current',
        accountCurrency: 'EUR',
        moneyCurrency: 'EUR',
        homeCurrency: HOME,
        what: 'banking this payout',
      }),
    ).toEqual({ ok: true })
  })

  it('still lets the ordinary domestic case through', () => {
    // Why a hundred and thirty phases are untouched: all three agree.
    expect(
      mayPostToBank({
        accountName: 'Business Checking',
        accountCurrency: HOME,
        moneyCurrency: HOME,
        homeCurrency: HOME,
        what: 'banking this payout',
      }),
    ).toEqual({ ok: true })
  })

  it('reads the two currencies the same however they are cased', () => {
    expect(
      mayPostToBank({
        accountName: 'Frankfurt Current',
        accountCurrency: 'EUR',
        moneyCurrency: 'eur',
        homeCurrency: HOME,
        what: 'banking this payout',
      }).ok,
    ).toBe(true)
  })
})

describe('when the money and the account disagree', () => {
  it('refuses a euro payout into a dollar account, which used to post', () => {
    // **The inversion.** Phase 134 made `importPayouts` convert this case and
    // Phase 133 refused the one above — exactly backwards.
    //
    // A €96.80 payout into a dollar account was converted by the *bank*, at the
    // bank's rate on the bank's terms. These books do not have that rate, so
    // any figure posted is a guess at somebody else's arithmetic. Phase 40's
    // tie-out compares each account in its own currency, so the statement and
    // the ledger differ by the bank's spread with nothing to name it.
    const verdict = mayPostToBank({
      accountName: 'Business Checking',
      accountCurrency: 'USD',
      moneyCurrency: 'EUR',
      homeCurrency: HOME,
      what: 'banking this payout',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    // Names both currencies, the account, the act, and what to do instead —
    // Phase 119's standard for a refusal somebody has to act on.
    expect(verdict.why).toContain('EUR')
    expect(verdict.why).toContain('USD')
    expect(verdict.why).toContain('Business Checking')
    expect(verdict.why).toContain('banking this payout')
    expect(verdict.why).toMatch(/journal entry/)
  })

  it('says the bank did the conversion, not that a rate is missing', () => {
    // The distinction that decides where somebody goes to fix it. "No rate for
    // that day" sends them to the rate table, which would not help: the rate
    // that matters is the bank's and is not ours to enter.
    const verdict = mayPostToBank({
      accountName: 'Business Checking',
      accountCurrency: 'USD',
      moneyCurrency: 'EUR',
      homeCurrency: HOME,
      what: 'banking this payout',
    })

    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.why).toMatch(/bank converts that at its own rate/)
  })

  it('refuses two foreign currencies against each other too', () => {
    // Nothing here turns on either being the home currency. A sterling payout
    // into a euro account is somebody else's conversion just the same.
    expect(
      mayPostToBank({
        accountName: 'Frankfurt Current',
        accountCurrency: 'EUR',
        moneyCurrency: 'GBP',
        homeCurrency: HOME,
        what: 'banking this payout',
      }).ok,
    ).toBe(false)
  })
})

describe('when the path does not know what currency the money is in', () => {
  it('keeps Phase 133’s refusal, because nothing can be checked', () => {
    // Nine of Phase 133's ten. A person typed an amount and chose an account,
    // and there is no field saying what currency the amount was in — so the
    // account being foreign is the only question that can be asked, and the
    // honest answer is still no.
    const verdict = mayPostToBank({
      accountName: 'Frankfurt Current',
      accountCurrency: 'EUR',
      homeCurrency: HOME,
      what: 'holding this deposit',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('these books are kept in')
  })

  it('lets a domestic account through, exactly as before', () => {
    expect(
      mayPostToBank({
        accountName: 'Business Checking',
        accountCurrency: HOME,
        homeCurrency: HOME,
        what: 'holding this deposit',
      }),
    ).toEqual({ ok: true })
  })
})
