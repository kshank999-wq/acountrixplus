/** Sub-navigation for the accounting workspace (spec §2). */
export const ACCOUNTING_NAV = [
  // First, because raising an invoice and entering a bill are what a business
  // does daily and every other screen here is about what happened afterwards.
  { href: '/accounting/invoices', label: 'Invoices & bills' },
  // Beside the documents they appear on, because the reason somebody opens
  // this screen is almost always a document they were just looking at.
  { href: '/accounting/people', label: 'Customers & suppliers' },
  // Third, because "what do I owe and what is late" is the question a business
  // asks itself every Friday, and until Phase 49 it had no screen — only an
  // as-of aging report with nothing on it clickable.
  { href: '/accounting/payables', label: 'What we owe' },
  // Fourth, because until Phase 52 payments were recorded from two screens and
  // then vanished into balances — "did that $1,500 go in twice?" was a question
  // with no screen behind it, and taking one back was impossible.
  { href: '/accounting/payments', label: 'Money in and out' },
  { href: '/accounting/reports', label: 'Reports' },
  { href: '/accounting/journal', label: 'Journal' },
  { href: '/accounting/receivables', label: 'Credits & statements' },
  { href: '/accounting/deposits', label: 'Deposits' },
  { href: '/accounting/billing', label: 'Recurring billing' },
  { href: '/accounting/budgets', label: 'Budgets' },
  { href: '/accounting/dimensions', label: 'Dimensions' },
  { href: '/accounting/currencies', label: 'Currencies' },
  { href: '/accounting/assets', label: 'Fixed assets' },
  { href: '/accounting/periods', label: 'Recurring & close' },
  { href: '/accounting/reconcile', label: 'Reconcile' },
  { href: '/accounting/documents', label: 'Documents' },
]
