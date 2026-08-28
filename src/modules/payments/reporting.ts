import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import type { ActorContext } from '@/modules/tenancy/context'
import { heldByProcessor, unresolvedCheckouts } from './service'

/**
 * Whether `1250 Payments in Transit` holds what the processor actually owes
 * (spec §19, Phase 44).
 *
 * ## What makes this checkable at all
 *
 * The clearing account exists precisely so there is something to check. Money
 * taken by card and not yet deposited is a real asset with a real counterparty
 * who publishes a figure for it, and posting it to the bank on the day of the
 * charge would have thrown that away — the business would have no way to know
 * whether the processor is holding what it should.
 *
 * The register's convention is left minus right, left being the subledger. The
 * subledger here is the set of captured, unswept checkouts; the ledger is the
 * account.
 *
 * ## Why a difference is a fault rather than a position
 *
 * Unlike the bank tie-out, nothing legitimately posts to `1250` except this
 * module. Every entry that touches it is one of the three Phase 44 writes, so
 * a difference means something is genuinely wrong: a fee posted without a
 * capture, or a payout that swept a checkout it did not settle.
 *
 * ## The failure the comparison alone cannot see (Phase 46)
 *
 * ADR 0044 claimed this check would also catch *"a payment the customer made
 * that never reached these books"*. **It could not**, and the reason is worth
 * stating rather than quietly fixing.
 *
 * A customer who pays and closes the tab leaves the checkout `pending`.
 * `heldByProcessor` counts only `succeeded` rows, so the processor side reads
 * zero; nothing posted, so the ledger side reads zero. The comparison agrees
 * perfectly while the money sits at the processor unrecorded — and Phase 43
 * chases the customer for an invoice they have already paid.
 *
 * Two zeroes agreeing is not the same as nothing being wrong. So the check
 * carries a third number that no subtraction can produce: how many checkouts
 * were started and never resolved. A stale one is not "in progress"; it is a
 * question nobody has answered, and the honest thing is to count it.
 */
export async function paymentsInTransitPosition(
  ctx: ActorContext,
  asOf?: string,
): Promise<{
  agrees: boolean
  /** What the processor still owes, per our own checkout records. */
  owedCents: number
  /** What the clearing account carries. */
  ledgerCents: number
  differenceCents: number
  /** Checkouts started and never resolved. Invisible to the subtraction. */
  unresolvedCount: number
  /** What those are worth, if the customer was charged. */
  unresolvedCents: number
}> {
  const account = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.paymentsInTransit)

  if (!account) {
    // A company whose chart predates this phase and whose migration has not
    // run. Nothing has been captured either, so zero against zero is the
    // truthful answer rather than an error.
    return {
      agrees: true,
      owedCents: 0,
      ledgerCents: 0,
      differenceCents: 0,
      unresolvedCount: 0,
      unresolvedCents: 0,
    }
  }

  const [owedCents, ledgerCents, unresolved] = await Promise.all([
    heldByProcessor(ctx.companyId),
    balanceForAccount(ctx, account.id, asOf ? { endDate: asOf } : undefined),
    unresolvedCheckouts(ctx.companyId, asOf),
  ])

  const unresolvedCents = unresolved.reduce((sum, row) => sum + Number(row.grossCents), 0)

  return {
    // Both halves have to hold. Agreeing figures with an unanswered checkout
    // behind them is the state this check was blind to.
    agrees: owedCents === ledgerCents && unresolved.length === 0,
    owedCents,
    ledgerCents,
    differenceCents: owedCents - ledgerCents,
    unresolvedCount: unresolved.length,
    unresolvedCents,
  }
}
