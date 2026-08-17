import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  accountingPeriods,
  chartAccounts,
  companies,
  costCodes,
  journalEntries,
  journalLines,
  projects,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  assignLineDimensions,
  type DimensionAssignment,
} from '@/modules/dimensions/service'

/**
 * The double-entry journal (spec §13).
 *
 * Two rules hold everywhere in this module:
 *
 *  1. An entry's debits must equal its credits. Enforced on every write and
 *     covered by tests, because the invariant spans rows and the database
 *     cannot express it.
 *  2. Posted entries are never edited or deleted. Corrections are made by
 *     voiding and re-posting, or by a reversing entry, so history survives
 *     (spec §16, §19).
 */

export type JournalSource =
  | 'manual'
  | 'bank_transaction'
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'adjusting'
  | 'closing'
  // Phase 9. Named rather than folded into `manual` so a payroll entry can be
  // found without knowing its memo — an auditor asking "show me every payroll
  // posting" should not have to search text.
  | 'payroll'
  | 'remittance'
  // Phase 26. Fund accounting: money given for a purpose, and the moment that
  // purpose is satisfied.
  | 'contribution'
  | 'release'
  // Phase 28. A whole trading day, summarised into one entry.
  | 'takings'
  | 'appointment'

export type JournalLineInput = {
  chartAccountId: string
  /** Minor units, never negative. Provide exactly one of the two. */
  debitCents?: number
  creditCents?: number
  memo?: string | null
  /**
   * Accounting dimensions (spec §13, and job costing in spec §5).
   *
   * They ride on the line rather than the entry because one entry routinely
   * spans jobs — a single supplier bill covering three sites is one document
   * and three cost postings.
   */
  projectId?: string | null
  costCodeId?: string | null
  /**
   * User-defined dimensions (Phase 16): `{ [dimensionId]: dimensionValueId }`.
   *
   * A map rather than a list of pairs, because one value per dimension per
   * line is the constraint the whole dimensional model rests on, and a map
   * cannot express a violation of it. See `modules/dimensions/service.ts`.
   */
  dimensions?: DimensionAssignment
}

export type JournalEntryInput = {
  entryDate: string
  memo?: string | null
  lines: JournalLineInput[]
  source?: JournalSource
  sourceType?: string | null
  sourceId?: string | null
  reversalOfId?: string | null
  /**
   * Defaults to `posted`. `draft` writes a balanced, validated entry that
   * affects no report until a person posts it — the shape a proposed
   * period-end adjustment needs (ADR 0007, ADR 0010).
   */
  status?: 'draft' | 'posted'
}

/** Raised when an entry's debits and credits disagree. */
export class UnbalancedEntryError extends Error {
  readonly status = 422
  constructor(
    readonly debitCents: number,
    readonly creditCents: number,
  ) {
    super(
      `Journal entry is out of balance: debits ${debitCents} vs credits ${creditCents}. ` +
        'Every entry must balance exactly.',
    )
    this.name = 'UnbalancedEntryError'
  }
}

/** Raised when a change would land inside a closed accounting period. */
export class ClosedPeriodError extends Error {
  readonly status = 409
  constructor(readonly entryDate: string) {
    super(
      `${entryDate} falls in a closed accounting period. ` +
        'Reopen the period before changing entries dated inside it.',
    )
    this.name = 'ClosedPeriodError'
  }
}

/**
 * Validates and normalizes lines.
 *
 * Rejects negative amounts and lines that are both a debit and a credit — the
 * database enforces those too, but failing here produces a message a person can
 * act on instead of a constraint violation.
 */
export function normalizeLines(lines: JournalLineInput[]) {
  if (lines.length < 2) {
    throw new Error('A journal entry needs at least two lines.')
  }

  let debitTotal = 0
  let creditTotal = 0

  const normalized = lines.map((line, index) => {
    const debit = line.debitCents ?? 0
    const credit = line.creditCents ?? 0

    if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
      throw new Error('Journal amounts must be whole numbers of cents.')
    }
    if (debit < 0 || credit < 0) {
      throw new Error('Journal amounts cannot be negative. Use the other column instead.')
    }
    if ((debit === 0) === (credit === 0)) {
      throw new Error('Each line must be either a debit or a credit, not both and not neither.')
    }

    if (line.costCodeId && !line.projectId) {
      throw new Error('A cost code needs the job it belongs to. Choose a job as well.')
    }

    debitTotal += debit
    creditTotal += credit

    return {
      chartAccountId: line.chartAccountId,
      debitCents: debit,
      creditCents: credit,
      memo: line.memo ?? null,
      projectId: line.projectId ?? null,
      costCodeId: line.costCodeId ?? null,
      dimensions: line.dimensions ?? {},
      sortOrder: index,
    }
  })

  if (debitTotal !== creditTotal) {
    throw new UnbalancedEntryError(debitTotal, creditTotal)
  }

  return { lines: normalized, totalCents: debitTotal }
}

