# Accountrix Plus

A unified business operating system for bookkeeping, accounting, clients, proposals, and
marketing — an alternative to QuickBooks.

This repository implements **Phase 0 (Foundation)**, **Phase 1 (Bookkeeping MVP)**,
**Phase 2 (Reconciliation + Accounting Core)**, **Phase 3 (CRM + Proposal Pipeline)**,
**Phase 4 (Proposal Designer + Company Studio)**, **Phase 5 (Marketing)**,
**Phase 6 (AI Add-on)**, **Phase 7 (Industry Modules)**, and the mobile app from the
[development specification](docs/SPEC.md). Architecture decisions are recorded in
[ADR 0001](docs/adr/0001-modular-monolith-and-tenancy.md),
[ADR 0002](docs/adr/0002-double-entry-ledger.md),
[ADR 0003](docs/adr/0003-crm-and-public-intake.md),
[ADR 0004](docs/adr/0004-document-engine-and-brand.md),
[ADR 0005](docs/adr/0005-marketing-consent-and-engagement.md),
[ADR 0006](docs/adr/0006-ai-gateway-and-human-approval.md),
[ADR 0007](docs/adr/0007-industry-modules-without-forking-the-ledger.md), and
[ADR 0008](docs/adr/0008-offline-first-and-replay-safety.md).

> **A note on phase numbering.** Spec §20's Phase 8 is *Payroll/Tax/Advanced
> Integrations*; the mobile app is not a phase of its own there, and §18 asks
> for "a responsive web/PWA interface **before committing to separate native
> mobile apps**". The mobile work below is that PWA, plus the versioned API and
> replay contract a native client would consume later. Payroll and tax remain
> unbuilt.

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

### The optional AI module (Phase 6)

**Off by default for every company, and nothing above depends on it** (spec §23). A company with
no AI settings row has it disabled, the workspaces render no AI affordances at all, and the test
suite asserts the full bookkeeping workflow runs with the module off.

- **One gateway** — every AI call passes through a single function that checks permission, then
  quota and cost ceiling, then resolves a prompt version, then calls a provider, then validates
  the output against a schema, then writes a usage-ledger row. Blocked calls are recorded too.
- **Provider adapters** — a built-in heuristic provider that needs no credentials (and is what
  the demo and tests use), plus an Anthropic adapter loaded through a dynamic import so an
  unconfigured deployment never parses a vendor SDK. Keys stay server-side.
- **A suggestion is never an action** — model output lands in a review queue. Accepting it calls
  the same service a person uses, under their own actor context, so the audit log records the
  person who decided and a separate event records that a machine proposed it.
- **Retrieval is permission-gated** — an assistant cannot show you a figure you would not be
  allowed to look up. A sales role asking about cash flow gets nothing.
- **Versioned prompts** — built-ins ship in code; a company can write its own version, and every
  ledger row records which version answered. Saving appends rather than overwrites, so rolling
  back is one press.
- **Metering** — spend in millionths of a dollar (a call costs a fraction of a cent), per-capability
  usage, an hourly rate limit, and a monthly ceiling enforced *before* a provider is reached.
- **Capabilities** — category suggestions, duplicate and outlier review, rule proposals, inbox
  summaries, reconciliation explanations, proposal drafting, campaign drafting, and business
  insights in plain language.

No AI provider is required for any of it (spec §22) — the built-in heuristic provider needs no
API key, no network, and no configuration.

### Industry modules and construction (Phase 7)

Spec §20 attaches one constraint to this phase: add specialized workflows **without forking the
core ledger**. Everything below is a `SUM` over `journal_lines` or an extension of a service that
already existed — there is no job cost table, no construction invoice type, and no second set of
books. `tests/jobs.test.ts` asserts the reconciliation directly.

- **Modules resolve from the industry pack plus the company's own overrides** — a contractor gets
  job costing with nothing configured; a landscaper on the "general" pack can switch it on; a
  contractor who does not want it can switch it off. Industry is a starting point, not a cage.
  When a module is off, its workspace is *absent*, not greyed out.
- **Cost codes are a second dimension on the journal line**, beside the job that Phase 2 added.
  The account says what kind of cost; the cost code says which part of the work. A database CHECK
  refuses a cost code without a job.
- **Job budgets** keep the original estimate and approved changes in separate columns, because
  "over the revised budget" and "over the original bid" are different findings.
