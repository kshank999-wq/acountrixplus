import { DomainError } from '@/modules/errors'
/**
 * Role-based permissions with optional per-membership overrides (spec §14).
 *
 * Permission checks are deliberately pure and synchronous: they take a
 * resolved membership and return a boolean. That keeps them trivially
 * testable and means an authorization decision never depends on a database
 * round trip at the point of use.
 */

export const PERMISSIONS = [
  // Company administration
  'company:manage',
  'company:billing',
  'users:manage',

  // Bookkeeping (spec §3)
  'bookkeeping:view',
  'bookkeeping:categorize',
  'bookkeeping:rules',
  'bookkeeping:import',

  // Reconciliation (spec §4)
  'reconciliation:view',
  'reconciliation:perform',
  'reconciliation:reopen',

  // Professional accounting (spec §13)
  'accounting:view',
  'accounting:journal',
  /**
   * Agreeing that a bill may be paid (Phase 50).
   *
   * Deliberately its own permission rather than a fold into
   * `accounting:journal`, so that entering a bill and agreeing it may be paid
   * are separately grantable. The default roster gives both to the same roles
   * — an owner or accountant does all of it — and there the two-person rule
   * does the separating. The seam is for the company that widens things: a
   * colleague granted `accounting:journal` as a per-membership override to
   * enter supplier bills does not thereby gain the power to clear them.
   */
  'accounting:approve',
  'accounting:close',

  // Reporting
  'reports:view',
  'reports:financial',

  // Client-facing workspaces (spec §6–§10)
  'crm:view',
  'crm:manage',
  'proposals:view',
  'proposals:manage',
  'marketing:view',
  'marketing:manage',

  // Industry modules (spec §5, §20 Phase 7)
  'jobs:view',
  'jobs:manage',

  // Payroll and tax (spec §13, §19). Deliberately narrow: payroll is the most
  // sensitive data a small business holds, and `payroll:view` is not implied
  // by any general accounting permission.
  'payroll:view',
  'payroll:manage',
  'payroll:run',
  'tax:view',
  'tax:manage',

  // The optional AI module (spec §11, §14)
  'ai:use',
  'ai:manage',

  // Oversight
  'audit:view',
  /**
   * The background worker's queue and schedules (spec §18, Phase 10).
   *
   * Its own permission rather than folded into `audit:view`, because the
   * operations page is not read-only: retrying a job re-runs real work, and
   * pausing a schedule stops campaigns going out. Seeing what happened and
   * being able to make it happen again are different powers.
   */
  'operations:view',
  'operations:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export type Role =
  | 'owner'
  | 'manager'
  | 'bookkeeper'
  | 'accountant'
  | 'sales'
  | 'marketing'
  | 'readonly'

const ALL: Permission[] = [...PERMISSIONS]

/**
 * Default permission set per role, mirroring the table in spec §14.
 *
 * Note that `sales` and `marketing` get no bookkeeping or accounting
 * permissions at all — the spec is explicit that those roles have limited to
 * no financial visibility.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,

  manager: [
    'bookkeeping:view',
    'bookkeeping:categorize',
    'bookkeeping:rules',
    'reconciliation:view',
    'reports:view',
    'crm:view',
    'crm:manage',
    'proposals:view',
    'proposals:manage',
    'marketing:view',
    'marketing:manage',
    'jobs:view',
    'jobs:manage',
    // No payroll. A manager who needs it gets it as an explicit grant, so the
    // decision to show one colleague another's pay is always deliberate.
    'tax:view',
    'ai:use',
    'ai:manage',
    'audit:view',
    // Can see whether the campaigns they scheduled actually went out, and
    // cannot retry a job — re-running work is an accountant's or owner's call.
    'operations:view',
  ],

  bookkeeper: [
    'bookkeeping:view',
    'bookkeeping:categorize',
    'bookkeeping:rules',
    'bookkeeping:import',
    'reconciliation:view',
    'reconciliation:perform',
    'accounting:view',
    'reports:view',
    'crm:view',
    'jobs:view',
    'jobs:manage',
    // A bookkeeper records the sales tax they collected and can see what is
    // owed, but payroll is not theirs by default — it is the one part of the
    // books that is also somebody's private pay.
    'tax:view',
    'tax:manage',
    'ai:use',
    'operations:view',
  ],

  accountant: [
    'bookkeeping:view',
    'bookkeeping:categorize',
    'bookkeeping:rules',
    'bookkeeping:import',
    'reconciliation:view',
    'reconciliation:perform',
    'reconciliation:reopen',
    'accounting:view',
    'accounting:journal',
    // The second pair of eyes on money going out (Phase 50). An accountant
    // both enters and approves, so what actually separates the two is the
    // two-person rule: not the bill you entered yourself.
    'accounting:approve',
    'accounting:close',
    'reports:view',
    'reports:financial',
    'jobs:view',
    'jobs:manage',
    // An accountant prepares the returns and posts the runs; that is the job.
    'payroll:view',
    'payroll:manage',
    'payroll:run',
    'tax:view',
    'tax:manage',
    'ai:use',
    'audit:view',
    // An accountant retries the failed WIP proposal and pauses a schedule at a
    // period end. Both are their work rather than an administrator's.
    'operations:view',
    'operations:manage',
  ],

  sales: [
    'crm:view',
    'crm:manage',
    'proposals:view',
    'proposals:manage',
    // Sales sees the job a proposal became, and no financial statement.
    'jobs:view',
    'ai:use',
  ],

  marketing: ['crm:view', 'marketing:view', 'marketing:manage', 'ai:use'],

  readonly: [
    'bookkeeping:view',
    'reconciliation:view',
    'accounting:view',
    'reports:view',
    'jobs:view',
  ],
}

/** Granular adjustments layered on top of a role (spec §14). */
export type PermissionOverrides = {
  grant?: Permission[]
  revoke?: Permission[]
}

/**
 * Resolves the effective permission set. Revocations are applied after grants,
 * so an explicit revoke always wins — the safer direction when the two
 * conflict.
 */
export function effectivePermissions(
  role: Role,
  overrides?: PermissionOverrides | null,
): Set<Permission> {
  const permissions = new Set<Permission>(ROLE_PERMISSIONS[role])

  for (const granted of overrides?.grant ?? []) permissions.add(granted)
  for (const revoked of overrides?.revoke ?? []) permissions.delete(revoked)

  return permissions
}

export function hasPermission(
  role: Role,
  permission: Permission,
  overrides?: PermissionOverrides | null,
): boolean {
  return effectivePermissions(role, overrides).has(permission)
}

/** Thrown when an actor lacks a required permission. Maps to HTTP 403. */
export class PermissionError extends DomainError {
  readonly status = 403
  constructor(readonly permission: Permission) {
    super(`Missing required permission: ${permission}`)
    this.name = 'PermissionError'
  }
}

/** Parses the JSON stored on `memberships.permissionOverrides`. */
export function parseOverrides(raw: string | null | undefined): PermissionOverrides | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PermissionOverrides
    return {
      grant: parsed.grant?.filter(isPermission) ?? [],
      revoke: parsed.revoke?.filter(isPermission) ?? [],
    }
  } catch {
    // Malformed overrides must not silently widen access — fall back to the
    // role's defaults.
    return null
  }
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}
