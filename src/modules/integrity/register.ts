import { formatCents } from '@/lib/money'
import type { ActorContext } from '@/modules/tenancy/context'
import type { IndustryModule } from '@/modules/coa/industry'

import { giftCardPosition, payoutPosition } from '@/modules/appointments/reporting'
import { cashTieOut, sharedLedgerAccounts } from '@/modules/banking/accounts'
import { reconcileFixedAssets } from '@/modules/assets/service'
import { netAssets } from '@/modules/funds/reporting'
import { reconcileInventory } from '@/modules/inventory/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { wipPosition } from '@/modules/manufacturing/reporting'
import { tipsPosition } from '@/modules/pos/service'
import { drawerPosition } from '@/modules/drawer/service'
import { conversionsAgree } from '@/modules/fx/reporting'
import { depositsHeld } from '@/modules/properties/deposits'
import { retainerPosition } from '@/modules/timebilling/billing'
import { verdictFor, weakerBecauseShared } from '@/modules/timebilling/retainer-position'
import { authorisationsAgree } from '@/modules/vehicles/reporting'
import { paymentsInTransitPosition } from '@/modules/payments/reporting'
import { heldCredits } from '@/modules/receivables/customer-credit'
import { duplicateExposure } from '@/modules/payables/duplicates'
import { sharedAddresses } from '@/modules/parties/service'
import { summarise } from '@/modules/parties/addresses'
import { unbilledReceiptValue } from '@/modules/payables/receipt-billing'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'

/**
 * Every reconciliation this application has, as named data (spec §19).
 *
 * ## Why this file exists
 *
 * Eleven phases wrote a check. Phase 14 proved the stock lots against the
 * Inventory account, Phase 16 the asset register against 1500, Phase 23 the
 * deposits register against 2580, Phase 26 the funds, Phase 27 work in
 * process, Phase 28 the tips, Phases 29 and 30 the gift cards and the
 * authorisations, and Phase 31 the control accounts. Each was written
 * carefully, tested, and surfaced on a page.
 *
 * Not one of them was ever run by the machine. Measured before this phase:
 * **nine reconciliation functions across nine modules, and none of the
 * seventeen scheduled job kinds ran any of them.** Every check in the books
 * existed only in the moment somebody opened the page that called it — and the
 * whole point of a reconciliation is to catch a drift nobody is looking for.
 *
 * ADR 0031 and ADR 0032 both listed "run `controlAccounts` nightly" as a
 * follow-up. Phase 31 taught what a follow-up repeated across consecutive ADRs
 * usually means, so this is the whole set rather than that one.
 *
 * **A check nobody runs is not a check.**
 *
 * ## The distinction that keeps the alarm worth hearing
 *
 * Not every difference is a fault, and this is the part that would be easy to
 * get wrong. Three of these positions are *expected* to diverge:
 *
 * - **What practitioners are owed** differs from account 2320 the moment
 *   anybody is paid. That is payday, not a defect.
 * - **Tips collected** differs from account 2310 for exactly the same reason.
 * - **Untagged contributions** are non-zero whenever a charity receives
 *   unrestricted money, which is most charities most of the time.
 *
 * A register that treated all ten alike would raise an alarm every payday and
 * every time a donation arrived without an appeal attached — and an alarm that
 * fires on ordinary business is one that gets switched off before the day it
 * matters. That is Phase 24's digest rule (*silence has to mean something*)
 * applied to the books rather than to the queue.
 *
 * So each entry declares what a difference *means*, and only a `fault` is
 * something somebody has to act on. A `position` is still run, still recorded,
 * and still shown — the number is useful, it is just not an accusation.
 */

/** What a difference on this check means. */
export type CheckSeverity =
  /**
   * The two sides must agree. Nothing legitimately moves them apart, so a
   * difference is always a defect and somebody has to look.
   */
  | 'fault'
  /**
   * The two sides are expected to diverge in ordinary trading. Recorded and
   * shown because the gap is a number somebody wants, never alarmed on.
   */
  | 'position'

/** What running one check produced. */
export type CheckOutcome = {
  agrees: boolean
  /** The subledger, register, or document side. */
  leftCents: number
  /** What the ledger says. */
  rightCents: number
  /**
   * Something a total cannot say.
   *
   * Some checks fail as a *list* rather than as a difference — a repair order
   * whose cached authority disagrees with its own approvals is a fault even
   * when the totals net out across the shop. This is where that goes.
   */
  detail?: string
}

