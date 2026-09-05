import { denominatedProperties } from './inherited'

/**
 * Money on a screen, and what it is denominated in (Phase 124).
 *
 * ## The defect
 *
 * ADR 0123 nominated this and said why it could not reach it:
 *
 * > It does not reach a client component. `board.tsx` sums receipts in the
 * > browser and the scanner cannot see it, because a client component receives
 * > a plain type rather than reading a drizzle table. The repair there was made
 * > by hand, having been found by looking at the screen.
 *
 * Looking at the screen is not a strategy. Measured instead: **92 client
 * components, 94 prop types carrying money, 17 of which carry a currency
 * beside it and 77 of which do not.**
 *
 * That raw count is not the finding, for the same reason Phase 123's 145
 * reduces were not: most of that money is the company's own. A trial balance,
 * a budget, a drawer count and a depreciation schedule are all in one currency
 * by construction, and a currency prop on them would be noise.
 *
 * ## The rule that makes it decidable
 *
 * > **A currency travels with a document, and only a document has one.**
 *
 * Money that came off a table with a currency is a **face** amount: it belongs
 * to a customer's or supplier's document, two rows of a list can differ, and it
 * has to be shown wearing its own currency. Everything else is the company's own
 * money, and `formatCents`' default is right for it.
 *
 * ### Which tables those are, and the two ways of getting that wrong
 *
 * Phase 124 wrote here that "of every table these screens read, only five carry
 * a `currency` column", and named `deposits` among the tables that carry none.
 * **`deposits` has carried one since Phase 127** — added in the same migration
 * as `invoice_write_offs`, which the same sentence also missed — and so have
 * `financial_accounts`, `checkouts`, `payouts` and `refunds`. Thirteen, not
 * five. It is Phase 110's failure, the one Phase 128 named when it found the
 * same shape in three registry entries: a declaration argued from a schema fact
 * that is not a fact. `DOCUMENT_TABLES` comes from `CURRENCY_CARRIERS` now,
 * whose own test asks `information_schema` whether the list is complete.
 *
 * The second way is worse, because widening the list does not fix it: **a row's
 * currency can live one join away.** `bank_transactions` has no currency column
 * and never will; it takes the account's. Phase 128 wrote that down in prose and
 * made no rule out of it, so the transaction inbox — the screen this application
 * is mostly used through — was outside this scan by construction, and rendered
 * every row of a foreign account with a dollar sign from Phase 1 until Phase
 * 131. `INHERITED_CURRENCY` is the rule that sentence should have been.
 *
 * ## Why the default is where the damage happens
 *
 * `formatCents(cents, currency = 'USD')` labels anything with the company's
 * symbol if nobody says otherwise. That is correct for the books and wrong for
 * a document, and the two are indistinguishable at the call site — which is how
 * the deposits list came to render a €4,000 SEPA transfer as **"$4,000.00"**
 * (Phase 123, found by looking, fixed by hand).
 *
 * This file makes the distinction something a screen has to declare rather than
 * something the default decides.
 */

/** Where a figure on a screen got its denomination. */
export type MoneyBasis =
  /**
   * The row it came off carries its own currency, and two rows of one list can
   * disagree — so the figure must be shown wearing it.
   *
   * Five tables when Phase 124 wrote this rule: invoices, bills, credit notes,
   * payments and retainers. Seven since Phase 126 gave a recurring schedule and
   * its occurrences one. The name stays `document` because that is still what
   * the rule *means* — this is money somebody outside the business is quoted,
   * as against money the books are kept in.
   */
  | 'document'
  /**
   * It is the company's own money: a ledger balance, a budget, a till count, a
   * depreciation schedule. One currency by construction, so `formatCents`'
   * default is the right answer rather than a lucky one.
   */
  | 'books'
  /**
   * The denomination exists but is not written down (Phase 125).
   *
   * Three tables stored one number with **no currency column and no functional
   * twin** when this basis was added: `invoice_write_offs`, `deposits`, and
   * `recurring_invoice_occurrences`. Phase 126 closed the third and Phase 127
   * closed the other two, so **no entry carries this basis today**.
   *
   * It stays in the vocabulary rather than being deleted. The gap it names is
   * real and will recur the next time a table stores money without saying what
   * it is in — and ADR 0125 is the record of how much a phase can miss while
   * calling such a figure "probably fine". It is not a synonym for that: an
   * entry using it has to say where the answer actually lives.
   */
  | 'unrecorded'

