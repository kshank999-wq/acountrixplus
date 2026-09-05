import { CURRENCY_CARRIERS } from './carriers'
import { RegistryError } from '@/modules/errors/registry'

/**
 * Money on a row that has no currency of its own (Phase 131).
 *
 * ## The sentence nobody turned into a rule
 *
 * Phase 128 asked the schema which tables carry a currency and got thirteen.
 * One of its entries — `financial_accounts` — ends like this:
 *
 * > A `bank_transactions` row has no currency of its own and inherits this
 * > one, which is why the bank feed was posting face amounts into the ledger.
 *
 * That is the whole of this file's subject, written down in prose one phase
 * ago and never made into anything that checks. `CURRENCY_CARRIERS` answers
 * *which tables have a currency*. Nothing answered *which tables hold money
 * belonging to one*, and those are the rows a screen shows.
 *
 * ## What it cost
 *
 * `money-on-screen.test.ts` (Phase 124) decides whether a screen serves foreign
 * money by asking which of seven tables the page behind it reads. Seven, typed
 * by hand, in the same shape and for the same reason as the nine that Phase 128
 * found and replaced. `bank_transactions` is not one of them and never could
 * be — it has no currency column — so **the transaction inbox was outside the
 * scan entirely**, and has rendered every row of a euro account with a dollar
 * sign since Phase 1. So has the reconciliation workspace.
 *
 * The narrowing was not wrong to exist. It was wrong about what to narrow by:
 * a row's currency can live one join away, and asking only about the row is how
 * the application's busiest screen went four phases of FX work without being
 * looked at.
 *
 * ## The rule that makes it decidable
 *
 * A **mandatory** foreign key to a currency carrier. Not any foreign key: a
 * `time_entries.invoice_id` is nullable, because a time entry exists long
 * before anybody bills it, and its rate is the company's own money whether or
 * not it is ever billed. A parent that must be there is a parent the row cannot
 * mean anything without, and that is what inheritance is.
 *
 * Thirteen tables qualify, asked of `information_schema` rather than
 * remembered. Each says which of its money columns are the parent's and which
 * are the books' — and the test compares that split against every `%_cents`
 * column the table actually has, so a column added later cannot be silently
 * unclassified.
 *
 * Three of the thirteen answer *the books'*, which is the answer that makes the
 * registry worth having: a mandatory link is not automatically a denomination,
 * and a registry where every entry says the same thing is a list.
 */

/** A table's money, and whose currency it is in. */
export type InheritedCurrency = {
  /** The table, as the database names it. */
  table: string
  /** The same, as drizzle names it — what a source scan matches on. */
  property: string
  /**
   * Every mandatory foreign key from this table to a currency carrier.
   *
   * Measured from `information_schema`, not chosen. Two entries means the row
   * cannot exist without both, and the prose has to say how they are kept from
   * disagreeing.
   */
  parents: readonly { table: string; column: string }[]
  /**
   * The `%_cents` columns denominated in a parent's currency.
   *
   * Empty when the table's money is the company's own despite the link.
   */
  faceColumns: readonly string[]
  /**
   * The parent tables `faceColumns` are denominated in.
   *
   * More than one is a claim that a refusal keeps them equal, and the prose
   * must name it. Empty when `faceColumns` is.
   */
  faceOf: readonly string[]
  /** The `%_cents` columns that are the company's own money. */
  booksColumns: readonly string[]
  /** Why the split is where it is, argued from what writes the row. */
  because: string
}

