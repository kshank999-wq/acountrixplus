import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  customers,
  invoices,
  progressBillingLines,
  progressBillings,
  projects,
  scheduleOfValues,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { requireModule } from '@/modules/industry/modules'
import { createInvoice } from '@/modules/receivables/service'

/**
 * Schedule of values and progress billing (spec §5).
 *
 * ## What an application for payment is, here
 *
 * An AIA-style application says: here is the contract broken into items, here
 * is how complete each one is, here is what that means you owe me this month,
 * and here is the slice you are holding back.
 *
 * The first three are this module's job. The fourth — retainage — is handled
 * by `createInvoice`, which gained two optional parameters in Phase 7. That is
 * the whole extent of the change to the core: **one existing service, two
 * optional arguments.** The journal engine, the double-entry rules, period
 * closing, and every financial statement are untouched (spec §20, §23).
 *
 * Issuing an application produces an **ordinary invoice**. It appears in AR
 * aging, accepts ordinary payments, and can be voided like any other. There is
 * no construction invoice type, because a construction company's receivable is
 * a receivable.
 */

export type SovLineInput = {
  itemNumber: string
  description: string
  scheduledValueCents: number
  chartAccountId: string
  costCodeId?: string | null
}

export async function scheduleFor(ctx: ActorContext, projectId: string) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select()
    .from(scheduleOfValues)
    .where(scoped(ctx, scheduleOfValues, eq(scheduleOfValues.projectId, projectId)))
    .orderBy(asc(scheduleOfValues.sortOrder), asc(scheduleOfValues.itemNumber))
}

/**
 * Sets the schedule of values for a job.
 *
 * Items that have already been billed on an issued application cannot be
 * removed or repriced downward below what was billed — an application already
 * sent to a client is a statement about a contract item, and quietly changing
 * the item underneath it would make the sent document wrong.
 */
export async function setScheduleOfValues(
  ctx: ActorContext,
  projectId: string,
  lines: SovLineInput[],
) {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'job_costing')

  const [job] = await db
    .select()
    .from(projects)
    .where(scoped(ctx, projects, eq(projects.id, projectId)))
    .limit(1)

  if (!job) throw new Error('Job not found')

  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.itemNumber)) {
      throw new Error(`Item ${line.itemNumber} appears twice in the schedule of values.`)
    }
    seen.add(line.itemNumber)
    if (line.scheduledValueCents < 0) {
      throw new Error('A scheduled value cannot be negative.')
    }
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(scheduleOfValues)
      .where(
        and(
          eq(scheduleOfValues.companyId, ctx.companyId),
          eq(scheduleOfValues.projectId, projectId),
        ),
      )

    const billed = await billedByItem(ctx, projectId, tx)

    for (const [index, line] of lines.entries()) {
      const previous = existing.find((row) => row.itemNumber === line.itemNumber)
      const alreadyBilled = previous ? (billed.get(previous.id) ?? 0) : 0

      if (line.scheduledValueCents < alreadyBilled) {
        throw new Error(
          `Item ${line.itemNumber} has ${alreadyBilled} already billed, so its value cannot be lowered to ${line.scheduledValueCents}.`,
        )
      }

      if (previous) {
        await tx
          .update(scheduleOfValues)
          .set({
            description: line.description,
            scheduledValueCents: line.scheduledValueCents,
            chartAccountId: line.chartAccountId,
            costCodeId: line.costCodeId ?? null,
            sortOrder: index,
          })
          .where(eq(scheduleOfValues.id, previous.id))
      } else {
        await tx.insert(scheduleOfValues).values({
          companyId: ctx.companyId,
          projectId,
          itemNumber: line.itemNumber,
          description: line.description,
          scheduledValueCents: line.scheduledValueCents,
          chartAccountId: line.chartAccountId,
          costCodeId: line.costCodeId ?? null,
          sortOrder: index,
        })
      }
    }

    for (const row of existing) {
      if (seen.has(row.itemNumber)) continue
      if ((billed.get(row.id) ?? 0) > 0) {
        throw new Error(
          `Item ${row.itemNumber} has already been billed and cannot be removed from the schedule of values.`,
        )
      }
      await tx.delete(scheduleOfValues).where(eq(scheduleOfValues.id, row.id))
    }

    await recordAudit(
      ctx,
      {
        action: 'sov.set',
        entityType: 'project',
        entityId: projectId,
        after: {
          items: lines.length,
          totalCents: lines.reduce((sum, line) => sum + line.scheduledValueCents, 0),
        },
      },
      tx,
    )

    return scheduleFor(ctx, projectId)
  })
}

