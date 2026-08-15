import type { accountTypeEnum } from '@/db/schema'

export type AccountType = (typeof accountTypeEnum.enumValues)[number]

export type AccountTemplate = {
  number: string
  name: string
  type: AccountType
  subtype?: string
  description?: string
  /** System accounts cannot be deleted — the books depend on them. */
  isSystem?: boolean
}

/**
 * The standard chart of accounts installed for every new company (spec §5).
 *
 * Numbering follows the conventional blocks so an accountant recognises the
 * structure immediately, and so industry packs have obvious places to slot in:
 *
 *   1000–1999  Assets            5000–5999  Cost of goods sold
 *   2000–2999  Liabilities       6000–7999  Operating expenses
 *   3000–3999  Equity            8000–8999  Other income
 *   4000–4999  Revenue           9000–9999  Other expense
 *
 * Industry packs add accounts inside these blocks rather than defining a
 * parallel structure, which is what keeps every company on one accounting
 * model (spec §23).
 */
export const STANDARD_ACCOUNTS: AccountTemplate[] = [
  // --- Assets -------------------------------------------------------------
  { number: '1000', name: 'Checking Account', type: 'asset', subtype: 'bank' },
  { number: '1010', name: 'Savings Account', type: 'asset', subtype: 'bank' },
  { number: '1050', name: 'Petty Cash', type: 'asset', subtype: 'cash' },
  {
    number: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subtype: 'accounts_receivable',
    isSystem: true,
    description: 'Amounts owed to the company by customers.',
  },
  {
    number: '1200',
    name: 'Undeposited Funds',
    type: 'asset',
    subtype: 'undeposited_funds',
    isSystem: true,
    description: 'Payments received but not yet deposited to a bank account.',
  },
  // Subtype `prepaid_expense`, not `other_current_asset`, since Phase 12: it is
  // what tells cash-basis reporting this account holds a timing difference
  // rather than an asset the business owns. See `coa/classification.ts`.
  { number: '1300', name: 'Prepaid Expenses', type: 'asset', subtype: 'prepaid_expense' },
  { number: '1400', name: 'Inventory', type: 'asset', subtype: 'inventory' },
  { number: '1500', name: 'Fixed Assets', type: 'asset', subtype: 'fixed_asset' },
  {
    number: '1510',
    name: 'Accumulated Depreciation',
    type: 'asset',
    subtype: 'accumulated_depreciation',
    description: 'Contra-asset. Normally carries a credit balance.',
  },

  // --- Liabilities --------------------------------------------------------
  {
    number: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subtype: 'accounts_payable',
    isSystem: true,
    description: 'Amounts the company owes to vendors.',
  },
  { number: '2100', name: 'Credit Card', type: 'liability', subtype: 'credit_card' },
  {
    number: '2150',
    name: 'Accrued Liabilities',
    type: 'liability',
    subtype: 'accrued_liability',
    description:
      'Expenses incurred but not yet billed. Accrue at period end and reverse at the start of the next one.',
  },
  { number: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'sales_tax' },
  { number: '2300', name: 'Payroll Liabilities', type: 'liability', subtype: 'payroll' },
  { number: '2400', name: 'Loans Payable', type: 'liability', subtype: 'long_term_liability' },
  // Deferred revenue: money taken before the work is done. Subtype matters —
  // it is what makes a deposit revenue on a cash-basis report and not on an
  // accrual one.
  { number: '2500', name: 'Unearned Revenue', type: 'liability', subtype: 'deferred_revenue' },

  // --- Equity -------------------------------------------------------------
  { number: '3000', name: "Owner's Equity", type: 'equity' },
  { number: '3100', name: "Owner's Draw", type: 'equity' },
  { number: '3200', name: 'Retained Earnings', type: 'equity', isSystem: true },
  {
    number: '3900',
    name: 'Opening Balance Equity',
    type: 'equity',
    isSystem: true,
    description: 'Offsets opening balances during setup. Should clear to zero.',
  },

  // --- Revenue ------------------------------------------------------------
  { number: '4000', name: 'Sales Revenue', type: 'revenue' },
  { number: '4100', name: 'Service Revenue', type: 'revenue' },
  { number: '4900', name: 'Discounts and Refunds', type: 'revenue' },
  {
    number: '4990',
    name: 'Uncategorized Income',
    type: 'revenue',
    isSystem: true,
    description: 'Holding account for deposits awaiting review.',
  },

  // --- Cost of goods sold -------------------------------------------------
  { number: '5000', name: 'Cost of Goods Sold', type: 'cogs' },
  { number: '5100', name: 'Materials and Supplies', type: 'cogs' },
  { number: '5200', name: 'Subcontracted Services', type: 'cogs' },
  { number: '5300', name: 'Freight and Shipping', type: 'cogs' },

  // --- Operating expenses -------------------------------------------------
  { number: '6000', name: 'Advertising and Marketing', type: 'expense' },
  // Added in Phase 11 for write-offs. Kept apart from a credit note on
  // purpose: a credit note says the customer owes less, a write-off says they
  // owe it and will not pay, and only the second is a cost of doing business.
  { number: '6025', name: 'Bad Debt', type: 'expense' },
  { number: '6050', name: 'Bank Service Charges', type: 'expense' },
  { number: '6100', name: 'Computer and Software', type: 'expense' },
  { number: '6150', name: 'Dues and Subscriptions', type: 'expense' },
  { number: '6200', name: 'Insurance', type: 'expense' },
  { number: '6250', name: 'Legal and Professional Fees', type: 'expense' },
  { number: '6300', name: 'Meals', type: 'expense' },
  { number: '6350', name: 'Office Supplies', type: 'expense' },
  { number: '6400', name: 'Rent and Lease', type: 'expense' },
  { number: '6450', name: 'Repairs and Maintenance', type: 'expense' },
  { number: '6500', name: 'Salaries and Wages', type: 'expense' },
  { number: '6550', name: 'Payroll Taxes', type: 'expense' },
  { number: '6600', name: 'Taxes and Licenses', type: 'expense' },
  { number: '6650', name: 'Telephone and Internet', type: 'expense' },
  { number: '6700', name: 'Travel', type: 'expense' },
  { number: '6750', name: 'Utilities', type: 'expense' },
  { number: '6800', name: 'Vehicle and Fuel', type: 'expense' },
  { number: '6850', name: 'Merchant and Processing Fees', type: 'expense' },
  {
    number: '6900',
    name: 'Uncategorized Expense',
    type: 'expense',
    isSystem: true,
    description: 'Holding account for spending awaiting review.',
  },
  {
    number: '6950',
    name: 'Ask My Accountant',
    type: 'expense',
    isSystem: true,
    description: 'Parked transactions for the accountant to resolve at close.',
  },

  // --- Other income / expense --------------------------------------------
  { number: '8000', name: 'Interest Income', type: 'other_income' },
  { number: '8100', name: 'Other Income', type: 'other_income' },
  { number: '9000', name: 'Interest Expense', type: 'other_expense' },
  { number: '9100', name: 'Depreciation Expense', type: 'other_expense' },
]

/**
 * Account numbers the application looks up by name. Referencing these
 * constants keeps the wiring explicit instead of scattering magic strings.
 */
export const SYSTEM_ACCOUNTS = {
  accountsReceivable: '1100',
  badDebt: '6025',
  accruedLiabilities: '2150',
  undepositedFunds: '1200',
  accountsPayable: '2000',
  retainedEarnings: '3200',
  openingBalanceEquity: '3900',
  uncategorizedIncome: '4990',
  uncategorizedExpense: '6900',
  askMyAccountant: '6950',
  defaultChecking: '1000',
  defaultCreditCard: '2100',
} as const

/**
 * Accounts an industry pack installs that the application still looks up by
 * number (spec §5, §20 Phase 7).
 *
 * Kept apart from `SYSTEM_ACCOUNTS` because they are not guaranteed to exist:
 * a company on the retail pack has no Retainage Receivable, and the code that
 * needs one has to say so rather than assume it.
 */
export const INDUSTRY_ACCOUNTS = {
  retainageReceivable: '1170',
  retainagePayable: '2570',
  contractRevenue: '4200',
  changeOrderRevenue: '4210',
  costsInExcessOfBillings: '1160',
  billingsInExcessOfCosts: '2560',
} as const
