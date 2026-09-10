import { eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { financialAccounts } from '@/db/schema'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import { scoped, type ActorContext } from '@/modules/tenancy/context'
import { functionalCurrency } from '@/modules/fx/service'
import { mayPostToBank } from '@/modules/fx/bank-side'

/**
 * The ledger account a bank account posts through, once it has been asked
 * whether it may (Phase 133).
 *
 * ## Why the lookup and the question are one call
 *
 * Ten paths posted into a bank account's ledger account, and each did its own
 * two-line lookup: select the `chart_account_id`, refuse if the row is not
 * there. Ten copies of a lookup is how ten copies of a *missing* question
 * happen — nobody adding the eleventh path would have known there was one to
 * ask, because there was nowhere for it to live.
 *
 * So the question travels with the lookup. A path that wants the ledger account
 * gets it from here and is refused here, and the twelfth path inherits the rule
 * by using the same function rather than by remembering.
 *
 * `what` is the act in the words the person used — "remitting this liability",
 * "banking this deposit" — because the refusal names it, and "operation failed"
 * makes somebody guess which of the things they just did was refused.
 */
export async function bankGlAccountFor(
  ctx: ActorContext,
  financialAccountId: string,
  what: string,
  exec: Executor = db,
  /**
   * The currency the money is in, when the caller knows it (Phase 136).
   *
   * Only `importPayouts` does: `payouts.currency` is what the processor said it
   * sent. The other nine have no field for it, so they leave it out and get the
   * Phase 133 rule — a foreign account refused — which is the honest answer when
   * nothing knows what currency the amount was in.
   */
  moneyCurrency?: string,
): Promise<string> {
  const [account] = await exec
    .select({
      chartAccountId: financialAccounts.chartAccountId,
      currency: financialAccounts.currency,
      name: financialAccounts.name,
    })
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, financialAccountId)))
    .limit(1)

  if (!account) throw missing('financialAccount')

  const verdict = mayPostToBank({
    accountName: account.name,
    accountCurrency: account.currency,
    homeCurrency: await functionalCurrency(ctx.companyId, exec),
    what,
    moneyCurrency,
  })

  // A `Refusal` rather than a bare Error: the sentence names the account, both
  // currencies and what to do instead, and Phase 119 established that a
  // sentence written for a reader has to carry something saying so.
  if (!verdict.ok) throw new Refusal(verdict.why)

  return account.chartAccountId
}