export type ApplicationLineInput = {
  scheduleOfValuesId: string
  /**
   * Percent complete for this item, in basis points. The billed amount is
   * derived from it, so the person filing the application answers the question
   * they actually know the answer to.
   */
  percentCompleteBp?: number
  /** Or, when they would rather state the amount, this instead. */
  thisPeriodCents?: number
}

export type DraftApplication = {
  projectId: string
  applicationNumber: number
  retainagePercentBp: number
  thisPeriodCents: number
  retainedCents: number
  netDueCents: number
  lines: Array<{
    scheduleOfValuesId: string
    itemNumber: string
    description: string
    scheduledValueCents: number
    previousCompletedCents: number
    thisPeriodCents: number
    completedToDateCents: number
    percentCompleteBp: number
  }>
}

/**
 * Prices an application without saving anything.
 *
 * Separated from `createProgressBilling` so the UI can show the person what
 * they are about to bill, and so the arithmetic — the part worth testing — is
 * reachable without writing to the database.
 */
export async function priceApplication(
  ctx: ActorContext,
  input: {
    projectId: string
    retainagePercentBp: number
    lines: ApplicationLineInput[]
  },
): Promise<DraftApplication> {
  requirePermission(ctx, 'jobs:view')

  if (input.retainagePercentBp < 0 || input.retainagePercentBp > 10_000) {
    throw new Error('Retainage must be between 0% and 100%.')
  }

  const items = await scheduleFor(ctx, input.projectId)
  const itemById = new Map(items.map((item) => [item.id, item]))
  const billed = await billedByItem(ctx, input.projectId)

  const applicationNumber = (await lastApplicationNumber(ctx, input.projectId)) + 1

  const lines = input.lines.map((line) => {
    const item = itemById.get(line.scheduleOfValuesId)
    if (!item) throw new Error('That contract item is not on this job.')

    const previousCompletedCents = billed.get(item.id) ?? 0

    let completedToDateCents: number
    if (line.percentCompleteBp !== undefined) {
      if (line.percentCompleteBp < 0 || line.percentCompleteBp > 10_000) {
        throw new Error(`Item ${item.itemNumber}: percent complete must be between 0% and 100%.`)
      }
      completedToDateCents = Math.round(
        (item.scheduledValueCents * line.percentCompleteBp) / 10_000,
      )
    } else {
      completedToDateCents = previousCompletedCents + (line.thisPeriodCents ?? 0)
    }

    const thisPeriodCents = completedToDateCents - previousCompletedCents

    if (thisPeriodCents < 0) {
      throw new Error(
        `Item ${item.itemNumber} would bill a negative amount. Completion cannot go backwards on an application; raise a credit instead.`,
      )
    }
    if (completedToDateCents > item.scheduledValueCents) {
      throw new Error(
        `Item ${item.itemNumber} would be billed beyond its scheduled value. Approve a change order first.`,
      )
    }

    return {
      scheduleOfValuesId: item.id,
      itemNumber: item.itemNumber,
      description: item.description,
      scheduledValueCents: item.scheduledValueCents,
      previousCompletedCents,
      thisPeriodCents,
      completedToDateCents,
      percentCompleteBp:
        item.scheduledValueCents > 0
          ? Math.round((completedToDateCents / item.scheduledValueCents) * 10_000)
          : 0,
    }
  })

  const thisPeriodCents = lines.reduce((sum, line) => sum + line.thisPeriodCents, 0)
  // Rounded once on the total, not per line: rounding each line and adding
  // them up can miss the total by a cent per line, and the customer's copy has
  // to foot.
  const retainedCents = Math.round((thisPeriodCents * input.retainagePercentBp) / 10_000)

  return {
    projectId: input.projectId,
    applicationNumber,
    retainagePercentBp: input.retainagePercentBp,
    thisPeriodCents,
    retainedCents,
    netDueCents: thisPeriodCents - retainedCents,
    lines,
  }
}

