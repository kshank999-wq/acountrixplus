/**
 * What is built and not wired (Phase 139).
 *
 * ## Why this exists
 *
 * The cores are being put in place first and hooked up in a later pass, so that
 * banks, deposits and the rest are connected deliberately rather than one at a
 * time. That is a reasonable way to stage the work and it has one sharp cost:
 *
 * > **Phase 49's rule.** A function with no caller is a feature that does not
 * > exist. A staged core is indistinguishable from a forgotten one, and the only
 * > record that `spends` is waiting for `applyDeposit` is prose in three files
 * > that nothing checks.
 *
 * Prose that nothing checks is what Phase 135 found rotting in `BANK_POSTINGS`,
 * and ADR 0135's answer applies here too: **a false sentence is exactly as long
 * as a true one.** So the backlog is a registry, and a scan holds it to the
 * source in both directions:
 *
 * - an entry whose target **does** call the core is stale, and must be removed
 *   rather than left to read as outstanding;
 * - an entry with nothing blocking it must name the test that says it is done,
 *   because "wire it up" with no acceptance is a task nobody can finish.
 *
 * ## What it is not
 *
 * Not a list of every unwired export. Measured: **1,349 exported functions in
 * `src/modules`, 293 with no caller elsewhere in `src/`** — and almost all of
 * those are registry lookups (`bankPostingFor`, `carrierFor`, `falsifierFor`)
 * and devices a test drives on purpose. A scan that called those dead would be
 * wrong about nearly three hundred things, which is why this is a declaration
 * with prose rather than a count.
 *
 * This registry holds only work that is **known to be outstanding and known to
 * be wrong today**: each entry names a defect still live in the code.
 */

/** What stands between the entry and being wired. */
export type Blocker =
  /**
   * Only the wiring. Every piece exists; somebody has to call the core and
   * unskip the acceptance test.
   */
  | 'nothing'
  /**
   * A column and the screen that fills it. The path cannot ask the question
   * because nothing records the answer, so wiring alone would not help — this
   * is the shape ADR 0136 called "a real change to a real screen".
   */
  | 'a field'

export type Pending = {
  /** The core that exists and is not called. */
  core: string
  coreFile: string
  /** What has to call it. One entry may name several. */
  targets: readonly { symbol: string; file: string }[]
  /** The phase that built or nominated it. */
  phase: number
  blockedBy: Blocker
  /**
   * The test that says this is done — skipped until it is.
   *
   * Required when nothing is blocking. `null` is only honest for an entry that
   * cannot be finished yet, because a test written against a column that does
   * not exist would be fiction rather than a definition of done.
   */
  acceptance: string | null
  /**
   * What is wrong in the code **today**, in a sentence somebody can go and
   * check. Not what the fix will do — what the defect is, so that reading this
   * registry is reading a list of live faults rather than a list of plans.
   */
  liveDefect: string
  /** Why it is staged rather than wired, argued. */
  because: string
}

