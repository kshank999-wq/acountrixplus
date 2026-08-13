/**
 * The job-costing vocabulary: labels, kinds, and the pure expiry rule.
 *
 * Separated from the services because client components need these and the
 * services import the database. A `'use client'` file that reaches into a
 * module touching Postgres drags the driver into the browser bundle, which
 * fails the build — this file is the seam that keeps that from happening.
 *
 * Everything here is a constant or a pure function, which also means the
 * expiry rule below is testable without a database or a clock.
 */

// --- Cost codes ------------------------------------------------------------

export type CostType = 'labor' | 'material' | 'subcontract' | 'equipment' | 'other'

export const COST_TYPE_LABELS: Record<CostType, string> = {
  labor: 'Labor',
  material: 'Material',
  subcontract: 'Subcontract',
  equipment: 'Equipment',
  other: 'Other',
}

// --- Subcontractor compliance ---------------------------------------------

export type ComplianceKind =
  | 'general_liability'
  | 'workers_comp'
  | 'auto_liability'
  | 'w9'
  | 'license'
  | 'lien_waiver'
  | 'other'

export const COMPLIANCE_LABELS: Record<ComplianceKind, string> = {
  general_liability: 'General liability insurance',
  workers_comp: "Workers' compensation",
  auto_liability: 'Auto liability insurance',
  w9: 'W-9',
  license: 'Trade license',
  lien_waiver: 'Lien waiver',
  other: 'Other',
}

/**
 * What a general contractor is normally expected to hold for every sub.
 *
 * Lien waivers are per payment and W-9s are per year, so neither is on this
 * list — "missing" would be true of every sub on the day they are added, and a
 * warning that is always on is a warning nobody reads.
 */
export const REQUIRED_KINDS: ComplianceKind[] = ['general_liability', 'workers_comp', 'w9']

/** How many days before expiry a document starts warning. */
export const EXPIRY_WARNING_DAYS = 30

export type DocumentStatus = 'valid' | 'expiring' | 'expired' | 'no_expiry'

/**
 * A document's status on a given day.
 *
 * Derived, never stored: a stored status is correct on the day it is written
 * and wrong every day after, which is precisely the failure this feature
 * exists to prevent.
 */
export function documentStatus(
  expiresOn: string | null,
  asOfDate: string,
  warningDays = EXPIRY_WARNING_DAYS,
): DocumentStatus {
  if (!expiresOn) return 'no_expiry'

  const expiry = Date.parse(`${expiresOn}T00:00:00Z`)
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`)
  const daysRemaining = Math.floor((expiry - asOf) / 86_400_000)

  // Expiring *on* the as-of date still counts as expired: cover that ends
  // today does not cover an incident tomorrow morning.
  if (daysRemaining <= 0) return 'expired'
  if (daysRemaining <= warningDays) return 'expiring'
  return 'valid'
}
