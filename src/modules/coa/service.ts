import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { chartAccounts } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { industryPack, type Industry } from './industry'
import { STANDARD_ACCOUNTS, SYSTEM_ACCOUNTS, type AccountTemplate } from './standard'

/**
 * Builds the full account list for an industry: the standard chart plus the
 * industry pack, sorted by account number.
 *
 * A pack that reuses a standard number is ignored rather than overriding it —
 * the standard chart is the shared backbone and must stay consistent across
 * companies (spec §23). `assertNoPackCollisions` in the tests keeps packs
 * honest so this never silently drops an account someone meant to add.
 */
export function accountsForIndustry(industry: Industry): AccountTemplate[] {
  const standardNumbers = new Set(STANDARD_ACCOUNTS.map((a) => a.number))
  const packAccounts = industryPack(industry).accounts.filter(
    (a) => !standardNumbers.has(a.number),
  )

  return [...STANDARD_ACCOUNTS, ...packAccounts].sort((a, b) => a.number.localeCompare(b.number))
}

/**
 * Installs the chart of accounts for a newly created company (spec §5, §22).
 *
 * Called inside the onboarding transaction, so a company is never left half
 * seeded. Idempotent: re-running skips accounts whose numbers already exist.
 */
export async function installChartOfAccounts(
  companyId: string,
  industry: Industry,
  exec: Executor = db,
): Promise<number> {
  const templates = accountsForIndustry(industry)

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(eq(chartAccounts.companyId, companyId))

  const alreadyInstalled = new Set(existing.map((row) => row.number))
  const pending = templates.filter((t) => !alreadyInstalled.has(t.number))
  if (pending.length === 0) return 0

  await exec.insert(chartAccounts).values(
    pending.map((t) => ({
      companyId,
      number: t.number,
      name: t.name,
      type: t.type,
      subtype: t.subtype ?? null,
      description: t.description ?? null,
      isSystem: t.isSystem ?? false,
    })),
  )

  return pending.length
}

/** Every account for the company, ordered by number. */
export async function listAccounts(ctx: ActorContext, opts?: { activeOnly?: boolean }) {
  requirePermission(ctx, 'bookkeeping:view')

  const rows = await db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))
    .orderBy(asc(chartAccounts.number))

  return opts?.activeOnly ? rows.filter((r) => r.isActive) : rows
}

/**
 * Accounts a bank transaction can be categorized into.
 *
 * Balance-sheet accounts are excluded from the common case: assigning a card
 * purchase to Accounts Receivable is almost always a mistake, and the ones
 * that are legitimate (transfers, owner draws) have their own flows.
 */
export async function categorizableAccounts(ctx: ActorContext) {
  const rows = await listAccounts(ctx, { activeOnly: true })
  const categorizable = new Set(['revenue', 'cogs', 'expense', 'other_income', 'other_expense'])
  return rows.filter((row) => categorizable.has(row.type))
}

/** Looks up one account by number, e.g. via SYSTEM_ACCOUNTS. */
export async function accountByNumber(companyId: string, number: string, exec: Executor = db) {
  // Number is unique per company, so this pair identifies exactly one row.
  const [row] = await exec
    .select()
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, companyId), eq(chartAccounts.number, number)))
    .limit(1)

  return row ?? null
}

/** Resolves the system accounts in one query, keyed by account number. */
export async function systemAccountMap(companyId: string, exec: Executor = db) {
  const numbers: string[] = Object.values(SYSTEM_ACCOUNTS)

  const rows = await exec
    .select()
    .from(chartAccounts)
    .where(
      and(eq(chartAccounts.companyId, companyId), inArray(chartAccounts.number, numbers)),
    )

  return new Map(rows.map((r) => [r.number, r]))
}

export type CreateAccountInput = {
  number: string
  name: string
  type: AccountTemplate['type']
  subtype?: string | null
  description?: string | null
  parentId?: string | null
}

/** Creates a custom account (spec §5 allows full customization). */
export async function createAccount(ctx: ActorContext, input: CreateAccountInput) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(chartAccounts)
      .values({
        companyId: ctx.companyId,
        number: input.number,
        name: input.name,
        type: input.type,
        subtype: input.subtype ?? null,
        description: input.description ?? null,
        parentId: input.parentId ?? null,
        isSystem: false,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'account.create',
        entityType: 'chart_account',
        entityId: account.id,
        after: { number: account.number, name: account.name, type: account.type },
      },
      tx,
    )

    return account
  })
}

/** Loads accounts by id, scoped to the tenant. Ids from other tenants drop out. */
export async function accountsByIds(ctx: ActorContext, ids: string[]) {
  if (ids.length === 0) return []
  return db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.id, ids)))
}
