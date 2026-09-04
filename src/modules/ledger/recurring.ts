import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  recurringEntries,
  recurringEntryLines,
  recurringOccurrences,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { createJournalEntry } from '@/modules/ledger/journal'
import { formatCents } from '@/lib/money'
import { Refusal } from '@/modules/errors'

/**
 * Recurring journal entries (spec §13: "recurring entries").
 *
 * Listed in §13 from the beginning and impossible until Phase 10: a recurring
 * entry is a template plus a clock, and without the clock it is a template
 * nobody uses. The clock exists now, so this is the template.
 *
 * ## Posting is a choice the template makes, once
 *
 * `autoPost` decides whether an occurrence posts or waits as a draft, and the
 * distinction is Phase 10's, applied here. A monthly rent accrual is the same
 * number every month and safe to post unattended. A depreciation estimate or
 * an accrual that moves with volume is not, and a template that posts one
 * anyway fills a ledger with figures nobody checked.
 *
 * Defaulting to **draft** is deliberate: the safe default is the one where a
 * mistake is caught by a person rather than found in a year-end review.
 */

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annually'

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every quarter',
  annually: 'Every year',
}

export type RecurringLineInput = {
  chartAccountId: string
  debitCents?: number
  creditCents?: number
  memo?: string
}

export type RecurringEntryInput = {
  name: string
  memo?: string
  cadence: Cadence
  dayOfMonth?: number
  autoPost?: boolean
  startsOn: string
  endsOn?: string
  lines: RecurringLineInput[]
}

/**
 * The next date after `after`, on the template's cadence.
 *
 * Pure, in UTC, and **strictly after** — the same property Phase 10's scheduler
 * needed and for the same reason: a next-run equal to now gives a template that
 * fires forever, because every check computes a date that has already passed.
 *
 * `dayOfMonth` is capped at 28 by a database CHECK rather than clamped here.
 * "The 31st" in February has three defensible answers and picking one silently
 * is how a monthly entry posts eleven times a year.
 */
export function nextOccurrence(
  spec: { cadence: Cadence; dayOfMonth?: number },
  after: string,
): string {
  const day = spec.dayOfMonth ?? 1
  const date = new Date(`${after}T00:00:00Z`)

  if (spec.cadence === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7)
    return date.toISOString().slice(0, 10)
  }

  const monthsAhead = spec.cadence === 'monthly' ? 1 : spec.cadence === 'quarterly' ? 3 : 12

  // Set the day *after* moving the month, and from the 1st, so a rollover from
  // a long month cannot skip one: the 31st of January plus a month is the 31st
  // of February, which resolves to March.
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsAhead, 1),
  )
  next.setUTCDate(day)

  return next.toISOString().slice(0, 10)
}

/** The first occurrence on or after a start date. */
export function firstOccurrence(
  spec: { cadence: Cadence; dayOfMonth?: number },
  startsOn: string,
): string {
  if (spec.cadence === 'weekly') return startsOn

  const day = spec.dayOfMonth ?? 1
  const start = new Date(`${startsOn}T00:00:00Z`)

  const candidate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  candidate.setUTCDate(day)

  if (candidate.toISOString().slice(0, 10) >= startsOn) {
    return candidate.toISOString().slice(0, 10)
  }

  return nextOccurrence(spec, candidate.toISOString().slice(0, 10))
}

/** Validates a template's lines by the same rule the journal engine applies. */
function assertBalanced(lines: RecurringLineInput[]): number {
  if (lines.length < 2) {
    throw new Refusal('A journal entry needs at least two lines.')
  }

  let debits = 0
  let credits = 0

  for (const line of lines) {
    const debit = line.debitCents ?? 0
    const credit = line.creditCents ?? 0

    if (debit < 0 || credit < 0) throw new Refusal('Amounts cannot be negative.')
    if ((debit === 0) === (credit === 0)) {
      throw new Refusal('Each line is either a debit or a credit, never both and never neither.')
    }

    debits += debit
    credits += credit
  }

  if (debits !== credits) {
    // Checked when the template is saved rather than when it first fires, so a
    // broken template is a failed save instead of a failed job at 2am.
    throw new Refusal(
      `This template does not balance: ${formatCents(debits)} of debits against ` +
        `${formatCents(credits)} of credits.`,
    )
  }

  return debits
}

