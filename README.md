# Accountrix Plus

A unified business operating system for bookkeeping, accounting, clients, proposals, and
marketing — an alternative to QuickBooks.

This repository implements **Phase 0 (Foundation)**, **Phase 1 (Bookkeeping MVP)**,
**Phase 2 (Reconciliation + Accounting Core)**, **Phase 3 (CRM + Proposal Pipeline)**,
**Phase 4 (Proposal Designer + Company Studio)**, and **Phase 5 (Marketing)** from the
[development specification](docs/SPEC.md). Architecture decisions are recorded in
[ADR 0001](docs/adr/0001-modular-monolith-and-tenancy.md),
[ADR 0002](docs/adr/0002-double-entry-ledger.md),
[ADR 0003](docs/adr/0003-crm-and-public-intake.md),
[ADR 0004](docs/adr/0004-document-engine-and-brand.md), and
[ADR 0005](docs/adr/0005-marketing-consent-and-engagement.md).

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

### Documents and brand (Phase 4)

- **Company Studio** — profile, brand kit (colours, fonts, logo), a logo and image library, a
  reusable service catalog, and a versioned legal clause library.
- **Proposal designer** — a block-based document editor with a live preview through the same
  renderer the client sees. Blocks reflow, so one document works on a phone, in print, and in
  an email.
- **Template gallery** — built-in templates ordered by your industry, plus your own saved layouts.
- **Merge fields** — `{{client.name}}`, `{{proposal.total}}` and friends fill from real records.
  Unresolved fields render blank and are flagged to the author before sending.
- **Branded client proposals** — the public link renders in your colours with a print stylesheet,
  so the client's own Print → Save as PDF gives a paginated, print-ready file.
- **Acceptance and e-signature** — the client picks optional items, sees the total update, types
  their name to sign, and the deal closes. The accepted total is recomputed server-side.

### Marketing (Phase 5)

- **Segment builder** — filter by lifecycle stage, industry, region, size, source, tags, strategic
  flag, and deal history, with a live count that shows how many match *and* how many may actually
  be emailed, broken down by reason.
- **Campaigns and nurture sequences** — a broadcast or a multi-step sequence, each step attached
  to a piece of creative. Sending reports matched, sent, skipped, and why.
- **Consent enforced at send time** — a segment says who you are interested in; permission is
  decided against the state of the world at the moment the message would go out. Suppression is
  company-wide and keyed by address, so it survives a contact being recreated.
- **Shared creative studio** — the same design engine proposals use, with `button`, `qrCode`, and
  `video` blocks added. One document renders as a branded web page and as table-based email HTML
  with a plain-text alternative.
- **Public unsubscribe and tracking** — an RFC 8058 one-click endpoint, a confirmation page, an
  open pixel, and click redirects that re-validate their destination.
- **The sales loop** — a click raises a follow-up task for whoever owns the relationship, and
  lost deals marked eligible at close surface on a re-engagement list with a one-press reopen.
  Engagement never reopens a deal on its own.
- **Analytics** — open, click, click-through, unsubscribe, and bounce rates per campaign and
  across the account, with a scheduled-campaign calendar.

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
| `tests/design.test.ts` | Block validation, merge-field resolution, template composition, brand colour validation, clause versioning |
| `tests/acceptance.test.ts` | Server-side total recomputation, signature matching, expiry, double-acceptance, foreign item ids |
| `tests/marketing.test.ts` | Segment matching, contactability, link safety, email rendering and escaping, send-time consent, suppression, engagement tracking, unsubscribe idempotence, analytics denominators, tenant and role isolation |

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

### Documents and brand (Phase 4)

26. **Company Studio** — open **Company Studio**. The profile fills merge fields; the **Brand**
    tab has the company's colours and fonts with a live preview; **Legal clauses** holds three
    approved clauses.
27. **Brand safety** — try setting a brand colour to `red; background: url(...)`. It is refused:
    these values land in a `style` attribute on public pages, so only plain hex is accepted.
    SVG uploads are refused for the same reason.
28. **Designer** — from **Proposals**, click **Design** on any proposal. The left pane lists the
    blocks; the right pane is a live preview through the same renderer the client sees. Add,
    reorder, and delete blocks; the preview follows.
29. **Merge fields** — the preview shows real values, not `{{client.name}}`. Add a block using a
    field with no data and a warning appears above the editor naming it — before you send.
