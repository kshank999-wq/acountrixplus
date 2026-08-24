import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  appointments,
  chartAccounts,
  customers,
  giftCardRedemptions,
  giftCards,
  invoices,
  practitioners,
  serviceItems,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { createInvoice } from '@/modules/receivables/service'
import { relieveFunctional } from '@/modules/fx/documents'
import { redeemFor, splitFor } from './split'
import { DomainError } from '@/modules/errors'

/**
 * Appointments, practitioner splits and gift cards (spec §5).
 *
 * See `split.ts` for the arithmetic and `db/schema/appointments.ts` for why a
 * double-booking is refused by Postgres rather than by a check in here.
 */

export class AppointmentError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'AppointmentError'
  }
}

/** Raised when the diary already has that practitioner at that time. */
export class DoubleBookedError extends DomainError {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'DoubleBookedError'
  }
}

/** Accounts this module posts to, by their conventional numbers. */
export const APPOINTMENT_ACCOUNTS = {
  serviceRevenue: '4700',
  productRevenue: '4710',
  giftCardsOutstanding: '2590',
  practitionerPayable: '2320',
  practitionerCost: '5220',
  receivable: '1100',
} as const

/**
 * The accounts a practice posts to, installed if missing.
 *
 * The personal-care pack carries most of them; the healthcare pack carries
 * none, because until now nothing in the application had a practitioner to pay.
 * Only ever adds — the rule properties, funds, manufacturing and takings all
 * follow.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    {
      number: APPOINTMENT_ACCOUNTS.serviceRevenue,
      name: 'Service Revenue - Appointments',
      type: 'revenue' as const,
    },
    {
      number: APPOINTMENT_ACCOUNTS.productRevenue,
      name: 'Retail Product Sales',
      type: 'revenue' as const,
    },
    {
      number: APPOINTMENT_ACCOUNTS.giftCardsOutstanding,
      name: 'Gift Cards Outstanding',
      type: 'liability' as const,
      subtype: 'deferred_revenue' as const,
      description:
        'Money taken for services not yet given. Every balance here is a promise the business still owes somebody.',
    },
    {
      number: APPOINTMENT_ACCOUNTS.practitionerPayable,
      name: 'Contractor Payouts Payable',
      type: 'liability' as const,
      subtype: 'payroll' as const,
      description:
        "What practitioners have earned and not yet been paid. Theirs from the moment the work was done, not from the moment payroll runs.",
    },
    {
      number: APPOINTMENT_ACCOUNTS.practitionerCost,
      name: 'Booth Rent and Staff Splits',
      type: 'cogs' as const,
    },
  ]

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(
          chartAccounts.number,
          wanted.map((account) => account.number),
        ),
      ),
    )

  const have = new Set(existing.map((row) => row.number))
  const missing = wanted.filter((account) => !have.has(account.number))
  if (missing.length === 0) return

  await exec
    .insert(chartAccounts)
    .values(missing.map((account) => ({ companyId: ctx.companyId, ...account })))
    .onConflictDoNothing()
}

/** Resolves account numbers to ids, refusing the whole operation if any is missing. */
async function accountsByNumber(
  ctx: ActorContext,
  numbers: string[],
  exec: Executor,
): Promise<Map<string, string>> {
  const wanted = [...new Set(numbers)]
  const rows = await exec
    .select({ id: chartAccounts.id, number: chartAccounts.number })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.number, wanted)))

  const map = new Map(rows.map((row) => [row.number, row.id]))
  const unknown = wanted.filter((number) => !map.has(number))

  if (unknown.length > 0) {
    throw new AppointmentError(
      `This chart of accounts has no ${unknown.join(', ')}. Add the account first.`,
    )
  }

  return map
}

// --- Practitioners ---------------------------------------------------------

export async function addPractitioner(
  ctx: ActorContext,
  input: {
    name: string
    email?: string | null
    commissionBp?: number
    productCommissionBp?: number
    isEmployee?: boolean
    userId?: string | null
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'company:manage')
  await requireModule(ctx, 'appointments')

  const name = input.name.trim()
  if (!name) throw new AppointmentError('A practitioner needs a name.')

  const [row] = await db
    .insert(practitioners)
    .values({
      companyId: ctx.companyId,
      name,
      email: input.email?.trim() || null,
      userId: input.userId ?? null,
      commissionBp: input.commissionBp ?? 0,
      productCommissionBp: input.productCommissionBp ?? 0,
      isEmployee: input.isEmployee ?? false,
    })
    .returning({ id: practitioners.id })

  return row
}

