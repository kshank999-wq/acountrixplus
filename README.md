# Accountrix Plus

A unified business operating system for bookkeeping, accounting, clients, proposals, and
marketing — an alternative to QuickBooks.

This repository currently implements **Phase 0 (Foundation)** and **Phase 1 (Bookkeeping MVP)**
from the [development specification](docs/SPEC.md), delivered as the vertical slice described in
spec §21. Architecture decisions are recorded in
[ADR 0001](docs/adr/0001-modular-monolith-and-tenancy.md).

## What works today

- **Onboarding** — register a company, pick one of 14 industries, and get a full chart of
  accounts installed automatically (standard structure plus an industry pack).
- **Bank feed** — connect through a provider-agnostic interface. A deterministic mock adapter
  ships in the box, so the whole flow runs with no credentials.
- **Transaction Inbox** — search, filter by account and review state, one-tap categorize, split,
  exclude, mark transfers, add notes, and act on many transactions at once. Responsive: a table
  on desktop, stacked cards with large tap targets on a phone.
- **Rules and vendor memory** — build a rule from any transaction, choose whether it categorizes
  automatically or only suggests, and optionally back-apply it to the existing inbox. Categorizing
  with "remember this vendor" turns one decision into a recurring rule.
- **Undo and audit history** — every change is attributed to a user, recorded append-only, and
  reversible. Bulk actions undo as one action.
- **Roles and permissions** — seven roles with granular per-membership overrides. Sales and
  marketing users cannot see financial data at all.

No AI provider is required for any of it (spec §22).

## Requirements

- Node.js 20 or newer (developed on 22)
- PostgreSQL 14 or newer (developed on 16)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure the environment
cp .env.example .env.local
#    Edit .env.local — at minimum set DATABASE_URL.
#    Generate a session secret:
#      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Create the databases
createdb accountrix
createdb accountrix_test

# 4. Apply migrations
npm run db:migrate

# 5. (Optional) Seed a demo company with mock bank data
npm run db:seed

# 6. Start the app
npm run dev
```

Open <http://localhost:3000>. If you seeded, sign in as `owner@ridgeline.test` with the password
`correct-horse-battery`; otherwise register a new company.

### Database commands

| Command | What it does |
| --- | --- |
| `npm run db:generate` | Generate a new SQL migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push the schema directly (development only — skips migration files) |
| `npm run db:studio` | Open Drizzle Studio to browse the data |
| `npm run db:seed` | Create the demo company and import mock transactions |

After editing anything in `src/db/schema/`, run `npm run db:generate` and commit the generated SQL
alongside the schema change.

## Tests

```bash
npm test          # run once
npm run test:watch
```

Tests run against `TEST_DATABASE_URL` (default `accountrix_test`). The harness refuses to run
against a database whose name does not contain "test", because it truncates every table between
suites. Migrations are applied automatically before the run.

Coverage matches what spec §21 asks for:

| File | What it covers |
| --- | --- |
| `tests/tenant-isolation.test.ts` | Two companies side by side: inbox scoping, cross-tenant writes, foreign ids in bulk operations, audit scoping |
| `tests/permissions.test.ts` | Role defaults, granular overrides, and enforcement inside services |
| `tests/dedup.test.ts` | Repeated syncs, the database-level unique constraint, and two tenants importing identical provider ids |
| `tests/rules.test.ts` | Condition evaluation, priority, merchant normalization, vendor memory, auto vs suggest |
| `tests/integrity.test.ts` | Money arithmetic, chart-of-accounts consistency, split balancing, transfers, audit trail and undo |

```bash
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

## Demo checklist

A five-minute walkthrough proving the spec §22 definition of done. Start from a clean database
(`npm run db:migrate`, no seed).

1. **Register** — go to `/register`, create "Ridgeline Construction", choose **Construction /
   Trades**. You land on the inbox signed in as the owner.
2. **Confirm the chart of accounts** — the category dropdown on any transaction lists both
   standard accounts (`6350 Office Supplies`) and construction ones (`5130 Subcontractors`,
   `4210 Change Order Revenue`).
3. **Import** — click **Sync bank**. The mock provider connects three accounts and imports roughly
   70 transactions across three months.
4. **Categorize one** — pick a category from any row's dropdown. Leave "Remember this vendor"
   checked; the toast confirms a rule was created.
5. **Undo** — click **Undo last**. The transaction returns to uncategorized *and* the vendor rule
   is retired, so it will not silently reapply.
6. **Bulk categorize** — tick three checkboxes, choose a category in the bar that appears, and
   apply. **Undo last** reverses all three as one action.
7. **Split** — click **More** on a transaction, stay on the **Split** tab, add two lines. The
   remainder indicator turns green only when the lines sum exactly to the transaction; **Save
   split** is disabled until then.
8. **Create a rule** — on the **Create rule** tab, match a recurring merchant (`SHELL OIL`), choose
   a category, select **Categorize automatically**, and apply to existing transactions. Every past
   and future Shell charge is categorized.
9. **Mobile** — narrow the window below 768px. The table becomes stacked cards with full-width
   controls and no horizontal scrolling.
10. **Permissions** — the audit trail behind every one of these changes is attributed to your user.
    A `sales` or `marketing` member visiting `/bookkeeping` sees an explanation instead of data.

## Project layout

```
src/
  app/                    Routes, server actions, and UI (no business logic)
    actions/              Server actions — resolve the actor, call one service
    bookkeeping/          Transaction Inbox
  db/
    schema/               Drizzle table definitions (the migration source)
    migrate.ts, seed.ts
  lib/                    Money arithmetic, request-scoped actor resolution
  modules/                Domain logic, one directory per spec §17 boundary
    audit/                Append-only event log and undo support
    auth/                 Password hashing and sessions
    banking/              Provider interface, mock adapter, import and dedup
    bookkeeping/          Rule matching, categorization, splits, transfers
    coa/                  Chart of accounts and industry packs
    permissions/          Roles, permissions, overrides
    tenancy/              Actor context, tenant scoping, onboarding
drizzle/                  Generated SQL migrations
docs/                     Specification and architecture decision records
tests/                    Vitest suites
```

The rule that keeps this honest: **`src/app/` must not contain business logic**, and every service
function takes an `ActorContext` first. See ADR 0001 for why.

## Switching bank providers

Set `BANK_PROVIDER` in `.env.local`. To add a real aggregator:

1. Implement the `BankProvider` interface from `src/modules/banking/provider.ts`.
2. Register it in `src/modules/banking/registry.ts`.
3. Set `BANK_PROVIDER` to its key.

No changes to import, dedup, categorization, or the inbox — that isolation is the point
(spec §3). Provider credentials stay server-side and are never exposed to the browser
(spec §19).

## Not built yet

Tracked against the spec §20 phases:

- **Phase 2** — reconciliation, double-entry ledger and journals, trial balance, financial
  statements, AR/AP
- **Phase 3** — CRM, leads, opportunity pipeline
- **Phase 4** — proposal designer, Company Studio brand kit
- **Phase 5** — marketing, segments, campaigns
- **Phase 6** — the optional AI module and its gateway
- Infrastructure from spec §18 still open: background job queue (bank sync currently runs inline),
  object storage for receipts, the outbox pattern
- Security from spec §14/§19 still open: MFA, session/device controls, row-level security as a
  second isolation layer

Per spec §19, a security review is required before any production use involving real financial
integrations or payments.
