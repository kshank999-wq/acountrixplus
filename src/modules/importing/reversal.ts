import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  bills,
  chartAccounts,
  customers,
  importRecords,
  importRuns,
  invoices,
  journalEntries,
  journalLines,
  paymentApplications,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { voidJournalEntry } from '@/modules/ledger/journal'
import { DomainError } from '@/modules/errors'

/**
 * Undoing an import (spec §19: nothing destroys history).
 *
 * A bulk write is the highest-stakes operation in the application — four
 * hundred rows arriving at once, from a file whose column mapping somebody
 * guessed at. The realistic failure is not that it crashes; it is that it
 * succeeds and is *wrong*, and is discovered twenty minutes later.
 *
 * ## What reversal does, and what it refuses to do
 *
 * It removes what the import **created**, and only that, found by name from
 * `import_records` rather than by a timestamp window that would sweep up
 * whatever else happened in the same minute.
 *
 * It refuses when anything created has since been *used* — a customer with an
 * invoice raised against them, an opening invoice that has been part-paid.
 * Deleting those would either fail on a foreign key or, worse, cascade and
 * take the newer work with it. So reversal stops and says which rows are in
 * the way, and the person decides.
 *
 * Journal entries are **voided rather than deleted**, because ADR 0002's rule
 * has held since Phase 2: posted entries are never erased. An entry number
 * that vanished would leave a gap an auditor is entitled to ask about.
 *
 * Rows the import **updated** are not touched. An account that already existed
 * and had its name corrected is not the import's to delete, and restoring the
 * old name would undo a correction somebody may have built on since.
 */

export class ImportNotReversibleError extends DomainError {
  readonly status = 409
  constructor(readonly reasons: string[]) {
    super(
      `This import cannot be undone because some of what it created is now in use:\n` +
        reasons.map((reason) => `  • ${reason}`).join('\n'),
    )
    this.name = 'ImportNotReversibleError'
  }
}

export type ImportRunSummary = {
  id: string
  kind: string
  status: 'committed' | 'reverted'
  fileName: string | null
  rowCount: number
  createdCount: number
  updatedCount: number
  skippedCount: number
  totalCents: number | null
  createdAt: Date
  revertedAt: Date | null
  notes: string[]
}

export async function listImportRuns(
  ctx: ActorContext,
  opts: { limit?: number } = {},
): Promise<ImportRunSummary[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(importRuns)
    .where(scoped(ctx, importRuns))
    .orderBy(desc(importRuns.createdAt))
    .limit(opts.limit ?? 25)

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    fileName: row.fileName,
    rowCount: row.rowCount,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    totalCents: row.totalCents,
    createdAt: row.createdAt,
    revertedAt: row.revertedAt,
    notes: parseNotes(row.notes),
  }))
}

function parseNotes(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((note): note is string => typeof note === 'string') : []
  } catch {
    return []
  }
}

/**
 * Checks whether an import can be undone, without undoing it.
 *
 * The wizard calls this before offering the button, so "Undo" is never a
 * button that fails.
 */
