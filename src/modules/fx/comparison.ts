import { RegistryError } from '@/modules/errors/registry'

/**
 * The ways money is compared, and how two amounts are known comparable
 * (Phase 144).
 *
 * ## The gap
 *
 * Phase 122 built a tripwire for money being **added** and Phase 123 gave it a
 * registry of forms, because "it reads the source" turned out to mean "it reads
 * one syntactic form". Nothing was ever built for money being **compared**, and
 * a comparison is the same mistake with a different operator: `€500 > $500` is
 * as meaningless as `€500 + $500`.
 *
 * Two of the five defects before this phase were comparisons, both found by
 * hand, four phases apart:
 *
 * ```
 * Phase 138  applyDeposit     input.amountCents > position.heldCents
 * Phase 142  redeemGiftCard   redeemFor(card.balanceCents, bill.balanceCents)
 * ```
 *
 * ## Four forms, and the fourth is the one that matters
 *
 * Measured across `src/modules`: **63 money-versus-money comparisons, 30 of them
 * in files that read a currency-bearing table, across 23 functions.**
 *
 * The first three forms are what anybody would write down — a relational
 * operator, `Math.min`/`Math.max`, an equality. Between them they reach
 * `applyDeposit`.
 *
 * They do **not** reach `redeemGiftCard`, which is the defect that motivated
 * this phase. Its comparison is `Math.min(balanceCents, dueCents)` inside
 * `redeemFor`, a pure helper in `appointments/split.ts` — a file that reads no
 * currency-bearing table, over two bare parameters. The comparison is in one
 * place and the two currencies arrive from another.
 *
 * So the third form is the call itself: **a helper handed two money amounts
 * cannot know whether they are comparable.** It has to be told, or its callers
 * have to be checked. `spends` (Phase 138) and `affords` (Phase 142) take a
 * `documentCurrency` and a `homeCurrency` and say so in their refusals;
 * `redeemFor` and `releaseFor` take two bare numbers.
 *
 * Writing the first two forms and stopping would have produced a scan that
 * missed the defect it was built for — which is Phase 123's lesson exactly, one
 * registry later.
 */

/** A syntactic form in which this codebase compares two amounts of money. */
export type ComparisonForm = {
  key: string
  /** A JavaScript regular expression source, compiled by the test that scans. */
  pattern: string
  /** What it looks like, for somebody reading this rather than the regex. */
  looksLike: string
  /** Why it counts as comparing money, and what it reaches that the others do not. */
  because: string
}

/** Both sides of a comparison: a dotted or bare identifier ending in `Cents`. */
const OPERAND = String.raw`[A-Za-z_][\w.]*[cC]ents`

export const COMPARISON_FORMS: readonly ComparisonForm[] = [
  {
    key: 'relational',
    pattern: String.raw`(${OPERAND})\s*(?:>=|<=|>|<)\s*(${OPERAND})`,
    looksLike: 'input.amountCents > position.heldCents',
    because:
      'The commonest form and the one that decides whether an act is permitted. Phase 138 found ' +
      'exactly this shape putting a euro face amount against a dollar holding, in the check ' +
      'saying whether somebody else’s money may be spent — so the refusal a person reads was ' +
      'computed from two incomparable numbers.',
  },
  {
    key: 'bounded',
    pattern: String.raw`Math\.(?:min|max)\(\s*(${OPERAND})\s*,\s*(${OPERAND})\s*\)`,
    looksLike: 'Math.min(checkout.grossCents, invoice.balanceCents)',
    because:
      'A cap or a floor, which is a comparison that returns one of its operands rather than a ' +
      'boolean. The result is then posted, so a wrong answer here does not refuse anything — it ' +
      'becomes a journal line.',
  },
  {
    key: 'equality',
    pattern: String.raw`(${OPERAND})\s*(?:===|!==)\s*(${OPERAND})`,
    looksLike: 'registerCents === ledgerCents',
    because:
      'How every reconciliation in this codebase states its verdict: a subledger against the ' +
      'ledger, a register against a control account, a statement against what was ticked off. An ' +
      'equality over two currencies does not report a difference — it reports a difference that ' +
      'is not there, or hides one that is.',
  },
  {
    key: 'handed_over',
    pattern: String.raw`\b(\w+)\(\s*(${OPERAND})\s*,\s*(${OPERAND})\s*[,)]`,
    looksLike: 'redeemFor(card.balanceCents, bill.balanceCents)',
    because:
      'Two money amounts handed to a helper, which is where the comparison leaves the file that ' +
      'knows the currencies. `redeemFor` takes two bare numbers and returns `min(balance, due)`; ' +
      'the call site knows one is a gift card and the other a euro invoice and says nothing. The ' +
      'first three forms all miss it, because the operator is in a file that reads no ' +
      'currency-bearing table — so a scan without this form would have missed the defect this ' +
      'registry was built for.',
  },
]

