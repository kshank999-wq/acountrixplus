import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billableExpenses,
  customers,
  invoices,
  projects,
  refunds,
  retainerApplications,
  retainers,
  timeEntries,
  users,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createInvoice, type DocumentLineInput } from '@/modules/receivables/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { amountForMinutes, minutesToQuantityMilli } from './rates'
import { rateForEntry } from './service'
import { relieveFunctional } from '@/modules/fx/documents'
import { settleHeld } from '@/modules/fx/settlement'
import { drawableAgainst } from '@/modules/fx/denomination'
import { mayUse } from '@/modules/receivables/overpayment'
import { convert, ensureFxAccount, functionalCurrency, normalise, rateFor } from '@/modules/fx/service'
import { DomainError, Refusal } from '@/modules/errors'
import { balanceForAccount } from '@/modules/ledger/balances'
import { heldAcrossAt, type Position } from './retainer-position'

/**
 * Turning recorded work into an invoice (spec §5).
 *
 * ## An hour is billed once, or not at all
 *
 * This is the phase's whole claim, and the enforcement is one detail: the
 * update that marks time billed carries its own precondition.
 *
 * ```sql
 *   UPDATE time_entries SET status = 'billed', invoice_id = $1
 *    WHERE id = ANY($2) AND status = 'approved' AND invoice_id IS NULL
 * ```
 *
 * Two partners billing the same engagement at the same moment both read the
 * same unbilled rows and both build an invoice. Only one update matches; the
 * other affects fewer rows than it selected, throws, and **its whole invoice
 * rolls back** — because the update runs inside the invoice's own transaction.
 * The client is charged once.
 *
 * A read-then-write would have both invoices commit and the second one arrive
 * at a client who has already paid. This is the same reasoning as the deposit
 * uniqueness index in Phase 12 and the stock relief in Phase 14: where two
 * people can act at once, the database arbitrates.
 *
 * ## Grouping is a presentation choice, not an accounting one
 *
 * Every entry is billed at its own resolved rate and the line amounts are the
 * sum of those. Grouping only decides how many lines the client sees — one per
 * person, one per day, or one line for the lot — and switching it can never
 * change the total, because the total was computed before the grouping was.
 */

export type BillingGrouping = 'person' | 'day' | 'service' | 'single'

// Labels live in `vocabulary.ts`, which imports nothing, so the billing
// screen can name a grouping without pulling the database into the browser.
export { GROUPING_LABELS } from './vocabulary'

export type BillableTimeRow = {
  id: string
  userId: string
  personName: string
  workedOn: string
  minutes: number
  description: string
  serviceItemId: string | null
  rateCents: number
  amountCents: number
  rateSource: string
}

export type BillingPreview = {
  projectId: string | null
  projectName: string
  time: BillableTimeRow[]
  expenses: Array<{ id: string; incurredOn: string; description: string; billableCents: number }>
  timeCents: number
  expenseCents: number
  totalCents: number
}

/**
 * What would be billed, priced, without writing anything.
 *
 * The same rate resolution the invoice will use — `rateForEntry`, once — so
 * the preview and the document cannot disagree. Two implementations of a
 * fallback chain is exactly how they come to.
 */
