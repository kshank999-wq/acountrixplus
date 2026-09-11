import { RegistryError } from '@/modules/errors/registry'

/**
 * What a `domestic` basis stands on (Phase 141).
 *
 * ## NOT WIRED YET — and it never will be
 *
 * A check, like `askingFor` and `claimStands` before it. Nothing in `src/` calls
 * it; the test beside it measures the source and drives it. Stated plainly
 * because the staging pass makes "no caller" ambiguous, and `PENDING_WIRING`
 * exists so that ambiguity has an answer.
 *
 * ## The question
 *
 * `LEDGER_POSTINGS` sorts every posting site into three baskets, and fourteen
 * sit in `domestic`:
 *
 * > The money cannot be foreign at this site, argued from the schema.
 *
 * That is a claim about the world, and this project has a rule for those —
 * Phase 110 and 125's **a declaration argued from a fact that is not a fact.**
 * The entries do argue. What none of them does is say *which kind* of argument
 * it is making, and the kinds are not interchangeable:
 *
 * - nothing with a currency is anywhere near this code;
 * - something is, and the path **refuses** when it differs (Phase 133's ten);
 * - something is, and a callee **converted** it before this line ran;
 * - something is, and this function **writes** it, at a rate of one;
 * - something is, and the figure is a sum already argued to be one currency.
 *
 * Prose cannot be checked and a sentence that has rotted is exactly as long as
 * one that has not (Phase 135). A named ground can be checked, because each one
 * implies something measurable about the source.
 *
 * ## What measuring it found
 *
 * Three of the fourteen argue a ground the source contradicts:
 *
 * - **`applyDeposit`** — "the lease it is applied to carries no currency
 *   either", and it reaches `invoices` through `settleInvoiceWithoutCash`. The
 *   sentence that licensed the defect Phase 138 measured.
 * - **`redeemGiftCard`** — "a gift-card balance that has no currency column", and
 *   it reads `invoices` itself, bounding a home-currency card by the invoice's
 *   **face** balance and posting that figure while relieving the functional twin.
 * - **`recordContribution`** — "`contributions` and `funds` carry no currency
 *   column", and it reads `financial_accounts.chart_account_id` directly rather
 *   than through `bankGlAccountFor`. Its sibling `receivePledge`, forty lines
 *   below in the same file, goes through the gate.
 *
 * That last one is a sixth instance of the reach failure this codebase keeps
 * finding. Phase 133's scan looks for `chartAccountId: bank.chartAccountId` or a
 * name containing `gl`; `recordContribution` assigns the account to
 * `debitAccountId` first, so it is not in `BANK_POSTINGS` at all — **the scan
 * looked for a spelling rather than for the fact.**
 *
 * ## Why the ground is declared and the reach is measured
 *
 * The split is the whole design. A declaration nobody checks is what Phase 134
 * called worse than a gap, because a gap invites a look and a declaration ends
 * one. So the entry says what *kind* of argument it is making — which is a
 * decision a person has to make — and the scan says whether the source agrees,
 * which is a fact nobody should be asked to remember.
 *
 * One structural consequence is worth stating: **a carrier a function reads
 * itself can never be covered by a callee.** `covered` is built only from what
 * the named `via` reach, so swapping a failing entry to `converted-downstream`
 * cannot rescue it — which is the hole a self-declared field would otherwise
 * leave open.
 */

/** How a `domestic` entry argues that the money here cannot be foreign. */
export type Ground =
  /**
   * Nothing within one call carries a currency.
   *
   * The strongest and the easiest to falsify: the scan reaches a
   * currency-carrying table or it does not. A till float and a trial-balance
   * import are genuinely this; three entries claimed it and are not.
   */
  | 'nothing-in-reach'
  /**
   * Something does, and the path declines when it differs.
   *
   * Phase 133's answer, and the reason it is a *ground* rather than a bug: the
   * figure really is the books' money, not because no currency is near but
   * because the path refuses to post when one is. Checked against
   * `BANK_POSTINGS`, which is checked against the source in turn.
   */
  | 'refuses-foreign'
  /**
   * Something does, and a callee converted it before this line ran.
   *
   * `completeAppointment` raises its invoice through `createInvoice`, which
   * `LEDGER_POSTINGS` declares `converted` — so the conversion happened, it
   * happened somewhere that argues for itself, and this site posts a share of a
   * figure that was already the books' money.
   */
  | 'converted-downstream'
  /**
   * Something does, and this function writes it, at a rate of one.
   *
   * An imported opening balance is what the old system said was owed, in the
   * money these books are kept in. The check is not that the file says so: it is
   * that the face column and its functional twin are assigned **the same
   * expression**, which is what "the rate is one" means when written down.
   */
  | 'writes-rate-one'
  /**
   * Something does, and the figure is a sum already argued to be one currency.
   *
   * `closeShift` reaches `payments` through `shiftPosition`, and `SAFE_FACE_SUMS`
   * argues that one — verified in the code rather than from what a till is like:
   * `takeCounterPayment` never passes a currency to `recordPayment`. Reusing that
   * argument rather than restating it keeps one answer to one question.
   */
  | 'sum-is-one-currency'

