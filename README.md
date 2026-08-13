# Accountrix Plus

A unified business operating system for bookkeeping, accounting, clients, proposals, and
marketing — an alternative to QuickBooks.

This repository implements **Phase 0 (Foundation)**, **Phase 1 (Bookkeeping MVP)**,
**Phase 2 (Reconciliation + Accounting Core)**, and **Phase 3 (CRM + Proposal Pipeline)** from
the [development specification](docs/SPEC.md). Architecture decisions are recorded in
[ADR 0001](docs/adr/0001-modular-monolith-and-tenancy.md),
[ADR 0002](docs/adr/0002-double-entry-ledger.md), and
[ADR 0003](docs/adr/0003-crm-and-public-intake.md).

## What works today

### Bookkeeping (Phase 1)

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

### Accounting (Phase 2)

- **Double-entry ledger** — every categorized transaction, invoice, bill, and payment posts a
  balanced journal entry automatically. Owners never write journal entries to keep their books;
  accountants can, for adjustments.
- **Trial balance, balance sheet, profit & loss, general ledger** — all summed live from posted
  journal lines. No cached balances anywhere.
- **Reconciliation** — per-account sessions with statement balance entry, live difference
  calculation, and completion refused unless the difference is exactly zero. Completing locks the
  cleared transactions; reopening is a separate permission.
- **Period close** — closing a date range blocks entries, voids, and bookkeeping changes dated
  inside it. Reopening is recorded, not erased.
- **A/R and A/P** — customers, vendors, invoices, bills, payments with application across several
  documents, and aging reports bucketed by days past due.

### Clients and sales (Phase 3)

- **Unified client records** — one organization record per party, carrying lifecycle stage and
  the strategic-account flag. Being a customer or a vendor is an accounting *role* it plays, not
  a separate record.
- **Opportunity pipeline** — the ten stages from the spec, with owner, expected value,
  probability that tracks the stage until someone overrides it, and structured loss reasons.
- **Proposals** — line items with optional extras, an immutable snapshot on every send, a
  client-facing link with view tracking, and statuses through to won or lost.
- **Website lead intake** — a public endpoint and a paste-in form snippet that create leads
  directly in the pipeline. Rate limited, honeypot-protected, origin-restricted, and write-only.
- **Win/loss analytics** — win rate by count and by value, weighted forecast, average deal size
  and time to decision, performance by source, owner, industry, or region, and a loss-reason
  breakdown with re-engagement eligibility.
- **Won deals become work** — one action creates the client, the job, and optionally an invoice
  from the winning proposal's lines.

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
| `tests/ledger.test.ts` | Balanced-entry validation, normal balances, derived postings, void and reversal, period locking, statements |
| `tests/reconciliation.test.ts` | Difference arithmetic, balance chaining, completion gating, locking and controlled reopen |
| `tests/receivables.test.ts` | Invoice and bill posting, payment application, overpayment rejection, aging buckets |
| `tests/crm.test.ts` | Stage transitions, probability tracking, consent-based marketing eligibility, conversion idempotence, win/loss maths |
| `tests/proposals.test.ts` | Optional-item pricing, send-time versioning, forward-only stage advances, view tracking, proposal-to-invoice |
| `tests/intake.test.ts` | Honeypot, rate limiting, log ceiling, origin allowlist, address truncation, key scoping and enumeration |

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

### Accounting (Phase 2)

Continue from the same session, or run `npm run db:seed` for a company that already has
receivables, payables, and a partly-categorized ledger.

11. **The ledger built itself** — open **Accounting → Journal**. Every transaction you
    categorized in step 4 already posted a balanced entry. Nobody typed a journal entry.
12. **Trial balance** — **Accounting → Reports → Trial balance**. Debits equal credits, and the
    page says so explicitly.
13. **Balance sheet** — switch to **Balance sheet**. Assets equal liabilities plus equity. Credit
    card spending shows as a liability, not as negative cash.
14. **Manual entry** — on the Journal tab, click **New journal entry** and enter an unbalanced
    pair of lines. The running total flags the difference and **Post entry** stays disabled until
    the two sides agree.
15. **Reconcile** — **Accounting → Reconcile**. Start a session on Business Checking with any
    statement end date and balance. Tick transactions: the difference updates on every click, and
    **Complete reconciliation** is disabled until it reaches exactly zero.
16. **Reconciliation lock** — complete a session, then return to `/bookkeeping` and try to
    recategorize one of the cleared transactions. It is refused until the reconciliation is
    reopened, which needs the accountant or owner role.
