import { and, desc, eq, gt, gte, isNull, lte, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, fiscalYearCloses, journalEntries, journalLines } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry, voidJournalEntry } from '@/modules/ledger/journal'
import { accountBalances } from './balances'
import { formatCents } from '@/lib/money'
import { DomainError } from '@/modules/errors'

/**
 * Year-end closing entries (spec §13: "recurring entries, adjusting entries,
 * and **closing entries**").
 *
 * ## What closing does
 *
 * Revenue and expense accounts measure a year and then start again. Closing is
 * the entry that empties them into Retained Earnings, so the next year opens
 * from zero and the accumulated result sits where a balance sheet expects it:
 *
 * ```
 *   Dr  every revenue account       its balance
 *       Cr  every expense account       its balance
 *       Cr  Retained Earnings           the difference   (a profit)
 * ```
 *
 * The balance sheet has anticipated this since Phase 2, which shows current
 * earnings as a separate equity line precisely because *"closing entries are
 * what move it, and they have not been written yet at the time this report is
 * run"*. After a close, that line is empty for the closed year — because the
 * entry moved it.
 *
 * ## Why closing is not the same as locking
 *
 * Period locking already exists and stops entries being *written* into a
 * period. Closing is an accounting act: it writes one more entry, the last one
 * of the year. A company can close without locking (and find a correction next
 * week) or lock without closing (and carry the year's result in the wrong
 * place). Doing both is usual; conflating them would mean a correction to last
 * year required unlocking something that had nothing to do with the lock.
 *
 * So closing does not lock, and this module says so rather than deciding for
 * anybody.
 */

export type CloseCheck = {
  severity: 'blocker' | 'warning'
  message: string
}

export type ClosePreview = {
  fiscalYear: number
  closingDate: string
  revenueCents: number
  expenseCents: number
  netIncomeCents: number
  /** What to look at first. A blocker stops the close. */
  checks: CloseCheck[]
  alreadyClosed: boolean
}

/**
 * What closing this year would do, and what is wrong with the books first.
 *
 * The checks are the same idea as Phase 9's workpaper exceptions: an accountant
 * finds a draft entry or an unbalanced ledger eventually, and finding it before
 * the close rather than after is the whole value.
 */
export async function previewClose(
  ctx: ActorContext,
  input: { closingDate: string },
): Promise<ClosePreview> {
  requirePermission(ctx, 'accounting:close')

  const fiscalYear = Number(input.closingDate.slice(0, 4))
  const yearStart = `${fiscalYear}-01-01`

  const balances = await accountBalances(ctx, {
    startDate: yearStart,
    endDate: input.closingDate,
  })

  const revenue = balances.filter((row) => ['revenue', 'other_income'].includes(row.type))
  const expenses = balances.filter((row) =>
    ['cogs', 'expense', 'other_expense'].includes(row.type),
  )

  const revenueCents = revenue.reduce((sum, row) => sum + row.balanceCents, 0)
  const expenseCents = expenses.reduce((sum, row) => sum + row.balanceCents, 0)

  const checks: CloseCheck[] = []

  const [existing] = await db
    .select()
    .from(fiscalYearCloses)
    .where(
      scoped(
        ctx,
        fiscalYearCloses,
        eq(fiscalYearCloses.fiscalYear, fiscalYear),
        isNull(fiscalYearCloses.reopenedAt),
      ),
    )
    .limit(1)

  if (existing) {
    checks.push({
      severity: 'blocker',
      message: `${fiscalYear} was already closed on ${existing.closedAt.toISOString().slice(0, 10)}. Closing it twice would double the transfer to Retained Earnings.`,
    })
  }

  // Drafts are invisible to every statement, which is exactly why they are
  // worth raising here: a proposed entry nobody decided on is about to become
  // permanently "last year's".
  const drafts = await db
    .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
    .from(journalEntries)
    .where(
      scoped(
        ctx,
        journalEntries,
        eq(journalEntries.status, 'draft'),
        gte(journalEntries.entryDate, yearStart),
        lte(journalEntries.entryDate, input.closingDate),
      ),
    )

  const inYear = drafts.length
  if (inYear > 0) {
    checks.push({
      severity: 'warning',
      message: `${inYear} proposed ${inYear === 1 ? 'entry is' : 'entries are'} still waiting for a decision. They affect no figure, so closing now leaves them out of the year.`,
    })
  }

  const retained = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.retainedEarnings)
  if (!retained) {
    checks.push({
      severity: 'blocker',
      message: 'Retained Earnings (3200) is missing from the chart of accounts.',
    })
  }

  if (revenueCents === 0 && expenseCents === 0) {
    checks.push({
      severity: 'warning',
      message: 'There is no revenue or expense in this year. Closing it would post nothing.',
    })
  }

  return {
    fiscalYear,
    closingDate: input.closingDate,
    revenueCents,
    expenseCents,
    netIncomeCents: revenueCents - expenseCents,
    checks,
    alreadyClosed: Boolean(existing),
  }
}

