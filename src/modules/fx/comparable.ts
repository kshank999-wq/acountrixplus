/**
 * When a sum of money may be added up, and when it may not (Phase 122).
 *
 * ## The defect
 *
 * Phase 65 closed "the three sums that still add currencies". Phase 115 found
 * the integrity register doing the same thing — `receivables.customer_credit`
 * summing held amounts in the currency each payment was taken in and comparing
 * the total against a functional ledger balance — and repaired it. Phase 116
 * built `PAIRED_COLUMNS` so every face amount would have a functional twin, and
 * a constraint keeping the pair honest.
 *
 * None of that stopped it happening somewhere else, because nothing looked.
 * Measured across `src/modules` — every `sum()` of a face-amount column,
 * classified by whether the query groups or filters by currency:
 *
 * ```
 * currency-aware   4
 * currency-blind   8   in six files
 * ```
 *
 * Two of the eight decide money rather than describe it:
 *
 * - **`vendorCreditBalances`** totals what each supplier owes back, and the pay
 *   run nets it against what is owed to them. A €500 credit and a $500 credit
 *   became "1000" of nothing, and that number came off a payment.
 * - **`assistants.ts`** computes revenue concentration — the largest client's
 *   share — by adding invoice totals across currencies and dividing. The
 *   percentage it advises a business on is arithmetic on incomparable things.
 *
 * The rest report rather than decide: a cash-basis figure, two deactivation
 * refusals, two till takings.
 *
 * ## The rule
 *
 * A face amount is denominated in the document's own currency. Adding two of
 * them is only meaningful if they are **the same** currency. So a sum of a face
 * column must do one of three things, and say which:
 *
 * 1. **Group by currency**, so each total is one currency and says so. What
 *    Phase 61 did for statements and Phase 62 for chasing.
 * 2. **Convert first**, summing the functional twin — or, where there is none,
 *    `convert(amount, rate)` at read time, which is what Phase 115 did for the
 *    payments list.
 * 3. **Be provably one currency already**, in which case it says why here.
 *
 * ## `payments.amount_cents` has no twin at all
 *
 * `PAIRED_COLUMNS` pairs `unapplied_cents` with `functional_unapplied_cents`,
 * and notes that a payment "stores its rate and `amount_cents` but no converted
 * total". So the whole amount of a payment can only be made comparable by
 * converting it at read time. That is the trap in four of the eight sites, and
 * it is why this file names the column explicitly rather than deriving the list
 * from `PAIRED_COLUMNS` alone.
 */

/**
 * Which money a column holds (Phase 143).
 *
 * `FACE_COLUMNS` was seventeen names typed by hand. The schema has **fifty-three**
 * money columns on currency-carrying tables, and the thirty-six nobody classified
 * were invisible to both scans — including the one a 1099 is filed on.
 */
export type MoneySide =
  /**
   * The document's own currency. Adding two of these is only meaningful when
   * they are the same currency, which is what the scans exist to ask.
   */
  | 'face'
  /**
   * Already the company's own money, whatever the row's `currency` says.
   *
   * `refunds.carried_cents` is "functional, off the balance being cleared, at
   * its carried rate" — the schema says so in those words. Summing these across
   * rows is legitimate, so the scans must not ask about them.
   */
  | 'functional'
  /**
   * The account's own currency, not any document's.
   *
   * A bank balance and a reconciliation are denominated in what the account
   * holds. They are comparable within one account and nowhere else, which is a
   * different question from the one `face` asks — `cashTieOut` argues exactly
   * this in `SAFE_FACE_SUMS` and is right to.
   */
  | 'account'

/** A money column on a currency-carrying table, and which money it holds. */
export type MoneyColumn = {
  table: string
  column: string
  side: MoneySide
  /** The column holding the same amount in company currency, if there is one. */
  functionalColumn: string | null
  because: string
}

/** A column holding an amount in the document's own currency. */
export type FaceColumn = MoneyColumn & { side: 'face' }