export const INHERITED_CURRENCY: readonly InheritedCurrency[] = [
  {
    table: 'bank_transactions',
    property: 'bankTransactions',
    parents: [{ table: 'financial_accounts', column: 'financial_account_id' }],
    faceColumns: ['amount_cents'],
    faceOf: ['financial_accounts'],
    booksColumns: ['functional_amount_cents'],
    because:
      'What the bank says moved, in the money the bank holds. The account cannot be changed after ' +
      'the row exists, so the denomination is fixed the moment the feed writes it. Phase 129 added ' +
      'the functional twin beside it and the rate that made it, which is why the second column is ' +
      'the books’ rather than a second opinion about the first.',
  },
  {
    table: 'reconciliations',
    property: 'reconciliations',
    parents: [{ table: 'financial_accounts', column: 'financial_account_id' }],
    faceColumns: [
      'statement_ending_balance_cents',
      'beginning_balance_cents',
      'cleared_balance_cents',
    ],
    faceOf: ['financial_accounts'],
    booksColumns: [],
    because:
      'All three are figures off a bank statement, or sums of transactions on it, and a statement ' +
      'is printed in the bank’s money. The whole session is self-consistent in that currency — ' +
      '`summarize` adds `bank_transactions.amount_cents` to a beginning balance and subtracts it ' +
      'from an ending one — which is why nothing here was ever wrong, only unlabelled.',
  },
  {
    table: 'invoice_lines',
    property: 'invoiceLines',
    parents: [{ table: 'invoices', column: 'invoice_id' }],
    faceColumns: ['unit_price_cents', 'amount_cents'],
    faceOf: ['invoices'],
    booksColumns: [],
    because:
      'What the customer was quoted per unit and in total. The invoice’s own currency by ' +
      'construction: Phase 35 converts the parts and totals the conversions, so the lines are the ' +
      'face figures and the invoice’s functional twin is derived from them rather than the other ' +
      'way about.',
  },
  {
    table: 'bill_lines',
    property: 'billLines',
    parents: [{ table: 'bills', column: 'bill_id' }],
    faceColumns: ['unit_price_cents', 'amount_cents'],
    faceOf: ['bills'],
    booksColumns: [],
    because:
      'The payables mirror of an invoice line, and carried the same way: what the supplier charged ' +
      'per unit and in total, in the currency they invoiced in. A bill cannot be re-denominated ' +
      'after entry, so no line can outlive the currency it was written in.',
  },
  {
    table: 'credit_note_lines',
    property: 'creditNoteLines',
    parents: [{ table: 'credit_notes', column: 'credit_note_id' }],
    faceColumns: ['unit_price_cents', 'amount_cents'],
    faceOf: ['credit_notes'],
    booksColumns: [],
    because:
      'What is being credited, line by line. Phase 63 settled that a credit note has no currency ' +
      'of its own — it takes the document it credits — so a line here is two joins from an ' +
      'invoice or a bill and in exactly that document’s money.',
  },
  {
    table: 'recurring_invoice_lines',
    property: 'recurringInvoiceLines',
    parents: [{ table: 'recurring_invoices', column: 'recurring_invoice_id' }],
    faceColumns: ['unit_price_cents'],
    faceOf: ['recurring_invoices'],
    booksColumns: [],
    because:
      'What each period will be billed at. Phase 126 gave the schedule a currency precisely so ' +
      'these figures had one; before that a schedule was the one invoice path that could not be ' +
      'foreign, and the line prices were the company’s own by the absence of any alternative.',
  },
  {
    table: 'payment_applications',
    property: 'paymentApplications',
    parents: [{ table: 'payments', column: 'payment_id' }],
    faceColumns: ['amount_cents'],
    faceOf: ['payments'],
    booksColumns: [],
    because:
      'How much of a receipt settled one document, in the money it arrived in. The payment’s ' +
      'currency is derived from the documents it settles rather than chosen (Phase 62), so an ' +
      'application cannot be denominated in anything else without the payment itself being wrong.',
  },
  {
    table: 'credit_applications',
    property: 'creditApplications',
    parents: [{ table: 'credit_notes', column: 'credit_note_id' }],
    faceColumns: ['amount_cents'],
    faceOf: ['credit_notes'],
    booksColumns: [],
    because:
      'How much of a credit note was spent against a document. Only the credit note is mandatory — ' +
      'the invoice and bill columns are nullable and are two ways of naming what it was spent on — ' +
      'so the note is the one parent the row cannot exist without, and its currency is the answer.',
  },
  {
    table: 'deposit_items',
    property: 'depositItems',
    parents: [{ table: 'deposits', column: 'deposit_id' }],
    faceColumns: ['amount_cents'],
    faceOf: ['deposits'],
    booksColumns: [],
    because:
      'One receipt being banked, in the currency it was received in. Phase 123 refused to bank two ' +
      'currencies in one deposit, which is what makes the deposit’s single currency an answer for ' +
      'every item under it rather than an average of them.',
  },
  {
    table: 'payout_items',
    property: 'payoutItems',
    parents: [
      { table: 'checkouts', column: 'checkout_id' },
      { table: 'payouts', column: 'payout_id' },
    ],
    faceColumns: ['gross_cents', 'fee_cents'],
    faceOf: ['checkouts'],
    booksColumns: [],
    because:
      'Copied straight off the checkout by `importPayouts` — `grossCents: row.grossCents` — so ' +
      'they are the checkout’s money, not the payout’s. The two agree because a processor settles ' +
      'a batch in the currency it charged in, and that is the processor’s guarantee rather than ' +
      'this application’s: nothing here compares the two.',
  },
  {
    table: 'retainer_applications',
    property: 'retainerApplications',
    parents: [
      { table: 'retainers', column: 'retainer_id' },
      { table: 'invoices', column: 'invoice_id' },
    ],
    faceColumns: ['amount_cents'],
    faceOf: ['retainers', 'invoices'],
    booksColumns: ['carried_cents'],
    because:
      'Both parents, and they are the same currency by refusal: `drawableAgainst` declines a draw ' +
      'across currencies on Phase 62’s rule that money held in one has not discharged a demand in ' +
      'another. `carried_cents` is the functional figure Phase 112 kept so a draw does not have to ' +
      're-derive what the retainer was carried at.',
  },
  {
    table: 'invoice_costings',
    property: 'invoiceCostings',
    parents: [{ table: 'invoices', column: 'invoice_id' }],
    faceColumns: [],
    faceOf: [],
    booksColumns: ['cost_cents'],
    because:
      'The books’, despite the link. `cost_cents` is what the stock cost to buy — frozen off ' +
      '`consumeStockForSale` so a return puts it back at what it left at — and inventory is held ' +
      'in one currency. The invoice says what it sold for; this says what it cost, and those are ' +
      'not the same money even when they are the same number.',
  },
  {
    table: 'tax_remittances',
    property: 'taxRemittances',
    parents: [{ table: 'financial_accounts', column: 'financial_account_id' }],
    faceColumns: [],
    faceOf: [],
    booksColumns: ['amount_cents'],
    because:
      'The books’. `recordRemittance` refuses an amount larger than what `liabilityPositions` says ' +
      'is owed on the ledger account, so the figure is measured against a ledger balance and is ' +
      'therefore in the ledger’s money. The account is where it was paid from, not what it is ' +
      'denominated in — which is a real gap when that account is foreign, and is named in ADR 0131.',
  },
]