/** The form a key names. Throws on a form nobody declared. */
export function comparisonFormFor(key: string): ComparisonForm {
  const form = COMPARISON_FORMS.find((row) => row.key === key)
  if (!form) {
    throw new RegistryError({
      registry: 'COMPARISON_FORMS',
      key,
      message:
        `No comparison form is declared for "${key}". A tripwire that scans for comparisons has ` +
        'to say which forms it scans for, or its guarantee is narrower than it reads.',
    })
  }
  return form
}

/**
 * How two amounts meeting at one site are known to be in the same currency.
 *
 * Declared, because it is a judgement about what the code guarantees; the sites
 * themselves are measured. That is the split ADR 0141 settled for
 * `DOMESTIC_GROUNDS` and the reason is the same — the half that could excuse a
 * site is the half that has to be checkable.
 */
export type Comparability =
  /**
   * Both operands come off one row.
   *
   * `document.balanceCents !== document.totalCents` compares an invoice with
   * itself. One row has one currency, so there is nothing to ask.
   */
  | 'same-row'
  /**
   * A guard earlier in the same function refused a mismatch.
   *
   * `applyCreditWithin` calls `creditableAgainst` with both currencies and
   * throws before it compares anything. The comparison is sound *because* of a
   * refusal, which is Phase 117's rule paying off two phases of work later.
   */
  | 'refused-upstream'
  /**
   * Neither side carries a currency.
   *
   * A till, a gift-card balance against the ledger, a fund, an inventory
   * valuation. Argued from the schema the way `DOMESTIC_GROUNDS` argues it, and
   * the same warning applies: "nothing here carries a currency" is a claim about
   * the world and has been wrong three times.
   */
  | 'home-money'
  /**
   * One row was created carrying the other's currency.
   *
   * A checkout is created with `currency: invoice.currency`; a credit note takes
   * the currency of the document it reverses (Phase 63); an amount applied to a
   * document is in that document's currency by construction of the act. Two
   * rows, one currency, guaranteed at the moment the second was written —
   * which is the same fact `INHERITED_CURRENCY` records about columns.
   */
  | 'inherited'
  /**
   * They are not known comparable, and this site is wrong today.
   *
   * Registered rather than excused (ADR 0134): a declaration that excuses a site
   * is worse than one that misses it. Each of these names its live defect and
   * where the repair is tracked.
   */
  | 'blind'

export type ComparedPair = {
  file: string
  symbol: string
  comparability: Comparability
  /** Why, argued from what the code guarantees rather than from what it is like. */
  because: string
  /**
   * For a `blind` site: where the repair is tracked.
   *
   * Every one of them was already found by hand and is already on a register, so
   * this scan's first act is to rediscover three known defects rather than to
   * announce new ones — which is the only way to know it works.
   */
  trackedIn?: string
}

export type ComparabilityVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a declared comparability survives what the scan measured.
 *
 * Pure: no database, no clock, no file reading.
 */
export function comparabilityStands(input: {
  pair: ComparedPair
  /** Measured: does a guard in this function refuse a currency mismatch? */
  refusesMismatch: boolean
  /** Measured: do both operands come off the same identifier? */
  sameRow: boolean
}): ComparabilityVerdict {
  const { pair, refusesMismatch, sameRow } = input

  if (pair.comparability === 'blind') {
    if (pair.trackedIn === undefined) {
      return {
        ok: false,
        why:
          `${pair.symbol} is declared \`blind\` and names nowhere the repair is tracked. A site ` +
          'known to compare two currencies with no record of what happens next is a defect ' +
          'somebody wrote down and then lost.',
      }
    }
    return { ok: true }
  }

  if (pair.comparability === 'same-row' && !sameRow) {
    return {
      ok: false,
      why:
        `${pair.symbol} argues that both amounts come off one row, and they do not. One row has ` +
        'one currency; two rows have two, and the scan can see which this is.',
    }
  }

  if (pair.comparability === 'refused-upstream' && !refusesMismatch) {
    return {
      ok: false,
      why:
        `${pair.symbol} argues that a guard refuses a currency mismatch before it compares, and ` +
        'nothing in it does. A refusal that is not there is the most expensive kind of argument, ' +
        'because everything downstream is written as though it happened.',
    }
  }

  return { ok: true }
}