export const MONEY_COLUMNS: readonly MoneyColumn[] = [
  {
    table: 'invoices',
    column: 'total_cents',
    side: 'face',
    functionalColumn: 'functional_total_cents',
    because: 'What the customer was billed, in what they were billed in.',
  },
  {
    table: 'invoices',
    column: 'balance_cents',
    side: 'face',
    functionalColumn: 'functional_balance_cents',
    because: 'What is still owed on it, in the same currency as the bill.',
  },
  {
    table: 'bills',
    column: 'total_cents',
    side: 'face',
    functionalColumn: 'functional_total_cents',
    because: 'What the supplier invoiced, in their currency.',
  },
  {
    table: 'bills',
    column: 'balance_cents',
    side: 'face',
    functionalColumn: 'functional_balance_cents',
    because: 'What is still owed to them, in the currency the supplier invoiced in.',
  },
  {
    table: 'credit_notes',
    column: 'total_cents',
    side: 'face',
    functionalColumn: 'functional_total_cents',
    because: 'What was credited, in the currency of the document it credits.',
  },
  {
    table: 'credit_notes',
    column: 'remaining_cents',
    side: 'face',
    functionalColumn: 'functional_remaining_cents',
    because:
      'What is left to spend of it. Summed per supplier by the pay run, which is why adding ' +
      'two currencies here takes money off a payment.',
  },
  {
    table: 'payments',
    column: 'unapplied_cents',
    side: 'face',
    functionalColumn: 'functional_unapplied_cents',
    because: 'Money held that has not met an invoice yet, in the currency it arrived in.',
  },
  {
    table: 'payments',
    column: 'amount_cents',
    side: 'face',
    // The one with no twin, and the reason this list is written out rather
    // than derived from PAIRED_COLUMNS.
    functionalColumn: null,
    because:
      'The whole receipt, in the currency it was taken in. A payment stores its rate but no ' +
      'converted total, so the only way to make this comparable is to convert it at read time.',
  },
  {
    table: 'retainers',
    column: 'remaining_cents',
    side: 'face',
    functionalColumn: 'functional_remaining_cents',
    because: 'Client money on account, in the currency it was put on account in.',
  },
  {
    table: 'invoice_write_offs',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: 'functional_amount_cents',
    because:
      'What was written off, in the invoice’s own currency. ADR 0125 traced this and could not ' +
      'give it a twin; Phase 127 did, because `badDebtSummary` was adding write-offs across ' +
      'currencies and a recovery had no carried figure to reverse.',
  },
  {
    table: 'invoice_write_offs',
    column: 'recovered_cents',
    side: 'face',
    functionalColumn: 'functional_recovered_cents',
    because:
      'What later turned up, in the same currency as the debt. Posting this unconverted is what ' +
      'left $250 of bad-debt expense on a fully recovered €2,500 write-off (Phase 127).',
  },
  {
    table: 'deposits',
    column: 'total_cents',
    side: 'face',
    functionalColumn: 'functional_total_cents',
    because:
      'What the paying-in slip says, in the receipts’ currency — single since Phase 123 refused ' +
      'to bank two. The twin is what hit the bank, and it is what the ledger carries.',
  },
  {
    table: 'deposits',
    column: 'receipts_cents',
    side: 'face',
    functionalColumn: 'functional_receipts_cents',
    because:
      'The receipts’ own sum, before other lines and fees. Crediting Undeposited Funds this ' +
      'figure rather than its twin left $50 of a €500 receipt in a clearing account (Phase 127).',
  },
  {
    table: 'bank_transactions',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: 'functional_amount_cents',
    because:
      'What the statement says, in whatever currency the account is held in — a bank transaction ' +
      'has no currency of its own and inherits the account’s. The twin is what the books took for ' +
      'it, written down at the moment of posting since Phase 129 rather than derived twice.',
  },
  {
    table: 'checkouts',
    column: 'gross_cents',
    side: 'face',
    functionalColumn: 'functional_gross_cents',
    because:
      'What the customer was asked to pay, in the invoice’s currency — `checkouts.currency` is ' +
      '`invoice.currency`, so a euro invoice paid by card makes a euro checkout. The twin is what ' +
      'the capture debited to `1250 Payments in Transit` (Phase 134).',
  },
  {
    table: 'checkouts',
    column: 'fee_cents',
    side: 'face',
    functionalColumn: 'functional_fee_cents',
    because:
      'What the processor kept, in the same currency it charged. Its own twin rather than a share ' +
      'of the gross, because the fee is posted as a separate entry and the clearing account has to ' +
      'be relieved of what each entry actually put through it.',
  },
  {
    table: 'payouts',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: 'functional_amount_cents',
    because:
      'What the processor says it deposited, in its own currency — the figure the bank statement ' +
      'will show. The twin is what the bank account took for it at the arrival rate, which is a ' +
      'different rate from the capture and the gap between them is a realised gain.',
  },
  {
    table: 'invoices',
    column: 'subtotal_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The invoice before tax, in the currency it was raised in. No functional twin: only the total and the balance were paired in Phase 116, so anything summing this across customers is adding whatever currencies they were billed in.',
  },
  {
    table: 'invoices',
    column: 'tax_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'Tax on the invoice, in the invoice\'s currency. Summed by `cashBasisCaveats` across every invoice — which is where a euro tax figure and a dollar one become one number that describes neither.',
  },
  {
    table: 'invoices',
    column: 'retainage_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'Money withheld under a construction contract until the work is signed off, in the invoice\'s own currency. Phase 50\'s, and denominated wherever the job is.',
  },
  {
    table: 'invoice_lines',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A line of an invoice, in the invoice\'s currency — `invoice_lines` inherits it, which is why the table is in `INHERITED_CURRENCY`. Comparable within one document and nowhere else.',
  },
  {
    table: 'invoice_lines',
    column: 'unit_price_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The price before quantity, in the invoice\'s currency. A per-unit figure is still money and still denominated.',
  },
  {
    table: 'invoice_costings',
    column: 'cost_cents',
    side: 'functional',
    functionalColumn: null,
    because:
      'What the stock consumed on an invoice line cost. Inventory is valued in the company\'s own money whatever currency the invoice is raised in — the cost came out of a lot bought in home currency — so this is already functional and adding it across invoices is sound.',
  },
  {
    table: 'bills',
    column: 'subtotal_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The payables twin of the invoice subtotal, and the same omission: paired only at the total and balance, so the components were never classified.',
  },
  {
    table: 'bills',
    column: 'tax_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'Tax on a supplier\'s bill, in the supplier\'s currency.',
  },
  {
    table: 'bills',
    column: 'retainage_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'Withheld from a subcontractor, in the bill\'s currency.',
  },
  {
    table: 'bill_lines',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A line of a bill, in the bill\'s currency, inherited the same way invoice lines are.',
  },
  {
    table: 'bill_lines',
    column: 'unit_price_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The per-unit price on a bill line, in the bill\'s currency.',
  },
  {
    table: 'credit_notes',
    column: 'subtotal_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A credit note is denominated by the document it reverses (Phase 63), and so is every part of it.',
  },
  {
    table: 'credit_notes',
    column: 'tax_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The tax being credited back, in the note\'s currency.',
  },
  {
    table: 'credit_note_lines',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A line of a credit note, inheriting the note\'s currency.',
  },
  {
    table: 'credit_note_lines',
    column: 'unit_price_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The per-unit figure on a credit note line.',
  },
  {
    table: 'credit_applications',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'How much of a credit note was applied to a document, in the note\'s currency. Phase 137 found the two applications posting at two rates; this is the column that records what was applied, and it had no classification at all.',
  },
  {
    table: 'recurring_invoice_lines',
    column: 'unit_price_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A template line for a billing schedule, in the currency the schedule raises invoices in.',
  },
  {
    table: 'recurring_invoice_occurrences',
    column: 'total_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'What one occurrence of a schedule came to, in the schedule\'s currency.',
  },
  {
    table: 'payment_applications',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      '**What a payment settled of one document, in that document\'s currency.** Undeclared until Phase 143, and this is the column `contractorPayments` sums to decide whether a contractor crosses the 1099 threshold — so a 1099 was being filed on a total that adds whatever currencies the vendor was paid in, against a threshold in dollars.',
  },
  {
    table: 'retainers',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'What was received on account, in the client\'s currency. `remaining_cents` was declared in Phase 122 and its sibling was not, so half the retainer was classified.',
  },
  {
    table: 'retainer_applications',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'A draw against a retainer, in the retainer\'s currency — the schema says so: "In the client\'s currency — what the retainer itself is denominated in."',
  },
  {
    table: 'retainer_applications',
    column: 'carried_cents',
    side: 'functional',
    functionalColumn: null,
    because:
      'Functional, off the liability, at the rate the money has been carried at since it came in (Phase 112). The schema states it and the column exists precisely so the held position can be stated for any day; summing it across clients is sound.',
  },
  {
    table: 'refunds',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'What was handed back, in the other party\'s currency — the schema says exactly that, and Phase 69 added `refunds.currency` because every reader had to join back to find out.',
  },
  {
    table: 'refunds',
    column: 'carried_cents',
    side: 'functional',
    functionalColumn: null,
    because:
      '"Functional, off the balance being cleared, at its carried rate." The schema\'s own words.',
  },
  {
    table: 'refunds',
    column: 'cash_cents',
    side: 'functional',
    functionalColumn: null,
    because:
      '"Functional, through the bank, at the rate on the day." The other half of Phase 68\'s pair, and the reason a refund can realise a difference at all.',
  },
  {
    table: 'refunds',
    column: 'realised_cents',
    side: 'functional',
    functionalColumn: null,
    because:
      'The gain or loss between the two above, which is a difference of two functional figures and therefore functional itself. Kept rather than re-derived because the sign is the risk.',
  },
  {
    table: 'deposit_items',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'One receipt inside a banking batch, in the currency that receipt was taken in. Phase 127 found `createDeposit` posting the batch\'s face total; this is the row that total is built from.',
  },
  {
    table: 'payouts',
    column: 'expected_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'What a payout\'s own items come to, in the payout\'s currency — stored rather than recomputed so a changed fee schedule cannot rewrite history.',
  },
  {
    table: 'payouts',
    column: 'difference_cents',
    side: 'face',
    functionalColumn: null,
    because:
      '`expected` less `amount`, both in the payout\'s currency, so the difference is in it too. Not functional despite being a discrepancy: nothing has converted here.',
  },
  {
    table: 'payout_items',
    column: 'gross_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'One capture inside a payout, in the checkout\'s currency.',
  },
  {
    table: 'payout_items',
    column: 'fee_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'The processor\'s fee on that capture, in the same currency as the gross it was taken from.',
  },
  {
    table: 'tax_remittances',
    column: 'amount_cents',
    side: 'face',
    functionalColumn: null,
    because:
      'What was paid over to a tax authority. `tax_remittances` inherits its currency from the account it was paid from (`INHERITED_CURRENCY`), which is why Phase 133 made `recordRemittance` refuse a foreign account rather than post a figure nobody could trace.',
  },
  {
    table: 'financial_accounts',
    column: 'current_balance_cents',
    side: 'account',
    functionalColumn: null,
    because:
      'The balance the feed last reported, in the currency the account is held in. Comparable within one account and nowhere else — which is the argument `cashTieOut` already makes in `SAFE_FACE_SUMS`, and the reason this is its own side rather than `face`.',
  },
  {
    table: 'financial_accounts',
    column: 'available_balance_cents',
    side: 'account',
    functionalColumn: null,
    because:
      'The same money net of what has not cleared, in the same account\'s currency.',
  },
  {
    table: 'reconciliations',
    column: 'statement_ending_balance_cents',
    side: 'account',
    functionalColumn: null,
    because:
      'What the statement said, in the account\'s currency. A reconciliation is an account\'s own arithmetic from end to end.',
  },
  {
    table: 'reconciliations',
    column: 'beginning_balance_cents',
    side: 'account',
    functionalColumn: null,
    because:
      'Where the statement started, in the account\'s currency.',
  },
  {
    table: 'reconciliations',
    column: 'cleared_balance_cents',
    side: 'account',
    functionalColumn: null,
    because:
      'What has been ticked off, in the account\'s currency — the figure `summarize` compares against the statement, and it argues that in `SAFE_FACE_SUMS` because one reconciliation is one account.',
  },
]