/** One prop type that carries money across the server/client boundary. */
export type ScreenMoney = {
  /** The client component, as a repo-relative path. */
  file: string
  /** The prop type declared inside it. */
  type: string
  basis: MoneyBasis
  /**
   * Which of the type's money fields the basis applies to (Phase 125).
   *
   * A prop type is not always one kind of money. `billing/board.tsx`'s `Detail`
   * carries a raised invoice's `balanceCents` — a document's — beside the
   * schedule's own `totalCents` and `perOccurrenceCents`, which no table records
   * a currency for. Classifying the type as a whole made the check demand a
   * currency on all three, which would have been a second wrong answer rather
   * than a fix. Omit to mean every money field in the type.
   */
  fields?: readonly string[]
  /**
   * The field carrying the currency, when it is not called `currency`.
   *
   * A row nested inside a prop type names things for its own context: the
   * schedule history calls it `invoiceCurrency`, because the row is an
   * occurrence and the currency belongs to the invoice it raised. Defaults to
   * `currency`.
   */
  currencyField?: string
  /** Why it is that basis, argued from where the data comes from. */
  because: string
}

/**
 * The tables whose rows can be shown in something other than the company's own
 * money, as drizzle properties.
 *
 * Seven names typed out here until Phase 131, on the theory that this list is
 * "where somebody has to notice if a sixth ever grows one". Nobody did: Phase
 * 127 grew two and Phase 128 found four more that had been there for years,
 * and neither came back. A list a person maintains drifts the moment somebody
 * adds a column, which is what `CURRENCY_CARRIERS` exists to stop.
 *
 * `denominatedProperties()` is that registry plus the tables that inherit from
 * one. Both halves matter here and only here: a posting scan cares whether the
 * *module* touches foreign money, but a screen can only show a currency it can
 * reach, and `bank_transactions` reaches one through its account.
 */
export const DOCUMENT_TABLES: readonly string[] = denominatedProperties()

