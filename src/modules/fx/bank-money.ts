/**
 * What the bank line is, and what it is posted against (Phase 153).
 *
 * ## The capability that did not exist
 *
 * `BANK_POSTINGS` has recorded four paths as `withheld: 'no-field'` since Phase
 * 136, and `PENDING_WIRING` has carried them as its one blocked entry since:
 *
 * ```
 * recordRemittance   a payroll or sales tax liability paid to an agency
 * receivePledge      a promise settled in cash
 * receiveDeposit     a tenancy deposit taken in
 * refundDeposit      a tenancy deposit given back
 * ```
 *
 * All four refuse a foreign bank account outright. That refusal was honest —
 * nothing recorded what currency the money was in, so posting a home-currency
 * figure against a euro account would assert something nobody had been asked —
 * but the result is that a business banking in euros cannot remit a liability,
 * take a pledge, or hold and return a deposit through that account **at all**.
 * A wrong figure is a defect; this was a missing capability, which is why ADR
 * 0136 declined to wire it and said a column, a form field and a migration came
 * first.
 *
 * ## The core was already here, twice
 *
 * Nothing in this file does the arithmetic. `settleHeld` and `recoverHeld` have
 * decided it since Phase 68, and Phase 151 proved they fit a live path by
 * routing `recoverWriteOff` through the second of them. Both come down to one
 * sentence from ADR 0068:
 *
 * > `realised` is the debit side less the credit side.
 *
 * What was missing is not arithmetic. It is the answer to a question the four
 * paths answer differently and none of them states:
 *
 * ## Does this act create the balance it posts against, or relieve one?
 *
 * **Three relieve.** The liability a remittance clears was accrued when the
 * payroll ran. The receivable a pledge settles was raised when the promise was
 * made. The deposit a refund returns was credited when it was taken. Every one
 * of those balances is already in the books, already in the company's own money,
 * already carried at whatever rate applied when it was recorded. So the bank
 * takes the rate on the day the money moved, the balance keeps its own figure,
 * and **the difference between them is a realised gain or loss** — the same
 * three-line entry `recordPayment` has posted since Phase 35.
 *
 * **One creates.** `receiveDeposit` is the first time that tenancy's deposit
 * exists. There is no carried figure to disagree with, so the liability is
 * credited exactly what the bank was debited and a difference is not merely
 * absent — it is **impossible**. A site like this that reached the exchange
 * account would be inventing a gain out of a single conversion.
 *
 * This is ADR 0147's question — *which came first, the whole or the parts* —
 * asked about a balance rather than about a division. It has the same property
 * that made it worth naming there: the two cases look identical at the call
 * site, and only the provenance separates them.
 *
 * ## Why getting it wrong is quiet
 *
 * Both mistakes balance.
 *
 * Omit a difference that should be there and the only way the entry still foots
 * is if the bank line was given the balance's figure instead of the converted
 * one — so the bank is understated by exactly the movement, and Phase 40's
 * tie-out reports a difference in the morning with nothing to name it. That is
 * the defect ADRs 0136, 0137 and 0138 each nominated and Phase 151 finally fixed
 * in `recoverWriteOff`: €2,500 recovered at 1.10 put $2,708.75 on an account
 * whose statement said $2,750.
 *
 * Post a difference that cannot exist and the entry foots too, against a gain
 * nobody earned.
 *
 * Neither shows up as an imbalance, which is why the question is declared here
 * and measured against the source rather than left to each caller.
 *
 * Nothing here touches the database or the clock.
 */

import { RegistryError } from '@/modules/errors/registry'
import { convert } from '@/modules/fx/rates'
import { recoverHeld, settleHeld } from '@/modules/fx/settlement'

/** Where the figure on the other side of the bank line comes from. */
export type BalanceOrigin =
  /**
   * The balance exists before this act, in the company's own money, at whatever
   * rate it was recorded at. The bank takes the day's rate and the difference is
   * realised.
   */
  | 'already-carried'
  /**
   * This act is the first time the balance exists. It takes the converted
   * figure, and a realised difference is impossible rather than absent.
   */
  | 'created-here'
  /**
   * The balance exists before this act and is held in the **company's own
   * money**, with no rate of its own (Phase 157).
   *
   * The case the first two could not spell, found by wiring the site this
   * registry had declared and never acted on. `origin` as Phase 153 wrote it
   * asked *does the balance pre-exist?* — and what actually decides whether a
   * difference arises is *does the balance carry its own rate?*
   *
   * ```
   * site               pre-exists   carries a rate   difference
   * receiveDeposit     no           —                impossible
   * refundDeposit      yes          yes              realised
   * recordRemittance   yes          yes              realised
   * receivePledge      yes          NO               none
   * ```
   *
   * `contributions` has no currency column, so a pledge's `amount_cents` is the
   * books' own money: a €600 receipt worth $660 relieves $660 of a dollar
   * receivable, exactly. Nothing for a day rate to differ from.
   *
   * Declared as a third value rather than squeezed into `already-carried`
   * (Phase 130). Passing that one with `carriedCents` set to the converted
   * figure would have produced the right numbers **by accident**, which is
   * exactly the coincidence a registry exists to stop somebody relying on.
   */
  | 'carried-in-home-money'

