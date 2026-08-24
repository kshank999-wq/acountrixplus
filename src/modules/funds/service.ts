import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { chartAccounts, dimensionValues, dimensions, funds } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import type { Restriction } from './restriction'
import { DomainError } from '@/modules/errors'

/**
 * Funds, and the dimension that makes them reportable (spec §5, Nonprofit).
 *
 * See `db/schema/funds.ts` for what a fund is and — more importantly — what it
 * is not. This file creates them.
 */

/** The company-wide dimension every fund is a value of. */
export const FUND_DIMENSION_CODE = 'FUND'

export class FundError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'FundError'
  }
}

/**
 * The Fund dimension, created on first use.
 *
 * `requirement: 'expected'` rather than optional: a charity's whole reporting
 * obligation is which money went where, so a posting with no fund is worth
 * flagging on Phase 16's coverage report. It is advisory there and advisory
 * here — a general-running-costs invoice legitimately belongs to no appeal, and
 * refusing to post it would teach people to invent a fund to get past the
 * error.
 */
async function fundDimension(ctx: ActorContext, exec: Executor): Promise<{ id: string }> {
  const [existing] = await exec
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.code, FUND_DIMENSION_CODE)))
    .limit(1)

  if (existing) return existing

  const [created] = await exec
    .insert(dimensions)
    .values({
      companyId: ctx.companyId,
      name: 'Fund',
      code: FUND_DIMENSION_CODE,
      description: 'Which fund or appeal an amount belongs to. Managed by the funds module.',
      requirement: 'expected',
      sortOrder: 10,
    })
    // Two funds created in the same moment would otherwise race to make the
    // dimension and one would lose on the unique index.
    .onConflictDoNothing({ target: [dimensions.companyId, dimensions.code] })
    .returning({ id: dimensions.id })

  if (created) return created

  const [raced] = await exec
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.code, FUND_DIMENSION_CODE)))
    .limit(1)

  if (!raced) throw new FundError('Could not resolve the Fund dimension.')
  return raced
}

/**
 * The seven accounts this module posts to, installed if they are missing.
 *
 * They come from the nonprofit pack, so a charity on that pack already has
 * them. A community-interest company on the "general" pack that switches the
 * module on does not — and without this, everything would work until the first
 * release run failed with "your chart of accounts is missing 4590", which is a
 * message about a problem the application could have solved itself.
 *
 * Only ever adds. An existing 4500 named something else is that company's
 * decision, and renaming it here would rewrite their chart behind their back.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    { number: INDUSTRY_ACCOUNTS.pledgesReceivable, name: 'Pledges Receivable', type: 'asset' as const },
    {
      number: INDUSTRY_ACCOUNTS.netAssetsWithoutRestriction,
      name: 'Net Assets Without Donor Restrictions',
      type: 'equity' as const,
    },
    {
      number: INDUSTRY_ACCOUNTS.netAssetsWithRestriction,
      name: 'Net Assets With Donor Restrictions',
      type: 'equity' as const,
    },
    {
      number: INDUSTRY_ACCOUNTS.contributionRevenue,
      name: 'Contributions and Donations',
      type: 'revenue' as const,
    },
    { number: INDUSTRY_ACCOUNTS.grantRevenue, name: 'Grant Revenue', type: 'revenue' as const },
    {
      number: INDUSTRY_ACCOUNTS.releasedFromRestriction,
      name: 'Net Assets Released from Restriction',
      type: 'revenue' as const,
    },
    {
      number: INDUSTRY_ACCOUNTS.releasedToUnrestricted,
      name: 'Net Assets Released — Unrestricted',
      type: 'revenue' as const,
    },
  ]

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(
          chartAccounts.number,
          wanted.map((account) => account.number),
        ),
      ),
    )

  const have = new Set(existing.map((row) => row.number))
  const missing = wanted.filter((account) => !have.has(account.number))
  if (missing.length === 0) return

  await exec
    .insert(chartAccounts)
    .values(missing.map((account) => ({ companyId: ctx.companyId, ...account })))
    .onConflictDoNothing()
}

export type FundRow = {
  id: string
  code: string
  name: string
  restriction: Restriction
  purpose: string | null
  expiresOn: string | null
  dimensionValueId: string
  isActive: boolean
  notes: string | null
}

function toFundRow(row: typeof funds.$inferSelect): FundRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    restriction: row.restriction as Restriction,
    purpose: row.purpose,
    expiresOn: row.expiresOn,
    dimensionValueId: row.dimensionValueId,
    isActive: row.isActive,
    notes: row.notes,
  }
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '-').slice(0, 32)
}

/**
 * Opens a fund, and the dimension value that makes it reportable.
 *
 * Both in one transaction, for the reason a property's are: a fund whose
 * dimension value did not commit would accept postings that land in Unassigned,
 * and nobody would find out until a donor asked what happened to their money.
 */