/**
 * Files an application and issues it as an invoice.
 *
 * The two halves commit together: the application row and the invoice are
 * written in one database transaction, so there is no state where a client has
 * an invoice for an application that was never recorded.
 */
export async function createProgressBilling(
  ctx: ActorContext,
  input: {
    projectId: string
    customerId: string
    periodEnd: string
    billingDate: string
    retainagePercentBp: number
    lines: ApplicationLineInput[]
    memo?: string
  },
) {
  requirePermission(ctx, 'jobs:manage')
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'job_costing')

  const draft = await priceApplication(ctx, {
    projectId: input.projectId,
    retainagePercentBp: input.retainagePercentBp,
    lines: input.lines,
  })

  if (draft.thisPeriodCents <= 0) {
    throw new Error('This application bills nothing. Enter progress on at least one item.')
  }

  const items = await scheduleFor(ctx, input.projectId)
  const accountByItem = new Map(items.map((item) => [item.id, item]))

  return db.transaction(async (tx) => {
    const [billing] = await tx
      .insert(progressBillings)
      .values({
        companyId: ctx.companyId,
        projectId: input.projectId,
        applicationNumber: draft.applicationNumber,
        periodEnd: input.periodEnd,
        billingDate: input.billingDate,
        status: 'invoiced',
        retainagePercentBp: input.retainagePercentBp,
        thisPeriodCents: draft.thisPeriodCents,
        retainedCents: draft.retainedCents,
        netDueCents: draft.netDueCents,
        memo: input.memo ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(progressBillingLines).values(
      draft.lines.map((line, index) => ({
        companyId: ctx.companyId,
        progressBillingId: billing.id,
        scheduleOfValuesId: line.scheduleOfValuesId,
        scheduledValueCents: line.scheduledValueCents,
        previousCompletedCents: line.previousCompletedCents,
        thisPeriodCents: line.thisPeriodCents,
        completedToDateCents: line.completedToDateCents,
        percentCompleteBp: line.percentCompleteBp,
        sortOrder: index,
      })),
    )

    // The invoice goes through the ordinary receivables service, under the
    // same actor and inside this same transaction. Everything an invoice
    // normally does — numbering, the AR posting, aging, payment application —
    // happens exactly as it does for any other customer invoice, because it is
    // one.
    const invoice = await createInvoice(
      ctx,
      {
        customerId: input.customerId,
        issueDate: input.billingDate,
        projectId: input.projectId,
        retainageCents: draft.retainedCents,
        memo: input.memo ?? `Application for payment ${draft.applicationNumber}`,
        lines: draft.lines
          .filter((line) => line.thisPeriodCents !== 0)
          .map((line) => {
            const item = accountByItem.get(line.scheduleOfValuesId)
            if (!item) throw new Error('Contract item disappeared while billing.')
            return {
              chartAccountId: item.chartAccountId,
              description: `${line.itemNumber} — ${line.description}`,
              unitPriceCents: line.thisPeriodCents,
              costCodeId: item.costCodeId,
            }
          }),
      },
      tx,
    )

    await tx
      .update(progressBillings)
      .set({ invoiceId: invoice.id, updatedAt: new Date() })
      .where(eq(progressBillings.id, billing.id))

    await recordAudit(
      ctx,
      {
        action: 'progress_billing.issue',
        entityType: 'progress_billing',
        entityId: billing.id,
        after: {
          applicationNumber: draft.applicationNumber,
          thisPeriodCents: draft.thisPeriodCents,
          retainedCents: draft.retainedCents,
          invoiceNumber: invoice.number,
          netDueCents: invoice.balanceCents,
        },
      },
      tx,
    )

    return { billing: { ...billing, invoiceId: invoice.id }, invoice }
  })
}

/**
 * Bills the retainage held on a job.
 *
 * Needs no new machinery at all: it is an ordinary invoice whose one line
 * credits Retainage Receivable instead of a revenue account. Dr AR, Cr
 * Retainage Receivable — the money moves from held to owed, and revenue is not
 * touched, because it was recognized when the work was billed.
 *
 * That this falls out of the existing invoice service without a special case
 * is the clearest evidence the retainage design is in the right place.
 */
export async function releaseRetainage(
  ctx: ActorContext,
  input: {
    projectId: string
    customerId: string
    billingDate: string
    /** Defaults to everything still held on the job. */
    amountCents?: number
    memo?: string
  },
) {
  requirePermission(ctx, 'jobs:manage')
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'job_costing')

  const held = await retainageHeld(ctx, input.projectId)
  if (held <= 0) {
    throw new Error('There is no retainage held on this job.')
  }

  const amountCents = input.amountCents ?? held
  if (amountCents <= 0) {
    throw new Error('A retainage release must be greater than zero.')
  }
  if (amountCents > held) {
    throw new Error(`Only ${held} is held in retainage on this job.`)
  }

  const retainageAccount = await accountByNumber(
    ctx.companyId,
    INDUSTRY_ACCOUNTS.retainageReceivable,
  )
  if (!retainageAccount) {
    throw new Error('This chart of accounts has no Retainage Receivable account (1170).')
  }

  const applicationNumber = (await lastApplicationNumber(ctx, input.projectId)) + 1

  const invoice = await createInvoice(ctx, {
    customerId: input.customerId,
    issueDate: input.billingDate,
    projectId: input.projectId,
    memo: input.memo ?? 'Release of retainage',
    lines: [
      {
        chartAccountId: retainageAccount.id,
        description: 'Release of retainage',
        unitPriceCents: amountCents,
      },
    ],
  })

  return db.transaction(async (tx) => {
    const [billing] = await tx
      .insert(progressBillings)
      .values({
        companyId: ctx.companyId,
        projectId: input.projectId,
        applicationNumber,
        periodEnd: input.billingDate,
        billingDate: input.billingDate,
        status: 'invoiced',
        retainagePercentBp: 0,
        thisPeriodCents: amountCents,
        retainedCents: 0,
        netDueCents: amountCents,
        isRetainageRelease: true,
        invoiceId: invoice.id,
        memo: input.memo ?? 'Release of retainage',
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'progress_billing.issue',
        entityType: 'progress_billing',
        entityId: billing.id,
        after: {
          retainageRelease: true,
          amountCents,
          invoiceNumber: invoice.number,
        },
      },
      tx,
    )

    return { billing, invoice }
  })
}

