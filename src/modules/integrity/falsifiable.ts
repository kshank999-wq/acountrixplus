/**
 * How each check can be made to fail (Phase 121).
 *
 * ## The defect
 *
 * The register declares a great deal about each check: what it **compares**,
 * what a difference **means**, how far back it **reaches** and why (Phase 109,
 * verified in Phase 110). It has never declared the one thing that decides
 * whether a check is worth having: **what would make it disagree.**
 *
 * Measured across the twenty, by searching every test for an assertion that a
 * given check reports `agrees: false`:
 *
 * ```
 * proven to disagree at least once   7
 * only ever seen to agree           13
 * ```
 *
 * A check that has only ever been seen to agree is not a check. It is a green
 * light with no wiring behind it, and this codebase has already been bitten by
 * exactly that, twice:
 *
 * - **Phase 115.** `receivables.customer_credit` summed held amounts in the
 *   currency each payment was taken in and compared the total against a
 *   functional-currency ledger balance. It had agreed for eighty phases,
 *   because every set of books it had ever run against was single-currency.
 * - **Phase 117.** `inventory.goods_received` reconciles `2050` against goods
 *   receipt rows, and the project's own seed had been crediting `2000` on four
 *   receipts since it was written. The check was right; nothing had ever put a
 *   difference in front of it on the companies anybody looked at.
 *
 * Both were found by accident, years of phases apart. A declared falsifier plus
 * a test that applies it turns that into something the suite asks every run.
 *
 * ## The shape most of them share
 *
 * Seventeen of the twenty compare a subledger sum against **one named ledger
 * account**. For those the falsifier is the same act, and it is the act the
 * check exists to catch: **post a hand-written journal entry straight at the
 * control account.** ADR 0033 put it plainly — *nothing legitimately moves a
 * control account except a document* — so an entry that moves it with no
 * document behind it is precisely the difference the check must see.
 *
 * The other three do not compare a balance at all, and each says so.
 *
 * Nineteen, not twenty, since Phase 122 retired `banking.shared_ledger_accounts`
 * — the one no falsifier could reach, because a unique index added in the same
 * commit as the check made its subject impossible.
 */

/** What must make one check disagree, and why that is the thing worth proving. */
export type Falsifier = {
  /** The register key this falsifies. */
  key: string
  /** The single change to a set of books that must flip `agrees` to false. */
  how: string
  /** Why this is the change worth proving, in the terms of the books. */
  because: string
  /**
   * The ledger account a hand-written entry lands on to break this check, for
   * the checks that reconcile a subledger against one account.
   *
   * `null` where the check compares something that is not a ledger balance —
   * a count of rows, a column against the rows behind it, or two subledgers
   * against each other. Those three carry their falsifier entirely in `how`.
   */
  account: string | null
}

