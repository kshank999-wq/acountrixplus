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

/** A column holding an amount in the document's own currency. */
export type FaceColumn = {
  table: string
  column: string
  /** The column holding the same amount in company currency, if there is one. */
  functionalColumn: string | null
  because: string
}

export const FACE_COLUMNS: readonly FaceColumn[] = [
  {
    table: 'invoices',
    column: 'total_cents',
    functionalColumn: 'functional_total_cents',
    because: 'What the customer was billed, in what they were billed in.',
  },
  {
    table: 'invoices',
    column: 'balance_cents',
    functionalColumn: 'functional_balance_cents',
    because: 'What is still owed on it, in the same currency as the bill.',
  },
  {
    table: 'bills',
    column: 'total_cents',
    functionalColumn: 'functional_total_cents',
    because: 'What the supplier invoiced, in their currency.',
  },
  {
    table: 'bills',
    column: 'balance_cents',
    functionalColumn: 'functional_balance_cents',
    because: 'What is still owed to them, in the currency the supplier invoiced in.',
  },
  {
    table: 'credit_notes',
    column: 'total_cents',
    functionalColumn: 'functional_total_cents',
    because: 'What was credited, in the currency of the document it credits.',
  },
  {
    table: 'credit_notes',
    column: 'remaining_cents',
    functionalColumn: 'functional_remaining_cents',
    because:
      'What is left to spend of it. Summed per supplier by the pay run, which is why adding ' +
      'two currencies here takes money off a payment.',
  },
  {
    table: 'payments',
    column: 'unapplied_cents',
    functionalColumn: 'functional_unapplied_cents',
    because: 'Money held that has not met an invoice yet, in the currency it arrived in.',
  },
  {
    table: 'payments',
    column: 'amount_cents',
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
    functionalColumn: 'functional_remaining_cents',
    because: 'Client money on account, in the currency it was put on account in.',
  },
]

/** The face column a table/column pair names, or null if it is not one. */
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
]

/** Whether a sum at this site is excused, and why. */
export function safeFaceSumFor(file: string, symbol: string): SafeFaceSum | null {
  return SAFE_FACE_SUMS.find((row) => row.file === file && row.symbol === symbol) ?? null
}