export async function listPractitioners(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(practitioners)
    .where(scoped(ctx, practitioners))
    .orderBy(asc(practitioners.name))
}

// --- The diary -------------------------------------------------------------

export type BookInput = {
  practitionerId: string
  customerId?: string | null
  serviceItemId?: string | null
  startsAt: Date
  endsAt: Date
  priceCents?: number
  productCents?: number
  /** Overrides the practitioner's standing rate for this booking only. */
  commissionBp?: number
  productCommissionBp?: number
  notes?: string | null
}

/**
 * Puts an appointment in the diary.
 *
 * **Posts nothing.** A booking is a promise: the client has not been seen, the
 * practitioner has not earned anything, and if the ledger moved here then every
 * cancellation would need a reversal and a practice's revenue would be whatever
 * its diary happened to hold.
 *
 * The overlap check is the database's. `book` does not read the practitioner's
 * other appointments first — deliberately, because a check-then-insert is
 * correct right up until the receptionist and the online form act in the same
 * second. The exclusion constraint raises `23P01`, and that is translated into
 * something a receptionist can act on.
 */
export async function book(ctx: ActorContext, input: BookInput): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'appointments')

  if (input.endsAt <= input.startsAt) {
    throw new AppointmentError('An appointment has to end after it starts.')
  }

  const [practitioner] = await db
    .select()
    .from(practitioners)
    .where(scoped(ctx, practitioners, eq(practitioners.id, input.practitionerId)))
    .limit(1)

  if (!practitioner) throw new AppointmentError('No such practitioner.')
  if (!practitioner.isActive) {
    throw new AppointmentError(`${practitioner.name} is no longer taking appointments.`)
  }

  // The rate is copied from the practitioner now rather than read at completion,
  // so a rise in March cannot restate what February's work was worth.
  const commissionBp = input.commissionBp ?? practitioner.commissionBp
  const productCommissionBp = input.productCommissionBp ?? practitioner.productCommissionBp

  const priceCents = input.priceCents ?? (await defaultPrice(ctx, input.serviceItemId))

  try {
    const [row] = await db
      .insert(appointments)
      .values({
        companyId: ctx.companyId,
        practitionerId: input.practitionerId,
        customerId: input.customerId ?? null,
        serviceItemId: input.serviceItemId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        priceCents,
        productCents: input.productCents ?? 0,
        commissionBp,
        productCommissionBp,
        notes: input.notes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning({ id: appointments.id })

    return row
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new DoubleBookedError(
        `${practitioner.name} already has an appointment overlapping that time. ` +
          'Two people cannot be in the same chair at once.',
      )
    }
    throw error
  }
}

/**
 * Postgres raises `23P01` for an exclusion violation.
 *
 * Matched on the SQLSTATE rather than the message, because the message is
 * localized and the constraint name could be renamed by a later migration.
 *
 * The cause chain is walked because drizzle wraps driver errors in its own
 * `Failed query:` error and hangs the original off `cause` — so checking only
 * the top-level object finds nothing and every double-booking surfaces to the
 * receptionist as an unhandled database error. Found by the test below, which
 * asserted the error *type* rather than only that something was thrown.
 */
function isExclusionViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === '23P01') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

async function defaultPrice(ctx: ActorContext, serviceItemId?: string | null): Promise<number> {
  if (!serviceItemId) return 0

  const [item] = await db
    .select({ price: serviceItems.unitPriceCents })
    .from(serviceItems)
    .where(scoped(ctx, serviceItems, eq(serviceItems.id, serviceItemId)))
    .limit(1)

  return item?.price ?? 0
}

export type CompleteResult = {
  id: string
  practitionerCents: number
  businessCents: number
  totalCents: number
  /** The invoice the client owes. Empty on a free visit, which bills nothing. */
  invoiceId: string
  /** The practitioner's share. Empty when there was none to post. */
  journalEntryId: string
  /** False when this appointment was already completed and nothing was posted. */
  posted: boolean
}

/**
 * Records that the service was delivered, and posts it.
 *
 * ```
 *   Dr Accounts Receivable            total
 *       Cr Service Revenue                    price
 *       Cr Retail Product Sales               products
 *   Dr Booth Rent and Staff Splits    share
 *       Cr Contractor Payouts Payable         share
 * ```
 *
 * The second pair is the one worth staring at. The practitioner's share is
 * **not** netted off the revenue: the practice earned the whole £130 and owes
 * £58.50 of it to the person who did the work. Netting would understate both
 * the revenue and the cost of delivering it, and would hide the payout from
 * anybody reading the profit and loss — which is precisely the figure a salon
 * owner wants to see when they ask why a busy month made no money.
 *
 * A second call posts nothing and says so, for the same reason Phase 28's
 * import does: this is a button a receptionist double-taps.
 */
