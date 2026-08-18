import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, customers, invoices, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { functionalCurrency, rateFor } from './service'
import { revalue } from './rates'

/**
 * What the open foreign balances would be worth today (spec §19).
 *
 * ## Reported, not posted
 *
 * A €4,000 invoice raised at 1.0835 sits in receivables at $4,334. If the rate
 * is 1.1000 at month end it is *worth* $4,400 — but nobody has been paid, and
 * the rate can be back at 1.07 before they are.
 *
 * Standards permit posting this movement, and most large systems do. This one
 * does not, and the reason is who uses it: a small business whose result is
 * driven by a number it does not control, has not received, and will restate
 * next month is a small business whose accountant spends December explaining
 * that the profit is not real. The exposure is worth *knowing*; booking it is
 * a choice with consequences somebody should make deliberately rather than
 * discover.
 *
 * So this is a report. It names the exposure, per currency and per party, and
 * anybody who wants it in the ledger can post the journal entry it describes.
 */

export type ExposureRow = {
  party: string
  documentNumber: string
  currency: string
  /** Still owed, in the document's currency. */
  outstandingCents: number
  /** The rate it was raised at. */
  documentRateMillionths: number
  /** What the books carry it at. */
  carriedCents: number
  /** What it would be at the closing rate. */
  restatedCents: number
  unrealisedCents: number
}

export type Exposure = {
  asOf: string
  functionalCurrency: string
  /** Per currency, so somebody can see which one is moving against them. */
  byCurrency: Array<{
    currency: string
    closingRateMillionths: number
    outstandingCents: number
    carriedCents: number
    restatedCents: number
    unrealisedCents: number
  }>
  receivables: ExposureRow[]
  payables: ExposureRow[]
  /**
   * The net movement across everything open.
   *
   * A gain on receivables and a loss on payables in the same currency largely
   * cancel, which is the useful thing this number says and the reason it is
   * reported net rather than as two gross figures.
   */
  netUnrealisedCents: number
  /** True when nothing is open in a currency other than the books' own. */
  noExposure: boolean
}

const OPEN_INVOICE_STATUSES = ['open', 'partial', 'written_off'] as const
const OPEN_BILL_STATUSES = ['open', 'partial'] as const

/**
 * Open foreign balances restated at the rate on a date.
 *
 * A missing closing rate is a refusal, per the module's rule — a currency with
 * no rate on file is one this report cannot honestly say anything about, and
 * reporting it at its original rate would show zero exposure, which is the one
 * answer guaranteed to be wrong.
 */