export type IntegrityCheck = {
  /**
   * Stable across renames, because it is stored on every finding and is what
   * "when did this start" is answered by. Never change one; retire it and add
   * a new key instead.
   */
  key: string
  /** What somebody reads on the operations page. */
  label: string
  /** The two things being compared, in the order they are reported. */
  compares: string
  /**
   * The module that has to be on. Null for the checks every company gets.
   *
   * A salon is not asked whether its work in process agrees, and skipping is
   * not the same as passing — the run records it as skipped.
   */
  module: IndustryModule | null
  severity: CheckSeverity
  /**
   * What the two numbers are (Phase 94).
   *
   * Almost every check compares money, so money is the default. Two do not:
   * `banking.shared_ledger_accounts` counts accounts against ledger lines, and
   * `parties.shared_addresses` counts parties against addresses. Rendering
   * either as currency produces "$0.01 apart" for two customers on one email —
   * a sentence that is not merely unhelpful but false, in a register whose
   * whole job is telling somebody the truth about their books.
   */
  unit?: 'money' | 'count'
  /** Why a difference here means what it means. Shown next to the number. */
  meaning: string
  run: (ctx: ActorContext, asOf: string) => Promise<CheckOutcome>
}

/**
 * The register.
 *
 * Ordered with the checks every company gets first, then the module ones
 * alphabetically. Nothing depends on the order; it is for the person reading
 * the page.
 */
