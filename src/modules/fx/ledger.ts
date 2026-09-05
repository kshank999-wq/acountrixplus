/**
 * What money the ledger will accept (Phase 127).
 *
 * ## The defect
 *
 * The ledger is kept in one currency. Every balance, every report, every check
 * reads it as the company's own money — that is what *functional* means. So a
 * face amount reaching `debitCents` or `creditCents` is not a rounding
 * question. It is a number in the wrong currency, posted, and it stays.
 *
 * Two writes did it, and both were found by measuring rather than by looking:
 *
 * ```
 * recoverWriteOff   Dr Bank / Cr Bad Debt  input.amountCents   ← the invoice's face
 * createDeposit     Dr Bank                totalCents          ← the receipts' face
 *                   Cr Undeposited Funds   receiptsCents       ← the receipts' face
 * ```
 *
 * Neither is theoretical. Written out on the test database:
 *
 * - A €2,500 invoice is written off. `writeOffInvoice` converts correctly and
 *   posts the functional **$2,750** to bad debt. The debt is then recovered *in
 *   full*, and the recovery posts **$2,500** — the euros, as if they were
 *   dollars. **$250 of bad-debt expense is stranded on the profit and loss
 *   forever**, and the bank is debited a figure that is neither what arrived
 *   nor what it was worth. Meanwhile `badDebtSummary` reports `netCents: 0`.
 *   Two answers to one question, which is this codebase's oldest named defect.
 *
 * - A €500 receipt debits Undeposited Funds **$550** when `recordPayment` takes
 *   it. Banking it credits Undeposited Funds **$500**. **$50 sits in a clearing
 *   account nothing will ever clear**, and the bank is short by the same.
 *
 * ## Why the two are one defect
 *
 * ADR 0126 nominated giving `invoice_write_offs` and `deposits` a currency
 * column, as the last two thirds of ADR 0125's `unrecorded` gap. That framing
 * made them a tidiness exercise — write down a denomination nobody had written
 * down. Measuring found why the column matters: **neither write had a
 * functional figure to post because neither table kept one.** The missing
 * column is not the defect, it is the reason the defect could not be fixed
 * locally.
 *
 * ## The vocabulary was already there
 *
 * Reading all 189 posting sites in `src/modules` and narrowing to the 81 in
 * files that read a currency-bearing table, the convention is unmistakable.
 * Money that reaches the ledger is called `functionalCents`, `receivedCents`,
 * `carriedCents`, `relievedCents`, `realisedCents`, `paidCents`, `lossCents` —
 * the vocabulary of a conversion that has happened. The two defects are the
 * only sites posting something still named after a document's own amount.
 *
 * So the rule is checkable by reading the source, which is what
 * `tests/ledger-postings.test.ts` does. The entries below are what makes it
 * decidable: every posting symbol says which basis its money is on and argues
 * it from where the number comes from, on the pattern Phase 122 set for sums,
 * Phase 123 for their forms and Phase 124 for money crossing to a screen.
 */

/** Why the money at a posting site is the company's own. */
export type PostingBasis =
  /**
   * A face amount was converted before it got here.
   *
   * The commonest and the only one that needs arithmetic. The entry names the
   * expression, so a later edit that posts the unconverted twin fails the scan
   * rather than the reconciliation.
   */
  | 'converted'
  /**
   * The money cannot be foreign at this site, argued from the schema.
   *
   * A till float, a gift card, an imported opening balance, a card processor's
   * fee: none of the tables behind them carries a currency, so the figure is
   * the company's own by construction rather than by conversion. Not a synonym
   * for "probably fine" — the entry has to say which table settles it.
   */
  | 'domestic'
  /**
   * It is already ledger money, being read rather than posted.
   *
   * `cash-basis.ts` selects `journalLines.debitCents` to re-derive a report.
   * The scan sees the same property name; the entry records that nothing here
   * writes a journal line at all.
   */
  | 'ledger'

