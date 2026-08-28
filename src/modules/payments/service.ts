import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  checkouts,
  customers,
  financialAccounts,
  invoices,
  payments,
  payoutItems,
  payouts,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError, logUnexpected } from '@/modules/errors'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { recordPayment } from '@/modules/receivables/service'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { appBaseUrl } from '@/modules/notify/transactional'
import { getPaymentSettings } from './settings'
import { getPaymentProvider } from './registry'
import { feeFor, payableAmount, payoutReconciliation } from './settlement'
import {
  EMPTY_SWEEP,
  STALE_AFTER_DAYS,
  sweepDecision,
  type SweepSummary,
} from './reconcile'
import type { ProviderPaymentStatus } from './provider'

/**
 * Taking a card payment, and following the money until it reaches the bank
 * (spec §13, §3, §19).
 *
 * ## The three entries, and why there are three
 *
 * A customer pays a $1,000 invoice on Tuesday. On Friday $8,431.15 lands in
 * the current account, batched with eleven other payments. There is no single
 * entry that describes both facts, so there are three:
 *
 *     capture   Dr Payments in Transit 1,000.00  Cr Accounts Receivable 1,000.00
 *     fee       Dr Merchant Fees          29.30  Cr Payments in Transit    29.30
 *     payout    Dr Checking            8,431.15  Cr Payments in Transit 8,431.15
 *
 * The invoice is settled by the **gross**, because the customer paid what they
 * were asked for and the fee is a cost the business chose by accepting cards.
 * The bank sees exactly one row per payout, which is what the statement shows,
 * so Phase 40's tie-out can pass. And `1250` carries what the processor is
 * holding — a real asset, checkable against the processor's own figures, which
 * is what the integrity check does.
 *
 * ## What guarantees an invoice is not paid twice
 *
 * Not a lock, and not a check-then-act. `checkouts.payment_id` is unique, and
 * claiming a checkout is a conditional update that only fires while it is
 * still pending. Two requests race, one wins the row, the loser finds nothing
 * to claim and returns what already happened. The database arbitrates, which
 * is the rule everywhere in this system that two people can act at once.
 */

export class PaymentError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}

// --- Starting a payment ----------------------------------------------------

export type StartedCheckout = {
  checkoutId: string
  url: string
  amountCents: number
}

/**
 * Starts a card payment for an invoice.
 *
 * **No `ActorContext`.** The caller is the customer holding a share link, and
 * there is no actor to scope to — the token is what stands in for one, the
 * same reasoning `invoiceByShareToken` follows. Everything it needs is derived
 * from the invoice the token resolved to, so nothing the customer sends can
 * widen what they reach.
 *
 * The amount is decided here rather than accepted from the request. A form
 * field carrying "what I owe" is a form field somebody can edit.
 */
export async function startCheckout(input: {
  invoiceId: string
  /** A part payment, when the customer chose one. Null means the balance. */
  requestedCents?: number | null
}): Promise<StartedCheckout> {
  const [row] = await db
    .select({ invoice: invoices, customer: customers })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, input.invoiceId))
    .limit(1)

  if (!row) throw new PaymentError('That invoice could not be found.')
  if (row.invoice.status === 'void') {
    throw new PaymentError('This invoice has been cancelled. Please contact the sender.')
  }

  const settings = await getPaymentSettings(row.invoice.companyId)
  if (!settings.enabled) {
    throw new PaymentError('This business is not set up to take card payments.')
  }

  const payable = payableAmount({
    balanceCents: row.invoice.balanceCents,
    requestedCents: input.requestedCents,
  })
  if (!payable.ok) throw new PaymentError(payable.reason)

  const provider = getPaymentProvider(settings.provider)

  const checkout = await provider.createCheckout({
    companyId: row.invoice.companyId,
    invoiceId: row.invoice.id,
    amountCents: payable.amountCents,
    currency: row.invoice.currency,
    description: `Invoice ${row.invoice.number}`,
    customerEmail: row.customer.email,
    returnUrl: `${appBaseUrl()}/i/${row.invoice.shareToken}/paid`,
  })

  // Recorded before the customer is sent anywhere, for Phase 42's reason in
  // the other direction: a customer at a processor's page that this system
  // has no record of is a payment that can arrive with nothing to attach it
  // to.
  const [saved] = await db
    .insert(checkouts)
    .values({
      companyId: row.invoice.companyId,
      invoiceId: row.invoice.id,
      providerCheckoutId: checkout.providerCheckoutId,
      provider: provider.key,
      status: 'pending',
      grossCents: payable.amountCents,
      currency: row.invoice.currency,
      expiresAt: checkout.expiresAt,
    })
    .returning()

  return { checkoutId: saved.id, url: checkout.url, amountCents: payable.amountCents }
}

