import { RATE_ONE, convert, normalise } from '@/modules/fx/rates'

/**
 * The account where three currencies met (Phase 134).
 *
 * ## What reaches `1250 Payments in Transit`
 *
 * Phase 44 built the clearing account on a three-line story, written at the top
 * of `settlement.ts` and still true:
 *
 * ```
 * Payment captured:  Dr Payments in Transit / Cr Accounts Receivable (gross)
 * Fee taken:         Dr Merchant Fees       / Cr Payments in Transit
 * Payout arrives:    Dr Bank                / Cr Payments in Transit (net)
 * ```
 *
 * Measured, those three lines were not in the same money. `recordPayment`
 * debits `receivedCents` — **converted**, and declared so. `postFee` credits
 * `input.feeCents` and `importPayouts` credits `batch.amountCents` — both the
 * **face** figure, in the customer's currency, posted as though it were the
 * company's own.
 *
 * A €100 card payment on a dollar-keeping business, at 1.10:
 *
 * | Line | What the ledger took | What it should have been |
 * | --- | --- | --- |
 * | Capture | Dr 1250 **$110.00** | $110.00 |
 * | Fee (€5) | Cr 1250 **$5.00** | $5.50 |
 * | Payout (€95) | Cr 1250 **$95.00** | $104.50 |
 *
 * The account is left holding **$10.00** that is not a balance, not a fee and
 * not a gain. It is the difference between one converted posting and two
 * unconverted ones, and no report names it.
 *
 * ## The two declarations that said so
 *
 * `LEDGER_POSTINGS` declares both offenders `domestic`, and both arguments end
 * the same way — `postFee`: "domestic only while the account is, which is a
 * fact about the data rather than about the schema"; `importPayouts`: "domestic
 * only while those agree with the company's own — a fact about the data, not a
 * guarantee from the schema". Both were **corrected in Phase 128**, and both
 * corrections fixed the *description* of where the currency lives while leaving
 * the *posting* unconverted. Phase 133 enforced one half of `importPayouts`'
 * hedge — that the bank account agrees — and left the other half standing.
 *
 * `checkouts.currency` is `row.invoice.currency`, so this is not hypothetical:
 * a euro invoice paid by card produces a euro checkout today.
 *
 * ## Why the clearing account is relieved of what it was charged
 *
 * The rate on the day the customer paid is not the rate three days later when
 * the processor settles. Both are real, and only one of them belongs on each
 * line:
 *
 * - The **bank** takes what actually arrived, at the arrival rate.
 * - The **clearing account** gives up exactly what was put into it, at the
 *   capture rate — because a clearing account that is relieved at a different
 *   rate from the one it was charged at can never reach zero, and reaching zero
 *   is the only thing it is for.
 * - The **difference** is a realised foreign exchange gain or loss, posted as
 *   one. It is Phase 67's rule for retainers — release at the rate the money
 *   was carried at and post the difference — applied to the money a processor
 *   holds instead of the money a client does.
 *
 * `clearedCents` is therefore summed from what each capture and each fee entry
 * *actually posted*, not recomputed from the face figures. Phase 35's rule —
 * convert the parts and total the conversions — and here it is not a nicety:
 * recomputing would leave the account a cent or two short of zero on almost
 * every batch, which is indistinguishable from a real discrepancy.
 */

/** One checkout a payout is settling, as the books already carry it. */
export type CarriedCheckout = {
  /** What the customer was charged, in the customer's currency. */
  grossCents: number
  /** What the processor kept out of it, in the same currency. */
  feeCents: number
  /** The currency both of those are in. */
  currency: string
  /**
   * What the capture actually debited to the clearing account, in the books'
   * money. Read from the posting rather than recomputed, so the relief matches
   * the charge to the cent.
   */
  carriedGrossCents: number
  /** What the fee entry actually credited to it, in the books' money. */
  carriedFeeCents: number
}

