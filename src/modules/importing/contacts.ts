import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { customers, importRecords, importRuns, vendors } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { readSheet, rowToRecord } from './csv'
import { cleanText, looksLikeEmail } from './coerce'
import { CONTACT_FIELDS, proposeMapping, valueFor } from './mapping'
import {
  finishPlan,
  ImportNotReadyError,
  summarizeProblems,
  type ImportPlan,
  type PlannedRow,
  type RowProblem,
} from './plan'

/** Importing customers and vendors (spec §20 Phase 8). */

export type ContactKind = 'customers' | 'vendors'

export type PlannedContact = {
  name: string
  email: string | null
  phone: string | null
  taxId: string | null
  addressLine1: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  existingId?: string
}

/**
 * Matching key for "is this the same customer".
 *
 * Case- and punctuation-insensitive, and it drops the common company suffixes,
 * because `Acme, Inc.` in the old system and `Acme Inc` typed in here are one
 * business — and importing both leaves two ledgers for one customer, each with
 * half the history.
 *
 * It stops well short of fuzzy matching. `Acme Northwest` and `Acme North West`
 * stay separate, because merging two real businesses that share a name prefix
 * is worse than a duplicate somebody can see and fix.
 */
export function contactKey(name: string): string {
  return cleanText(name)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|plc|gmbh|pty|pte)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function planContactImport(
  ctx: ActorContext,
  input: { kind: ContactKind; text: string; columns?: Record<string, string | null> },
): Promise<ImportPlan<PlannedContact>> {
  requirePermission(ctx, 'bookkeeping:categorize')

  const sheet = readSheet(input.text)
  const proposed = proposeMapping(sheet.headers, CONTACT_FIELDS)
  const columns = input.columns ?? proposed.columns

  const fileProblems: RowProblem[] = []
  if (!columns.name) {
    fileProblems.push({
      row: 0,
      field: 'name',
      message: 'No column is mapped to Name.',
      severity: 'error',
    })
  }

  const table = input.kind === 'customers' ? customers : vendors
  const existing = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(scoped(ctx, table))

  const byKey = new Map(existing.map((row) => [contactKey(row.name), row]))
  const seenInFile = new Map<string, number>()
  const rows: Array<PlannedRow<PlannedContact>> = []

  sheet.rows.forEach((raw, index) => {
    const row = index + 1
    const record = rowToRecord(sheet.headers, raw)
    const problems: RowProblem[] = []

    const name = cleanText(valueFor(record, columns, 'name'))
    if (name === '') {
      problems.push({ row, field: 'name', message: 'No name.', severity: 'error' })
    }

    const email = cleanText(valueFor(record, columns, 'email'))
    // A warning, not an error. Somebody who owes money is still somebody who
    // owes money, and dropping the row would lose the balance with it.
    if (email !== '' && !looksLikeEmail(email)) {
      problems.push({
        row,
        field: 'email',
        message: `“${email}” does not look like an email address. Imported anyway.`,
        severity: 'warning',
      })
    }

    const key = contactKey(name)
    const firstSeenAt = seenInFile.get(key)
    if (key !== '' && firstSeenAt !== undefined) {
      problems.push({
        row,
        field: 'name',
        message: `“${name}” appears twice in this file — also at row ${firstSeenAt}. Only the first will be imported.`,
        severity: 'warning',
      })
    } else if (key !== '') {
      seenInFile.set(key, row)
    }

    const match = key === '' ? undefined : byKey.get(key)
    const duplicateInFile = key !== '' && firstSeenAt !== undefined

    const parsed: PlannedContact | null =
      name === ''
        ? null
        : {
            name,
            email: email || null,
            phone: cleanText(valueFor(record, columns, 'phone')) || null,
            taxId: cleanText(valueFor(record, columns, 'taxId')) || null,
            addressLine1: cleanText(valueFor(record, columns, 'addressLine1')) || null,
            city: cleanText(valueFor(record, columns, 'city')) || null,
            region: cleanText(valueFor(record, columns, 'region')) || null,
            postalCode: cleanText(valueFor(record, columns, 'postalCode')) || null,
            existingId: match?.id,
          }

    rows.push({
      row,
      parsed,
      action: !parsed || duplicateInFile ? 'skip' : match ? 'update' : 'create',
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

export async function commitContactImport(
  ctx: ActorContext,
  kind: ContactKind,
  plan: ImportPlan<PlannedContact>,
  meta: { fileName?: string } = {},
): Promise<{ runId: string; created: number; updated: number }> {
  requirePermission(ctx, 'bookkeeping:categorize')

  if (!plan.canCommit) throw new ImportNotReadyError(plan.counts.errors)

  const table = kind === 'customers' ? customers : vendors

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        kind,
        fileName: meta.fileName ?? null,
        headers: JSON.stringify(plan.headers),
        columnMapping: JSON.stringify(plan.columns),
        rowCount: plan.counts.total,
        createdCount: plan.counts.willCreate,
        updatedCount: plan.counts.willUpdate,
        skippedCount: plan.counts.willSkip,
        notes: JSON.stringify(summarizeProblems(plan.rows.flatMap((row) => row.problems))),
        createdBy: ctx.userId,
      })
      .returning({ id: importRuns.id })

    let created = 0
    let updated = 0

    for (const planned of plan.rows) {
      if (!planned.parsed || planned.action === 'skip') continue
      const contact = planned.parsed

      const values = {
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        addressLine1: contact.addressLine1,
        city: contact.city,
        region: contact.region,
        postalCode: contact.postalCode,
      }

      if (contact.existingId) {
        // Only fills gaps. A file six months old should not blank out a phone
        // number somebody has since corrected in the application — the import
        // is the older source of truth here, not the newer one.
        await tx
          .update(table)
          .set({
            name: contact.name,
            email: sql`COALESCE(${table.email}, ${contact.email})`,
            phone: sql`COALESCE(${table.phone}, ${contact.phone})`,
            addressLine1: sql`COALESCE(${table.addressLine1}, ${contact.addressLine1})`,
            city: sql`COALESCE(${table.city}, ${contact.city})`,
            region: sql`COALESCE(${table.region}, ${contact.region})`,
            postalCode: sql`COALESCE(${table.postalCode}, ${contact.postalCode})`,
          })
          .where(scoped(ctx, table, eq(table.id, contact.existingId)))

        await tx.insert(importRecords).values({
          companyId: ctx.companyId,
          importRunId: run.id,
          entityType: kind === 'customers' ? 'customer' : 'vendor',
          entityId: contact.existingId,
          action: 'updated',
          sourceRow: planned.row,
        })
        updated += 1
        continue
      }

      const [inserted] = await tx
        .insert(table)
        .values({
          companyId: ctx.companyId,
          ...values,
          ...(kind === 'vendors' && contact.taxId ? { taxId: contact.taxId } : {}),
        })
        .returning({ id: table.id })

      await tx.insert(importRecords).values({
        companyId: ctx.companyId,
        importRunId: run.id,
        entityType: kind === 'customers' ? 'customer' : 'vendor',
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
        after: { kind, created, updated, fileName: meta.fileName ?? null },
      },
      tx,
    )

    return { runId: run.id, created, updated }
  })
}
