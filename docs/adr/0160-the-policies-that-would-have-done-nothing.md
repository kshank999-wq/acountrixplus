# 0160 — The policies that would have done nothing

**Status:** accepted
**Date:** 2026-10-05
**Phase:** 160

---

## The nomination, which survived

ADRs 0157, 0158 and 0159 each nominated spec §19's database-layer tenant
isolation, on the grounds that it was the last item on the spec audit that is a
stated requirement rather than a feature. Verified before building:

| measured | result |
| --- | --- |
| tables with row level security enabled | 0 |
| rows in `pg_policies` | 0 |
| tables carrying `company_id` | 167 |
| tables without one | 14 |

So it is genuinely absent, genuinely required, and genuinely large. The
nomination stands.

What did not survive is the shape of the work. Phases 149 and 150 had described
this as *"a second layer and a migration"*, and it is a migration the way a lock
is a hole in a door.

## What measuring found before a line was written

**The application connects as `postgres`. That role is a superuser and it owns
all 181 tables.**

Row level security is never applied to a superuser, and is not applied to a
table's owner unless `FORCE ROW LEVEL SECURITY` is also set. So the obvious
version of this phase —

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoices USING (company_id = current_setting('app.company_id')::uuid);
```

— repeated across every tenant-scoped table would have produced 163 rows in
`pg_policies`, 163 tables reporting `relrowsecurity`, a line in the release
notes, and **exactly no isolation**. Every policy inert. Every query unaffected,
so nothing breaks and nobody looks. And the next person to audit this database
by listing its policies — which is what an auditor does — would read 163 of them
and conclude the tenants were separated at the storage layer.

That is Phases 110 and 125's defect (a declaration argued from a fact that is
not a fact) in the worst available place, and Phase 121's (a check only ever seen
to agree) in its most dangerous form, because a policy that is never consulted
cannot disagree.

**A security control that looks present and does nothing is worse than its
absence, because its absence is legible.**

So `RLS_BYPASSES` is the register of the five ways this control can be installed
and do nothing, and the field that matters on each entry is `appearance` — what
it looks like from outside. Four of the five leave the database reporting that
RLS is on.

| bypass | what it looks like |
| --- | --- |
| `superuser` | Perfect, and nothing breaks |
| `unforced-owner` | Also perfect, and identical symptoms, so fixing the first alone leaves this |
| `bypassrls` | Perfect, and the hardest to notice — not a superuser, tables forced |
| `policy-without-enable` | `pg_policies` is full and nothing consults it |
| `session-scoped-setting` | Isolation *works*, until two requests share a pooled backend |

The fifth is the one that fails neither open nor closed but **sideways**: a plain
`SET` lasts for the life of a connection, postgres-js pools ten, and the next
request handed that backend inherits the last one's tenant — which the policy
then faithfully applies. One tenant reads another's books through a query that is
filtering correctly on the value it was given. Nothing errors. `withTenant` opens
a transaction and uses `set_config(…, true)` for exactly that reason: the
transaction is not there for atomicity, it is there because it is the only unit
Postgres will scope a setting to *and* the driver will keep on one backend, and
those have to be the same unit.

## The four tables that must not be policed

This was not the plan. The migration's first draft protected every table
carrying a `company_id` — all 167 — and `tests/rls-bites.test.ts` failed on
`memberships`. Chasing that found four, and they are not an oversight in the
rule. They are a property of what those tables are for: **each is read in order
to decide who the caller is and what they may do, which is strictly before any
tenant can be set.** A policy keyed on `app.company_id` cannot protect a table
the setting is derived from.

| table | what policing it does |
| --- | --- |
| `memberships` | **Sign-in stops working.** The read that resolves the caller's role *is* the row the policy would filter by, and `companiesForUser` returns an empty company picker, so there is no way to choose a tenant either. Circular, and loud. |
| `devices` | **A revoked device reads as live.** Left-joined for `deviceRevokedAt`; an invisible row yields NULL, which the code reads as "not revoked". Adding RLS would quietly undo device revocation, a Phase 8 security feature. |
| `security_policies` | **The company's security policy reads as absent**, so lockout thresholds, session lifetime and any MFA requirement fall back to defaults on the authentication path that is supposed to enforce them. |
| `practice_engagements` | A practice user loses the `viaPractice` label, so the audit log records the person acting without recording that they work for the client's accountants — the distinction `recordAudit` was given that field for. |

Two of the four degrade **silently**, and those are what earn the register. A
policy that breaks sign-in is noticed in a minute. A revoked device reading as
live, or a security policy reading as absent, is **a security control weakening
authentication while reporting success** — the same shape as the inert-policy
problem above, arrived at from the opposite direction.

It is also why the migration cannot be a loop over `information_schema` alone.
"Has a `company_id`" is a good rule and it is not the whole rule, and an
exception list that does not carry its reasons gets deleted by the next person
who reads it as an omission.

## The predicate, which the acceptance test corrected

`tenantPredicate` first returned:

```sql
company_id = current_setting('app.company_id', true)::uuid
```

reasoned as: an unset setting is `NULL`, `company_id = NULL` is `NULL`, the row
is filtered out, a query with no tenant sees nothing. The prose asserting that
was written confidently and it was incomplete.

**Once a custom GUC has been set at all in a session — including by a `SET LOCAL`
that has since rolled back — Postgres remembers it and reverts it to the empty
string rather than forgetting it.** The predicate becomes `company_id = ''::uuid`
and raises `invalid input syntax for type uuid: ""` instead of filtering. Still
fail-closed, since an error leaks nothing, but a 500 on a pooled connection whose
previous occupant happened to set a tenant — a bug that appears under load and
not in development.

`nullif(…, '')` turns both states back into `NULL` and both into no rows. The
test that found it is the one asserting *"sees nothing at all when no tenant is
set"*: it failed because the query threw rather than returning zero.

Worth keeping the near-miss beside it. The inviting way to write this predicate
is

```sql
company_id = coalesce(current_setting('app.company_id', true)::uuid, company_id)
```

which returns **every tenant's rows** when the setting is missing. One function
call apart from the right answer, and the opposite of it.

## What this phase does not claim

It does not claim production is isolated at the database layer, and this is the
part most worth reading twice.

The migration installs the mechanism, forces it, and **changes nothing for the
running application by design**, because the application still connects as a
superuser that owns the tables. Switching that is a deployment change, and then
every query has to carry the tenant through `withTenant` — which 883 reads do
not yet. A query outside `withTenant` on the restricted role returns **no rows**:
the right direction to fail in, and still an outage.

So:

- `RLS_ROLLOUT` is the register (Phase 139's device — a staged core gets a
  register and an acceptance test), with one surface `live` and one `bypassed`.
- `rlsStands` refuses to report isolation on a connection that bypasses it, and
  `tests/rls-bites.test.ts` asserts it refuses *this* application's connection.
- `docs/DEPLOY.md` has the two steps, and says to read them before answering a
  security questionnaire from `pg_policies`.

The alternative was shipping inert policies and calling them isolation, or not
shipping until somebody changes a `DATABASE_URL` this session cannot change. The
register is what makes a third option honest rather than evasive.

## Smaller things

`companyScopedTablesIn` gained `companyScopedSqlTablesIn`, because RLS needs
`chart_accounts` where the isolation scans needed `chartAccounts`. Two
projections of one rule, with the declaration-boundary split written once — so
Phase 149's parsing mistake, which miscounted nine tables, cannot be made twice
in two places.

The role is created `NOLOGIN` with no password. A migration that shipped a
credential would be a credential in version control, which is §12's rule read
from the inside. The test gives it a throwaway password and takes it away again,
which is how the acceptance test can prove the policies bite without anything
secret living in the repository.

## What is nominated next

**A policy for the four exempt tables, keyed on the session rather than the
tenant.** This is the first nomination in four phases that is not row level
security, and it is the direct consequence of this one: those tables are exactly
the ones an attacker with a database connection would want, and they are the
four this phase left open. What they need is not a later ordering but a different
key — `app.session_id` or `app.user_id`, set by the same `withTenant` seam — and
working out what a policy on an access-granting table should say is a phase, not
a line.

Second, and larger: **routing reads through `withTenant`**. 883 of them, and
until they go the second layer cannot be switched on. That is mechanical work
with a measured denominator and an existing register, which makes it a good
phase rather than a long one.
