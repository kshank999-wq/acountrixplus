import { netPosition, type NetPosition } from './net-position'

/**
 * What currency a movement of money is in (spec §13, §35, Phase 62).
 *
 * ## The defect this exists to fix
 *
 * `recordPayment` works this out on every single payment:
 *
 * ```ts
 * const paymentCurrency = await documentCurrency(ctx, input.kind, input.applications)
 * const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, input.paymentDate)).rateMillionths
 * ```
 *
 * — uses it to fetch the rate, and **never stores it**. The answer is known at
 * the moment the row is written and thrown away, which is the same defect class
 * as Phase 55's `sent_at` written by nothing and Phase 59's `paid` list
 * discarded by a `catch`: a fact the code has and does not keep.
 *
 * The cost is paid five times over. `payments.unapplied_cents` is money a
 * customer overpaid, and five separate queries sum it across a customer's
 * receipts and treat the result as the company's own currency — the customers
 * screen, the chase run, the statement run, the statement itself, and the
 * statement picker. A customer who overpaid a €4,000 invoice by €500 is
 * recorded as having $500 held.
 *
 * ADR 0061 could only work around that. It netted held credit against the
 * home-currency balance alone and said so on the document, because the credit's
 * currency was genuinely unknowable. With the currency kept, the netting can be
 * right instead of merely honest.
 *
 * **Two of the five are fixed by knowing the currency, and three are not.** The
 * statement and the chase decision each net a credit against a *particular*
 * balance, so matching currencies is the whole answer. The customers screen,
 * the statement run's floor and the statements picker want one comparable
 * figure across every currency a party holds — and that needs the payment's
 * rate as well as its currency, which is another column and another backfill.
 * ADR 0062 records that rather than half-doing it here.
 *
 * ## One answer, where there were two
 *
 * `documentCurrency` in `service.ts` decides this for a payment being recorded.
 * `remittance-send.ts` decides it again for a payment being described, as
 * `bills[0]?.currency ?? row.company.currency`. They agree today and nothing
 * makes them keep agreeing — the two-answers defect this project keeps
 * refusing. Both now come through here.
 */

export type SettlementCurrency =
  | { ok: true; currency: string }
  | { ok: false; currencies: string[]; reason: string }

/**
 * The currency a payment settling these documents is in.
 *
 * ## Why an empty list is the company's own currency
 *
 * A payment that settles nothing is a payment on account — money arrived, or
 * money went out, against no particular document. There is no document to read
 * a currency from, and the company's own is the only answer available. It is
 * also the right one in practice: a customer paying in advance pays in the
 * currency they are billed in, and a business billing in one currency has one.
 *
 * ## Why two currencies is a refusal rather than a conversion
 *
 * One payment is one transfer, and a transfer is in one currency. Converting
 * would invent a figure the bank statement will not show. The sentence is the
 * one `documentCurrency` has always thrown, kept word for word so the message a
 * person already knows does not change under them.
 */
export function settlementCurrency(input: {
  documentCurrencies: string[]
  homeCurrency: string
}): SettlementCurrency {
  const distinct = [...new Set(input.documentCurrencies)]

  if (distinct.length === 0) return { ok: true, currency: input.homeCurrency }
  if (distinct.length === 1) return { ok: true, currency: distinct[0] }

  return {
    ok: false,
    currencies: distinct,
    reason:
      `That payment settles documents in ${distinct.join(' and ')}. ` +
      'Record one payment per currency — there is no single amount of money that arrived.',
  }
}

export type HeldCredit = {
  currency: string
  /** What is held, in `currency`. */
  heldCents: number
}

/**
 * What is being held for somebody, split by the currency it is held in.
 *
 * Receipts with nothing left over are dropped rather than kept as zeroes: a
 * currency the business holds nothing in is not a fact worth putting on a
 * statement, and an entry reading "€0.00 held" invites the question of what
 * happened to it.
 */
export function heldByCurrency(
  rows: { currency: string; unappliedCents: number }[],
): HeldCredit[] {
  const totals = new Map<string, number>()

  for (const row of rows) {
    if (row.unappliedCents <= 0) continue
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.unappliedCents)
  }

  return [...totals.entries()]
    .map(([currency, heldCents]) => ({ currency, heldCents }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

export type CurrencyPosition = NetPosition & { currency: string }

/**
 * Phase 54's netting, done once per currency.
 *
 * Composed rather than reimplemented: `netPosition` already decides what is due
 * once credit is set against what is owed, including the clamp that keeps
 * "what should this customer pay" from going negative. Writing that rule a
 * second time per currency would let the two drift, and the single-currency
 * answer this returns has to be identical to the one Phase 54 has given since
 * it was written.
 *
 * A currency appears if the customer owes in it **or** the business holds in
 * it, because both are things somebody needs to see. Holding €500 for a
 * customer who owes nothing in euro is exactly the case Phase 53 built the
 * column for, and dropping it would hide money the business owes back.
 */
export function netByCurrency(
  owed: { currency: string; balanceCents: number }[],
  held: HeldCredit[],
): CurrencyPosition[] {
  const currencies = [
    ...new Set([...owed.map((row) => row.currency), ...held.map((row) => row.currency)]),
  ]

  return currencies
    .map((currency) => ({
      currency,
      ...netPosition({
        owedCents: owed.find((row) => row.currency === currency)?.balanceCents ?? 0,
        heldCents: held.find((row) => row.currency === currency)?.heldCents ?? 0,
      }),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}