/**
 * Twenty-one since Phase 151, down from twenty-three.
 *
 * `redeemGiftCard`'s `min(card.balanceCents, bill.balanceCents)` and
 * `priceApplication`'s `completedToDateCents > item.scheduledValueCents` are
 * both gone from here — not because anybody decided they were fine, but because
 * the wiring pass moved them into `affords` and `priceApplicationLines`, which
 * take their currencies as arguments and refuse a mismatch.
 *
 * Those two cores are out of this scan's reach on purpose: it narrows to files
 * that read a currency-bearing table, and a pure core reads none. That is the
 * limit ADR 0144 declared in its own "what this does not do" — a helper called
 * only from unscanned files is invisible — and the right answer to it is the
 * one taken here, which is to give the helper the currencies rather than to
 * widen the scan until it drowns.
 */
export const COMPARED_PAIRS: readonly ComparedPair[] = [
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'applyDeposit',
    comparability: 'home-money',
    because:
      'Was `blind` until Phase 151. It compared `input.amountCents` — an invoice’s face amount — ' +
      'against a dollar holding, so $1,050 held and €1,000 applied asked `100000 > 105000`, went ' +
      'ahead, and spent $1,100 of a $1,050 deposit. The invoice branch goes through `spends` now, ' +
      'which takes both currencies and refuses a mismatch; what is left here is the ' +
      'kept-for-damage branch, where the amount is the company’s own money on both sides.',
  },
  {
    file: 'src/modules/payroll/vendor-reporting.ts',
    symbol: 'contractorPayments',
    comparability: 'blind',
    because:
      '`paidCents >= thresholdCents` measures a face sum of `payment_applications.amount_cents` ' +
      'against a statutory figure in the company’s own money, and decides whether a 1099 is ' +
      'filed. Found in Phase 143 by completing `FACE_COLUMNS`; the sum is registered there and ' +
      'the comparison is registered here, which is the same defect from both ends.',
    trackedIn: 'BLIND_FACE_SUMS — contractorPayments',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'applyCreditWithin',
    comparability: 'refused-upstream',
    because:
      'Calls `creditableAgainst({ creditCurrency, documentCurrency })` and throws before either ' +
      'comparison runs, so by the time `input.amountCents` meets `note.remainingCents` and ' +
      '`invoice.balanceCents` all three are one currency. Phase 117’s "a refusal beats a check", ' +
      'making a comparison sound two phases of work later.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'applyVendorCreditWithin',
    comparability: 'refused-upstream',
    because:
      'The payables mirror, with the same guard on the bill’s currency and the vendor credit’s. ' +
      'Both comparisons run after it, so both are within one currency.',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'postCapturedCheckout',
    comparability: 'inherited',
    because:
      '`Math.min(row.checkout.grossCents, row.invoice.balanceCents)` is two rows, and the checkout ' +
      'was created with `currency: row.invoice.currency` — so the second row carries the first ' +
      'one’s currency by construction. Not a refusal and not one row: a third thing, and the one ' +
      'that makes this cap sound.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'createCreditNote',
    comparability: 'inherited',
    because:
      'A credit note reverses a document and takes its currency (Phase 63 settled that, and ' +
      '`fx/denomination.ts` is the shared rule). So `totalCents > invoice.totalCents` and the ' +
      '`Math.min` beside it compare the note with the invoice it is denominated by.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'createVendorCredit',
    comparability: 'inherited',
    because:
      'The payables mirror of the credit note: a vendor credit reverses a bill and takes its ' +
      'currency through the same shared rule in `fx/denomination.ts` that Phase 63 settled for ' +
      'the receivables side. So `totalCents > bill.totalCents` and the `Math.min` beside it ' +
      'compare the credit with the document that denominates it.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'writeOffInvoice',
    comparability: 'inherited',
    because:
      'The amount written off is an amount *of that invoice*, so `amountCents > ' +
      'invoice.balanceCents` compares the invoice’s currency with itself. The act carries the ' +
      'denomination, which is why `invoice_write_offs` had to be given a currency column at all ' +
      '(Phase 127).',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'reduceDocumentBalance',
    comparability: 'inherited',
    because:
      'The amount coming off a document is in that document’s currency — every caller settles ' +
      'something against the document it names. `amountCents > document.balanceCents` is ' +
      'therefore one currency, and the functional figure this returns is what the ledger gets.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'recoverWriteOff',
    comparability: 'inherited',
    because:
      '`input.amountCents > writeOff.amountCents` bounds a recovery by the write-off it recovers. ' +
      'Declared `same-row` first and the scan disagreed, correctly: the operands have different ' +
      'roots, so this is two things and not one row. What makes it sound is that the amount ' +
      'recovered is an amount *of that write-off*, denominated by it — which is why ' +
      '`invoice_write_offs` had to be given a currency column at all (Phase 127).',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'voidDocument',
    comparability: 'same-row',
    because:
      '`document.balanceCents !== document.totalCents` asks whether anything has been applied to ' +
      'a document before it may be voided, comparing that document with itself. Both operands ' +
      'read off one identifier, which is the thing the scan can actually check — and after four ' +
      'entries were declared `same-row` and found not to be, it is one of only two that are.',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'createInvoice',
    comparability: 'inherited',
    because:
      '`retainageCents >= totalCents` refuses a contract withholding more than the invoice is ' +
      'worth. Both are bare locals rather than one row — the scan said so when this was declared ' +
      '`same-row` — and both are computed from the same input lines, so each inherits the ' +
      'currency of the document being built before anything is written.',
  },
  {
    file: 'src/modules/receivables/service.ts',
    symbol: 'createBill',
    comparability: 'inherited',
    because:
      'The payables twin of the invoice check, and the same arithmetic on the same input: both ' +
      'figures are derived from the bill’s own lines and carry the currency it is being raised ' +
      'in. Declared `same-row` first, for the same wrong reason, and corrected by the same scan.',
  },
  {
    file: 'src/modules/payables/approvals-service.ts',
    symbol: 'withdrawApproval',
    comparability: 'same-row',
    because:
      '`row.balanceCents !== row.totalCents` asks whether a bill has been paid against before an ' +
      'approval may be withdrawn. One bill, compared with itself.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'refundDeposit',
    comparability: 'home-money',
    because:
      'The same expression as its sibling `applyDeposit` and sound where that one is not, which ' +
      'is the whole reason this registry is per-site rather than per-file. A refund hands the ' +
      'tenant back money the business is holding: both sides are the company’s own, no document ' +
      'is involved, and no currency enters. Applying it to an **invoice** is what makes the other ' +
      'one wrong.',
  },
  {
    file: 'src/modules/properties/deposits.ts',
    symbol: 'depositsHeld',
    comparability: 'home-money',
    because:
      'The nightly check: what the deposit register says is held against what the ledger says. ' +
      'Neither `leases` nor the deposit tables record a currency (Phase 23), and the ledger is ' +
      'functional by definition.',
  },
  {
    file: 'src/modules/appointments/reporting.ts',
    symbol: 'giftCardPosition',
    comparability: 'home-money',
    because:
      '`gift_cards` has no currency column and no functional twin, so what is outstanding on the ' +
      'cards is the company’s own money and comparing it with the liability account is sound. ' +
      'This is the *card* side of the same table Phase 142 found misused on the invoice side.',
  },
  {
    file: 'src/modules/appointments/reporting.ts',
    symbol: 'payoutPosition',
    comparability: 'home-money',
    because:
      'What practitioners have earned against what the ledger owes them. `appointments` and ' +
      '`appointment_services` carry no currency column, and a commission split is a share of a ' +
      'domestic price (`DOMESTIC_GROUNDS` argues the same fact for `completeAppointment`).',
  },
  {
    file: 'src/modules/drawer/service.ts',
    symbol: 'drawerPosition',
    comparability: 'home-money',
    because:
      'A till counted against the ledger. `SAFE_FACE_SUMS` already argues this one from the code ' +
      'rather than from what a drawer is like: `takeCounterPayment` never passes a currency to ' +
      '`recordPayment`, so every receipt reaching a drawer is the company’s own money.',
  },
  {
    file: 'src/modules/inventory/service.ts',
    symbol: 'reconcileInventory',
    comparability: 'home-money',
    because:
      'Stock valuation against the inventory control account. Inventory is carried in the ' +
      'company’s own money whatever currency it was bought in — the cost came off a lot, and a ' +
      'lot is valued when it is received.',
  },
  {
    file: 'src/modules/importing/opening-balances.ts',
    symbol: 'planTrialBalanceImport',
    comparability: 'home-money',
    because:
      '`fileDebitCents === fileCreditCents` checks that an imported trial balance balances. An ' +
      'opening trial balance is the company’s own books being carried over, so there is no second ' +
      'currency for it to be in — the same argument `DOMESTIC_GROUNDS` makes for ' +
      '`commitTrialBalanceImport`.',
  },
]

/** How two amounts meeting here are known comparable. Throws on an undeclared site. */
export function comparedPairFor(file: string, symbol: string): ComparedPair {
  const found = COMPARED_PAIRS.find((row) => row.file === file && row.symbol === symbol)
  if (found) return found

  throw new RegistryError({
    registry: 'COMPARED_PAIRS',
    key: `${file}:${symbol}`,
    message:
      `Nothing declares how the two amounts compared in ${symbol} are known to be in the same ` +
      'currency. A comparison of two money amounts is only meaningful when they are, and saying ' +
      'which of the four reasons applies is what makes that checkable.',
  })
}