export async function previewBilling(
  ctx: ActorContext,
  opts: { projectId: string; throughDate?: string },
): Promise<BillingPreview> {
  requirePermission(ctx, 'accounting:view')

  const [project] = await db
    .select()
    .from(projects)
    .where(scoped(ctx, projects, eq(projects.id, opts.projectId)))
    .limit(1)

  if (!project) throw new Error('Engagement not found')

  const timeRows = await db
    .select({
      id: timeEntries.id,
      userId: timeEntries.userId,
      personName: users.name,
      workedOn: timeEntries.workedOn,
      minutes: timeEntries.minutes,
      description: timeEntries.description,
      serviceItemId: timeEntries.serviceItemId,
      rateCents: timeEntries.rateCents,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .where(
      scoped(
        ctx,
        timeEntries,
        eq(timeEntries.projectId, opts.projectId),
        eq(timeEntries.status, 'approved'),
        eq(timeEntries.isBillable, true),
        isNull(timeEntries.invoiceId),
        opts.throughDate ? lte(timeEntries.workedOn, opts.throughDate) : undefined,
      ),
    )
    .orderBy(asc(timeEntries.workedOn))

  const time: BillableTimeRow[] = []
  for (const row of timeRows) {
    const rate = await rateForEntry(ctx, {
      userId: row.userId,
      projectId: opts.projectId,
      serviceItemId: row.serviceItemId,
      rateCents: row.rateCents,
    })

    time.push({
      id: row.id,
      userId: row.userId,
      personName: row.personName,
      workedOn: row.workedOn,
      minutes: row.minutes,
      description: row.description,
      serviceItemId: row.serviceItemId,
      rateCents: rate.rateCents,
      amountCents: amountForMinutes(row.minutes, rate.rateCents),
      rateSource: rate.source,
    })
  }

  const expenses = await db
    .select({
      id: billableExpenses.id,
      incurredOn: billableExpenses.incurredOn,
      description: billableExpenses.description,
      billableCents: billableExpenses.billableCents,
    })
    .from(billableExpenses)
    .where(
      scoped(
        ctx,
        billableExpenses,
        eq(billableExpenses.projectId, opts.projectId),
        eq(billableExpenses.status, 'unbilled'),
        isNull(billableExpenses.invoiceId),
        opts.throughDate ? lte(billableExpenses.incurredOn, opts.throughDate) : undefined,
      ),
    )
    .orderBy(asc(billableExpenses.incurredOn))

  const timeCents = time.reduce((sum, row) => sum + row.amountCents, 0)
  const expenseCents = expenses.reduce((sum, row) => sum + row.billableCents, 0)

  return {
    projectId: opts.projectId,
    projectName: project.name,
    time,
    expenses,
    timeCents,
    expenseCents,
    totalCents: timeCents + expenseCents,
  }
}

/** Raised when somebody else billed the same work first. */
export class AlreadyBilledError extends DomainError {
  readonly status = 409
  constructor(readonly expected: number, readonly claimed: number) {
    super(
      `${expected - claimed} of those entries were billed by somebody else while this invoice ` +
        'was being prepared. Nothing has been charged — reload and try again.',
    )
    this.name = 'AlreadyBilledError'
  }
}

export type BillWorkInput = {
  projectId: string
  customerId: string
  issueDate: string
  dueDate?: string
  throughDate?: string
  grouping?: BillingGrouping
  /** What to bill the client in (Phase 66). Blank is the company's own. */
  currency?: string
  /** Draw a retainer down against the invoice, up to what is left of it. */
  applyRetainerId?: string | null
  memo?: string
}

/**
 * Bills approved time and unbilled expenses onto one invoice.
 *
 * Everything happens in the invoice's transaction: the lines, the marking, and
 * any retainer drawdown. A crash anywhere leaves no invoice and no time marked
 * billed, which is the only safe pair of outcomes — an invoice whose time is
 * still unbilled charges the client twice next month.
 */
export async function billWork(ctx: ActorContext, input: BillWorkInput) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'time_billing')

  const preview = await previewBilling(ctx, {
    projectId: input.projectId,
    throughDate: input.throughDate,
  })

  if (preview.time.length === 0 && preview.expenses.length === 0) {
    throw new Refusal('There is no approved, unbilled work on that engagement.')
  }

  const grouping = input.grouping ?? 'person'

  const [serviceRevenue, expenseRevenue] = await Promise.all([
    accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.consultingRevenue).then(
      (row) => row ?? accountByNumber(ctx.companyId, '4100'),
    ),
    accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.reimbursableRevenue).then(
      (row) => row ?? accountByNumber(ctx.companyId, '4100'),
    ),
  ])

  if (!serviceRevenue || !expenseRevenue) {
    throw new Refusal('No revenue account is set up for billing time.')
  }

  const lines: DocumentLineInput[] = groupTimeIntoLines(preview.time, grouping).map((line) => ({
    chartAccountId: serviceRevenue.id,
    description: line.description,
    quantityMilli: line.quantityMilli,
    // The rate shown is derived from the line's own total, so it always
    // multiplies back out — a blended line of two people at different rates
    // still foots.
    unitPriceCents:
      line.quantityMilli === 0 ? 0 : Math.round((line.amountCents * 1000) / line.quantityMilli),
    projectId: input.projectId,
  }))

  for (const expense of preview.expenses) {
    lines.push({
      chartAccountId: expenseRevenue.id,
      description: `${expense.description} (${expense.incurredOn})`,
      quantityMilli: 1000,
      unitPriceCents: expense.billableCents,
      projectId: input.projectId,
    })
  }

  return db.transaction(async (tx) => {
    const invoice = await createInvoice(
      ctx,
      {
        customerId: input.customerId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        // Phase 66: a client billed in euro is invoiced in euro. Without this a
        // euro retainer had nothing it could ever be drawn against, since a
        // draw across currencies is refused.
        currency: input.currency,
        lines,
        memo: input.memo,
        projectId: input.projectId,
      },
      tx,
    )

    // --- The claim ---------------------------------------------------------
    //
    // The precondition is in the WHERE. Two people billing this engagement at
    // once both selected these rows; only one update finds them still
    // approved and unbilled, and the loser's invoice rolls back entire.
    if (preview.time.length > 0) {
      const claimed = await tx
        .update(timeEntries)
        .set({
          status: 'billed',
          invoiceId: invoice.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(timeEntries.companyId, ctx.companyId),
            inArray(
              timeEntries.id,
              preview.time.map((row) => row.id),
            ),
            eq(timeEntries.status, 'approved'),
            isNull(timeEntries.invoiceId),
          ),
        )
        .returning({ id: timeEntries.id })

      if (claimed.length !== preview.time.length) {
        throw new AlreadyBilledError(preview.time.length, claimed.length)
      }

      // The rate each entry was actually billed at, frozen. A rate change next
      // quarter must not restate an invoice that has already been sent.
      for (const row of preview.time) {
        await tx
          .update(timeEntries)
          .set({ rateCents: row.rateCents, amountCents: row.amountCents })
          .where(eq(timeEntries.id, row.id))
      }
    }

    if (preview.expenses.length > 0) {
      const claimed = await tx
        .update(billableExpenses)
        .set({ status: 'billed', invoiceId: invoice.id })
        .where(
          and(
            eq(billableExpenses.companyId, ctx.companyId),
            inArray(
              billableExpenses.id,
              preview.expenses.map((row) => row.id),
            ),
            eq(billableExpenses.status, 'unbilled'),
            isNull(billableExpenses.invoiceId),
          ),
        )
        .returning({ id: billableExpenses.id })

      if (claimed.length !== preview.expenses.length) {
        throw new AlreadyBilledError(preview.expenses.length, claimed.length)
      }
    }

    let retainerAppliedCents = 0
    if (input.applyRetainerId) {
      retainerAppliedCents = await applyRetainerWithin(ctx, tx, {
        retainerId: input.applyRetainerId,
        invoiceId: invoice.id,
        appliedOn: input.issueDate,
      })
    }

    await recordAudit(
      ctx,
      {
        action: 'time.bill',
        entityType: 'invoice',
        entityId: invoice.id,
        after: {
          entries: preview.time.length,
          minutes: preview.time.reduce((sum, row) => sum + row.minutes, 0),
          expenses: preview.expenses.length,
          totalCents: preview.totalCents,
          retainerAppliedCents,
        },
      },
      tx,
    )

    return { invoice, ...preview, retainerAppliedCents }
  })
}

