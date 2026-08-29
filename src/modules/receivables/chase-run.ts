import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { customers, invoices, payments, paymentApplications } from '@/db/schema'
import { logUnexpected } from '@/modules/errors'
import type { ActorContext } from '@/modules/tenancy/context'
import { getChasePolicy, type ChaseSettings } from './chase-policy'
import {
  planChases,
  nextChaseDate,
  type ChaseableInvoice,
  type ChaseRefusal,
} from './chasing'
import { sendInvoice } from './send'

/**
 * Chasing overdue invoices without anybody opening a page (spec §13, §18).
 *
 * `chasing.ts` decides *whether*; this reads what it needs and does it. The
 * split is not ceremony — the decision is the part that has to be arguable in
 * a test with no database and no clock, because the cost of getting it wrong
 * is a customer who paid last week receiving a demand.
 *
 * ## Why the last payment date is a join and not a column
 *
 * `invoices` carries a balance but not a "last paid on". The date lives on the
 * payment, reached through the application that ties it to this invoice, which
 * is also the only place that knows a payment settling three invoices touched
 * this one. Denormalising it would create a second answer to when somebody
 * last paid — the thing ADR 0002 spent a phase refusing — for the sake of one
 * daily query.
 */

/** One invoice as the chase decision needs it, with what a screen wants too. */
export type ChaseCandidate = ChaseableInvoice & {
  customerId: string
  customerName: string
  currency: string
}

/**
 * Every invoice on the books that a chase could conceivably concern.
 *
 * Deliberately not filtered to "overdue" in SQL. The preview's whole job is to
 * say *why the other forty are not going out*, and an invoice excluded by the
 * query cannot explain itself.
 */
export async function chaseCandidates(companyId: string): Promise<ChaseCandidate[]> {
  // Last payment per invoice, through the application. `max` over the date
  // rather than the created timestamp: a payment entered today for money that
  // arrived last month bought quiet last month.
  const lastPayment = db
    .select({
      invoiceId: paymentApplications.invoiceId,
      lastDate: sql<string>`max(${payments.paymentDate})`.as('last_date'),
    })
    .from(paymentApplications)
    .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
    // A voided payment bought no quiet (Phase 52): if the money went back,
    // the invoice is owed again and the chase should resume.
    .where(and(eq(paymentApplications.companyId, companyId), eq(payments.status, 'posted')))
    .groupBy(paymentApplications.invoiceId)
    .as('last_payment')

  /**
   * What the business is holding for each customer (Phase 54).
   *
   * A subquery rather than a second round trip: `chaseCandidates` runs once a
   * day over every invoice on the books, and the preview screen calls it too.
   *
   * Void receipts hold nothing (Phase 52), which is the same exclusion the
   * last-payment subquery above makes for the same reason.
   */
  const heldCredit = db
    .select({
      customerId: payments.customerId,
      heldCents: sql<string>`sum(${payments.unappliedCents})`.as('held_cents'),
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, companyId),
        eq(payments.status, 'posted'),
        gt(payments.unappliedCents, 0),
      ),
    )
    .groupBy(payments.customerId)
    .as('held_credit')

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      dueDate: invoices.dueDate,
      balanceCents: invoices.balanceCents,
      currency: invoices.currency,
      // What the floor is compared against (Phase 61).
      functionalBalanceCents: invoices.functionalBalanceCents,
      sentAt: invoices.sentAt,
      sendCount: invoices.sendCount,
      customerId: customers.id,
      customerName: customers.name,
      customerEmail: customers.email,
      lastPaymentDate: lastPayment.lastDate,
      heldCreditCents: heldCredit.heldCents,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(lastPayment, eq(lastPayment.invoiceId, invoices.id))
    .leftJoin(heldCredit, eq(heldCredit.customerId, invoices.customerId))
    .where(
      and(
        eq(invoices.companyId, companyId),
        // Draft, void and paid are excluded here because there is nothing
        // useful to say about them and a busy company has thousands. Written
        // off is *kept*, so the preview can say out loud that a debt given up
        // on is not being chased — which is the reassurance somebody needs
        // before they switch this on.
        inArray(invoices.status, ['open', 'partial', 'written_off']),
      ),
    )

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    dueDate: row.dueDate,
    balanceCents: Number(row.balanceCents),
    functionalBalanceCents: Number(row.functionalBalanceCents),
    sentAt: row.sentAt ? row.sentAt.toISOString().slice(0, 10) : null,
    sendCount: row.sendCount,
    lastPaymentDate: row.lastPaymentDate ?? null,
    heldCreditCents: Number(row.heldCreditCents ?? 0),
    customerEmail: row.customerEmail,
    customerId: row.customerId,
    customerName: row.customerName,
    currency: row.currency,
  }))
}

export type ChasePreview = {
  policy: ChaseSettings
  asOf: string
  /** What would go out today, oldest debt first, already capped at `maxPerRun`. */
  due: Array<{ invoice: ChaseCandidate; stage: number; daysOverdue: number; nextAfter: string | null }>
  /** How many would go out but for the cap. Zero on a normal day. */
  overCap: number
  held: Array<{ invoice: ChaseCandidate; reason: ChaseRefusal; nextChase: string | null }>
  heldCounts: Record<ChaseRefusal, number>
}

