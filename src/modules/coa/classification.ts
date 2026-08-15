import type { AccountType } from './standard'

/**
 * What an account *is*, beyond its type (spec §13).
 *
 * Two reports need to know more about an account than "asset" or "liability":
 *
 *  - The **statement of cash flows** needs to know whether a movement is
 *    operating, investing, or financing — and which accounts *are* cash.
 *  - **Cash-basis reporting** needs to know which accounts exist only to hold
 *    a timing difference, because those are the accounts cash basis claims do
 *    not exist.
 *
 * ## Why this is derived and not stored
 *
 * The obvious design is two more columns on `chart_accounts`. It was rejected:
 * `subtype` already exists, every seeded and industry-pack account already
 * carries one, and it is the field that answers "what kind of account is
 * this". A second field saying the same thing in different words can disagree
 * with it, and then a report and the chart of accounts tell different stories
 * about the same account — the exact failure spec §23's "one source of truth"
 * rule is about.
 *
 * The cost is real and worth naming: an account with the wrong subtype lands
 * in the wrong section of the cash flow statement, and the fix is to correct
 * the subtype rather than to override the report. That is the right place for
 * the fix, because the subtype was already wrong for every other reader.
 *
 * This module imports nothing but a type, so client components can use it.
 */

/**
 * Where an account's movement belongs on a statement of cash flows.
 *
 * `cash` and `income` are not sections — they are the two special cases the
 * indirect method treats structurally rather than listing.
 */
export type CashFlowClass =
  /** Cash and equivalents. The thing the statement explains the change in. */
  | 'cash'
  /** Revenue and expense. Already inside net income; never listed separately. */
  | 'income'
  | 'operating'
  | 'investing'
  | 'financing'

/**
 * Subtypes that are cash for the purposes of the statement.
 *
 * Undeposited Funds is here deliberately. A cheque in the drawer is money the
 * business has; if it were not cash, every deposit would appear on the
 * statement as an operating inflow, which is nonsense — the money arrived when
 * the customer handed it over, not when somebody walked to the bank.
 */
const CASH_SUBTYPES: ReadonlySet<string> = new Set([
  'bank',
  'cash',
  'undeposited_funds',
])

/** Long-lived assets. Buying and selling them is investing. */
const INVESTING_ASSET_SUBTYPES: ReadonlySet<string> = new Set([
  'fixed_asset',
  'intangible_asset',
  'investment',
])

/** Borrowing and repaying. */
const FINANCING_LIABILITY_SUBTYPES: ReadonlySet<string> = new Set([
  'long_term_liability',
  'note_payable',
])

const INCOME_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'revenue',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
])

export function cashFlowClass(type: AccountType, subtype?: string | null): CashFlowClass {
  if (INCOME_TYPES.has(type)) return 'income'

  const kind = subtype ?? ''

  if (type === 'asset') {
    if (CASH_SUBTYPES.has(kind)) return 'cash'
    if (INVESTING_ASSET_SUBTYPES.has(kind)) return 'investing'
    // Accumulated Depreciation is deliberately operating, not investing.
    //
    // Its movement over a period is the depreciation charge, and the indirect
    // method's first adjustment is to add that charge back to net income
    // because no cash left. Classifying it beside the asset it offsets would
    // put the add-back in the investing section, where it would look like a
    // disposal. Gross Fixed Assets stays investing, so a purchase still
    // appears where it should.
    //
    // The approximation this makes: disposing of a depreciated asset moves
    // accumulated depreciation for a reason that *is* investing, and this
    // reports it as operating. Correct handling needs a fixed-asset register,
    // which spec §13 explicitly allows as a later module.
    return 'operating'
  }

  if (type === 'liability') {
    return FINANCING_LIABILITY_SUBTYPES.has(kind) ? 'financing' : 'operating'
  }

  // Equity: contributions, draws, and distributions are all financing.
  return 'financing'
}

export function isCashAccount(type: AccountType, subtype?: string | null): boolean {
  return cashFlowClass(type, subtype) === 'cash'
}

/**
 * Accounts whose entire purpose is to hold a timing difference (spec §13).
 *
 * These are what accrual accounting has and cash accounting does not: a
 * prepayment, an accrued expense, revenue billed before it is earned, work
 * done before it is billed. Every one of them is a claim that an amount
 * belongs to a period other than the one its cash landed in — which is
 * precisely the claim a cash-basis report rejects.
 *
 * **Receivables and payables are not in this list**, even though they are the
 * same idea. They have real payment applications recording which document
 * each settlement covers, so cash basis handles them exactly rather than by
 * inference. See `cash-basis.ts`.
 *
 * **Accumulated Depreciation is not here either**, and it is the case that
 * proves the list has to be by account rather than by shape. A depreciation
 * entry looks identical to an accrual — an expense against a balance-sheet
 * account, no cash — but a cash-basis taxpayer still deducts depreciation,
 * because it is capital recovery rather than a timing difference. Any rule
 * phrased as "entries that touch no cash" gets this one wrong.
 */
const ACCRUAL_ONLY_SUBTYPES: ReadonlySet<string> = new Set([
  'accrued_liability',
  'prepaid_expense',
  'deferred_revenue',
  'unbilled_revenue',
])

export function isAccrualOnly(type: AccountType, subtype?: string | null): boolean {
  if (INCOME_TYPES.has(type)) return false
  return ACCRUAL_ONLY_SUBTYPES.has(subtype ?? '')
}

export const CASH_FLOW_SECTION_LABELS = {
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
} as const

/**
 * Human wording for why an account sits where it does, shown next to the
 * subtype in the chart of accounts so the classification is visible before a
 * report is run rather than discovered inside one.
 */
export const CASH_FLOW_CLASS_LABELS: Record<CashFlowClass, string> = {
  cash: 'Cash and equivalents',
  income: 'Income statement',
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
}