type GroupedLine = { description: string; quantityMilli: number; amountCents: number }

/**
 * Collapses entries into invoice lines.
 *
 * Amounts are summed from the entries, never recomputed from the group — so
 * however the lines are grouped, they add to the same total. That is what
 * makes the choice a presentation one.
 */
export function groupTimeIntoLines(
  rows: BillableTimeRow[],
  grouping: BillingGrouping,
): GroupedLine[] {
  if (rows.length === 0) return []

  const keyFor = (row: BillableTimeRow): string => {
    if (grouping === 'person') return row.personName
    if (grouping === 'day') return row.workedOn
    if (grouping === 'service') return row.serviceItemId ?? 'other'
    return 'all'
  }

  const groups = new Map<string, { rows: BillableTimeRow[]; minutes: number; amountCents: number }>()

  for (const row of rows) {
    const key = keyFor(row)
    const group = groups.get(key) ?? { rows: [], minutes: 0, amountCents: 0 }
    group.rows.push(row)
    group.minutes += row.minutes
    group.amountCents += row.amountCents
    groups.set(key, group)
  }

  return [...groups.entries()].map(([key, group]) => ({
    // The individual descriptions are kept in the line, because "Professional
    // services — 14.5 hours" is the invoice line a client queries and the
    // detail is what answers them.
    description: describeGroup(key, group.rows, grouping),
    quantityMilli: minutesToQuantityMilli(group.minutes),
    amountCents: group.amountCents,
  }))
}

function describeGroup(
  key: string,
  rows: BillableTimeRow[],
  grouping: BillingGrouping,
): string {
  const detail = rows.map((row) => `${row.workedOn} ${row.description}`).join('; ')

  if (grouping === 'person') return `Professional services — ${key}: ${detail}`
  if (grouping === 'day') return `Professional services, ${key}: ${detail}`
  if (grouping === 'service') return `Professional services: ${detail}`
  return `Professional services: ${detail}`
}

// --- Retainers -------------------------------------------------------------