/** The face column a table/column pair names, or null if it is not one. */
/**
 * The face columns, which is what both scans ask about.
 *
 * Derived rather than typed, since Phase 143. It was a hand-written list of
 * seventeen and the schema has fifty-four money columns on these tables — so a
 * sum over any of the other thirty-seven was not excused, it was **unseen**.
 */
export const FACE_COLUMNS: readonly FaceColumn[] = MONEY_COLUMNS.filter(
  (row): row is FaceColumn => row.side === 'face',
)

export function faceColumnFor(table: string, column: string): FaceColumn | null {
  return FACE_COLUMNS.find((row) => row.table === table && row.column === column) ?? null
}

/**
 * Sums of a face column that are legitimate without grouping or converting.
 *
 * Each entry has to argue that the rows it adds are provably one currency.
 * "Probably fine" is not an argument: the whole point of this file is that
 * "probably fine" is what eight sites were relying on.
 */
export type SafeFaceSum = {
  /** Where it is, as `path:symbol`, so the entry survives the line moving. */
  file: string
  symbol: string
  because: string
}

export const SAFE_FACE_SUMS: readonly SafeFaceSum[] = [
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'shiftPosition',
    because:
      'Verified in the code rather than argued from what a till is like: `takeCounterPayment` ' +
      'never passes a currency to `recordPayment`, so every receipt that reaches a drawer ' +
      'defaults to the company’s own. A drawer count is also somebody physically counting notes ' +
      'at a counter, and only cash goes in — a card settles into a batch elsewhere. One ' +
      'currency by construction, from both directions.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'drawerPosition',
    because:
      'The same drawer and the same construction: what is in the till now, against what the ' +
      'ledger says is in it. Both sides are counter cash, and counter cash is company currency ' +
      'because nothing on that path ever sets another.',
  },
  {
    file: 'src/modules/banking/accounts.ts',
    symbol: 'cashTieOut',
    because:
      'Verified in the code rather than argued: the sum of `amount_cents` runs inside a loop over ' +
      '`listFinancialAccounts` and is filtered to one `financial_account_id`, and an account holds ' +
      'exactly one currency. So `feedCents` is provably a single currency — the account’s — and is ' +
      'reported beside `currency` for that reason. The figure that is compared against the ledger ' +
      'is `feedFunctionalCents`, which sums the functional twin, and the register adds *that* one ' +
      'across accounts precisely because this one may not be.',
  },
  {
    file: 'src/modules/reconciliation/service.ts',
    symbol: 'summarize',
    because:
      'Filtered to one `reconciliation_id`, and `reconciliations.financial_account_id` is not ' +
      'null — so every row summed belongs to one account, and an account holds one currency. The ' +
      'figure is then compared against a statement balance for that same account, which is the ' +
      'only comparison that would make sense in any currency at all.',
  },
  {
    file: 'src/modules/ai/assistants.ts',
    symbol: 'explainReconciliation',
    because:
      'The same query as `summarize` and the same filter — one `reconciliation_id`, therefore one ' +
      'account, therefore one currency. It exists separately because the assistant explains the ' +
      'difference in words rather than rendering it in a table.',
  },
  {
    file: 'src/modules/ledger/settlement-history.ts',
    symbol: 'openCreditsAsAt',
    because:
      'Grouped by `credit_note_id`, and a credit note has one currency (Phase 63 settled that it ' +
      'takes the document it reverses). So every row in a group is one currency and the total is ' +
      'in it. Newly in reach in Phase 143, which declared `credit_applications.amount_cents` — ' +
      'the `currencyAware` window missed it because a `groupBy` on a foreign key says nothing ' +
      'about currency in words, only in fact.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'previewBilling',
    because:
      'Not a retainer sum at all. The reduce adds `amountForMinutes(row.minutes, rate.rateCents)` ' +
      'over `time_entries`, which has no currency column — the scan attributes it to ' +
      '`retainers.amount_cents` only because `billing.ts` reads that column elsewhere in the ' +
      'file. That attribution is the known cost of Phase 123\'s narrowing, and declaring 37 more ' +
      'columns in Phase 143 is what made it show: a wider list of face columns makes a ' +
      'property-name heuristic guess more often.',
  },
  {
    file: 'src/modules/bookkeeping/transactions.ts',
    symbol: 'splitTransaction',
    because:
      'Not a roll-up at all: it sums the split lines of **one** transaction and refuses unless ' +
      'they equal that transaction’s own `amountCents`. One transaction has one account and so ' +
      'one currency, and the comparison is against the very face amount the parts came from — ' +
      'converting either side would be the thing that made them disagree.',
  },
]

