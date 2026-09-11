/**
 * The declaration that licensed the defect (Phase 140).
 *
 * ## NOT WIRED YET
 *
 * A check, not a service change: nothing in `src/` calls this, and the test
 * beside it is what drives it. That is the same shape as `askingFor`,
 * `agreementFor` and every other registry device here — but it is stated
 * plainly because the staging pass makes "no caller" ambiguous.
 *
 * ## The defect
 *
 * `LEDGER_POSTINGS` declares `applyDeposit` as `domestic`, and argues it:
 *
 * > "Keeping some of the deposit against what the tenant owes, which turns held
 * > money into revenue. **The lease it is applied to carries no currency
 * > either**, so both sides of the entry are the books' money and the deduction
 * > needs no conversion."
 *
 * Three things are wrong, and the third is what matters:
 *
 * 1. **It names the wrong document.** A deposit is applied to an *invoice*
 *    (`input.invoiceId`); the lease is only whose deposit it is.
 * 2. **The fact is false.** `invoices` carries a `currency` and an
 *    `exchange_rate_millionths`, and is in both `CURRENCY_CARRIERS` and
 *    `PAIRED_COLUMNS`.
 * 3. **So "needs no conversion" is false**, and that sentence is exactly the
 *    defect Phase 138 found — `applyDeposit` crediting Accounts Receivable with
 *    a euro face amount.
 *
 * ## Worse than missing it
 *
 * The registry did not overlook this site. It **declared it safe**, and the code
 * did what the declaration said. ADR 0134 met the same shape when Phase 122's
 * `currencyAware` excused a site rather than failing to reach it, and called it
 * worse than missing it — a gap invites a look, and a declaration ends one.
 *
 * A `domestic` basis argued from "nothing here carries a currency" is a claim
 * about the world, and this project has a rule for those: Phase 110 and 125's
 * **a declaration argued from a fact that is not a fact.** The fix is not to
 * rewrite one sentence but to make the class of claim checkable.
 *
 * ## Why the check must follow a call
 *
 * Measured across the eight `domestic` entries that argue this way, scanning
 * each function body for a currency-carrying table:
 *
 * ```
 * completeAppointment   invoice_lines, invoices
 * redeemGiftCard        invoices
 * recordContribution    financial_accounts
 * recordRemittance      financial_accounts, tax_remittances
 * receiveDeposit        financial_accounts
 * sellGiftCard          — none —
 * openShift             — none —
 * applyDeposit          — none —
 * ```
 *
 * **`applyDeposit` reads as clean.** It reaches `invoices` through
 * `settleInvoiceWithoutCash`, one call away, so a body scan misses precisely the
 * entry that motivated the phase — the reach failure of Phases 128, 131, 133 and
 * 136 once more. The reach is a parameter here for that reason: the caller
 * resolves it, and the test that drives this follows one hop.
 *
 * ## And why reaching one is not enough to condemn it
 *
 * Three of the five that reach a carrier are right anyway.
 * `recordRemittance`, `receiveDeposit` and `recordContribution` all touch
 * `financial_accounts`, and Phase 133 made every one of them **refuse** a
 * foreign account. Their figures really are the books' money — not because no
 * currency exists nearby, but because the path declines when it differs.
 *
 * So the rule is not "reaching a carrier makes the claim false". It is that a
 * claim of *no currency* must be true, and where a currency is reachable the
 * entry has to say what keeps it out.
 */

export type Claim = {
  symbol: string
  /** What `LEDGER_POSTINGS` declares. */
  basis: string
  /** Does the prose argue from nothing nearby carrying a currency? */
  claimsNoCurrency: boolean
  /**
   * Currency-carrying tables this function reaches, **measured** — directly or
   * through one call. Never declared: that is the whole point.
   */
  reaches: readonly string[]
  /**
   * Does the path refuse when the currency differs, the way Phase 133's ten do?
   * A refusal is what makes a figure the books' money despite a carrier being
   * in reach.
   */
  refusesForeign: boolean
}

export type ClaimVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a "nothing here carries a currency" argument survives the source.
 *
 * Pure: no database, no clock, no file reading. The caller measures the reach.
 */
export function claimStands(input: Claim): ClaimVerdict {
  const { symbol, basis, claimsNoCurrency, reaches, refusesForeign } = input

  if (!claimsNoCurrency) return { ok: true }

  if (basis !== 'domestic') {
    return {
      ok: false,
      why:
        `${symbol} argues from nothing nearby carrying a currency, and declares \`${basis}\`. ` +
        'That argument only supports `domestic` — a converted figure is one that came from ' +
        'somewhere, so the two cannot both be true.',
    }
  }

  if (reaches.length === 0) return { ok: true }

  if (refusesForeign) return { ok: true }

  return {
    ok: false,
    why:
      `${symbol} is declared \`domestic\` on the argument that nothing here carries a currency, ` +
      `and it reaches ${reaches.join(', ')}, which does. Nothing in it refuses when the two ` +
      'differ, so the figure it posts can be a face amount in another currency — which is what ' +
      'this sentence licensed rather than missed. Either name what keeps the currency out, or ' +
      'the basis is wrong.',
  }
}