export const SCREEN_MONEY: readonly ScreenMoney[] = [
  {
    file: 'src/app/accounting/invoices/board.tsx',
    type: 'Duplicate',
    basis: 'document',
    because:
      'Two bills from one supplier that look like the same invoice. Bills carry a currency, and ' +
      'the page already passes `homeCurrency` to this board — so before Phase 124 a €4,000 pair ' +
      'from a German supplier was rendered with the company’s symbol beside a dollar pair, on the ' +
      'screen whose whole job is telling somebody which two documents to go and compare.',
  },
  {
    file: 'src/app/accounting/payables/board.tsx',
    type: 'Credit',
    basis: 'document',
    because:
      'Open vendor credit notes. `credit_notes.currency` is a face column, and Phase 122 made ' +
      '`vendorCreditBalances` group by it after a euro credit and a dollar credit were added into ' +
      'a number that came off a payment. The list they are chosen from still showed bare ' +
      'remainders until this phase.',
  },
  {
    file: 'src/app/settings/statements/board.tsx',
    type: 'DueRow',
    basis: 'books',
    because:
      'This one looks like the defect and is not, which is why it is written down. Beside it, ' +
      '`settings/chasing/board.tsx` has a `DueRow` carrying a currency — same name, adjacent ' +
      'screen — so the pair reads like one was forgotten. They are different rows: chasing lists ' +
      'individual overdue invoices, which are documents; this lists a customer, and ' +
      '`statement-run.ts` builds its balance by summing `invoices.functional_balance_cents` ' +
      '(Phase 56, refined in Phase 65). It is already converted, so the company’s symbol is the ' +
      'right one and a currency prop would be a second answer to a settled question.',
  },
  {
    file: 'src/app/settings/statements/board.tsx',
    type: 'HeldRow',
    basis: 'books',
    because:
      'The same screen and the same reasoning: `heldCreditCents` comes from a sum of ' +
      '`payments.functional_unapplied_cents`, which Phase 65 converted precisely so that a ' +
      'minimum-balance threshold could be applied to it. A held figure per customer is already ' +
      'in the company’s money before it leaves the module.',
  },
  {
    file: 'src/app/accounting/billing/board.tsx',
    type: 'Detail',
    basis: 'document',
    because:
      'Every money field, since Phase 126. Phase 125 narrowed this to `balanceCents` alone — the ' +
      'raised invoice’s, found by tracing the join in `billing/service.ts` — because a schedule ' +
      'carried no currency and its own totals were `unrecorded`. It does now, so `unitPriceCents`, ' +
      '`totalCents` and `perOccurrenceCents` are the schedule’s currency and `balanceCents` is the ' +
      'raised invoice’s, settled in one field by `occurrenceCurrency`. The narrowing is gone ' +
      'because the reason for it is.',
  },
  {
    file: 'src/app/accounting/receivables/board.tsx',
    type: 'WriteOff',
    basis: 'document',
    fields: ['amountCents', 'recoveredCents'],
    // Phase 127 gave the table its own currency column, so the row no longer
    // has to prove its denomination by a join to the invoice behind it.
    because:
      '`invoice_write_offs.amount_cents` carries no currency column, which is exactly what made ' +
      'this look like the books’ money. The write path settles it: `writeOffInvoice` calls ' +
      '`relieveFunctional(invoice, amountCents)` and posts `relief.functionalCents` to bad debt, ' +
      'so the stored figure is the invoice’s own and only the ledger sees a converted one. The ' +
      'comment above that line calls a write-off "the one balance reduction that converts exactly".',
  },
  {
    file: 'src/app/accounting/deposits/board.tsx',
    type: 'Deposit',
    basis: 'document',
    fields: ['receiptsCents'],
    because:
      'Phase 125 recorded this `unrecorded`: Phase 123 had made a deposit single-currency by ' +
      'refusing receipts that disagree, so the denomination was well defined and nothing wrote it ' +
      'down. Phase 127 did, because the posting needed it. `receiptsCents` is the customers’ own ' +
      'money and wears their currency; `functionalTotalCents` is what the bank account was debited ' +
      'and is the books’ — not because a financial account has no currency of its own, which ' +
      'Phase 127 claimed and Phase 128 found false, but because the ledger is kept in one ' +
      'currency and that is the side of the pair the ledger took.',
  },
  {
    file: 'src/app/accounting/billing/board.tsx',
    type: 'Forecast',
    basis: 'document',
    because:
      'Phase 125 recorded this `unrecorded`: a billing schedule had no currency column, so an ' +
      'occurrence total was whatever the line prices were typed in as and a forecast added those ' +
      'across schedules. Phase 126 gave the schedule one and the forecast reports its totals per ' +
      'currency rather than adding them, so the denomination is a fact on the row — which is what ' +
      'this basis means. The gap this entry declared is closed rather than restated.',
  },
  {
    file: 'src/app/bookkeeping/inbox.tsx',
    type: 'InboxRow',
    basis: 'document',
    because:
      'The account’s, one join away (Phase 131). `bank_transactions` has no currency column and ' +
      'takes `financial_accounts.currency`, and the inbox is not filtered to one account unless ' +
      'somebody asks — so two rows of this list can genuinely disagree, which is the whole test ' +
      'for this basis. `listInbox` already joined the account for its name and mask; it selects ' +
      'the currency beside them now. Until this the busiest screen in the application showed a ' +
      'euro statement with a dollar sign, and no scan could see it.',
  },
  {
    file: 'src/app/accounting/reconcile/[id]/workspace.tsx',
    type: 'Summary',
    basis: 'document',
    because:
      'Every figure here is off a bank statement or a sum of transactions on one, and a statement ' +
      'is printed in the bank’s money. None of them was ever wrong: a session is self-consistent ' +
      'in that currency and `summarize` converts nothing. `ReconciliationSummary` carries the ' +
      'account’s currency rather than the page looking it up beside the figures, so the screen ' +
      'cannot end up guessing when the lookup misses.',
  },
  {
    file: 'src/app/accounting/reconcile/[id]/workspace.tsx',
    type: 'Row',
    basis: 'document',
    because:
      'A transaction on the one account being reconciled, so it wears `summary.currency` rather ' +
      'than a copy of its own. That is deliberate: a session is for exactly one account, and ' +
      'putting the same string on every row would be a second answer to a question the summary ' +
      'above already settles — the shape Phase 116 spent a whole phase undoing elsewhere.',
  },
  {
    file: 'src/app/m/review/deck.tsx',
    type: 'Transaction',
    basis: 'document',
    because:
      'The same inherited currency as the inbox, on the phone (Phase 131). `reviewQueue` is the ' +
      'payload a phone downloads and holds for offline review, kept deliberately small — and one ' +
      'string per row is the right trade against handing somebody a figure wearing the wrong ' +
      'symbol and asking them to categorise it. It also writes `formatCents(Math.abs(...))`, ' +
      'which is why the scan learned to unwrap that call.',
  },
  {
    file: 'src/app/payroll/liabilities/form.tsx',
    type: 'Position',
    basis: 'books',
    because:
      'In reach only because the form lists bank accounts to pay from. `balanceCents` is what ' +
      '`liabilityPositions` says is owed on a chart account, summed from `journal_lines` — the ' +
      'ledger’s own money by definition, and the figure `recordRemittance` refuses to exceed. ' +
      'The account beside it is where the money leaves from, which is not what the figure is ' +
      'denominated in. `INHERITED_CURRENCY` says the same of `tax_remittances`, and names the ' +
      'gap that opens when that account is foreign.',
  },
  {
    file: 'src/app/settings/accounts/restatements.tsx',
    type: 'FaceValuePosting',
    basis: 'document',
    because:
      'A bank transaction that went into the books at its face value (Phase 130), so the account’s ' +
      'currency again. This row shows the same number twice on purpose — once wearing the ' +
      'account’s currency and once wearing the company’s — because that pair *is* the finding, ' +
      'and the second of them is declared in `NAME_COLLISIONS` rather than left to look like the ' +
      'defect it exists to report.',
  },
]