export async function completeAppointment(
  ctx: ActorContext,
  input: { appointmentId: string; completedOn: string; productCents?: number },
): Promise<CompleteResult> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'appointments')

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    // Locked, so two clicks cannot both read `booked` and both post.
    const [existing] = await tx
      .select()
      .from(appointments)
      .where(scoped(ctx, appointments, eq(appointments.id, input.appointmentId)))
      .limit(1)
      .for('update')

    if (!existing) throw new AppointmentError('No such appointment.')

    if (existing.status === 'completed') {
      return {
        id: existing.id,
        practitionerCents: existing.practitionerCents ?? 0,
        businessCents:
          existing.priceCents + existing.productCents - (existing.practitionerCents ?? 0),
        totalCents: existing.priceCents + existing.productCents,
        invoiceId: existing.invoiceId ?? '',
        journalEntryId: existing.journalEntryId ?? '',
        posted: false,
      }
    }

    if (existing.status === 'cancelled' || existing.status === 'no_show') {
      throw new AppointmentError(
        `That appointment is marked ${existing.status.replace('_', '-')}. ` +
          'Reopen it before completing it.',
      )
    }

    const productCents = input.productCents ?? existing.productCents

    const split = splitFor({
      serviceCents: existing.priceCents,
      productCents,
      commissionBp: existing.commissionBp,
      productCommissionBp: existing.productCommissionBp,
    })

    if (split.totalCents === 0 && split.practitionerCents === 0) {
      // A free appointment is a real thing — a consultation, a redo — and it
      // has nothing to post. It still completes, so the diary is honest about
      // what happened.
      await tx
        .update(appointments)
        .set({
          status: 'completed',
          completedOn: input.completedOn,
          productCents,
          practitionerCents: 0,
        })
        .where(scoped(ctx, appointments, eq(appointments.id, existing.id)))

      return {
        id: existing.id,
        practitionerCents: 0,
        businessCents: 0,
        totalCents: 0,
        invoiceId: '',
        journalEntryId: '',
        posted: true,
      }
    }

    const accounts = await accountsByNumber(
      ctx,
      [
        APPOINTMENT_ACCOUNTS.receivable,
        APPOINTMENT_ACCOUNTS.serviceRevenue,
        APPOINTMENT_ACCOUNTS.productRevenue,
        APPOINTMENT_ACCOUNTS.practitionerCost,
        APPOINTMENT_ACCOUNTS.practitionerPayable,
      ],
      tx,
    )

    const [practitioner] = await tx
      .select({ name: practitioners.name })
      .from(practitioners)
      .where(scoped(ctx, practitioners, eq(practitioners.id, existing.practitionerId)))
      .limit(1)

    // --- What the client owes: a real invoice -----------------------------
    //
    // Phase 29 posted `Dr 1100 / Cr revenue` by hand here, and it balanced, and
    // it was wrong. An appointment billed that way appears on the balance sheet
    // and on **no aging report, no statement and no PDF**, and cannot be paid,
    // because every one of those reads invoices rather than the ledger. A salon
    // owner could see £199 of receivables and have no way to find out whose it
    // was. Phase 31 hands the job to the machinery that already does it
    // properly; `controlAccounts` is the detector that would have caught it.
    // A walk-in is a real customer, just not a named one, and refusing to bill
    // one would be wrong about the trade — half a salon's book is people who
    // rang that morning. They go on a single house account, which is what a
    // shop does on paper too, and a payment at the counter clears it. Naming
    // them later is an ordinary edit to the invoice.
    const billToId = existing.customerId ?? (await walkInCustomer(ctx, tx))

    const invoiceLines = []

    if (existing.priceCents > 0) {
      invoiceLines.push({
        chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.serviceRevenue) as string,
        description: `${practitioner?.name ?? 'Practitioner'} — service`,
        unitPriceCents: existing.priceCents,
      })
    }

    if (productCents > 0) {
      invoiceLines.push({
        chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.productRevenue) as string,
        description: 'Retail sold at the visit',
        unitPriceCents: productCents,
      })
    }

    const invoice = await createInvoice(
      ctx,
      {
        customerId: billToId,
        issueDate: input.completedOn,
        memo: `Appointment — ${practitioner?.name ?? 'practitioner'}`,
        lines: invoiceLines,
      },
      tx,
    )

    // --- What the practitioner is owed ------------------------------------
    //
    // Still its own entry, and deliberately not a line on the invoice: the
    // client is not being billed for the stylist's share, and putting it on
    // their bill would be both wrong and rude. It is a cost of delivering what
    // the invoice sold.
    let entryId = ''

    if (split.practitionerCents > 0) {
      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: input.completedOn,
          memo: `${practitioner?.name ?? 'Practitioner'}'s share of ${invoice.number}`,
          source: 'appointment',
          sourceType: 'appointment',
          sourceId: existing.id,
          lines: [
            {
              chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.practitionerCost) as string,
              debitCents: split.practitionerCents,
              memo: `${practitioner?.name ?? 'Practitioner'}'s share`,
            },
            {
              chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.practitionerPayable) as string,
              creditCents: split.practitionerCents,
              memo: `Owed to ${practitioner?.name ?? 'practitioner'}`,
            },
          ],
        },
        tx,
      )
      entryId = entry.id
    }

    await tx
      .update(appointments)
      .set({
        status: 'completed',
        completedOn: input.completedOn,
        productCents,
        practitionerCents: split.practitionerCents,
        invoiceId: invoice.id,
        journalEntryId: entryId || null,
      })
      .where(scoped(ctx, appointments, eq(appointments.id, existing.id)))

    await recordAudit(
      ctx,
      {
        action: 'appointment.complete',
        entityType: 'appointment',
        entityId: existing.id,
        before: { status: existing.status },
        after: {
          status: 'completed',
          totalCents: split.totalCents,
          practitionerCents: split.practitionerCents,
        },
      },
      tx,
    )

    return {
      id: existing.id,
      practitionerCents: split.practitionerCents,
      businessCents: split.businessCents,
      totalCents: split.totalCents,
      invoiceId: invoice.id,
      journalEntryId: entryId,
      posted: true,
    }
  })
}