/** Which way the money goes, which is what decides the sign. */
export type MoneyDirection =
  /** Into the bank: the bank is debited. */
  | 'in'
  /** Out of the bank: the bank is credited. */
  | 'out'

export type BankMoneySite = {
  file: string
  symbol: string
  origin: BalanceOrigin
  direction: MoneyDirection
  /** The account on the other side of the bank line, in the words the code uses. */
  against: string
  /** Why the balance is carried or created, argued from what raised it. */
  because: string
}

export const BANK_MONEY_SITES: readonly BankMoneySite[] = [
  {
    file: 'src/modules/payroll/remittance.ts',
    symbol: 'recordRemittance',
    origin: 'already-carried',
    direction: 'out',
    against: 'the payroll or sales tax liability account',
    because:
      'The liability was accrued when the payroll ran or the sale was made, and `recordRemittance` ' +
      'already refuses an amount larger than `liabilityPositions` says is owed — so the figure ' +
      'leaving the liability is a ledger balance in the company’s own money, and was before this ' +
      'path was called. Paying it from a euro account means the bank gives up euros worth ' +
      'something else on the day, and the gap is a realised movement rather than a rounding.',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'receivePledge',
    origin: 'carried-in-home-money',
    direction: 'in',
    against: 'Pledges Receivable',
    because:
      'The revenue was recognised when the promise was made — the code’s own line memo says so, ' +
      '"Promise settled — the revenue was recognised when it was made" — so the receivable predates ' +
      'the cash. **`already-carried` until Phase 157, and wrong.** That entry argued the receivable ' +
      'was "relieved at what it has been carried at" while the bank took what arrived, which implies ' +
      'a difference between them. `contributions` has no currency column: a pledge’s `amount_cents` ' +
      'is the books’ own money, so a €600 receipt worth $660 relieves $660 of a dollar receivable ' +
      'exactly and there is no second rate to differ from. Written in Phase 153 for a site nobody ' +
      'had wired, and contradicted the moment somebody did.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'receiveDeposit',
    origin: 'created-here',
    direction: 'in',
    against: 'the tenancy deposits liability',
    because:
      'This is the first time the deposit exists. Nothing was carrying it a moment ago, so there ' +
      'is no earlier rate for the day’s rate to disagree with: the liability is credited exactly ' +
      'what the bank was debited. A realised difference here would be a gain conjured from one ' +
      'conversion, which is the mistake that balances.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    origin: 'already-carried',
    direction: 'out',
    against: 'the tenancy deposits liability',
    because:
      'The sibling of the entry above and the opposite answer, which is why this is declared per ' +
      'site rather than per file. `depositPosition` reads what is held and `refundDeposit` refuses ' +
      'more than that, so the figure leaving the liability is a balance the books have carried ' +
      'since the deposit was taken — possibly years, and across any amount of rate movement.',
  },
]

/** The site a file and symbol name. Throws on a site nobody declared. */
export function bankMoneySiteFor(file: string, symbol: string): BankMoneySite {
  const site = BANK_MONEY_SITES.find((row) => row.file === file && row.symbol === symbol)
  if (!site) {
    throw new RegistryError({
      registry: 'BANK_MONEY_SITES',
      key: `${file}:${symbol}`,
      message:
        `No bank-money site is declared for ${symbol} in ${file}. A path that posts a converted ` +
        'figure to a bank account has to say whether the balance on the other side was created ' +
        'by this act or carried into it, because the two differ by a realised gain and both of ' +
        'them balance.',
    })
  }
  return site
}

/** The two lines of the entry, and the difference between them. */
export type BankMoneyLines = {
  /** What the bank is debited or credited — the face amount at the day's rate. */
  bankCents: number
  /** What the other account takes. */
  againstCents: number
  /**
   * Positive credits the exchange account, negative debits it — `Settlement`'s
   * convention, because this delegates to it rather than restating the sign.
   * Always zero for a `created-here` site.
   */
  realisedCents: number
}

/**
 * What `bankMoneyLines` is given, which the compiler keeps honest.
 *
 * A **constraint beats a check** (Phase 116). `carriedCents` is required exactly
 * when the balance was carried in and rejected when it was created here, and
 * both of those are the `origin` field discriminating a union rather than two
 * runtime throws. The first draft had the throws; they were the right rule
 * stated in the wrong place, because a wrong call site deserves to fail before
 * it runs.
 *
 * The two mistakes it makes impossible are the two that balance:
 *
 * - a `created-here` site handed a carried figure posts a realised gain out of
 *   one conversion;
 * - an `already-carried` site with no figure to relieve gets the converted
 *   amount on both sides, which understates the bank by exactly the rate
 *   movement.
 */