export async function reversalBlockers(
  ctx: ActorContext,
  runId: string,
): Promise<string[]> {
  requirePermission(ctx, 'accounting:view')

  const [run] = await db
    .select()
    .from(importRuns)
    .where(scoped(ctx, importRuns, eq(importRuns.id, runId)))
    .limit(1)

  if (!run) return ['That import does not exist on these books.']
  if (run.status === 'reverted') return ['This import has already been undone.']

  const created = await db
    .select({ entityType: importRecords.entityType, entityId: importRecords.entityId })
    .from(importRecords)
    .where(
      scoped(
        ctx,
        importRecords,
        eq(importRecords.importRunId, runId),
        eq(importRecords.action, 'created'),
      ),
    )

  const ids = (type: string) =>
    created.filter((record) => record.entityType === type).map((record) => record.entityId)

  const blockers: string[] = []

  const accountIds = ids('chart_account')
  if (accountIds.length > 0) {
    const used = await db
      .select({ id: journalLines.chartAccountId, count: sql<string>`count(*)` })
      .from(journalLines)
      .where(scoped(ctx, journalLines, inArray(journalLines.chartAccountId, accountIds)))
      .groupBy(journalLines.chartAccountId)

    if (used.length > 0) {
      blockers.push(
        `${used.length} imported ${used.length === 1 ? 'account has' : 'accounts have'} postings against them.`,
      )
    }
  }

  const customerIds = ids('customer')
  if (customerIds.length > 0) {
    // Invoices this import made are removed with it, so only invoices from
    // elsewhere block. Anything else would make an import un-undoable by its
    // own output.
    const ownInvoiceIds = new Set(ids('invoice'))
    const raised = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(scoped(ctx, invoices, inArray(invoices.customerId, customerIds)))

    const foreign = raised.filter((invoice) => !ownInvoiceIds.has(invoice.id))
    if (foreign.length > 0) {
      blockers.push(
        `${foreign.length} ${foreign.length === 1 ? 'invoice has' : 'invoices have'} been raised against imported customers.`,
      )
    }
  }

  const vendorIds = ids('vendor')
  if (vendorIds.length > 0) {
    const ownBillIds = new Set(ids('bill'))
    const entered = await db
      .select({ id: bills.id })
      .from(bills)
      .where(scoped(ctx, bills, inArray(bills.vendorId, vendorIds)))

    const foreign = entered.filter((bill) => !ownBillIds.has(bill.id))
    if (foreign.length > 0) {
      blockers.push(
        `${foreign.length} ${foreign.length === 1 ? 'bill has' : 'bills have'} been entered against imported vendors.`,
      )
    }
  }

  // A statement import (Phase 39) puts rows in the feed, not the ledger. An
  // untouched row is safe to remove — nobody has said anything about it. A row
  // somebody has since coded carries a journal entry, and one that has been
  // cleared is part of a reconciliation, so both are somebody else's work now.
  const transactionIds = ids('bank_transaction')
  if (transactionIds.length > 0) {
    const posted = await db
      .select({ id: journalEntries.sourceId })
      .from(journalEntries)
      .where(
        scoped(
          ctx,
          journalEntries,
          eq(journalEntries.sourceType, 'bank_transaction'),
          inArray(journalEntries.sourceId, transactionIds),
          ne(journalEntries.status, 'void'),
        ),
      )

    if (posted.length > 0) {
      blockers.push(
        `${posted.length} imported ${posted.length === 1 ? 'transaction has' : 'transactions have'} been categorised and posted.`,
      )
    }

    const cleared = await db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        scoped(
          ctx,
          bankTransactions,
          inArray(bankTransactions.id, transactionIds),
          isNotNull(bankTransactions.clearedAt),
        ),
      )

    if (cleared.length > 0) {
      blockers.push(
        `${cleared.length} imported ${cleared.length === 1 ? 'transaction has' : 'transactions have'} been cleared on a reconciliation.`,
      )
    }
  }

  const documentIds = [...ids('invoice'), ...ids('bill')]
  if (documentIds.length > 0) {
    // Two `inArray`s rather than one `= ANY($1)`: the driver sends a uuid[]
    // parameter as a comma-joined string, and Postgres refuses it with
    // "op ANY/ALL (array) requires array on right side".
    const paid = await db
      .select({ id: paymentApplications.id })
      .from(paymentApplications)
      .where(
        scoped(
          ctx,
          paymentApplications,
          or(
            inArray(paymentApplications.invoiceId, documentIds),
            inArray(paymentApplications.billId, documentIds),
          ),
        ),
      )

    if (paid.length > 0) {
      blockers.push(
        `${paid.length} payment${paid.length === 1 ? ' has' : 's have'} been applied to imported documents.`,
      )
    }
  }

  return blockers
}

export type ReversalResult = {
  runId: string
  deleted: Record<string, number>
  entriesVoided: number
  updatesLeftAlone: number
}