/** Grounds that argue from the site itself, and so may name no callee. */
const ARGUES_ALONE: readonly Ground[] = ['nothing-in-reach', 'refuses-foreign']

/** One `domestic` entry, and the kind of argument it makes. */
export type DomesticGround = {
  /** Module file, repo-relative — the `LEDGER_POSTINGS` key. */
  file: string
  symbol: string
  ground: Ground
  /**
   * The callees the ground argues through, named so the scan can check them.
   *
   * Empty for the two grounds that argue from the site itself. Required for the
   * other three: "a callee converted it" with no callee named is the same
   * unfalsifiable sentence this file exists to replace.
   */
  via: readonly string[]
  /** Why this ground and not a neighbouring one, argued from the code. */
  because: string
}

/** What the scan measured about one entry, never what the entry declared. */
export type Grounded = {
  symbol: string
  ground: Ground
  via: readonly string[]
  /** Currency-carrying tables reached, directly or through one call. */
  reaches: readonly string[]
  /**
   * Of those, the ones the named `via` account for.
   *
   * Built only from what a `via` reaches, never from the body — so a carrier the
   * function reads itself is never covered by a callee.
   */
  covered: readonly string[]
  /** Does `BANK_POSTINGS` say this path refuses a foreign account? */
  refusesForeign: boolean
  /** Named `via` that do not do what the ground claims of them. */
  unsound: readonly string[]
}

export type GroundVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a declared ground survives what the source actually does.
 *
 * Pure: no database, no clock, no file reading. Every fact it judges is measured
 * by the caller and handed in, which is the same shape as `claimStands` and for
 * the same reason — the reach is the part that must not be declared.
 */
export function groundStands(input: Grounded): GroundVerdict {
  const { symbol, ground, via, reaches, covered, refusesForeign, unsound } = input

  const argueAlone = ARGUES_ALONE.includes(ground)

  if (argueAlone && via.length > 0) {
    return {
      ok: false,
      why:
        `${symbol} argues \`${ground}\`, which is a claim about this site, and names ` +
        `${via.join(', ')} as well. One or the other is the argument — naming a callee beside a ` +
        'claim that does not need one hides which of the two is doing the work.',
    }
  }

  if (!argueAlone && via.length === 0) {
    return {
      ok: false,
      why:
        `${symbol} argues \`${ground}\`, which is a claim about something it calls, and names ` +
        'nothing. A ground that points at a callee has to say which one, or it is the ' +
        'unfalsifiable sentence this registry exists to replace.',
    }
  }

  if (unsound.length > 0) {
    return {
      ok: false,
      why:
        `${symbol} argues \`${ground}\` through ${unsound.join(', ')}, which ${
          unsound.length === 1 ? 'does' : 'do'
        } not do that. The ground is only as good as what it names: either name what really ` +
        'keeps the currency out, or the basis is wrong.',
    }
  }

  if (ground === 'nothing-in-reach') {
    if (reaches.length === 0) return { ok: true }

    return {
      ok: false,
      why:
        `${symbol} is declared \`domestic\` on the argument that nothing here carries a currency, ` +
        `and it reaches ${reaches.join(', ')}, which does. Nothing in it refuses when the two ` +
        'differ and nothing converted it on the way, so the figure it posts can be a face amount ' +
        'in another currency. Either name what keeps the currency out, or the basis is wrong.',
    }
  }

  if (ground === 'refuses-foreign') {
    if (refusesForeign) return { ok: true }

    return {
      ok: false,
      why:
        `${symbol} argues that it refuses a foreign account, and \`BANK_POSTINGS\` does not say ` +
        'so — either because it declares something else, or because the bank-posting scan never ' +
        'reached it. A refusal nothing records is a refusal nobody can rely on.',
    }
  }

  const uncovered = reaches.filter((table) => !covered.includes(table))
  if (uncovered.length === 0) return { ok: true }

  return {
    ok: false,
    why:
      `${symbol} argues \`${ground}\` through ${via.join(', ')}, and that accounts for ` +
      `${covered.length === 0 ? 'none' : covered.join(', ')} of what it reaches — leaving ` +
      `${uncovered.join(', ')}. A ground has to cover every carrier in reach, because the one it ` +
      'misses is the one the figure comes from.',
  }
}