- **Change orders** revise the contract value, the budget, and the schedule of values on approval,
  and post **nothing** — the work has not happened yet, and recognizing revenue for it is the
  error percentage-of-completion accounting exists to prevent.
- **Progress billing** with an AIA-style schedule of values: percent complete per contract item,
  billed as increments, issued as an **ordinary invoice** that ages and takes payments like any
  other.
- **Retainage** is withheld inside `createInvoice` (and `createBill`), not reclassified afterwards:
  Dr AR net, Dr Retainage Receivable retained, Cr revenue in full. The AR control account still
  equals the sum of open invoice balances, and the retained amount stays out of AR aging.
  Releasing it needs no new machinery — it is an invoice whose line credits Retainage Receivable.
- **WIP and job profitability** — cost-to-cost percent complete, earned revenue, and over- and
  under-billings reported *apart* rather than netted, because one is a liability and the other an
  asset. A job with no budget reports percent complete as unknown rather than zero.
- **Subcontractor compliance** — insurance, workers' comp, W-9s, licences, and lien waivers with
  expiry warnings. Status is always derived from the expiry date, never stored: a stored status is
  correct the day it is written and wrong every day after.
- **Terminology** — each industry pack's vocabulary reaches the UI. A "Tenant", a "Patient", a
  "Production". Only the words change; the records are the ones every company keeps.

### The mobile app

An installable PWA at `/m`, not a second codebase. It is offline-first because
the two facts that shape it are that a phone is sometimes offline and a pocket is
sometimes emptied.

- **Replay-safe operations** — every mutation a phone can queue carries a
  client-generated idempotency key, and the key row is written *inside the
  operation's own transaction*. Sending the same categorization six times
  concurrently produces one journal entry. This is the phase's central claim and
  `tests/mobile.test.ts` asserts it directly.
- **An offline outbox** — decisions are queued in IndexedDB and drained on
  reconnect. The ordering rules, retry policy, and permanent-versus-retryable
  classification are pure functions in `modules/mobile/outbox.ts`, tested without
  a browser. Later decisions about the same transaction supersede earlier ones;
  two receipts do not.
- **The same door, not a different building** — the mobile API calls the same
  services the browser does, so a categorization from a phone produces the same
  journal entry and the same audit event, attributed to the same person.
  `/api/mobile/v1/sync` versions in the path, and one round trip both drains the
  queue and returns fresh state.
- **A phone-first review deck** — one transaction at a time, recently-used
  categories first, 48px targets, and nothing awaiting the network. Spec §3's
  "several transactions at a time" is what several looks like when the screen
  fits one.
- **Receipt capture** — the phone's own camera, downscaled to ~200 KB in the
  browser before upload, attached through the queue. Receipts have their own
  permission (`bookkeeping:categorize`) rather than the brand library's.
- **Revocable devices** — a lost phone is signed out on its own, from the laptop
  doing the revoking. Revocation takes effect on the next request, not whenever
  the session expires.
- **Notifications** — a `PushProvider` abstraction with a built-in mock, per-topic
  preferences that default to *on* (granting browser permission is the opt-in),
  and a log of every attempt including the suppressed ones. A client accepting a
  proposal notifies everyone who can manage proposals.
- **A hand-written service worker** — about 130 lines, because a generated one is
  code nobody has read intercepting every request. `/api/**` is never cached, only
  GET is considered, and the offline fallback is plain HTML rather than a page in
  the app.

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
| `tests/mobile.test.ts` | Replay safety under sequential and concurrent retries, fingerprint conflicts, key scoping and rollback, the outbox's ordering/superseding/backoff/classification rules, device revocation and session invalidation, receipt permissions and idempotent attachment, notification defaults and delivery outcomes, the proposal-acceptance push, a full offline session, and a regression test for the journal-numbering deadlock |
| `tests/jobs.test.ts` | Module resolution from pack plus override, workflow gating, terminology, the cost-code dimension end to end, budget vs actual, change-order approval posting nothing, application pricing and increments, retainage splitting AR from Retainage Receivable, the AR-control-equals-subledger identity, retainage release without double-recognizing revenue, WIP arithmetic, compliance expiry, and the no-forked-ledger reconciliation |
| `tests/ai.test.ts` | The core-works-without-AI guarantee, cost arithmetic in micros, gateway ordering and schema rejection, quotas and ceilings, provider fallback, prompt versioning and rollback, permission-gated retrieval, human-in-the-loop approval and audit attribution, capability behaviour, tenant isolation |

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