/**
 * Rejects a date that falls inside a closed period (spec §13, §14).
 *
 * A period that has been reopened no longer blocks: the row is kept for
 * history but its status says the close was lifted.
 */
export async function assertPeriodOpen(
  ctx: ActorContext,
  entryDate: string,
  exec: Executor = db,
): Promise<void> {
  const [closed] = await exec
    .select({ id: accountingPeriods.id })
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.companyId, ctx.companyId),
        eq(accountingPeriods.status, 'closed'),
        lte(accountingPeriods.periodStart, entryDate),
        gte(accountingPeriods.periodEnd, entryDate),
      ),
    )
    .limit(1)

  if (closed) throw new ClosedPeriodError(entryDate)
}

/**
 * Assigns the next entry number for a company.
 *
 * Serializes concurrent posts so two cannot claim the same number — the unique
 * constraint would catch it, but a lock turns a failed write into a brief
 * wait.
 *
 * ## Why an advisory lock and not `SELECT … FOR UPDATE` on the company row
 *
 * It used to be the company row, and that deadlocked. Every table in this
 * schema has a foreign key to `companies`, so *inserting an audit event*, or a
 * transaction, or an idempotency key, takes a `FOR KEY SHARE` lock on the same
 * company row. Two concurrent postings therefore both hold KEY SHARE and then
 * both ask for `FOR UPDATE`, each waiting for the other to let go:
 *
 *   T1: insert audit event  → KEY SHARE on companies
 *   T2: insert audit event  → KEY SHARE on companies
 *   T1: SELECT … FOR UPDATE → waits for T2
 *   T2: SELECT … FOR UPDATE → waits for T1   → deadlock
 *
 * Two people categorizing transactions at the same moment was enough to hit
 * it. An advisory lock is in a namespace of its own, so it cannot interact
 * with the foreign-key locks at all, and `xact` scope releases it on commit
 * or rollback without any unlock call to forget.
 *
 * The first argument is a fixed namespace so this lock cannot collide with any
 * other advisory lock the application takes later; the second is a hash of the
 * company id. A hash collision between two companies costs one of them a short
 * wait and nothing else — the entry-number query below is still scoped by
 * company, so correctness never depended on the lock being exclusive to one.
 */
const JOURNAL_LOCK_NAMESPACE = 724_301