export class CloseBlockedError extends DomainError {
  readonly status = 409
  constructor(readonly blockers: CloseCheck[]) {
    super(blockers.map((check) => check.message).join(' '))
    this.name = 'CloseBlockedError'
  }
}

/**
 * Closes a financial year.
 *
 * One entry, dated the last day of the year, zeroing every revenue and expense
 * account into Retained Earnings. Refuses on a blocker with no override — this
 * is not Phase 9's filing, where a person might have a good reason to prepare
 * from imperfect figures. Closing a year twice has exactly one outcome, it is
 * wrong, and no reason makes it right.
 */
export async function closeFiscalYear(
  ctx: ActorContext,
  input: { closingDate: string; memo?: string },
) {
  requirePermission(ctx, 'accounting:close')

  const preview = await previewClose(ctx, input)
  const blockers = preview.checks.filter((check) => check.severity === 'blocker')

  if (blockers.length > 0) throw new CloseBlockedError(blockers)

  const yearStart = `${preview.fiscalYear}-01-01`
  const balances = await accountBalances(ctx, {
    startDate: yearStart,
    endDate: input.closingDate,
  })

  const retained = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.retainedEarnings)
  if (!retained) throw new Error('Retained Earnings (3200) is missing from the chart of accounts.')

  const periodAccounts = balances.filter((row) =>
    ['revenue', 'other_income', 'cogs', 'expense', 'other_expense'].includes(row.type),
  )

  if (periodAccounts.length === 0) {
    throw new Error('There is nothing to close in this year.')
  }

  // Each account is zeroed by posting the opposite of its balance. Working
  // from debits and credits rather than the signed balance keeps this correct
  // for an account with an abnormal balance — a revenue account with a debit
  // balance after heavy credit notes closes the same way as any other.
  const lines = periodAccounts.map((row) => {
    const net = row.debitCents - row.creditCents
    return net > 0
      ? { chartAccountId: row.chartAccountId, creditCents: net, memo: `Close ${row.number}` }
      : { chartAccountId: row.chartAccountId, debitCents: -net, memo: `Close ${row.number}` }
  })

  const netIncomeCents = preview.netIncomeCents

  // The balancing line. A profit credits Retained Earnings; a loss debits it.
  if (netIncomeCents !== 0) {
    lines.push(
      netIncomeCents > 0
        ? { chartAccountId: retained.id, creditCents: netIncomeCents, memo: 'Net income for the year' }
        : { chartAccountId: retained.id, debitCents: -netIncomeCents, memo: 'Net loss for the year' },
    )
  }

  return db.transaction(async (tx) => {
    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.closingDate,
        memo:
          input.memo ??
          `Closing entry for ${preview.fiscalYear} — ${formatCents(netIncomeCents)} to Retained Earnings`,
        source: 'closing',
        sourceType: 'fiscal_year_close',
        lines: lines.filter((line) => (line.debitCents ?? 0) + (line.creditCents ?? 0) > 0),
      },
      tx,
    )

    const [closed] = await tx
      .insert(fiscalYearCloses)
      .values({
        companyId: ctx.companyId,
        closingDate: input.closingDate,
        fiscalYear: preview.fiscalYear,
        netIncomeCents,
        revenueCents: preview.revenueCents,
        expenseCents: preview.expenseCents,
        journalEntryId: entry.id,
        // What was known to be imperfect, frozen alongside — the same idea as
        // a prepared filing carrying its exceptions.
        exceptions: preview.checks,
        closedBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'year.close',
        entityType: 'fiscal_year_close',
        entityId: closed.id,
        after: {
          fiscalYear: preview.fiscalYear,
          netIncomeCents,
          revenueCents: preview.revenueCents,
          expenseCents: preview.expenseCents,
          entryNumber: entry.entryNumber,
        },
      },
      tx,
    )

    return { ...closed, journalEntryId: entry.id, entryNumber: entry.entryNumber }
  })
}

/**
 * Reopens a closed year by reversing its closing entry.
 *
 * Reversal rather than deletion, for the same reason a posted entry is voided
 * rather than deleted: the fact that the year was closed and then reopened is
 * part of the record, and an auditor asking "why does Retained Earnings move
 * twice in January" deserves an answer.
 */
