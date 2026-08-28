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
import { authorisationsAgree } from '@/modules/vehicles/reporting'
import { paymentsInTransitPosition } from '@/modules/payments/reporting'

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
    compares: 'Accounts Receivable against open invoices',
    module: null,
    severity: 'fault',
    meaning:
      'Nothing legitimately moves a control account except a document. A difference means an ' +
      'entry was posted straight at 1100, or an invoice exists that the ledger never heard about.',
    run: async (ctx, asOf) => {
      const result = await controlAccounts(ctx, { asOf })
      return {
        agrees: result.receivables.agrees,
        leftCents: result.receivables.subledgerCents,
        rightCents: result.receivables.ledgerCents,
        detail: named(result.receivables.parties),
      }
    },
  },
  {
    key: 'ledger.payables',
    label: 'What we owe, against who we owe it to',
    compares: 'Accounts Payable against open bills',
    module: null,
    severity: 'fault',
    meaning: 'The same rule as receivables, on the other side of the balance sheet.',
    run: async (ctx, asOf) => {
      const result = await controlAccounts(ctx, { asOf })
      return {
        agrees: result.payables.agrees,
        leftCents: result.payables.subledgerCents,
        rightCents: result.payables.ledgerCents,
        detail: named(result.payables.parties),
      }
    },
  },
  {
    key: 'banking.shared_ledger_accounts',
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
function named(parties: Array<{ name: string }>): string | undefined {
  if (parties.length === 0) return undefined
  const shown = parties.slice(0, 3).map((party) => party.name)
  return parties.length > 3
    ? `${shown.join(', ')} and ${parties.length - 3} more`
    : shown.join(', ')
}
