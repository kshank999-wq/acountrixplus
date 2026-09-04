import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billableExpenses,
  memberships,
  personRates,
  projectRates,
  projects,
  serviceItems,
  timeEntries,
  users,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { Refusal } from '@/modules/errors'
import {
  amountForMinutes,
  billableAmountCents,
  resolveRate,
  utilization,
  type ResolvedRate,
  type UtilizationRow,
} from './rates'

/**
 * Timesheets, approval, and reimbursable expenses (spec §5).
 *
 * ## Recording time posts nothing
 *
 * Deliberately, and it is the same decision as ADR 0014's "a purchase order
 * posts nothing". Unbilled time is not revenue — nobody has agreed to pay it —
 * and for most small firms it is not an asset either. Booking profit on your
 * own labour before anybody has been billed is the accounting that flatters a
 * business right up to the point it runs out of cash.
 *
 * The professional-services pack declares `1150 Unbilled Work in Progress` for
 * firms whose policy is to accrue it. Nothing posts there, and `unbilledWork`
 * reads the timesheet directly instead.
 *
 * ## Approval is a gate, not a formality
 *
 * Only `approved` time can be billed. The point is not ceremony: it is that
 * somebody other than the person who typed it has looked at what the client is
 * about to be charged for. A firm that bills straight from a timesheet
 * discovers its description problems in a client's reply.
 */

export type LogTimeInput = {
  userId?: string
  projectId?: string | null
  serviceItemId?: string | null
  workedOn: string
  minutes: number
  description: string
  isBillable?: boolean
  /** Overrides every other rate. Zero is a real answer; omit for the usual one. */
  rateCents?: number | null
}

export async function logTime(ctx: ActorContext, input: LogTimeInput) {
  requirePermission(ctx, 'accounting:view')
  await requireModule(ctx, 'time_billing')

  // Logging time for somebody else is a supervisor's action, not a colleague's.
  const userId = input.userId ?? ctx.userId
  if (userId !== ctx.userId) requirePermission(ctx, 'users:manage')

  const description = input.description.trim()
  if (!description) {
    throw new Refusal(
      'Say what the time was for. A line reading only "work" is what a client queries.',
    )
  }
  if (input.minutes <= 0) throw new Refusal('Log more than zero minutes.')
  if (input.minutes > 1440) throw new Refusal('That is more than a day. Check the units.')

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(timeEntries)
      .values({
        companyId: ctx.companyId,
        userId,
        projectId: input.projectId ?? null,
        serviceItemId: input.serviceItemId ?? null,
        workedOn: input.workedOn,
        minutes: input.minutes,
        description,
        isBillable: input.isBillable ?? true,
        rateCents: input.rateCents ?? null,
        status: 'draft',
      })
      .returning()

    // No journal entry. See the header.
    await recordAudit(
      ctx,
      {
        action: 'time.log',
        entityType: 'time_entry',
        entityId: entry.id,
        after: { minutes: entry.minutes, workedOn: entry.workedOn, billable: entry.isBillable },
      },
      tx,
    )

    return entry
  })
}

export async function updateTime(
  ctx: ActorContext,
  entryId: string,
  input: Partial<Omit<LogTimeInput, 'userId'>>,
) {
  requirePermission(ctx, 'accounting:view')

  return db.transaction(async (tx) => {
    const entry = await loadOwnEditable(ctx, entryId, tx)

    const [updated] = await tx
      .update(timeEntries)
      .set({
        projectId: input.projectId === undefined ? entry.projectId : input.projectId,
        serviceItemId:
          input.serviceItemId === undefined ? entry.serviceItemId : input.serviceItemId,
        workedOn: input.workedOn ?? entry.workedOn,
        minutes: input.minutes ?? entry.minutes,
        description: input.description?.trim() ?? entry.description,
        isBillable: input.isBillable ?? entry.isBillable,
        rateCents: input.rateCents === undefined ? entry.rateCents : input.rateCents,
        updatedAt: new Date(),
      })
      .where(eq(timeEntries.id, entryId))
      .returning()

    return updated
  })
}