/**
 * Takes money before the work is done.
 *
 * `Dr Bank / Cr Client Retainers Held`. **Not revenue** — the client's money
 * is held against work not yet performed. Recognising it on arrival is the
 * commonest error in professional-services bookkeeping, and it flatters a
 * quarter by exactly the value of the work still owed.
 */
export async function receiveRetainer(
  ctx: ActorContext,
  input: {
    customerId: string
    projectId?: string | null
    receivedOn: string
    amountCents: number
    /**
     * What the client actually sent (Phase 66). Blank is the company's own.
     *
     * Chosen rather than inherited, unlike a credit note's: a retainer arrives
     * before there is any document to inherit a currency from.
     */
    currency?: string
    financialAccountId: string
    reference?: string
    memo?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'time_billing')

  if (input.amountCents <= 0) throw new Refusal('A retainer has to be more than nothing.')

  const { financialAccounts } = await import('@/db/schema')

  const [account] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!account) throw new Error('Financial account not found')

  const heldAccount = await retainerAccount(ctx.companyId)

  const [customer] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
    .limit(1)

  if (!customer) throw new Error('Client not found')

  /**
   * What the money is worth in the books, fixed on the day it arrived
   * (Phase 66).
   *
   * The liability is carried at this rate until every cent of it is drawn, so
   * this is the number a later draw settles against. `rateFor` refuses when
   * there is no rate on file, which is the right moment to stop: a retainer
   * taken at a guessed rate is a wrong liability from its first day.
   */
  const currency = normalise(input.currency ?? (await functionalCurrency(ctx.companyId)))
  const { rateMillionths } = await rateFor(ctx, currency, input.receivedOn)
  const functionalCents = convert(input.amountCents, rateMillionths)

  return db.transaction(async (tx) => {
    const [retainer] = await tx
      .insert(retainers)
      .values({
        companyId: ctx.companyId,
        customerId: input.customerId,
        projectId: input.projectId ?? null,
        receivedOn: input.receivedOn,
        amountCents: input.amountCents,
        remainingCents: input.amountCents,
        currency,
        exchangeRateMillionths: rateMillionths,
        functionalRemainingCents: functionalCents,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.receivedOn,
        memo: `Retainer from ${customer.name}`,
        // `manual`, not `payment`. A payment in this codebase settles a
        // document through `payment_applications`, and a retainer settles
        // nothing — it arrives before there is anything to settle. Labelling it
        // a payment makes cash-basis reporting look for an application that
        // does not exist and warn about it.
        source: 'manual',
        sourceType: 'retainer',
        sourceId: retainer.id,
        // In the company's own money, at the rate on the day it arrived
        // (Phase 66). The ledger is never in the client's currency; posting the
        // face amount would put €10,000 on a dollar balance sheet.
        lines: [
          { chartAccountId: account.chartAccountId, debitCents: functionalCents },
          { chartAccountId: heldAccount.id, creditCents: functionalCents },
        ],
      },
      tx,
    )

    await tx
      .update(retainers)
      .set({ journalEntryId: entry.id })
      .where(eq(retainers.id, retainer.id))

    await recordAudit(
      ctx,
      {
        action: 'retainer.receive',
        entityType: 'retainer',
        entityId: retainer.id,
        after: {
          customer: customer.name,
          amountCents: input.amountCents,
          currency,
          functionalCents,
        },
      },
      tx,
    )

    return { ...retainer, journalEntryId: entry.id }
  })
}

/**
 * Draws a retainer down against an invoice.
 *
 * `Dr Client Retainers Held / Cr Accounts Receivable` — the liability is
 * discharged by settling the receivable it was always going to settle. The
 * invoice's balance falls without any money moving, because the money moved
 * when the retainer arrived.
 *
 * Unlike applying a credit note, this **does** post: a credit note already
 * moved the receivable when it was raised, whereas a retainer moved cash into
 * a liability and this is what converts it.
 */
export async function applyRetainer(
  ctx: ActorContext,
  input: { retainerId: string; invoiceId: string; appliedOn: string; amountCents?: number },
): Promise<number> {
  requirePermission(ctx, 'accounting:journal')
  return db.transaction((tx) => applyRetainerWithin(ctx, tx, input))
}