export async function createRecurringEntry(ctx: ActorContext, input: RecurringEntryInput) {
  requirePermission(ctx, 'accounting:journal')

  if (!input.name.trim()) throw new Refusal('A recurring entry needs a name.')

  const totalCents = assertBalanced(input.lines)

  const accountIds = [...new Set(input.lines.map((line) => line.chartAccountId))]
  const found = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.id, accountIds)))

  if (found.length !== accountIds.length) {
    throw new Refusal('One or more accounts are not on this company’s chart.')
  }

  const nextRunOn = firstOccurrence(input, input.startsOn)

  return db.transaction(async (tx) => {
    const [template] = await tx
      .insert(recurringEntries)
      .values({
        companyId: ctx.companyId,
        name: input.name.trim(),
        memo: input.memo ?? null,
        cadence: input.cadence,
        dayOfMonth: input.dayOfMonth ?? 1,
        autoPost: input.autoPost ?? false,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        nextRunOn,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(recurringEntryLines).values(
      input.lines.map((line, index) => ({
        companyId: ctx.companyId,
        recurringEntryId: template.id,
        chartAccountId: line.chartAccountId,
        debitCents: line.debitCents ?? 0,
        creditCents: line.creditCents ?? 0,
        memo: line.memo ?? null,
        sortOrder: index,
      })),
    )

    await recordAudit(
      ctx,
      {
        action: 'recurring.create',
        entityType: 'recurring_entry',
        entityId: template.id,
        after: {
          name: template.name,
          cadence: template.cadence,
          autoPost: template.autoPost,
          totalCents,
          nextRunOn,
        },
      },
      tx,
    )

    return template
  })
}

export async function setRecurringActive(
  ctx: ActorContext,
  templateId: string,
  isActive: boolean,
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await db.transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(recurringEntries)
      .where(scoped(ctx, recurringEntries, eq(recurringEntries.id, templateId)))
      .limit(1)

    if (!template) throw new Error('Recurring entry not found')

    await tx
      .update(recurringEntries)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(recurringEntries.id, templateId))

    await recordAudit(
      ctx,
      {
        action: 'recurring.update',
        entityType: 'recurring_entry',
        entityId: templateId,
        before: { isActive: template.isActive },
        after: { isActive },
      },
      tx,
    )
  })
}

export type RunResult = {
  templateId: string
  name: string
  occurredOn: string
  journalEntryId: string | null
  posted: boolean
  skipped?: string
}

/**
 * Materializes every template due on or before a date.
 *
 * ## Running twice is free
 *
 * `recurring_occurrences` has a unique constraint on (template, date), written
 * inside the same transaction as the entry it describes. Two workers firing the
 * same template on the same day means the second insert fails, its transaction
 * rolls back, and no entry of its survives — the same mechanism Phase 8 used
 * for idempotency keys, and it is what lets Phase 10's at-least-once queue call
 * this safely.
 */
export async function runDueRecurringEntries(
  ctx: ActorContext,
  asOfDate: string,
): Promise<RunResult[]> {
  requirePermission(ctx, 'accounting:journal')

  const due = await db
    .select()
    .from(recurringEntries)
    .where(
      scoped(
        ctx,
        recurringEntries,
        eq(recurringEntries.isActive, true),
        lte(recurringEntries.nextRunOn, asOfDate),
      ),
    )
    .orderBy(asc(recurringEntries.nextRunOn))

  const results: RunResult[] = []

  for (const template of due) {
    // Catch up fully rather than one occurrence per call. A template eight
    // months behind — a worker that was down, or a company that started using
    // this today — would otherwise take eight daily runs to arrive, posting
    // January's rent in August. Bounded so a misconfigured template cannot
    // produce an unbounded run.
    let current = template
    let produced = 0

    while (produced < MAX_CATCH_UP) {
      if (!current.isActive || current.nextRunOn > asOfDate) break
      // A template whose end date has passed stops rather than being deleted:
      // its history is why last year's numbers look the way they do.
      if (current.endsOn && current.nextRunOn > current.endsOn) {
        await db
          .update(recurringEntries)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(recurringEntries.id, current.id))

        results.push({
          templateId: current.id,
          name: current.name,
          occurredOn: current.nextRunOn,
          journalEntryId: null,
          posted: false,
          skipped: 'Past its end date — switched off.',
        })
        break
      }

      try {
        const result = await runOneOccurrence(ctx, current)
        results.push(result)

        // "Already run for this date" means a concurrent worker got there
        // first; stopping avoids two workers racing round this loop together.
        if (result.skipped) break
      } catch (error) {
        results.push({
          templateId: current.id,
          name: current.name,
          occurredOn: current.nextRunOn,
          journalEntryId: null,
          posted: false,
          skipped: error instanceof Error ? error.message : String(error),
        })

        // Advance anyway. A template that fails on a closed period would
        // otherwise retry the same date forever and never reach the next one.
        await db
          .update(recurringEntries)
          .set({
            nextRunOn: nextOccurrence(
              { cadence: current.cadence, dayOfMonth: current.dayOfMonth },
              current.nextRunOn,
            ),
            updatedAt: new Date(),
          })
          .where(eq(recurringEntries.id, current.id))
      }

      produced++

      const [refreshed] = await db
        .select()
        .from(recurringEntries)
        .where(eq(recurringEntries.id, current.id))
        .limit(1)

      if (!refreshed) break
      current = refreshed
    }
  }

  return results
}