/**
 * Carriers measured but not classified: undeclared, and carrying no currency.
 *
 * The honest remainder, on the pattern Phase 121 used for the check it could
 * not falsify: a list with reasons beats a silence. Each is a prop type
 * carrying money named after a face column, on a screen whose modules touch a
 * table that has a currency — so the scan cannot rule it out, and only reading
 * the query behind it can say whether the figure arrives converted.
 *
 * ## Nothing computed this number until Phase 126
 *
 * Phase 124 recorded **19**, counted off a list that had since moved; Phase 125
 * traced all seventeen and put the remainder at **13**, which was right.
 *
 * But nothing checked it. The test asserted `UNCLASSIFIED_CARRIERS <= 13`
 * against a constant of 13 — true whatever the codebase does, and equally true
 * if the figure were 19 again. That is how Phase 124's error survived a green
 * suite for a whole phase. **A tripwire made of a number nobody measures is not
 * a tripwire**, however carefully the number was arrived at. The test runs the
 * scan now and compares exactly, so the figure can be wrong once and not twice.
 *
 * Twelve from Phase 126 to Phase 130: `billing/board.tsx`'s `Waiting` — periods
 * claimed on a schedule and left for a person to raise — was one of the
 * thirteen and now carries its occurrence's currency. The rest read no face
 * column at all: funds, inventory, properties, the shop, the import wizard,
 * unbilled time and the party and statement roll-ups. They are reached only
 * because a page imports a module that touches a currency-carrying table
 * somewhere else.
 *
 * ## Twenty-one since Phase 131, and this is the growth being said why for
 *
 * Correcting the table list from seven to twenty-four brought nine more pages
 * into reach: the asset register, budgets, dimensions, proposals, the chart of
 * accounts and the takings board. Every one of them reaches the new tables the
 * same way the twelve above do — a page imports a module that touches
 * `bank_transactions` somewhere else — and every one shows the company's own
 * money: a trial balance, a budget, a depreciation schedule, a day's till.
 *
 * They are not written up as `books` entries, and that is a decision rather
 * than laziness. Phase 124 built this remainder precisely so a screen nobody
 * doubts can be counted instead of argued, and nine arguments that all say "a
 * ledger balance is the ledger's money" would bury the six entries above that
 * say something. The four screens this phase found a defect on are declared;
 * these are counted.
 *
 * It may shrink. It must never grow without somebody saying why.
 */
