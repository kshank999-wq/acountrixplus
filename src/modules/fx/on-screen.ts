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
 * Checked against the schema rather than assumed — of every table these screens
 * read, **only five carry a `currency` column**: `invoices`, `bills`,
 * `credit_notes`, `payments` and `retainers`. Billing schedules, proposals,
 * deposits, contributions, purchase orders, time entries, assets and statement
 * runs carry none.
 *
 * So:
 *
 * > **A currency travels with a document, and only a document has one.**
 *
 * Money that came off one of the five is a **face** amount: it belongs to a
 * customer's or supplier's document, two rows of a list can differ, and it has
 * to be shown wearing its own currency. Everything else is the company's own
 * money, and `formatCents`' default is right for it.
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
 * The tables that carry a currency, as drizzle properties.
 *
 * Written out rather than derived from `FACE_COLUMNS` because the question here
 * is about a *table* — does a row of this thing have a currency of its own —
 * rather than about a particular column of it.
 *
 * Five when Phase 124 measured it, and its test said out loud that this list is
 * where somebody has to notice if a sixth ever grows one. Phase 126 grew two:
 * a recurring schedule now records what it bills in, and each occurrence
 * records what its period was billed in. Noticed here, as intended.
 */
export const DOCUMENT_TABLES: readonly string[] = [
  'invoices',
  'bills',
  'creditNotes',
  'payments',
  'retainers',
  'recurringInvoices',
  'recurringInvoiceOccurrences',
]

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
      'and is the books’, because a financial account carries no currency of its own.',
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
 * Twelve, since Phase 126: `billing/board.tsx`'s `Waiting` — periods claimed on
 * a schedule and left for a person to raise — was one of the thirteen and now
 * carries its occurrence's currency. The rest read no face column at all:
 * funds, inventory, properties, the shop, the import wizard, unbilled time and
 * the party and statement roll-ups. They are reached only because a page
 * imports a module that touches a currency-carrying table somewhere else.
 *
 * It may shrink. It must never grow without somebody saying why.
 */
export const UNCLASSIFIED_CARRIERS = 12

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
      'not a face table. It is the first thing giving that table a currency column would fix, and ' +
      'it is recorded here rather than quietly excused.',
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