export const INTEGRITY_CHECKS: IntegrityCheck[] = [
  {
    key: 'ledger.receivables',
    label: 'What is owed to us, against who owes it',
    compares: 'Accounts Receivable against the open invoices and credit notes behind it',
    module: null,
    severity: 'fault',
    meaning:
      'Nothing legitimately moves a control account except a document. A difference means an ' +
      'entry was posted straight at 1100, or a document exists that the ledger never heard about. ' +
      'Credit notes count on the same side of that sentence as invoices: a credit posts to 1100 ' +
      'when it is issued, not when somebody decides which invoice it belongs to.',
    run: async (ctx, asOf) => {
      const result = await controlAccounts(ctx, { asOf })
      return {
        agrees: result.receivables.agrees,
        leftCents: result.receivables.subledgerCents,
        rightCents: result.receivables.ledgerCents,
        detail: madeOf(result.receivables),
      }
    },
  },
  {
    key: 'ledger.payables',
    label: 'What we owe, against who we owe it to',
    compares: 'Accounts Payable against the open bills and vendor credits behind it',
    module: null,
    severity: 'fault',
    meaning:
      'The same rule as receivables, on the other side of the balance sheet — vendor credits ' +
      'included, since one debits 2000 the moment it is raised.',
    run: async (ctx, asOf) => {
      const result = await controlAccounts(ctx, { asOf })
      return {
        agrees: result.payables.agrees,
        leftCents: result.payables.subledgerCents,
        rightCents: result.payables.ledgerCents,
        detail: madeOf(result.payables),
      }
    },
  },
  {
    key: 'banking.shared_ledger_accounts',
    // Counts, not money — and said so since Phase 94, which is when the page
    // stopped rendering them as currency.
    unit: 'count',
    label: 'Bank accounts that share one ledger account',
    compares: 'Bank accounts against the ledger accounts they post to',
    module: null,
    severity: 'fault',
    meaning:
      'Two bank accounts on one ledger account give the balance sheet a single figure covering ' +
      'both, so it can never say what either holds — which is the only question a bank statement ' +
      'asks, and neither account can be tied out. A unique index refuses new pairs; this catches ' +
      'books that were migrated with one already in place.',
    run: async (ctx) => {
      const shared = await sharedLedgerAccounts(ctx)
      const accounts = shared.reduce((sum, entry) => sum + entry.names.length, 0)

      return {
        agrees: shared.length === 0,
        // Counts, not money. The number that matters is how many real accounts
        // are hidden behind how few ledger lines.
        leftCents: accounts,
        rightCents: shared.length,
        detail:
          shared.length === 0
            ? undefined
            : shared
                .map((entry) => `${entry.chartAccountNumber}: ${entry.names.join(' and ')}`)
                .join('; '),
      }
    },
  },
  {
    key: 'banking.cash_tie_out',
    label: 'What each bank account holds, against its feed',
    compares: 'Σ per account (its ledger account) against its own posted transactions',
    module: null,
    // Deliberately a position rather than a fault. Money legitimately enters a
    // bank account from an invoice payment or a manual journal that never
    // appeared in the feed, and rows still in the inbox have not posted at
    // all — so a difference is a number worth knowing, not an accusation.
    severity: 'position',
    meaning:
      'A difference is not automatically wrong: a payment recorded against an invoice moves the ' +
      'ledger without a feed row, and anything still in the inbox has not posted. It is the ' +
      'figure to look at when the balance sheet and the bank disagree, and it is only answerable ' +
      'at all because each account now has a ledger account of its own.',
    run: async (ctx) => {
      const rows = await cashTieOut(ctx)
      const ledger = rows.reduce((sum, row) => sum + row.ledgerCents, 0)
      const feed = rows.reduce((sum, row) => sum + row.feedCents, 0)
      const waiting = rows.reduce((sum, row) => sum + row.uncategorizedCount, 0)
      const apart = rows.filter((row) => row.differenceCents !== 0)

      return {
        agrees: apart.length === 0,
        leftCents: feed,
        rightCents: ledger,
        detail: (() => {
          if (rows.length === 0) return 'No bank accounts.'
          const parts: string[] = []
          if (apart.length > 0) {
            parts.push(
              apart
                .slice(0, 3)
                .map((row) => `${row.accountName} ${formatCents(row.differenceCents)}`)
                .join(', ') + (apart.length > 3 ? ` and ${apart.length - 3} more` : ''),
            )
          }
          if (waiting > 0) {
            parts.push(`${waiting} still in the inbox`)
          }
          return parts.length > 0 ? parts.join('; ') : undefined
        })(),
      }
    },
  },
  {
    key: 'payments.in_transit',
    label: 'What the card processor is holding, against the clearing account',
    compares: 'Σ captured, unswept checkouts (net) against 1250',
    module: null,
    // A fault rather than a position, unlike the bank tie-out. Nothing
    // legitimately posts to 1250 except this module's own three entries, so a
    // difference is not a timing artefact — it means a fee posted without a
    // capture, a payout swept a checkout it did not settle, or the processor
    // took a customer's money and nothing recorded it.
    severity: 'fault',
    meaning:
      'Card money sits at the processor for days before it is deposited. This is the only ' +
      'account that holds it, and the only thing that posts there is a capture, its fee, and ' +
      'the payout that clears it. A difference means one of the three is missing. It also ' +
      'counts checkouts that were started and never resolved, which no subtraction can find: ' +
      'a customer who paid and closed the tab leaves both sides reading zero while their ' +
      'money sits at the processor unrecorded (Phase 46).',
    run: async (ctx, asOf) => {
      const position = await paymentsInTransitPosition(ctx, asOf)

      const parts: string[] = []
      if (position.differenceCents !== 0) {
        parts.push(
          `The processor owes ${formatCents(position.owedCents)}; the account carries ${formatCents(position.ledgerCents)}.`,
        )
      }
      if (position.unresolvedCount > 0) {
        parts.push(
          `${position.unresolvedCount} payment${position.unresolvedCount === 1 ? '' : 's'} ` +
            `started and never resolved, worth ${formatCents(position.unresolvedCents)} if they were charged.`,
        )
      }

      return {
        agrees: position.agrees,
        leftCents: position.owedCents,
        rightCents: position.ledgerCents,
        detail: parts.length > 0 ? parts.join(' ') : undefined,
      }
    },
  },
  {
    key: 'payables.duplicate_bills',
    label: 'Bills that look like the same supplier invoice twice',
    compares: 'Σ suspected duplicate bills against nothing',
    module: null,
    // A position, not a fault. Nothing here is provably wrong — two bills for
    // the same amount a week apart is how a weekly delivery looks — and
    // reporting a suspicion as a broken book is how a check gets ignored. What
    // it says is "somebody should look at these two", which is true.
    severity: 'position',
    meaning:
      'The same supplier invoice entered twice is the most expensive routine mistake in ' +
      'payables, because both copies get paid and getting the second one back is a favour ' +
      'rather than a right. Phase 47 stopped it at the door; this finds the ones already in ' +
      'the books, which is where the one that gets paid twice actually is. Nothing here is ' +
      'proof — it is two documents worth a minute of somebody\'s attention.',
    run: async (ctx) => {
      const exposure = await duplicateExposure(ctx)

      return {
        agrees: exposure.pairs === 0,
        // Left is the subledger side, as everywhere in this register. There is
        // no ledger figure to compare against — the whole point is that the
        // books balance perfectly with a duplicate in them.
        leftCents: exposure.totalCents,
        rightCents: 0,
        detail:
          exposure.pairs === 0
            ? undefined
            : `${exposure.pairs} pair${exposure.pairs === 1 ? '' : 's'} worth a look, ` +
              `${formatCents(exposure.totalCents)} in total — ` +
              `${formatCents(exposure.unpaidCents)} of it not yet paid.`,
      }
    },
  },
  {
    key: 'parties.shared_addresses',
    label: 'Two customers, or two suppliers, on one email address',
    compares: 'Parties sharing an address against the addresses they share',
    module: null,
    unit: 'count',
    /*
      A position rather than a fault, on the same reasoning as the duplicate
      bills above. Two customers on one address is not proof of anything — a
      parent company and its subsidiary genuinely may share an accounts inbox —
      and calling a suspicion a broken book is how a check gets ignored. What it
      says is "the post to this address is ambiguous", which is true.
    */
    severity: 'position',
    meaning:
      'Phase 93 refuses to file a letter when two parties of one kind share an address, ' +
      'because an entry on the wrong customer is evidence about the wrong party. That refusal ' +
      'is silent, so the application detects a real problem and tells nobody. It is worse than ' +
      'the filing: both accounts are chased at that inbox, both statements arrive there, and ' +
      'the person reading them cannot tell which account either refers to. A customer sharing ' +
      'with a supplier is deliberately not reported — that is one firm that buys from you and ' +
      'sells to you, which is ordinary business.',
    run: async (ctx) => {
      const clashes = await sharedAddresses(ctx)

      return {
        agrees: clashes.length === 0,
        // Counts, not money — the same shape `banking.shared_accounts` uses,
        // and for the same reason: there is no ledger figure to compare
        // against, because the books balance perfectly with two customers on
        // one address. The number that matters is how many parties are hidden
        // behind how few addresses.
        leftCents: clashes.reduce((sum, clash) => sum + clash.parties.length, 0),
        rightCents: clashes.length,
        detail: summarise(clashes),
      }
    },
  },
  {
    key: 'assets.register',
    label: 'The asset register, against the balance sheet',
    compares: 'Σ register cost and depreciation against 1500 and 1590',
    module: null,
    severity: 'fault',
    meaning:
      'Two comparisons that both have to hold. A difference means an asset was capitalised ' +
      'without being registered, or depreciation was journalled by hand.',
    run: async (ctx, asOf) => {
      const result = await reconcileFixedAssets(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.registerCostCents,
        rightCents: result.ledgerCostCents,
        detail: result.accumulatedAgrees
          ? undefined
          : `Accumulated depreciation also differs: register ${formatCents(result.registerAccumulatedCents)}, ` +
            `ledger ${formatCents(result.ledgerAccumulatedCents)}`,
      }
    },
  },
  {
    key: 'fx.conversions',
    label: 'What foreign documents are carried at, against their own rates',
    compares: 'invoices.functional_balance_cents against balance × the rate beside it',
    module: null,
    severity: 'fault',
    meaning:
      'A home-currency amount is written once, when the document is raised, and never ' +
      'recomputed. A document carrying an amount its own rate cannot produce means something ' +
      'wrote one by hand, or converted at a rate other than the one it stored.',
    run: async (ctx) => {
      const result = await conversionsAgree(ctx)
      return {
        agrees: result.agrees,
        leftCents: result.documentsCents,
        rightCents: result.recomputedCents,
        detail:
          result.offenders.length === 0
            ? undefined
            : result.offenders.map((row) => row.number).join(', '),
      }
    },
  },
  {
    key: 'appointments.gift_cards',
    label: 'What the gift cards are worth, against what we owe on them',
    compares: 'Σ card balances against 2590',
    module: 'appointments',
    severity: 'fault',
    meaning:
      'Selling and redeeming a card both maintain the balance and post in the same transaction, ' +
      'so nothing else can move these apart. A difference means one half happened without the other.',
    run: async (ctx, asOf) => {
      const result = await giftCardPosition(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.outstandingCents,
        rightCents: result.ledgerCents,
        detail:
          `${result.cardsWithBalance} of ${result.cardsIssued} ` +
          `${result.cardsIssued === 1 ? 'card' : 'cards'} still ` +
          (result.cardsWithBalance === 1 ? 'has something on it' : 'have something on them'),
      }
    },
  },
  {
    key: 'appointments.payouts',
    label: 'What practitioners have earned, against what is still owed them',
    compares: 'Σ delivered visits against 2320',
    module: 'appointments',
    severity: 'position',
    meaning:
      'These two are meant to differ: money leaves 2320 through payroll, which this does not ' +
      'control. The gap is what has been paid out, and it is the number somebody wants when a ' +
      'stylist asks what they are owed this month.',
    run: async (ctx, asOf) => {
      const result = await payoutPosition(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.earnedCents,
        rightCents: result.ledgerCents,
        detail:
        result.paidOutCents === 0
          ? undefined
          : `${formatCents(result.paidOutCents)} paid out so far`,
      }
    },
  },
  {
    key: 'cash_drawer.open_tills',
    label: 'What the tills should hold, against the balance sheet',
    compares: 'Σ per drawer (open shift, or the float its last shift left in) against 1060',
    module: 'cash_drawer',
    severity: 'fault',
    meaning:
      'Nothing moves 1060 except opening a shift, taking cash into one, paying out of one, or ' +
      'closing one — and all four maintain both sides in the same transaction. A difference ' +
      'means cash was journalled into a till by hand, or a shift closed without its entry.',
    run: async (ctx, asOf) => {
      const result = await drawerPosition(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.registerCents,
        rightCents: result.ledgerCents,
        detail: (() => {
          const open = result.tills.filter((row) => row.openShiftId)
          if (result.tills.length === 0) return 'No tills.'
          return open.length === 0
            ? `${result.tills.length} till${result.tills.length === 1 ? '' : 's'}, none open`
            : `${open.length} open: ${open.map((row) => row.drawerName).join(', ')}`
        })(),
      }
    },
  },
  {
    key: 'funds.untagged_contributions',
    label: 'Donations that name no fund',
    compares: 'Contribution revenue against contributions tagged to a fund',
    module: 'funds',
    severity: 'position',
    meaning:
      'Not an error. A charity really does receive unrestricted money with no appeal attached — ' +
      'but that money is outside every figure on the funds report, and somebody should know how much.',
    run: async (ctx, asOf) => {
      const result = await netAssets(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.contributionRevenueCents,
        rightCents: result.contributionRevenueCents - result.untaggedContributionCents,
        detail:
          result.overspent.length === 0
            ? undefined
            : `${result.overspent.length} fund${result.overspent.length === 1 ? '' : 's'} spent ` +
              'beyond what was given for them',
      }
    },
  },
  {
    key: 'inventory.lots',
    label: 'The stock on the shelf, against the balance sheet',
    compares: 'Σ open lots against 1300',
    module: 'inventory',
    severity: 'fault',
    meaning:
      'The two are computed by different code from different tables, so agreement is evidence ' +
      'rather than tautology. A difference means stock moved without a posting, or the reverse.',
    run: async (ctx, asOf) => {
      const result = await reconcileInventory(ctx, { asOfDate: asOf })
      return {
        agrees: result.agrees,
        leftCents: result.subledgerCents,
        rightCents: result.ledgerCents,
      }
    },
  },
  {
    key: 'inventory.goods_received',
    label: 'Deliveries nobody has billed, against the clearing account',
    compares: 'Σ unbilled goods receipts against 2050',
    module: 'inventory',
    // A fault. Nothing legitimately posts to 2050 except a receipt taking
    // goods in and a bill clearing them out, so a difference is not a timing
    // artefact — the two are the same event seen from either end.
    severity: 'fault',
    meaning:
      'Receiving stock credits 2050 and the supplier\'s bill debits it, so the account should ' +
      'hold exactly the deliveries nobody has billed yet — and an accountant asking "what is in ' +
      'it" should get a list of deliveries rather than a number. Phase 48 found no check here ' +
      'at all, and a balance of $28,700 that nothing in the application could clear: a bill ' +
      'line could not name 2050, so every delivery was billed to inventory or an expense ' +
      'instead, counting the cost twice.',
    run: async (ctx) => {
      const unbilled = await unbilledReceiptValue(ctx)
      const account = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced)

      // `balanceForAccount` signs in the account's *normal* direction, so a
      // liability holding a credit balance comes back positive — which is
      // already what somebody asking "what do we owe for goods" means.
      const ledgerCents = account ? await balanceForAccount(ctx, account.id) : 0

      return {
        agrees: unbilled.totalCents === ledgerCents,
        leftCents: unbilled.totalCents,
        rightCents: ledgerCents,
        detail:
          unbilled.totalCents === ledgerCents
            ? undefined
            : `${unbilled.count} deliver${unbilled.count === 1 ? 'y is' : 'ies are'} unbilled, ` +
              `worth ${formatCents(unbilled.totalCents)}; the account carries ${formatCents(ledgerCents)}.`,
      }
    },
  },
  {
    key: 'receivables.customer_credit',
    label: 'What customers have overpaid, against the account holding it',
    compares: 'Σ unapplied receipts against 2520',
    // Core accounting rather than an optional module: every company can be
    // overpaid, so this runs for all of them.
    module: null,
    /**
     * A fault, not a position. Nothing legitimately posts to 2520 except a
     * receipt holding a leftover and the application or refund that clears it,
     * so a difference is not a timing artefact — the two are the same event
     * seen from either end.
     *
     * Added with the account rather than after it, because Phase 48 found a
     * clearing account with no check on it and $28,700 in it that nothing in
     * the application could clear. Once is enough to learn that.
     */
    severity: 'fault',
    meaning:
      'A customer who sends more than they owe has the difference held here until it goes ' +
      'against their next invoice or back to them. The account should equal exactly what is ' +
      'still unapplied on their receipts — an accountant asking "whose money is this" should ' +
      'get a list of customers rather than a number.',
    run: async (ctx) => {
      const rows = await heldCredits(ctx)
      const heldTotal = rows.reduce((sum, row) => sum + row.availableCents, 0)

      const account = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.customerOverpayments)
      // `balanceForAccount` signs in the account's *normal* direction, so a
      // liability holding a credit balance comes back positive — which is
      // already what "how much of other people's money are we holding" means.
      const ledgerCents = account ? await balanceForAccount(ctx, account.id) : 0

      return {
        agrees: heldTotal === ledgerCents,
        leftCents: heldTotal,
        rightCents: ledgerCents,
        detail:
          heldTotal === ledgerCents
            ? undefined
            : `${rows.length} receipt${rows.length === 1 ? '' : 's'} hold ` +
              `${formatCents(heldTotal)} between them; the account carries ` +
              `${formatCents(ledgerCents)}.`,
      }
    },
  },
  {
    key: 'manufacturing.wip',
    label: 'What the floor is holding, against work in process',
    compares: 'Σ open work orders against 1450',
    module: 'manufacturing',
    severity: 'fault',
    meaning:
      'Cost enters work in process when material is issued and leaves when a run finishes. A ' +
      'difference means a run consumed something the ledger did not see, or finished twice.',
    run: async (ctx, asOf) => {
      const result = await wipPosition(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.registerCents,
        rightCents: result.ledgerCents,
        detail: `${result.openOrders.length} run${result.openOrders.length === 1 ? '' : 's'} open`,
      }
    },
  },
  {
    key: 'pos.tips',
    label: 'Tips collected, against what is still owed to staff',
    compares: 'Σ imported days against 2310',
    module: 'pos_import',
    severity: 'position',
    meaning:
      'Expected to differ once tips have been paid out, which is payroll doing its job. The gap ' +
      'answers whether last month’s tips actually went out.',
    run: async (ctx, asOf) => {
      const result = await tipsPosition(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.collectedCents,
        rightCents: result.ledgerCents,
        detail:
        result.paidOutCents === 0
          ? undefined
          : `${formatCents(result.paidOutCents)} paid out so far`,
      }
    },
  },
  {
    key: 'properties.deposits',
    label: 'Deposits we are holding, against what we owe the tenants',
    compares: 'Σ deposit movements against 2580',
    module: 'properties',
    severity: 'fault',
    meaning:
      'A landlord who cannot show that the deposits they hold match the liability on their ' +
      'balance sheet has a problem no report will fix, and in most places a legal one.',
    run: async (ctx, asOf) => {
      const result = await depositsHeld(ctx, { asOf })
      return {
        agrees: result.agrees,
        leftCents: result.registerCents,
        rightCents: result.ledgerCents,
        detail: `${result.leases.length} lease${result.leases.length === 1 ? '' : 's'} holding money`,
      }
    },
  },
  {
    key: 'timebilling.retainers',
    label: 'Client money we are holding, against what we owe on it',
    compares: 'Σ retainer balances against 2550, or 2500 where that is all there is',
    module: 'time_billing',
    /**
     * A fault, in both of the shapes this check comes in.
     *
     * Taking a retainer and drawing on it each post in the same transaction
     * that maintains the balance, so on a dedicated account nothing can move
     * the two apart. On a shared account only the weaker claim is available —
     * see `retainer-position.ts` — but it is still one that nothing legitimate
     * can break, which is where this register draws the line.
     *
     * Added late, and the register already knew better: `receivables.
     * customer_credit` says "Added with the account rather than after it,
     * because Phase 48 found a clearing account with no check on it and
     * $28,700 in it that nothing in the application could clear. Once is
     * enough to learn that." Retainers arrived in Phase 15 with an account of
     * their own and no check until Phase 105.
     */
    severity: 'fault',
    meaning:
      'Money a client handed over before the work was done. A firm that cannot show the ' +
      'retainers it holds against the liability on its balance sheet has the same problem a ' +
      'landlord has with deposits, and in most places where professionals take money on ' +
      'account the rules about it are stricter.',
    run: async (ctx, asOf) => {
      const position = await retainerPosition(ctx, { asOf })
      const verdict = verdictFor(position)
      const caveat = weakerBecauseShared(position)

      return {
        agrees: verdict.agrees,
        leftCents: position.heldCents,
        rightCents: position.ledgerCents,
        // The caveat rides along even when the check passes: on a shared
        // account the tick means less than it looks like, and a check that
        // quietly weakens what it asserts is worse than one that is absent.
        detail: [verdict.detail, caveat].filter(Boolean).join(' ') || undefined,
      }
    },
  },
  {
    key: 'vehicles.authorisations',
    label: 'What each order says was agreed, against its own approvals',
    compares: 'repair_orders.authorised_cents against the authorisation rows',
    module: 'vehicles',
    severity: 'fault',
    meaning:
      'The cached total is what the billing ceiling is computed from, so a drift here is a bill ' +
      'somebody could not defend. Totals can net out while individual orders are wrong, so the ' +
      'offender list decides rather than the difference.',
    run: async (ctx) => {
      const result = await authorisationsAgree(ctx)
      return {
        agrees: result.agrees,
        leftCents: result.storedCents,
        rightCents: result.recordedCents,
        detail:
          result.offenders.length === 0
            ? undefined
            : result.offenders.map((row) => row.number).join(', '),
      }
    },
  },
]

/** Lookup by key, for a page rendering a stored finding. */
export function checkByKey(key: string): IntegrityCheck | undefined {
  return INTEGRITY_CHECKS.find((check) => check.key === key)
}

/**
 * The parties a control-account check named, as one line.
 *
 * Capped, because the point is to give somebody a place to start rather than
 * to reproduce the aging report in a notification.
 */
/**
 * A control account's finding: what the figure is made of, then who is in it.
 *
 * The composition leads because the subledger side stopped being "the open
 * invoices" in Phase 106, and a reader looking at a number that no longer
 * matches the aging report needs the reason before the names.
 */
function madeOf(check: {
  composition: string
  parties: Array<{ name: string }>
}): string | undefined {
  const who = named(check.parties)
  return [check.composition, who].filter(Boolean).join(' — ') || undefined
}

function named(parties: Array<{ name: string }>): string | undefined {
  if (parties.length === 0) return undefined
  const shown = parties.slice(0, 3).map((party) => party.name)
  return parties.length > 3
    ? `${shown.join(', ')} and ${parties.length - 3} more`
    : shown.join(', ')
}
