import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  customers,
  invoices,
  recurringInvoiceLines,
  recurringInvoiceOccurrences,
  recurringInvoices,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { createInvoice } from '@/modules/receivables/service'
import { functionalCurrency } from '@/modules/fx/service'
import { occurrenceCurrency } from './currency'
import { firstOccurrence, nextOccurrence, type Cadence } from '@/modules/ledger/recurring'
import { DomainError } from '@/modules/errors'

/**
 * Invoicing a customer every period (spec §13).
 *
 * ## The claim this module exists to make
 *
 * **A schedule is a promise to bill, not a bill.** Setting one up owes nobody
 * anything: no receivable, no revenue, nothing on a statement, nothing ageing.
 * An invoice appears when a period arrives and not before, and it appears
 * through Phase 2's `createInvoice` — so it ages, reaches a statement, gets a
 * PDF and can be paid, exactly like one somebody typed.
 *
 * That last part is the Phase 31 lesson, which cost a phase to learn: a module
 * that hand-posts `Dr AR / Cr Revenue` produces a receivable no aging report
 * knows about. Everything that bills a customer goes through the one door.
 */

export class BillingError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'BillingError'
  }
}

/**
 * How far a single run will catch up.
 *
 * Phase 11's bound, for its reason: a schedule eight months behind — a worker
 * that was down, a company that started using this today — should arrive in one
 * run rather than take eight daily ones, and a misconfigured schedule should
 * still not produce an unbounded loop.
 */
const MAX_CATCH_UP = 400

export type ScheduleLineInput = {
  chartAccountId: string
  description: string
  quantityMilli?: number
  unitPriceCents: number
}

export type ScheduleInput = {
  customerId: string
  name: string
  memo?: string
  cadence: Cadence
  /**
   * What this schedule bills in (Phase 126). Defaults to the company's own.
   *
   * Every other way of raising an invoice has offered this since Phase 64. A
   * schedule could not, so a European customer on a monthly retainer got dollar
   * invoices — or the schedule was switched off and twelve raised by hand.
   */
  currency?: string
  dayOfMonth?: number
  paymentTermsDays?: number
  autoRaise?: boolean
  startsOn: string
  endsOn?: string
  lines: ScheduleLineInput[]
}

function assertLines(lines: ScheduleLineInput[]) {
  if (lines.length === 0) {
    throw new BillingError('A billing schedule needs at least one line.')
  }

  for (const line of lines) {
    if (!Number.isInteger(line.unitPriceCents)) {
      throw new BillingError('A price has to be a whole number of cents.')
    }
    if (line.unitPriceCents < 0) {
      throw new BillingError(
        'A schedule bills positive amounts. To credit a customer, raise a credit note against ' +
          'the invoice it relates to.',
      )
    }
    if (line.quantityMilli !== undefined && line.quantityMilli <= 0) {
      throw new BillingError('A quantity has to be greater than zero.')
    }
    if (!line.description.trim()) {
      throw new BillingError('Every line needs a description — it is what the customer reads.')
    }
  }
}

/** What one occurrence of a schedule would bill. */
export function scheduleTotalCents(
  lines: Array<{ quantityMilli: number; unitPriceCents: number }>,
): number {
  return lines.reduce(
    (sum, line) => sum + Math.round((line.quantityMilli * line.unitPriceCents) / 1000),
    0,
  )
}