export async function listProgressBillings(ctx: ActorContext, projectId: string) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select({
      id: progressBillings.id,
      applicationNumber: progressBillings.applicationNumber,
      periodEnd: progressBillings.periodEnd,
      billingDate: progressBillings.billingDate,
      status: progressBillings.status,
      retainagePercentBp: progressBillings.retainagePercentBp,
      thisPeriodCents: progressBillings.thisPeriodCents,
      retainedCents: progressBillings.retainedCents,
      netDueCents: progressBillings.netDueCents,
      isRetainageRelease: progressBillings.isRetainageRelease,
      invoiceId: progressBillings.invoiceId,
      invoiceNumber: invoices.number,
      invoiceBalanceCents: invoices.balanceCents,
    })
    .from(progressBillings)
    .leftJoin(invoices, eq(invoices.id, progressBillings.invoiceId))
    .where(scoped(ctx, progressBillings, eq(progressBillings.projectId, projectId)))
    .orderBy(asc(progressBillings.applicationNumber))
}

export async function progressBillingWithLines(ctx: ActorContext, billingId: string) {
  requirePermission(ctx, 'jobs:view')

  const [billing] = await db
    .select()
    .from(progressBillings)
    .where(scoped(ctx, progressBillings, eq(progressBillings.id, billingId)))
    .limit(1)

  if (!billing) return null

  const lines = await db
    .select({
      id: progressBillingLines.id,
      itemNumber: scheduleOfValues.itemNumber,
      description: scheduleOfValues.description,
      scheduledValueCents: progressBillingLines.scheduledValueCents,
      previousCompletedCents: progressBillingLines.previousCompletedCents,
      thisPeriodCents: progressBillingLines.thisPeriodCents,
      completedToDateCents: progressBillingLines.completedToDateCents,
      percentCompleteBp: progressBillingLines.percentCompleteBp,
    })
    .from(progressBillingLines)
    .innerJoin(
      scheduleOfValues,
      eq(scheduleOfValues.id, progressBillingLines.scheduleOfValuesId),
    )
    .where(eq(progressBillingLines.progressBillingId, billingId))
    .orderBy(asc(progressBillingLines.sortOrder))

  return { billing, lines }
}