30. **Templates** — **Templates** offers a construction bid, a professional engagement, a simple
    estimate, and a general services proposal, ordered so your industry's comes first. **Save as
    template** puts your own layout in the gallery.
31. **Locked once sent** — open the designer on a sent proposal. It is read-only: the sent version
    is a snapshot, and editing what a client is reading would be worse than making them wait for
    version 2.
32. **The client's view** — open the proposal link from the seed output. It renders in the
    company's colours, with the fee table drawn from the real line items.
33. **Print to PDF** — click **Print or save as PDF**. Page margins, page breaks, and brand
    colours all survive; the interactive form is replaced by ruled signature lines.
34. **Accept it** — type a name, then type something *different* as the signature: it refuses.
    Match them, tick the agreement, and accept. The page shows the acceptance, and back in the
    pipeline the deal is **Won**.
35. **Accept it twice** — reload and try again, or re-post to the endpoint. It returns 409: a
    unique constraint makes double-acceptance impossible, not just unlikely.

### Marketing (Phase 5)

36. **The overview** — open **Marketing**. The seed sends two campaigns, so there are open and
    click rates, an engagement feed, and a scheduled campaign on the calendar.
37. **Segments** — under **Segments**, add a rule (say `industry is Real estate`). The panel on
    the right counts the audience as you type, and tells you how many of them may actually be
    emailed and why the rest may not.
38. **A segment is not permission** — delete every rule. It now matches everyone, and the panel
    still shows only the contactable subset. A wide segment never implies consent.
39. **A campaign's honesty** — open **Year-end planning note**. It says "1 of 3 people who matched
    this segment were not emailed: 1 had not opted in." The recipients table lists the skipped
    person with the reason, rather than quietly dropping them.
40. **Creative** — under **Creative**, open the year-end note. It is the same designer proposals
    use, with `Button`, `QR code`, and `Video` added and the fee table and signature blocks gone.
    **Duplicate** copies it with fresh block ids.
41. **One document, two renderers** — the preview is the React renderer; the same blocks go out as
    table-based email HTML with a plain-text alternative. That is what ADR 0004's flowing-block
    decision bought.
42. **Unsubscribe** — take a token from the recipients table and open `/u/<token>`. It asks before
    doing anything: mail clients pre-fetch links, so a GET must not opt someone out. Confirm, then
    reload — it says you were already unsubscribed rather than erroring.
43. **Suppression outlives the contact** — the address now appears under **Suppressions**. Delete
    that contact in the CRM and let lead intake recreate them; they are still suppressed, because
    the list is keyed by address, not by row id.
44. **Removing a suppression restores nothing** — remove the entry. The hard block lifts, but the
    contact's consent stays withdrawn. It is theirs to give.
45. **Click tracking will not redirect anywhere** — try
    `/api/track/<token>?u=javascript:alert(1)`. It lands on the home page instead: the destination
    is re-validated, so a forged tracking link is not an open redirect.
46. **The sales loop** — a click raised **Follow up: City Works Authority engaged with…** on the
    overview, and the lost parking-structure deal appears under **Lost deals showing interest**.
    Press **Reopen deal** and it returns to the pipeline — the deal never reopened on its own,
    because that would have rewritten the win/loss figures.
47. **Roles** — the `marketing` role gets marketing and read-only CRM, and nothing financial. The
    same designer serves both proposals and creative, but the document's own kind decides which
    permission governs it, so sales cannot edit a newsletter and marketing cannot edit a proposal.

## Project layout