/**
 * Marks an appointment as called off or not turned up to.
 *
 * Neither posts. A no-show that carries a charge is a fee somebody raises as an
 * invoice — a different transaction with a different revenue account and, in
 * most places, different tax treatment. Quietly booking the service revenue for
 * a service nobody received would be the wrong answer to a tempting question.
 */
export async function closeWithoutDelivery(
  ctx: ActorContext,
  input: { appointmentId: string; status: 'no_show' | 'cancelled' },
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'appointments')

  const [existing] = await db
    .select({ status: appointments.status })
    .from(appointments)
    .where(scoped(ctx, appointments, eq(appointments.id, input.appointmentId)))
    .limit(1)

  if (!existing) throw new AppointmentError('No such appointment.')

  if (existing.status === 'completed') {
    throw new AppointmentError(
      'That appointment was delivered and posted. Reverse the entry rather than ' +
        'marking it a no-show.',
    )
  }

  await db
    .update(appointments)
    .set({ status: input.status })
    .where(scoped(ctx, appointments, eq(appointments.id, input.appointmentId)))
}

/**
 * The house account every unnamed visit is billed to.
 *
 * One row per company, found or created. Deliberately a real `customers` row
 * rather than a null on the invoice: an invoice with no customer cannot age,
 * cannot appear on a statement and cannot be chased, which is the whole class
 * of bug Phase 31 exists to close.
 */
async function walkInCustomer(ctx: ActorContext, exec: Executor): Promise<string> {
  const [existing] = await exec
    .select({ id: customers.id })
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.name, 'Walk-in')))
    .limit(1)

  if (existing) return existing.id

  const [created] = await exec
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      name: 'Walk-in',
      notes: 'Visits taken without a named client. Settled at the counter.',
    })
    .returning({ id: customers.id })

  return created.id
}

// --- Gift cards ------------------------------------------------------------

/**
 * Sells a gift card.
 *
 * ```
 *   Dr Cash / Undeposited Funds     face value
 *       Cr Gift Cards Outstanding                face value
 * ```
 *
 * **No revenue.** This is the claim of the second half of this phase: the
 * business has the money and has given nothing for it. Booking it as revenue
 * on the day of sale overstates the year it was sold and understates the year
 * it is used — which is the reason gift cards are a named liability in every
 * accounting standard rather than a kind of sale.
 */
