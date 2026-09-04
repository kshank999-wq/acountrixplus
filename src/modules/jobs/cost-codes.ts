import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { costCodes } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { requireModule } from '@/modules/industry/modules'
import type { CostType } from './vocabulary'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * The cost code library (spec §5 "job costing").
 *
 * ## Why this is a dimension and not a set of accounts
 *
 * The obvious way to do job costing is to add accounts: 5110-Framing,
 * 5110-Concrete, 5110-Roofing. It works until the second job, at which point
 * the chart has to gain an account per phase per job and the profit & loss
 * becomes unreadable.
 *
 * A cost code is instead a column on the journal line, alongside the job. The
 * chart stays the eleven-account construction pack, the P&L stays comparable
 * with every other company on the platform (spec §23), and "framing labour
 * across all jobs this year" is a `GROUP BY`.
 */

export { COST_TYPE_LABELS, type CostType } from './vocabulary'

/**
 * A starter library, loosely following CSI divisions.
 *
 * Deliberately short. A contractor's real cost codes are their own, and a
 * hundred imported codes they did not choose is worse than a dozen they will
 * actually use — the point is to make the first job codeable in a minute, not
 * to guess at their business.
 */
export const DEFAULT_COST_CODES: Array<{
  code: string
  name: string
  division: string
  costType: CostType
  /** Account number in the construction pack this code usually posts to. */
  accountNumber: string
}> = [
  { code: '01-100', name: 'Supervision', division: 'General Requirements', costType: 'labor', accountNumber: '5120' },
  { code: '01-200', name: 'Permits and Fees', division: 'General Requirements', costType: 'other', accountNumber: '5150' },
  { code: '01-300', name: 'Temporary Facilities', division: 'General Requirements', costType: 'equipment', accountNumber: '5140' },
  { code: '02-100', name: 'Demolition', division: 'Site Work', costType: 'subcontract', accountNumber: '5130' },
  { code: '02-200', name: 'Excavation and Grading', division: 'Site Work', costType: 'subcontract', accountNumber: '5130' },
  { code: '03-300', name: 'Cast-in-Place Concrete', division: 'Concrete', costType: 'subcontract', accountNumber: '5130' },
  { code: '06-100', name: 'Rough Carpentry', division: 'Wood and Plastics', costType: 'labor', accountNumber: '5120' },
  { code: '06-200', name: 'Finish Carpentry', division: 'Wood and Plastics', costType: 'labor', accountNumber: '5120' },
  { code: '06-900', name: 'Lumber and Materials', division: 'Wood and Plastics', costType: 'material', accountNumber: '5110' },
  { code: '07-100', name: 'Roofing', division: 'Thermal and Moisture', costType: 'subcontract', accountNumber: '5130' },
  { code: '09-200', name: 'Drywall and Plaster', division: 'Finishes', costType: 'subcontract', accountNumber: '5130' },
  { code: '09-900', name: 'Painting', division: 'Finishes', costType: 'subcontract', accountNumber: '5130' },
  { code: '15-100', name: 'Plumbing', division: 'Mechanical', costType: 'subcontract', accountNumber: '5130' },
  { code: '15-500', name: 'HVAC', division: 'Mechanical', costType: 'subcontract', accountNumber: '5130' },
  { code: '16-100', name: 'Electrical', division: 'Electrical', costType: 'subcontract', accountNumber: '5130' },
]

/**
 * Installs the starter library, skipping codes that already exist.
 *
 * Idempotent, and never called by onboarding: a company gets cost codes when
 * somebody switches job costing on and asks for them, not because of the
 * industry they typed into a form.
 */
export async function installDefaultCostCodes(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<number> {
  const existing = await exec
    .select({ code: costCodes.code })
    .from(costCodes)
    .where(eq(costCodes.companyId, ctx.companyId))

  const already = new Set(existing.map((row) => row.code))
  const pending = DEFAULT_COST_CODES.filter((template) => !already.has(template.code))
  if (pending.length === 0) return 0

  const resolved = await Promise.all(
    pending.map(async (template) => ({
      template,
      account: await accountByNumber(ctx.companyId, template.accountNumber, exec),
    })),
  )

  await exec.insert(costCodes).values(
    resolved.map(({ template, account }, index) => ({
      companyId: ctx.companyId,
      code: template.code,
      name: template.name,
      division: template.division,
      costType: template.costType,
      defaultChartAccountId: account?.id ?? null,
      sortOrder: index,
    })),
  )

  return pending.length
}

export async function listCostCodes(
  ctx: ActorContext,
  opts: { activeOnly?: boolean } = {},
) {
  requirePermission(ctx, 'jobs:view')

  const rows = await db
    .select()
    .from(costCodes)
    .where(scoped(ctx, costCodes))
    .orderBy(asc(costCodes.code))

  return opts.activeOnly ? rows.filter((row) => row.isActive) : rows
}

export async function createCostCode(
  ctx: ActorContext,
  input: {
    code: string
    name: string
    division?: string
    costType?: CostType
    defaultChartAccountId?: string | null
  },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  const code = input.code.trim()
  if (!code) throw new Refusal('A cost code needs a code.')
  if (!input.name.trim()) throw new Refusal('A cost code needs a name.')

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(costCodes)
      .values({
        companyId: ctx.companyId,
        code,
        name: input.name.trim(),
        division: input.division?.trim() || null,
        costType: input.costType ?? 'other',
        defaultChartAccountId: input.defaultChartAccountId ?? null,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'cost_code.create',
        entityType: 'cost_code',
        entityId: created.id,
        after: { code: created.code, name: created.name, costType: created.costType },
      },
      tx,
    )

    return created
  })
}

export async function updateCostCode(
  ctx: ActorContext,
  costCodeId: string,
  input: { name?: string; division?: string | null; costType?: CostType; isActive?: boolean },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(costCodes)
      .where(and(eq(costCodes.id, costCodeId), eq(costCodes.companyId, ctx.companyId)))
      .limit(1)

    if (!before) throw missing('costCode')

    await tx
      .update(costCodes)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.division !== undefined ? { division: input.division } : {}),
        ...(input.costType !== undefined ? { costType: input.costType } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .where(and(eq(costCodes.id, costCodeId), eq(costCodes.companyId, ctx.companyId)))

    await recordAudit(
      ctx,
      {
        action: 'cost_code.update',
        entityType: 'cost_code',
        entityId: costCodeId,
        before: { name: before.name, isActive: before.isActive },
        after: input as Record<string, unknown>,
      },
      tx,
    )
  })
}

/** Loads cost codes by id under the tenant filter; foreign ids drop out. */
export async function costCodesByIds(ctx: ActorContext, ids: string[]) {
  if (ids.length === 0) return []
  return db
    .select()
    .from(costCodes)
    .where(scoped(ctx, costCodes, inArray(costCodes.id, ids)))
}
