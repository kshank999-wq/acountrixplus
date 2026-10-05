# 0163 — The sweep that deleted nothing and said it worked

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 163

---

## The nomination, refused with a measurement

ADR 0162 nominated *"the `accountrix_worker` principal, so the queue tables can
be policed again rather than exempt, and so the five global handlers have
something to run as. That closes both halves this phase left open with one
role."*

**One role closes neither half, because the worker is not a principal.**
`runOnce` has three callers:

| caller | process | connects as |
| --- | --- | --- |
| `src/worker.ts` (`npm run worker`) | standalone | could be a worker role |
| `src/app/api/cron/worker/route.ts` | the web app | the web role |
| `src/app/actions/operations.ts` ("Run now") | the web app | the web role |

Two of three run inside the web process on the web connection, so a role named
after a deployment unit covers one caller in three. And the codebase already
explains why they share the code — `operations.ts` says it *"calls the same
`runOnce` the worker loop calls, so there is no second implementation"* — which
was the right call for correctness and is exactly what makes one role
insufficient.

Handing the web process worker credentials would give the queue-wide view to
whatever can run code in the web process, which is most of what the separation
was for. So the nomination is deferred, and what it was reaching for —
**knowing which paths rely on cross-tenant sight, and on what authority** — is
what this phase builds instead.

That is the third nomination in a row that measurement has had to correct. Worth
saying plainly: ADRs 0161, 0162 and 0163 each nominated a next step by reasoning
about how something would behave, and each was wrong in a way a ten-minute
measurement would have caught. The nominations are still worth writing — they are
what makes the correction findable — but they should be read as hypotheses.

## The second finding: the queue was two of six

Phase 162 exempted `background_jobs` and `domain_events` under
`crosses-tenants-by-design`. Measuring the five `global` job handlers found four
more paths of the same kind:

| path | across tenants | silent when blinded |
| --- | --- | --- |
| `claimJobs` | claims the oldest work anywhere | yes |
| `relayPendingEvents` | relays every unrelayed event | yes |
| **`sweepAll`** | **sweeps every company's expiring rows** | **yes** |
| `prune_jobs` | deletes succeeded jobs | yes |
| `prune_idempotency_keys` | deletes expired keys | yes |
| `morning_brief` | reads a firm's clients | no |

`housekeeping.retention` is the worst. It calls `sweepAll`, sums `removed`, and
returns `{ removed, byPolicy }`. Blinded it returns `{ removed: 0, byPolicy: {} }`
— **the same value it returns when there was genuinely nothing to remove** — and
the job is recorded as succeeded. Retention stops working and the first symptom
is tables growing that a policy says should not.

And it cannot be fixed by scoping it: a per-tenant sweep would need a list of
tenants, which is itself a cross-tenant read.

`morning_brief` is the one worth naming separately. Its authority to cross
tenants is a **practice engagement** — a firm may see its clients because
somebody signed one. That is a positive grant rather than the absence of a
tenant, and it is the only one of the three authorities a policy could express,
keyed on the session's practice rather than on a company. Hence
`a-practice-engagement` as its own value rather than folded into
`the-schedule`.

## What is actually worth building: zero rows is not an answer

All of these are silent for one reason, and it is not carelessness:

**A cross-tenant path cannot tell "I can see this table and it is empty" from "I
cannot see this table" by counting. Both are zero.**

No amount of care at the call site fixes that, because the information is not in
the result. It is in the catalogue. For each table, is row level security
enabled, and does *this role* get through it unconditionally — by being a
superuser, by `BYPASSRLS`, by owning an unforced table, or by a permissive policy
whose `USING` is `true`? That has a definite answer, and asking it is the same
move `rlsStands` makes: measure the mechanism, do not infer it from results.

The test proves the distinction rather than asserting it. `proposal_views` is
empty for a fresh company *and* policed; a count returns 0 on both connections,
and `crossTenantSight` returns `[]` for the owner and `['proposal_views']` for the
restricted role. Identical and meaningless against not identical and decisive.

## What was built

- **`CROSS_TENANT_PATHS`** — six paths, three authorities, each naming the tables
  it needs unrestricted sight of, the authority that stands in for a tenant
  setting, and whether being blinded looks like success. The sweep's tables are
  **derived** from `RETENTION_POLICIES` rather than listed, because a second copy
  is the one that goes stale when a policy is added — which would leave a table
  swept by a path the register says nothing about, the register's own failure one
  level up.
- **`crossTenantSight(tables, exec)`** — measured from `pg_class` and
  `pg_policies`. Also reports a table the register names and the database does
  not have, rather than passing by saying nothing was blind.
- **`assertCrossTenantSight(path)`** in front of the retention sweep and once per
  worker tick, throwing `CrossTenantBlindError` with the authority it was relying
  on, so the refusal is actionable.

Deliberately not in front of all six. The catalogue query costs a round trip, and
this phase's whole argument is that the information belongs at the start of the
work rather than at every statement. `silentWhenBlinded` says which paths need
it; the two that run on a schedule and sweep or drain are guarded.

## What this is not

It is not a permission. Nothing here grants cross-tenant access — these paths
already have it, because they run on a connection not subject to a tenant
policy. The register says **who is relying on that and for what**, so the day the
connection changes they fail loudly rather than quietly doing nothing.

It also does not make the retention sweep work on a restricted connection. It
makes it *refuse* to run there. That is the correct outcome and it is not the
same as solving the problem: the sweep still needs a principal, which is the
nomination below.

## What is nominated next

**A principal per kind of authority, not per deployment unit.** The three
authorities in the register are the three principals: a schedule-runner that may
see the queue, a retention-runner that may see what the policy sweeps, and a
practice session that may see its engagements. `runOnce`'s three callers are why
this cannot be done by naming a role after a process, and the `authority` field
is what makes it expressible.

**Then the web boundaries**, still the only part of the arc untouched: ~397 of
them, needing a pattern that survives React returning. `after()` is the candidate
ADR 0161 could not use for want of a boundary and which would supply one — and
on this phase's evidence it should be measured on one page before it is believed.
