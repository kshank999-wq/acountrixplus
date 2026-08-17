/**
 * A day's takings, turned into one balanced entry (spec §5).
 *
 * Two industry rows at once: Restaurant/Food Service asks for "POS imports,
 * tips, daily sales summaries", and E-commerce asks for "marketplace/payment
 * processor feeds, fees, returns". They are the same shape — a day's trading
 * arrives as a summary from somebody else's system, and has to become
 * double-entry — so they are one module rather than two.
 *
 * A pure core, with no database and no clock, for the reason every phase since
 * Phase 16 has had one: this is the arithmetic somebody disputes, and here the
 * dispute is usually with a manager who is certain the till was right.
 *
 * ## The claims this file makes true
 *
 * **Gross, not net.** A processor that deposits £940 on £1,000 of sales did not
 * make £940 of sales. Booking the deposit loses the revenue *and* the fee, and
 * it is the single commonest way a small e-commerce business ends up with a
 * profit and loss that cannot be reconciled to anything.
 *
 * **The till is counted, and the difference is named.** What the register says
 * it took and what is actually in the drawer are two numbers, and where they
 * differ the difference goes to Cash Over and Short. A summary that balances by
 * quietly adjusting cash is a summary that hides theft.
 *
 * **Tips are somebody else's money.** Collected from a customer on a member of
 * staff's behalf, owed to them, and never the restaurant's revenue.
 */

/** One revenue category as the till reports it. */
export type SalesCategory = {
  /** Chart account number the category posts to: '4030' for food. */
  accountNumber: string
  /** Gross, before discount and before tax. Never negative. */
  amountCents: number
}

/** How the money arrived. */
export type Tender = {
  /**
   * `cash` is counted; everything else settles through a clearing account.
   *
   * The distinction is not cosmetic: cash is the only tender that can be
   * miscounted, and the only one whose discrepancy is a fact about a person
   * rather than about a bank.
   */
  kind: 'cash' | 'card' | 'other'
  /** What the till says was taken on this tender, including tax and tips. */
  amountCents: number
  /**
   * What the processor kept. Zero for cash.
   *
   * Recorded per tender rather than as one figure, because a business taking
   * card and a marketplace at different rates needs to see which is expensive.
   */
  feeCents: number
}

export type DayInput = {
  /** `YYYY-MM-DD`. The trading day, which is not always the calendar day. */
  businessDate: string
  categories: SalesCategory[]
  /** Sales tax collected. A liability, never revenue. */
  taxCents: number
  /** Tips taken on the customer's behalf. A liability, never revenue. */
  tipsCents: number
  /** Money given back for returns. Reduces revenue rather than being a cost. */
  refundsCents: number
  /**
   * Discounts allowed.
   *
   * Reported separately rather than netted off the categories, because "we sold
   * £5,000 and gave £400 away" and "we sold £4,600" are different facts and only
   * the first can be managed.
   */
  discountsCents: number
  tenders: Tender[]
  /**
   * What was actually in the drawer, if anybody counted it.
   *
   * Null means nobody counted — which is a real and common state, and is not
   * the same as counting and finding it exact. A null produces no over/short
   * line at all; a zero difference produces none either, but for a reason
   * somebody can point at.
   */
  countedCashCents: number | null
  /** Float left in the drawer overnight, excluded from the count. */
  floatCents: number
}

export type PlanLine = {
  accountNumber: string
  debitCents: number
  creditCents: number
  memo: string
}

export type DayPlan = {
  businessDate: string
  lines: PlanLine[]
  /** Gross sales before discounts, tax and tips. */
  grossSalesCents: number
  /** What the day actually earned: gross, less discounts and refunds. */
  netSalesCents: number
  taxCents: number
  tipsCents: number
  feeCents: number
  /** What the tills say was taken, across every tender. */
  takingsCents: number
  /**
   * Counted cash less expected cash. Negative is short.
   *
   * Null when nobody counted.
   */
  overShortCents: number | null
  /**
   * What the summary itself does not add up to.
   *
   * Non-zero means the POS export is internally inconsistent — its tenders do
   * not equal its sales plus tax plus tips less discounts and refunds. That is
   * a fact about the export rather than about the business.
   *
   * It gets its own line, to `1220 POS Import Suspense`, and its own figure on
   * the day row. Both are deliberate. An entry has to balance, so the choice is
   * never "plug or don't" — it is *which account absorbs it*, and the only
   * dishonest answers are the ones that hide it inside cash or revenue. A
   * suspense account says "this much of this day is unexplained" in the one
   * place somebody is obliged to look, and stays on the balance sheet until it
   * is cleared.
   */
  outOfBalanceCents: number
}

/** Accounts the plan posts to, by their conventional numbers. */
export const POS_ACCOUNTS = {
  cash: '1050',
  processorClearing: '1210',
  salesTaxPayable: '2200',
  tipsPayable: '2310',
  discounts: '4900',
  refunds: '4930',
  processorFees: '6860',
  cashOverShort: '6870',
  suspense: '1220',
} as const

/**
 * Turns a day into balanced lines.
 *
 * ## Where everything goes
 *
 * ```
 *   Cash counted              Dr Petty Cash / till
 *   Card and other tenders    Dr Payment Processor Clearing   (net of fees)
 *   Processor fees            Dr Marketplace and Platform Fees
 *   Cash over or short        Dr or Cr Cash Over and Short
 *   Discounts allowed         Dr Discounts and Refunds
 *   Refunds given             Dr Returns and Refunds
 *                                 Cr Food Sales, Beverage Sales, …
 *                                 Cr Sales Tax Payable
 *                                 Cr Tips Payable
 * ```
 *
 * Note what is *debited*: the clearing account takes the **net** deposit and
 * the fee is debited separately, so the credit side still carries the full
 * gross. That is the whole of "gross, not net" in two lines.
 */