export async function reopenFiscalYear(
  ctx: ActorContext,
  closeId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, 'accounting:close')

  if (!reason.trim()) throw new Error('Say why the year is being reopened.')

  await db.transaction(async (tx) => {
    const [closed] = await tx
      .select()
      .from(fiscalYearCloses)
      .where(scoped(ctx, fiscalYearCloses, eq(fiscalYearCloses.id, closeId)))
      .limit(1)

    if (!closed) throw new Error('Close not found')
    if (closed.reopenedAt) throw new Error('That year is already reopened.')

    if (closed.journalEntryId) {
      await voidJournalEntry(ctx, closed.journalEntryId, tx)
    }

    await tx
      .update(fiscalYearCloses)
      .set({ reopenedAt: new Date(), reopenReason: reason.trim() })
      .where(eq(fiscalYearCloses.id, closeId))

    await recordAudit(
      ctx,
      {
        action: 'year.reopen',
        entityType: 'fiscal_year_close',
        entityId: closeId,
        before: { fiscalYear: closed.fiscalYear, netIncomeCents: closed.netIncomeCents },
        after: { reason: reason.trim() },
      },
      tx,
    )
  })
}

export async function listCloses(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(fiscalYearCloses)
    .where(scoped(ctx, fiscalYearCloses))
    .orderBy(desc(fiscalYearCloses.fiscalYear))
}

export type StaleClose = {
  closeId: string
  fiscalYear: number
  closingDate: string
  closedAt: Date
  /** Posted entries dated inside the closed year, written after the close. */
  entriesSinceCloseCount: number
  /** How much the year's net income would move if it were closed again. */
  netIncomeDriftCents: number
}

/**
 * Closes whose figures have gone stale (ADR 0011, follow-up 1).
 *
 * ## Why this is a warning and not a block
 *
 * Closing and locking are deliberately separate. Locking stops entries being
 * written; closing writes one more — the last of the year. Conflating them
 * would mean a correction to last year needed somebody to unlock something
 * that was never locked, so posting into a closed year stays possible.
 *
 * But it has a consequence nothing was saying: the close moved a *number* into
 * Retained Earnings, and an entry landing in that year afterwards makes the
 * number wrong. The books still balance — the new entry has its own two sides
 * — and the year's profit no longer matches what was transferred, which is the
 * kind of error that surfaces a year later as an equity figure nobody can
 * explain.
 *
 * So: the entries are counted, the drift is measured, and the person who has
 * to decide gets told. Reopening and re-closing is the fix, and it is theirs
 * to choose.
 */
export async function staleCloses(ctx: ActorContext): Promise<StaleClose[]> {
  requirePermission(ctx, 'accounting:view')

  const closes = await db
    .select()
    .from(fiscalYearCloses)
    .where(scoped(ctx, fiscalYearCloses, isNull(fiscalYearCloses.reopenedAt)))
    .orderBy(desc(fiscalYearCloses.fiscalYear))

  const stale: StaleClose[] = []

  for (const close of closes) {
    const yearStart = `${close.fiscalYear}-01-01`

    // `created_at`, not `entry_date`: an entry dated inside the year is only a
    // problem if it was *written* after the close froze the figures. The
    // closing entry itself is excluded, since it is what the close is.
    const [row] = await db
      .select({ count: sql<string>`count(*)` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.entryDate, yearStart),
          lte(journalEntries.entryDate, close.closingDate),
          gt(journalEntries.createdAt, close.closedAt),
          close.journalEntryId ? ne(journalEntries.id, close.journalEntryId) : undefined,
        ),
      )

    const count = Number(row?.count ?? 0)
    if (count === 0) continue

    // Recompute the year's profit and compare it with what was transferred.
    // Reading it rather than inferring it means the figure shown is the drift
    // that actually exists, not the size of the entries that might have caused
    // one — two corrections in opposite directions cancel, and saying so is
    // more useful than raising an alarm about them.
    //
    // `accountBalances` cannot be reused here: it would include the closing
    // entry, which zeroes every revenue and expense account by design, and the
    // recomputed profit would come out as nothing every time.
    const [profit] = await db
      .select({
        income: sql<string>`coalesce(sum(
          CASE WHEN ${chartAccounts.type} IN ('revenue', 'other_income')
               THEN ${journalLines.creditCents} - ${journalLines.debitCents} ELSE 0 END), 0)`,
        expense: sql<string>`coalesce(sum(
          CASE WHEN ${chartAccounts.type} IN ('expense', 'cogs', 'other_expense')
               THEN ${journalLines.debitCents} - ${journalLines.creditCents} ELSE 0 END), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.entryDate, yearStart),
          lte(journalEntries.entryDate, close.closingDate),
          ne(journalEntries.source, 'closing'),
        ),
      )

    const income = Number(profit?.income ?? 0)
    const expense = Number(profit?.expense ?? 0)

    stale.push({
      closeId: close.id,
      fiscalYear: close.fiscalYear,
      closingDate: close.closingDate,
      closedAt: close.closedAt,
      entriesSinceCloseCount: count,
      netIncomeDriftCents: income - expense - close.netIncomeCents,
    })
  }

  return stale
}