// --- Settling one ----------------------------------------------------------

export type SettleResult =
  | { ok: true; paymentId: string; grossCents: number; feeCents: number; alreadyDone: boolean }
  | { ok: false; reason: string }

/**
 * Asks the processor what happened, and posts it if money changed hands.
 *
 * Safe to call repeatedly, and it will be: the customer's browser returns to
 * a page that calls this, a webhook calls it, and a sweep calls it for
 * anything left pending. All three racing is the ordinary case, not the
 * exceptional one.
 *
 * No `ActorContext` for the same reason as `startCheckout`. It acts on one
 * checkout, identified by the processor's own id, and derives the company from
 * the row.
 */
export async function settleCheckout(providerCheckoutId: string): Promise<SettleResult> {
  const [existing] = await db
    .select()
    .from(checkouts)
    .where(eq(checkouts.providerCheckoutId, providerCheckoutId))
    .limit(1)

  if (!existing) return { ok: false, reason: 'That payment could not be found.' }

  // Already posted. The common case on a double-click, and it reports the
  // payment rather than an error, because from the customer's point of view
  // nothing is wrong: they paid.
  if (existing.paymentId) {
    return {
      ok: true,
      paymentId: existing.paymentId,
      grossCents: existing.grossCents,
      feeCents: existing.feeCents,
      alreadyDone: true,
    }
  }

  if (existing.status === 'failed' || existing.status === 'expired') {
    return { ok: false, reason: existing.failureReason ?? 'That payment did not go through.' }
  }

  const settings = await getPaymentSettings(existing.companyId)
  const provider = getPaymentProvider(existing.provider)
  const reported = await provider.getPayment(providerCheckoutId)

  if (reported.status === 'pending') {
    return { ok: false, reason: 'That payment has not completed yet.' }
  }

  // The processor has no record of it (Phase 46). Deliberately *not* treated
  // as a decline: marking a checkout failed because the processor was
  // unreachable is how a real payment gets written off. The row is left
  // exactly as it is, the sweep keeps asking, and the integrity check counts
  // it as unresolved until somebody or something settles the question.
  if (reported.status === 'unknown') {
    return {
      ok: false,
      reason: 'The processor has no record of that payment yet. It has not been written off.',
    }
  }

  if (reported.status === 'failed') {
    await db
      .update(checkouts)
      .set({
        status: 'failed',
        failureReason: reported.failureReason ?? 'The payment was declined.',
        completedAt: new Date(),
      })
      .where(eq(checkouts.id, existing.id))

    return { ok: false, reason: reported.failureReason ?? 'The payment was declined.' }
  }

  // The fee the processor actually charged, or what the company's schedule
  // says it will be. A processor that reports the fee late must not leave the
  // clearing account holding a figure nobody has accounted for.
  const feeCents =
    reported.feeCents > 0 ? reported.feeCents : feeFor(reported.grossCents, settings.fee).feeCents

  // Claim it. Only one caller can move a row out of `pending`, so only one
  // records a payment — no lock, no read-then-write, and no possibility of
  // two payments against one charge.
  const claimed = await db
    .update(checkouts)
    .set({
      status: 'succeeded',
      providerPaymentId: reported.providerPaymentId,
      feeCents,
      completedAt: new Date(),
    })
    .where(and(eq(checkouts.id, existing.id), eq(checkouts.status, 'pending')))
    .returning({ id: checkouts.id })

  if (claimed.length === 0) {
    // Somebody else claimed it between the read and the write. Whether they
    // have finished posting is their business; re-reading tells the truth.
    const [now] = await db.select().from(checkouts).where(eq(checkouts.id, existing.id)).limit(1)
    if (now?.paymentId) {
      return {
        ok: true,
        paymentId: now.paymentId,
        grossCents: now.grossCents,
        feeCents: now.feeCents,
        alreadyDone: true,
      }
    }
    return { ok: false, reason: 'That payment is still being recorded.' }
  }

  return postCapturedCheckout(existing.id)
}