### The optional AI module (Phase 6)

48. **It is off until you switch it on** — open **AI**. The seed enables it so there is something
    to look at; a company created through **Set up a company** has no settings row at all, and no
    settings row means off. Untick **Enable the AI module** and the assistant disappears from
    Bookkeeping entirely — absent, not greyed out.
49. **No API key needed** — the provider reads `mock`, and the model column reads
    `mock-heuristic-v1`. It answers from readable heuristics, which is why the demo and all 452
    tests run with no credentials and no network.
50. **The meter is the page** — spend, request count, per-capability usage, and the raw usage
    ledger. Every call is there, including the ones that were blocked, so "why did nothing happen"
    has an answer.
51. **Suggestions are proposals** — under **Awaiting a decision** are two the seed raised. Nothing
    has been categorized. Go to **Bookkeeping**, open **More → Assistant** on any transaction, and
    press **Suggest a category**: it returns an account, a confidence, and one sentence of
    reasoning, and changes nothing.
52. **Accepting is the person's action** — press **Accept**. The transaction is categorized and a
    journal entry posts. Check the transaction's history: the event is `transaction.categorize` by
    *you*, exactly as if you had used the dropdown, with a separate `ai_suggestion.accept` event
    recording that a machine proposed it.
53. **It declines rather than guessing** — try the assistant on a transaction like `POS 88213
    XFER`. It returns "Nothing in the description identifies this reliably" instead of a wrong
    account. The call still succeeded and was still metered — declining is an answer.
54. **Rule proposals generalize your decision, not its own** — the assistant only proposes a rule
    for a merchant you have already categorized the same way twice, so it is extending a pattern
    you established.
55. **Duplicates** — press **Check for duplicates** above the inbox. It looks for the same merchant
    and amount within three days, and for charges far above a merchant's own typical size, and
    explains each in one sentence.
56. **Insights** — under **AI → Insights**, press **Explain my figures**. Every number is drawn
    from the same records the reports page shows; this only says what they mean. The seed's data
    produces a real concentration warning: one client is 89% of invoiced revenue.
57. **AI cannot read what you cannot** — sign in as a `sales` or `marketing` role and the insights
    assistant refuses, because those roles have no `reports:view`. The retrieval layer is gated on
    the same permission the human would need.
58. **Prompts are versioned** — under **AI → Prompts**, edit one and save. It becomes a new version
    rather than overwriting, the ledger records which version answered each request, and
    **Roll back to built-in** is one press.
59. **The limits bite before a provider is reached** — set **Requests per hour** to `1`, save, and
    press **Summarize the inbox** twice. The second is refused and lands in the ledger as
    `Blocked — quota`, having cost nothing. The monthly spend ceiling works the same way, but note
    it can only bite against a *priced* provider: the built-in heuristics are free, so on `mock`
    there is never any spend to cap and the hourly limit is the control that matters.
60. **A missing key degrades rather than breaks** — switch the provider to `anthropic` without
    setting `ANTHROPIC_API_KEY`. The page warns that credentials are missing and suggestions keep
    coming from the heuristics. Bookkeeping is unaffected either way.

### Job costing and construction (Phase 7)

61. **The module is already on, and nobody configured it** — the **Jobs** chip is in the workspace
    row because the construction industry pack asks for job costing. Open **Jobs → Modules**: it
    is ticked and labelled *on by default for your industry*.
62. **Turn it off and it disappears** — untick **Job costing**. The **Jobs** chip vanishes from
    every workspace, and visiting `/jobs` directly explains the module is off rather than showing
    an empty page. Tick it back on.
63. **The WIP schedule** — **Jobs** shows contract value, revised budget, cost to date, percent
    complete, earned revenue, billed to date, and over/under billing for every open job. The seed's
    job is slightly overbilled, which is the normal healthy position for a contractor.
64. **Budget vs actual** — open the job. **Actual** is posted ledger cost carrying that job and
    cost code; nothing on the page is a cached total. Framing is 22.7% spent against $11,800
    budgeted.
65. **Approving a change order posts nothing** — the **Change orders** tab shows CO-001 approved
    for $860 of contract and $610 of budget. Look at **Accounting → Trial balance**: there is no
    entry for it. A change order is an agreement about work nobody has done, and posting on
    approval recognizes revenue for it.
