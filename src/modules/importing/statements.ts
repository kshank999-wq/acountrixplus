import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, financialAccounts, importRecords, importRuns } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError } from '@/modules/errors'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { isAmbiguousDate, parseDateISO, parseMoneyCents, type DateOrder } from './coerce'
import { readSheet, rowToRecord } from './csv'
import { proposeMapping, type FieldSpec } from './mapping'
import {
  finishPlan,
  ImportNotReadyError,
  summarizeProblems,
  type ImportPlan,
  type PlannedRow,
  type RowProblem,
} from './plan'
import { fingerprintRows, signedAmountCents, type StatementRow } from './statement-rows'

/**
 * Importing a downloaded bank statement (spec §3, §17).
 *
 * ## Why this exists
 *
 * Transactions could only arrive through a `BankProvider`, and the only adapter
 * is the mock. A business with real books and no aggregator connection had no
 * way to get a single transaction into the system — which made every screen
 * downstream, the whole of Phase 1 and 2, unreachable with their own money.
 *
 * Every bank on earth exports CSV. This is the path that needs no vendor, no
 * credentials and no integration to approve.
 *
 * ## It is a feed, not a ledger entry
 *
 * The rows land in `bank_transactions` — the same table, the same inbox, the
 * same review state a connection would have produced. Nothing posts. The rules
 * engine, categorisation and reconciliation are all Phase 1's and are reached
 * unchanged, because a statement row is the same kind of fact whether a machine
 * fetched it or somebody downloaded it.
 *
 * That is also what makes the reversal safe: an uncategorised row can simply be
 * deleted, and a categorised one refuses, because by then it is attached to an
 * entry in the ledger.
 */

export const STATEMENT_FIELDS: FieldSpec[] = [
  {
    key: 'date',
    label: 'Date',
    required: true,
    aliases: ['transaction date', 'posted date', 'posting date', 'date posted', 'value date'],
  },
  {
    key: 'description',
    label: 'Description',
    required: true,
    aliases: ['details', 'narrative', 'memo', 'payee', 'transaction', 'particulars', 'reference'],
  },
  {
    key: 'amount',
    label: 'Amount',
    required: false,
    aliases: ['value', 'transaction amount'],
    hint: 'A single signed column: negative for money out.',
  },
  {
    key: 'debit',
    label: 'Money out',
    required: false,
    aliases: ['debit', 'withdrawal', 'withdrawals', 'paid out', 'payment', 'spend'],
    hint: 'Used when the statement has separate columns.',
  },
  {
    key: 'credit',
    label: 'Money in',
    required: false,
    aliases: ['credit', 'deposit', 'deposits', 'paid in', 'receipt'],
    hint: 'Used when the statement has separate columns.',
  },
]

/**
 * The accounts a statement can be imported into.
 *
 * Every financial account, including ones already fed by a connection: a
 * connection that has been down for a fortnight is exactly when somebody
 * downloads the CSV, and refusing them the account would be refusing the only
 * case where this matters most. The dedup means importing over a synced window
 * adds nothing.
 */
export async function listStatementAccounts(
  ctx: ActorContext,
): Promise<Array<{ id: string; name: string; mask: string | null }>> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: financialAccounts.id, name: financialAccounts.name, mask: financialAccounts.mask })
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.isActive, true)))
    .orderBy(financialAccounts.name)
}

export type PlannedStatementRow = {
  postedDate: string
  amountCents: number
  description: string
  fingerprint: string
  /** Already in the feed — from an earlier import, or an overlapping window. */
  alreadyPresent: boolean
}

export type StatementPlanExtra = {
  financialAccountId: string
  accountName: string
  /** How the dates were read, so the wizard can offer to flip it. */
  dateOrder: DateOrder
  /** Sum of what would actually be added, for a sanity check against the file. */
  netCentsToAdd: number
  earliest: string | null
  latest: string | null
}

/**
 * Reads a statement and says what importing it would do.
 *
 * Nothing is written. The counts distinguish *new* from *already present*,
 * which is the number that matters: importing an overlapping window is normal
 * and the honest report of it is "142 rows, 118 you already have".
 */