/**
 * Posts a claimed checkout to the ledger.
 *
 * Split out because a checkout can be claimed and not posted — the process
 * died in between — and that state has to be recoverable rather than
 * permanent. Calling this again finishes the job; the unique constraint on
 * `checkouts.payment_id` is what stops it doing the job twice.
 */
export async function postCapturedCheckout(checkoutId: string): Promise<SettleResult> {
  const [row] = await db
    .select({ checkout: checkouts, invoice: invoices })
    .from(checkouts)
    .innerJoin(invoices, eq(invoices.id, checkouts.invoiceId))
    .where(eq(checkouts.id, checkoutId))
    .limit(1)

  if (!row) return { ok: false, reason: 'That payment could not be found.' }
  if (row.checkout.paymentId) {
    return {
      ok: true,
      paymentId: row.checkout.paymentId,
      grossCents: row.checkout.grossCents,
      feeCents: row.checkout.feeCents,
      alreadyDone: true,
    }
  }

  const ctx = await paymentActor(row.checkout.companyId)

  // The gross settles the debt. Charging the fee back to the customer's
  // balance would leave every card-paid invoice showing 29 dollars owing.
  //
  // Capped at what is still outstanding, because the balance can have moved
  // since the checkout was created — somebody may have banked a cheque while
  // the customer had the payment page open. Over-applying would push the
  // invoice negative and put the AR control account out of agreement with the
  // aging report, which Phase 31 spent a phase proving.
  const applyCents = Math.min(row.checkout.grossCents, row.invoice.balanceCents)

  if (applyCents <= 0) {
    // Real money with nothing to apply it to. Left claimed and unposted
    // rather than guessed at: the integrity check surfaces it and a person
    // decides whether it is a refund or a credit.
    return {
      ok: false,
      reason: 'This invoice was settled by something else before the card payment arrived.',
    }
  }

  const payment = await recordPayment(ctx, {
    kind: 'receipt',
    customerId: row.invoice.customerId,
    paymentDate: new Date().toISOString().slice(0, 10),
    amountCents: applyCents,
    viaPaymentsInTransit: true,
    reference: row.checkout.providerPaymentId ?? row.checkout.providerCheckoutId,
    memo: `Card payment for invoice ${row.invoice.number}`,
    applications: [{ invoiceId: row.invoice.id, amountCents: applyCents }],
  })

  // Attach it, and let the database refuse a second attempt. If this update
  // loses to a concurrent one, the unique constraint throws rather than
  // leaving two payments claiming the same charge.
  await db
    .update(checkouts)
    .set({ paymentId: payment.id })
    .where(and(eq(checkouts.id, checkoutId), isNull(checkouts.paymentId)))

  if (row.checkout.feeCents > 0) {
    await postFee(ctx, {
      checkoutId,
      feeCents: row.checkout.feeCents,
      invoiceNumber: row.invoice.number,
    })
  }

  await recordAudit(ctx, {
    action: 'payment.card_captured',
    entityType: 'invoice',
    entityId: row.invoice.id,
    after: {
      grossCents: row.checkout.grossCents,
      feeCents: row.checkout.feeCents,
      appliedCents: applyCents,
    },
  })

  return {
    ok: true,
    paymentId: payment.id,
    grossCents: row.checkout.grossCents,
    feeCents: row.checkout.feeCents,
    alreadyDone: false,
  }
}

/**
 * The fee, as its own entry.
 *
 * Posted at capture rather than at payout, because it is incurred when the
 * charge is taken — and because leaving it until the payout would mean the
 * clearing account carried the gross for three days while the processor was
 * only ever going to send the net, so the account would never reconcile
 * against the processor's own figure.
 */
async function postFee(
  ctx: ActorContext,
  input: { checkoutId: string; feeCents: number; invoiceNumber: string },
): Promise<void> {
  const [fees, inTransit] = await Promise.all([
    accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.merchantFees),
    accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.paymentsInTransit),
  ])

  if (!fees || !inTransit) {
    // Named rather than swallowed. A missing account means the fee never
    // reaches the profit and loss and the clearing account never clears, and
    // the integrity check is what will say so.
    logUnexpected(
      new Error('Merchant Fees or Payments in Transit is missing from the chart.'),
      'posting a card processing fee',
    )
    return
  }

  await createJournalEntry(
    ctx,
    {
      entryDate: new Date().toISOString().slice(0, 10),
      memo: `Card processing fee on invoice ${input.invoiceNumber}`,
      source: 'payment',
      sourceType: 'checkout',
      sourceId: input.checkoutId,
      lines: [
        { chartAccountId: fees.id, debitCents: input.feeCents },
        { chartAccountId: inTransit.id, creditCents: input.feeCents },
      ],
    },
    db,
  )
}