export async function deleteTime(ctx: ActorContext, entryId: string): Promise<void> {
  requirePermission(ctx, 'accounting:view')

  await db.transaction(async (tx) => {
    await loadOwnEditable(ctx, entryId, tx)
    await tx.delete(timeEntries).where(eq(timeEntries.id, entryId))
  })
}

/**
 * Loads an entry the actor may still change.
 *
 * Billed time is immutable: an invoice has gone to a client, and editing the
 * hours behind it would make the timesheet and the document disagree about
 * what was charged for. Correcting it is a credit note plus a new entry, which
 * is what the accounting already knows how to do.
 */
async function loadOwnEditable(ctx: ActorContext, entryId: string, tx: Executor) {
  const [entry] = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.companyId, ctx.companyId), eq(timeEntries.id, entryId)))
    .limit(1)

  if (!entry) throw new Error('Time entry not found')

  if (entry.status === 'billed') {
    throw new Refusal(
      'That time has been invoiced. Raise a credit note and log a corrected entry rather than ' +
        'changing what the client was shown.',
    )
  }

  // Somebody else's timesheet needs the permission that manages people.
  if (entry.userId !== ctx.userId) requirePermission(ctx, 'users:manage')

  return entry
}

/** Moves draft entries to `submitted`, ready for somebody to approve. */
export async function submitTime(ctx: ActorContext, entryIds: string[]): Promise<number> {
  requirePermission(ctx, 'accounting:view')
  if (entryIds.length === 0) return 0

  const updated = await db
    .update(timeEntries)
    .set({ status: 'submitted', updatedAt: new Date() })
    .where(
      and(
        eq(timeEntries.companyId, ctx.companyId),
        eq(timeEntries.userId, ctx.userId),
        eq(timeEntries.status, 'draft'),
        inArray(timeEntries.id, entryIds),
      ),
    )
    .returning({ id: timeEntries.id })

  return updated.length
}

/**
 * Approves time for billing.
 *
 * The status filter is in the `WHERE`, not checked beforehand: approving is
 * the gate in front of money leaving the building as an invoice, and a
 * read-then-write would let two approvals race.
 */
export async function approveTime(ctx: ActorContext, entryIds: string[]): Promise<number> {
  requirePermission(ctx, 'accounting:journal')
  if (entryIds.length === 0) return 0

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(timeEntries)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(timeEntries.companyId, ctx.companyId),
          sql`${timeEntries.status} IN ('draft', 'submitted')`,
          inArray(timeEntries.id, entryIds),
        ),
      )
      .returning({ id: timeEntries.id, minutes: timeEntries.minutes })

    if (updated.length > 0) {
      await recordAudit(
        ctx,
        {
          action: 'time.approve',
          entityType: 'time_entry',
          after: {
            entries: updated.length,
            minutes: updated.reduce((sum, row) => sum + row.minutes, 0),
          },
        },
        tx,
      )
    }

    return updated.length
  })
}

/**
 * Decides not to charge for time that was worked.
 *
 * Kept rather than deleted, with a reason. An hour written off is a fact about
 * an engagement's profitability, and deleting it makes every job look better
 * than it was — which is how a firm keeps taking work that loses money.
 */
export async function writeOffTime(
  ctx: ActorContext,
  entryIds: string[],
  reason: string,
): Promise<number> {
  requirePermission(ctx, 'accounting:journal')

  const trimmed = reason.trim()
  if (!trimmed) {
    throw new Refusal('Say why it is not being charged for. "Over-run" and "goodwill" are different.')
  }
  if (entryIds.length === 0) return 0

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(timeEntries)
      .set({ status: 'written_off', writeOffReason: trimmed, updatedAt: new Date() })
      .where(
        and(
          eq(timeEntries.companyId, ctx.companyId),
          sql`${timeEntries.status} <> 'billed'`,
          inArray(timeEntries.id, entryIds),
        ),
      )
      .returning({ id: timeEntries.id })

    if (updated.length > 0) {
      await recordAudit(
        ctx,
        {
          action: 'time.write_off',
          entityType: 'time_entry',
          after: { entries: updated.length, reason: trimmed },
        },
        tx,
      )
    }

    return updated.length
  })
}