/**
 * Retainage still held on a job.
 *
 * Read from the applications rather than the Retainage Receivable balance,
 * because that account is company-wide and this question is per job. The two
 * agree by construction: every cent in the account came from an application
 * counted here.
 */
export async function retainageHeld(ctx: ActorContext, projectId: string): Promise<number> {
  const [row] = await db
    .select({
      retained: sql<string>`coalesce(sum(${progressBillings.retainedCents}), 0)`,
      released: sql<string>`coalesce(sum(CASE WHEN ${progressBillings.isRetainageRelease} THEN ${progressBillings.thisPeriodCents} ELSE 0 END), 0)`,
    })
    .from(progressBillings)
    .where(
      scoped(
        ctx,
        progressBillings,
        eq(progressBillings.projectId, projectId),
        eq(progressBillings.status, 'invoiced'),
      ),
    )

  return Number(row?.retained ?? 0) - Number(row?.released ?? 0)
}

/** Completed-to-date per contract item, from the applications already issued. */
export async function billedByItem(
  ctx: ActorContext,
  projectId: string,
  exec: Executor = db,
): Promise<Map<string, number>> {
  const rows = await exec
    .select({
      scheduleOfValuesId: progressBillingLines.scheduleOfValuesId,
      billed: sql<string>`coalesce(sum(${progressBillingLines.thisPeriodCents}), 0)`,
    })
    .from(progressBillingLines)
    .innerJoin(
      progressBillings,
      eq(progressBillings.id, progressBillingLines.progressBillingId),
    )
    .where(
      and(
        eq(progressBillings.companyId, ctx.companyId),
        eq(progressBillings.projectId, projectId),
        eq(progressBillings.status, 'invoiced'),
      ),
    )
    .groupBy(progressBillingLines.scheduleOfValuesId)

  return new Map(rows.map((row) => [row.scheduleOfValuesId, Number(row.billed)]))
}

async function lastApplicationNumber(
  ctx: ActorContext,
  projectId: string,
): Promise<number> {
  const [row] = await db
    .select({ number: progressBillings.applicationNumber })
    .from(progressBillings)
    .where(scoped(ctx, progressBillings, eq(progressBillings.projectId, projectId)))
    .orderBy(desc(progressBillings.applicationNumber))
    .limit(1)

  return row?.number ?? 0
}

/** Customers, for the application form. */
export async function billableCustomers(ctx: ActorContext) {
  requirePermission(ctx, 'jobs:view')
  return db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(scoped(ctx, customers))
    .orderBy(asc(customers.name))
}