async function applyRetainerWithin(
  ctx: ActorContext,
  tx: Executor,
  input: { retainerId: string; invoiceId: string; appliedOn: string; amountCents?: number },
): Promise<number> {
  const [retainer] = await tx
    .select()
    .from(retainers)
    .where(and(eq(retainers.companyId, ctx.companyId), eq(retainers.id, input.retainerId)))
    .limit(1)

  if (!retainer) throw new Error('Retainer not found')

  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, input.invoiceId)))
    .limit(1)

  if (!invoice) throw new Error('Invoice not found')
  if (invoice.customerId !== retainer.customerId) {
    throw new Refusal('A retainer can only be drawn against the same client’s invoice.')
  }

  /**
   * The rate somebody had to choose turned out to be two rates already on file
   * (Phase 66).
   *
   * `refuseForeign` stopped this from Phase 35 because a draw is a settlement,
   * not a reversal, and settling at a guessed rate is an accounting decision
   * made by accident. But neither rate needs guessing: the retainer has been
   * carried at the rate the money arrived at, and the invoice at the rate it
   * was raised at. The difference between them is exactly the realised gain or
   * loss `recordPayment` has posted since Phase 35.
   *
   * What is still refused is a draw *across* currencies. Phase 62's rule, a
   * third time: money held in one currency has not discharged a demand in
   * another.
   */
  const verdict = drawableAgainst({
    retainerLabel: `The retainer received on ${retainer.receivedOn}`,
    retainerCurrency: retainer.currency,
    documentNumber: invoice.number,
    documentCurrency: invoice.currency,
  })
  if (!verdict.ok) throw new DomainError(verdict.reason)

  // Never more than is left, and never more than is owed. Both caps matter:
  // over-drawing invents money the client never paid, and over-applying leaves
  // an invoice with a negative balance that no report knows how to show.
  const amountCents = Math.min(
    input.amountCents ?? retainer.remainingCents,
    retainer.remainingCents,
    invoice.balanceCents,
  )

  if (amountCents <= 0) return 0

  const heldAccount = await retainerAccount(ctx.companyId, tx)
  const arAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable, tx)
  if (!arAccount) throw new Refusal('Accounts Receivable is missing from the chart.')

  /**
   * The settlement, in the company's own money.
   *
   * `relieveFunctional` decides what the invoice gives up — including its rule
   * that the final relief takes the whole remaining functional balance, so an
   * invoice cannot be left with a stranded cent — and `settleHeld` takes that
   * as given rather than re-deriving it.
   */
  const relief = relieveFunctional(invoice, amountCents)
  const release = relieveFunctional(
    {
      balanceCents: retainer.remainingCents,
      exchangeRateMillionths: retainer.exchangeRateMillionths,
      functionalBalanceCents: retainer.functionalRemainingCents,
    },
    amountCents,
  )
  const settlement = settleHeld({
    releasedCents: release.functionalCents,
    relievedCents: relief.functionalCents,
  })

  const fxAccount =
    settlement.realisedCents === 0 ? null : await ensureFxAccount(ctx, tx)

  const entry = await createJournalEntry(
    ctx,
    {
      entryDate: input.appliedOn,
      memo: `Retainer drawn against invoice ${invoice.number}`,
      source: 'manual',
      sourceType: 'retainer_application',
      sourceId: retainer.id,
      lines: [
        // The liability at what it has been carried at since the money came in,
        // the receivable at what the invoice was raised at, and the difference
        // where a difference belongs: it is a rate movement between two dates,
        // not revenue, because nothing more was sold (Phase 66).
        { chartAccountId: heldAccount.id, debitCents: settlement.releasedCents },
        { chartAccountId: arAccount.id, creditCents: settlement.relievedCents },
        ...(fxAccount
          ? [
              settlement.realisedCents > 0
                ? {
                    chartAccountId: fxAccount,
                    creditCents: settlement.realisedCents,
                    memo: 'Exchange gain',
                  }
                : {
                    chartAccountId: fxAccount,
                    debitCents: -settlement.realisedCents,
                    memo: 'Exchange loss',
                  },
            ]
          : []),
      ],
    },
    tx,
  )

  await tx.insert(retainerApplications).values({
    companyId: ctx.companyId,
    retainerId: retainer.id,
    invoiceId: invoice.id,
    amountCents,
    // The figure that was already worked out and posted a few lines above, kept
    // rather than dropped (Phase 112). It is the same number the entry debited,
    // so the row and the ledger cannot say different things about what left the
    // liability — and it is what lets the held-money position be stated for a
    // past date at all, since `relieveFunctional`'s stranded-cent rule makes it
    // underivable after the fact.
    carriedCents: settlement.releasedCents,
    appliedOn: input.appliedOn,
    journalEntryId: entry.id,
  })

  await tx
    .update(retainers)
    .set({
      remainingCents: retainer.remainingCents - amountCents,
      // Both halves together (Phase 66), by what actually left the liability —
      // which is the same number the entry debited, so the column and the
      // ledger cannot drift apart.
      functionalRemainingCents: release.functionalBalanceCents,
      updatedAt: new Date(),
    })
    .where(eq(retainers.id, retainer.id))

  const newBalance = invoice.balanceCents - amountCents
  await tx
    .update(invoices)
    .set({
      balanceCents: newBalance,
      // The relief worked out above, not a second call: computing it twice
      // would be two answers to what this invoice gives up.
      functionalBalanceCents: relief.functionalBalanceCents,
      status: newBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoice.id))

  await recordAudit(
    ctx,
    {
      action: 'retainer.apply',
      entityType: 'retainer',
      entityId: retainer.id,
      after: {
        invoice: invoice.number,
        amountCents,
        remainingCents: retainer.remainingCents - amountCents,
      },
    },
    tx,
  )

  return amountCents
}

