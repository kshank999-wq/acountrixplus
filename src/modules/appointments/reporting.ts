import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { appointments, customers, giftCards, practitioners } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { APPOINTMENT_ACCOUNTS } from './service'

/**
 * What the diary and the ledger each say (spec §5).
 *
 * Two reconciliations here, and both follow the rule Phase 26 learned the hard
 * way: **a reconciliation has to compare two genuinely different things.** A
 * figure recomputed from the rows it is being checked against agrees with
 * itself and proves nothing.
 */

export type DiaryRow = {
  id: string
  practitionerId: string
  practitionerName: string
  customerName: string | null
  startsAt: Date
  endsAt: Date
  status: string
  priceCents: number
  productCents: number
  practitionerCents: number | null
}

/** The diary between two instants, in the order it happens. */
export async function diary(
  ctx: ActorContext,
  opts: { from?: Date; to?: Date; limit?: number } = {},
): Promise<DiaryRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: appointments.id,
      practitionerId: appointments.practitionerId,
      practitionerName: practitioners.name,
      customerName: customers.name,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      priceCents: appointments.priceCents,
      productCents: appointments.productCents,
      practitionerCents: appointments.practitionerCents,
    })
    .from(appointments)
    .innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      scoped(
        ctx,
        appointments,
        and(
          opts.from ? gte(appointments.startsAt, opts.from) : undefined,
          opts.to ? lte(appointments.startsAt, opts.to) : undefined,
        ),
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(opts.limit ?? 200)
}

export type PayoutPosition = {
  /** What delivered appointments say practitioners earned. */
  earnedCents: number
  /** What account 2320 still holds, after payroll has drawn on it. */
  ledgerCents: number
  /** Earned less still owed. Positive means somebody has been paid. */
  paidOutCents: number
  /** True when nothing has been paid out and the two therefore match. */
  agrees: boolean
  perPractitioner: Array<{
    practitionerId: string
    name: string
    earnedCents: number
    appointments: number
  }>
}

/**
 * What practitioners have earned, against what the books still owe them.
 *
 * The two sides are genuinely different and are *expected* to diverge: the left
 * is the sum of `appointments.practitioner_cents`, decided when each visit was
 * delivered; the right is the balance on 2320 after payroll has drawn on it.
 * Once anybody has been paid they must differ, so this does not treat a
 * difference as a fault — it names the gap, which is the number somebody needs
 * when a stylist asks what they are owed this month.
 *
 * Money leaves 2320 by a door this module does not control, and that is what
 * makes this a reconciliation rather than a restatement. The same shape as
 * Phase 28's tips position, against a different obligation — the recurrence is
 * the point rather than an accident.
 */
export async function payoutPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<PayoutPosition> {
  requirePermission(ctx, 'reports:view')

  const perPractitioner = await db
    .select({
      practitionerId: appointments.practitionerId,
      name: practitioners.name,
      earnedCents: sql<string>`coalesce(sum(${appointments.practitionerCents}), 0)`,
      appointments: sql<string>`count(*)`,
    })
    .from(appointments)
    .innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId))
    .where(scoped(ctx, appointments, eq(appointments.status, 'completed')))
    .groupBy(appointments.practitionerId, practitioners.name)
    .orderBy(desc(sql`coalesce(sum(${appointments.practitionerCents}), 0)`))

  const rows = perPractitioner.map((row) => ({
    practitionerId: row.practitionerId,
    name: row.name,
    earnedCents: Number(row.earnedCents),
    appointments: Number(row.appointments),
  }))

  const earnedCents = rows.reduce((sum, row) => sum + row.earnedCents, 0)

  const account = await accountByNumber(ctx.companyId, APPOINTMENT_ACCOUNTS.practitionerPayable)
  const ledgerCents = account
    ? await balanceForAccount(ctx, account.id, { endDate: opts.asOf })
    : 0

  return {
    earnedCents,
    ledgerCents,
    paidOutCents: earnedCents - ledgerCents,
    agrees: earnedCents === ledgerCents,
    perPractitioner: rows,
  }
}

export type GiftCardPosition = {
  /** What the cards themselves say is left on them. */
  outstandingCents: number
  /** What account 2590 says the business owes. */
  ledgerCents: number
  differenceCents: number
  agrees: boolean
  /** Cards sold, and how many still have something on them. */
  cardsIssued: number
  cardsWithBalance: number
  issuedCents: number
}

