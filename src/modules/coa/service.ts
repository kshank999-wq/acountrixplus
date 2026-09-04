import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { chartAccounts } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError } from '@/modules/errors'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { industryPack, type Industry } from './industry'
import { STANDARD_ACCOUNTS, SYSTEM_ACCOUNTS, type AccountTemplate } from './standard'
import { proposeAccount } from './proposal'

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

/**
 * A refusal written for whoever proposed the account.
 *
 * `DomainError` rather than `Error`, because `messageFor` denies by default:
 * anything that is not a `DomainError` reaches the browser as "Something went
 * wrong", which is exactly what the first browser pass showed for all four
 * refusals — the sentences were being thrown away one layer above the screen.
 */
export class ChartError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'ChartError'
  }
}

/**
 * Creates a custom account (spec §5 allows full customization).
 *
 * **Reachable at last (Phase 118).** Written in Phase 1 and called by nothing
 * for 117 phases — there was no screen showing the chart of accounts at all,
 * so a business could neither see nor extend its own. It also validated
 * nothing: a duplicate number reached the unique index and came back as a raw
 * Postgres error, and an expense could be numbered among the assets. The
 * refusals arrive with the screen, because a screen that accepts anything is
 * how a chart of accounts stops being one.
 */
export async function createAccount(ctx: ActorContext, input: CreateAccountInput) {
  requirePermission(ctx, 'accounting:journal')

  const existing = await db
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))

  const verdict = proposeAccount({
    proposal: { number: input.number, name: input.name, type: input.type },
    taken: existing.map((row) => row.number),
    reserved: Object.values(SYSTEM_ACCOUNTS),
  })

  if (!verdict.ok) throw new ChartError(verdict.why)

  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(chartAccounts)
      .values({
        companyId: ctx.companyId,
        number: verdict.number,
        name: verdict.name,
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

/**
 * Retires an account, or brings one back (Phase 118).
 *
 * Not a delete: the journal entries behind it still point at it, and a chart
 * that loses an account loses the heading its own history was filed under.
 * Retiring takes it out of every picker — `listAccounts({ activeOnly: true })`
 * and `categorizableAccounts` both read `is_active` — while the reports that
 * walk the ledger keep reporting it, which is what a business that stopped
 * using an account actually wants.
 *
 * A system account cannot be retired. The application looks those up by number
 * and posts into them without asking, so retiring one would hide an account
 * that is still being used from every screen that offers a choice.
 */
export async function setAccountRetired(
  ctx: ActorContext,
  input: { accountId: string; retired: boolean },
) {
  requirePermission(ctx, 'accounting:journal')

  const [account] = await db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, input.accountId)))
    .limit(1)

  if (!account) throw new ChartError('That account is not on this chart.')

  if (account.isSystem && input.retired) {
    throw new ChartError(
      `${account.number} ${account.name} is one of the accounts this application posts into by ` +
        'number. Retiring it would take it out of every picker while the software kept using ' +
        'it, so it stays.',
    )
  }

  const [updated] = await db
    .update(chartAccounts)
    .set({ isActive: !input.retired })
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, input.accountId)))
    .returning()

  await recordAudit(ctx, {
    action: input.retired ? 'account.retire' : 'account.restore',
    entityType: 'chart_account',
    entityId: account.id,
    before: { isActive: account.isActive },
    after: { isActive: updated.isActive },
  })

  return updated
}