export type PayoutSettlement = {
  /** What the processor says it sent, in its own currency. */
  faceCents: number
  /** The currency that figure is in. */
  currency: string
  /** What the bank account actually received, in the books' money. */
  bankCents: number
  /** What comes out of the clearing account: exactly what went in. */
  clearedCents: number
  /**
   * `bankCents` less `clearedCents`. Positive is a gain — the money was worth
   * more when it landed than when it was taken.
   */
  gainCents: number
  /** Whether the processor's figure matches the checkouts behind it. */
  balances: boolean
  /** Face net of the matched checkouts, in their own currency. */
  expectedCents: number
  /** Reported less expected, both face, both the same currency. */
  differenceCents: number
}

export type PayoutOutcome =
  | { ok: true; settlement: PayoutSettlement }
  | { ok: false; why: string }

/**
 * What a payout does to the bank, the clearing account and the profit and loss.
 *
 * `arrivalRateMillionths` is the rate on the day the money landed, `RATE_ONE`
 * when the payout is already in the company's own money — the same parity a
 * domestic bank transaction posts at since Phase 129, so that a domestic
 * business goes through exactly the same arithmetic and gets exactly the
 * figures it got before.
 */
export function payoutSettlement(input: {
  faceCents: number
  currency: string
  items: CarriedCheckout[]
  arrivalRateMillionths: number
}): PayoutOutcome {
  const currency = normalise(input.currency)

  // Two currencies in one batch is not a rate problem — it means the checkouts
  // matched to this payout are not the ones it paid for. Phase 123 refused a
  // mixed-currency deposit for the same reason: the total would be a number in
  // no currency at all, and the honest answer is that the matching is wrong.
  const foreign = input.items.filter((item) => normalise(item.currency) !== currency)
  if (foreign.length > 0) {
    const others = [...new Set(foreign.map((item) => normalise(item.currency)))].sort()
    return {
      ok: false,
      why:
        `This payout is in ${currency}, but ${foreign.length} of the ` +
        `${input.items.length} payments matched to it ${foreign.length === 1 ? 'is' : 'are'} in ` +
        `${others.join(' and ')}. A processor settles one currency per batch, so these payments ` +
        'are matched to the wrong payout rather than the rate being unknown.',
    }
  }

  const expectedCents = input.items.reduce(
    (sum, item) => sum + item.grossCents - item.feeCents,
    0,
  )

  // Both face, both this payout's currency. Before this phase the comparison
  // was the processor's face figure against a sum of checkout figures that
  // could be in another currency entirely — a difference nobody could act on.
  const differenceCents = input.faceCents - expectedCents

  // What the two earlier entries actually moved, totalled. Not recomputed:
  // see the note above on why the parts are summed rather than the sum
  // converted.
  const clearedCents = input.items.reduce(
    (sum, item) => sum + item.carriedGrossCents - item.carriedFeeCents,
    0,
  )

  const bankCents = convert(input.faceCents, input.arrivalRateMillionths)

  return {
    ok: true,
    settlement: {
      faceCents: input.faceCents,
      currency,
      bankCents,
      clearedCents,
      gainCents: bankCents - clearedCents,
      balances: differenceCents === 0,
      expectedCents,
      differenceCents,
    },
  }
}

/**
 * What one capture put into the clearing account and what its fee took out.
 *
 * The capture and the fee are two entries posted at the same moment on the same
 * rate, so they are converted together here rather than each guessing. A
 * domestic checkout passes `RATE_ONE` and gets its face figures back unchanged,
 * which is why every company that has ever used this feature is untouched.
 */
export function carriedFor(input: {
  grossCents: number
  feeCents: number
  currency: string
  captureRateMillionths: number
}): CarriedCheckout {
  return {
    grossCents: input.grossCents,
    feeCents: input.feeCents,
    currency: normalise(input.currency),
    carriedGrossCents: convert(input.grossCents, input.captureRateMillionths),
    carriedFeeCents: convert(input.feeCents, input.captureRateMillionths),
  }
}

/** Parity, for a payout already in the company's own money. */
export const PARITY = RATE_ONE
