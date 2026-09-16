import { RegistryError } from '@/modules/errors/registry'
import { isForeign } from './rates'
import type { Withheld } from './asking'

/**
 * The currency of the account money lands in (Phase 133).
 *
 * ## The question nobody asked
 *
 * Phase 127 built `LEDGER_POSTINGS`, which asks every site that reaches
 * `debitCents` or `creditCents`: **is this figure the company's own money?** It
 * is a good question and it caught two real defects.
 *
 * There is a second question it cannot ask. A ledger line names an account, and
 * one kind of account is held somewhere real:
 *
 * > **The figure can be right and the entry still wrong, because the account it
 * > lands on is held in a currency nobody asked about.**
 *
 * Nineteen postings in fourteen functions land on a bank account's ledger
 * account. Measured across `src/modules`, `financial_accounts.currency` is read
 * in seven places — the bank feed, three screens, the accounts module, the AI
 * retrieval and the sync. **Not one of the ten that need it is among them.**
 *
 * Four of the fourteen know the account they post to: the feed, its transfer
 * pair, its restatement, and banking deposits. Every one of those is the feed or
 * something built on it. The feed learned to ask in Phase 128; nothing else did.
 *
 * ## What goes wrong
 *
 * Remit a payroll liability of $1,200 from a euro account. `recordRemittance`
 * refuses an amount larger than the ledger says is owed, so the figure is
 * measured against a ledger balance and is genuinely the company's own money —
 * `LEDGER_POSTINGS` is right to call it `domestic`. The entry balances. And it
 * asserts that $1,200 left an account that deals in euros, when what left was
 * €1,100 worth $1,210 on the day.
 *
 * So the bank ledger account is understated, no realised difference is posted,
 * and — the part that makes it undiscoverable — **the person was never asked
 * what actually left.** There is no field for it. The path has no way to be
 * right.
 *
 * ## Why this refuses rather than converts
 *
 * Phase 117's rule: a refusal beats a check. Converting the ten would mean ten
 * new rate decisions, ten UI changes and ten ways to get it wrong, built
 * speculatively for accounts that mostly do not exist yet. Refusing means
 * a business with a euro account is told which paths cannot yet handle it,
 * instead of being given entries nobody can defend.
 *
 * That is a real limitation and it is stated as one. It is better than the
 * alternative on the only test that matters here: **a refusal a person reads is
 * worth more than a number nobody can trace**, which is the sentence Phase 117
 * used and Phase 129 proved twice over.
 *
 * A domestic account is untouched. `isForeign` is false, and every one of these
 * paths behaves exactly as it did — which is why this went a hundred and thirty
 * phases without being noticed.
 */

/** What a path may do with the bank account it was handed. */
export type BankSide = { ok: true } | { ok: false; why: string }

/**
 * Whether money may be posted into this account's ledger account.
 *
 * `what` names the act in the words the person used — "remit this liability",
 * "record this deposit" — because a refusal that says "operation failed" makes
 * somebody guess which of the four things they just did was refused.
 */
