import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, importRecords, importRuns } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'
import { readSheet, rowToRecord } from './csv'
import { cleanText } from './coerce'
import { ACCOUNT_FIELDS, proposeMapping, valueFor } from './mapping'
import {
  finishPlan,
  ImportNotReadyError,
  summarizeProblems,
  type ImportPlan,
  type PlannedRow,
  type RowProblem,
} from './plan'

/**
 * Importing a chart of accounts (spec §5, §20 Phase 8).
 *
 * The first file anybody brings, and the one everything else depends on: a
 * trial balance is a list of account numbers, and open invoices post to
 * Accounts Receivable. Get the chart wrong and nothing after it can land.
 */

export type PlannedAccount = {
  number: string
  name: string
  type: AccountType
  subtype: string | null
  description: string | null
  /** Set when an account with this number already exists. */
  existingId?: string
  existingName?: string
}

/**
 * What other systems call each account type.
 *
 * QuickBooks says "Income" and "Other Current Asset"; Xero says "Revenue" and
 * "Current Asset"; Sage says "Sales". They all mean one of six things, and
 * asking a user to hand-map forty rows of an enum is asking them to give up.
 */
const TYPE_ALIASES: Record<string, AccountType> = {
  asset: 'asset',
  assets: 'asset',
  'current asset': 'asset',
  'other current asset': 'asset',
  'fixed asset': 'asset',
  'other asset': 'asset',
  bank: 'asset',
  'accounts receivable': 'asset',
  receivable: 'asset',
  'non current asset': 'asset',

  liability: 'liability',
  liabilities: 'liability',
  'current liability': 'liability',
  'other current liability': 'liability',
  'long term liability': 'liability',
  'accounts payable': 'liability',
  payable: 'liability',
  'credit card': 'liability',

  equity: 'equity',
  capital: 'equity',
  'owners equity': 'equity',

  revenue: 'revenue',
  income: 'revenue',
  sales: 'revenue',
  'operating income': 'revenue',

  cogs: 'cogs',
  'cost of goods sold': 'cogs',
  'cost of sales': 'cogs',
  'direct costs': 'cogs',

  expense: 'expense',
  expenses: 'expense',
  overhead: 'expense',
  'operating expense': 'expense',
  'operating expenses': 'expense',

  'other income': 'other_income',
  'other revenue': 'other_income',
  'non operating income': 'other_income',

  'other expense': 'other_expense',
  'other expenses': 'other_expense',
  depreciation: 'other_expense',
  'non operating expense': 'other_expense',
}

/** Maps a foreign type name onto ours, or null if it means nothing here. */
export function normalizeAccountType(raw: string): AccountType | null {
  const key = cleanText(raw).toLowerCase().replace(/[^a-z ]/g, '').trim()
  if (key === '') return null
  return TYPE_ALIASES[key] ?? null
}