export const UNCLASSIFIED_CARRIERS = 21

/**
 * Call sites where a face-column *name* appears on something that is not one.
 *
 * The scan matches by property name, because a `formatCents(row.remainingCents)`
 * gives no other clue about where the row came from. That is the limitation ADR
 * 0123 wrote down for the reduce scan, and it shows up here the same way: two
 * different things in one file can share a name.
 *
 * Each entry has to say what the money actually is. An exemption without an
 * argument is just the finding switched off.
 */
export type NameCollision = { file: string; expression: string; because: string }

export const NAME_COLLISIONS: readonly NameCollision[] = [
  {
    file: 'src/app/accounting/receivables/board.tsx',
    expression: 'badDebt.recoveredCents',
    because:
      'A different object from the `WriteOff` row beside it: `badDebtSummary` sums ' +
      '`invoice_write_offs.recovered_cents` across every write-off. It is excused from **this** ' +
      'check because it is not a document row — and it is not excused from being wrong. Those ' +
      'stored amounts are each in their own invoice’s currency (see the `WriteOff` entry), so the ' +
      'roll-up adds currencies. Phase 122’s scanner never saw it because `invoice_write_offs` is ' +
      'not a face table. Phase 127 gave it one — and a functional twin — and `badDebtSummary` sums ' +
      '`functional_recovered_cents` now, so the roll-up is the books’ money and agrees with the ' +
      'profit and loss beside it. The excuse stands; the defect it recorded is closed.',
  },
  {
    file: 'src/app/accounting/payables/board.tsx',
    expression: 'plan.remainingCents',
    because:
      'Not a credit note. `plan` is the pay-run plan, and `remainingCents` is what would be left ' +
      'in the **bank account** after the run — a ledger balance, which is the company’s own money ' +
      'by definition. It sits three lines from `formatCents(account.availableCents)`, which is the ' +
      'same figure before the run, and neither wants a document’s currency. The credit notes on ' +
      'this same screen do, and they are declared above.',
  },
  {
    file: 'src/app/settings/accounts/restatements.tsx',
    expression: 'row.amountCents',
    because:
      'The one place a bare `formatCents` is the point rather than the defect. The row reads ' +
      '"€4,000.00 in the books as $4,000.00" — the first wearing the account’s currency, the ' +
      'second deliberately wearing the company’s, because what it is reporting is precisely that ' +
      'the ledger took a face amount as though it were functional. Passing the account’s currency ' +
      'to the second would erase the finding while appearing to fix it.',
  },
]

/** Whether a call site is a known name collision rather than a document's money. */
export function nameCollisionFor(file: string, expression: string): NameCollision | null {
  return (
    NAME_COLLISIONS.find((row) => row.file === file && row.expression === expression) ?? null
  )
}

/** What a screen's money is denominated in. Throws on a prop type nobody classified. */
export function screenMoneyFor(file: string, type: string): ScreenMoney {
  const found = SCREEN_MONEY.find((row) => row.file === file && row.type === type)
  if (!found) {
    throw new Error(
      `No basis is declared for ${type} in ${file}. Money reaching a screen has to say whether ` +
        'it came off a document — which carries its own currency — or out of the books, which ' +
        'are in the company’s. Nothing else can tell the two apart at the call site.',
    )
  }
  return found
}