export async function sellGiftCard(
  ctx: ActorContext,
  input: {
    code: string
    amountCents: number
    issuedOn: string
    depositAccountNumber?: string
    purchaserCustomerId?: string | null
  },
): Promise<{ id: string; balanceCents: number }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'appointments')

  const code = input.code.trim().toUpperCase()
  if (!code) throw new AppointmentError('A gift card needs a code.')
  if (input.amountCents <= 0) {
    throw new AppointmentError('A gift card has to be sold for something.')
  }

  const depositNumber = input.depositAccountNumber ?? '1000'

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const accounts = await accountsByNumber(
      ctx,
      [depositNumber, APPOINTMENT_ACCOUNTS.giftCardsOutstanding],
      tx,
    )

    const [card] = await tx
      .insert(giftCards)
      .values({
        companyId: ctx.companyId,
        code,
        purchaserCustomerId: input.purchaserCustomerId ?? null,
        issuedCents: input.amountCents,
        balanceCents: input.amountCents,
        issuedOn: input.issuedOn,
        depositAccountId: accounts.get(depositNumber) as string,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing({ target: [giftCards.companyId, giftCards.code] })
      .returning({ id: giftCards.id })

    if (!card) {
      throw new AppointmentError(`Gift card ${code} has already been sold.`)
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issuedOn,
        memo: `Gift card ${code} sold`,
        source: 'appointment',
        sourceType: 'gift_card',
        sourceId: card.id,
        lines: [
          {
            chartAccountId: accounts.get(depositNumber) as string,
            debitCents: input.amountCents,
            memo: 'Gift card sold',
          },
          {
            chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.giftCardsOutstanding) as string,
            creditCents: input.amountCents,
            memo: 'Owed as a service, not yet given',
          },
        ],
      },
      tx,
    )

    await tx.update(giftCards).set({ journalEntryId: entry.id }).where(eq(giftCards.id, card.id))

    return { id: card.id, balanceCents: input.amountCents }
  })
}

export type RedemptionResult = {
  appliedCents: number
  remainingBalanceCents: number
  stillDueCents: number
  /** False when this appointment had already been settled by a card. */
  applied: boolean
}

/**
 * Uses a card against a completed appointment.
 *
 * ```
 *   Dr Gift Cards Outstanding    applied
 *       Cr Accounts Receivable               applied
 * ```
 *
 * ## Why this does not touch `4720 Gift Card Redemptions`
 *
 * The personal-care pack installs `4720` as a revenue account, and the obvious
 * reading is that redeeming a card earns revenue. **Here it does not, and
 * crediting it would count the same money twice.**
 *
 * The revenue was already recognised when the service was delivered — that is
 * the whole of this phase's first claim. By the time a card is produced at the
 * desk, the practice has earned its £65 and the client owes it; the card
 * settles the debt. Posting revenue again on redemption would state £130 of
 * income for one £65 haircut.
 *
 * `4720` belongs to a different model, the one a till uses: sell a card, and
 * recognise revenue when it is spent because there is no separate delivery
 * event to hang it on. That model is right for a shop and wrong here, and
 * having the account in the pack is not a reason to post to it. See ADR 0029.
 *
 * The redemption row carries `unique(appointment_id)`, so a retried click
 * cannot spend the card twice.
 */
