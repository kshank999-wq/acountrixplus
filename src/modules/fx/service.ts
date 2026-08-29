import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { chartAccounts, companies, exchangeRates } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { RATE_ONE, RateError, convert, describeRate, isForeign, normalise } from './rates'
import { documentQuote, offerableCurrencies, type DocumentQuote } from './quoting'

/**
 * Rates on file, and the conversion the ledger actually uses (spec §19).
 *
 * ## The accounts
 *
 * `7100 Foreign Exchange Gain or Loss` is one account, not two. A business
 * wants to know what currency did to its year as a single number; splitting
 * gains from losses into separate lines makes somebody add them together to
 * answer that, and a net figure near zero is the useful signal that a hedging
 * policy is working.
 *
 * `7100` sits in other income rather than in operating expenses, because
 * currency movement is not something the business did. It sold what it sold;
 * the rate moved underneath.
 */

export const FX_ACCOUNTS = {
  gainOrLoss: '7100',
} as const

/**
 * The account FX differences post to, installed on first use.
 *
 * The rule Phase 28 set for `6870` and Phase 34 for `1060`: only ever adding,
 * and only when something is about to need it. A company that never invoices in
 * a foreign currency never gets the account, and its chart stays as short as
 * its business.
 */
export async function ensureFxAccount(ctx: ActorContext, exec: Executor = db): Promise<string> {
  const [existing] = await exec
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.number, FX_ACCOUNTS.gainOrLoss)))
    .limit(1)

  if (existing) return existing.id

  const [created] = await exec
    .insert(chartAccounts)
    .values({
      companyId: ctx.companyId,
      number: FX_ACCOUNTS.gainOrLoss,
      name: 'Foreign Exchange Gain or Loss',
      type: 'other_income',
      description:
        'What currency movement did, as one net figure. Not revenue — nothing more was sold; ' +
        'the rate moved underneath a sale that had already happened.',
    })
    .returning({ id: chartAccounts.id })

  return created.id
}