/**
 * `2550 Client Retainers Held`, or `2500 Unearned Revenue` where the pack did
 * not install it.
 *
 * Either way the subtype is `deferred_revenue`, which is what makes Phase 12's
 * cash-basis transformation handle a retainer correctly with no extra code: on
 * a cash basis the deposit *is* revenue when it arrives, and the drawdown
 * never happened.
 */
async function retainerAccount(companyId: string, exec: Executor = db) {
  return (await resolveRetainerAccount(companyId, exec)).account
}

/**
 * The same resolution, saying **which** of the two it landed on (Phase 105).
 *
 * The integrity check has to know: on 2550 nothing else posts, so the retainers
 * and the account must be equal; on 2500 the account also holds every other
 * kind of deferred revenue, so only "not more than" can be claimed. Deriving
 * that a second time from the account number would be two answers to "where do
 * retainers live", and the posting path and the check disagreeing about that is
 * exactly how a check ends up reconciling the wrong account.
 */
export async function resolveRetainerAccount(companyId: string, exec: Executor = db) {
  const held = await accountByNumber(companyId, INDUSTRY_ACCOUNTS.clientRetainers, exec)
  if (held) return { account: held, holding: 'dedicated' as const }

  const unearned = await accountByNumber(companyId, '2500', exec)
  if (!unearned) throw new Refusal('No account is set up to hold client retainers.')
  return { account: unearned, holding: 'shared' as const }
}

/**
 * What the retainers say, against what the ledger says (Phase 105).
 *
 * Summed on `functional_remaining_cents` rather than `remaining_cents`: a
 * retainer carries the currency the money arrived in (Phase 66) and the ledger
 * is in the company's own money, so adding the second across a firm holding
 * both euros and dollars would produce the number Phase 65 was named for
 * eliminating — inside a check whose whole purpose is noticing when numbers
 * disagree.
 *
 * The verdict is `verdictFor` in `retainer-position.ts`; this only fetches.
 */
export async function retainerPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<Position> {
  requirePermission(ctx, 'reports:view')

  /**
   * Walked back to `asOf` rather than read off the running column (Phase 112).
   *
   * `functional_remaining_cents` is where the retainer stands *now*, and the
   * ledger side below has always been filtered by `entry_date` — so asking
   * about a past date compared a subledger as it stands today against a ledger
   * as at that day. Measured on the development books before this phase:
   *
   * ```
   * 2026-07-31  held 320000  ledger 320000  agrees
   * 2026-06-15  held 320000  ledger 500000  DIFFERS
   * 2026-04-30  held 320000  ledger      0  DIFFERS
   * ```
   *
   * The held figure never moved, and this is a **fault** — so $5,000 of client
   * money read as broken books in May, and $3,200 read as held a month before
   * the client had sent anything.
   */
  const rows = await db
    .select({
      id: retainers.id,
      receivedOn: retainers.receivedOn,
      amountCents: retainers.amountCents,
      rateMillionths: retainers.exchangeRateMillionths,
    })
    .from(retainers)
    .where(scoped(ctx, retainers))

  const [draws, returns] = await Promise.all([
    db
      .select({
        retainerId: retainerApplications.retainerId,
        on: retainerApplications.appliedOn,
        carriedCents: retainerApplications.carriedCents,
      })
      .from(retainerApplications)
      .where(scoped(ctx, retainerApplications)),
    db
      .select({
        subjectId: refunds.subjectId,
        on: refunds.refundedOn,
        carriedCents: refunds.carriedCents,
      })
      .from(refunds)
      .where(
        scoped(
          ctx,
          refunds,
          eq(refunds.subjectType, 'retainer'),
          // A refund taken back is marked rather than deleted (Phase 69), and
          // its entry is voided — so the ledger has already put the money back
          // and the subledger must too.
          isNull(refunds.voidedAt),
        ),
      ),
  ])

  const drawsBy = new Map<string, Array<{ on: string; carriedCents: number }>>()
  for (const draw of draws) {
    drawsBy.set(draw.retainerId, [...(drawsBy.get(draw.retainerId) ?? []), draw])
  }
  const returnsBy = new Map<string, Array<{ on: string; carriedCents: number }>>()
  for (const back of returns) {
    returnsBy.set(back.subjectId, [...(returnsBy.get(back.subjectId) ?? []), back])
  }

  const totals = heldAcrossAt(
    rows.map((row) => ({
      receivedOn: row.receivedOn,
      // The opening figure is not stored, and does not need to be: neither the
      // amount nor the rate ever changes after the money arrives, so converting
      // them is the same arithmetic `receiveRetainer` did on the day.
      openingCents: convert(row.amountCents, row.rateMillionths),
      draws: drawsBy.get(row.id) ?? [],
      returns: returnsBy.get(row.id) ?? [],
    })),
    // Undated means *everything*, which is what the ledger side below already
    // means: `endDate: undefined` puts no filter on `entry_date`. A date beyond
    // any movement says that in the same words the dated path uses, rather than
    // giving this function a second code path or a clock it does not need.
    opts.asOf ?? '9999-12-31',
  )

  const { account, holding } = await resolveRetainerAccount(ctx.companyId)

  return {
    heldCents: totals.heldCents,
    // Signed in the account's normal direction, so a liability carrying a
    // credit balance comes back positive — already what "how much of other
    // people's money are we holding" means.
    ledgerCents: await balanceForAccount(ctx, account.id, { endDate: opts.asOf }),
    holding,
    accountNumber: account.number,
    accountName: account.name,
    // From the same walk as the total, not a second query: "how much are we
    // holding" and "on how many retainers" are one question asked two ways, and
    // a past date makes them disagree if they are answered separately.
    openCount: totals.openCount,
  }
}