// --- Rates -----------------------------------------------------------------

export async function setPersonRate(
  ctx: ActorContext,
  input: { userId: string; rateCents: number; costRateCents?: number | null },
) {
  requirePermission(ctx, 'users:manage')

  const [existing] = await db
    .select()
    .from(personRates)
    .where(and(eq(personRates.companyId, ctx.companyId), eq(personRates.userId, input.userId)))
    .limit(1)

  if (existing) {
    await db
      .update(personRates)
      .set({ rateCents: input.rateCents, costRateCents: input.costRateCents ?? null })
      .where(eq(personRates.id, existing.id))
    return
  }

  await db.insert(personRates).values({
    companyId: ctx.companyId,
    userId: input.userId,
    rateCents: input.rateCents,
    costRateCents: input.costRateCents ?? null,
  })
}

export async function setProjectRate(
  ctx: ActorContext,
  input: { projectId: string; userId?: string | null; rateCents: number },
) {
  requirePermission(ctx, 'accounting:journal')

  const [existing] = await db
    .select()
    .from(projectRates)
    .where(
      and(
        eq(projectRates.companyId, ctx.companyId),
        eq(projectRates.projectId, input.projectId),
        input.userId ? eq(projectRates.userId, input.userId) : isNull(projectRates.userId),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(projectRates)
      .set({ rateCents: input.rateCents })
      .where(eq(projectRates.id, existing.id))
    return
  }

  await db.insert(projectRates).values({
    companyId: ctx.companyId,
    projectId: input.projectId,
    userId: input.userId ?? null,
    rateCents: input.rateCents,
  })
}

/**
 * The rate for one entry, and where it came from.
 *
 * Exported because the timesheet shows it as you type: somebody logging an
 * hour should be able to see it is about to be billed at $150 before an
 * invoice tells them.
 */
export async function rateForEntry(
  ctx: ActorContext,
  entry: {
    userId: string
    projectId?: string | null
    serviceItemId?: string | null
    rateCents?: number | null
  },
  exec: Executor = db,
): Promise<ResolvedRate> {
  const [projectRateRows, personRateRow, itemRow] = await Promise.all([
    entry.projectId
      ? exec
          .select()
          .from(projectRates)
          .where(
            and(
              eq(projectRates.companyId, ctx.companyId),
              eq(projectRates.projectId, entry.projectId),
            ),
          )
      : Promise.resolve([]),

    exec
      .select()
      .from(personRates)
      .where(and(eq(personRates.companyId, ctx.companyId), eq(personRates.userId, entry.userId)))
      .limit(1),

    entry.serviceItemId
      ? exec
          .select({ unitPriceCents: serviceItems.unitPriceCents })
          .from(serviceItems)
          .where(
            and(
              eq(serviceItems.companyId, ctx.companyId),
              eq(serviceItems.id, entry.serviceItemId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ])

  return resolveRate({
    entryRateCents: entry.rateCents,
    projectPersonRateCents:
      projectRateRows.find((row) => row.userId === entry.userId)?.rateCents ?? null,
    projectRateCents: projectRateRows.find((row) => row.userId === null)?.rateCents ?? null,
    personRateCents: personRateRow[0]?.rateCents ?? null,
    itemRateCents: itemRow[0]?.unitPriceCents ?? null,
  })
}

// --- Reimbursable expenses -------------------------------------------------

export async function recordBillableExpense(
  ctx: ActorContext,
  input: {
    projectId?: string | null
    customerId?: string | null
    incurredOn: string
    description: string
    costCents: number
    markupBasisPoints?: number
    chartAccountId?: string | null
    sourceType?: string
    sourceId?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'time_billing')

  if (input.costCents <= 0) throw new Refusal('An expense has to have cost something.')

  const markupBasisPoints = input.markupBasisPoints ?? 0

  return db.transaction(async (tx) => {
    const [expense] = await tx
      .insert(billableExpenses)
      .values({
        companyId: ctx.companyId,
        projectId: input.projectId ?? null,
        customerId: input.customerId ?? null,
        incurredOn: input.incurredOn,
        description: input.description.trim(),
        costCents: input.costCents,
        markupBasisPoints,
        billableCents: billableAmountCents(input.costCents, markupBasisPoints),
        chartAccountId: input.chartAccountId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    // No journal entry. The cost is already in the books — it arrived as a
    // bank transaction or a bill and was categorized like any other. Posting
    // it again here would double the expense.
    await recordAudit(
      ctx,
      {
        action: 'expense.mark_billable',
        entityType: 'billable_expense',
        entityId: expense.id,
        after: { costCents: expense.costCents, billableCents: expense.billableCents },
      },
      tx,
    )

    return expense
  })
}

// --- Reading ---------------------------------------------------------------

export type TimesheetRow = {
  id: string
  workedOn: string
  minutes: number
  description: string
  isBillable: boolean
  status: string
  projectId: string | null
  projectName: string | null
  personName: string
  userId: string
  rateCents: number | null
  amountCents: number | null
}

export async function timesheet(
  ctx: ActorContext,
  opts: { userId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<TimesheetRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: timeEntries.id,
      workedOn: timeEntries.workedOn,
      minutes: timeEntries.minutes,
      description: timeEntries.description,
      isBillable: timeEntries.isBillable,
      status: timeEntries.status,
      projectId: timeEntries.projectId,
      projectName: projects.name,
      personName: users.name,
      userId: timeEntries.userId,
      rateCents: timeEntries.rateCents,
      amountCents: timeEntries.amountCents,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(
      scoped(
        ctx,
        timeEntries,
        opts.userId ? eq(timeEntries.userId, opts.userId) : undefined,
        opts.from ? gte(timeEntries.workedOn, opts.from) : undefined,
        opts.to ? lte(timeEntries.workedOn, opts.to) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.workedOn), asc(users.name))
    .limit(opts.limit ?? 200)

  return rows
}

export type UnbilledWork = {
  projectId: string | null
  projectName: string
  customerId: string | null
  timeMinutes: number
  timeValueCents: number
  expenseCount: number
  expenseValueCents: number
  totalCents: number
  oldestDate: string | null
}

/**
 * What has been approved and not yet invoiced.
 *
 * The report a partner reads on a Friday, and the reason the phase exists: the
 * expensive failure in a professional-services firm is not double-billing, it
 * is work that was done, recorded, and never charged for — because nobody
 * noticed it sitting there.
 *
 * `oldestDate` is the number that makes it act on: two hours from last week is
 * a rounding error, and two hours from March means something is wrong with how
 * this engagement gets billed.
 */
export async function unbilledWork(ctx: ActorContext): Promise<UnbilledWork[]> {
  requirePermission(ctx, 'accounting:view')

  const [timeRows, expenseRows] = await Promise.all([
    db
      .select({
        projectId: timeEntries.projectId,
        projectName: projects.name,
        userId: timeEntries.userId,
        minutes: timeEntries.minutes,
        workedOn: timeEntries.workedOn,
        serviceItemId: timeEntries.serviceItemId,
        rateCents: timeEntries.rateCents,
      })
      .from(timeEntries)
      .leftJoin(projects, eq(projects.id, timeEntries.projectId))
      .where(
        scoped(
          ctx,
          timeEntries,
          eq(timeEntries.status, 'approved'),
          eq(timeEntries.isBillable, true),
          isNull(timeEntries.invoiceId),
        ),
      ),

    db
      .select({
        projectId: billableExpenses.projectId,
        projectName: projects.name,
        customerId: billableExpenses.customerId,
        billableCents: billableExpenses.billableCents,
        incurredOn: billableExpenses.incurredOn,
      })
      .from(billableExpenses)
      .leftJoin(projects, eq(projects.id, billableExpenses.projectId))
      .where(
        scoped(
          ctx,
          billableExpenses,
          eq(billableExpenses.status, 'unbilled'),
          isNull(billableExpenses.invoiceId),
        ),
      ),
  ])

  const byProject = new Map<string, UnbilledWork>()

  const bucket = (projectId: string | null, projectName: string | null): UnbilledWork => {
    const key = projectId ?? 'none'
    let entry = byProject.get(key)
    if (!entry) {
      entry = {
        projectId,
        projectName: projectName ?? 'No engagement',
        customerId: null,
        timeMinutes: 0,
        timeValueCents: 0,
        expenseCount: 0,
        expenseValueCents: 0,
        totalCents: 0,
        oldestDate: null,
      }
      byProject.set(key, entry)
    }
    return entry
  }

  // Rates are resolved per row rather than in SQL, because the fallback order
  // is the pure function in `rates.ts` and having two implementations of it is
  // how a preview and an invoice come to disagree.
  for (const row of timeRows) {
    const entry = bucket(row.projectId, row.projectName)
    const rate = await rateForEntry(ctx, {
      userId: row.userId,
      projectId: row.projectId,
      serviceItemId: row.serviceItemId,
      rateCents: row.rateCents,
    })

    entry.timeMinutes += row.minutes
    entry.timeValueCents += amountForMinutes(row.minutes, rate.rateCents)
    entry.oldestDate =
      entry.oldestDate === null || row.workedOn < entry.oldestDate ? row.workedOn : entry.oldestDate
  }

  for (const row of expenseRows) {
    const entry = bucket(row.projectId, row.projectName)
    entry.customerId = entry.customerId ?? row.customerId
    entry.expenseCount += 1
    entry.expenseValueCents += row.billableCents
    entry.oldestDate =
      entry.oldestDate === null || row.incurredOn < entry.oldestDate
        ? row.incurredOn
        : entry.oldestDate
  }

  for (const entry of byProject.values()) {
    entry.totalCents = entry.timeValueCents + entry.expenseValueCents
  }

  return [...byProject.values()].sort((a, b) => b.totalCents - a.totalCents)
}

/** Billable hours against total, per person, over a window. */
export async function utilizationReport(
  ctx: ActorContext,
  range: { from: string; to: string },
): Promise<UtilizationRow[]> {
  requirePermission(ctx, 'reports:view')

  const rows = await db
    .select({
      personId: timeEntries.userId,
      personName: users.name,
      minutes: timeEntries.minutes,
      isBillable: timeEntries.isBillable,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(
      scoped(
        ctx,
        timeEntries,
        gte(timeEntries.workedOn, range.from),
        lte(timeEntries.workedOn, range.to),
        // Written-off time was still worked, so it belongs in the denominator.
        // Excluding it would let a firm improve its utilization by giving work
        // away.
        sql`${timeEntries.status} <> 'draft'`,
      ),
    )

  return utilization(rows)
}

/** People who can have time logged against them. */
export async function billablePeople(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      userId: users.id,
      name: users.name,
      rateCents: personRates.rateCents,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      personRates,
      and(eq(personRates.userId, users.id), eq(personRates.companyId, ctx.companyId)),
    )
    .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.isActive, true)))
    .orderBy(asc(users.name))
}

/** Unbilled expenses, for the billing screen. */
export async function unbilledExpenses(ctx: ActorContext, opts: { projectId?: string } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(billableExpenses)
    .where(
      scoped(
        ctx,
        billableExpenses,
        eq(billableExpenses.status, 'unbilled'),
        opts.projectId ? eq(billableExpenses.projectId, opts.projectId) : undefined,
      ),
    )
    .orderBy(asc(billableExpenses.incurredOn))
}