export async function revertImport(
  ctx: ActorContext,
  runId: string,
): Promise<ReversalResult> {
  const [subject] = await db
    .select({ kind: importRuns.kind })
    .from(importRuns)
    .where(scoped(ctx, importRuns, eq(importRuns.id, runId)))
    .limit(1)

  // Undoing an opening balance voids journal entries, so it is an accountant's
  // act. Undoing a statement import deletes uncategorised feed rows and touches
  // no ledger at all — and the person who imported the wrong file into the
  // wrong account is a bookkeeper, who would otherwise have to find somebody
  // else to clean up after them.
  requirePermission(ctx, subject?.kind === 'bank_statement' ? 'bookkeeping:import' : 'accounting:journal')

  const blockers = await reversalBlockers(ctx, runId)
  if (blockers.length > 0) throw new ImportNotReversibleError(blockers)

  return db.transaction(async (tx) => {
    const records = await tx
      .select()
      .from(importRecords)
      .where(scoped(ctx, importRecords, eq(importRecords.importRunId, runId)))

    const created = records.filter((record) => record.action === 'created')
    const ids = (type: string) =>
      created.filter((record) => record.entityType === type).map((record) => record.entityId)

    const deleted: Record<string, number> = {}
    let entriesVoided = 0

    // Documents first: their journal entries are voided, then the rows go.
    // Voiding before deleting keeps the entry's reference intact while the
    // void is recorded.
    const invoiceIds = ids('invoice')
    const billIds = ids('bill')

    for (const [table, documentIds, label] of [
      [invoices, invoiceIds, 'invoice'],
      [bills, billIds, 'bill'],
    ] as const) {
      if (documentIds.length === 0) continue

      const documents = await tx
        .select({ id: table.id, journalEntryId: table.journalEntryId })
        .from(table)
        .where(scoped(ctx, table, inArray(table.id, documentIds)))

      for (const document of documents) {
        if (document.journalEntryId) {
          await voidJournalEntry(ctx, document.journalEntryId, tx)
          entriesVoided += 1
        }
      }

      const removed = await tx
        .delete(table)
        .where(scoped(ctx, table, inArray(table.id, documentIds)))
        .returning({ id: table.id })

      deleted[label] = removed.length
    }

    for (const [table, entityIds, label] of [
      [customers, ids('customer'), 'customer'],
      [vendors, ids('vendor'), 'vendor'],
      [chartAccounts, ids('chart_account'), 'account'],
      // Safe to delete outright rather than void, because a feed row is not
      // history — nothing posted, and the blockers above have already refused
      // if anything did. Re-importing the file puts them back identically,
      // which is the whole point of the fingerprint.
      [bankTransactions, ids('bank_transaction'), 'bank transaction'],
    ] as const) {
      if (entityIds.length === 0) continue
      const removed = await tx
        .delete(table)
        .where(scoped(ctx, table, inArray(table.id, entityIds)))
        .returning({ id: table.id })
      deleted[label] = removed.length
    }

    // A trial balance import has no records — it is one journal entry, named
    // on the run itself.
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(scoped(ctx, importRuns, eq(importRuns.id, runId)))
      .limit(1)

    if (run?.journalEntryId) {
      const [entry] = await tx
        .select({ status: journalEntries.status })
        .from(journalEntries)
        .where(
          and(eq(journalEntries.id, run.journalEntryId), eq(journalEntries.companyId, ctx.companyId)),
        )
        .limit(1)

      if (entry && entry.status === 'posted') {
        await voidJournalEntry(ctx, run.journalEntryId, tx)
        entriesVoided += 1
      }
    }

    await tx
      .update(importRuns)
      .set({ status: 'reverted', revertedAt: new Date(), revertedBy: ctx.userId })
      .where(scoped(ctx, importRuns, eq(importRuns.id, runId)))

    const updatesLeftAlone = records.filter((record) => record.action === 'updated').length

    await recordAudit(
      ctx,
      {
        action: 'import.revert',
        entityType: 'import_run',
        entityId: runId,
        after: { deleted, entriesVoided, updatesLeftAlone },
      },
      tx,
    )

    return { runId, deleted, entriesVoided, updatesLeftAlone }
  })
}