/** One function that puts money into the ledger, or reads it back out. */
export type LedgerPosting = {
  /** Module file, repo-relative. */
  file: string
  /** The enclosing function. */
  symbol: string
  basis: PostingBasis
  /** Why, argued from where the number comes from. */
  because: string
  /**
   * Expressions at this site that are domestic even though the symbol is not.
   *
   * One function can legitimately post both. `createDeposit` posts converted
   * receipts beside a line somebody typed against a chart account, and a chart
   * account has no currency — so demanding a conversion of the second would be
   * a second wrong answer rather than a fix. The same shape as Phase 124's
   * `fields` narrowing, and the exemption has to name itself in `because` and
   * point at an expression the scan really finds.
   */
  alsoDomestic?: readonly string[]
}

/**
 * Every posting site in a module that also reads a currency-bearing table.
 *
 * The narrowing is Phase 123's and it is what makes this a list somebody can
 * actually read: 189 posting sites in `src/modules`, 81 of them in files that
 * touch `invoices`, `bills`, `credit_notes`, `payments`, `retainers`, the two
 * recurring-billing tables, `invoice_write_offs` or `deposits`. A payroll run
 * or a depreciation schedule posts money too, and nothing in its file can be
 * foreign, so demanding an argument there would be noise.
 */
export const LEDGER_POSTINGS: readonly LedgerPosting[] = [
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'that',
    basis: 'converted',
    because:
      'Raising an invoice. `functionalTotalCents`, `functionalLineCents`, `functionalRetainageCents` ' +
      'and `functionalTaxCents` are computed line by line from the document rate, because ' +
      'converting the total and spreading it would leave the entry a cent out (Phase 35).',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'createBill',
    basis: 'converted',
    because:
      'The payables twin of raising an invoice, and the same arithmetic: each line converted at ' +
      'the bill’s own rate, the total taken as the sum of the converted lines rather than the ' +
      'conversion of the summed face amounts.',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'recordPayment',
    basis: 'converted',
    because:
      '`receivedCents` is what hit the bank, `carriedCents` what the documents were carried at, ' +
      '`heldFunctionalCents` the remainder held, and `fxCents` the difference the two rates make ' +
      '— the realised gain or loss. Every one of the four is converted; the face `input.amountCents` ' +
      'is stored on the payment and never posted.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'createCreditNote',
    basis: 'converted',
    because:
      'A credit note reverses a document, and Phase 63 settled that it must do so by the same ' +
      'arithmetic that raised it. `functional.lineCents`, `functional.functionalTotalCents` and ' +
      '`functional.functionalTaxCents` all come from `fx/denomination.ts`, which is that shared rule.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'writeOffInvoice',
    basis: 'converted',
    because:
      '`lossCents` is `relieveFunctional(invoice, amountCents).functionalCents` — the home amount ' +
      'the books were carrying, at the rate the invoice was raised at. Re-converting at today’s ' +
      'rate would fold a currency movement into bad debt, which nobody decided to recognise.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'recoverWriteOff',
    basis: 'converted',
    because:
      'Repaired in Phase 127. It posted `input.amountCents` — the invoice’s face amount — against ' +
      'a bad-debt expense that `writeOffInvoice` had raised in functional money, so a fully ' +
      'recovered €2,500 write-off left $250 of loss on the books permanently. `recovery.functionalCents` ' +
      'relieves the write-off’s own carried figure, and takes the whole remainder on the last of it.',
  },
  {
    file: 'src/modules/receivables/customer-credit.ts',
    symbol: 'converted',
    basis: 'converted',
    because:
      'Applying held customer credit. `settlement.releasedCents`, `relievedCents` and `realisedCents` ' +
      'come from the held-money settlement core: the credit was carried at the rate it arrived at, ' +
      'the invoice at the rate it was raised at, and the gap between them is the realised difference.',
  },
  {
    file: 'src/modules/receivables/customer-credit.ts',
    symbol: 'refundCredit',
    basis: 'converted',
    because:
      'Giving held money back. `paidCents` is `convert(input.amountCents, rateMillionths)` at the ' +
      'rate on the day the money leaves, which is what the bank will actually show; the difference ' +
      'from what was carried is `settlement.realisedCents` rather than a silent rounding.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'createVendorCredit',
    basis: 'converted',
    because:
      'The payables mirror of a credit note, through the same `fx/denomination.ts` rule — so a ' +
      'vendor credit reverses a bill by the arithmetic that raised it rather than a second one.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'refundVendorCredit',
    basis: 'converted',
    because:
      'A supplier giving money back. `recovery.receivedCents`, `relievedCents` and `realisedCents` ' +
      'are the same settlement shape as a customer refund, deliberately: Phase 68 made a refund one ' +
      'record with one rule rather than three near-copies.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'receiveRetainer',
    basis: 'converted',
    because:
      '`functionalCents` is the retainer converted at the rate the money arrived at, and stored ' +
      'beside the face amount so that later draws relieve what the books carry rather than ' +
      'recomputing it (Phase 66).',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'applyRetainerWithin',
    basis: 'converted',
    because:
      'Drawing against a retainer, through the same settlement core as customer credit. Phase 66 ' +
      'found neither rate needed choosing: the retainer is carried at the rate it arrived at, the ' +
      'invoice at the rate it was raised at, and the gap is realised rather than hidden.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'refundRetainer',
    basis: 'converted',
    because:
      'Giving a retainer back. `paidCents` converts at the day the money leaves and ' +
      '`settlement.realisedCents` carries the difference from what was held — the rule Phase 67 ' +
      'settled so that held money has exactly one way back.',
  },
  {
    file: 'src/modules/banking/deposits.ts',
    symbol: 'createDeposit',
    basis: 'converted',
    because:
      'Repaired in Phase 127. It posted `totalCents` and `receiptsCents`, both sums of face ' +
      'amounts, against an Undeposited Funds balance that `recordPayment` had debited in functional ' +
      'money — so banking a €500 receipt left $50 in a clearing account nothing could clear. It now ' +
      'posts `functionalTotalCents` and `functionalReceiptsCents`, each receipt converted at its own ' +
      'recorded rate rather than one rate for the batch. `item.amountCents` is a non-receipt line ' +
      'typed against a chart account, which has no currency — and this phase’s own scanner caught ' +
      'that a foreign batch could still add one to euros, so `createDeposit` now refuses the ' +
      'combination outright instead of converting a figure the bank will never show.',
    alsoDomestic: ['item.amountCents'],
  },
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'completeAppointment',
    basis: 'domestic',
    because:
      '`split.practitionerCents` is a commission split of an appointment price. `appointments` and ' +
      '`appointment_services` carry no currency column, and the invoice this raises goes through ' +
      '`createInvoice`, which converts on its own — this line is the practitioner’s share of a ' +
      'domestic price.',
  },
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'sellGiftCard',
    basis: 'domestic',
    because:
      '`gift_cards` has no currency column and no functional twin. A card is sold and redeemed in ' +
      'the company’s own money by construction, which is why Phase 31 could make it a payment ' +
      'rather than a bare credit without asking what it was denominated in.',
  },
  {
    file: 'src/modules/appointments/service.ts',
    symbol: 'redeemGiftCard',
    basis: 'domestic',
    because:
      '`plan.appliedCents` comes from `redeemFor(balanceCents, dueCents)`, over a gift-card balance ' +
      'that has no currency column. The same construction as selling one: a card cannot be foreign, ' +
      'so there is nothing to convert.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'openShift',
    basis: 'domestic',
    because:
      'A till float. `drawers` and `drawer_shifts` carry no currency column, and a physical drawer ' +
      'holds one currency by the nature of being a drawer — the notes in it are the ones the ' +
      'business trades in.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'payOut',
    basis: 'domestic',
    because:
      'Cash out of the same drawer, and the same argument: the money is physically in the till, in ' +
      'the currency the till holds, and no table in the module records another one.',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'closeShift',
    basis: 'domestic',
    because:
      '`position.toBankCents`, `drawerCredit` and `position.overShortCents` are a counted drawer ' +
      'against what it should hold. Counting notes produces the currency of the notes; the over/short ' +
      'that Phase 34 posts is the difference between two figures already in it.',
  },
  {
    file: 'src/modules/importing/opening-balances.ts',
    symbol: 'commitTrialBalanceImport',
    basis: 'domestic',
    because:
      'An opening trial balance is the company’s own books being carried over, so `line.amountCents` ' +
      'and the `plugCents` balancing figure are functional by definition — there is no second ' +
      'currency for a trial balance to be in.',
  },
  {
    file: 'src/modules/importing/opening-balances.ts',
    symbol: 'commitOpenDocumentImport',
    basis: 'domestic',
    because:
      'Imported open documents are home-currency only, and the file says so where it writes them: ' +
      '"the rate is one and the functional figure *is* the face figure". Phase 117 made that ' +
      'explicit by storing the functional twin rather than leaving it zero.',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'postFee',
    basis: 'domestic',
    because:
      'A card processor’s fee. **Corrected in Phase 128**: this said `financial_accounts` carries ' +
      'no currency column, which is false and has been since the banking schema was written. ' +
      '`checkouts.currency` records what the customer was asked to pay and the processor charges ' +
      'its fee in the same, so `input.feeCents` is that currency — domestic only while the account ' +
      'is, which is a fact about the data rather than about the schema.',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'importPayouts',
    basis: 'domestic',
    because:
      '`batch.amountCents` is what the processor says it paid into a bank account, in the currency ' +
      '`payouts.currency` records. **Corrected in Phase 128**: the entry said nothing recorded ' +
      'another currency, and both `payouts` and the `financial_accounts` row it lands in do. ' +
      'Domestic only while those agree with the company’s own — a fact about the data, not a ' +
      'guarantee from the schema.',
  },
  {
    file: 'src/modules/ledger/posting.ts',
    symbol: 'buildLines',
    basis: 'converted',
    because:
      'Where money first enters the books, and the largest instance of Phase 127’s defect — which ' +
      'Phase 127 could not see, because its list of currency-bearing tables was typed by hand and ' +
      'left `financial_accounts` out. `bank_transactions` has no currency of its own and inherits ' +
      'the account’s, so `Math.abs(amountCents)` put euros into a dollar ledger on every ' +
      'categorised transaction of every foreign account. `toBooks` converts at the rate on the day ' +
      'the money moved, and `rateFor` refuses rather than guessing when none covers it. Since ' +
      'Phase 129 that rate is **read** from the transaction when it has already posted, and only ' +
      'asked for once: posting is idempotent by voiding and re-posting, so re-deriving it made ' +
      're-categorising silently restate what the movement was worth.',
  },
  {
    file: 'src/modules/ledger/posting.ts',
    symbol: 'syncLedgerForTransferPair',
    basis: 'converted',
    because:
      'The same conversion for a transfer, plus a refusal the single-leg case does not need: one ' +
      'magnitude posts to both legs, which is only a movement of money if both accounts hold the ' +
      'same currency. Between a euro account and a dollar one the bank takes one amount out and ' +
      'puts a different one in, and that difference is a realised gain nobody has decided to ' +
      'recognise — so it is two transactions, not one (Phase 117, and Phase 123’s deposit).',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'recordContribution',
    basis: 'domestic',
    because:
      'A donation, typed against a fund. `contributions` and `funds` carry no currency column — ' +
      'restriction is about what money may be spent on rather than what it is denominated in ' +
      '(Phase 26) — so the figure is the company’s own by construction. Newly in reach of this ' +
      'scan in Phase 128, which is the first time anybody asked.',
  },
  {
    file: 'src/modules/funds/contributions.ts',
    symbol: 'receivePledge',
    basis: 'domestic',
    because:
      'A promise to give, recognised when it is made rather than when it arrives. Same ' +
      'construction as the contribution it becomes: no table in the funds module records a ' +
      'currency, so a pledge is in the company’s own money and there is nothing to convert.',
  },
  {
    file: 'src/modules/payroll/remittance.ts',
    symbol: 'recordRemittance',
    basis: 'domestic',
    because:
      'Paying over what was withheld. No payroll table carries a currency — a payroll run is ' +
      'computed by a provider in the jurisdiction the company files in — so the liability and the ' +
      'payment that clears it are both the books’ money. Reached by this scan only because the ' +
      'module reads `financial_accounts` to find the bank it pays from.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'receiveDeposit',
    basis: 'domestic',
    because:
      'A security deposit is somebody else’s money held against a lease (Phase 23), and neither ' +
      '`leases` nor the deposit tables record a currency. The figure is the company’s own; the ' +
      'module reaches this scan through the bank account it is banked into, which does have one.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    basis: 'domestic',
    because:
      'Giving the deposit back, against the same liability it created. Same construction and the ' +
      'same tables: what was held is what is returned, in the currency it was held in, and no ' +
      'row in the properties module records that as anything but the company’s own.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'applyDeposit',
    basis: 'domestic',
    because:
      'Keeping some of the deposit against what the tenant owes, which turns held money into ' +
      'revenue. The lease it is applied to carries no currency either, so both sides of the entry ' +
      'are the books’ money and the deduction needs no conversion.',
  },
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'accrualPlan',
    basis: 'ledger',
    because:
      'Selects `journalLines.debitCents` and `creditCents` to work out what an accrual-basis entry ' +
      'would have to become on a cash basis. It reads posted lines and writes none, so the property ' +
      'names match the scan without any money moving.',
  },
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'scaleSigned',
    basis: 'ledger',
    because:
      'A helper that scales an already-posted debit or credit by a settled proportion. Its operands ' +
      'are ledger money by the time it sees them, and it returns a number rather than posting one.',
  },
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'cashBasisBalances',
    basis: 'ledger',
    because:
      'Re-derives balances from posted journal lines, adding `delta.debitCents` and ' +
      '`delta.creditCents` that `accrualPlan` produced from the same lines. Nothing here is a ' +
      'journal entry input.',
  },
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'isBankish',
    basis: 'ledger',
    because:
      'A predicate deciding whether an account behaves like cash for the purpose of the restatement. ' +
      'It matches the scan only because its parameter is typed against a journal line; it posts ' +
      'nothing and returns a boolean.',
  },
]

