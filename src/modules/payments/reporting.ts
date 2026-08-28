import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import type { ActorContext } from '@/modules/tenancy/context'
import { heldByProcessor } from './service'

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
 * module. Every entry that touches it is one of the three this phase writes,
 * so a difference means something is genuinely wrong: a fee posted without a
 * capture, a payout that swept a checkout it did not settle, or a payment
 * captured at the processor and never posted here — the last being the one
 * failure mode that leaves a customer's money unrecorded.
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
}> {
  const account = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.paymentsInTransit)

  if (!account) {
    // A company whose chart predates this phase and whose migration has not
    // run. Nothing has been captured either, so zero against zero is the
    // truthful answer rather than an error.
    return { agrees: true, owedCents: 0, ledgerCents: 0, differenceCents: 0 }
  }

  const [owedCents, ledgerCents] = await Promise.all([
    heldByProcessor(ctx.companyId),
    balanceForAccount(ctx, account.id, asOf ? { endDate: asOf } : undefined),
  ])

  return {
    agrees: owedCents === ledgerCents,
    owedCents,
    ledgerCents,
    differenceCents: owedCents - ledgerCents,
  }
}