// --- The sweep -------------------------------------------------------------

/**
 * Asks the processor about every checkout still hanging, and resolves what it
 * can (spec §13, §19, Phase 46).
 *
 * ## Why the browser returning is not enough
 *
 * Phase 44 settled a payment when the customer's browser came back from the
 * processor. That is the least reliable moment in the flow: the tab is closed,
 * the redirect fails, the phone loses signal. The processor took the money
 * either way, and until this sweep existed nothing ever asked again — the
 * checkout sat `pending`, the invoice still said the money was owed, and
 * Phase 43 chased the customer for an invoice they had paid.
 *
 * ## What it will not do
 *
 * Decide, on its own, that a customer was not charged. An `unknown` from the
 * processor — an outage, a 404, a checkout raised against other credentials —
 * resolves nothing in either direction and is counted for a person. Waiting
 * another hour costs an hour; writing off a payment costs the payment.
 */
export async function sweepUnresolvedCheckouts(
  ctx: ActorContext,
  opts: { asOf?: string; limit?: number } = {},
): Promise<SweepSummary & { considered: number }> {
  requirePermission(ctx, 'accounting:journal')

  const asOf = opts.asOf ?? new Date().toISOString()

  const pending = await db
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.companyId, ctx.companyId), eq(checkouts.status, 'pending')))
    .orderBy(checkouts.createdAt)
    .limit(opts.limit ?? 200)

  const summary = { ...EMPTY_SWEEP, considered: pending.length }
  if (pending.length === 0) return summary

  const provider = getPaymentProvider(pending[0].provider)

  for (const row of pending) {
    // Each one caught on its own. A processor refusing one lookup must not
    // leave the other eleven unasked — the shape Phase 33's check runner
    // settled on, for the same reason.
    let reported: ProviderPaymentStatus = 'unknown'
    try {
      reported = (await provider.getPayment(row.providerCheckoutId)).status
    } catch (error) {
      logUnexpected(error, `asking the processor about checkout ${row.providerCheckoutId}`)
    }

    const verdict = sweepDecision({
      checkout: {
        id: row.id,
        status: row.status,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      },
      reported,
      asOf,
    })

    // Written down before anything is decided, and for every answer including
    // the boring ones. Browser verification found the sweep saying "somebody
    // needs to look" into a toast that vanished on reload, leaving the row
    // indistinguishable from the abandoned ones it sits beside. A finding
    // nobody can see an hour later is a finding the sweep did not make.
    await db
      .update(checkouts)
      .set({ lastReportedStatus: reported, lastCheckedAt: new Date(asOf) })
      .where(eq(checkouts.id, row.id))

    if (verdict.action === 'settle') {
      const result = await settleCheckout(row.providerCheckoutId)
      if (result.ok) summary.settled++
      else summary.investigate++
      continue
    }

    if (verdict.action === 'mark_failed') {
      await db
        .update(checkouts)
        .set({ status: 'failed', failureReason: verdict.why, completedAt: new Date() })
        .where(and(eq(checkouts.id, row.id), eq(checkouts.status, 'pending')))
      summary.failed++
      continue
    }

    if (verdict.action === 'expire') {
      // Only while it is still pending. If something settled it between the
      // read and here, that write wins — the database arbitrates, as it does
      // everywhere else two things can act at once.
      await db
        .update(checkouts)
        .set({ status: 'expired', failureReason: verdict.why, completedAt: new Date() })
        .where(and(eq(checkouts.id, row.id), eq(checkouts.status, 'pending')))
      summary.expired++
      continue
    }

    if (verdict.action === 'investigate') summary.investigate++
    else summary.waiting++
  }

  if (summary.settled > 0 || summary.investigate > 0) {
    await recordAudit(ctx, {
      action: 'payments.sweep',
      entityType: 'checkout',
      entityId: null,
      after: {
        settled: summary.settled,
        investigate: summary.investigate,
        expired: summary.expired,
      },
    })
  }

  return summary
}

