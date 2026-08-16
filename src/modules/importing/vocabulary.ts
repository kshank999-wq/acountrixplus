/**
 * Client-safe names for the import wizard.
 *
 * Kept out of `app/actions/importing.ts` because a `'use server'` file may
 * export **only async functions** — a plain const there fails at runtime with
 * "A 'use server' file can only export async functions, found object", and it
 * fails when the page renders rather than when it builds.
 *
 * Kept out of the service modules for the usual reason: they import the
 * database, and a client component that imports one drags the driver into the
 * browser bundle. Same seam as `jobs/vocabulary.ts` and
 * `dimensions/vocabulary.ts`.
 */

export const IMPORT_KINDS = [
  'chart_of_accounts',
  'customers',
  'vendors',
  'trial_balance',
  'open_invoices',
  'open_bills',
] as const

export type ImportKind = (typeof IMPORT_KINDS)[number]

/** The order a migration actually happens in, with why each step comes first. */
export const IMPORT_STEPS: Array<{ kind: ImportKind; label: string; blurb: string }> = [
  {
    kind: 'chart_of_accounts',
    label: 'Chart of accounts',
    blurb: 'First, because everything after it refers to account numbers.',
  },
  {
    kind: 'customers',
    label: 'Customers',
    blurb: 'Needed before open invoices can be matched to anybody.',
  },
  { kind: 'vendors', label: 'Vendors', blurb: 'Needed before open bills can be matched.' },
  {
    kind: 'trial_balance',
    label: 'Trial balance',
    blurb:
      'The closing balances from your old system. Receivables and payables are read but not posted — the open documents supply those.',
  },
  {
    kind: 'open_invoices',
    label: 'Open invoices',
    blurb:
      'What customers still owe, one row each. This is where the receivable enters the ledger.',
  },
  { kind: 'open_bills', label: 'Open bills', blurb: 'What you still owe suppliers.' },
]

export const IMPORT_KIND_LABELS: Record<string, string> = Object.fromEntries(
  IMPORT_STEPS.map((step) => [step.kind, step.label]),
)