async function nextEntryNumber(companyId: string, exec: Executor): Promise<number> {
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(${JOURNAL_LOCK_NAMESPACE}, hashtext(${companyId}))`,
  )

  const [row] = await exec
    .select({ max: sql<number | null>`max(${journalEntries.entryNumber})` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, companyId))

  return (row?.max ?? 0) + 1
}

/**
 * Creates and posts an entry without checking permissions.
 *
 * Internal: used by the derived-posting paths, where the caller has already
 * been authorized for the action that produced the entry (categorizing a
 * transaction, saving an invoice). Manual entries go through `postManualEntry`.
 */
export async function createJournalEntry(
  ctx: ActorContext,
  input: JournalEntryInput,
  exec: Executor,
): Promise<{ id: string; entryNumber: number; totalCents: number }> {
  const { lines, totalCents } = normalizeLines(input.lines)
  await assertPeriodOpen(ctx, input.entryDate, exec)
  await assertAccountsInCompany(
    ctx,
    lines.map((l) => l.chartAccountId),
    exec,
  )
  await assertDimensionsInCompany(ctx, lines, exec)

  const entryNumber = await nextEntryNumber(ctx.companyId, exec)

  const [entry] = await exec
    .insert(journalEntries)
    .values({
      companyId: ctx.companyId,
      entryNumber,
      entryDate: input.entryDate,
      memo: input.memo ?? null,
      source: input.source ?? 'manual',
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      // A draft is written but not posted: every balance and statement query
      // filters on `status = 'posted'`, so a draft affects no figure until
      // somebody promotes it. That is what lets a background job *propose* an
      // entry without ADR 0007's objection — nothing was decided on anybody's
      // behalf, and the proposal is visible where journal entries live.
      status: input.status ?? 'posted',
      postedAt: input.status === 'draft' ? null : new Date(),
      postedBy: input.status === 'draft' ? null : ctx.userId,
    })
    .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })

  const inserted = await exec
    .insert(journalLines)
    .values(
      lines.map((line) => ({
        companyId: ctx.companyId,
        journalEntryId: entry.id,
        chartAccountId: line.chartAccountId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        memo: line.memo,
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        sortOrder: line.sortOrder,
      })),
    )
    .returning({ id: journalLines.id, sortOrder: journalLines.sortOrder })

  // Dimensions are written inside the same transaction as the lines they
  // belong to. A line that committed without them would show up as
  // Unassigned on a report, which the person who posted it — having assigned
  // a value — would have no way to explain.
  //
  // Matched by `sortOrder` rather than by the order `returning()` happened to
  // give back: Postgres makes no promise about that, and silently attaching
  // the Airport site's costs to the Downtown line is the kind of defect that
  // reconciles perfectly and is still wrong.
  const bySortOrder = new Map(inserted.map((row) => [row.sortOrder, row.id]))
  const withDimensions = lines
    .filter((line) => Object.keys(line.dimensions).length > 0)
    .map((line) => ({
      journalLineId: bySortOrder.get(line.sortOrder) as string,
      assignment: line.dimensions,
    }))

  if (withDimensions.length > 0) {
    await assignLineDimensions(ctx, withDimensions, exec)
  }

  return { id: entry.id, entryNumber: entry.entryNumber, totalCents }
}

/**
 * Posts a manual journal entry (spec §13).
 *
 * Requires `accounting:journal` — a bookkeeper categorizes transactions, an
 * accountant writes journal entries directly.
 */
export async function postManualEntry(ctx: ActorContext, input: JournalEntryInput) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const entry = await createJournalEntry(
      ctx,
      { ...input, source: input.source ?? 'manual' },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'journal.post',
        entityType: 'journal_entry',
        entityId: entry.id,
        after: {
          entryNumber: entry.entryNumber,
          entryDate: input.entryDate,
          totalCents: entry.totalCents,
          memo: input.memo ?? null,
        },
      },
      tx,
    )

    return entry
  })
}

/**
 * Voids an entry.
 *
 * The row and its lines stay in the database with `status = 'void'`; balance
 * queries filter on `status = 'posted'`. Nothing is deleted, so the ledger's
 * history remains complete (spec §16).
 */
export async function voidJournalEntry(
  ctx: ActorContext,
  entryId: string,
  exec: Executor,
): Promise<void> {
  const [entry] = await exec
    .select()
    .from(journalEntries)
    .where(
      and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)),
    )
    .limit(1)

  if (!entry) throw new Error('Journal entry not found')
  if (entry.status === 'void') return

  // Voiding changes the books, so the period rules apply here too.
  await assertPeriodOpen(ctx, entry.entryDate, exec)

  await exec
    .update(journalEntries)
    .set({
      status: 'void',
      voidedAt: new Date(),
      voidedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)),
    )
}

/** Voids an entry as a user-initiated action, with permission and audit. */
export async function voidEntry(ctx: ActorContext, entryId: string) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    await voidJournalEntry(ctx, entryId, tx)

    await recordAudit(
      ctx,
      {
        action: 'journal.void',
        entityType: 'journal_entry',
        entityId: entryId,
        before: { status: 'posted' },
        after: { status: 'void' },
      },
      tx,
    )
  })
}

/**
 * Posts a reversing entry: the same lines with debits and credits swapped.
 *
 * Preferred over voiding when the original fell in a period that has already
 * been reported on — the correction shows up in the current period rather than
 * silently changing a prior one.
 */
export async function reverseEntry(
  ctx: ActorContext,
  entryId: string,
  reversalDate: string,
  memo?: string,
) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(journalEntries)
      .where(scoped(ctx, journalEntries, eq(journalEntries.id, entryId)))
      .limit(1)

    if (!original) throw new Error('Journal entry not found')
    if (original.status !== 'posted') {
      throw new Error('Only a posted entry can be reversed.')
    }

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId))
      .orderBy(journalLines.sortOrder)

    const reversal = await createJournalEntry(
      ctx,
      {
        entryDate: reversalDate,
        memo: memo ?? `Reversal of entry #${original.entryNumber}`,
        source: 'adjusting',
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        reversalOfId: original.id,
        // Swap the sides.
        // Dimensions come across unchanged: a reversal has to land on the same
        // job, or the job's cost would keep the original and lose the undo.
        lines: lines.map((line) => ({
          chartAccountId: line.chartAccountId,
          debitCents: line.creditCents,
          creditCents: line.debitCents,
          memo: line.memo,
          projectId: line.projectId,
          costCodeId: line.costCodeId,
        })),
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'journal.reverse',
        entityType: 'journal_entry',
        entityId: reversal.id,
        after: { reversalOf: original.entryNumber, entryNumber: reversal.entryNumber },
      },
      tx,
    )

    return reversal
  })
}