export function mayPostToBank(input: {
  accountName: string
  accountCurrency: string
  homeCurrency: string
  what: string
  /**
   * The currency the money itself is in, when the path knows it (Phase 136).
   *
   * Omitted by the paths that do not. Nine of the ten Phase 133 refused have no
   * field for it — a person typed an amount and chose an account, and nothing
   * asked what currency the amount was in — so for them the old rule stands and
   * a foreign account is refused.
   */
  moneyCurrency?: string
}): BankSide {
  const { accountName, accountCurrency, homeCurrency, what, moneyCurrency } = input

  // The money and the account agree, whatever the books are kept in.
  //
  // This is the bank feed's shape, and the feed has been doing it correctly
  // since Phase 128: `bank_transactions` inherits its currency from
  // `financial_accounts`, so the money *is* the account's currency, and the
  // ledger takes the converted figure at a recorded rate. Nothing is unknown.
  // The statement will show what the feed shows, and Phase 40's tie-out — which
  // compares each account in its own currency — agrees.
  if (moneyCurrency !== undefined && !isForeign(moneyCurrency, accountCurrency)) {
    return { ok: true }
  }

  // The money and the account disagree, and somebody else did the conversion.
  //
  // A €96.80 payout into a dollar account was converted by the *bank*, at the
  // bank's rate on the bank's terms, and we do not have that rate. Converting
  // at ours produces an estimate of somebody else's arithmetic: the statement
  // will show what the bank decided, the ledger will hold what we guessed, and
  // the tie-out will differ by the spread with nothing to name it.
  if (moneyCurrency !== undefined && isForeign(moneyCurrency, accountCurrency)) {
    return {
      ok: false,
      why:
        `${what} would put ${moneyCurrency} into ${accountName}, which is held in ` +
        `${accountCurrency}. The bank converts that at its own rate on the day, and these books ` +
        'do not have that rate — so any figure posted here is a guess at somebody else’s ' +
        `arithmetic, and the statement will not agree with it. Use a ${moneyCurrency} account, or ` +
        'enter what the bank actually credited as a journal entry that says the rate.',
    }
  }

  if (!isForeign(accountCurrency, homeCurrency)) return { ok: true }

  return {
    ok: false,
    why:
      `${accountName} is held in ${accountCurrency} and these books are kept in ${homeCurrency}, ` +
      `so ${what} would put a ${homeCurrency} figure against an account that moves in ` +
      `${accountCurrency} — without recording what actually left it. Use a ${homeCurrency} ` +
      'account, or post it by hand as a journal entry that says what the rate was.',
  }
}

/**
 * Where money reaches a bank account's ledger account, and whether the path can
 * cope with that account being foreign.
 *
 * The registry-with-prose device, Phase 101's, for the same reason as
 * `LEDGER_POSTINGS` beside it: a bare list of fourteen file names is a fact that
 * looks the same whether it is right or wrong.
 *
 * Two answers only, and the second is the interesting one:
 *
 * - `converts` — the path knows the account's currency and says what moved in
 *   it. Four do, and they are the feed and what is built on it.
 * - `refuses` — the path has no way to say what left the account, so it
 *   declines rather than posting a figure nobody can trace.
 *
 * There is deliberately no `domestic-only, unchecked` answer. That is what ten of
 * the fourteen were before this phase, and it is the thing being fixed.
 *
 * `matched` is Phase 136's, added rather than folded into either neighbour
 * (Phase 130's rule: argue a new value, do not bend the nearest). A path is
 * `matched` when it knows the currency the money is in and can therefore tell
 * two situations apart that `converts` and `refuses` each flatten:
 *
 * - the money and the account agree — the bank feed's shape, converted at a
 *   recorded rate, nothing unknown;
 * - they disagree — the **bank** converted, at its own rate, and posting ours
 *   would be a guess at somebody else's arithmetic.
 *
 * Calling that `converts` would claim it always posts; calling it `refuses`
 * would claim it never does. Both are false half the time.
 *
 * Knowing the currency is necessary and not sufficient. A `matched` path must
 * also strike its bank line at the rate on the day the money moved, because
 * that is the figure the statement will show — and `askingFor` measures that
 * from the source rather than taking the declaration's word for it. Phase 136
 * shipped with one `matched` path and part 3 measured four more, plus one —
 * `recoverWriteOff` — that had the currency and failed the rate test, and was
 * left refusing with the reason recorded. Phase 151 wired `recoverHeld` into
 * it, which gave it a day rate and a realised line, so it is the sixth
 * `matched` path and the only entry here whose handling has ever changed.
 */
export type BankPostingHandling = 'converts' | 'refuses' | 'matched'

export type BankPosting = {
  /** The module, as a repo-relative path. */
  file: string
  /** The function that posts. */
  symbol: string
  handling: BankPostingHandling
  /** Why it is that, argued from what the path can and cannot know. */
  because: string
  /**
   * Why a refusing path does not ask what currency the money is in (Phase 136,
   * part 3). Absent on `converts` and `matched`, which do not refuse.
   *
   * ADR 0136 answered this for all ten refusing paths in one sentence — "the
   * other nine have no such field" — and it was false for five of them. So each
   * one answers for itself now, and `askingFor` measures the answer against the
   * source rather than believing it.
   */
  withheld?: Withheld
}