/** Sets up an arrangement to bill a customer every period. */
export async function createSchedule(ctx: ActorContext, input: ScheduleInput) {
  requirePermission(ctx, 'accounting:journal')

  const name = input.name.trim()
  if (!name) {
    throw new BillingError('A schedule needs a name. It is what somebody sees on the list.')
  }

  assertLines(input.lines)

  const dayOfMonth = input.dayOfMonth ?? 1
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw new BillingError(
      'Choose a day between the 1st and the 28th. "The 31st" is not a day every month has, and ' +
        'a schedule that silently skips February is worse than one that bills on the 28th.',
    )
  }

  if (input.endsOn && input.endsOn < input.startsOn) {
    throw new BillingError('A schedule cannot end before it starts.')
  }

  const [customer] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
    .limit(1)

  if (!customer) throw new BillingError('Customer not found.')

  const accountIds = [...new Set(input.lines.map((line) => line.chartAccountId))]
  const found = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))

  const known = new Set(found.map((row) => row.id))
  for (const id of accountIds) {
    if (!known.has(id)) {
      throw new BillingError('A line points at an account that is not in this company’s chart.')
    }
  }

  const nextRunOn = firstOccurrence(
    { cadence: input.cadence, dayOfMonth },
    input.startsOn,
  )

  return db.transaction(async (tx) => {
    const [schedule] = await tx
      .insert(recurringInvoices)
      .values({
        companyId: ctx.companyId,
        customerId: customer.id,
        name,
        currency: input.currency ?? (await functionalCurrency(ctx.companyId)),
        memo: input.memo?.trim() || null,
        cadence: input.cadence,
        dayOfMonth,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        autoRaise: input.autoRaise ?? false,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        nextRunOn,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(recurringInvoiceLines).values(
      input.lines.map((line, index) => ({
        companyId: ctx.companyId,
        recurringInvoiceId: schedule.id,
        chartAccountId: line.chartAccountId,
        description: line.description.trim(),
        quantityMilli: line.quantityMilli ?? 1000,
        unitPriceCents: line.unitPriceCents,
        sortOrder: index,
      })),
    )

    await recordAudit(
      ctx,
      {
        action: 'billing.schedule_create',
        entityType: 'recurring_invoice',
        entityId: schedule.id,
        after: {
          name,
          customer: customer.name,
          cadence: input.cadence,
          nextRunOn,
          autoRaise: schedule.autoRaise,
          perOccurrenceCents: scheduleTotalCents(
            input.lines.map((line) => ({
              quantityMilli: line.quantityMilli ?? 1000,
              unitPriceCents: line.unitPriceCents,
            })),
          ),
        },
      },
      tx,
    )

    return schedule
  })
}

/**
 * Switches a schedule on or off.
 *
 * Off rather than deleted: the invoices it raised are why last year's numbers
 * look the way they do, and a customer who cancels in March should leave a
 * record of having been billed January and February. **Stopping a schedule
 * unbills nothing.**
 */
export async function setScheduleActive(
  ctx: ActorContext,
  scheduleId: string,
  isActive: boolean,
) {
  requirePermission(ctx, 'accounting:journal')

  const [schedule] = await db
    .select()
    .from(recurringInvoices)
    .where(scoped(ctx, recurringInvoices, eq(recurringInvoices.id, scheduleId)))
    .limit(1)

  if (!schedule) throw new BillingError('Schedule not found.')
  if (schedule.isActive === isActive) return schedule

  // Restarting a schedule that fell behind while it was off starts from today
  // rather than replaying the months nobody billed. Catching up automatically
  // would send a customer four invoices the morning somebody flipped a switch.
  const today = new Date().toISOString().slice(0, 10)
  const resumeFrom =
    isActive && schedule.nextRunOn < today
      ? firstOccurrence({ cadence: schedule.cadence, dayOfMonth: schedule.dayOfMonth }, today)
      : schedule.nextRunOn

  const [updated] = await db
    .update(recurringInvoices)
    .set({ isActive, nextRunOn: resumeFrom, updatedAt: new Date() })
    .where(eq(recurringInvoices.id, schedule.id))
    .returning()

  await recordAudit(ctx, {
    action: isActive ? 'billing.schedule_resume' : 'billing.schedule_pause',
    entityType: 'recurring_invoice',
    entityId: schedule.id,
    before: { isActive: schedule.isActive, nextRunOn: schedule.nextRunOn },
    after: { isActive, nextRunOn: resumeFrom },
  })

  return updated
}

export type RunResult = {
  scheduleId: string
  name: string
  customerName: string
  occurredOn: string
  invoiceId: string | null
  invoiceNumber: string | null
  totalCents: number
  /** What the schedule billed in (Phase 126) — the face amount's denomination. */
  currency: string
  raised: boolean
  /**
   * Whether this run wrote the occurrence row — i.e. whether the period is now
   * accounted for.
   *
   * Distinct from `raised` on purpose. A schedule that waits for a person
   * *claims* its period without invoicing it, and the catch-up loop has to tell
   * that apart from a genuine stop: treating "waiting for somebody" as a stop
   * meant a quarterly arrangement nobody attended to silently stopped claiming
   * periods altogether, so the second overdue quarter was never billed and
   * never appeared anywhere. Browser verification found it.
   */
  claimed: boolean
  skipped?: string
}

/**
 * Raises every invoice that has fallen due, up to a date.
 *
 * Idempotent by construction: the occurrence row is written *first*, inside the
 * same transaction as the invoice, so a second run hits the unique constraint
 * and does nothing rather than billing December twice.
 */
export async function runDueSchedules(
  ctx: ActorContext,
  asOfDate: string,
): Promise<RunResult[]> {
  requirePermission(ctx, 'accounting:journal')

  const due = await db
    .select()
    .from(recurringInvoices)
    .where(
      scoped(
        ctx,
        recurringInvoices,
        eq(recurringInvoices.isActive, true),
        lte(recurringInvoices.nextRunOn, asOfDate),
      ),
    )
    .orderBy(asc(recurringInvoices.nextRunOn))

  const results: RunResult[] = []

  for (const schedule of due) {
    let current = schedule
    let produced = 0

    while (produced < MAX_CATCH_UP) {
      if (!current.isActive || current.nextRunOn > asOfDate) break

      // A schedule past its end date stops rather than being deleted: its
      // history is the record of a contract that ran and finished.
      if (current.endsOn && current.nextRunOn > current.endsOn) {
        await db
          .update(recurringInvoices)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(recurringInvoices.id, current.id))

        results.push({
          scheduleId: current.id,
          name: current.name,
          customerName: '',
          occurredOn: current.nextRunOn,
          invoiceId: null,
          invoiceNumber: null,
          totalCents: 0,
          currency: current.currency,
          raised: false,
          claimed: false,
          skipped: 'Past its end date — switched off.',
        })
        break
      }

      try {
        const result = await runOneOccurrence(ctx, current)
        results.push(result)

        // Stop only when the period was *not* claimed — "already billed for
        // this date" means a concurrent worker got there first, and stopping
        // keeps two workers from racing round this loop. A period claimed and
        // left for a person is progress, not a stop, and continuing is what
        // makes a second overdue quarter appear on the work list.
        if (!result.claimed) break
      } catch (error) {
        results.push({
          scheduleId: current.id,
          name: current.name,
          customerName: '',
          occurredOn: current.nextRunOn,
          invoiceId: null,
          invoiceNumber: null,
          totalCents: 0,
          currency: current.currency,
          raised: false,
          claimed: false,
          skipped: error instanceof Error ? error.message : String(error),
        })
        break
      }

      produced += 1

      const [reloaded] = await db
        .select()
        .from(recurringInvoices)
        .where(eq(recurringInvoices.id, current.id))
        .limit(1)

      if (!reloaded) break
      current = reloaded
    }
  }

  return results
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function runOneOccurrence(
  ctx: ActorContext,
  schedule: typeof recurringInvoices.$inferSelect,
): Promise<RunResult> {
  const lines = await db
    .select()
    .from(recurringInvoiceLines)
    .where(eq(recurringInvoiceLines.recurringInvoiceId, schedule.id))
    .orderBy(asc(recurringInvoiceLines.sortOrder))

  const [customer] = await db
    .select({ name: customers.name })
    .from(customers)
    .where(eq(customers.id, schedule.customerId))
    .limit(1)

  const customerName = customer?.name ?? ''
  const occurredOn = schedule.nextRunOn
  const totalCents = scheduleTotalCents(lines)

  const advance = async () => {
    await db
      .update(recurringInvoices)
      .set({
        lastRunOn: occurredOn,
        nextRunOn: nextOccurrence(
          { cadence: schedule.cadence, dayOfMonth: schedule.dayOfMonth },
          occurredOn,
        ),
        occurrenceCount: schedule.occurrenceCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(recurringInvoices.id, schedule.id))
  }

  // A schedule with no lines, or one that would bill nothing, raises nothing.
  // An invoice for $0.00 is a document a customer has to read to discover it
  // says nothing, and it ages on a report as though it mattered.
  if (lines.length === 0 || totalCents === 0) {
    const [occurrence] = await db
      .insert(recurringInvoiceOccurrences)
      .values({
        companyId: ctx.companyId,
        recurringInvoiceId: schedule.id,
        occurredOn,
        wasRaised: false,
        totalCents: 0,
        currency: schedule.currency,
      })
      .onConflictDoNothing({
        target: [
          recurringInvoiceOccurrences.recurringInvoiceId,
          recurringInvoiceOccurrences.occurredOn,
        ],
      })
      .returning()

    if (occurrence) await advance()

    return {
      scheduleId: schedule.id,
      name: schedule.name,
      customerName,
      occurredOn,
      invoiceId: null,
      invoiceNumber: null,
      totalCents: 0,
      currency: schedule.currency,
      raised: false,
      claimed: Boolean(occurrence),
      skipped: occurrence
        ? 'Nothing to bill — no invoice raised.'
        : 'Already billed for this date.',
    }
  }

  return db.transaction(async (tx) => {
    // The occurrence goes in first, so the unique constraint arbitrates a
    // concurrent second run rather than a read-then-write both would pass.
    const [occurrence] = await tx
      .insert(recurringInvoiceOccurrences)
      .values({
        companyId: ctx.companyId,
        recurringInvoiceId: schedule.id,
        occurredOn,
        currency: schedule.currency,
        wasRaised: schedule.autoRaise,
        totalCents,
      })
      .onConflictDoNothing({
        target: [
          recurringInvoiceOccurrences.recurringInvoiceId,
          recurringInvoiceOccurrences.occurredOn,
        ],
      })
      .returning()

    if (!occurrence) {
      return {
        scheduleId: schedule.id,
        name: schedule.name,
        customerName,
        occurredOn,
        invoiceId: null,
        invoiceNumber: null,
        totalCents: 0,
        currency: schedule.currency,
        raised: false,
        claimed: false,
        skipped: 'Already billed for this date.',
      }
    }

    // Not auto-raise: the period is claimed so it cannot be billed twice, and
    // the invoice waits for a person. The claim is the point — otherwise a
    // schedule somebody is reviewing would be offered again tomorrow.
    if (!schedule.autoRaise) {
      await tx
        .update(recurringInvoices)
        .set({
          lastRunOn: occurredOn,
          nextRunOn: nextOccurrence(
            { cadence: schedule.cadence, dayOfMonth: schedule.dayOfMonth },
            occurredOn,
          ),
          occurrenceCount: schedule.occurrenceCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(recurringInvoices.id, schedule.id))

      return {
        scheduleId: schedule.id,
        name: schedule.name,
        customerName,
        occurredOn,
        invoiceId: null,
        invoiceNumber: null,
        totalCents,
        currency: schedule.currency,
        raised: false,
        claimed: true,
        skipped: 'Waiting for somebody to raise it.',
      }
    }

    const invoice = await raiseInvoiceFor(ctx, schedule, lines, occurredOn, tx)

    await tx
      .update(recurringInvoiceOccurrences)
      .set({ invoiceId: invoice.id })
      .where(eq(recurringInvoiceOccurrences.id, occurrence.id))

    await tx
      .update(recurringInvoices)
      .set({
        lastRunOn: occurredOn,
        nextRunOn: nextOccurrence(
          { cadence: schedule.cadence, dayOfMonth: schedule.dayOfMonth },
          occurredOn,
        ),
        occurrenceCount: schedule.occurrenceCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(recurringInvoices.id, schedule.id))

    return {
      scheduleId: schedule.id,
      name: schedule.name,
      customerName,
      occurredOn,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      totalCents,
      currency: schedule.currency,
      raised: true,
      claimed: true,
    }
  })
}

/**
 * The one place a schedule becomes a document.
 *
 * Through `createInvoice`, not a hand-rolled `Dr AR / Cr Revenue` — so what it
 * bills ages, appears on a statement, gets a PDF and can be paid (Phase 31).
 */
async function raiseInvoiceFor(
  ctx: ActorContext,
  schedule: typeof recurringInvoices.$inferSelect,
  lines: Array<typeof recurringInvoiceLines.$inferSelect>,
  occurredOn: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  return createInvoice(
    ctx,
    {
      customerId: schedule.customerId,
      // Phase 126. Until this, a schedule raised the company's currency
      // whatever the customer trades in — the one invoice path that could not
      // be foreign.
      currency: schedule.currency,
      issueDate: occurredOn,
      dueDate: addDays(occurredOn, schedule.paymentTermsDays),
      memo: schedule.memo ?? schedule.name,
      lines: lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
      })),
    },
    tx,
  )
}

/**
 * Raises the invoice for an occurrence that was left for a person.
 *
 * The counterpart to `autoRaise: false`. The period was already claimed when
 * the run reached it, so this cannot double-bill; what it does is turn a
 * claimed period into the document it was always going to be.
 */
export async function raiseOccurrence(ctx: ActorContext, occurrenceId: string) {
  requirePermission(ctx, 'accounting:journal')

  const [occurrence] = await db
    .select()
    .from(recurringInvoiceOccurrences)
    .where(
      scoped(ctx, recurringInvoiceOccurrences, eq(recurringInvoiceOccurrences.id, occurrenceId)),
    )
    .limit(1)

  if (!occurrence) throw new BillingError('That billing period is not on record.')
  if (occurrence.invoiceId) {
    throw new BillingError('That period has already been invoiced.')
  }

  const [schedule] = await db
    .select()
    .from(recurringInvoices)
    .where(eq(recurringInvoices.id, occurrence.recurringInvoiceId))
    .limit(1)

  if (!schedule) throw new BillingError('Schedule not found.')

  const lines = await db
    .select()
    .from(recurringInvoiceLines)
    .where(eq(recurringInvoiceLines.recurringInvoiceId, schedule.id))
    .orderBy(asc(recurringInvoiceLines.sortOrder))

  if (lines.length === 0) {
    throw new BillingError('That schedule has no lines to bill.')
  }

  return db.transaction(async (tx) => {
    const invoice = await raiseInvoiceFor(ctx, schedule, lines, occurrence.occurredOn, tx)

    await tx
      .update(recurringInvoiceOccurrences)
      .set({
        invoiceId: invoice.id,
        wasRaised: true,
        totalCents: scheduleTotalCents(lines),
      })
      .where(eq(recurringInvoiceOccurrences.id, occurrence.id))

    await recordAudit(
      ctx,
      {
        action: 'billing.occurrence_raise',
        entityType: 'recurring_invoice',
        entityId: schedule.id,
        after: { occurredOn: occurrence.occurredOn, invoice: invoice.number },
      },
      tx,
    )

    return invoice
  })
}

export type ScheduleRow = {
  id: string
  name: string
  customerId: string
  customerName: string
  cadence: Cadence
  dayOfMonth: number
  autoRaise: boolean
  isActive: boolean
  startsOn: string
  endsOn: string | null
  nextRunOn: string
  lastRunOn: string | null
  occurrenceCount: number
  perOccurrenceCents: number
  /** What it bills in (Phase 126). Fixed when the schedule was set up. */
  currency: string
}

/** Every schedule, with what one occurrence of it bills. */
export async function listSchedules(ctx: ActorContext): Promise<ScheduleRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: recurringInvoices.id,
      name: recurringInvoices.name,
      customerId: recurringInvoices.customerId,
      customerName: customers.name,
      cadence: recurringInvoices.cadence,
      dayOfMonth: recurringInvoices.dayOfMonth,
      autoRaise: recurringInvoices.autoRaise,
      isActive: recurringInvoices.isActive,
      startsOn: recurringInvoices.startsOn,
      endsOn: recurringInvoices.endsOn,
      nextRunOn: recurringInvoices.nextRunOn,
      lastRunOn: recurringInvoices.lastRunOn,
      occurrenceCount: recurringInvoices.occurrenceCount,
      currency: recurringInvoices.currency,
      perOccurrenceCents: sql<string>`coalesce(sum(
        round(${recurringInvoiceLines.quantityMilli} * ${recurringInvoiceLines.unitPriceCents} / 1000.0)
      ), 0)`,
    })
    .from(recurringInvoices)
    .innerJoin(customers, eq(customers.id, recurringInvoices.customerId))
    .leftJoin(
      recurringInvoiceLines,
      eq(recurringInvoiceLines.recurringInvoiceId, recurringInvoices.id),
    )
    .where(scoped(ctx, recurringInvoices))
    .groupBy(recurringInvoices.id, customers.name)
    .orderBy(desc(recurringInvoices.isActive), asc(recurringInvoices.nextRunOn))

  return rows.map((row) => ({ ...row, perOccurrenceCents: Number(row.perOccurrenceCents) }))
}