/**
 * Finds the live (non-void) entry derived from a source document.
 *
 * Derived postings look this up before re-posting, so recategorizing replaces
 * the old entry instead of stacking a second one on top of it.
 */
export async function entryForSource(
  ctx: ActorContext,
  sourceType: string,
  sourceId: string,
  exec: Executor = db,
) {
  const [entry] = await exec
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceType, sourceType),
        eq(journalEntries.sourceId, sourceId),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .limit(1)

  return entry ?? null
}

/** Confirms every account belongs to the acting company (spec §19). */
async function assertAccountsInCompany(
  ctx: ActorContext,
  chartAccountIds: string[],
  exec: Executor,
) {
  const unique = [...new Set(chartAccountIds)]

  const rows = await exec
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(
      and(eq(chartAccounts.companyId, ctx.companyId), inArray(chartAccounts.id, unique)),
    )

  if (rows.length !== unique.length) {
    throw new Error('One or more chart accounts were not found')
  }
}

/**
 * Confirms every dimension on a line belongs to the acting company.
 *
 * Same reasoning as the account check: a uuid arriving from a form is not
 * evidence of anything until it has been looked up under the tenant filter
 * (spec §19).
 */
async function assertDimensionsInCompany(
  ctx: ActorContext,
  lines: Array<{ projectId: string | null; costCodeId: string | null }>,
  exec: Executor,
) {
  const projectIds = [...new Set(lines.map((l) => l.projectId).filter(Boolean))] as string[]
  const costCodeIds = [...new Set(lines.map((l) => l.costCodeId).filter(Boolean))] as string[]

  if (projectIds.length > 0) {
    const rows = await exec
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, ctx.companyId), inArray(projects.id, projectIds)))

    if (rows.length !== projectIds.length) {
      throw new Error('One or more jobs were not found')
    }
  }

  if (costCodeIds.length > 0) {
    const rows = await exec
      .select({ id: costCodes.id })
      .from(costCodes)
      .where(and(eq(costCodes.companyId, ctx.companyId), inArray(costCodes.id, costCodeIds)))

    if (rows.length !== costCodeIds.length) {
      throw new Error('One or more cost codes were not found')
    }
  }
}

/**
 * Writes a balanced entry that affects no report until somebody posts it.
 *
 * The point of a draft is who decides. ADR 0007 refused to have the WIP
 * adjusting entry posted automatically — *"automating a period-end adjustment
 * nobody reviewed is how a WIP schedule becomes a source of surprises"* — and
 * that objection is about the deciding, not about the arithmetic. A machine is
 * perfectly capable of working out the entry; what it must not do is put it in
 * the books unasked.
 *
 * So a draft is fully validated: balanced, accounts checked, dimensions
 * checked, period checked, entry number allocated. Everything a posted entry
 * gets except the posting.
 */
export async function draftJournalEntry(ctx: ActorContext, input: JournalEntryInput) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const entry = await createJournalEntry(ctx, { ...input, status: 'draft' }, tx)

    await recordAudit(
      ctx,
      {
        action: 'journal.draft',
        entityType: 'journal_entry',
        entityId: entry.id,
        after: {
          entryNumber: entry.entryNumber,
          entryDate: input.entryDate,
          totalCents: entry.totalCents,
          memo: input.memo ?? null,
          source: input.source ?? 'manual',
        },
      },
      tx,
    )

    return entry
  })
}

/**
 * Promotes a draft to posted.
 *
 * The period is re-checked at this moment rather than trusted from when the
 * draft was written — a draft proposed in an open period and posted after that
 * period closed would otherwise slip past the lock.
 */
export async function postDraftEntry(ctx: ActorContext, entryId: string) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(scoped(ctx, journalEntries, eq(journalEntries.id, entryId)))
      .limit(1)

    if (!entry) throw new Error('Entry not found')
    if (entry.status !== 'draft') {
      throw new Error(`Entry ${entry.entryNumber} is ${entry.status}, not a draft.`)
    }

    await assertPeriodOpen(ctx, entry.entryDate, tx)

    await tx
      .update(journalEntries)
      .set({ status: 'posted', postedAt: new Date(), postedBy: ctx.userId })
      .where(eq(journalEntries.id, entryId))

    await recordAudit(
      ctx,
      {
        action: 'journal.post',
        entityType: 'journal_entry',
        entityId: entryId,
        before: { status: 'draft' },
        after: { status: 'posted', entryNumber: entry.entryNumber },
      },
      tx,
    )

    return { id: entryId, entryNumber: entry.entryNumber }
  })
}

