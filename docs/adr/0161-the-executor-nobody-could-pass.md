# 0161 — The executor nobody could pass

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 161

---

## The nomination, checked and deferred

ADR 0160 nominated a session-keyed policy for the four tables it left exempt —
`memberships`, `devices`, `security_policies`, `practice_engagements` — on the
grounds that they are exactly what an attacker with a database connection would
want.

That argument still holds and the sequencing was wrong. Measured first:

- The application connects as a superuser that owns every table, so **no policy
  that exists applies to it.**
- **`withTenant` had no caller.** Three references in the whole repository and
  all three are prose about it.

Adding four more policies on top of that would have been a second consecutive
phase of security mechanism that nothing uses — Phase 49's defect (a function
with no caller is a feature that does not exist) at the scale of a subsystem,
and the same shape as the inert policies Phase 160 was written to avoid. So the
nomination is re-made at the end of this document, behind the thing that makes
any of it live.

## Why `withTenant` had no caller, which is worse than an oversight

| measured | count |
| --- | --- |
| sites reaching the module-level `db` directly | 903 |
| service entry points taking an `ActorContext` | 802 |
| functions accepting an `Executor` | 149 |

Phase 160's `withTenant` opens a transaction, sets `app.company_id` for it, and
hands the caller the executor. The obvious use —

```ts
await withTenant(ctx, (tx) => trialBalance(ctx, range))
```

— does nothing useful, because `trialBalance` has no executor parameter and
reads `db`. Neither does `accountBalances` below it. The 149 functions that *do*
accept an `Executor` are write paths, threaded for transaction reasons many
phases ago; the read surface was never threaded and was never meant to be,
because Phase 149 made read isolation structural with `scoped()` rather than
per-call-site.

So `withTenant` was not waiting for somebody to get round to calling it. **It
could not be called**, short of adding a parameter to 802 functions and then
remembering to pass it at 903 sites. ADR 0160 wrote the remaining work down as
*"883 reads have to go through `withTenant`"*, which read as mechanical and was
not: it was 802 signature changes first.

## So the connection carries the tenant, not a parameter

This is the move this codebase keeps making and Phase 116 settled as a rule: **a
constraint beats a check.** A tenant threaded through 802 signatures is a check
at every one of them, and the one that forgets is a cross-tenant query. A tenant
bound to the connection the query lands on is a constraint at one place.

Phase 149 did the same thing one level down — `scoped()` makes a `where` clause
carry the company rather than trusting each query to remember. This is that,
one level further out.

Three pieces:

1. **`src/db/tenant-scope.ts`** — an `AsyncLocalStorage` holding the open
   transaction and the company it was opened for.
2. **`db` is a proxy.** When a scope is bound it resolves to that transaction;
   otherwise it is the pooled handle. `Reflect.get` with the resolved source as
   receiver so drizzle's own getters see the object they belong to, functions
   bound for the same reason, and `has`/`getPrototypeOf` forwarded so anything
   reflecting over the handle describes what it would actually delegate to.
3. **`withTenant` binds the scope** after setting the GUC, so nothing inside can
   observe a scope whose connection does not yet carry a tenant.

The result is that every read below `withTenant`, at any depth, in modules that
have never heard of row level security, lands on the connection the policy can
see a tenant on. **No call site changed.**

## The proof

`tests/a-report-through-the-policies.test.ts` runs `trialBalance`,
`accountBalances`, `arAging` and `listAccounts` — real service functions, taking
no executor, reading the module-level `db` — on a connection as `accountrix_app`
inside a tenant scope.

They work, and they return the same figures as the owner connection: Alpha's
trial balance foots to $4,000 and Beta's to $11, deliberately far apart so a leak
could not pass as a rounding difference. Three different query shapes — a grouped
sum, a document-level aging read with its own joins and currency lookup, and a
plain list — none of them touched by this phase.

Outside a scope, the same restricted connection sees nothing. Fails closed, which
is the right direction and is still an outage.

## Two guards, and why each is there

**Re-entrant for the same company.** A report that calls two services which each
open a scope should be one transaction, not three nested savepoints. Asserted by
identity: the inner scope *is* the outer one.

**Refused for a different company.** There is no legitimate reason for one
request to open a tenant scope inside another tenant's, and the failure it would
otherwise cause is the worst available kind: the inner `set_config` succeeds,
every query in the *outer* scope after that point silently runs as the inner
company, and both are filtering correctly on the value they were given. A
cross-tenant read with nothing to say so. So it throws.

## Why `enterWith` is not offered

`AsyncLocalStorage.enterWith` sets the store for the current async context
without a callback, which would have allowed `requireActor` to bind a scope and
have the rest of the request inherit it — a tempting answer to the open-the-scope
problem below.

It is not offered, and the storage is module-private so nobody can reach for it:
**`enterWith` has no boundary, so nothing releases the transaction.** A leaked
connection exhausts the pool and fails as connection timeouts some distance from
the cause, which is the same class of problem `isPooled` in `src/db/index.ts`
already carries a long comment about. `run` is the only form exported because it
is the only form with an end.

## What this does not do

It does not open a scope. Something has to call `withTenant` once per request,
and **Next.js's App Router has no single place that wraps a render** — middleware
runs in the edge runtime with no Postgres driver, and a server component cannot
wrap its own request. So that is a per-surface change across pages and server
actions rather than a line, and it is the remaining work.

`RLS_ROLLOUT` records it: two live surfaces, both tests, and one bypassed — the
application's own connection, which is still a superuser that owns the tables.
`tests/a-report-through-the-policies.test.ts` asserts that outside a scope `db`
is the pooled handle and the 903 call sites behave exactly as they did before,
which is why applying this phase changes nothing until a scope is opened.

Worth being plain about what moved and what did not. Before this phase the
remaining work was *802 signature changes, then 903 call sites, then a
deployment change*. After it the remaining work is *open a scope per surface,
then a deployment change*. The mechanism is complete and it is not switched on.

## What is nominated next

**Opening the scope, on one real surface, end to end.** The accounting reports
page is the right first one: it is read-only, it calls six services that between
them cover most query shapes in the codebase, and a report that silently returned
nothing would be obvious rather than subtle. One page, wrapped, running against
`accountrix_app` in a test that renders it — and then the register says how many
surfaces are left.

**Then ADR 0160's session-keyed policies**, which keep their argument intact and
are now second rather than third: once a scope is opened per request, `app.
session_id` can be set beside `app.company_id` by the same seam, and a policy on
`memberships` keyed on the session's user becomes expressible rather than
circular. Those four tables are still the ones an attacker would want.

> **Corrected by Phase 167.** The refusal this ADR argues for — a nested tenant
> scope for a different company — was thrown as a bare `Error` with a sentence
> the Phase 119 audience heuristic reads as person-facing, so
> `tests/refusal-audience.test.ts` has been red since this phase. Nothing caught
> it for six phases, because no full suite completed in between. It is now the
> twelfth entry in `ALLOWED_BARE_REFUSALS`, argued there: the refusal is correct
> and must not reach a screen, since showing it would put two company ids on one.