/**
 * What a table's money belongs to, or a refusal.
 *
 * Throws on an undeclared table, the device Phase 101 set and Phase 128 used
 * for its sibling: a lookup returning `undefined` lets somebody walk past the
 * question, and walking past this one is what left the inbox unlabelled.
 */
export function inheritedFor(table: string): InheritedCurrency {
  const found = INHERITED_CURRENCY.find((row) => row.table === table)

  if (!found) {
    throw new RegistryError({
      registry: 'INHERITED_CURRENCY',
      key: table,
      message:
        `No currency inheritance is declared for "${table}". If it holds money and cannot exist ` +
        'without a row that carries a currency, declare it in src/modules/fx/inherited.ts and say ' +
        'which of its columns are that currency and which are the books’.',
    })
  }

  return found
}

/**
 * Every table whose rows can be shown in something other than the company's
 * own money, as drizzle properties.
 *
 * The carriers, plus the tables that inherit from one. This is the list a
 * screen scan wants: a page reaching either kind may be putting a face amount
 * in front of somebody, and a page reaching neither cannot be.
 */
export function denominatedProperties(): readonly string[] {
  return [
    ...CURRENCY_CARRIERS.map((row) => row.property),
    ...INHERITED_CURRENCY.filter((row) => row.faceColumns.length > 0).map((row) => row.property),
  ]
}