export async function redeemGiftCard(
  ctx: ActorContext,
  input: { code: string; appointmentId: string; redeemedOn: string },
): Promise<RedemptionResult> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'appointments')

  const code = input.code.trim().toUpperCase()

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const [card] = await tx
      .select()
      .from(giftCards)
      .where(scoped(ctx, giftCards, eq(giftCards.code, code)))
      .limit(1)
      .for('update')

    if (!card) throw new AppointmentError(`No gift card with code ${code}.`)
    if (!card.isActive) throw new AppointmentError(`Gift card ${code} is no longer valid.`)

    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(scoped(ctx, appointments, eq(appointments.id, input.appointmentId)))
      .limit(1)

    if (!appointment) throw new AppointmentError('No such appointment.')

    if (appointment.status !== 'completed' || !appointment.invoiceId) {
      throw new AppointmentError(
        'A card settles a visit that happened. Complete the appointment first.',
      )
    }

    // What is still owed comes from the **invoice**, not from the appointment's
    // own prices. Phase 31 made the visit raise a real invoice, so a client who
    // has already part-paid at the counter must not be able to spend a card
    // against a balance that is no longer outstanding.
    const [bill] = await tx
      .select({
        id: invoices.id,
        balanceCents: invoices.balanceCents,
        exchangeRateMillionths: invoices.exchangeRateMillionths,
        functionalBalanceCents: invoices.functionalBalanceCents,
      })
      .from(invoices)
      .where(scoped(ctx, invoices, eq(invoices.id, appointment.invoiceId as string)))
      .limit(1)

    if (!bill) {
      throw new AppointmentError('That visit has no invoice to settle.')
    }

    // Idempotency before arithmetic.
    //
    // A retried click must get "that was already settled" rather than an error,
    // and after Phase 31 the balance check would beat the claim row to it — the
    // first redemption clears the invoice, so the second sees nothing owing and
    // throws where it used to return quietly. Same lesson as Phase 28's import:
    // the honest answer to doing it twice is "it is already done".
    const [alreadyDone] = await tx
      .select({ appliedCents: giftCardRedemptions.appliedCents })
      .from(giftCardRedemptions)
      .where(
        scoped(ctx, giftCardRedemptions, eq(giftCardRedemptions.appointmentId, appointment.id)),
      )
      .limit(1)

    if (alreadyDone) {
      return {
        appliedCents: 0,
        remainingBalanceCents: card.balanceCents,
        stillDueCents: bill.balanceCents,
        applied: false,
      }
    }

    const dueCents = bill.balanceCents
    const plan = redeemFor(card.balanceCents, dueCents)

    if (plan.appliedCents === 0) {
      throw new AppointmentError(
        card.balanceCents === 0
          ? `Gift card ${code} has nothing left on it.`
          : 'That appointment has nothing owing on it.',
      )
    }

    const accounts = await accountsByNumber(
      ctx,
      [APPOINTMENT_ACCOUNTS.giftCardsOutstanding, APPOINTMENT_ACCOUNTS.receivable],
      tx,
    )

    // The claim row goes in first, so a retry is refused before anything posts.
    const [claim] = await tx
      .insert(giftCardRedemptions)
      .values({
        companyId: ctx.companyId,
        giftCardId: card.id,
        appointmentId: appointment.id,
        appliedCents: plan.appliedCents,
        redeemedOn: input.redeemedOn,
      })
      .onConflictDoNothing({ target: [giftCardRedemptions.appointmentId] })
      .returning({ id: giftCardRedemptions.id })

    if (!claim) {
      return {
        appliedCents: 0,
        remainingBalanceCents: card.balanceCents,
        stillDueCents: dueCents,
        applied: false,
      }
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.redeemedOn,
        memo: `Gift card ${code} redeemed`,
        source: 'appointment',
        sourceType: 'gift_card_redemption',
        sourceId: claim.id,
        lines: [
          {
            chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.giftCardsOutstanding) as string,
            debitCents: plan.appliedCents,
            memo: 'Card spent — the promise is kept',
          },
          {
            chartAccountId: accounts.get(APPOINTMENT_ACCOUNTS.receivable) as string,
            creditCents: plan.appliedCents,
            memo: 'No longer owed by the client',
          },
        ],
      },
      tx,
    )

    // The subledger has to move with the ledger, or `controlAccounts` will say
    // so — which is the whole point of having it. A card that cleared the
    // balance closes the invoice; a partial one leaves it open for the rest.
    const remainingCents = bill.balanceCents - plan.appliedCents

    await tx
      .update(invoices)
      .set({
        balanceCents: remainingCents,
        // And the home-currency balance with it (Phase 35). Leaving this out is
        // exactly the defect the receivables check reported the night Phase 35
        // landed: the invoice was settled, the amount the control account is
        // measured against was not.
        functionalBalanceCents: relieveFunctional(bill, plan.appliedCents)
          .functionalBalanceCents,
        status: remainingCents === 0 ? 'paid' : 'partial',
      })
      .where(scoped(ctx, invoices, eq(invoices.id, bill.id)))

    await tx
      .update(giftCards)
      .set({ balanceCents: plan.remainingBalanceCents })
      .where(eq(giftCards.id, card.id))

    await tx
      .update(giftCardRedemptions)
      .set({ journalEntryId: entry.id })
      .where(eq(giftCardRedemptions.id, claim.id))

    await recordAudit(
      ctx,
      {
        action: 'giftcard.redeem',
        entityType: 'gift_card',
        entityId: card.id,
        before: { balanceCents: card.balanceCents },
        after: { balanceCents: plan.remainingBalanceCents, appliedCents: plan.appliedCents },
      },
      tx,
    )

    return { ...plan, applied: true }
  })
}
