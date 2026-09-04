import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  changeOrderLines,
  changeOrders,
  costCodes,
  jobBudgetLines,
  projects,
  scheduleOfValues,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { Refusal } from '@/modules/errors'

/**
 * Job budgets and change orders (spec §5 "estimates, change orders").
 *
 * ## What a change order does, and what it deliberately does not
 *
 * Approving a change order revises two things: the contract value on the job,
 * and the cost budget for the affected cost codes. It posts **nothing** to the
 * ledger.
 *
 * That is not an omission. A change order is an agreement about work that has
 * not happened yet. Revenue still arrives when the work is billed and cost
 * still arrives when it is incurred; posting on approval would recognize
 * revenue for work nobody has done, which is exactly the error percentage-of-
 * completion accounting exists to avoid.
 *
 * The consequence is worth stating plainly, because it is the phase's central
 * claim: the construction workflows here change what the *reports* say about a
 * job, and never what the *ledger* contains (spec §20, §23).
 */

export type BudgetLineInput = {
  costCodeId: string
  description?: string
  originalAmountCents: number
}

export type BudgetLine = {
  id: string
  costCodeId: string
  code: string
  name: string
  costType: string
  description: string | null
  originalAmountCents: number
  changeAmountCents: number
  /** Original plus approved change orders — what the job is now expected to cost. */
  revisedAmountCents: number
}

async function assertJob(ctx: ActorContext, projectId: string, exec: Executor = db) {
  const [job] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, ctx.companyId)))
    .limit(1)

  if (!job) throw new Error('Job not found')
  return job
}

/** The job's budget, one row per cost code, ordered by code. */
export async function jobBudget(ctx: ActorContext, projectId: string): Promise<BudgetLine[]> {
  requirePermission(ctx, 'jobs:view')

  const rows = await db
    .select({
      id: jobBudgetLines.id,
      costCodeId: jobBudgetLines.costCodeId,
      code: costCodes.code,
      name: costCodes.name,
      costType: costCodes.costType,
      description: jobBudgetLines.description,
      originalAmountCents: jobBudgetLines.originalAmountCents,
      changeAmountCents: jobBudgetLines.changeAmountCents,
    })
    .from(jobBudgetLines)
    .innerJoin(costCodes, eq(costCodes.id, jobBudgetLines.costCodeId))
    .where(scoped(ctx, jobBudgetLines, eq(jobBudgetLines.projectId, projectId)))
    .orderBy(asc(costCodes.code))

  return rows.map((row) => ({
    ...row,
    revisedAmountCents: row.originalAmountCents + row.changeAmountCents,
  }))
}

/**
 * Sets the original budget for a job.
 *
 * Upserts by cost code and leaves `changeAmountCents` alone, so re-importing a
 * corrected estimate does not silently erase approved change orders. Removing
 * a cost code from the estimate deletes its line only when no change order has
 * touched it — otherwise the approved change would vanish with it.
 */
export async function setJobBudget(
  ctx: ActorContext,
  projectId: string,
  lines: BudgetLineInput[],
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')
  await assertJob(ctx, projectId)

  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.costCodeId)) {
      throw new Refusal('The same cost code appears twice in the budget.')
    }
    seen.add(line.costCodeId)
    if (!Number.isInteger(line.originalAmountCents)) {
      throw new Refusal('Budget amounts must be whole numbers of cents.')
    }
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(jobBudgetLines)
      .where(
        and(
          eq(jobBudgetLines.companyId, ctx.companyId),
          eq(jobBudgetLines.projectId, projectId),
        ),
      )

    for (const line of lines) {
      await tx
        .insert(jobBudgetLines)
        .values({
          companyId: ctx.companyId,
          projectId,
          costCodeId: line.costCodeId,
          description: line.description ?? null,
          originalAmountCents: line.originalAmountCents,
        })
        .onConflictDoUpdate({
          target: [jobBudgetLines.projectId, jobBudgetLines.costCodeId],
          set: {
            description: line.description ?? null,
            originalAmountCents: line.originalAmountCents,
            updatedAt: new Date(),
          },
        })
    }

    const dropped = existing.filter(
      (row) => !seen.has(row.costCodeId) && row.changeAmountCents === 0,
    )
    for (const row of dropped) {
      await tx.delete(jobBudgetLines).where(eq(jobBudgetLines.id, row.id))
    }

    await recordAudit(
      ctx,
      {
        action: 'budget.set',
        entityType: 'project',
        entityId: projectId,
        after: {
          lines: lines.length,
          totalCents: lines.reduce((sum, line) => sum + line.originalAmountCents, 0),
        },
      },
      tx,
    )

    return jobBudget(ctx, projectId)
  })
}