66. **Where the change went instead** — back on the job, the **Budget vs actual** tab shows
    Electrical with a `$610.00` *Changes* column beside its unchanged `$7,600.00` original, and the
    **Billing** tab shows a new `CO-001` line on the schedule of values, so the change is billable.
67. **An application is an ordinary invoice** — under **Billing**, application 1 billed $5,600 with
    $560 retained and $5,040 due, issued as `INV-1004`. Open **Accounting → A/R aging**: that
    invoice contributes **$5,040**, not $5,600. The retained portion is billed work sitting in
    Retainage Receivable, not in AR — and it ages nowhere, because it is not yet owed.
68. **The identity that motivated the design** — on **Trial balance** (set the range wide enough to
    cover the seeded dates), `1100 Accounts Receivable` nets to **$38,440.00**, which is exactly
    the total on the A/R aging report — the sum of open invoice balances. `1170 Retainage
    Receivable` carries the $560 separately. Handling retainage as a reclassifying entry *after*
    the invoice would leave the control account short by $560 while the subledger was not, which
    is why it lives inside `createInvoice` instead.
69. **Release the retainage** — press **Release retainage**, choose the client, and bill it. On
    **Profit & loss**, revenue is *unchanged*: the money moved from held to owed, and it was
    recognized when the work was billed. `1170` is back to zero.
70. **The job's ledger** — at the bottom of the job page is every posted line carrying it, with
    entry numbers. The budget report above is exactly these rows, grouped. Follow any number to the
    entry behind it in **Accounting → Journal**.
71. **Nothing forked** — this is the phase's claim. Every cost line on the job page carries an
    entry number; find the same entry under **Accounting → Journal** and it is one entry, not a
    ledger posting plus a job-cost posting. There is no job cost table to fall out of step, because
    a job's costs and the trial balance are the same rows added up two different ways. The global
    form of the claim — job cost plus unassigned cost equals cost of sales plus operating expenses
    on the P&L — is asserted directly by `tests/jobs.test.ts`, in the suite named
    *the ledger did not fork*.
72. **Subcontractor compliance** — **Jobs → Subcontractors**. Delta Electrical is flagged: a
    missing W-9 and a general liability certificate expiring in three weeks. Record the W-9 and the
    warning clears. Note the certificate status is derived from its expiry date every time the page
    loads — nothing stores "valid".
73. **Advice, not a lock** — a missing form does not block anything on its own. **Hold payments**
    is a decision a person makes, and it is the only thing that blocks. Software that silently
    refuses to pay a subcontractor over a stale form is software that gets worked around.
74. **A company without the module is untouched** — register a second company as **Retail**. It has
    no **Jobs** chip, no cost codes, no retainage account, and its invoices post the same two-line
    entry they always did. That is spec §23's rule: industry customization extends the common
    platform rather than creating separate products.

### The mobile app

75. **Open it on a phone** — visit `/m`, or narrow a desktop window to 390px. Signed out, you land
    on the login page with `?next=/m` and come straight back after signing in.
76. **Install it** — Chrome offers an install button at the bottom of Today; iOS Safari gets an
    explanation of where the Share menu is, because Safari has no programmatic install. Dismissing
    it is remembered, so it does not come back.
77. **Today answers one question** — how many transactions need a category, roughly how long that
    will take, and what is owed to you. Not a dashboard: a phone opened for ninety seconds cannot
    afford a screen of figures.
78. **Review is a deck, not a table** — one transaction filling the screen, recently-used categories
    surfacing after the first tap, 48px rows. Each decision advances immediately without waiting for
    the network.
79. **Now turn off your wifi.** A line appears: *"You are offline. Everything you do here is saved
    and sent when the connection returns."* Keep reviewing — four or five transactions. The counter
    reads *"4 changes saved on this device."*
80. **Check that it is real** — open DevTools → Application → IndexedDB → `accountrix-outbox`. Your
    decisions are there with their idempotency keys, `status: "pending"`.
81. **Turn the wifi back on.** Within a second or two the queue empties, the badge disappears, and
    the transactions are categorized in the desktop inbox with journal entries posted. Nothing was
    lost and nothing was duplicated.
82. **The claim, tested the hard way** — the seed categorizes two transactions through the mobile
    API and then *replays the same operation with the same key*, exactly as a phone that lost the
    first response would. The output reads "replayed, no second entry". Check
    **Accounting → Journal**: one entry each.
