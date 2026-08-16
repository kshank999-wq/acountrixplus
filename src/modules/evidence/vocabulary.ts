/**
 * Names and constants a client component may import.
 *
 * Kept apart from `subjects.ts` because that file imports the schema, and a
 * module that touches the database cannot be pulled into a `'use client'`
 * bundle. Same seam as the jobs, payroll, importing and auth vocabularies —
 * and the same reason: the alternative is duplicating these strings in the UI,
 * where they drift.
 */

export const EVIDENCE_SUBJECT_LABELS: Record<string, string> = {
  bank_transaction: 'Transaction',
  journal_entry: 'Journal entry',
  invoice: 'Invoice',
  bill: 'Bill',
  payment: 'Payment',
  fixed_asset: 'Fixed asset',
  reconciliation: 'Reconciliation',
  payroll_run: 'Payroll run',
  expense: 'Expense',
  customer: 'Customer',
  vendor: 'Vendor',
}

/** Where a record of each kind can be looked at, for the documents page. */
export const EVIDENCE_SUBJECT_PATHS: Record<string, string | null> = {
  bank_transaction: '/bookkeeping',
  journal_entry: '/accounting/journal',
  invoice: '/accounting/receivables',
  bill: '/accounting/receivables',
  payment: '/accounting/receivables',
  fixed_asset: '/accounting/assets',
  reconciliation: '/accounting/reconciliation',
  payroll_run: '/payroll',
  expense: '/time',
  customer: '/crm',
  vendor: '/crm',
}

/** Bytes as something a person reads, without a library for it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What the upload control offers, mirroring EVIDENCE_CONTENT_TYPES. */
export const EVIDENCE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/heic,application/pdf,text/plain,text/csv,' +
  'application/vnd.ms-excel,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const MAX_EVIDENCE_MB = 10