export function summariseDay(input: DayInput): DayPlan {
  const grossSalesCents = input.categories.reduce((sum, row) => sum + row.amountCents, 0)
  const netSalesCents = grossSalesCents - input.discountsCents - input.refundsCents

  const feeCents = input.tenders.reduce((sum, tender) => sum + tender.feeCents, 0)
  const takingsCents = input.tenders.reduce((sum, tender) => sum + tender.amountCents, 0)

  const cashTakingsCents = input.tenders
    .filter((tender) => tender.kind === 'cash')
    .reduce((sum, tender) => sum + tender.amountCents, 0)

  // The float is not takings — it was in the drawer yesterday and will be
  // there tomorrow — so it comes off the count before the comparison.
  const overShortCents =
    input.countedCashCents === null
      ? null
      : input.countedCashCents - input.floatCents - cashTakingsCents

  const lines: PlanLine[] = []

  const nonCash = input.tenders.filter((tender) => tender.kind !== 'cash')
  const nonCashGross = nonCash.reduce((sum, tender) => sum + tender.amountCents, 0)
  const nonCashFees = nonCash.reduce((sum, tender) => sum + tender.feeCents, 0)
  // Cash fees are unusual but a cash-handling charge exists, and it comes off
  // the deposit rather than out of the drawer — so it reduces what is banked
  // without touching what was counted.
  const cashFees = feeCents - nonCashFees

  // --- What came in -------------------------------------------------------
  //
  // Cash is banked at what was *counted*, not at what the till claimed. The
  // books should say what is actually there; the difference is the next line.
  const bankedCashCents = cashTakingsCents + (overShortCents ?? 0) - cashFees
  if (bankedCashCents !== 0) {
    lines.push(line(POS_ACCOUNTS.cash, bankedCashCents, 'Cash taken'))
  }

  if (nonCashGross - nonCashFees !== 0) {
    lines.push(
      line(
        POS_ACCOUNTS.processorClearing,
        nonCashGross - nonCashFees,
        'Card and other tenders, net of fees',
      ),
    )
  }

  if (nonCashFees !== 0) {
    lines.push(line(POS_ACCOUNTS.processorFees, nonCashFees, 'Processor and platform fees'))
  }

  if (cashFees !== 0) {
    lines.push(line(POS_ACCOUNTS.processorFees, cashFees, 'Cash handling charges'))
  }

  if (overShortCents !== null && overShortCents !== 0) {
    // Debit when short (the money is gone), credit when over.
    lines.push(
      line(
        POS_ACCOUNTS.cashOverShort,
        -overShortCents,
        overShortCents < 0 ? 'Till short' : 'Till over',
      ),
    )
  }

  // --- What it was for ----------------------------------------------------
  for (const category of input.categories) {
    if (category.amountCents !== 0) {
      lines.push(line(category.accountNumber, -category.amountCents, 'Sales'))
    }
  }

  if (input.discountsCents !== 0) {
    lines.push(line(POS_ACCOUNTS.discounts, input.discountsCents, 'Discounts allowed'))
  }

  if (input.refundsCents !== 0) {
    lines.push(line(POS_ACCOUNTS.refunds, input.refundsCents, 'Refunds given'))
  }

  if (input.taxCents !== 0) {
    lines.push(line(POS_ACCOUNTS.salesTaxPayable, -input.taxCents, 'Sales tax collected'))
  }

  if (input.tipsCents !== 0) {
    lines.push(line(POS_ACCOUNTS.tipsPayable, -input.tipsCents, 'Tips owed to staff'))
  }

  // --- Does the export itself add up? -------------------------------------
  //
  // Everything the tills say they took, against everything that was sold plus
  // what was collected on somebody else's behalf. A difference is the POS
  // export contradicting itself.
  //
  // The temptation is to refuse the day. That is worse than it sounds: a
  // restaurant whose till software is out by 5p would be unable to record that
  // it traded at all, and the answer in practice is that somebody keys the day
  // in by hand and the discrepancy vanishes without ever being seen. So the
  // day posts, and the difference goes somewhere it cannot be missed.
  const expectedTakings = netSalesCents + input.taxCents + input.tipsCents
  const outOfBalanceCents = takingsCents - expectedTakings

  if (outOfBalanceCents !== 0) {
    lines.push(
      line(
        POS_ACCOUNTS.suspense,
        -outOfBalanceCents,
        outOfBalanceCents > 0
          ? 'Unexplained: the tills took more than the day sold'
          : 'Unexplained: the day sold more than the tills took',
      ),
    )
  }

  return {
    businessDate: input.businessDate,
    lines,
    grossSalesCents,
    netSalesCents,
    taxCents: input.taxCents,
    tipsCents: input.tipsCents,
    feeCents,
    takingsCents,
    overShortCents,
    outOfBalanceCents,
  }
}

/** Positive is a debit, negative a credit. One place, so no sign is guessed twice. */
function line(accountNumber: string, signedCents: number, memo: string): PlanLine {
  return {
    accountNumber,
    debitCents: signedCents > 0 ? signedCents : 0,
    creditCents: signedCents < 0 ? -signedCents : 0,
    memo,
  }
}

/**
 * Debits less credits. Zero on every plan this function can produce.
 *
 * Which is the point of asserting it: it is not a check on the data — the data
 * is allowed to be wrong, and `outOfBalanceCents` is where that is said — but a
 * check on this file. A non-zero result means the arithmetic above has a
 * defect, and posting it would put an unbalanced entry in the ledger.
 */
export function planImbalanceCents(plan: DayPlan): number {
  return plan.lines.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0)
}
