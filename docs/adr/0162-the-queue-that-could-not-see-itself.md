# 0162 — The queue that could not see itself

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 162

---

## The nomination, refuted in three lines

ADR 0161 nominated *"opening the scope, on one real surface, end to end. The
accounting reports page is the right first one."*

It is not, and the reason is mechanical rather than a matter of taste:

```
inside the parent body:                  alpha
child called after the parent returned:  null
child called inside a scope:             beta
```

**An `AsyncLocalStorage` scope does not survive the function that opened it
returning.** The reports page calls `requireActor()` and returns an element tree
holding nine async child server components — `TrialBalanceReport` and its
siblings — which React invokes *after* the page function returns. A scope opened
in the page body would cover the construction of that tree and none of the
fetching inside it, and the transaction would already be committed.

The probe is kept as the first test in `tests/a-job-through-the-policies.test.ts`,
isolated from React so it is about the mechanism rather than about a framework
version.

The denominator was wrong too. ADR 0161 said "one page, wrapped":

| boundary | count |
| --- | --- |
| async server components in `src/app` | 97 |
| `.tsx` files importing from `@/modules` | 115 |
| exported server actions across 44 `'use server'` files | 300 |

Nearer four hundred. That correction is the first half of this phase, and it is
the second nomination in a row that measurement has had to put right — which is
worth noting as a pattern rather than an accident: both were guesses about how
something would behave, written into an ADR as plans.

## The one surface that does have a single boundary

`runJob` in `src/modules/worker/runner.ts` dispatches **every** background job.
One function, already holding `job.companyId`, already distinguishing
`definition.global`, and invoking the handler on one line. Wrapping that line
covers all 24 registered handlers — 19 tenant, 5 global — and none of them
changed.

It is also **the first production caller of `withTenant`.** Phase 160 shipped it
with nothing able to call it; Phase 161 made the tenant travel on the connection
instead of in a parameter; this is the line that uses both.

## What wiring it exposed: Phase 160 had taken the queue out

Two of the 163 tables Phase 160 policed are read **across** tenants on purpose.

- **`background_jobs`.** `claimJobs` is raw SQL with a `LIMIT` and **no company
  filter**, because a poller claims whatever work is oldest across every tenant.
  That is what a poller is.
- **`domain_events`.** `relayPendingEvents` reads `where relayed_at is null`
  with **no company filter**, because an outbox drain is global for the same
  reason.

Under the tenant policy, on a restricted role, with no scope open:

| path | what happens |
| --- | --- |
| `claimJobs` | returns nothing — **the queue never drains** |
| `relayPendingEvents` | returns nothing — **events are never fanned out** |
| `failJob` / `completeJob` | affect 0 rows — a claimed job retries until it dies |

A complete outage of all background processing, caused by a security control.
And silent: nothing errors, because an empty result is a valid result. *"The
queue is empty"* and *"nothing can see the queue"* render identically — which is
the failure `runner.ts`'s own `heartbeat` comment already warns about, in those
words:

> Without it, "the queue is empty" and "nothing is draining the queue" render
> identically, and the second is an outage that looks like calm.

That comment was written many phases before row level security existed, about a
different cause, and it describes this exactly. Worth recording, because it is
the second time this phase that something already in the codebase turned out to
have anticipated the problem.

## A second exemption ground

Phase 160's `ExemptionGround` had one value, `establishes-the-tenant`: the table
is read in order to work out who the caller is, so a policy keyed on the tenant
cannot protect the table the tenant is derived from.

These two are not that. Nothing reads the job queue to find out who the caller
is. They are read across tenants deliberately. So `crosses-tenants-by-design` is
a second ground, argued as its own value rather than bent onto the nearest
(Phase 130) — because the two grounds imply different remedies, and a single
ground would have hidden that.

Six exempt tables now, under two grounds, each entry carrying what policing it
would do.

## Why un-policing, and what must never be done instead

The tempting fix is to widen the policy:

```sql
-- Never this.
USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid
       OR current_setting('app.company_id', true) IS NULL)
```

That is a **fail-open control dressed as a fail-closed one**. Every forgotten
scope anywhere in the application would see every tenant's rows — the `coalesce`
trap Phase 160 named, with extra steps. It is written into the `ExemptionGround`
prose so the next person reaches it already refused.

The *right* answer is a **second principal**: an `accountrix_worker` role with
its own `FOR ALL TO accountrix_worker USING (true)` on these two tables, keeping
the tenant policy for the web role. The worker genuinely is a different
principal from a web request, and a policy cannot express "this one sees
everything" without a role to attach it to.

That is a second role and a second `DATABASE_URL`, compounding the deployment
change already outstanding from Phase 160, so the exemption is explicitly
**provisional** and nominated below rather than slipped in.

Un-policing is safe in the meantime because the first layer is untouched. Phases
149 and 150 measured every read as guarded; `domain_events`'s per-company
readers, `listEvents(companyId)` and `eventsFor(companyId)`, are
`explicit-company`; and the two drain paths were deliberately global before row
level security existed and remain so.

## The honest half of the worker

**Five of the 24 handlers are `global`.** They have no company, so there is
nothing to set, so they get no scope — they run on the pooled handle and would
see nothing once the application connects as a restricted role.

That is recorded in `RLS_ROLLOUT` and asserted in the test rather than papered
over. It is the part of this surface the phase does not finish, and it is the
same shape as the exemptions: a thing that reads across tenants, needing a
principal rather than a scope.

`completeJob` and `failJob` are deliberately **outside** the scope. Inside it,
the bookkeeping would depend on a scope the global jobs do not have.

## The tripwire

There is exactly one place a job handler is invoked, and a second one added
later would bypass the scope silently — working on the owner connection and
returning nothing on a restricted one. So the test counts
`definition.handler(` occurrences in the source and asserts the tenant branch
reads as written, the same way this codebase has counted reads and writes since
Phase 149.

## What is nominated next

**The `accountrix_worker` principal**, so the queue tables can be policed again
rather than exempt, and so the five global handlers have something to run as.
That closes both halves this phase left open with one role.

**Then the web boundaries**, which need a pattern that survives React returning.
The two honest candidates are hoisting fetches into the page body and passing
data rather than the actor to children — correct architecture, large diff — or
`after()` to close a scope `requireActor` opened with `enterWith`, which ADR 0161
refused for lack of a boundary and which `after()` would supply. That is a design
question with a real trade in it, not a mechanical one, and it should be decided
on one page before it is applied to ninety-seven.