/**
 * What a run today would do, without doing any of it.
 *
 * The same function the worker uses, so the screen cannot drift from the job —
 * a preview that is a second implementation is a preview that lies eventually.
 *
 * ## Asked as if it were on, always
 *
 * The plan is computed against the policy with `enabled` forced true, and the
 * caller is handed the real `policy` alongside it. That is not the preview
 * disagreeing with the run: `policy_off` is the correct answer to *is this
 * being chased*, and it is a useless answer to *what would happen if I turned
 * this on*, which is the only question anybody has while it is off.
 *
 * Written the other way — and it was, until the screen was opened — every row
 * on a company that has not switched chasing on reads "chasing is switched
 * off", including under the heading promising to show what would go out.
 * The preview was empty at exactly the moment it was the whole point.
 *
 * The switch is still what decides whether anything is sent. `runChases`
 * checks it, and checks it against the stored policy rather than this one.
 */
export async function previewChases(companyId: string, asOf?: string): Promise<ChasePreview> {
  const [policy, candidates] = await Promise.all([
    getChasePolicy(companyId),
    chaseCandidates(companyId),
  ])

  const today = asOf ?? new Date().toISOString().slice(0, 10)
  const asIfOn = { ...policy, enabled: true }
  const plan = planChases({ invoices: candidates, policy: asIfOn, asOf: today })

  return {
    policy,
    asOf: today,
    due: plan.due.slice(0, policy.maxPerRun).map((row) => ({
      invoice: row.invoice as ChaseCandidate,
      stage: row.stage,
      daysOverdue: row.daysOverdue,
      // What happens *after* today's send, which is the question somebody
      // reading this actually has: "and then when?"
      //
      // Asked of the invoice as today's send will leave it — one more letter,
      // sent today. Asking it of the invoice as it stands now would answer
      // from a send that is about to be superseded, and name a day sooner
      // than anything will actually go out.
      nextAfter: nextChaseDate({
        invoice: { ...row.invoice, sendCount: row.invoice.sendCount + 1, sentAt: today },
        policy: asIfOn,
      }),
    })),
    overCap: Math.max(0, plan.due.length - policy.maxPerRun),
    held: plan.held.map((row) => ({
      invoice: row.invoice as ChaseCandidate,
      reason: row.reason,
      nextChase: nextChaseDate({ invoice: row.invoice, policy: asIfOn }),
    })),
    heldCounts: plan.heldCounts,
  }
}

export type ChaseRunResult = {
  companyId: string
  asOf: string
  enabled: boolean
  sent: number
  failed: number
  /** Named so the operations page says something on a quiet night. */
  considered: number
  /** Refusals worth reporting. Excludes the ordinary ones, which are most of them. */
  notes: string[]
}

/**
 * Sends today's chases for one company.
 *
 * ## Nothing here decides anything
 *
 * The plan comes from the pure core, the sending from Phase 42's `sendInvoice`
 * — the same call the button on the invoices screen makes, so a chase is
 * recorded, counted, rate limited and logged exactly like a send somebody made
 * by hand. That is what makes the count and the date `chaseVerdict` reads
 * correct: there is one place a send is recorded and one thing that moves it,
 * so a run that fires twice reads its own first send and declines.
 *
 * The actor is whoever the caller passes — the worker's `systemActor`, so the
 * audit trail says *Scheduled task* rather than putting the owner's name on
 * an email they did not write.
 *
 * ## Each send is caught on its own
 *
 * A provider refusing one address must not stop the other eleven. This is the
 * shape Phase 33's check runner settled on for the same reason: a run that
 * dies on its third item leaves the rest silently undone, and nobody finds out
 * until a customer asks why they were never chased.
 */
export async function runChases(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<ChaseRunResult> {
  const companyId = ctx.companyId
  const preview = await previewChases(companyId, opts.asOf)

  const base: ChaseRunResult = {
    companyId,
    asOf: preview.asOf,
    enabled: preview.policy.enabled,
    sent: 0,
    failed: 0,
    considered: preview.due.length + preview.held.length,
    notes: [],
  }

  // The single most important line in the module. Absent settings mean off,
  // and off means this returns having touched nothing.
  if (!preview.policy.enabled) return base

  let sent = 0
  let failed = 0
  const notes: string[] = []

  for (const row of preview.due) {
    try {
      const result = await sendInvoice(ctx, row.invoice.id)
      if (result.delivered) {
        sent++
      } else {
        failed++
        notes.push(`${row.invoice.number}: ${result.error ?? 'the provider refused it'}`)
      }
    } catch (error) {
      failed++
      // Logged rather than rethrown: one bad address is not a reason to leave
      // the rest of the day's chases unsent.
      logUnexpected(error, `chasing invoice ${row.invoice.number}`)
      notes.push(`${row.invoice.number}: ${error instanceof Error ? error.message : 'failed'}`)
    }
  }

  if (preview.overCap > 0) {
    notes.push(`${preview.overCap} more were due but the daily cap held them back.`)
  }

  return { ...base, sent, failed, notes }
}
