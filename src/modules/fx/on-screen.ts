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
   * It came off a document — an invoice, bill, credit note, payment or
   * retainer. Those five tables carry a `currency` column, two rows of one list
   * can disagree, and the figure must be shown in its own.
   */
  | 'document'
  /**
   * It is the company's own money: a ledger balance, a budget, a till count, a
   * depreciation schedule. One currency by construction, so `formatCents`'
   * default is the right answer rather than a lucky one.
   */
  | 'books'

/** One prop type that carries money across the server/client boundary. */
export type ScreenMoney = {
  /** The client component, as a repo-relative path. */
  file: string
  /** The prop type declared inside it. */
  type: string
  basis: MoneyBasis
  /** Why it is that basis, argued from where the data comes from. */
  because: string
}

/**
 * The five tables that carry a currency, as drizzle properties.
 *
 * Written out rather than derived from `FACE_COLUMNS` because the question here
 * is about a *table* — does a row of this thing have a currency of its own —
 * rather than about a particular column of it.
 */
export const DOCUMENT_TABLES: readonly string[] = [
  'invoices',
  'bills',
  'creditNotes',
  'payments',
  'retainers',
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
]

/**
 * Carriers this phase measured but did not classify.
 *
 * The honest remainder, on the pattern Phase 121 used for the check it could
 * not falsify: a list with reasons beats a silence. Each of these is a prop
 * type carrying money named after a face column, on a screen whose modules
 * touch a document table — so the scan cannot rule it out, and only reading the
 * query behind it can say whether the figure arrives converted.
 *
 * Every one of them was **looked at** and none is a screen where a foreign
 * document is listed beside a domestic one; they are roll-ups, job budgets,
 * till counts and import plans reached through a shared module. But "looked at"
 * is not "traced to its query", which is what the two classified `document`
 * entries got, and the difference is worth being honest about.
 *
 * The number is a tripwire: it may shrink as entries are traced and moved into
 * `SCREEN_MONEY`, and it must never grow without somebody saying why.
 */
export const UNCLASSIFIED_CARRIERS = 19

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