export async function listRetainers(
  ctx: ActorContext,
  opts: { customerId?: string; openOnly?: boolean } = {},
) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: retainers.id,
      customerId: retainers.customerId,
      customerName: customers.name,
      receivedOn: retainers.receivedOn,
      amountCents: retainers.amountCents,
      remainingCents: retainers.remainingCents,
      // Phase 66: the picker showed a EUR 10,000 retainer as $10,000, and a
      // draw only ever happens against an invoice in this currency.
      currency: retainers.currency,
      functionalRemainingCents: retainers.functionalRemainingCents,
      reference: retainers.reference,
    })
    .from(retainers)
    .innerJoin(customers, eq(customers.id, retainers.customerId))
    .where(
      scoped(
        ctx,
        retainers,
        opts.customerId ? eq(retainers.customerId, opts.customerId) : undefined,
        opts.openOnly ? sql`${retainers.remainingCents} > 0` : undefined,
      ),
    )
    .orderBy(desc(retainers.receivedOn))
}

/**
 * Gives a retainer back (spec §5, Phase 67).
 *
 * ## Why this did not exist
 *
 * ADR 0066 recorded it: *"a retainer cannot be refunded in its own currency,
 * because it cannot be refunded at all — there has never been a way to give one
 * back."* An engagement that ends with money unearned left a balance on
 * `2550 Client Retainers Held` that nothing could clear, and a client owed money
 * the product could not record returning.
 *
 * That is Phase 49's lesson exactly, which found `applyVendorCredit` written
 * since Phase 12 with no caller: **a balance with no way out becomes a wrong
 * number and stays one.**
 *
 * ## The three amounts
 *
 * A refund of a foreign retainer is three different facts, and collapsing them
 * is what Phase 53's `refundCredit` did wrong:
 *
 * - what the client gets back, in the money they sent — they are owed in theirs;
 * - what leaves the liability, at the rate it has been carried at since it
 *   arrived, because that is what the books have been saying it is worth;
 * - what leaves the bank, at the rate on the day the money moves, because that
 *   is what the statement will say and what the reconciliation needs.
 *
 * The difference between the last two is a realised exchange gain or loss —
 * `settleHeld`'s rule, a third caller after the payment and the retainer draw.
 */