export async function createFund(
  ctx: ActorContext,
  input: {
    code: string
    name: string
    restriction?: Restriction
    purpose?: string | null
    expiresOn?: string | null
    notes?: string | null
  },
): Promise<FundRow> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'funds')

  const code = normalizeCode(input.code)
  if (!code) throw new FundError('A fund needs a short code, like ROOF or GENERAL.')

  const name = input.name.trim()
  if (!name) throw new FundError('A fund needs a name.')

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)
    const dimension = await fundDimension(ctx, tx)

    const [value] = await tx
      .insert(dimensionValues)
      .values({ companyId: ctx.companyId, dimensionId: dimension.id, code, name })
      .returning({ id: dimensionValues.id })

    const [row] = await tx
      .insert(funds)
      .values({
        companyId: ctx.companyId,
        code,
        name,
        restriction: (input.restriction ?? 'restricted') as never,
        purpose: input.purpose?.trim() || null,
        expiresOn: input.expiresOn ?? null,
        dimensionValueId: value.id,
        notes: input.notes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'fund.create',
        entityType: 'fund',
        entityId: row.id,
        after: { code, name, restriction: row.restriction },
      },
      tx,
    )

    return toFundRow(row)
  })
}

export async function listFunds(
  ctx: ActorContext,
  opts: { includeInactive?: boolean } = {},
): Promise<FundRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(funds)
    .where(scoped(ctx, funds, opts.includeInactive ? undefined : eq(funds.isActive, true)))
    .orderBy(asc(funds.code))

  return rows.map(toFundRow)
}

export async function requireFund(
  ctx: ActorContext,
  fundId: string,
  exec: Executor = db,
): Promise<FundRow> {
  const [row] = await exec
    .select()
    .from(funds)
    .where(scoped(ctx, funds, eq(funds.id, fundId)))
    .limit(1)

  if (!row) throw new FundError('That fund does not exist.')
  return toFundRow(row)
}

/**
 * Changes what a fund is for — but never what the donor said it was for.
 *
 * `restriction` is deliberately absent from the input. A gift given for the
 * roof does not become a gift for anything else because somebody edited a
 * dropdown, and a fund whose class could be edited would let a charity move
 * money between the two columns of its balance sheet without posting an entry
 * anybody could see. Closing the fund and opening another is the honest way to
 * change one, and it leaves the donations where they were given.
 */
export async function updateFund(
  ctx: ActorContext,
  fundId: string,
  input: { name?: string; purpose?: string | null; expiresOn?: string | null; notes?: string | null },
): Promise<FundRow> {
  requirePermission(ctx, 'accounting:journal')
  const before = await requireFund(ctx, fundId)

  const [row] = await db
    .update(funds)
    .set({
      name: input.name?.trim() || before.name,
      purpose: input.purpose === undefined ? before.purpose : input.purpose?.trim() || null,
      expiresOn: input.expiresOn === undefined ? before.expiresOn : input.expiresOn,
      notes: input.notes === undefined ? before.notes : input.notes?.trim() || null,
      updatedAt: new Date(),
    })
    .where(scoped(ctx, funds, eq(funds.id, fundId)))
    .returning()

  await recordAudit(ctx, {
    action: 'fund.update',
    entityType: 'fund',
    entityId: fundId,
    before,
    after: toFundRow(row),
  })

  return toFundRow(row)
}

/**
 * Closes a fund to new money.
 *
 * Does not touch the balance, and deliberately does not check that it is zero.
 * A charity winding up an appeal that still holds £300 has a real decision to
 * take about that £300 — return it, or ask the donors to redirect it — and
 * refusing to close the fund does not help them take it. What closing does is
 * stop the fund appearing on the pickers, so nothing new lands in it.
 */
export async function closeFund(ctx: ActorContext, fundId: string): Promise<FundRow> {
  requirePermission(ctx, 'accounting:journal')
  await requireFund(ctx, fundId)

  const [row] = await db
    .update(funds)
    .set({ isActive: false, updatedAt: new Date() })
    .where(scoped(ctx, funds, eq(funds.id, fundId)))
    .returning()

  await recordAudit(ctx, { action: 'fund.close', entityType: 'fund', entityId: fundId })
  return toFundRow(row)
}

/** The Fund dimension's id, or null when no fund has ever been opened. */
export async function fundDimensionId(ctx: ActorContext, exec: Executor = db): Promise<string | null> {
  const [row] = await exec
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.code, FUND_DIMENSION_CODE)))
    .limit(1)

  return row?.id ?? null
}

/** Resolves the accounts this module posts to, keyed by number. */
export async function fundAccounts(ctx: ActorContext, exec: Executor = db) {
  const numbers: string[] = [
    INDUSTRY_ACCOUNTS.pledgesReceivable,
    INDUSTRY_ACCOUNTS.contributionRevenue,
    INDUSTRY_ACCOUNTS.grantRevenue,
    INDUSTRY_ACCOUNTS.releasedFromRestriction,
    INDUSTRY_ACCOUNTS.releasedToUnrestricted,
    INDUSTRY_ACCOUNTS.netAssetsWithoutRestriction,
    INDUSTRY_ACCOUNTS.netAssetsWithRestriction,
  ]

  const rows = await exec
    .select({ id: chartAccounts.id, number: chartAccounts.number })
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, ctx.companyId), inArray(chartAccounts.number, numbers)))

  const map = new Map(rows.map((row) => [row.number, row.id]))

  function need(number: string, what: string): string {
    const id = map.get(number)
    if (!id) throw new FundError(`This needs ${what} (${number}), which this chart of accounts does not have.`)
    return id
  }

  return { map, need }
}