/**
 * The declared basis for one posting site.
 *
 * Throws on an undeclared one, which is the whole point: a new place that puts
 * money into the ledger from a file that touches a document table has to say
 * what currency that money is in before the test will go green. Phase 101 set
 * this shape — a lookup that refuses is a question somebody must answer, where
 * a lookup that returns `undefined` is one they can walk past.
 */
export function ledgerPostingFor(file: string, symbol: string): LedgerPosting {
  const found = LEDGER_POSTINGS.find((row) => row.file === file && row.symbol === symbol)

  if (!found) {
    throw new Error(
      `No ledger posting basis is declared for ${symbol} in ${file}. ` +
        'Money reaching debitCents or creditCents is the company’s own money — say why this ' +
        'is, in src/modules/fx/ledger.ts, or convert it first.',
    )
  }

  return found
}

/**
 * What a recovery of a written-off debt is worth in the books.
 *
 * ## The shape, and why it is not new
 *
 * This is `relieveFunctional`'s question asked about a write-off instead of an
 * invoice: relieve a carried functional figure by a face amount, at the rate it
 * was carried at, and take the whole remainder on the last of it. The same two
 * reasons apply and neither is about elegance.
 *
 * **At the write-off's own rate**, not today's. `writeOffInvoice` posts the
 * loss the books were carrying, and its comment says converting at a later rate
 * would fold a currency movement into bad debt. A recovery reverses that
 * posting, so it has to reverse the figure that was posted.
 *
 * **The whole remainder on a full recovery**, not a computed one. Six-decimal
 * rounding on three part-recoveries does not necessarily sum back to what was
 * written off, and the residue would sit in bad debt looking exactly like the
 * defect this phase exists to fix.
 */
export function recoveryFunctional(
  writeOff: {
    /** The invoice's own amount that was written off. */
    amountCents: number
    /** What the books carry for it — what `writeOffInvoice` posted. */
    functionalAmountCents: number
    /** Already recovered before this one, both sides. */
    recoveredCents: number
    functionalRecoveredCents: number
  },
  recoveredFaceCents: number,
): { functionalCents: number } {
  const outstandingFace = writeOff.amountCents - writeOff.recoveredCents
  const outstandingFunctional =
    writeOff.functionalAmountCents - writeOff.functionalRecoveredCents

  // The last of it takes what is left, so nothing is stranded.
  if (recoveredFaceCents >= outstandingFace) return { functionalCents: outstandingFunctional }

  // No rate parameter, deliberately. The pair the write-off stores *is* the
  // rate it was carried at, and a rate passed in beside them is a second answer
  // to the same question — the defect Phase 116 removed from `fx.conversions`
  // by making it read the pair that moves rather than recompute it.
  return {
    functionalCents: Math.round(
      (recoveredFaceCents * writeOff.functionalAmountCents) / writeOff.amountCents,
    ),
  }
}