export async function refundRetainer(
  ctx: ActorContext,
  input: {
    retainerId: string
    /** In the retainer's own currency. */
    amountCents: number
    financialAccountId: string
    refundedOn: string
    reference?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'time_billing')

  return db.transaction(async (tx) => {
    const [retainer] = await tx
      .select()
      .from(retainers)
      .where(scoped(ctx, retainers, eq(retainers.id, input.retainerId)))
      .limit(1)

    if (!retainer) throw new DomainError('That retainer is not on these books.')

    // Phase 53's verdict, borrowed rather than restated: held money has two
    // ends, and neither may exceed what is held or be for nothing. It names the
    // currency now (Phase 67), so a euro retainer is refused in euro.
    const permitted = mayUse({
      use: 'refund',
      amountCents: input.amountCents,
      availableCents: retainer.remainingCents,
      currency: retainer.currency,
    })
    if (!permitted.ok) throw new DomainError(permitted.why)

    const { financialAccounts } = await import('@/db/schema')
    const [account] = await tx
      .select()
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!account) throw new DomainError('That account is not on these books.')

    /**
     * What actually leaves the bank, at the rate on the day it leaves.
     *
     * Not the retainer's rate. The bank gives up today's dollars for today's
     * euro, and a refund booked at the rate the money arrived at would put a
     * figure on the cash account that the statement disagrees with — which is
     * the reconciliation error Phase 53 built the whole overpayment split to
     * avoid, in the other direction.
     */
    const { rateMillionths } = await rateFor(ctx, retainer.currency, input.refundedOn, tx)
    const paidCents = convert(input.amountCents, rateMillionths)

    // What leaves the liability, at what it has been carried at — and the last
    // refund takes the whole functional remainder, so neither column strands a
    // cent (Phase 66's rule, one operation over).
    const release = relieveFunctional(
      {
        balanceCents: retainer.remainingCents,
        exchangeRateMillionths: retainer.exchangeRateMillionths,
        functionalBalanceCents: retainer.functionalRemainingCents,
      },
      input.amountCents,
    )
    const settlement = settleHeld({
      releasedCents: release.functionalCents,
      relievedCents: paidCents,
    })

    const heldAccount = await retainerAccount(ctx.companyId, tx)
    const fxAccount =
      settlement.realisedCents === 0 ? null : await ensureFxAccount(ctx, tx)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.refundedOn,
        memo: input.reference
          ? `Retainer refunded — ${input.reference}`
          : 'Retainer refunded',
        source: 'manual',
        sourceType: 'retainer_refund',
        sourceId: retainer.id,
        lines: [
          { chartAccountId: heldAccount.id, debitCents: settlement.releasedCents },
          { chartAccountId: account.chartAccountId, creditCents: paidCents },
          ...(fxAccount
            ? [
                settlement.realisedCents > 0
                  ? {
                      chartAccountId: fxAccount,
                      creditCents: settlement.realisedCents,
                      memo: 'Exchange gain',
                    }
                  : {
                      chartAccountId: fxAccount,
                      debitCents: -settlement.realisedCents,
                      memo: 'Exchange loss',
                    },
              ]
            : []),
        ],
      },
      tx,
    )

    // One table for every refund since Phase 68 — this had `retainer_refunds`
    // to itself for exactly one phase, and a second table beside it would have
    // made the split permanent.
    await tx.insert(refunds).values({
      companyId: ctx.companyId,
      subjectType: 'retainer',
      subjectId: retainer.id,
      direction: 'out',
      amountCents: input.amountCents,
      currency: retainer.currency,
      carriedCents: settlement.releasedCents,
      cashCents: paidCents,
      realisedCents: settlement.realisedCents,
      exchangeRateMillionths: rateMillionths,
      refundedOn: input.refundedOn,
      reference: input.reference ?? null,
      financialAccountId: account.id,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    /**
     * Conditional on what was there when it was read, so two people refunding
     * the same retainer at once produce one refund and the second finds
     * nothing — the database arbitrates, as it does everywhere in this system
     * two people can act at once.
     */
    const claimed = await tx
      .update(retainers)
      .set({
        remainingCents: retainer.remainingCents - input.amountCents,
        functionalRemainingCents: release.functionalBalanceCents,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(retainers.id, retainer.id),
          eq(retainers.remainingCents, retainer.remainingCents),
        ),
      )
      .returning({ id: retainers.id })

    if (claimed.length === 0) {
      throw new DomainError('That retainer was drawn on by somebody else a moment ago.')
    }

    await recordAudit(
      ctx,
      {
        action: 'retainer.refund',
        entityType: 'retainer',
        entityId: retainer.id,
        after: {
          amountCents: input.amountCents,
          currency: retainer.currency,
          paidCents,
          releasedCents: settlement.releasedCents,
          realisedCents: settlement.realisedCents,
        },
      },
      tx,
    )

    return {
      refundedCents: input.amountCents,
      currency: retainer.currency,
      paidCents,
      realisedCents: settlement.realisedCents,
      remainingCents: retainer.remainingCents - input.amountCents,
    }
  })
}