/**
 * What the cards say is left on them, against what the balance sheet says.
 *
 * This one **should** agree exactly, and that is what makes it worth running.
 * Unlike the payout position — where a difference is just payday having
 * happened — nothing legitimately moves 2590 except selling and redeeming a
 * card, both of which maintain the card balance in the same transaction. A
 * difference here means a redemption posted without updating a card, a card
 * updated without posting, or somebody journalling straight at 2590 by hand.
 *
 * The two sides are still genuinely independent: the left is a sum over
 * `gift_cards.balance_cents`, the right is a sum over journal lines. Neither is
 * derived from the other.
 */
export async function giftCardPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<GiftCardPosition> {
  requirePermission(ctx, 'reports:view')

  const [totals] = await db
    .select({
      outstanding: sql<string>`coalesce(sum(${giftCards.balanceCents}), 0)`,
      issued: sql<string>`coalesce(sum(${giftCards.issuedCents}), 0)`,
      cards: sql<string>`count(*)`,
      withBalance: sql<string>`count(*) filter (where ${giftCards.balanceCents} > 0)`,
    })
    .from(giftCards)
    .where(scoped(ctx, giftCards))

  const outstandingCents = Number(totals?.outstanding ?? 0)

  const account = await accountByNumber(ctx.companyId, APPOINTMENT_ACCOUNTS.giftCardsOutstanding)
  const ledgerCents = account
    ? await balanceForAccount(ctx, account.id, { endDate: opts.asOf })
    : 0

  return {
    outstandingCents,
    ledgerCents,
    differenceCents: outstandingCents - ledgerCents,
    agrees: outstandingCents === ledgerCents,
    cardsIssued: Number(totals?.cards ?? 0),
    cardsWithBalance: Number(totals?.withBalance ?? 0),
    issuedCents: Number(totals?.issued ?? 0),
  }
}

export type DiarySummary = {
  booked: number
  completed: number
  noShow: number
  cancelled: number
  /** What was earned from delivered visits. */
  deliveredCents: number
  /**
   * What sits in the diary undelivered.
   *
   * Explicitly **not** revenue, and named separately so nobody adds the two
   * together. A practice's forward book is a useful number and a dangerous one.
   */
  bookedCents: number
  /**
   * No-shows as a proportion of everything that was not cancelled, in basis
   * points. A cancellation is a slot given back; a no-show is one lost.
   */
  noShowRateBp: number
}

/** Counts by outcome over a window. */
export async function diarySummary(
  ctx: ActorContext,
  opts: { from?: Date; to?: Date } = {},
): Promise<DiarySummary> {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select({
      booked: sql<string>`count(*) filter (where ${appointments.status} = 'booked')`,
      completed: sql<string>`count(*) filter (where ${appointments.status} = 'completed')`,
      noShow: sql<string>`count(*) filter (where ${appointments.status} = 'no_show')`,
      cancelled: sql<string>`count(*) filter (where ${appointments.status} = 'cancelled')`,
      deliveredCents: sql<string>`coalesce(sum(${appointments.priceCents} + ${appointments.productCents}) filter (where ${appointments.status} = 'completed'), 0)`,
      bookedCents: sql<string>`coalesce(sum(${appointments.priceCents} + ${appointments.productCents}) filter (where ${appointments.status} = 'booked'), 0)`,
    })
    .from(appointments)
    .where(
      scoped(
        ctx,
        appointments,
        and(
          opts.from ? gte(appointments.startsAt, opts.from) : undefined,
          opts.to ? lte(appointments.startsAt, opts.to) : undefined,
        ),
      ),
    )

  const completed = Number(row?.completed ?? 0)
  const noShow = Number(row?.noShow ?? 0)
  const turnedUpOrNot = completed + noShow

  return {
    booked: Number(row?.booked ?? 0),
    completed,
    noShow,
    cancelled: Number(row?.cancelled ?? 0),
    deliveredCents: Number(row?.deliveredCents ?? 0),
    bookedCents: Number(row?.bookedCents ?? 0),
    noShowRateBp: turnedUpOrNot === 0 ? 0 : Math.round((noShow * 10_000) / turnedUpOrNot),
  }
}