/** Discards a proposed entry. Only a draft — a posted entry is voided, never deleted. */
export async function discardDraftEntry(ctx: ActorContext, entryId: string): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(scoped(ctx, journalEntries, eq(journalEntries.id, entryId)))
      .limit(1)

    if (!entry) throw new Error('Entry not found')
    if (entry.status !== 'draft') {
      throw new Error(
        `Entry ${entry.entryNumber} is ${entry.status}. A posted entry is voided, never deleted.`,
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'journal.discard_draft',
        entityType: 'journal_entry',
        entityId: entryId,
        before: { entryNumber: entry.entryNumber, memo: entry.memo },
      },
      tx,
    )

    // Lines cascade. Deleting is right for a draft specifically: it was a
    // proposal, it was never part of the record, and keeping rejected
    // proposals in the ledger table would mean every query grows a filter.
    await tx.delete(journalEntries).where(eq(journalEntries.id, entryId))
  })
}

/** Entries proposed and not yet decided. */
export async function listDraftEntries(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(journalEntries)
    .where(scoped(ctx, journalEntries, eq(journalEntries.status, 'draft')))
    .orderBy(desc(journalEntries.entryDate))
    .limit(opts.limit ?? 50)
}

/** Journal entries for the accounting workspace, newest first. */
export async function listEntries(
  ctx: ActorContext,
  opts: { startDate?: string; endDate?: string; limit?: number; includeVoid?: boolean } = {},
) {
  requirePermission(ctx, 'accounting:view')

  const conditions = [
    opts.startDate ? gte(journalEntries.entryDate, opts.startDate) : undefined,
    opts.endDate ? lte(journalEntries.entryDate, opts.endDate) : undefined,
    opts.includeVoid ? undefined : eq(journalEntries.status, 'posted'),
  ]

  return db
    .select()
    .from(journalEntries)
    .where(scoped(ctx, journalEntries, ...conditions))
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNumber))
    .limit(opts.limit ?? 100)
}

/** One entry with its lines and account names, for a detail view. */
export async function entryWithLines(ctx: ActorContext, entryId: string) {
  requirePermission(ctx, 'accounting:view')

  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(scoped(ctx, journalEntries, eq(journalEntries.id, entryId)))
    .limit(1)

  if (!entry) return null

  const lines = await db
    .select({
      id: journalLines.id,
      chartAccountId: journalLines.chartAccountId,
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      memo: journalLines.memo,
      projectId: journalLines.projectId,
      costCodeId: journalLines.costCodeId,
    })
    .from(journalLines)
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(eq(journalLines.journalEntryId, entryId))
    .orderBy(journalLines.sortOrder)

  return { entry, lines }
}

/** Closes a period, blocking changes to entries dated inside it (spec §13). */
export async function closePeriod(
  ctx: ActorContext,
  input: { periodStart: string; periodEnd: string; notes?: string },
) {
  requirePermission(ctx, 'accounting:close')

  if (input.periodEnd < input.periodStart) {
    throw new Error('The period end must be on or after the period start.')
  }

  return db.transaction(async (tx) => {
    const [period] = await tx
      .insert(accountingPeriods)
      .values({
        companyId: ctx.companyId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        notes: input.notes ?? null,
        status: 'closed',
        closedBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'period.close',
        entityType: 'accounting_period',
        entityId: period.id,
        after: { periodStart: input.periodStart, periodEnd: input.periodEnd },
      },
      tx,
    )

    return period
  })
}

/**
 * Reopens a closed period.
 *
 * Requires `accounting:close`, and the row is marked reopened rather than
 * deleted, so the close and its reversal both remain visible (spec §4).
 */
export async function reopenPeriod(ctx: ActorContext, periodId: string) {
  requirePermission(ctx, 'accounting:close')

  return db.transaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(accountingPeriods)
      .where(scoped(ctx, accountingPeriods, eq(accountingPeriods.id, periodId)))
      .limit(1)

    if (!period) throw new Error('Accounting period not found')

    await tx
      .update(accountingPeriods)
      .set({ status: 'reopened', reopenedAt: new Date(), reopenedBy: ctx.userId })
      .where(
        and(
          eq(accountingPeriods.id, periodId),
          eq(accountingPeriods.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'period.reopen',
        entityType: 'accounting_period',
        entityId: periodId,
        before: { status: 'closed' },
        after: { status: 'reopened' },
      },
      tx,
    )
  })
}

export async function listPeriods(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(accountingPeriods)
    .where(scoped(ctx, accountingPeriods))
    .orderBy(desc(accountingPeriods.periodEnd))
}