export async function foreignExposure(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<Exposure> {
  requirePermission(ctx, 'reports:financial')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const home = await functionalCurrency(ctx.companyId)

  const openInvoices = await db
    .select({
      party: customers.name,
      documentNumber: invoices.number,
      currency: invoices.currency,
      outstandingCents: invoices.balanceCents,
      documentRateMillionths: invoices.exchangeRateMillionths,
      carriedCents: invoices.functionalBalanceCents,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      scoped(
        ctx,
        invoices,
        and(
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          ne(invoices.balanceCents, 0),
          ne(invoices.currency, home),
        ),
      ),
    )

  const openBills = await db
    .select({
      party: vendors.name,
      documentNumber: bills.number,
      currency: bills.currency,
      outstandingCents: bills.balanceCents,
      documentRateMillionths: bills.exchangeRateMillionths,
      carriedCents: bills.functionalBalanceCents,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(
      scoped(
        ctx,
        bills,
        and(
          inArray(bills.status, [...OPEN_BILL_STATUSES]),
          ne(bills.balanceCents, 0),
          ne(bills.currency, home),
        ),
      ),
    )

  const currencies = [
    ...new Set([...openInvoices, ...openBills].map((row) => row.currency)),
  ].sort()

  if (currencies.length === 0) {
    return {
      asOf,
      functionalCurrency: home,
      byCurrency: [],
      receivables: [],
      payables: [],
      netUnrealisedCents: 0,
      noExposure: true,
    }
  }

  const closing = new Map<string, number>()
  for (const currency of currencies) {
    closing.set(currency, (await rateFor(ctx, currency, asOf)).rateMillionths)
  }

  const restate = (row: (typeof openInvoices)[number]): ExposureRow => {
    const closingRate = closing.get(row.currency)!
    const result = revalue({
      outstandingCents: row.outstandingCents,
      documentRateMillionths: row.documentRateMillionths,
      closingRateMillionths: closingRate,
    })

    return {
      party: row.party,
      documentNumber: row.documentNumber,
      currency: row.currency,
      outstandingCents: row.outstandingCents,
      documentRateMillionths: row.documentRateMillionths,
      // What the books actually carry, not a re-derivation of it. A part-paid
      // invoice's carried amount is the remainder of an original conversion,
      // and recomputing it from the rate would differ by the rounding the
      // payment already absorbed.
      carriedCents: row.carriedCents,
      restatedCents: result.restatedCents,
      unrealisedCents: result.restatedCents - row.carriedCents,
    }
  }

  const receivables = openInvoices.map(restate)
  // A payable moving the same way is the opposite sign: owing more of the
  // books' own money is a loss, not a gain.
  const payables = openBills.map(restate).map((row) => ({
    ...row,
    unrealisedCents: -row.unrealisedCents,
  }))

  const byCurrency = currencies.map((currency) => {
    const rows = [...receivables, ...payables].filter((row) => row.currency === currency)
    return {
      currency,
      closingRateMillionths: closing.get(currency)!,
      outstandingCents: rows.reduce((sum, row) => sum + row.outstandingCents, 0),
      carriedCents: rows.reduce((sum, row) => sum + row.carriedCents, 0),
      restatedCents: rows.reduce((sum, row) => sum + row.restatedCents, 0),
      unrealisedCents: rows.reduce((sum, row) => sum + row.unrealisedCents, 0),
    }
  })

  return {
    asOf,
    functionalCurrency: home,
    byCurrency,
    receivables,
    payables,
    netUnrealisedCents: byCurrency.reduce((sum, row) => sum + row.unrealisedCents, 0),
    noExposure: false,
  }
}

export type ConversionCheck = {
  /** Σ what the documents say they are carried at. */
  documentsCents: number
  /** Σ what a fresh conversion at each document's own rate would give. */
  recomputedCents: number
  differenceCents: number
  agrees: boolean
  offenders: Array<{ number: string; carriedCents: number; recomputedCents: number }>
}

/**
 * Whether every document's stored home amount matches its own rate.
 *
 * The two sides are genuinely different in the sense Phase 26 established: the
 * left is a column written when the document was raised, the right is the
 * conversion recomputed now from the balance and the rate beside it. Nothing
 * derives one from the other, and they can only disagree if something wrote a
 * home amount that its own rate does not produce.
 *
 * They are **expected to differ by rounding on a part-paid document**, which is
 * why the tolerance is a cent per open document rather than zero — a payment
 * takes an exact remainder out of the carried amount, and the remainder is not
 * always what re-converting the remaining foreign balance gives.
 */
export async function conversionsAgree(ctx: ActorContext): Promise<ConversionCheck> {
  requirePermission(ctx, 'reports:view')

  const home = await functionalCurrency(ctx.companyId)

  const rows = await db
    .select({
      number: invoices.number,
      balanceCents: invoices.balanceCents,
      rate: invoices.exchangeRateMillionths,
      carriedCents: invoices.functionalBalanceCents,
    })
    .from(invoices)
    .where(
      scoped(
        ctx,
        invoices,
        and(inArray(invoices.status, [...OPEN_INVOICE_STATUSES]), ne(invoices.currency, home)),
      ),
    )

  let documentsCents = 0
  let recomputedCents = 0
  const offenders: ConversionCheck['offenders'] = []

  for (const row of rows) {
    const recomputed = Math.round((row.balanceCents * row.rate) / 1_000_000)
    documentsCents += row.carriedCents
    recomputedCents += recomputed

    // More than a cent apart is not rounding — it is a home amount that its own
    // rate cannot produce.
    if (Math.abs(recomputed - row.carriedCents) > 1) {
      offenders.push({
        number: row.number,
        carriedCents: row.carriedCents,
        recomputedCents: recomputed,
      })
    }
  }

  return {
    documentsCents,
    recomputedCents,
    differenceCents: documentsCents - recomputedCents,
    agrees: offenders.length === 0,
    offenders,
  }
}

/**
 * What currency has already cost or earned, in the profit and loss (spec §19).
 *
 * The other half of the sentence the exposure report starts. Exposure is what
 * *might* happen to the open balances; this is what already did — the realised
 * gains and losses on documents that have been settled, sitting in 7100 where
 * they affect the year's result.
 *
 * Reported together on purpose. A currencies page that showed only the
 * unrealised figure would say currency movement is a reporting matter, which is
 * the opposite of true for anybody who has actually been paid.
 */
export async function realisedMovement(
  ctx: ActorContext,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<{ accountNumber: string; realisedCents: number; hasAccount: boolean }> {
  requirePermission(ctx, 'reports:financial')

  const { accountByNumber } = await import('@/modules/coa/service')
  const { balanceForAccount } = await import('@/modules/ledger/balances')
  const { FX_ACCOUNTS } = await import('./service')

  const account = await accountByNumber(ctx.companyId, FX_ACCOUNTS.gainOrLoss)

  if (!account) {
    // The account is installed on first use, so its absence is not an error —
    // it means nothing foreign has ever been settled.
    return { accountNumber: FX_ACCOUNTS.gainOrLoss, realisedCents: 0, hasAccount: false }
  }

  return {
    accountNumber: FX_ACCOUNTS.gainOrLoss,
    // `balanceForAccount` returns the *normal* balance, and 7100 is credit-normal
    // other income — so a gain reads positive and a loss negative, which is the
    // direction somebody expects to read.
    realisedCents: await balanceForAccount(ctx, account.id, {
      startDate: opts.startDate,
      endDate: opts.endDate,
    }),
    hasAccount: true,
  }
}