export const BANK_POSTINGS: readonly BankPosting[] = [
  {
    file: 'src/modules/ledger/posting.ts',
    symbol: 'buildLines',
    handling: 'converts',
    because:
      'The bank feed, and the only path that has always known the account it posts to. Phase 128 ' +
      'found it posting face amounts into a functional ledger and Phase 129 made it record the ' +
      'rate it used, so it converts and says what it converted at. It is the shape the ten that ' +
      'refuse would have to grow into.',
  },
  {
    file: 'src/modules/ledger/posting.ts',
    symbol: 'syncLedgerForTransferPair',
    handling: 'converts',
    because:
      'A transfer between two of the company’s own accounts, and the only posting that lands on ' +
      'two bank ledger accounts at once. Phase 129 made it write the rate on both legs, signed ' +
      'the way each statement reads it, so each side knows its own account’s currency — which is ' +
      'exactly the knowledge the ten that refuse do not have.',
  },
  {
    file: 'src/modules/ledger/restate.ts',
    symbol: 'restatePosting',
    handling: 'converts',
    because:
      'Phase 130’s correction to a feed posting. It reads the transaction’s stored rate and ' +
      'functional twin and posts the difference, so it inherits the feed’s knowledge of the ' +
      'account rather than needing its own — and it is refused by `mayRestate` when the ' +
      'transaction has no pair to restate.',
  },
  {
    file: 'src/modules/banking/deposits.ts',
    symbol: 'createDeposit',
    handling: 'converts',
    because:
      'Banking a batch of receipts. Phase 127 gave `deposits` a functional twin because this ' +
      'posting needed one, and Phase 123 made a deposit single-currency by refusing receipts that ' +
      'disagree — so the face sum and its functional value are both on the row before the entry ' +
      'is written.',
  },
  {
    file: 'src/modules/payroll/remittance.ts',
    symbol: 'recordRemittance',
    handling: 'refuses',
    because:
      'The one ADR 0131 and ADR 0132 both named. The amount is refused unless it is no larger ' +
      'than what `liabilityPositions` says the ledger account owes, so it is measured against a ' +
      'ledger balance and is the books’ money — right by `LEDGER_POSTINGS` and still wrong ' +
      'against a euro account, because nothing asks what left it and there is no field to say.',
    withheld: 'no-field',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'receivePledge',
    handling: 'refuses',
    because:
      'A donation arriving. The amount is what the donor gave and the account is where it landed, ' +
      'and nothing joins the two: a euro gift into a euro account would post the euro figure to a ' +
      'dollar ledger, which is Phase 127’s defect exactly, one module over.',
    withheld: 'no-field',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'receiveDeposit',
    handling: 'refuses',
    because:
      'A tenant’s security deposit into a bank account — somebody else’s money, which Phase 23 ' +
      'was careful to keep as a liability rather than income. The care stops at the currency: the ' +
      'figure is typed by a person and the account is chosen from a list that includes foreign ones.',
    withheld: 'no-field',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    handling: 'refuses',
    because:
      'The other end of the same act, and refused for the same reason. Returning it is the half ' +
      'where getting the currency wrong is worst: the liability was raised at one figure and ' +
      'relieving it at another leaves a balance no tenant can be shown.',
    withheld: 'no-field',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'importPayouts',
    handling: 'matched',
    because:
      'What the card processor actually paid into a bank account, and the only entry here that ' +
      'has moved twice. Phase 134 made the figure convert; Phase 136 made it ask the question ' +
      'Phase 133 could not, because `payouts.currency` says what the processor sent and no other ' +
      'path has a field for it. A euro payout into a euro account is the feed’s shape and posts. ' +
      'A euro payout into a dollar account is refused: the bank converted it at the bank’s rate, ' +
      'these books do not have that rate, and Phase 40’s tie-out would differ by the spread with ' +
      'nothing to name it. Phase 134 had those two exactly the wrong way round.'
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'recoverWriteOff',
    handling: 'matched',
    because:
      'Money arriving against a debt already written off, and the sixth path that may be told ' +
      'what currency it is in. It was `refuses` with `withheld: \'no-day-rate\'` from Phase 136 ' +
      'until Phase 151 wired it: `writeOff.currency` was right there, and the figure reaching the ' +
      'bank was struck at the write-off’s *carried* rate rather than the rate on the day the ' +
      'money arrived, so one figure was answering two questions and passing a currency would have ' +
      'bought a posting nobody could tie to a statement. `recoverHeld` separates them — the bank ' +
      'takes the day’s rate, bad debt keeps the carried one, and the difference is realised — so ' +
      'the reason for withholding is gone and the currency goes through.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'refundVendorCredit',
    handling: 'matched',
    because:
      'A supplier giving money back. `recovery.receivedCents` is what they sent, and the currency ' +
      'it is in comes from the credit note rather than the account it was banked into — which ' +
      'ADR 0136 called "two currencies in one entry with nothing checking they are the same" and ' +
      'Phase 136 part 3 turned into the check. `note.currency` was already being read to look up ' +
      'the day’s rate; it is now also handed to the guard, so a euro refund into a euro account ' +
      'posts and one into a dollar account is refused. The bank line was already struck at the ' +
      'rate on the day — its own comment says "the figure the statement will show" — which is ' +
      'exactly what makes it safe to ask.',
  },
  {
    file: 'src/modules/receivables/customer-credit.ts',
    symbol: 'refundCredit',
    handling: 'matched',
    because:
      'Giving a customer their overpayment back. Phase 67 was careful that held money goes back ' +
      'at the rate it came in at and named the realised gap where a gap belongs — all of which ' +
      'was about the *credit’s* currency, and none of which asked what the account paying it is ' +
      'held in. Phase 136 part 3 joined the two: `payment.currency` already drove the day’s rate ' +
      'for `paidCents`, and now also tells the guard what is leaving, so a euro refund out of a ' +
      'euro account posts and out of a dollar account is refused.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'receiveRetainer',
    handling: 'matched',
    because:
      'Client money arriving on account. The comment above the posting already said the right ' +
      'thing — "the ledger is never in the client’s currency; posting the face amount would put ' +
      '€10,000 on a dollar balance sheet" — and it was about the retainer; the account it lands ' +
      'in was never part of that sentence. Phase 136 part 3 made it part of it. The one `matched` ' +
      'path with no realised gain line, and it is right not to have one: arrival is the moment ' +
      'the rate is set, so `functionalCents` is struck at the day’s rate by construction and ' +
      'there is no carried figure for it to differ from.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'refundRetainer',
    handling: 'matched',
    because:
      'Giving held client money back. Phase 67 built this to release at the rate the money was ' +
      'carried at and post the difference, which settles the retainer’s side completely, while ' +
      'the bank side took `paidCents` into an account whose currency was not consulted. It is ' +
      'now: `retainer.currency` is what the client is owed and what leaves the bank, and its own ' +
      'comment already named the rule this phase turns on — "what leaves the bank, at the rate on ' +
      'the day the money moves, because that is what the statement will say".',
  },
]

/**
 * What a posting site declares, or a refusal.
 *
 * Throws on an undeclared site, the device Phase 101 set — and a
 * `RegistryError` since Phase 132, which is why this file does not need an
 * allowlist entry of its own.
 */
export function bankPostingFor(file: string, symbol: string): BankPosting {
  const found = BANK_POSTINGS.find((row) => row.file === file && row.symbol === symbol)

  if (!found) {
    throw new RegistryError({
      registry: 'BANK_POSTINGS',
      key: `${file}:${symbol}`,
      message:
        `No bank posting handling is declared for ${symbol} in ${file}. A function that posts ` +
        'into a bank account’s ledger account has to say whether it can cope with that account ' +
        'being foreign, or refuse when it is.',
    })
  }

  return found
}