83. **Offline navigation degrades honestly** — with the wifi off, visit a page you have never
    opened. You get a plain "You are offline" page that explains nothing is lost, not a browser
    error and not a stale figure. Then go back to `/m`: it renders from cache, because you have
    been there.
84. **Capture a receipt** — the camera tab opens your phone's own camera app. The photo is
    downscaled in the browser before it uploads; the size under the preview is typically around
    200 KB rather than the 4 MB the camera produced. Choose what it belongs to and the attachment
    goes through the queue.
85. **Sign out a lost phone** — **Settings** lists every device signed in, with the current one
    marked. Signing another one out ends its sessions immediately and leaves this one alone. The
    device stays in the audit trail; it just stops working.
86. **Notifications are two switches, not one** — a per-device subscription and a per-topic
    preference. Turning off "An invoice was paid" does not silence proposals. The page says plainly
    that the built-in provider records notifications and delivers none, so nobody concludes push
    is broken.
87. **A notification nobody triggered** — accept a proposal from its public link at `/p/<token>`.
    Everyone who can manage proposals is notified, recorded in the log under **Settings**. That is
    the event a mobile app exists for: it happens when nobody is looking at a screen.
88. **The API is versioned in the path** — `POST /api/mobile/v1/sync` returns its contract version
    and drains the queue and returns fresh state in one round trip. A native client would call
    exactly this.

## Project layout

```
src/
  app/                    Routes, server actions, and UI (no business logic)
    actions/              Server actions — resolve the actor, call one service
    bookkeeping/          Transaction Inbox
    accounting/           Reports, journal, reconciliation workspace
    crm/                  Pipeline, dashboard, clients, proposals, designer
    marketing/            Overview, campaigns, segments, creative, suppressions
    ai/                   AI module admin, usage ledger, insights, prompt registry
    jobs/                 WIP schedule, job detail, cost codes, subcontractors
    settings/modules/     Industry module switches
    m/                    The mobile app — Today, review deck, receipts, devices
    api/mobile/v1/        Versioned mobile API: sync (outbox + state), receipts
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
  lib/                    Money arithmetic, basis points, request-scoped actor resolution
  modules/                Domain logic, one directory per spec §17 boundary
    audit/                Append-only event log and undo support
    auth/                 Password hashing and sessions
    banking/              Provider interface, mock adapter, import and dedup
    bookkeeping/          Rule matching, categorization, splits, transfers
    coa/                  Chart of accounts and industry packs
    crm/                  Pipeline, proposals, intake, conversion, acceptance
    design/               Blocks, merge fields, templates, document composition
    marketing/            Segments, campaigns, email provider, engagement, analytics
    ai/                   Gateway, providers, prompts, retrieval, suggestions, metering
    industry/             Module resolution from industry packs and company overrides
    jobs/                 Cost codes, budgets, change orders, progress billing, WIP, compliance
    mobile/               Idempotency, the pure outbox, devices, receipts, push, notifications
    studio/               Company profile, brand kits, assets, clause library
    ledger/               Journal engine, derived postings, balances, statements
    permissions/          Roles, permissions, overrides
    receivables/          Customers, vendors, invoices, bills, payments
    reconciliation/       Statement sessions, clearing, locking
    tenancy/              Actor context, tenant scoping, onboarding
public/                   PWA manifest, service worker, icons, offline fallback
scripts/                  One-off generators (PWA icons)
drizzle/                  Generated SQL migrations
docs/                     Specification and architecture decision records
tests/                    Vitest suites
```

The rule that keeps this honest: **`src/app/` must not contain business logic**, and every service
function takes an `ActorContext` first. See ADR 0001 for why.

## Installing the mobile app

The app lives at `/m` and is the same origin, the same session, and the same
services as the desktop workspaces — there is no separate build and no store listing.

- **Chrome / Edge (Android, desktop)** — an install button appears at the bottom of the
  Today screen once the browser considers the app installable.
- **iOS Safari** — Share → *Add to Home Screen*. Safari fires no install event and has
  no programmatic install, so the app explains where the button is instead.

Installing matters for more than the icon: **iOS delivers push notifications only to
installed PWAs**, never to a tab.

Service workers require HTTPS or `localhost`. A staging deployment behind plain HTTP
will run the app fine and register no service worker, so nothing will work offline.