export async function planAccountImport(
  ctx: ActorContext,
  input: { text: string; columns?: Record<string, string | null> },
): Promise<ImportPlan<PlannedAccount>> {
  requirePermission(ctx, 'accounting:journal')

  const sheet = readSheet(input.text)
  const proposed = proposeMapping(sheet.headers, ACCOUNT_FIELDS)
  const columns = input.columns ?? proposed.columns

  const fileProblems: RowProblem[] = []
  for (const field of ACCOUNT_FIELDS) {
    if (field.required && !columns[field.key]) {
      fileProblems.push({
        row: 0,
        field: field.key,
        message: `No column is mapped to ${field.label}.`,
        severity: 'error',
      })
    }
  }

  const existing = await db
    .select({
      id: chartAccounts.id,
      number: chartAccounts.number,
      name: chartAccounts.name,
      isSystem: chartAccounts.isSystem,
    })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))

  const byNumber = new Map(existing.map((account) => [account.number, account]))
  const seenInFile = new Map<string, number>()
  const rows: Array<PlannedRow<PlannedAccount>> = []

  sheet.rows.forEach((raw, index) => {
    const row = index + 1
    const record = rowToRecord(sheet.headers, raw)
    const problems: RowProblem[] = []

    const number = cleanText(valueFor(record, columns, 'number'))
    const name = cleanText(valueFor(record, columns, 'name'))
    const typeRaw = valueFor(record, columns, 'type')

    if (number === '') {
      problems.push({ row, field: 'number', message: 'No account number.', severity: 'error' })
    }
    if (name === '') {
      problems.push({ row, field: 'name', message: 'No account name.', severity: 'error' })
    }

    const type = normalizeAccountType(typeRaw)
    if (!type) {
      problems.push({
        row,
        field: 'type',
        message:
          typeRaw.trim() === ''
            ? 'No account type.'
            : `“${cleanText(typeRaw)}” is not an account type this understands. Use asset, liability, equity, revenue, cost of goods sold, or expense.`,
        severity: 'error',
      })
    }

    // A number appearing twice in one file is a genuine ambiguity: the second
    // row would silently overwrite the first, and which one the user meant is
    // not knowable.
    const firstSeenAt = seenInFile.get(number)
    if (number !== '' && firstSeenAt !== undefined) {
      problems.push({
        row,
        field: 'number',
        message: `Account ${number} appears twice in this file — also at row ${firstSeenAt}.`,
        severity: 'error',
      })
    } else if (number !== '') {
      seenInFile.set(number, row)
    }

    const match = byNumber.get(number)

    // A system account is the books' own plumbing. Renaming it is allowed;
    // having its type changed by a file is not, because the application looks
    // these up by number and expects them to be what they are.
    if (match?.isSystem && type) {
      problems.push({
        row,
        message: `${number} ${match.name} is a system account. Its name will be updated and its type left alone.`,
        severity: 'warning',
      })
    }

    const parsed: PlannedAccount | null =
      number && name && type
        ? {
            number,
            name,
            type,
            subtype: cleanText(valueFor(record, columns, 'subtype')) || null,
            description: cleanText(valueFor(record, columns, 'description')) || null,
            existingId: match?.id,
            existingName: match?.name,
          }
        : null

    rows.push({
      row,
      parsed,
      action: parsed ? (match ? 'update' : 'create') : 'skip',
      problems,
    })
  })

  return finishPlan({
    headers: sheet.headers,
    columns,
    delimiter: sheet.delimiter,
    rows,
    fileProblems,
    blankRowsSkipped: sheet.blankRowsSkipped,
  })
}

export async function commitAccountImport(
  ctx: ActorContext,
  plan: ImportPlan<PlannedAccount>,
  meta: { fileName?: string } = {},
): Promise<{ runId: string; created: number; updated: number }> {
  requirePermission(ctx, 'accounting:journal')

  if (!plan.canCommit) throw new ImportNotReadyError(plan.counts.errors)

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        kind: 'chart_of_accounts',
        fileName: meta.fileName ?? null,
        headers: JSON.stringify(plan.headers),
        columnMapping: JSON.stringify(plan.columns),
        rowCount: plan.counts.total,
        createdCount: plan.counts.willCreate,
        updatedCount: plan.counts.willUpdate,
        skippedCount: plan.counts.willSkip,
        notes: JSON.stringify(
          summarizeProblems(plan.rows.flatMap((row) => row.problems)),
        ),
        createdBy: ctx.userId,
      })
      .returning({ id: importRuns.id })

    let created = 0
    let updated = 0

    for (const planned of plan.rows) {
      if (!planned.parsed) continue
      const account = planned.parsed

      if (account.existingId) {
        // Name and description only. Changing the type of an account that
        // already carries postings would silently move money between sections
        // of the profit and loss for every period ever reported.
        await tx
          .update(chartAccounts)
          .set({ name: account.name, description: account.description })
          .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, account.existingId)))

        await tx.insert(importRecords).values({
          companyId: ctx.companyId,
          importRunId: run.id,
          entityType: 'chart_account',
          entityId: account.existingId,
          action: 'updated',
          sourceRow: planned.row,
        })
        updated += 1
        continue
      }

      const [inserted] = await tx
        .insert(chartAccounts)
        .values({
          companyId: ctx.companyId,
          number: account.number,
          name: account.name,
          type: account.type,
          subtype: account.subtype,
          description: account.description,
          isSystem: false,
        })
        .returning({ id: chartAccounts.id })

      await tx.insert(importRecords).values({
        companyId: ctx.companyId,
        importRunId: run.id,
        entityType: 'chart_account',
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
        after: { kind: 'chart_of_accounts', created, updated, fileName: meta.fileName ?? null },
      },
      tx,
    )

    return { runId: run.id, created, updated }
  })
}