/** Whether a sum at this site is excused, and why. */
export function safeFaceSumFor(file: string, symbol: string): SafeFaceSum | null {
  return SAFE_FACE_SUMS.find((row) => row.file === file && row.symbol === symbol) ?? null
}

/**
 * Sums known to add two currencies, and not yet repaired (Phase 143).
 *
 * **Empty since Phase 152.** It held three from the day it was written until
 * then; the entries and what became of each are below.
 *
 * ## Why this exists rather than a repair
 *
 * `SAFE_FACE_SUMS` says a sum is provably one currency. These are not, and
 * saying so there would be the failure ADR 0134 named — a declaration that
 * *excuses* a site is worse than one that misses it, because a gap invites a
 * look and an excuse ends one.
 *
 * So this is the opposite kind of entry: it **indicts**. Each names what is
 * wrong in the code today, in a sentence somebody can go and check, and points
 * at the skipped test that says when it is fixed. That is Phase 139's device,
 * applied to work that needs no core at all — every one of these is a query
 * change, grouping by currency or summing a functional twin.
 *
 * They were registered rather than repaired because the staging pass was
 * holding live service paths until the wiring pass. Repairing them was small
 * and available; leaving them undeclared was the only unacceptable option.
 *
 * ## What they were hidden behind
 *
 * All three summed a column `FACE_COLUMNS` did not list. It was seventeen names
 * typed by hand and the schema has fifty-four, so these were not excused by the
 * tripwire — they were **invisible** to it. Two of the three fed a filing made
 * to a tax authority.
 *
 * ## What the three turned into
 *
 * ```
 * contractorPayments   converts each payment at its own rate, functionalSumSql
 * salesTaxReturn       the same, plus the leftJoin that makes the rate reachable
 * cashBasisCaveats     counts rows — its total was only ever read as `> 0`
 * ```
 *
 * The third is the one worth remembering. Two of these needed a conversion and
 * the third needed the question asked one step earlier: *who reads this?*
 * Nothing printed it, so money was the wrong type for it, and `faceSumStands`
 * is where that distinction now lives. Its sibling query three lines above it
 * had already reached the same answer nine phases earlier and nobody had
 * carried it across.
 *
 * ## The register is kept, emptied, rather than deleted
 *
 * `blindFaceSumFor` still throws nothing and returns null for everything, and
 * the two scans still call it. An entry can be added the next time a sum is
 * found that cannot be repaired in the same pass — which is the situation this
 * was built for, and will happen again.
 */
export type BlindFaceSum = {
  file: string
  symbol: string
  /** What is wrong in the code today, checkably. */
  liveDefect: string
  /** The skipped test that says when it is fixed. */
  acceptance: string
}

export const BLIND_FACE_SUMS: readonly BlindFaceSum[] = []

/** Whether a sum at this site is a known, registered defect. */
export function blindFaceSumFor(file: string, symbol: string): BlindFaceSum | null {
  return BLIND_FACE_SUMS.find((row) => row.file === file && row.symbol === symbol) ?? null
}
