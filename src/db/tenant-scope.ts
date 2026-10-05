/**
 * The tenant a query is running for, carried by the connection (Phase 161).
 *
 * ## Why this exists, measured
 *
 * Phase 160 installed row level security and `withTenant`, which opens a
 * transaction, sets `app.company_id` for it, and hands the caller the executor.
 * Then nothing called it — and measuring why turned up something worse than an
 * oversight:
 *
 * | measured | count |
 * | --- | --- |
 * | sites reaching the module-level `db` directly | 903 |
 * | service entry points taking an `ActorContext` | 802 |
 * | functions accepting an `Executor` | 149 |
 *
 * `withTenant(ctx, (tx) => trialBalance(ctx, range))` does nothing useful,
 * because `trialBalance` ignores the executor it was not given and reads `db`.
 * The 149 that do take one are write paths, threaded for transactions years of
 * phases ago. **So `withTenant` had no caller and could not have one** without
 * adding a parameter to 802 functions and then remembering to pass it at 903
 * sites. Phase 49's rule — a function with no caller is a feature that does not
 * exist — with the measurement that says why it was not a matter of somebody
 * getting round to it.
 *
 * ## So the connection carries it, not a parameter
 *
 * This is the move Phase 149 made at the query level with `scoped()`, and Phase
 * 116 settled as a rule: a constraint beats a check. A tenant threaded through
 * 802 signatures is a check at every one of them. A tenant bound to the
 * connection the query lands on is a constraint, and the 903 call sites do not
 * change at all.
 *
 * `AsyncLocalStorage` is how a Node process keeps per-request state without a
 * parameter. The store holds the open transaction and the company it was opened
 * for; `db` is a proxy that resolves to that transaction whenever a scope is
 * open, so every read at any depth below `withTenant` lands on the connection
 * that has the setting — including reads in modules that have never heard of
 * this one.
 *
 * ## What it does not do
 *
 * It does not open the scope. Something still has to call `withTenant` once per
 * request, and in Next.js's App Router there is no single place that wraps a
 * render — which is the remaining work and is recorded in `RLS_ROLLOUT` rather
 * than implied. Outside a scope `db` is the plain pooled handle and behaves
 * exactly as it did before this phase, which is why applying this changes
 * nothing until somebody opens one.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type TenantScope = {
  /** The open transaction every query in this scope should land on. */
  executor: unknown
  /** The company its `app.company_id` is set to. */
  companyId: string
}

/**
 * Deliberately module-private, with readers rather than direct access.
 *
 * Exporting the storage would let any module call `enterWith`, which sets the
 * store for the current async context and **never unsets it** — there is no
 * callback boundary and so nothing to release the transaction on. A leaked
 * reservation exhausts the pool, which fails as connection timeouts a long way
 * from the cause. `run` is the only form offered because it is the only form
 * with an end.
 */
const storage = new AsyncLocalStorage<TenantScope>()

/** The scope this query is inside, or `undefined` for the plain pooled handle. */
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore()
}

/** Runs `fn` with every `db` use inside it bound to `scope.executor`. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn)
}