// --- Change orders ---------------------------------------------------------

export type ChangeOrderLineInput = {
  costCodeId: string
  description?: string
  /** Signed: a deductive change lowers the budget. */
  amountCents: number
}

export async function listChangeOrders(ctx: ActorContext, projectId: string) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select()
    .from(changeOrders)
    .where(scoped(ctx, changeOrders, eq(changeOrders.projectId, projectId)))
    .orderBy(asc(changeOrders.number))
}

export async function changeOrderWithLines(ctx: ActorContext, changeOrderId: string) {
  requirePermission(ctx, 'jobs:view')

  const [order] = await db
    .select()
    .from(changeOrders)
    .where(scoped(ctx, changeOrders, eq(changeOrders.id, changeOrderId)))
    .limit(1)

  if (!order) return null

  const lines = await db
    .select({
      id: changeOrderLines.id,
      costCodeId: changeOrderLines.costCodeId,
      code: costCodes.code,
      name: costCodes.name,
      description: changeOrderLines.description,
      amountCents: changeOrderLines.amountCents,
    })
    .from(changeOrderLines)
    .innerJoin(costCodes, eq(costCodes.id, changeOrderLines.costCodeId))
    .where(eq(changeOrderLines.changeOrderId, changeOrderId))
    .orderBy(asc(changeOrderLines.sortOrder))

  return { order, lines }
}

export async function createChangeOrder(
  ctx: ActorContext,
  input: {
    projectId: string
    number?: string
    title: string
    description?: string
    contractAmountCents: number
    scheduleDays?: number
    requestedOn?: string
    lines?: ChangeOrderLineInput[]
  },
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')
  await assertJob(ctx, input.projectId)

  if (!input.title.trim()) throw new Refusal('A change order needs a title.')

  const lines = input.lines ?? []
  const costAmountCents = lines.reduce((sum, line) => sum + line.amountCents, 0)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextChangeOrderNumber(input.projectId, tx))

    const [order] = await tx
      .insert(changeOrders)
      .values({
        companyId: ctx.companyId,
        projectId: input.projectId,
        number,
        title: input.title.trim(),
        description: input.description ?? null,
        status: 'draft',
        contractAmountCents: input.contractAmountCents,
        costAmountCents,
        scheduleDays: input.scheduleDays ?? 0,
        requestedOn: input.requestedOn ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    if (lines.length > 0) {
      await tx.insert(changeOrderLines).values(
        lines.map((line, index) => ({
          companyId: ctx.companyId,
          changeOrderId: order.id,
          costCodeId: line.costCodeId,
          description: line.description ?? null,
          amountCents: line.amountCents,
          sortOrder: index,
        })),
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'change_order.create',
        entityType: 'change_order',
        entityId: order.id,
        after: {
          number,
          title: order.title,
          contractAmountCents: input.contractAmountCents,
          costAmountCents,
        },
      },
      tx,
    )

    return order
  })
}

/**
 * Approves a change order.
 *
 * Three effects, all of them forward-looking:
 *
 *  1. The job's contract value moves by the change order's contract amount.
 *  2. Each budget line's `changeAmountCents` moves by its share.
 *  3. A schedule-of-values item is added, so the change becomes billable.
 *
 * And no journal entry, for the reason at the top of this file.
 *
 * Approving twice is refused rather than made idempotent: a second approval is
 * always a mistake, and silently doing nothing would hide it.
 */