export const DOMESTIC_GROUNDS: readonly DomesticGround[] = [
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'completeAppointment',
    ground: 'converted-downstream',
    via: ['createInvoice'],
    because:
      '`split.practitionerCents` is a commission share of an appointment price, and the price ' +
      'becomes money the books carry only when `createInvoice` raises the invoice — which ' +
      '`LEDGER_POSTINGS` declares `converted` and which computes the functional figures line by ' +
      'line. So the carrier really is in reach, and the conversion really did happen before this ' +
      'line; the entry names the callee rather than claiming nothing is near.',
  },
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'sellGiftCard',
    ground: 'nothing-in-reach',
    via: [],
    because:
      '`gift_cards` has no currency column and no functional twin, and selling one touches no ' +
      'other table that has either. A card is sold and redeemed in the company’s own money by ' +
      'construction, which is why Phase 31 could make it a payment rather than a bare credit ' +
      'without asking what it was denominated in. Measured rather than assumed: the scan reaches ' +
      'nothing from here.',
  },
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'redeemGiftCard',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'The argument the entry has always made — the same construction as selling a card, over a ' +
      'balance with no currency column — and **the source contradicts it.** It reads `invoices` ' +
      'itself to find what is still owed, bounds the card by `bill.balanceCents`, which is the ' +
      'face balance, and posts that figure to both lines while relieving the functional twin ' +
      'through `relieveFunctional`. Kept as the ground it argues rather than softened, so the ' +
      'scan disagrees with it by name.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'openShift',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'A till float. `drawers` and `drawer_shifts` carry no currency column, nothing else is in ' +
      'reach, and a physical drawer holds one currency by the nature of being a drawer — the ' +
      'notes in it are the ones the business trades in. The measurement agrees: the scan reaches ' +
      'no carrier from here at all.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'payOut',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'Cash out of the same drawer, and the same argument: the money is physically in the till, ' +
      'in the currency the till holds, and no table this function reaches — directly or one call ' +
      'away — records another one. `drawer_payouts` has no currency column and no functional ' +
      'twin.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'closeShift',
    ground: 'sum-is-one-currency',
    via: ['shiftPosition'],
    because:
      'Unlike its two neighbours this one **does** reach a carrier: `shiftPosition` sums ' +
      '`payments.amount_cents`, and `payments` carries a currency. It is still right, and not for ' +
      'the reason the other drawer entries are — `SAFE_FACE_SUMS` argues that sum from the code ' +
      'rather than from what a till is like: `takeCounterPayment` never passes a currency to ' +
      '`recordPayment`, so every receipt reaching a drawer defaults to the company’s own. This ' +
      'entry points at that argument instead of restating it, because two answers to one ' +
      'question is the defect.',
  },
  {
    file: 'src/modules/importing/opening-balances.ts',
    symbol: 'commitTrialBalanceImport',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'An opening trial balance is the company’s own books being carried over, so `line.amountCents` ' +
      'and the `plugCents` balancing figure are functional by definition — there is no second ' +
      'currency for a trial balance to be in. It writes journal lines and nothing else: the scan ' +
      'reaches no currency-carrying table, which is the difference between it and its sibling ' +
      'below.',
  },
  {
    file: 'src/modules/importing/opening-balances.ts',
    symbol: 'commitOpenDocumentImport',
    ground: 'writes-rate-one',
    via: ['insertOpeningInvoice', 'insertOpeningBill'],
    because:
      'The sibling that **does** reach carriers, because it creates them: `invoices` and `bills` ' +
      'with their lines. The file already says why that is safe — "an opening balance carries no ' +
      'currency of its own, so the rate is one and the functional figure *is* the face figure" — ' +
      'and this ground turns that sentence into something checkable. The scan requires the face ' +
      'column and its functional twin to be assigned the **same expression**, which is what a ' +
      'rate of one looks like written down, and would fail the day somebody converted one of them.',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'recordContribution',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'The argument the entry has always made — `contributions` and `funds` carry no currency ' +
      'column, restriction being about what money may be spent on rather than what it is ' +
      'denominated in — and **the source contradicts it.** It reads ' +
      '`financialAccounts.chartAccountId` directly and debits that account, where `receivePledge` ' +
      'forty lines below goes through `bankGlAccountFor` and is refused a foreign one. It is ' +
      'absent from `BANK_POSTINGS` because Phase 133’s scan matches `bank.chartAccountId` and a ' +
      'name containing `gl`, and this assigns to `debitAccountId` first — a scan that looked for ' +
      'a spelling rather than for the fact.',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'receivePledge',
    ground: 'refuses-foreign',
    via: [],
    because:
      'A promise to give, settled when the money arrives. No table in the funds module records a ' +
      'currency — but the bank account it is banked into does, so "nothing is in reach" would be ' +
      'false here as it is false for its sibling. What makes the figure the books’ money is that ' +
      '`bankGlAccountFor` declines a foreign account outright (Phase 133), which `BANK_POSTINGS` ' +
      'records as `refuses` and `bank-side.test.ts` checks against the source.',
  },
  {
    file: 'src/modules/payroll/remittance.ts',
    symbol: 'recordRemittance',
    ground: 'refuses-foreign',
    via: [],
    because:
      'Paying over what was withheld. No payroll table carries a currency — a run is computed by ' +
      'a provider in the jurisdiction the company files in — but `tax_remittances` inherits one ' +
      'from the account it pays from, and the account itself is in reach. The refusal is what ' +
      'settles it: Phase 133 made this path decline a foreign account rather than assert that a ' +
      'dollar figure left an account that deals in euros.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'receiveDeposit',
    ground: 'refuses-foreign',
    via: [],
    because:
      'A security deposit is somebody else’s money held against a lease (Phase 23), and neither ' +
      '`leases` nor the deposit tables record a currency. The bank it is banked into does, which ' +
      'is how this reaches the scan at all, and Phase 133 made the path refuse when that account ' +
      'is foreign. The refusal is the ground, not the absence of a currency.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    ground: 'refuses-foreign',
    via: [],
    because:
      'Giving the deposit back, against the same liability it created: what was held is what is ' +
      'returned, in the currency it was held in. Same tables and the same gate as receiving it — ' +
      '`bankGlAccountFor` declines a foreign account, so the figure that moves is the books’ ' +
      'money by refusal rather than by luck.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'applyDeposit',
    ground: 'nothing-in-reach',
    via: [],
    because:
      'The argument the entry has always made — "the lease it is applied to carries no currency ' +
      'either, so both sides of the entry are the books’ money" — and **the source contradicts ' +
      'it** twice over. A deposit is applied to an *invoice*, not to the lease; and it reaches ' +
      '`invoices` through `settleInvoiceWithoutCash`, one call away, so a body scan reports it ' +
      'clean. That sentence is what licensed the defect Phase 138 measured, and `PENDING_WIRING` ' +
      'tracks the repair.',
  },
]

/** The ground declared for one posting site, or a defect if none is. */
export function groundFor(file: string, symbol: string): DomesticGround {
  const found = DOMESTIC_GROUNDS.find((row) => row.file === file && row.symbol === symbol)
  if (found) return found

  throw new RegistryError({
    registry: 'DOMESTIC_GROUNDS',
    key: `${file}:${symbol}`,
    message:
      `No ground is declared for ${symbol} in ${file}. A \`domestic\` basis is a claim that the ` +
      'money here cannot be foreign, and the claim has to say what kind of argument it is: ' +
      'nothing in reach, a refusal, a conversion upstream, a rate of one, or a sum already ' +
      'argued to be one currency.',
  })
}