/**
 * Checkouts that started and were never resolved.
 *
 * What the integrity check needs, and the number the screen shows. A pending
 * checkout past its window is not "in progress" — it is a question nobody has
 * answered, and the honest thing is to count it rather than to assume either
 * way.
 */
export async function unresolvedCheckouts(companyId: string, asOf?: string) {
  const now = asOf ? new Date(asOf) : new Date()
  const stale = new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000)

  return db
    .select({
      id: checkouts.id,
      providerCheckoutId: checkouts.providerCheckoutId,
      grossCents: checkouts.grossCents,
      currency: checkouts.currency,
      createdAt: checkouts.createdAt,
      expiresAt: checkouts.expiresAt,
      // What the sweep was last told, so the screen can separate "the
      // processor says it is still pending" from "the processor has never
      // heard of this" — two rows that look identical without it and need
      // opposite responses.
      lastReportedStatus: checkouts.lastReportedStatus,
      lastCheckedAt: checkouts.lastCheckedAt,
      invoiceNumber: invoices.number,
      customerName: customers.name,
    })
    .from(checkouts)
    .innerJoin(invoices, eq(invoices.id, checkouts.invoiceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(checkouts.companyId, companyId),
        eq(checkouts.status, 'pending'),
        // Past its own expiry, or past the generous fallback window.
        sql`coalesce(${checkouts.expiresAt}, ${checkouts.createdAt}) < ${stale.toISOString()}`,
      ),
    )
    .orderBy(checkouts.createdAt)
}

// --- Payouts ---------------------------------------------------------------

export type PayoutImport = {
  imported: number
  skipped: number
  postedCents: number
  /** Announced by the processor but not yet arrived. Still at the processor. */
  notYetArrived: number
  /** Batches whose items do not add up. Worth a person's attention. */
  discrepancies: Array<{ providerPayoutId: string; differenceCents: number }>
}

/**
 * Brings in the processor's payouts and posts each as one bank entry.
 *
 * One entry per payout, matching the one line the bank statement shows. That
 * correspondence is the whole point: without it Phase 40's tie-out has twelve
 * ledger rows to match against one statement row and no way to say they are
 * the same money.
 *
 * ## Only what has actually arrived
 *
 * A processor announces a batch before it lands — `pending`, with an arrival
 * date a day or two out. Posting that to the bank on the day it is announced
 * would put money in the account that is not there yet, which is the exact
 * error this whole phase exists to prevent, committed at the last step
 * instead of the first. Browser verification caught it doing precisely that:
 * a deposit dated the 30th posted on the 28th.
 *
 * So an unarrived batch is left alone. The money stays in `1250`, which is
 * the truthful place for it, and the next run picks the batch up on the day
 * it lands.
 */
