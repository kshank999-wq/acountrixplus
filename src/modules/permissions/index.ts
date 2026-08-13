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

  // Oversight
  'audit:view',
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
    'audit:view',
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
    'accounting:close',
    'reports:view',
    'reports:financial',
    'audit:view',
  ],

  sales: ['crm:view', 'crm:manage', 'proposals:view', 'proposals:manage'],

  marketing: ['crm:view', 'marketing:view', 'marketing:manage'],

  readonly: ['bookkeeping:view', 'reconciliation:view', 'accounting:view', 'reports:view'],
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
export class PermissionError extends Error {
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