export async function planStatementImport(
  ctx: ActorContext,
  input: {
    financialAccountId: string
    text: string
    columns?: Record<string, string | null>
    dateOrder?: DateOrder
  },
): Promise<ImportPlan<PlannedStatementRow> & StatementPlanExtra> {
  requirePermission(ctx, 'bookkeeping:import')

  const [account] = await db
    .select({ id: financialAccounts.id, name: financialAccounts.name })
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!account) {
    throw new StatementImportError('Choose an account to import the statement into.')
  }

  const sheet = readSheet(input.text)
  const proposed = proposeMapping(sheet.headers, STATEMENT_FIELDS)
  const columns = input.columns ?? proposed.columns
  const dateOrder = input.dateOrder ?? 'mdy'

  const fileProblems: RowProblem[] = []
  for (const field of STATEMENT_FIELDS) {
    if (field.required && !columns[field.key]) {
      fileProblems.push({
        row: 0,
        field: field.key,
        message: `No column is mapped to ${field.label}.`,
        severity: 'error',
      })
    }
  }

  // One of the three money columns has to be mapped, and which ones depends on
  // the bank. Checked here rather than by marking all three required, because
  // requiring a column that this statement does not have would refuse a
  // perfectly good file.
  if (!columns.amount && !columns.debit && !columns.credit) {
    fileProblems.push({
      row: 0,
      field: 'amount',
      message: 'Map either a single Amount column, or Money out and Money in.',
      severity: 'error',
    })
  }

  /** Rows that parsed, in file order, before identity is assigned. */
  const parsed: Array<{ row: number; value: StatementRow | null; problems: RowProblem[] }> = []

  sheet.rows.forEach((cells, index) => {
    const rowNumber = index + 2 // 1-based, and the header is row 1.
    const source = rowToRecord(sheet.headers, cells)
    const problems: RowProblem[] = []

    const rawDate = columns.date ? (source[columns.date] ?? '') : ''
    const rawDescription = columns.description ? (source[columns.description] ?? '') : ''

    const postedDate = parseDateISO(rawDate, dateOrder)
    if (!postedDate) {
      problems.push({
        row: rowNumber,
        field: 'date',
        message: rawDate.trim() ? `Could not read "${rawDate}" as a date.` : 'No date.',
        severity: 'error',
      })
    } else if (isAmbiguousDate(rawDate)) {
      // 03/04 is the 3rd of April or the 4th of March. Read one way, said out
      // loud, and left for a person to correct — silently picking is how a
      // statement lands in the wrong month.
      problems.push({
        row: rowNumber,
        field: 'date',
        message: `"${rawDate}" could be read either way; read as ${postedDate}.`,
        severity: 'warning',
      })
    }

    const money = signedAmountCents({
      amount: columns.amount ? parseMoneyCents(source[columns.amount] ?? '') : null,
      debit: columns.debit ? parseMoneyCents(source[columns.debit] ?? '') : null,
      credit: columns.credit ? parseMoneyCents(source[columns.credit] ?? '') : null,
    })

    if (!money.ok) {
      problems.push({
        row: rowNumber,
        field: 'amount',
        message:
          money.reason === 'both'
            ? 'This row has a figure in both Money out and Money in.'
            : 'No amount.',
        severity: 'error',
      })
    }

    const description = rawDescription.trim()
    if (!description) {
      problems.push({
        row: rowNumber,
        field: 'description',
        message: 'No description.',
        severity: 'error',
      })
    }

    const usable = postedDate && money.ok && description
    parsed.push({
      row: rowNumber,
      value: usable ? { postedDate, amountCents: money.cents, description } : null,
      problems,
    })
  })

  // Identity is assigned over the rows that parsed, in file order, so the
  // ordinal counts real duplicates rather than being thrown off by a broken
  // row in between.
  const usable = parsed.filter((entry) => entry.value !== null)
  const identified = fingerprintRows(
    account.id,
    usable.map((entry) => entry.value as StatementRow),
  )

  const existing = identified.length
    ? await db
        .select({ providerTransactionId: bankTransactions.providerTransactionId })
        .from(bankTransactions)
        .where(
          scoped(
            ctx,
            bankTransactions,
            and(
              eq(bankTransactions.financialAccountId, account.id),
              inArray(
                bankTransactions.providerTransactionId,
                identified.map((entry) => entry.fingerprint),
              ),
            ),
          ),
        )
    : []

  const present = new Set(existing.map((row) => row.providerTransactionId))

  const identityByIndex = new Map<number, (typeof identified)[number]>()
  usable.forEach((entry, index) => identityByIndex.set(entry.row, identified[index]))

  const rows: Array<PlannedRow<PlannedStatementRow>> = parsed.map((entry) => {
    const identity = identityByIndex.get(entry.row)

    if (!entry.value || !identity) {
      // Nothing to do with a row that did not parse. The problems it carries
      // are what stop the whole file committing.
      return { row: entry.row, parsed: null, action: 'skip' as const, problems: entry.problems }
    }

    const alreadyPresent = present.has(identity.fingerprint)
    return {
      row: entry.row,
      parsed: { ...entry.value, fingerprint: identity.fingerprint, alreadyPresent },
      problems: entry.problems,
      // A row already in the feed is a skip, not a problem: re-importing an
      // overlapping window is the normal way people use this.
      action: alreadyPresent ? ('skip' as const) : ('create' as const),
    }
  })

  const toAdd = rows.filter((row) => row.parsed && !row.parsed.alreadyPresent)
  const dates = rows.filter((row) => row.parsed).map((row) => (row.parsed as PlannedStatementRow).postedDate).sort()

  const plan = finishPlan<PlannedStatementRow>({
    headers: sheet.headers,
    columns,
    delimiter: sheet.delimiter,
    rows,
    fileProblems,
    blankRowsSkipped: sheet.blankRowsSkipped,
  })

  return {
    ...plan,
    // A statement is the one kind where every row can be a legitimate skip, so
    // `total > 0` is not enough to mean there is work. Without this, importing
    // last month's file again says "ready to import" over "to add: 0", and
    // committing writes an empty run into the history that answers "where did
    // these come from" — the one place that must not fill with noise.
    canCommit: plan.canCommit && plan.counts.willCreate > 0,
    financialAccountId: account.id,
    accountName: account.name,
    dateOrder,
    netCentsToAdd: toAdd.reduce(
      (sum, row) => sum + ((row.parsed as PlannedStatementRow).amountCents ?? 0),
      0,
    ),
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
  }
}