```
src/
  app/                    Routes, server actions, and UI (no business logic)
    actions/              Server actions — resolve the actor, call one service
    bookkeeping/          Transaction Inbox
    accounting/           Reports, journal, reconciliation workspace
    crm/                  Pipeline, dashboard, clients, proposals, designer
    marketing/            Overview, campaigns, segments, creative, suppressions
    studio/               Company Studio — profile, brand, catalog, clauses
    api/intake/[key]/     Public lead-capture endpoint (unauthenticated)
    api/proposals/        Public proposal acceptance (unauthenticated)
    api/track/[token]/    Public open pixel and click redirect (unauthenticated)
    api/unsubscribe/      Public RFC 8058 one-click unsubscribe (unauthenticated)
    api/assets/[id]/      Asset serving, authorized by session or proposal token
    p/[token]/            Public client-facing proposal link (unauthenticated)
    u/[token]/            Public unsubscribe confirmation (unauthenticated)
  components/
    design/               Block renderer, the designer, and the document stylesheet
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
    crm/                  Pipeline, proposals, intake, conversion, acceptance
    design/               Blocks, merge fields, templates, document composition
    marketing/            Segments, campaigns, email provider, engagement, analytics
    studio/               Company profile, brand kits, assets, clause library
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

## Switching email providers

Set `EMAIL_PROVIDER` in `.env.local`. The default `mock` adapter records messages in memory and
sends nothing, so the demo and the tests run with no credentials. To add a real ESP:

1. Implement the `EmailProvider` interface from `src/modules/marketing/email-provider.ts`.
2. Register it with `registerEmailProvider`.
3. Set `EMAIL_PROVIDER` to its key, and set `PUBLIC_BASE_URL` — links inside a sent email are
   opened days later from a different origin, so they cannot be relative.

No adapter is ever asked to decide *whether* someone may be emailed. Consent and suppression are
enforced in the send pipeline before a message reaches a provider, so a misconfigured adapter
cannot become a compliance failure (spec §10, §19).

## Not built yet

Tracked against the spec §20 phases:

- **Phase 6** — the optional AI module and its gateway

Gaps within the phases already built:

- **Campaign scheduling.** `scheduledFor` puts a campaign on the calendar and a nurture step's
  `delayDays` is recorded, but nothing fires on its own — sending is a button somebody presses.
  The missing piece is a background worker calling the same `sendStep` that enforces consent.
- **Provider delivery callbacks.** Bounces are recorded from the synchronous send result. Real
  ESPs report hard bounces and spam complaints by webhook hours later, so the suppression list
  under-counts until that endpoint exists.
- **Open tracking is a pixel**, so it under-reports wherever images are blocked. Click rate is the
  more honest figure, which is why the sales loop keys on clicks rather than opens.
- **QR codes do not render in the designer preview.** The encoder is server-side; the preview
  shows a labelled placeholder naming what will be encoded. Sent and printed output is correct.
- **A/B testing and send-time optimization** (spec §10) are not built.

- **Cash-basis reporting.** All statements are accrual. Spec §13 asks for both "where supported by
  the underlying transaction model"; doing cash basis correctly means looking through payment
  applications to the accounts on the documents they settle. The `payment_applications` table was
  designed to make that possible, but it is not implemented — deliberately left rather than
  shipped as an approximation.
- **Server-side PDF generation** (spec §18). Print CSS gives a correct, paginated file through the
  browser's Save as PDF, but there is no server-rendered PDF. Adding it means either a headless
  browser in the deployment or a layout library re-implementing pagination the browser already
  does. See ADR 0004.
- **Illustrator-class vector editing** (spec §7). Deliberately deferred — §7 itself says to
  prioritize business-document layout first. No arbitrary positioning, layering, or path editing;
  a `canvas` block type is the extension point.
- **Rich text inside a paragraph.** Text blocks are plain with paragraph breaks. Bold, italics,
  and inline links need their own decision about format.
- **Comments and questions on a proposal** (spec §7). The acceptance endpoint is the model to
  copy when they are built.
- **Project dimension is stored but not reported on.** `journal_lines.projectId` exists and is set
  by conversion; filtering the statements by job is a query change still to make. Classes,
  departments, and locations are not modelled at all.
- Fixed assets and depreciation, recurring and closing entries, customer statements, write-offs,
  and 1099 reporting remain open from spec §13. Vendor `taxId` and `is1099Vendor` columns exist so
  the data is captured now.
- Communications and file attachments on opportunities (spec §6) are not built;
  `opportunity_activities` is the seam they will hang from.
- Renaming an organization does not propagate to its linked customer or vendor record. Client-
  facing documents read the organization, so they stay correct — but the accounting record drifts.
- A document's brand kit is captured when the document is composed. Changing the kit does not
  restyle existing documents: right for sent proposals, arguably surprising for drafts.
- Assets are stored in Postgres through the default `AssetStore` adapter. Fine for logos; object
  storage is one adapter away when receipts arrive at volume.
- Infrastructure from spec §18 still open: background job queue (bank sync runs inline and now
  writes journal entries too, so this matters more than it did), object storage for receipts, the
  outbox pattern.
- Security from spec §14/§19 still open: MFA, session/device controls, row-level security as a
  second isolation layer.

Per spec §19, a security review is required before any production use involving real financial
integrations or payments.