export async function approveChangeOrder(
  ctx: ActorContext,
  changeOrderId: string,
  input: { decidedOn?: string; notes?: string; revenueAccountId?: string } = {},
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(changeOrders)
      .where(and(eq(changeOrders.id, changeOrderId), eq(changeOrders.companyId, ctx.companyId)))
      .limit(1)

    if (!order) throw new Error('Change order not found')
    if (order.status === 'approved') {
      throw new Refusal('That change order has already been approved.')
    }
    if (order.status === 'rejected') {
      throw new Refusal('That change order was rejected. Raise a new one instead.')
    }

    const lines = await tx
      .select()
      .from(changeOrderLines)
      .where(eq(changeOrderLines.changeOrderId, changeOrderId))

    // 1. The contract value.
    await tx
      .update(projects)
      .set({
        contractValueCents: sql`${projects.contractValueCents} + ${order.contractAmountCents}`,
      })
      .where(and(eq(projects.id, order.projectId), eq(projects.companyId, ctx.companyId)))

    // 2. The budget, one cost code at a time. A cost code the original
    //    estimate never mentioned gets a line with a zero original — the
    //    change is entirely additional scope, and that is what the report
    //    should show.
    for (const line of lines) {
      await tx
        .insert(jobBudgetLines)
        .values({
          companyId: ctx.companyId,
          projectId: order.projectId,
          costCodeId: line.costCodeId,
          description: line.description ?? null,
          originalAmountCents: 0,
          changeAmountCents: line.amountCents,
        })
        .onConflictDoUpdate({
          target: [jobBudgetLines.projectId, jobBudgetLines.costCodeId],
          set: {
            changeAmountCents: sql`${jobBudgetLines.changeAmountCents} + ${line.amountCents}`,
            updatedAt: new Date(),
          },
        })
    }

    // 3. Make it billable, when there is a schedule of values to add it to and
    //    the change actually changes the contract.
    if (order.contractAmountCents !== 0) {
      const revenueAccountId =
        input.revenueAccountId ?? (await defaultSovAccount(ctx, order.projectId, tx))

      if (revenueAccountId) {
        await tx.insert(scheduleOfValues).values({
          companyId: ctx.companyId,
          projectId: order.projectId,
          itemNumber: `CO-${order.number}`,
          description: `Change order ${order.number} — ${order.title}`,
          scheduledValueCents: order.contractAmountCents,
          chartAccountId: revenueAccountId,
          changeOrderId: order.id,
          sortOrder: 1000,
        })
      }
    }

    await tx
      .update(changeOrders)
      .set({
        status: 'approved',
        decidedOn: input.decidedOn ?? new Date().toISOString().slice(0, 10),
        decidedBy: ctx.userId,
        decisionNotes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(changeOrders.id, changeOrderId))

    await recordAudit(
      ctx,
      {
        action: 'change_order.approve',
        entityType: 'change_order',
        entityId: changeOrderId,
        before: { status: order.status },
        after: {
          status: 'approved',
          contractAmountCents: order.contractAmountCents,
          costAmountCents: order.costAmountCents,
          // Stated in the audit trail because it is the surprising part.
          postedToLedger: false,
        },
      },
      tx,
    )

    return { ...order, status: 'approved' as const }
  })
}

export async function rejectChangeOrder(
  ctx: ActorContext,
  changeOrderId: string,
  input: { notes?: string } = {},
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(changeOrders)
      .where(and(eq(changeOrders.id, changeOrderId), eq(changeOrders.companyId, ctx.companyId)))
      .limit(1)

    if (!order) throw new Error('Change order not found')
    if (order.status === 'approved') {
      throw new Refusal('That change order is already approved. Raise a deductive one to undo it.')
    }

    await tx
      .update(changeOrders)
      .set({
        status: 'rejected',
        decidedOn: new Date().toISOString().slice(0, 10),
        decidedBy: ctx.userId,
        decisionNotes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(changeOrders.id, changeOrderId))

    await recordAudit(
      ctx,
      {
        action: 'change_order.reject',
        entityType: 'change_order',
        entityId: changeOrderId,
        before: { status: order.status },
        after: { status: 'rejected', notes: input.notes ?? null },
      },
      tx,
    )
  })
}

/** Next change order number for a job: 001, 002, … */
async function nextChangeOrderNumber(projectId: string, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(changeOrders)
    .where(eq(changeOrders.projectId, projectId))

  return String(Number(row?.count ?? 0) + 1).padStart(3, '0')
}

/** The revenue account the job's existing contract items bill to. */
async function defaultSovAccount(
  ctx: ActorContext,
  projectId: string,
  tx: Executor,
): Promise<string | null> {
  const [row] = await tx
    .select({ chartAccountId: scheduleOfValues.chartAccountId })
    .from(scheduleOfValues)
    .where(
      and(
        eq(scheduleOfValues.companyId, ctx.companyId),
        eq(scheduleOfValues.projectId, projectId),
      ),
    )
    .orderBy(desc(scheduleOfValues.sortOrder))
    .limit(1)

  return row?.chartAccountId ?? null
}
