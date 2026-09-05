import { RegistryError } from '@/modules/errors/registry'
import { isForeign } from './rates'

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
 * account. Measured across
 * `src/modules`, `financial_accounts.currency` is read in seven places — the
 * bank feed, three screens, the accounts module, the AI retrieval and the sync.
 * **Not one of the ten that needed it is among them.** The three that do read it
 * are the bank feed, its transfer pair, its restatement and banking deposits.
 * The feed learned
 * to ask in Phase 128; nothing else did.
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
 * new rate decisions, ten UI changes and ten ways to get it wrong,
 * built speculatively for accounts that mostly do not exist yet. Refusing means
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
}): BankSide {
  const { accountName, accountCurrency, homeCurrency, what } = input

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
 */
export type BankPostingHandling = 'converts' | 'refuses'

export type BankPosting = {
  /** The module, as a repo-relative path. */
  file: string
  /** The function that posts. */
  symbol: string
  handling: BankPostingHandling
  /** Why it is that, argued from what the path can and cannot know. */
  because: string
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
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'receivePledge',
    handling: 'refuses',
    because:
      'A donation arriving. The amount is what the donor gave and the account is where it landed, ' +
      'and nothing joins the two: a euro gift into a euro account would post the euro figure to a ' +
      'dollar ledger, which is Phase 127’s defect exactly, one module over.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'receiveDeposit',
    handling: 'refuses',
    because:
      'A tenant’s security deposit into a bank account — somebody else’s money, which Phase 23 ' +
      'was careful to keep as a liability rather than income. The care stops at the currency: the ' +
      'figure is typed by a person and the account is chosen from a list that includes foreign ones.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    handling: 'refuses',
    because:
      'The other end of the same act, and refused for the same reason. Returning it is the half ' +
      'where getting the currency wrong is worst: the liability was raised at one figure and ' +
      'relieving it at another leaves a balance no tenant can be shown.',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'importPayouts',
    handling: 'refuses',
    because:
      'What the card processor actually paid into a bank account. `payouts` carries a currency of ' +
      'its own (Phase 128 declared it), so this is the path closest to being able to convert — ' +
      'and it still does not, because nothing compares the payout’s currency to the account’s. ' +
      'It refuses rather than trusting that a processor settles into a matching account.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'recoverWriteOff',
    handling: 'refuses',
    because:
      'Money arriving against a debt already written off. Phase 127 fixed the *other* side of ' +
      'this entry — it posts `recovery.functionalCents` to bad debt now rather than the face ' +
      'amount — and left the bank side taking the same functional figure into whatever account ' +
      'was named. Right for the expense, unasked for the account.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'refundVendorCredit',
    handling: 'refuses',
    because:
      'A supplier giving money back. `recovery.receivedCents` is what they sent, and the currency ' +
      'it is in comes from the credit note rather than the account it was banked into — two ' +
      'currencies in one entry with nothing checking they are the same.',
  },
  {
    file: 'src/modules/receivables/customer-credit.ts',
    symbol: 'refundCredit',
    handling: 'refuses',
    because:
      'Giving a customer their overpayment back. Phase 67 was careful that held money goes back ' +
      'at the rate it came in at and named the realised gap where a gap belongs — all of which is ' +
      'about the *credit’s* currency, and none of which asks what the account paying it is held in.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'receiveRetainer',
    handling: 'refuses',
    because:
      'Client money arriving on account. The comment above the posting already says the right ' +
      'thing — "the ledger is never in the client’s currency; posting the face amount would put ' +
      '€10,000 on a dollar balance sheet" — and it is about the retainer. The account it lands ' +
      'in was never part of that sentence.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'refundRetainer',
    handling: 'refuses',
    because:
      'Giving held client money back. Phase 67 built this to release at the rate the money was ' +
      'carried at and post the difference, which settles the retainer’s side completely. The bank ' +
      'side takes `paidCents` into an account whose currency is not consulted.',
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