/** The currency this company keeps its books in. */
export async function functionalCurrency(
  companyId: string,
  exec: Executor = db,
): Promise<string> {
  const [row] = await exec
    .select({ currency: companies.currency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  return normalise(row?.currency ?? 'USD')
}

export type RateInput = {
  baseCurrency: string
  rateDate: string
  rateMillionths: number
  source?: string
}

/**
 * Records a rate, replacing any already on file for that pair and day.
 *
 * A correction replaces rather than sitting alongside: two rows for one day
 * with no rule for choosing between them is how two entries posted on the same
 * morning end up at different rates.
 */
export async function putRate(ctx: ActorContext, input: RateInput) {
  requirePermission(ctx, 'accounting:journal')

  const base = normalise(input.baseCurrency)
  const quote = await functionalCurrency(ctx.companyId)

  if (base === quote) {
    throw new RateError(
      `${base} is this company's own currency. A rate from it to itself is always one.`,
    )
  }

  if (!Number.isFinite(input.rateMillionths) || input.rateMillionths <= 0) {
    throw new RateError('An exchange rate has to be greater than zero.')
  }

  const rateMillionths = Math.round(input.rateMillionths)

  const [row] = await db
    .insert(exchangeRates)
    .values({
      companyId: ctx.companyId,
      baseCurrency: base,
      quoteCurrency: quote,
      rateDate: input.rateDate,
      rateMillionths,
      source: input.source?.trim() || 'entered',
      enteredByUserId: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [
        exchangeRates.companyId,
        exchangeRates.baseCurrency,
        exchangeRates.quoteCurrency,
        exchangeRates.rateDate,
      ],
      set: {
        rateMillionths,
        source: input.source?.trim() || 'entered',
        enteredByUserId: ctx.userId,
      },
    })
    .returning()

  await recordAudit(ctx, {
    action: 'fx.rate_set',
    entityType: 'exchange_rate',
    entityId: row.id,
    after: { pair: `${base}/${quote}`, rateDate: input.rateDate, rate: describeRate(rateMillionths) },
  })

  return row
}

/**
 * The rate to use for a currency on a date.
 *
 * Walks **backwards** to the most recent rate on or before the date asked for,
 * and no further forward than that. A rate published after a transaction
 * happened is not what the transaction happened at, and a business that filled
 * gaps with the next available rate would be restating the past with
 * information it did not have.
 *
 * Returns `RATE_ONE` for the company's own currency without touching the table
 * — a domestic document is not a conversion.
 */
export async function rateFor(
  ctx: ActorContext,
  currency: string,
  onDate: string,
  exec: Executor = db,
): Promise<{ rateMillionths: number; rateDate: string | null; source: string }> {
  const base = normalise(currency)
  const quote = await functionalCurrency(ctx.companyId, exec)

  if (!isForeign(base, quote)) {
    return { rateMillionths: RATE_ONE, rateDate: null, source: 'functional currency' }
  }

  const [row] = await exec
    .select({
      rateMillionths: exchangeRates.rateMillionths,
      rateDate: exchangeRates.rateDate,
      source: exchangeRates.source,
    })
    .from(exchangeRates)
    .where(
      scoped(
        ctx,
        exchangeRates,
        and(
          eq(exchangeRates.baseCurrency, base),
          eq(exchangeRates.quoteCurrency, quote),
          lte(exchangeRates.rateDate, onDate),
        ),
      ),
    )
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1)

  if (!row) {
    // No fallback, deliberately. Quietly using parity turns a €4,000 invoice
    // into a $4,000 one, and nothing downstream ever looks wrong enough for
    // anybody to notice.
    throw new RateError(
      `No ${base}/${quote} rate on file for ${onDate} or before it. Enter one before posting ` +
        'in that currency — guessing parity would book the wrong number and look right.',
    )
  }

  return row
}

/** What a document amount is worth in the books, and at what rate. */
export async function inFunctional(
  ctx: ActorContext,
  input: { amountCents: number; currency: string; onDate: string },
  exec: Executor = db,
): Promise<{ functionalCents: number; rateMillionths: number; currency: string }> {
  const rate = await rateFor(ctx, input.currency, input.onDate, exec)

  return {
    functionalCents: convert(input.amountCents, rate.rateMillionths),
    rateMillionths: rate.rateMillionths,
    currency: normalise(input.currency),
  }
}

export type QuoteResult =
  | { ok: true; quote: DocumentQuote }
  | { ok: false; reason: string }

/**
 * What a document about to be raised will book at — or why it cannot be
 * (Phase 64).
 *
 * ## Why this does not throw
 *
 * `rateFor` throws, and rightly: a posting that cannot honestly convert must
 * stop. But the composer is asking a *question* — "what would this be worth?"
 * — before anybody has committed to anything, and a question whose answer is
 * "no rate on file" is not an exception, it is the answer.
 *
 * Phase 47's rule is that a refusal belongs on the row, not behind a button
 * that fails when pressed. So the missing rate is reported rather than raised,
 * and the composer can say so beside the currency somebody just chose.
 *
 * ## Why the message is not written here
 *
 * The reason is `rateFor`'s own, caught and passed along. Writing a second
 * sentence about a missing rate would give the same question two answers that
 * agree today and drift the first time either is edited — and the one a person
 * sees when a *posting* is refused would stop matching the one they saw when
 * the composer warned them about it.
 */
export async function quoteDocument(
  ctx: ActorContext,
  input: {
    lineCents: number[]
    taxCents?: number
    currency: string
    issueDate: string
  },
  exec: Executor = db,
): Promise<QuoteResult> {
  requirePermission(ctx, 'accounting:view')

  const homeCurrency = await functionalCurrency(ctx.companyId, exec)

  try {
    const rate = await rateFor(ctx, input.currency, input.issueDate, exec)

    return {
      ok: true,
      quote: documentQuote({
        lineCents: input.lineCents,
        taxCents: input.taxCents,
        currency: input.currency,
        homeCurrency,
        rateMillionths: rate.rateMillionths,
        rateDate: rate.rateDate,
      }),
    }
  } catch (error) {
    if (error instanceof RateError) return { ok: false, reason: error.message }
    throw error
  }
}

/**
 * The currencies the composer may offer, and which is home.
 *
 * One call rather than two so the pair cannot be fetched from different
 * moments — a screen that read the home currency, then the rates, and had the
 * company's currency changed in between would offer a list with home missing
 * from it.
 */
export async function currencyChoices(
  ctx: ActorContext,
): Promise<{ homeCurrency: string; offerable: string[] }> {
  requirePermission(ctx, 'accounting:view')

  const [homeCurrency, withRates] = await Promise.all([
    functionalCurrency(ctx.companyId),
    currenciesInUse(ctx),
  ])

  return { homeCurrency, offerable: offerableCurrencies(homeCurrency, withRates) }
}

export type RateRow = {
  id: string
  baseCurrency: string
  quoteCurrency: string
  rateDate: string
  rateMillionths: number
  source: string
}

/** Rates on file, newest first. */
export async function listRates(
  ctx: ActorContext,
  opts: { currency?: string; limit?: number } = {},
): Promise<RateRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: exchangeRates.id,
      baseCurrency: exchangeRates.baseCurrency,
      quoteCurrency: exchangeRates.quoteCurrency,
      rateDate: exchangeRates.rateDate,
      rateMillionths: exchangeRates.rateMillionths,
      source: exchangeRates.source,
    })
    .from(exchangeRates)
    .where(
      scoped(
        ctx,
        exchangeRates,
        opts.currency ? eq(exchangeRates.baseCurrency, normalise(opts.currency)) : undefined,
      ),
    )
    .orderBy(desc(exchangeRates.rateDate), exchangeRates.baseCurrency)
    .limit(opts.limit ?? 100)
}

/** Every currency this company has actually transacted in. */
export async function currenciesInUse(ctx: ActorContext): Promise<string[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .selectDistinct({ currency: exchangeRates.baseCurrency })
    .from(exchangeRates)
    .where(scoped(ctx, exchangeRates))
    .orderBy(exchangeRates.baseCurrency)

  return rows.map((row) => row.currency)
}

export { RATE_ONE, RateError, convert, describeRate, isForeign, normalise } from './rates'
export { revalue, settlementFor, rateFrom, parseRate } from './rates'
export type { Settlement, Revaluation } from './rates'
