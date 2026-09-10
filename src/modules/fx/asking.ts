import type { BankPostingHandling } from './bank-side'

/**
 * Which paths may be told what currency the money is in (Phase 136, part 3).
 *
 * ## The claim that was wrong
 *
 * ADR 0136 said, of the ten paths Phase 133 made refuse:
 *
 * > "`importPayouts` is the only one with a field saying what currency the
 * > money is in. **The other nine have no such field.**"
 *
 * That was written from memory rather than measured, and it is false. Five of
 * the nine already read the money's currency, and read it *for a rate lookup*:
 *
 * | path | what it reads |
 * | --- | --- |
 * | `receiveRetainer` | `input.currency ?? functionalCurrency(…)` |
 * | `refundRetainer` | `retainer.currency` |
 * | `refundCredit` | `payment.currency` |
 * | `refundVendorCredit` | `note.currency` |
 * | `recoverWriteOff` | `writeOff.currency` |
 *
 * So `importPayouts` was one of six that could ask, and the other five simply
 * never handed the guard what they already had. This is the same class of error
 * Phase 135 exists to catch, committed in the document announcing it — which is
 * why the correction is a rule rather than an edit to a sentence.
 *
 * ## Why four, not five
 *
 * Having the currency is not enough. A path may only be *told* it if, when the
 * money and the account agree, the figure it posts to the bank is struck at the
 * rate on the day the money moved — because that is the figure the statement
 * will show, and letting a path post is worthless if what it posts is wrong.
 *
 * Measured across the six, by whether the function body reaches `rateFor`:
 *
 * - `refundRetainer`, `refundCredit`, `refundVendorCredit` and `importPayouts`
 *   convert at the day's rate and name the difference from the carried rate as
 *   a realised gain or loss. They may ask.
 * - `receiveRetainer` converts at the day's rate and has no realised line
 *   *because it cannot* — arrival is the moment the rate is set, so there is no
 *   carried figure to differ from. It may ask.
 * - `recoverWriteOff` posts `recovery.functionalCents` to **both** lines, at the
 *   write-off's own carried rate. That is right for the bad-debt line, for the
 *   reason its own comment gives — a later rate would fold a currency movement
 *   into bad debt — and wrong for the bank line, which is what actually landed.
 *   One figure where there are two questions. It holds back.
 *
 * `recoverWriteOff` is therefore left refusing **and the reason recorded**,
 * rather than wired and quietly wrong. Giving it a day rate and a realised line
 * is a real change to a real posting and is not this phase's.
 */

/** Why a refusing path does not ask what currency the money is in. */
export type Withheld =
  /**
   * Nothing in scope says it. A person typed an amount and chose an account,
   * and there is no field for the currency — so the account being foreign is
   * the only question that can be asked, and the honest answer is still no.
   */
  | 'no-field'
  /**
   * The currency is in scope and deliberately not passed, because the figure
   * this path posts to the bank is not struck at the rate on the day. Letting
   * it through would trade a refusal somebody can read for a number nobody can
   * tie to a statement, which is the wrong way round (Phase 117).
   */
  | 'no-day-rate'

export type AskingVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a posting site's declaration agrees with what it actually does.
 *
 * `passesMoneyCurrency`, `readsMoneyCurrency` and `strikesAtDayRate` are
 * **measured from the source**, never declared. Phase 49's rule pointed the
 * other way: a declaration with nothing wiring it up is a claim that is false,
 * and the way to tell is to go and look.
 */
export function askingFor(input: {
  symbol: string
  handling: BankPostingHandling
  withheld?: Withheld
  /** Does the call site hand `bankGlAccountFor` a money currency? */
  passesMoneyCurrency: boolean
  /** Is a money currency in scope in the function body at all? */
  readsMoneyCurrency: boolean
  /** Does the body convert at a rate looked up for the day of the movement? */
  strikesAtDayRate: boolean
}): AskingVerdict {
  const { symbol, handling, withheld, passesMoneyCurrency, readsMoneyCurrency, strikesAtDayRate } =
    input

  if (handling === 'matched') {
    if (withheld !== undefined) {
      return {
        ok: false,
        why:
          `${symbol} is declared \`matched\`, so it does ask what currency the money is in — but ` +
          `it also declares \`withheld: '${withheld}'\`, which is a reason for not asking. Two ` +
          'answers to one question.',
      }
    }

    if (!passesMoneyCurrency) {
      return {
        ok: false,
        why:
          `${symbol} is declared \`matched\`, meaning it tells the guard what currency the money ` +
          'is in — and its call to `bankGlAccountFor` passes no money currency, so it gets the ' +
          'Phase 133 rule and refuses a foreign account exactly as before. A declaration nothing ' +
          'wires up is a claim that is false (Phase 49).',
      }
    }

    if (!strikesAtDayRate) {
      return {
        ok: false,
        why:
          `${symbol} is declared \`matched\`, so it may post when the money and the account ` +
          'agree — but nothing in it looks up a rate for the day the money moved, so the figure ' +
          'it posts to the bank is not what the statement will show. A path that may post has to ' +
          'post the right number.',
      }
    }

    return { ok: true }
  }

  if (passesMoneyCurrency) {
    return {
      ok: false,
      why:
        `${symbol} passes a money currency to \`bankGlAccountFor\`, so it can post when the ` +
        `money and the account agree — and \`BANK_POSTINGS\` declares it \`${handling}\`, which ` +
        'says it cannot. The registry and the code disagree about what this path does.',
    }
  }

  if (handling === 'converts') {
    if (withheld !== undefined) {
      return {
        ok: false,
        why:
          `${symbol} converts for the account, so there is nothing it is withholding — ` +
          `\`withheld: '${withheld}'\` is a reason a *refusing* path gives.`,
      }
    }
    return { ok: true }
  }

  if (withheld === undefined) {
    return {
      ok: false,
      why:
        `${symbol} refuses a foreign account and does not say why it cannot ask what currency ` +
        'the money is in. ADR 0136 answered that for all ten at once and got it wrong for five ' +
        'of them, so each one now answers for itself.',
    }
  }

  if (withheld === 'no-field' && readsMoneyCurrency) {
    return {
      ok: false,
      why:
        `${symbol} declares \`withheld: 'no-field'\` — nothing in scope says what currency the ` +
        'money is in — and its body reads one. That is the sentence ADR 0136 got wrong about ' +
        'five paths at once, argued from a fact that is not a fact (Phase 110).',
    }
  }

  if (withheld === 'no-day-rate' && !readsMoneyCurrency) {
    return {
      ok: false,
      why:
        `${symbol} declares \`withheld: 'no-day-rate'\`, which says the currency is in scope and ` +
        'the *rate* is the problem. Nothing in its body reads a money currency, so the reason it ' +
        "cannot ask is `'no-field'` and this declaration overstates what the path knows.",
    }
  }

  if (withheld === 'no-day-rate' && strikesAtDayRate) {
    return {
      ok: false,
      why:
        `${symbol} declares \`withheld: 'no-day-rate'\` and looks up a rate for the day the money ` +
        'moved. If that rate reaches the bank line, this path can be told the money’s currency ' +
        'and should be declared `matched`; if it does not, the declaration needs a reason that is ' +
        'true.',
    }
  }

  return { ok: true }
}
