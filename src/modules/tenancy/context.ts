import { and, eq, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import {
  hasPermission,
  parseOverrides,
  PermissionError,
  type Permission,
  type Role,
} from '@/modules/permissions'
import { DomainError } from '@/modules/errors'

/**
 * Who is acting, and on whose books.
 *
 * Every service function in the application takes an ActorContext as its first
 * argument. That is the whole tenant-isolation strategy: there is no ambient
 * "current company", so a query cannot accidentally omit the tenant filter —
 * it has nowhere to get the data from except a context that always carries one
 * (spec §14, §19).
 */
export type ActorContext = {
  userId: string
  userName: string
  companyId: string
  role: Role
  /** Raw JSON from the membership row; parsed lazily. */
  overrides?: string | null
  /** Request metadata recorded on audit events. */
  ipAddress?: string | null
  userAgent?: string | null
  /**
   * The practice this person is acting through, when they are (spec §14,
   * Phase 18). Null for somebody who works at the company itself.
   *
   * Carried on the context rather than looked up at each audit write, because
   * every service already has the context and none of them should have to
   * know that practices exist. It changes what an audit event *says*, never
   * what anybody may do — the role does that, and the role was capped by the
   * client when the engagement was accepted.
   */
  viaPractice?: string | null
}

/** Throws PermissionError unless the actor holds `permission`. */
export function requirePermission(ctx: ActorContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission, parseOverrides(ctx.overrides))) {
    throw new PermissionError(permission)
  }
}

export function can(ctx: ActorContext, permission: Permission): boolean {
  return hasPermission(ctx.role, permission, parseOverrides(ctx.overrides))
}

/**
 * Builds a WHERE clause scoped to the actor's company.
 *
 * Use this instead of writing `eq(table.companyId, ...)` by hand so the tenant
 * predicate is impossible to leave out:
 *
 *   db.select().from(bankTransactions)
 *     .where(scoped(ctx, bankTransactions, eq(bankTransactions.id, id)))
 */
export function scoped<T extends PgTable & { companyId: PgColumn }>(
  ctx: ActorContext,
  table: T,
  ...conditions: (SQL | undefined)[]
): SQL {
  const filters = [eq(table.companyId, ctx.companyId), ...conditions.filter(Boolean)]
  // `and` over a non-empty list always yields a SQL node.
  return and(...(filters as SQL[])) as SQL
}

/** Raised when a record exists but belongs to a different tenant. */
export class TenantIsolationError extends DomainError {
  readonly status = 404
  constructor(entity: string) {
    // Deliberately reported as "not found": confirming that an id exists in
    // another tenant would itself leak information.
    super(`${entity} not found`)
    this.name = 'TenantIsolationError'
  }
}

/**
 * Defence in depth for rows fetched by a path that did not already filter by
 * tenant. Prefer `scoped()`; use this when a row arrives from elsewhere.
 */
export function assertOwnedBy<T extends { companyId: string }>(
  ctx: ActorContext,
  row: T | undefined | null,
  entity: string,
): T {
  if (!row || row.companyId !== ctx.companyId) {
    throw new TenantIsolationError(entity)
  }
  return row
}
