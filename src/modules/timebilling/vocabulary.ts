/**
 * Wording for time and billing, importable by client components.
 *
 * The same seam as `jobs/vocabulary.ts` and `auth/vocabulary.ts`: `billing.ts`
 * imports the database, and a client component pulling a label out of it drags
 * the database client into the browser bundle.
 */

export const GROUPING_LABELS: Record<string, string> = {
  person: 'One line per person',
  day: 'One line per day',
  service: 'One line per kind of work',
  single: 'A single line for all the time',
}

export const TIME_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  billed: 'Billed',
  written_off: 'Written off',
}
