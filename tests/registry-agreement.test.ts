import { describe, expect, it } from 'vitest'
import { DENIALS, agreementFor, deniesConversion, withoutQuotations } from '@/modules/fx/agreement'
import { LEDGER_POSTINGS } from '@/modules/fx/ledger'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'

/**
 * When one function is declared in two registries (Phase 135).
 *
 * No database, no clock. `BANK_POSTINGS` and `LEDGER_POSTINGS` both describe
 * fourteen of the same functions, and until this phase nothing had ever put the
 * two descriptions side by side.
 */

/** Every symbol both registries describe, with what each of them says. */
function crossDeclared() {
  const byKey = new Map(LEDGER_POSTINGS.map((row) => [`${row.file}:${row.symbol}`, row]))

  return BANK_POSTINGS.flatMap((bank) => {
    const ledger = byKey.get(`${bank.file}:${bank.symbol}`)
    if (!ledger) return []
    return [
      {
        symbol: bank.symbol,
        basis: ledger.basis,
        handling: bank.handling,
        ledgerBecause: ledger.because,
        bankBecause: bank.because,
      },
    ]
  })
}

describe('the two registries that describe the same functions', () => {
  const pairs = crossDeclared()

  it('finds the overlap, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126's lesson). Fourteen: every entry in
    // BANK_POSTINGS is also in LEDGER_POSTINGS, because a function that posts
    // to a bank account posts to the ledger.
    expect(pairs.length).toBe(14)
    expect(pairs.length).toBe(BANK_POSTINGS.length)
  })

  it('agrees with itself, symbol by symbol', () => {
    // The assertion that caught Phase 134's own defect: `importPayouts` was
    // made to convert, its LEDGER_POSTINGS entry was updated to `converted`,
    // and its BANK_POSTINGS argument was left saying "it still does not".
    const disagreements = pairs
      .map((pair) => ({ pair, verdict: agreementFor(pair) }))
      .filter(({ verdict }) => !verdict.ok)
      .map(({ verdict }) => (verdict.ok ? '' : verdict.why))

    expect(disagreements).toEqual([])
  })

  it('holds `converts` to implying `converted`, and does not claim the converse', () => {
    const converts = pairs.filter((pair) => pair.handling === 'converts')
    const refusesButConverted = pairs.filter(
      (pair) => pair.handling === 'refuses' && pair.basis === 'converted',
    )

    // Four convert, and every one of them posts a converted figure. A path that
    // converts *for the account* is producing the company's own money by
    // definition, so there is no way to be one and not the other.
    expect(converts.length).toBe(4)
    expect(converts.every((pair) => pair.basis === 'converted')).toBe(true)

    // And six are `refuses` + `converted`, which is correct and stated here so
    // that nobody tidying this up turns an implication into an equivalence.
    // The two registries answer different questions: `basis` is about the
    // figure, `handling` is about the account.
    expect(refusesButConverted.length).toBe(6)
  })
})

describe('what counts as denying a conversion', () => {
  it('reads the sentence that started this phase', () => {
    expect(deniesConversion('this is the path closest to being able to convert — and it still does not, because nothing compares')?.name).toBe(
      'still does not',
    )
  })

  it('leaves history alone, which a because is often right to recount', () => {
    // The distinction the registry turns on. "Did not" is a claim about the
    // past and most of these entries make one; "does not" is a claim about now.
    expect(deniesConversion('Phase 127 found that it did not convert, and Phase 134 fixed it')).toBe(
      null,
    )
    expect(deniesConversion('converting it would not convert the fee, which is posted apart')).toBe(
      null,
    )
  })

  it('lets an entry quote the sentence it is correcting', () => {
    // Found by this check on its first use, against the entry written to fix
    // what it had just caught: the corrected `importPayouts` prose quotes the
    // old sentence, and the denial fired on the quotation.
    //
    // Registries here recount their own history constantly. A check that
    // cannot tell a quotation from a claim makes the honest entry the failing
    // one, which is how a check gets deleted rather than fixed.
    expect(
      deniesConversion('This entry said “it still does not convert” for a phase after it did'),
    ).toBe(null)

    // But the claim outside the quotation is still read.
    expect(
      deniesConversion('It quotes “something harmless”, and it still does not convert')?.name,
    ).toBe('still does not')

    // The stripping itself, since it decides what counts as this entry's own
    // words. Straight and curly marks both, because prose here uses both.
    const stripped = withoutQuotations('said “a claim” and "another" here')
    expect(stripped).not.toContain('a claim')
    expect(stripped).not.toContain('another')
    expect(stripped.replace(/\s+/g, ' ').trim()).toBe('said and here')
  })

  it('catches a face-amount claim beside a converted declaration', () => {
    expect(deniesConversion('it posts the face amount into a functional ledger')?.name).toBe(
      'posts the face amount',
    )
  })

  it('argues each phrase from why it is safe to read as a denial', () => {
    // The registry-with-prose device, and this registry needs it more than
    // most: it decides that a sentence a person wrote means the opposite of a
    // declaration beside it.
    for (const denial of DENIALS) {
      expect(denial.because.length, denial.name).toBeGreaterThan(140)
    }
  })
})

describe('what agreementFor refuses', () => {
  it('names both registries and what they disagree about', () => {
    const verdict = agreementFor({
      symbol: 'someWriter',
      handling: 'converts',
      basis: 'domestic',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    expect(verdict.why).toContain('BANK_POSTINGS')
    expect(verdict.why).toContain('LEDGER_POSTINGS')
    expect(verdict.why).toContain('someWriter')
    expect(verdict.why).toContain('domestic')
  })

  it('lets a refusing path post a converted figure, which six really do', () => {
    expect(
      agreementFor({ symbol: 'refundRetainer', handling: 'refuses', basis: 'converted' }).ok,
    ).toBe(true)
  })

  it('catches the prose denial even when the handlings are consistent', () => {
    // Exactly Phase 134's shape: nothing structural is wrong, the argument is.
    const verdict = agreementFor({
      symbol: 'importPayouts',
      handling: 'refuses',
      basis: 'converted',
      bankBecause: 'the path closest to converting — and it still does not, because nothing asks',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('two answers to one question')
  })

  it('says nothing about a symbol only one registry declares', () => {
    // `LEDGER_POSTINGS` has thirty-seven functions and `BANK_POSTINGS` fourteen.
    // A symbol in one alone is not a disagreement; it is a smaller question.
    expect(agreementFor({ symbol: 'createCreditNote', basis: 'converted' }).ok).toBe(true)
  })
})