export const PENDING_WIRING: readonly Pending[] = [
  {
    core: 'spends',
    coreFile: 'src/modules/fx/spent-against.ts',
    targets: [{ symbol: 'applyDeposit', file: 'src/modules/properties/deposits.ts' }],
    phase: 138,
    blockedBy: 'nothing',
    acceptance: 'tests/deposit-against-foreign-invoice.test.ts',
    liveDefect:
      'applyDeposit compares a euro face amount against a dollar holding, credits Accounts ' +
      'Receivable with the face amount rather than what the invoice was carried at, and ' +
      'applyDepositAction reports it with formatCents’ default currency — so €400 applied reads ' +
      'as "$400.00 applied to the invoice".',
    because:
      'Every piece exists. `settleInvoiceWithoutCash` already returns the functional figure and ' +
      '`spends` already decides what the holding gives up; the wiring pass has to read one and ' +
      'call the other. Staged with the rest so the deposit paths are hooked up together rather ' +
      'than this one alone.',
  },
  {
    core: 'recoverHeld',
    coreFile: 'src/modules/fx/settlement.ts',
    targets: [{ symbol: 'recoverWriteOff', file: 'src/modules/receivables/credits.ts' }],
    phase: 136,
    blockedBy: 'nothing',
    acceptance: 'tests/recovery-at-two-rates.test.ts',
    liveDefect:
      'recoverWriteOff posts recovery.functionalCents to both the bank and bad debt at the ' +
      'write-off’s carried rate. Measured: €2,500 written off at 1.0835 and recovered in full at ' +
      '1.10 puts $2,708.75 on a euro cash account whose statement says $2,750 — $41.25 unnamed, ' +
      'with no realised line to put it on.',
    because:
      'Nominated by ADR 0136 and restated by 0137 and 0138, and **no new core is needed for it**. ' +
      '`recoverHeld` already answers exactly this question — what arrives at the day’s rate ' +
      'against what leaves at the carried one — and `refundVendorCredit` is the working ' +
      'precedent. Three ADRs nominated it as though something had to be built; measuring found ' +
      'the piece already there and uncalled, which is why it belongs on this list rather than in ' +
      'a phase of its own.',
  },
  {
    core: 'mayPostToBank',
    coreFile: 'src/modules/fx/bank-side.ts',
    targets: [
      { symbol: 'recordRemittance', file: 'src/modules/payroll/remittance.ts' },
      { symbol: 'receivePledge', file: 'src/modules/funds/contributions.ts' },
      { symbol: 'receiveDeposit', file: 'src/modules/properties/deposits.ts' },
      { symbol: 'refundDeposit', file: 'src/modules/properties/deposits.ts' },
    ],
    phase: 136,
    blockedBy: 'a field',
    acceptance: null,
    liveDefect:
      'These four refuse a foreign bank account outright, so a business banking in euros cannot ' +
      'remit a payroll liability, take a pledge, or hold and return a tenancy deposit through ' +
      'that account at all. The refusal is honest — nothing records what currency the money was ' +
      'in — but it is a capability that does not exist rather than a figure that is wrong.',
    because:
      '`mayPostToBank` has taken a `moneyCurrency` since Phase 136 and these four have nothing to ' +
      'pass it. ADR 0136 called that "a real change to a real screen" and declined to make it, ' +
      'and that is still right: a column, a form field and a migration come before the wiring. ' +
      'The acceptance test is `null` on purpose — one written against a column that does not ' +
      'exist would be fiction rather than a definition of done.',
  },
  {
    core: 'bankGlAccountFor',
    coreFile: 'src/modules/banking/bank-guard.ts',
    targets: [{ symbol: 'recordContribution', file: 'src/modules/funds/contributions.ts' }],
    phase: 141,
    blockedBy: 'nothing',
    acceptance: 'tests/contribution-into-a-foreign-account.test.ts',
    liveDefect:
      'recordContribution reads `financialAccounts.chartAccountId` directly and debits that ' +
      'account, so a donation banked into a euro account posts a dollar figure against it with ' +
      'nothing recording what actually arrived. `receivePledge`, forty lines below in the same ' +
      'file, goes through the gate and refuses — so the same business is told no when a pledge ' +
      'lands in that account and nothing at all when a gift does.',
    because:
      'Not a new capability and not a missing field: the gate exists, ten other functions ' +
      'already call it, and this one reads around it. It is on the register rather than repaired ' +
      'only because the staging pass is holding every bank path until they are hooked up ' +
      'together. Found by Phase 141 measuring what each `domestic` entry reaches — and invisible ' +
      'to Phase 133 because that scan matches `bank.chartAccountId` or a name containing `gl`, ' +
      'and this assigns to `debitAccountId` first.',
  },
  {
    core: 'affords',
    coreFile: 'src/modules/fx/affordable.ts',
    targets: [{ symbol: 'redeemGiftCard', file: 'src/modules/appointments/service.ts' }],
    phase: 142,
    blockedBy: 'nothing',
    acceptance: 'tests/gift-card-against-foreign-invoice.test.ts',
    liveDefect:
      'redeemGiftCard puts `min(card.balanceCents, bill.balanceCents)` against a euro invoice — a ' +
      'dollar compared with a euro — then posts that figure to both journal lines while relieving ' +
      'the invoice’s functional twin through `relieveFunctional`, which converts. Measured: a ' +
      '$600 card against a €1,000 invoice carried at 1.10 credits Accounts Receivable $600 and ' +
      'takes $660 off the subledger, so `ledger.receivables` reports a $60 difference nightly and ' +
      'the customer has $660 of debt forgiven for $600 of card.',
    because:
      'Nominated by ADR 0141 as the one finding this register could not hold, because the register ' +
      'requires a core that exists and none answered it. `affords` is that core: the first ' +
      'inverse of `convert` in the codebase, since `rateFrom` derives a rate from a pair rather ' +
      'than a face amount from a functional one. It returns a **face** amount and nothing else, ' +
      'so `relieveFunctional` still decides the functional figure — which is the only way a card ' +
      'that clears an invoice takes both columns to zero together.',
  },
  {
    core: 'taxPerCode',
    coreFile: 'src/modules/payroll/tax-rounding.ts',
    targets: [{ symbol: 'priceDocumentTax', file: 'src/modules/payroll/sales-tax.ts' }],
    phase: 145,
    blockedBy: 'nothing',
    acceptance: 'tests/tax-that-foots-on-the-document.test.ts',
    liveDefect:
      'priceDocumentTax rounds every tax line on its own base and adds the results up, which is ' +
      'the one thing taxOn’s own comment says not to do. Measured: three lines of $10.00, $20.00 ' +
      'and $33.33 under one 8.25% code charge $5.23 where the code’s base of $63.33 gives $5.22, ' +
      'so the invoice the customer receives shows a tax that is not its own printed base times ' +
      'its own printed rate — and the return inherits it from the stored breakdown.',
    because:
      'The core exists and is tested exhaustively, and the change at the call site is one ' +
      'expression: price through `taxPerCode` rather than mapping the per-line rounding over the ' +
      'lines. It is staged rather than made because it changes what an invoice charges, which is ' +
      'a repair to want deliberately and in one pass with the rest rather than as a side effect ' +
      'of the phase that found it.',
  },
]

