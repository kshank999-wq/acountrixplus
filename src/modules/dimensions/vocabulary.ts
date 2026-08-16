/**
 * Client-safe labels for dimensions and fixed assets.
 *
 * Kept apart from the services because those import the database, and a client
 * component that imports one drags the driver into the browser bundle. Same
 * seam as `jobs/vocabulary.ts` and `timebilling/vocabulary.ts`.
 */

export const REQUIREMENT_LABELS: Record<string, string> = {
  optional: 'Optional',
  expected: 'Expected — coverage is reported',
}

export const METHOD_LABELS: Record<string, string> = {
  straight_line: 'Straight line',
  declining_balance: 'Declining balance',
  declining_balance_switch: 'Declining balance, switching to straight line',
}

export const METHOD_HINTS: Record<string, string> = {
  straight_line: 'The same amount every month. What most small companies use for most things.',
  declining_balance:
    'A fixed share of what is left, so the early months carry more. The final month takes the remainder, which is visibly larger.',
  declining_balance_switch:
    'Declining balance until straight line pays more, then straight line. Front-loaded without the lump at the end.',
}

export const CONVENTION_LABELS: Record<string, string> = {
  full_month: 'Full month',
  mid_month: 'Mid-month',
  half_year: 'Half-year',
}

export const CONVENTION_HINTS: Record<string, string> = {
  full_month: 'The month it goes into service counts whole.',
  mid_month: 'Half a month at each end. The schedule runs one month longer.',
  half_year: 'Six months in the first year whenever it arrived. The tail extends to match.',
}

export const ASSET_STATUS_LABELS: Record<string, string> = {
  active: 'depreciating',
  fully_depreciated: 'fully depreciated',
  disposed: 'disposed',
}
