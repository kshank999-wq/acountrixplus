# ADR 0001 — Modular monolith, tenancy, and permission strategy

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §17 (service boundaries), §18 (technology direction), §14 (roles), §19 (security), §21 (first assignment)

## Context

Spec §21 asks the coding agent to inspect the existing repository before choosing an
architecture. The repository was empty — no commits, no files — so this is a
greenfield implementation and §18's greenfield guidance applies: a modern typed
web stack, a relational database suited to transactional accounting, background
jobs, object storage, and a responsive web/PWA interface.

Spec §17 lists twelve service boundaries but explicitly permits implementing them
as well-separated modules inside a modular monolith for the initial build,
provided the domain interfaces stay clean enough to extract later.

## Decisions

### 1. One Next.js application, organized as a modular monolith

TypeScript end to end (Next.js App Router, React 19), PostgreSQL via Drizzle ORM,
Tailwind for styling, Vitest for tests.

Domain logic lives in `src/modules/<domain>/` and never in route handlers or
React components. The current modules map onto spec §17 boundaries:

| Module | Spec §17 boundary |
| --- | --- |
| `modules/tenancy` | Identity & Tenant Service |
| `modules/auth` | Identity & Tenant Service |
| `modules/permissions` | Identity & Tenant Service |
| `modules/banking` | Banking/Feed Integration Service |
| `modules/bookkeeping` | Bookkeeping Rules & Transaction Review Service |
| `modules/coa` | Accounting Ledger Service (chart of accounts) |
| `modules/audit` | Audit/Compliance Service |

`src/app/` holds only routing, rendering, and server actions. A server action's
job is to resolve the actor, call one service function, and translate the result
for the UI. Extracting a module into its own service later means moving a
directory and replacing direct calls with RPC — not untangling business logic
from React.

**Rejected:** separate API and SPA (spec §17 explicitly allows the monolith, and
two deploy targets would slow the first vertical slice for no present benefit);
microservices from day one (premature at this scale).

### 2. Tenant isolation through an explicit actor context, not ambient state

Every service function takes an `ActorContext` as its first argument:

```ts
type ActorContext = {
  userId: string
  userName: string
  companyId: string
  role: Role
  overrides?: string | null
}
```

There is no ambient "current company" — no request-local global, no
`AsyncLocalStorage`. A query cannot accidentally omit the tenant filter because
there is nowhere else to obtain a company id. Queries compose their WHERE clause
through a helper that always includes the tenant predicate:

```ts
db.select().from(bankTransactions)
  .where(scoped(ctx, bankTransactions, eq(bankTransactions.id, id)))
```

This also shapes error behavior: a record belonging to another tenant is reported
as "not found" rather than "forbidden", because confirming that an id exists
elsewhere is itself a disclosure.

Writes are checked on both sides. Scoping the row being updated is not enough
when the *value* written is also an id — categorizing into another company's
chart account is rejected explicitly (`assertAccountInTenant`).

**Rejected:** Postgres row-level security. It is a strong second layer and worth
adding later, but as the only layer it pushes authorization into a place the
application cannot easily test or explain, and it does not address foreign ids
appearing in write payloads.

### 3. Roles resolve to permission sets; checks are pure functions

Roles live on the membership (user × company), not the user, so one accountant can
hold different roles at different companies — the prerequisite for the practice
mode in spec §14.

`effectivePermissions(role, overrides)` returns a `Set<Permission>` from a static
role table plus optional per-membership grants and revokes. Revocations are
applied after grants, so an explicit revoke always wins.

Permission checks are synchronous and pure, so authorization is unit-testable
without a database and never depends on a round trip at the point of use.

### 4. Money is integer cents, everywhere

Every monetary column is `bigint` holding minor units. No floats, no decimals in
application code. `0.1 + 0.2 !== 0.3` in IEEE 754 and an accounting ledger cannot
absorb that error. Split-balance checks are therefore exact equality with no
epsilon, and `allocateCents` distributes remainders deterministically so parts
always sum back to the whole.

### 5. Audit events are append-only, written in the change's transaction

`recordAudit` takes the surrounding transaction handle, so an audit row commits or
rolls back with the change it describes. A change can never be committed without
its trail.

Rows are never updated to reflect a reversal. Undo restores the `before` snapshot
and writes a **new** event marked `isUndo`, then stamps `undoneByEventId` on the
original as a pointer. History shows both the change and its reversal (spec §19).

Bulk actions share a `batchId` so they undo as the single action the user
actually took. This extends across module boundaries: categorizing with "remember
this vendor" creates a rule and a categorization under one batch, and undoing
retires both — otherwise the next sync would re-apply the decision the user just
took back.

### 6. Deduplication is a database constraint, not application logic

`bank_transactions` carries a unique index on
`(company_id, financial_account_id, provider_transaction_id)`, and imports use
`ON CONFLICT DO NOTHING`. Re-importing a window is idempotent regardless of what
the caller does, and two concurrent syncs cannot both win the race.

Provider adapters must return the aggregator's own immutable transaction id and
never synthesize one — that requirement is stated on the `BankProvider` interface.

### 7. Bank aggregation sits behind a provider interface

`BankProvider` (link, exchange, list accounts, fetch transactions) is the only
surface the bookkeeping domain sees. `MockBankProvider` implements it with
deterministic seeded generation, so the vertical slice runs with no credentials
and the dedup tests can assert that a re-import inserts nothing.

Adding a real aggregator means writing one adapter and registering it; the
registry resolves adapters by the `BANK_PROVIDER` environment variable.

## Consequences

- Service functions are verbose at the call site (an explicit `ctx` everywhere).
  That is the cost of making tenant isolation structural rather than remembered.
- Undo currently reverses bank transactions and rule creation. Extending it to
  another entity type means adding a branch in `undoLast` and listing the type in
  `UNDOABLE_ENTITY_TYPES`.
- Background jobs, object storage, and the outbox pattern (spec §18) are not yet
  present. Bank sync runs inline in a server action, which is acceptable at
  mock-data volume and is the next thing to move behind a queue.
- Row-level security, MFA, and session/device controls (spec §14) remain open.

## Follow-up

Phase 2 (spec §20) — reconciliation and the double-entry ledger — is the next
milestone. The ledger should post from bank transactions rather than replacing
them, keeping the feed as an immutable source record.
