/**
 * Which tables carry a currency, asked of the schema rather than remembered
 * (Phase 128).
 *
 * ## The defect
 *
 * Phase 127 built a scan that reads every place money reaches `debitCents` or
 * `creditCents`, and narrowed it to modules that touch a currency-bearing
 * table. The narrowing is sound. The list it narrowed by was **typed out by
 * hand**:
 *
 * ```ts
 * const CURRENCY_TABLES = [
 *   'invoices', 'bills', 'creditNotes', 'payments', 'retainers',
 *   'recurringInvoices', 'recurringInvoiceOccurrences',
 *   'invoiceWriteOffs', 'deposits',
 * ]
 * ```
 *
 * Nine. The schema has **thirteen**. `financial_accounts`, `checkouts`,
 * `payouts` and `refunds` were missing, and every one of them has carried a
 * `currency` column for far longer than the scan has existed —
 * `financial_accounts` since the banking schema was first written, long before
 * there was any FX work to forget about.
 *
 * Twenty-two posting sites in eight functions were therefore never asked to
 * argue what currency their money was in. Among them is `ledger/posting.ts`,
 * which is where money **first enters the books**.
 *
 * ## What it cost
 *
 * `buildLines` posts `Math.abs(transaction.amountCents)` against a bank
 * account's ledger account. `bank_transactions` has no currency of its own; it
 * inherits the account's, and `createFinancialAccount` genuinely stores one —
 * a business really can hold a euro account.
 *
 * So **every categorised transaction on a foreign account posted a face amount
 * into the functional ledger**, from the day the bank feed was built. Phase 127
 * fixed two instances of that defect and could not see the largest one.
 *
 * And the check that exists to catch exactly this **agreed**. `cashTieOut` puts
 * the ledger side against the feed side, and the feed side is a sum of
 * `bank_transactions.amount_cents` — euros. With the posting putting euros into
 * the ledger too, the two matched to the cent, every night, while the balance
 * sheet was wrong. Phase 121 asked every check what would make it disagree;
 * this is what it looks like when the answer is *nothing*.
 *
 * Fixing the posting is therefore only half of it: the feed side has to be
 * converted as well, or the repair itself makes the check disagree every night
 * for a reason nobody could trace. `cashTieOut` converts a day at a time now,
 * at the rate `buildLines` used for that day.
 *
 * ## A correction to ADR 0127
 *
 * Three entries in `LEDGER_POSTINGS` and one in `SCREEN_MONEY` argued, in these
 * words, that
 *
 * > `financial_accounts` carries no currency column — Phase 40 gave each one a
 * > ledger account, not a denomination
 *
 * That is false, and it was written one phase ago in a registry whose whole
 * purpose is to be trusted. It is the Phase 110 failure exactly — a declaration
 * argued from a schema fact that is not a fact — and it is why this file exists
 * rather than a corrected constant.
 *
 * ## The fix is that the list is not a list
 *
 * A registry of tables, typed by a person, drifts the moment somebody adds a
 * column. `paired-money` solved this in Phase 116 by asking `pg_constraint`
 * whether the constraints it claims are really there — *the registry is asked,
 * and the database answers*. This does the same: every entry says what its
 * currency belongs to, and the test compares the set against
 * `information_schema.columns`. A fourteenth table cannot be forgotten; it can
 * only be declared or fail.
 */

/** One table whose rows carry a currency of their own. */
export type CurrencyCarrier = {
  /** The table, as the database names it. */
  table: string
  /** The same, as drizzle names it — what a source scan matches on. */
  property: string
  /** Whose currency it is, and what that means for money read off the row. */
  because: string
}

/**
 * Every table with a `currency` column, except `companies`.
 *
 * `companies.currency` is excluded on purpose and is the one entry that would
 * be wrong here: it is the *functional* currency, the one the ledger is kept
 * in. A row of every other table can disagree with it, which is what makes
 * those rows face amounts and this one the thing they are measured against.
 */