export type WiringVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether an entry still describes the code.
 *
 * `targetsCallingCore` and `coreExists` are **measured from the source**, never
 * declared — the same rule Phase 136's `askingFor` follows, for the same reason:
 * a backlog that believes its own entries is a backlog that goes stale.
 */
export function wiringStateFor(input: {
  entry: Pending
  /** Measured: which of the entry's targets already call the core. */
  targetsCallingCore: readonly string[]
  /** Measured: is the core exported where the entry says it is? */
  coreExists: boolean
  /** Measured: does the named acceptance file exist? `null` when none is named. */
  acceptanceExists: boolean | null
}): WiringVerdict {
  const { entry, targetsCallingCore, coreExists, acceptanceExists } = input

  if (!coreExists) {
    return {
      ok: false,
      why:
        `${entry.core} is not exported from ${entry.coreFile}, so this entry names nothing. ` +
        'Either the core moved and the entry needs its new home, or it was never built and the ' +
        'entry is a plan wearing the clothes of a fact.',
    }
  }

  if (targetsCallingCore.length > 0) {
    return {
      ok: false,
      why:
        `${targetsCallingCore.join(', ')} already call${targetsCallingCore.length === 1 ? 's' : ''} ` +
        `${entry.core}, so this entry is stale and must be removed. A backlog that still lists ` +
        'finished work is worse than no backlog: it makes the remaining entries untrustworthy ' +
        'too.',
    }
  }

  if (entry.blockedBy === 'nothing' && entry.acceptance === null) {
    return {
      ok: false,
      why:
        `${entry.core} has nothing blocking it and names no acceptance test, so "wire it up" has ` +
        'no definition of done. An entry that cannot be finished cannot be checked off, and one ' +
        'that is never checked off is how a backlog becomes a graveyard.',
    }
  }

  if (entry.acceptance !== null && acceptanceExists === false) {
    return {
      ok: false,
      why:
        `${entry.core} names ${entry.acceptance} as its acceptance test and that file does not ` +
        'exist. The test is the entry’s only claim to being finishable.',
    }
  }

  return { ok: true }
}