export type BankMoneyInput = {
  /** What the bank actually moved, in the bank account's own currency. */
  faceCents: number
  /** The rate on the day it moved. `RATE_ONE` for a domestic account. */
  dayRateMillionths: number
  direction: MoneyDirection
} & (
  | {
      origin: 'created-here'
      /** Nothing was carrying this balance a moment ago. */
      carriedCents?: never
    }
  | {
      origin: 'carried-in-home-money'
      /**
       * Forbidden for the same reason as above, and a different one: the balance
       * does exist, but it is the books' own money and has no rate — so there is
       * no second figure, and offering one would invite a difference that cannot
       * arise (Phase 157).
       */
      carriedCents?: never
    }
  | {
      origin: 'already-carried'
      /** The home-money figure the other account already holds. */
      carriedCents: number
    }
)

/**
 * The lines, from the face amount and the rate on the day.
 *
 * Composes `settleHeld` and `recoverHeld` rather than subtracting again. ADR
 * 0068 put the sign in one private function on the grounds that *"a swapped gain
 * still balances"*, and a third hand-rolled subtraction here would be the thing
 * that file exists to prevent.
 */
export function bankMoneyLines(input: BankMoneyInput): BankMoneyLines {
  const bankCents = convert(input.faceCents, input.dayRateMillionths)

  // Both of these put the converted figure on each side. Different reasons —
  // one has no earlier balance and the other has one with no rate — and the same
  // arithmetic, which is why they share a branch and not a name.
  if (input.origin === 'created-here' || input.origin === 'carried-in-home-money') {
    return { bankCents, againstCents: bankCents, realisedCents: 0 }
  }

  if (input.direction === 'in') {
    const recovery = recoverHeld({
      receivedCents: bankCents,
      relievedCents: input.carriedCents,
    })
    return {
      bankCents: recovery.receivedCents,
      againstCents: recovery.relievedCents,
      realisedCents: recovery.realisedCents,
    }
  }

  // Out of the bank. The balance is debited as it leaves and the bank is
  // credited with what the statement will show, which is `settleHeld`'s refund
  // case in its own words: "for a refund it is the bank, at the rate on the day
  // the money left".
  const settlement = settleHeld({
    releasedCents: input.carriedCents,
    relievedCents: bankCents,
  })
  return {
    bankCents: settlement.relievedCents,
    againstCents: settlement.releasedCents,
    realisedCents: settlement.realisedCents,
  }
}

export type BankMoneyVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a site's declaration matches what the code does.
 *
 * ADR 0141's split — *declare the knowledge, measure the fact* — and the half
 * that can **excuse** a site is the half that has to be checkable. `origin` is
 * the declaration; both inputs below are measured from the source by the test,
 * never asserted here.
 */
export function bankMoneyStands(input: {
  site: BankMoneySite
  /** Measured: does the path reach `ensureFxAccount`? */
  reachesFxAccount: boolean
  /** Measured: does it hand `bankGlAccountFor` a currency? */
  passesCurrency: boolean
}): BankMoneyVerdict {
  if (!input.passesCurrency) {
    return {
      ok: false,
      why:
        `${input.site.symbol} does not tell bankGlAccountFor what currency the money is in, so a ` +
        'foreign account is still refused outright and this declaration describes a path nobody ' +
        'can take.',
    }
  }

  if (input.site.origin === 'already-carried' && !input.reachesFxAccount) {
    return {
      ok: false,
      why:
        `${input.site.symbol} relieves a balance the books already carry and never reaches ` +
        'ensureFxAccount. The rate on the day will not match the rate it was carried at, and an ' +
        'entry with nowhere to put the difference foots only by posting the wrong figure to the ' +
        'bank — which understates it by exactly the movement.',
    }
  }

  if (input.site.origin === 'created-here' && input.reachesFxAccount) {
    return {
      ok: false,
      why:
        `${input.site.symbol} creates the balance it posts against and reaches ensureFxAccount. ` +
        'There is no earlier figure for the day’s rate to differ from, so whatever it posts there ' +
        'is a gain conjured out of one conversion.',
    }
  }

  if (input.site.origin === 'carried-in-home-money' && input.reachesFxAccount) {
    return {
      ok: false,
      why:
        `${input.site.symbol} relieves a balance held in the company’s own money and reaches ` +
        'ensureFxAccount. That balance carries no rate, so the converted receipt relieves it ' +
        'exactly and there is nothing to realise — whatever it posts to the exchange account is a ' +
        'difference between a figure and itself.',
    }
  }

  return { ok: true }
}