/** A schedule, its lines, and everything it has billed. */
export async function scheduleDetail(ctx: ActorContext, scheduleId: string) {
  requirePermission(ctx, 'accounting:view')

  const [schedule] = await db
    .select()
    .from(recurringInvoices)
    .where(scoped(ctx, recurringInvoices, eq(recurringInvoices.id, scheduleId)))
    .limit(1)

  if (!schedule) throw new BillingError('Schedule not found.')

  const [lines, history] = await Promise.all([
    db
      .select()
      .from(recurringInvoiceLines)
      .where(eq(recurringInvoiceLines.recurringInvoiceId, schedule.id))
      .orderBy(asc(recurringInvoiceLines.sortOrder)),
    db
      .select({
        id: recurringInvoiceOccurrences.id,
        occurredOn: recurringInvoiceOccurrences.occurredOn,
        wasRaised: recurringInvoiceOccurrences.wasRaised,
        totalCents: recurringInvoiceOccurrences.totalCents,
        invoiceId: recurringInvoiceOccurrences.invoiceId,
        invoiceNumber: invoices.number,
        invoiceStatus: invoices.status,
        balanceCents: invoices.balanceCents,
        // `balance_cents` is the face column and this history is where somebody
        // reads what a schedule has billed (Phase 125).
        //
        // Phase 125's comment here claimed "a schedule billing a customer in
        // euros raises euro invoices". It could not: until Phase 126 a schedule
        // had no currency and always raised the company's. The column was right
        // and the reason given for it was wrong — it matters now because a
        // schedule can finally be foreign.
        invoiceCurrency: invoices.currency,
        occurrenceCurrency: recurringInvoiceOccurrences.currency,
      })
      .from(recurringInvoiceOccurrences)
      .leftJoin(invoices, eq(invoices.id, recurringInvoiceOccurrences.invoiceId))
      .where(eq(recurringInvoiceOccurrences.recurringInvoiceId, schedule.id))
      .orderBy(desc(recurringInvoiceOccurrences.occurredOn)),
  ])

  const home = await functionalCurrency(ctx.companyId)

  return {
    schedule,
    lines,
    // Phase 126. The invoice's currency where one was raised, the occurrence's
    // otherwise — a fact beats an intention, and both beat the default.
    history: history.map((row) => ({
      ...row,
      currency: occurrenceCurrency(row.invoiceCurrency, row.occurrenceCurrency, home),
    })),
    perOccurrenceCents: scheduleTotalCents(lines),
  }
}

export { firstOccurrence, nextOccurrence } from '@/modules/ledger/recurring'
export type { Cadence } from '@/modules/ledger/recurring'