export class StatementImportError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'StatementImportError'
  }
}

/**
 * Writes the rows that are not already there.
 *
 * `onConflictDoNothing` on the dedup constraint as well as the plan's own
 * check, because the plan was computed a moment ago and two people importing
 * the same file at once must not produce two feeds. The database is what
 * decides, which is the rule this codebase applies wherever two people can act
 * at once.
 */
export async function commitStatementImport(
  ctx: ActorContext,
  plan: ImportPlan<PlannedStatementRow> & { financialAccountId: string },
  meta: { fileName?: string } = {},
): Promise<{ runId: string; created: number; skipped: number }> {
  requirePermission(ctx, 'bookkeeping:import')

  // Checked before the generic one so the message is the true one. "There is
  // nothing in this file to import" would be a lie about a file full of
  // perfectly good rows you happen to already have.
  if (plan.counts.errors === 0 && plan.counts.willCreate === 0) {
    throw new StatementImportError(
      plan.counts.total === 0
        ? 'There is nothing in this file.'
        : `You already have all ${plan.counts.total} of these transactions. Nothing to import.`,
    )
  }

  if (!plan.canCommit) throw new ImportNotReadyError(plan.counts.errors)

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        kind: 'bank_statement',
        fileName: meta.fileName ?? null,
        headers: JSON.stringify(plan.headers),
        columnMapping: JSON.stringify(plan.columns),
        rowCount: plan.counts.total,
        createdCount: plan.counts.willCreate,
        updatedCount: 0,
        skippedCount: plan.counts.willSkip,
        notes: JSON.stringify(summarizeProblems(plan.rows.flatMap((row) => row.problems))),
        createdBy: ctx.userId,
      })
      .returning({ id: importRuns.id })

    let created = 0
    let skipped = 0

    for (const planned of plan.rows) {
      if (!planned.parsed) continue
      const entry = planned.parsed

      if (entry.alreadyPresent) {
        skipped += 1
        continue
      }

      const [inserted] = await tx
        .insert(bankTransactions)
        .values({
          companyId: ctx.companyId,
          financialAccountId: plan.financialAccountId,
          providerTransactionId: entry.fingerprint,
          postedDate: entry.postedDate,
          amountCents: entry.amountCents,
          description: entry.description,
        })
        .onConflictDoNothing({
          target: [
            bankTransactions.companyId,
            bankTransactions.financialAccountId,
            bankTransactions.providerTransactionId,
          ],
        })
        .returning({ id: bankTransactions.id })

      // Absent means another import won the race. Counted as skipped, which is
      // what it is.
      if (!inserted) {
        skipped += 1
        continue
      }

      await tx.insert(importRecords).values({
        companyId: ctx.companyId,
        importRunId: run.id,
        entityType: 'bank_transaction',
        entityId: inserted.id,
        action: 'created',
        sourceRow: planned.row,
      })
      created += 1
    }

    await recordAudit(
      ctx,
      {
        action: 'import.commit',
        entityType: 'import_run',
        entityId: run.id,
        after: {
          kind: 'bank_statement',
          created,
          skipped,
          financialAccountId: plan.financialAccountId,
          fileName: meta.fileName ?? null,
        },
      },
      tx,
    )

    return { runId: run.id, created, skipped }
  })
}