17. **Period close** — on the Journal tab, close a date range covering some of your transactions.
    Recategorizing anything dated inside it is now rejected, and the bookkeeping change rolls back
    with the entry rather than leaving the two out of step.
18. **Aging** — **Reports → A/R aging** on the seeded data shows one invoice current and one
    overdue, bucketed by days past due.

### Clients and sales (Phase 3)

Run `npm run db:seed` for a company with a populated pipeline. The seed prints the lead intake
key and the client proposal link — keep them for steps 22 and 24.

19. **Pipeline** — open **Clients & Sales**. Four deals sit across the stages with a weighted
    forecast in the header. Move one to a later stage; its probability follows.
20. **Loss reasons** — move a deal to **Lost**. It asks which reason before accepting the change,
    because the dashboard reports on them.
21. **Dashboard** — **Clients & Sales → Dashboard** shows win rate by count and by value,
    weighted forecast, performance by source and owner, and how many lost deals may be
    re-engaged (only those whose contact actually consented).
22. **Lead intake** — **Lead intake → Get form snippet** gives a paste-in HTML form. Submit to it
    from a terminal and watch the lead land in the pipeline:
    ```bash
    curl -X POST http://localhost:3000/api/intake/<key> \
      -H 'Content-Type: application/json' \
      -d '{"name":"Sam Okafor","email":"sam@newbuild.test","interest":"Retaining wall"}'
    ```
23. **Intake defences** — submit again with `"website":"http://spam.test"` (the honeypot). The
    response is still `{"ok":true}` so an automated submitter learns nothing, but no lead is
    created and the attempt appears in the submission log as `honeypot`.
24. **Client proposal link** — open `/p/<token>` from the seed output. That is what a client sees:
    read-only, no login, and opening it advances the deal to **Viewed**.
25. **Won becomes work** — on the pipeline, a won deal offers **Create client & job**. It creates
    the accounting customer linked to the CRM record, a job, and optionally an invoice from the
    proposal's lines. Running it twice does not duplicate anything.

## Project layout

```
src/
  app/                    Routes, server actions, and UI (no business logic)
    actions/              Server actions — resolve the actor, call one service
    bookkeeping/          Transaction Inbox
    accounting/           Reports, journal, reconciliation workspace
    crm/                  Pipeline, dashboard, clients, proposals, lead intake
    api/intake/[key]/     Public lead-capture endpoint (unauthenticated)
    p/[token]/            Public client-facing proposal link (unauthenticated)
  components/             Shared app shell and navigation
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
    crm/                  Pipeline, proposals, lead intake, conversion, analytics
    ledger/               Journal engine, derived postings, balances, statements
    permissions/          Roles, permissions, overrides
    receivables/          Customers, vendors, invoices, bills, payments
    reconciliation/       Statement sessions, clearing, locking
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

- **Phase 4** — proposal designer, Company Studio brand kit
- **Phase 5** — marketing, segments, campaigns
- **Phase 6** — the optional AI module and its gateway

Gaps within the phases already built:

- **Cash-basis reporting.** All statements are accrual. Spec §13 asks for both "where supported by
  the underlying transaction model"; doing cash basis correctly means looking through payment
  applications to the accounts on the documents they settle. The `payment_applications` table was
  designed to make that possible, but it is not implemented — deliberately left rather than
  shipped as an approximation.
- **E-signature and in-page acceptance** (spec §7). The client proposal link is read-only.
  Accepting in-page means a second public write endpoint, which deserves the same scrutiny the
  intake endpoint got rather than being tacked on.
- **Project dimension is stored but not reported on.** `journal_lines.projectId` exists and is set
  by conversion; filtering the statements by job is a query change still to make. Classes,
  departments, and locations are not modelled at all.
- Fixed assets and depreciation, recurring and closing entries, customer statements, write-offs,
  and 1099 reporting remain open from spec §13. Vendor `taxId` and `is1099Vendor` columns exist so
  the data is captured now.
- Communications and file attachments on opportunities (spec §6) are not built;
  `opportunity_activities` is the seam they will hang from.
- Renaming an organization does not propagate to its linked customer or vendor record. Worth
  fixing before the name appears on client-facing documents in Phase 4.
- Infrastructure from spec §18 still open: background job queue (bank sync runs inline and now
  writes journal entries too, so this matters more than it did), object storage for receipts, the
  outbox pattern.
- Security from spec §14/§19 still open: MFA, session/device controls, row-level security as a
  second isolation layer.

Per spec §19, a security review is required before any production use involving real financial
integrations or payments.