export async function importPayouts(
  ctx: ActorContext,
  opts: { since?: string; asOf?: string } = {},
): Promise<PayoutImport> {
  requirePermission(ctx, 'accounting:journal')

  const settings = await getPaymentSettings(ctx.companyId)
  if (!settings.payoutFinancialAccountId) {
    throw new PaymentError('Choose the bank account the processor pays into first.')
  }

  const [bank] = await db
    .select()
    .from(financialAccounts)
    .where(
      scoped(ctx, financialAccounts, eq(financialAccounts.id, settings.payoutFinancialAccountId)),
    )
    .limit(1)

  if (!bank) throw new PaymentError('That payout account is no longer on these books.')

  const inTransit = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.paymentsInTransit)
  if (!inTransit) throw new PaymentError('The Payments in Transit account is missing.')

  const provider = getPaymentProvider(settings.provider)
  const since = opts.since ?? ''
  const reported = await provider.listPayouts(ctx.companyId, since)

  const today = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const result: PayoutImport = {
    imported: 0,
    skipped: 0,
    postedCents: 0,
    notYetArrived: 0,
    discrepancies: [],
  }

  for (const batch of reported) {
    // Announced but not landed. Left where it is until it does.
    if (batch.status !== 'paid' || batch.arrivalDate > today) {
      result.notYetArrived++
      continue
    }

    const matched = batch.paymentIds.length
      ? await db
          .select()
          .from(checkouts)
          .where(
            and(
              eq(checkouts.companyId, ctx.companyId),
              inArray(checkouts.providerPaymentId, batch.paymentIds),
            ),
          )
      : []

    const check = payoutReconciliation({
      reportedCents: batch.amountCents,
      items: matched.map((row) => ({
        paymentId: row.providerPaymentId ?? row.id,
        grossCents: row.grossCents,
        feeCents: row.feeCents,
      })),
    })

    // `onConflictDoNothing` on (company, provider payout id) is what makes a
    // re-run import nothing rather than post the deposit twice. The database
    // decides, not a prior read.
    const [saved] = await db
      .insert(payouts)
      .values({
        companyId: ctx.companyId,
        providerPayoutId: batch.providerPayoutId,
        provider: provider.key,
        arrivalDate: batch.arrivalDate,
        amountCents: batch.amountCents,
        currency: batch.currency,
        expectedCents: check.expectedCents,
        differenceCents: check.differenceCents,
      })
      .onConflictDoNothing({ target: [payouts.companyId, payouts.providerPayoutId] })
      .returning()

    if (!saved) {
      result.skipped++
      continue
    }

    if (matched.length > 0) {
      await db
        .insert(payoutItems)
        .values(
          matched.map((row) => ({
            companyId: ctx.companyId,
            payoutId: saved.id,
            checkoutId: row.id,
            grossCents: row.grossCents,
            feeCents: row.feeCents,
          })),
        )
        .onConflictDoNothing({ target: payoutItems.checkoutId })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: batch.arrivalDate,
        memo: `Card payout ${batch.providerPayoutId} — ${check.count} payments`,
        source: 'payment',
        sourceType: 'payout',
        sourceId: saved.id,
        lines: [
          { chartAccountId: bank.chartAccountId, debitCents: batch.amountCents },
          { chartAccountId: inTransit.id, creditCents: batch.amountCents },
        ],
      },
      db,
    )

    await db.update(payouts).set({ journalEntryId: entry.id }).where(eq(payouts.id, saved.id))

    result.imported++
    result.postedCents += batch.amountCents

    if (!check.balances) {
      result.discrepancies.push({
        providerPayoutId: batch.providerPayoutId,
        differenceCents: check.differenceCents,
      })
    }
  }

  if (result.imported > 0) {
    await recordAudit(ctx, {
      action: 'payments.payout_import',
      entityType: 'payout',
      entityId: null,
      after: { imported: result.imported, postedCents: result.postedCents },
    })
  }

  return result
}

// --- Reading ---------------------------------------------------------------

/** What the processor is still holding, according to our own records. */
export async function heldByProcessor(companyId: string): Promise<number> {
  const [row] = await db
    .select({
      cents: sql<string>`coalesce(sum(${checkouts.grossCents} - ${checkouts.feeCents}), 0)`,
    })
    .from(checkouts)
    .leftJoin(payoutItems, eq(payoutItems.checkoutId, checkouts.id))
    .where(
      and(
        eq(checkouts.companyId, companyId),
        eq(checkouts.status, 'succeeded'),
        isNull(payoutItems.id),
      ),
    )

  return Number(row?.cents ?? 0)
}

export async function recentCheckouts(ctx: ActorContext, limit = 25) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: checkouts.id,
      status: checkouts.status,
      grossCents: checkouts.grossCents,
      feeCents: checkouts.feeCents,
      currency: checkouts.currency,
      createdAt: checkouts.createdAt,
      completedAt: checkouts.completedAt,
      failureReason: checkouts.failureReason,
      invoiceNumber: invoices.number,
      customerName: customers.name,
      paidOut: sql<boolean>`${payoutItems.id} is not null`,
    })
    .from(checkouts)
    .innerJoin(invoices, eq(invoices.id, checkouts.invoiceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(payoutItems, eq(payoutItems.checkoutId, checkouts.id))
    .where(scoped(ctx, checkouts))
    .orderBy(sql`${checkouts.createdAt} desc`)
    .limit(limit)
}

export async function recentPayouts(ctx: ActorContext, limit = 25) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(payouts)
    .where(scoped(ctx, payouts))
    .orderBy(sql`${payouts.arrivalDate} desc`)
    .limit(limit)
}

/**
 * An actor for a payment nobody at the company initiated.
 *
 * The customer pressed the button, and they are not a user of this system. The
 * scheduled-task identity is the honest attribution — the same reasoning
 * `modules/worker/system-actor.ts` set out for the same problem, reused rather
 * than duplicated so there is one such identity rather than two.
 */
async function paymentActor(companyId: string): Promise<ActorContext> {
  const { systemActor } = await import('@/modules/worker/system-actor')
  return systemActor(companyId)
}