export const CURRENCY_CARRIERS: readonly CurrencyCarrier[] = [
  {
    table: 'invoices',
    property: 'invoices',
    because:
      'What the customer was billed in. The original face/functional pair (Phase 35), and the ' +
      'reason every other entry here exists.',
  },
  {
    table: 'bills',
    property: 'bills',
    because:
      'What the supplier invoiced in — the payables mirror of an invoice, and carried the same ' +
      'way: a face total beside a functional twin, both written when the bill is entered and ' +
      'neither recomputed afterwards.',
  },
  {
    table: 'credit_notes',
    property: 'creditNotes',
    because:
      'The currency of the document it credits. Phase 63 settled that a credit note reverses a ' +
      'document by the same arithmetic that raised it, so it cannot have its own.',
  },
  {
    table: 'payments',
    property: 'payments',
    because:
      'The currency the money arrived in, derived from the documents it settles rather than ' +
      'chosen (Phase 62). A receipt on account with no document takes the company’s own.',
  },
  {
    table: 'retainers',
    property: 'retainers',
    because:
      'Client money on account, in the currency it was put on account in (Phase 66). Held rather ' +
      'than earned, so the currency is the client’s until a draw turns some of it into revenue ' +
      'at the rate it was carried at.',
  },
  {
    table: 'recurring_invoices',
    property: 'recurringInvoices',
    because:
      'What a billing schedule bills in, fixed when it is set up (Phase 126). Until then a ' +
      'schedule was the one invoice path that could not be foreign.',
  },
  {
    table: 'recurring_invoice_occurrences',
    property: 'recurringInvoiceOccurrences',
    because:
      'What one period was billed in — the invoice’s where it raised one, the schedule’s ' +
      'otherwise. A schedule re-denominated later must not restate a period already claimed.',
  },
  {
    table: 'invoice_write_offs',
    property: 'invoiceWriteOffs',
    because:
      'The written-off invoice’s own currency (Phase 127). Its functional twin is what the books ' +
      'took as the loss, and posting the face amount instead is what stranded bad-debt expense.',
  },
  {
    table: 'deposits',
    property: 'deposits',
    because:
      'The receipts’ currency, single since Phase 123 refused to bank two. Phase 127 wrote it ' +
      'down because the posting needed the functional twin beside it.',
  },
  {
    table: 'financial_accounts',
    property: 'financialAccounts',
    because:
      'The currency the account is held in — and the one Phase 127 declared did not exist, in ' +
      'three registry entries and a screen comment. It has been there since the banking schema ' +
      'was first written. A `bank_transactions` row has no currency of its own and inherits this ' +
      'one, which is why the bank feed was posting face amounts into the ledger.',
  },
  {
    table: 'checkouts',
    property: 'checkouts',
    because:
      'What the customer was asked to pay through the card processor. The processor reports its ' +
      'fee in the same currency, which is what `postFee` puts on the profit and loss.',
  },
  {
    table: 'payouts',
    property: 'payouts',
    because:
      'What the processor actually paid into a bank account, in the currency it settled in. ' +
      '`importPayouts` posts that figure, so it is a face amount whenever the account is foreign.',
  },
  {
    table: 'refunds',
    property: 'refunds',
    because:
      'The currency the money went back in — the refund’s own record of it, kept because Phase 68 ' +
      'made a refund one record rather than three near-copies with three answers.',
  },
]

/** The drizzle property names, for a scan that reads source rather than schema. */
export function carrierProperties(): readonly string[] {
  return CURRENCY_CARRIERS.map((row) => row.property)
}

/**
 * What a table's currency belongs to, or a refusal.
 *
 * Throws on an undeclared table, the device Phase 101 set: a lookup returning
 * `undefined` lets somebody walk past the question, and this is exactly the
 * question four tables walked past for a phase.
 */
export function carrierFor(table: string): CurrencyCarrier {
  const found = CURRENCY_CARRIERS.find((row) => row.table === table)

  if (!found) {
    throw new Error(
      `No currency carrier is declared for "${table}". If it has a currency column, declare it ` +
        'in src/modules/fx/carriers.ts and say whose currency it is; if it does not, do not ask.',
    )
  }

  return found
}

/**
 * What a bank transaction puts into the ledger.
 *
 * ## Why this is not just `convert`
 *
 * A bank transaction is the one amount in the system that is a **fact about
 * money that has already moved**. There is no document to take a rate from and
 * no rate stored on the row, so the rate has to come from the day it happened —
 * the same principle as a refund, where Phase 68 used the day the money left
 * rather than the day the obligation arose.
 *
 * A domestic account short-circuits with the rate untouched, which is why this
 * defect survived: `rateMillionths` is `1_000_000` for every account anybody
 * had, and the multiplication was a no-op.
 *
 * ## Refusing rather than guessing
 *
 * `null` when there is no rate for that date. The caller does not post, and the
 * transaction stays in the feed where a person can see it — Phase 117's rule,
 * and Phase 64's precedent for an invoice that cannot be raised without one.
 * Posting the euros as dollars is what this phase exists to stop; posting them
 * at *some* rate nobody chose would be the same defect wearing a hat.
 */
export function bankTransactionFunctional(
  amountCents: number,
  rateMillionths: number | null,
): number | null {
  if (rateMillionths === null) return null
  return Math.round((amountCents * rateMillionths) / 1_000_000)
}