### Push notifications

`PUSH_PROVIDER=mock` is the default: it records every notification in the log and
delivers none, which is what the demo and the tests run on. For real delivery, generate a
VAPID key pair and set all three variables server-side:

```bash
npx web-push generate-vapid-keys
```

```
PUSH_PROVIDER=webpush
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@yourcompany.com
```

The private key never leaves the server (spec §12, §19); only the public key is sent to
the browser, which is what it is for. An unconfigured `webpush` adapter reports itself as
such and the registry falls back to the mock rather than throwing on every notification —
the same degradation as the AI provider.

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

## Switching AI providers

The AI module is **off for every company by default**, and switching it on is a per-company
setting inside the app rather than an environment variable. `AI_PROVIDER` only decides which
adapter is the default selection.

The built-in `mock` adapter answers from readable heuristics — it needs no credentials, no
network, and no configuration, and it is what the demo and the whole test suite run on. To add a
real model provider:

1. Implement the `AiProvider` interface from `src/modules/ai/provider.ts`.
2. Register it in `src/modules/ai/registry.ts`.
3. Set its credentials in the server environment and select it on `/ai`.

An adapter that reports itself unconfigured is replaced by the mock at call time and the admin
page says so — a missing API key degrades to heuristic suggestions rather than breaking the
bookkeeping inbox. Nothing outside `modules/ai` imports a provider: permission, quota, cost
ceiling, prompt resolution, output validation, and metering all happen in one gateway function,
so no call site can skip them (spec §12).

## Dependency security

`npm audit` reports **0 vulnerabilities**, across runtime and development dependencies alike.

Getting there took three upgrades, each verified rather than assumed:

| Advisory | Resolution |
| --- | --- |
| `drizzle-orm` — SQL injection via improperly escaped SQL identifiers (high) | drizzle-orm 0.36.4 → 0.45.2, drizzle-kit 0.28.1 → 0.31.10. No source changes needed. |
| `postcss`, `sharp` — transitive through `next` (high) | next 15.1.3 → 16.3.0. No source changes needed. |
| `esbuild` — dev server readable cross-origin (moderate) | vitest 2.1.8 → 4.1.10 cleared its half; the other half is a deprecated `@esbuild-kit` package inside `drizzle-kit`, pinned forward with an `overrides` entry. |

The `overrides` entry in `package.json` exists because `@esbuild-kit/core-utils` and
`@esbuild-kit/esm-loader` are both deprecated — their maintainer merged them into `tsx` — so
`drizzle-kit` will never ship an updated copy. `npm audit fix --force` "solves" this by proposing a
downgrade to `drizzle-kit@0.18.1`, which would undo the SQL-injection fix above and cannot read this
schema. Pinning the nested `esbuild` forward is the fix; `drizzle-kit generate` and a
migrate-from-empty are checked after it to confirm the tooling still loads its config.

**What was checked after each upgrade**, because a green test suite is not by itself evidence that
a database toolchain or a rendering framework still behaves:

- The committed migrations produce a **byte-identical schema** from an empty database, diffed
  against a dump taken before any of this started.
- `drizzle-kit generate` reports no drift and rewrites no snapshot.
- The **route table is identical** — 45 routes, same names, same static/dynamic classification.
- All 497 tests pass, and the seed produces figures identical to the pre-upgrade run.
- Every route renders in a browser, with the ledger figures unmoved (AR nets $38,440 against an
  identical aging total; the trial balance balances).
- Write paths too: a categorization, a module toggle through its upsert-then-delete branch, the
  mobile sync endpoint, and a full offline cycle — four decisions queued with the network off and
  drained clean on reconnect.

### One thing the Next 16 upgrade required

Vitest 4 removed `poolOptions`, and with it the `singleFork` setting that had been *implying* serial
test files. This suite shares one Postgres database and truncates every table in `beforeEach`, so
parallel files truncate each other mid-test: the run went from 497 passing to 337 failing with
deadlocks and vanishing rows. `vitest.config.ts` now sets `fileParallelism: false` explicitly, so
the guarantee the suite depends on is stated rather than inherited from a pool detail.

## Not built yet

Tracked against the spec §20 phases:

- **Phase 8 — Payroll / Tax / Advanced Integrations.** Nothing built. Spec §19 requires a security
  review before production use of payroll or tax filing, which makes it a poor candidate for a
  phase that ends in a commit rather than an audit.