export const FALSIFIERS: readonly Falsifier[] = [
  {
    key: 'ledger.receivables',
    account: '1100',
    how: 'Post a manual journal entry that debits 1100 with no invoice behind it.',
    because:
      'The founding case, and the one ADR 0031 was written about: the balance sheet says money ' +
      'is owed and the aging report says nothing is. Anything that moves the control account ' +
      'without a document is the difference this check exists to name.',
  },
  {
    key: 'ledger.payables',
    account: '2000',
    how: 'Post a manual journal entry that credits 2000 with no bill behind it.',
    because:
      'The same failure from the other side, and Phase 117 found it live: a payable with no ' +
      'supplier, no due date and no bill number, which nobody could pay because the report they ' +
      'would pay from did not know about it.',
  },
  {
    key: 'banking.cash_tie_out',
    account: '1000',
    how: "Post a manual journal entry against a bank account's own ledger account.",
    because:
      'A position rather than a fault, because money legitimately reaches a bank ledger account ' +
      'without a feed row. Proving it can move at all is what says the two sides are really ' +
      'being read, rather than one number being compared with itself — which Phase 128 found ' +
      'was literally true for a foreign account, where both sides were the same face amount and ' +
      'the check agreed to the cent while the ledger held euros.',
  },
  {
    key: 'banking.posted_at_face',
    account: null,
    how: "Set a foreign transaction's functional amount equal to its face amount, which is what every one of them looked like before Phase 128.",
    because:
      'The check has no ledger side to journal against — it reads what each transaction records ' +
      'as its own posted rate. That is the point: before Phase 129 wrote the rate down, a euro ' +
      'charge put into a dollar ledger at its face value and one converted correctly were the ' +
      'same row, which is why ADR 0127 and ADR 0128 could only say the damage was unrepairable ' +
      'rather than show it to anybody.',
  },
  {
    key: 'payments.in_transit',
    account: '1250',
    how: 'Post a manual journal entry against 1250 with no captured checkout behind it.',
    because:
      'The clearing account nobody was watching until Phase 44. Money sits here between the ' +
      'customer paying and the processor settling, so a balance with no checkout behind it is ' +
      'either a payment that will never arrive or one that already did and was banked twice.',
  },
  {
    key: 'payables.duplicate_bills',
    account: null,
    how:
      'Enter two unreferenced bills from one supplier for the same amount on one day, ' +
      'proceeding past the warning.',
    because:
      'The only check with nothing on its right-hand side: it sums what it suspects against ' +
      'zero. Two routes are closed to it by design — a repeated reference is refused outright ' +
      'and cannot be overridden, and two bills that both carry references are never warned ' +
      'about, because the supplier has already said they are two documents. What is left, and ' +
      'what this check is therefore for, is the unreferenced resemblance somebody chose to ' +
      'proceed past. Phase 121 established that by trying the other two and being turned back.',
  },
  {
    key: 'parties.shared_addresses',
    account: null,
    how: 'Give two customers the same email address.',
    because:
      'A count, not money — and the address is the **email** one. The check selects id, name and ' +
      'email and clashes on those; nothing in it reads a postal address, which Phase 121 found ' +
      'by writing a falsifier that set one and watching the check stay green. Two parties on one ' +
      'address are usually one party entered twice, and it reports rather than accuses because a ' +
      'genuine share exists — two departments of one council.',
  },
  {
    key: 'assets.register',
    account: '1500',
    how: 'Post a manual journal entry that debits 1500 with no asset in the register.',
    because:
      'Cost and accumulated depreciation are two halves of one answer, and a van bought straight ' +
      'to the ledger never depreciates, so the difference compounds every month it is missed.',
  },
  {
    key: 'appointments.gift_cards',
    account: '2590',
    how: 'Post a manual journal entry that credits 2590 with no gift card behind it.',
    because:
      'A gift card is somebody else’s money until it is redeemed. A balance with no card ' +
      'behind it is a liability the business cannot honour, because it does not know whose it is.',
  },
  {
    key: 'appointments.payouts',
    account: '2320',
    how: 'Post a manual journal entry that credits 2320 with no delivered visit behind it.',
    because:
      'What is owed to practitioners. A position, because a payout run legitimately clears it ' +
      'between the visit and the payment, but the two sides still have to be read from different ' +
      'places for the number to mean anything.',
  },
  {
    key: 'cash_drawer.open_tills',
    account: '1060',
    how: 'Post a manual journal entry that debits 1060 with no open shift behind it.',
    because:
      'Cash in a till is the one balance somebody can physically count, so a ledger figure with ' +
      'no shift behind it is the difference that turns up as a short drawer at the end of a day.',
  },
  {
    key: 'funds.untagged_contributions',
    account: null,
    how: 'Post to 4500 Contribution Revenue with no Fund dimension on the line.',
    because:
      'The one check comparing two subledgers rather than a subledger and a ledger: revenue ' +
      'against the contributions that name a fund. An untagged gift is restricted money the ' +
      'charity cannot show it has honoured, which is the report its regulator asks for.',
  },
  {
    key: 'inventory.lots',
    account: '1400',
    how: 'Post a manual journal entry that debits 1400 with no open lot behind it.',
    because:
      'Stock on hand is a physical fact. A ledger balance with no lot behind it means the ' +
      'valuation cannot be walked back to anything countable on a shelf.',
  },
  {
    key: 'inventory.goods_received',
    account: '2050',
    how: 'Post a manual journal entry that credits 2050 with no goods receipt behind it.',
    because:
      'Goods received not invoiced. Phase 117 found the mirror of this live in the seed — a ' +
      'receipt crediting 2000 instead, so the payable existed and the receipt did not.',
  },
  {
    key: 'receivables.customer_credit',
    account: '2520',
    how: 'Post a manual journal entry that credits 2520 with no unapplied receipt behind it.',
    because:
      'Money held for a customer. Phase 115 found this check comparing held amounts in the ' +
      'currency they were taken in against a functional ledger balance, and it had agreed for ' +
      'eighty phases because nobody had ever put a difference in front of it.',
  },
  {
    key: 'manufacturing.wip',
    account: '1450',
    how: 'Post a manual journal entry that debits 1450 with no open work order behind it.',
    because:
      'Work in process is cost that has left raw materials and not yet arrived in finished ' +
      'goods. A balance with no work order behind it is cost that has gone nowhere and will ' +
      'never be relieved.',
  },
  {
    key: 'pos.tips',
    account: '2310',
    how: 'Post a manual journal entry that credits 2310 with no imported day behind it.',
    because:
      'Tips are staff money passing through the business. A position, because a payout run ' +
      'clears it, but a figure with no day behind it is money owed to nobody the system can name.',
  },
  {
    key: 'properties.deposits',
    account: '2580',
    how: 'Post a manual journal entry that credits 2580 with no deposit movement behind it.',
    because:
      'A security deposit is a tenant’s money held in trust, and in most jurisdictions ' +
      'holding it wrongly is an offence rather than an error.',
  },
  {
    key: 'timebilling.retainers',
    account: '2550',
    how: 'Post a manual journal entry that credits 2550 with no retainer behind it.',
    because:
      'Client money on account. Phase 105 gave it the nightly check its four siblings already ' +
      'had; this proves that check can still see a difference.',
  },
  {
    key: 'vehicles.authorisations',
    account: null,
    how: "Change a repair order's authorised amount without an authorisation row to match.",
    because:
      'The only check comparing a column against the rows that should explain it. What the ' +
      'customer approved is the ceiling on what may be billed, so a column that drifts from its ' +
      'authorisations is a garage billing past what anybody agreed to.',
  },
]

/** The falsifier for a check. Throws on a check nobody declared one for. */
export function falsifierFor(key: string): Falsifier {
  const falsifier = FALSIFIERS.find((row) => row.key === key)
  if (!falsifier) {
    throw new Error(
      `No falsifier is declared for the check "${key}". A check has to say what would make it ` +
        'disagree before it is worth running, or it is a green light with nothing behind it.',
    )
  }
  return falsifier
}
