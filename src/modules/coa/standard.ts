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
  {
    number: '1250',
    name: 'Payments in Transit',
    type: 'asset',
    subtype: 'other_current_asset',
    isSystem: true,
    description:
      'Card payments the processor has taken and not yet deposited. Cleared by the payout.',
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
  {
    number: '2050',
    name: 'Goods Received Not Invoiced',
    type: 'liability',
    subtype: 'accrued_liability',
    description:
      'Stock that has arrived and not yet been billed. Cleared when the supplier’s invoice lands.',
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
  // Phase 14. Its own account rather than folded into Cost of Goods Sold:
  // stock that went missing and stock that was sold are different facts, and a
  // margin that quietly includes theft explains nothing.
  { number: '5400', name: 'Inventory Shrinkage', type: 'cogs' },
  // Phase 48. Where the difference goes when a supplier's invoice does not
  // agree with what the goods were taken into stock at. Its own account
  // because it is a cost of *buying* rather than of selling, and because the
  // alternative — leaving the difference in 2050 — makes a clearing account
  // impossible to reconcile against the deliveries it is supposed to hold.
  { number: '5450', name: 'Purchase Price Variance', type: 'cogs' },

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
  // Phase 16. Selling a truck for more than its written-down value is not
  // trading income — putting it in Sales Revenue would flatter the margin of a
  // business that sells services, in a month it happened to sell a van.
  { number: '8200', name: 'Gain on Asset Disposal', type: 'other_income' },
  { number: '9000', name: 'Interest Expense', type: 'other_expense' },
  { number: '9100', name: 'Depreciation Expense', type: 'other_expense' },
  { number: '9200', name: 'Loss on Asset Disposal', type: 'other_expense' },
]

/**
 * Account numbers the application looks up by name. Referencing these
 * constants keeps the wiring explicit instead of scattering magic strings.
 */
export const SYSTEM_ACCOUNTS = {
  accountsReceivable: '1100',
  badDebt: '6025',
  accruedLiabilities: '2150',
  goodsReceivedNotInvoiced: '2050',
  inventory: '1400',
  costOfGoodsSold: '5000',
  inventoryShrinkage: '5400',
  purchasePriceVariance: '5450',
  undepositedFunds: '1200',
  // Phase 44. Deliberately *not* Undeposited Funds: that is cash in hand
  // waiting to be walked to the bank, and a deposit slip offers to bank it.
  // Money at a processor is neither in hand nor bankable — it arrives on its
  // own, net, in a batch — and the two must not be summed into one figure.
  paymentsInTransit: '1250',
  merchantFees: '6850',
  accountsPayable: '2000',
  retainedEarnings: '3200',
  openingBalanceEquity: '3900',
  uncategorizedIncome: '4990',
  uncategorizedExpense: '6900',
  // Phase 16. The fixed asset register reconciles to these two: the sum of
  // the register's costs is `fixedAssets`, and the sum of its depreciation is
  // `accumulatedDepreciation`.
  fixedAssets: '1500',
  accumulatedDepreciation: '1510',
  depreciationExpense: '9100',
  gainOnDisposal: '8200',
  lossOnDisposal: '9200',
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
  // Professional services (Phase 15). Declared by the pack since Phase 0 and
  // used for the first time here.
  unbilledWorkInProgress: '1150',
  clientRetainers: '2550',
  consultingRevenue: '4110',
  retainerRevenue: '4120',
  reimbursableRevenue: '4130',
  retainageReceivable: '1170',
  retainagePayable: '2570',
  contractRevenue: '4200',
  changeOrderRevenue: '4210',
  costsInExcessOfBillings: '1160',
  billingsInExcessOfCosts: '2560',

  // Real estate (Phase 23). Installed by the pack since Phase 0 and used for
  // the first time here — the same story the professional-services accounts
  // above had in Phase 15.
  //
  // `tenantSecurityDeposits` is a liability and that is the whole point: it is
  // the tenant's money, held. It never appears on a profit and loss until a
  // deposit is applied, and applying it is the moment it stops being theirs.
  tenantSecurityDeposits: '2580',
  rentalIncome: '4300',
  camReimbursements: '4310',
  lateFeeIncome: '4320',

  // Nonprofit (Phase 26). The pack has installed the net-asset and
  // contribution accounts since Phase 0; the two release accounts are new,
  // because nothing before this phase had a reason to move money between the
  // two columns.
  //
  // The pair is the point. A release changes no total — it is the same money,
  // reported in a different column — so it has to be a debit and a credit that
  // sum to zero on the statement of activities. One account with a signed
  // amount would net to zero too, and would also be invisible: the reader
  // could not see that £4,000 left the restricted column *because* £4,000
  // arrived in the unrestricted one.
  pledgesReceivable: '1180',
  netAssetsWithoutRestriction: '3300',
  netAssetsWithRestriction: '3400',
  contributionRevenue: '4500',
  grantRevenue: '4510',
  releasedFromRestriction: '4590',
  releasedToUnrestricted: '4595',

  // Manufacturing (Phase 27). Installed by the pack since Phase 0 and used for
  // the first time here.
  //
  // Three inventory accounts rather than one, because a manufacturer's balance
  // sheet has to say how much of its stock is steel, how much is half-built,
  // and how much is ready to sell — three very different answers to "how
  // quickly could you turn that into money". Phase 14 already lets an item name
  // its own inventory account, which is the seam that makes this work without a
  // second inventory model.
  rawMaterials: '1440',
  workInProcess: '1450',
  finishedGoods: '1460',
  directMaterials: '5060',
  directLabor: '5070',
  manufacturingOverhead: '5080',
} as const