Gaps within the phases already built:

- **No tool-calling loop.** Spec §12's tool layer is implemented as the suggestion queue plus
  permission-gated retrieval, not as a model invoking functions directly. Every consequential
  action here is one a person should confirm anyway. See ADR 0006.
- **No AI response caching.** Spec §12 asks for "caching where safe"; the `cache_hit` column
  exists and nothing sets it. A safe key has to cover the prompt *and* the underlying records,
  and getting it wrong serves a stale suggestion about a changed transaction.
- **AI quotas are per company, not per plan.** There is no billing-plan model yet, so the ceiling
  is a number an owner sets rather than a plan default.
- **No prompt evaluation harness.** Versions can be created and rolled back, and the acceptance
  rate tells you a version got worse — but nothing tells you before you ship it.
- **AI cost is an estimate.** Prices are a table in the adapter; historic ledger rows keep the
  figure computed at the time. It is a usage meter, not billing.

- **Eight of ten industry modules do nothing.** `job_costing` and `projects` are implemented;
  `inventory`, `time_billing`, `pos_import`, `properties`, `funds`, `appointments`, `vehicles`,
  and `manufacturing` are declared, switched on by the packs that ask for them, and have no
  workflows. The module settings page lists them under "Not built yet" rather than hiding them.
- **WIP does not post its adjusting entry.** The schedule reports over- and under-billings;
  `1160 Costs in Excess of Billings` and `2560 Billings in Excess of Costs` install with the pack
  and stay empty until an accountant posts to them. Automating a period-end adjustment nobody
  reviewed is how a WIP schedule becomes a source of surprises. See ADR 0007.
- **Percent complete is cost-to-cost only.** Units-complete and effort-expended methods are not
  offered.
- **An application for payment is issued immediately.** `priceApplication` gives the UI a preview,
  but there is no save-as-draft-then-review step; the `draft` progress-billing status is reserved
  for it and unused.
- **Retainage release is not per contract item.** A partial release takes an amount, not a
  schedule-of-values breakdown, so contracts releasing retainage per trade as each finishes are
  not supported.
- **Subcontractor retainage is a default, not an automation.** A sub's default rate is recorded and
  shown; `createBill` still takes the withheld amount explicitly, because a bill whose total
  depends on a setting the person entering it cannot see is worse than typing the number.
- **Lien waivers are not tied to payments.** They are a compliance document kind and can be filed
  against a job, but nothing blocks a payment for want of one.

- **No native mobile apps.** The mobile experience is an installable PWA, which is what spec §18
  asks for at this stage. The consequences are real: **iOS delivers push only to installed PWAs**,
  never to a Safari tab, and Background Sync is Chromium-only — on Safari the outbox drains on
  reconnect, on visibility, and on a slow timer, which covers everything except the app being
  closed for the whole outage. `/api/mobile/v1` is versioned so a native client can be added
  without a second contract.
- **Receipt photos cannot be uploaded offline.** A megabyte of JPEG will not go in the outbox
  without filling the device's storage quota, so capturing offline fails and says so. Attaching an
  already-uploaded receipt *is* queueable.
- **"Remember this vendor" is unavailable on the queued path.** Creating a rule writes outside the
  operation's transaction and creating one twice is a mess to undo, so the phone offers the
  checkbox only when online.
- **The mobile deck does not split transactions.** The API accepts splits and they replay safely;
  there is no phone UI for one, because a two-line split on a phone screen is worse than waiting
  for a laptop.
- **Nothing schedules the review nudge.** `nudgeReviewQueue` works and is tested; only the seed
  calls it. Same missing background worker as the campaign scheduler.
- **Idempotency keys are never pruned automatically.** `pruneIdempotencyKeys` exists and is tested;
  nothing calls it on a schedule, for the same reason.
- **A parked operation explains itself but cannot be repaired.** If a period closed while a phone
  was offline, the outbox shows the error and offers retry or discard — not a way to redate the
  entry. See ADR 0008.

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
- **Classes, departments, and locations are not modelled.** The job and cost-code dimensions are
  real as of Phase 7 and reported on throughout the jobs workspace; the other §13 dimensions are
  not. The statements themselves still cannot be filtered by job — the WIP and job cost reports
  answer that question, but a P&L scoped to one job is a query change still to make.
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