/**
 * How many occurrences one call will produce for a single template.
 *
 * A weekly template started five years ago is 260 occurrences, which is a
 * legitimate catch-up. Beyond that something is wrong with the template rather
 * than with the clock, and posting a thousand entries is a worse outcome than
 * stopping and being noticed.
 */
const MAX_CATCH_UP = 400

async function runOneOccurrence(
  ctx: ActorContext,
  template: typeof recurringEntries.$inferSelect,
): Promise<RunResult> {
  const lines = await db
    .select()
    .from(recurringEntryLines)
    .where(eq(recurringEntryLines.recurringEntryId, template.id))
    .orderBy(asc(recurringEntryLines.sortOrder))

  const occurredOn = template.nextRunOn

  return db.transaction(async (tx) => {
    // The occurrence row goes in *first*, inside this transaction, so the
    // unique constraint arbitrates a concurrent second run rather than a
    // read-then-write both of them would pass.
    const [occurrence] = await tx
      .insert(recurringOccurrences)
      .values({
        companyId: ctx.companyId,
        recurringEntryId: template.id,
        occurredOn,
        wasPosted: template.autoPost,
      })
      .onConflictDoNothing({
        target: [recurringOccurrences.recurringEntryId, recurringOccurrences.occurredOn],
      })
      .returning()

    if (!occurrence) {
      return {
        templateId: template.id,
        name: template.name,
        occurredOn,
        journalEntryId: null,
        posted: false,
        skipped: 'Already run for this date.',
      }
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: occurredOn,
        memo: template.memo ?? template.name,
        source: 'adjusting',
        sourceType: 'recurring_entry',
        sourceId: template.id,
        status: template.autoPost ? 'posted' : 'draft',
        lines: lines.map((line) => ({
          chartAccountId: line.chartAccountId,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
          memo: line.memo ?? undefined,
        })),
      },
      tx,
    )

    await tx
      .update(recurringOccurrences)
      .set({ journalEntryId: entry.id })
      .where(eq(recurringOccurrences.id, occurrence.id))

    await tx
      .update(recurringEntries)
      .set({
        lastRunOn: occurredOn,
        nextRunOn: nextOccurrence(
          { cadence: template.cadence, dayOfMonth: template.dayOfMonth },
          occurredOn,
        ),
        occurrenceCount: template.occurrenceCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(recurringEntries.id, template.id))

    return {
      templateId: template.id,
      name: template.name,
      occurredOn,
      journalEntryId: entry.id,
      posted: template.autoPost,
    }
  })
}

// --- Queries ---------------------------------------------------------------

export async function listRecurringEntries(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(recurringEntries)
    .where(scoped(ctx, recurringEntries))
    .orderBy(asc(recurringEntries.nextRunOn))
}

export async function recurringEntryDetail(ctx: ActorContext, templateId: string) {
  requirePermission(ctx, 'accounting:view')

  const [template] = await db
    .select()
    .from(recurringEntries)
    .where(scoped(ctx, recurringEntries, eq(recurringEntries.id, templateId)))
    .limit(1)

  if (!template) return null

  const [lines, occurrences] = await Promise.all([
    db
      .select({
        id: recurringEntryLines.id,
        chartAccountId: recurringEntryLines.chartAccountId,
        number: chartAccounts.number,
        name: chartAccounts.name,
        debitCents: recurringEntryLines.debitCents,
        creditCents: recurringEntryLines.creditCents,
        memo: recurringEntryLines.memo,
      })
      .from(recurringEntryLines)
      .innerJoin(chartAccounts, eq(chartAccounts.id, recurringEntryLines.chartAccountId))
      .where(eq(recurringEntryLines.recurringEntryId, templateId))
      .orderBy(asc(recurringEntryLines.sortOrder)),

    db
      .select()
      .from(recurringOccurrences)
      .where(eq(recurringOccurrences.recurringEntryId, templateId))
      .orderBy(sql`${recurringOccurrences.occurredOn} DESC`)
      .limit(24),
  ])

  return { template, lines, occurrences }
}
