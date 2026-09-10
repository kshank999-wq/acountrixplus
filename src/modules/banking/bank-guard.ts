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
   * The currency the money is in, when the caller may say (Phase 136).
   *
   * Five callers do. ADR 0136 claimed `importPayouts` was the only one that
   * *could* — "the other nine have no such field" — and measuring in part 3
   * found five of the nine already reading a currency for their own rate
   * lookups, and simply never handing it over.
   *
   * Having it is not enough to pass it: the figure this path posts to the bank
   * has to be struck at the rate on the day the money moved, or letting it
   * through buys a posting the statement disagrees with. `recoverWriteOff` has
   * `writeOff.currency` and fails that test, so it still leaves this out —
   * `BANK_POSTINGS` records it as `withheld: 'no-day-rate'` and `askingFor`
   * checks the record against the source.
   *
   * Omitted, the Phase 133 rule stands: a foreign account is refused, which is
   * the honest answer when nothing knows what currency the amount was in.
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
