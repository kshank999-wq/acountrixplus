# Accountrix Plus

A unified business operating system for bookkeeping, accounting, clients, proposals, and
marketing — an alternative to QuickBooks.

This repository implements **Phase 0 (Foundation)**, **Phase 1 (Bookkeeping MVP)**,
**Phase 2 (Reconciliation + Accounting Core)**, **Phase 3 (CRM + Proposal Pipeline)**,
**Phase 4 (Proposal Designer + Company Studio)**, **Phase 5 (Marketing)**,
**Phase 6 (AI Add-on)**, **Phase 7 (Industry Modules)**, the mobile app,
**Payroll and Tax**, the **background worker and outbox**, the
**completed accounting core**, the **statements an accountant asks for**, the
**security controls**, **inventory**, **time and billing**,
**accounting dimensions with the fixed asset register**, **bringing an
existing business's books in**, **accountant practice mode**,
**transactional mail with password reset and invitations**,
**attachments and accountant notes on a content-addressed object store**,
**server-side PDF generation with immutable sent-document snapshots**, the
**communications log with the follow-up list**, **property management**, a
**retention policy with the scheduled work six phases owed**,
**per-client staff assignment inside a firm**, **fund accounting for
nonprofits**, **manufacturing with bills of materials and work orders**, **daily takings
from a till or a marketplace**, **an appointment diary with practitioner splits
and gift cards**, and **customer vehicles with an estimate nobody may bill past**
from the
[development specification](docs/SPEC.md). Architecture decisions are recorded in
[ADR 0001](docs/adr/0001-modular-monolith-and-tenancy.md),
[ADR 0002](docs/adr/0002-double-entry-ledger.md),
[ADR 0003](docs/adr/0003-crm-and-public-intake.md),
[ADR 0004](docs/adr/0004-document-engine-and-brand.md),
[ADR 0005](docs/adr/0005-marketing-consent-and-engagement.md),
[ADR 0006](docs/adr/0006-ai-gateway-and-human-approval.md),
[ADR 0007](docs/adr/0007-industry-modules-without-forking-the-ledger.md),
[ADR 0008](docs/adr/0008-offline-first-and-replay-safety.md),
[ADR 0009](docs/adr/0009-payroll-the-entry-not-the-tax.md),
[ADR 0010](docs/adr/0010-at-least-once-and-who-decides.md),
[ADR 0011](docs/adr/0011-the-same-books-read-two-ways.md),
[ADR 0012](docs/adr/0012-the-statements-an-accountant-asks-for.md),
[ADR 0013](docs/adr/0013-a-stolen-password-is-not-enough.md),
[ADR 0014](docs/adr/0014-one-inventory-five-industries.md),
[ADR 0015](docs/adr/0015-an-hour-is-billed-once.md),
[ADR 0016](docs/adr/0016-the-parts-sum-to-the-whole.md),
[ADR 0017](docs/adr/0017-nothing-is-imported-until-all-of-it-can-be.md),
[ADR 0018](docs/adr/0018-access-is-granted-never-claimed.md),
[ADR 0019](docs/adr/0019-a-reset-is-not-marketing-and-an-invitation-carries-no-password.md), and
[ADR 0020](docs/adr/0020-one-file-stored-once-reachable-only-through-a-record.md),
[ADR 0021](docs/adr/0021-a-sent-document-never-changes.md), and
[ADR 0022](docs/adr/0022-what-was-said-and-what-was-promised.md), and
[ADR 0023](docs/adr/0023-somebody-elses-money.md), and
[ADR 0024](docs/adr/0024-nothing-grows-for-ever-and-nothing-waits-for-somebody-to-look.md), and
[ADR 0025](docs/adr/0025-a-firm-does-not-put-everybody-on-everything.md), and
[ADR 0026](docs/adr/0026-a-restriction-is-the-donors-not-the-charitys.md), and
[ADR 0027](docs/adr/0027-cost-moves-with-the-material.md), and
[ADR 0028](docs/adr/0028-a-day-is-a-fact-somebody-else-recorded.md), and
[ADR 0029](docs/adr/0029-a-booking-is-a-promise-and-part-of-the-money-was-never-yours.md), and
[ADR 0030](docs/adr/0030-nobody-bills-past-what-was-authorised.md), and
[ADR 0031](docs/adr/0031-what-is-owed-is-owed-by-somebody.md), and
[ADR 0032](docs/adr/0032-change-is-not-a-transaction.md), and
[ADR 0033](docs/adr/0033-a-check-nobody-runs-is-not-a-check.md), and
[ADR 0034](docs/adr/0034-the-drawer-is-counted-and-the-difference-is-named.md), and
[ADR 0035](docs/adr/0035-a-document-is-owed-in-its-own-currency.md), and
[ADR 0036](docs/adr/0036-a-plan-is-not-a-second-ledger.md), and
[ADR 0037](docs/adr/0037-a-schedule-is-a-promise-to-bill.md).

> **A note on phase numbering.** Spec §20's Phase 8 is *Payroll/Tax/Advanced
> Integrations*; the mobile app is not a phase of its own there, and §18 asks
> for "a responsive web/PWA interface **before committing to separate native
> mobile apps**". The mobile work below is that PWA, plus the versioned API and
> replay contract a native client would consume later. Payroll and tax — §20's
> actual Phase 8 — followed it. The **background worker** after that is past the
> roadmap's end: it is spec §18 infrastructure, and four consecutive ADRs had
> recorded it as the thing blocking features already built.

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

- **Design Center** — profile, brand kit (colours, fonts, logo), a logo and image library, a
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

### Payroll and tax (Phase 9)

The workspace at `/payroll`. It is built around one distinction, and every part
of it is that distinction applied to another surface: **this system is
authoritative about the journal entry, and is not authoritative about the tax.**

A wrong withholding figure takes money out of a real person's pay packet. That
depends on jurisdiction, filing status, year-to-date position, and rules that
change annually — so the default adapter does not calculate it at all.

- **Payroll behind an adapter, calculating nothing by default** — the sixth use
  of this codebase's provider pattern, but the point is not swappability. The
  default (`manual`) takes what a payroll bureau already worked out and records
  it, which is how most small businesses actually run payroll. The registry has
  **no fallback**: an unknown `PAYROLL_PROVIDER` throws, because silently
  substituting one source of payroll figures for another is the failure mode.
- **One balanced entry, and you see it before it posts** — the run wizard's
  third step is the entry itself, itemised, with the identity `gross +
  employer cost = net + everything owed` shown as arithmetic. A totals row looks
  identical whether withholding was kinded correctly or not; the entry is the
  only place the difference shows.
- **Withholding can't be booked as an employer cost** — the commonest payroll
  error, and it still balances, which is why it survives review. Three guards:
  a `payroll_item_kind` enum on every line, `expense_account_id` null on a
  withholding line *by construction*, and `assertBalanced` checking the payroll
  identity before anything reaches the journal engine.
- **Liabilities read from the ledger** — a figure somebody is about to pay an
  agency comes from the same place the balance sheet gets it. A remittance
  posts Dr the liability, Cr the bank, and **no expense**. It refuses to remit
  more than is owed, and refuses a kind that disagrees with the account.
- **Sales tax rates are yours** — nothing ships and nothing updates itself. A
  rate table in a release is correct on the day it ships and silently wrong
  afterwards. The rate is frozen onto each document, so changing a code next
  quarter cannot restate last quarter's return. Exempt sales are reported
  alongside taxable ones, and the ledger balance sits *beside* the period's
  collections rather than instead of them.
- **Contractor reporting, named for what it is** — what was paid to each
  reportable contractor in a calendar year, counted from **payments made**, not
  bills raised. The column that matters is `blockers`: the figure is the easy
  part, and the missing tax identifier is what actually stops a filing in
  January.
- **Only four digits of an employee's tax id**, with a database CHECK, and a
  longer value is *refused* rather than truncated. The system cannot leak what
  it never took. Payroll permissions are implied by nothing else — a bookkeeper
  gets tax and no payroll at all.
- **Workpapers that say what is wrong** — an accountant needs the figures, the
  trail back to them, and an honest account of what is wrong with them. Most
  software gives the first two. Every pack carries an `exceptions` list, and
  `prepareFiling` refuses on a blocker unless given a reason that is stored
  alongside every blocker it overrode.
- **No `file()`, and the enum says so** — `tax_filings.status` is `prepared` or
  `filed_externally`. There is no `filed`. This system does not submit returns,
  and spec §19 requires a security review before it could. The notice saying so
  is at the top of every screen in the workspace, not only in this README.

### Background work and the outbox

`npm run worker`, and the operations page at `/settings/operations`. Spec §18
asks for both a background queue and an event/outbox pattern; four ADRs in a row
had ended with "the missing piece is a background worker".

The queue's promise is deliberately narrow, and stating it plainly is the most
useful thing about it: **a job runs at least once, never exactly once.** A
worker can be killed between finishing work and recording that it finished, and
no arrangement of tables closes that window. So every handler is written to be
safe run twice — the same discipline the mobile app has followed since Phase 8.

- **Concurrency that actually works** — claims use `FOR UPDATE SKIP LOCKED`, so
  a second worker takes different jobs rather than blocking on the first or
  duplicating it. A worker killed holding a job has its claim expire and the
  job picked up again.
- **Backoff that does not synchronise** — exponential, capped at an hour, and
  jittered upward. A provider outage fails every queued job at once; without
  jitter they all retry at the same instant and synchronise harder each round.
- **Dead means dead** — out of attempts, a job stops and waits for a person.
  Deleting destroys the evidence; retrying forever hides the healthy queue
  behind one broken job. Housekeeping sweeps succeeded and cancelled jobs and
  never touches dead ones.
- **The outbox replaces a swallowed failure** — proposal acceptance used to
  call the notifier and swallow anything it threw, because a push service must
  not roll back a signature. Now an event is written *inside the acceptance's
  transaction*, so it exists exactly when the acceptance does, and delivery
  happens afterwards with retries. A delivery that fails five times is a row on
  a page instead of silence.
- **Schedules, not cron** — four cadences and an hour. A cron typo means
  "never" rather than an error, and a schedule that silently never fires is
  worse than one that cannot express every timing. `nextRunAt` is pure and
  returns a time *strictly* after the one given — a scheduler that can return
  "now" fires the same job forever.
- **A scheduled task has a real identity** — its own user row, honest in the
  audit trail, that cannot sign in (its stored hash is not in a format any
  password could hash to) and is a member of no company. Both are asserted in
  the tests rather than assumed. The alternative was putting an owner's name on
  an entry they did not post.
- **The four blocked features, now running** — campaign scheduling and nurture
  delays (ADR 0005), the WIP adjusting entry (ADR 0007), the review nudge and
  idempotency-key pruning (ADR 0008), and a remittance-due reminder (ADR 0009).
  Plus bank sync, which spec §18 named first and which ran inline until now.
- **A clock is not a licence to decide** — this is the part worth reading the
  ADR for. ADR 0007 refused to post the WIP adjusting entry automatically, and
  having a worker did not change that judgement. The objection was never that
  the arithmetic was hard; it was about *who decides*. So the job writes a
  **draft** — balanced, validated, numbered, and affecting no statement until an
  accountant posts it.
- **A page, because absence is invisible** — "the queue is empty" and "nothing
  is draining the queue" look identical everywhere else, and the second is an
  outage that presents as calm. Workers write a heartbeat every tick; the page
  leads with whether one is alive, then with what failed, and puts the
  successes last.

### The accounting core completed (cash basis, credits, recurring, close)

The §13 items that had been open since Phase 2. The centrepiece is
**cash-basis reporting**, which ADR 0002 deferred by name and designed
`payment_applications` to make possible — and which Phase 9's tax workpapers
need, because most small businesses file on a cash basis.

- **The same books, read two ways** — a basis switch on the profit & loss and
  the balance sheet. Cash basis is a *transformation* of the accrual ledger,
  not a second set of books: remove the invoice and bill entries, and replace
  each payment's receivable leg with the settled document's own revenue lines,
  scaled to what that payment covered. Both bases balance, and
  `tests/cash-basis.test.ts` asserts it rather than arguing it.
- **Not the shortcut that looks right** — reporting bank movements and calling
  it cash basis puts every receipt on one line, so revenue appears as a single
  "customer receipts" figure instead of split across the accounts the invoices
  were raised against. Nobody can file from that.
- **Caveats computed from your books, not printed on every report** — payroll
  timing, unapplied payments, sales tax. A company with no payroll is not
  warned about payroll.
- **A credit note and a write-off are opposite things** — a credit says they
  owe less and reverses revenue; a write-off says they owe it and will not pay,
  keeps the revenue, and books Bad Debt. Conflating them is how a set of books
  hides a collections problem: lower revenue, no bad debt, unchanged margin.
  They sit side by side with their consequences stated.
- **`written_off` is its own status**, not `paid`. Nobody paid, and a status
  saying they did erases the fact from every report that reads it.
- **Customer statements, open-item and balance-forward** — most software picks
  one and calls it "the statement". They answer different questions. A saved
  statement freezes its figures, because one regenerated from today's data is
  not the document the customer is holding.
- **Recurring entries** — a template plus a clock, which is why they needed
  Phase 10. Whether an occurrence posts or waits as a draft is the template's
  decision, made once: a rent accrual is safe unattended, an estimate is not.
  Catch-up runs fully in one pass, so a template eight months behind arrives
  with eight correctly dated entries rather than one a day for eight days.
- **The year-end close** — empties revenue and expense into Retained Earnings,
  so the next year opens from zero and the balance sheet's separate earnings
  line is finally moved where it belongs. It refuses on a blocker with **no
  override**: closing twice has one outcome and it is wrong. Reopening reverses
  the entry rather than deleting it.
- **Closing is not locking.** Locking stops entries being written; closing
  writes one more. A company can do either without the other, and conflating
  them would mean a correction to last year required unlocking something
  unrelated.

### The statements an accountant asks for (cash flow, comparatives, deposits)

The rest of §13's list, plus the fix for a defect the demo data found in the
last phase.

- **Statement of Cash Flows, indirect method.** Not a list of adjustment rules
  to memorise — one identity. Because every entry balances, the movements of
  all accounts sum to zero, so the change in cash *is* the negated movement of
  every other account, and the three sections are a grouping of those accounts.
  "Add back depreciation" is not a rule: Accumulated Depreciation moved by a
  credit, so its negated movement is positive and it lands in operating because
  that is where the account is classified. `reconciles` asserts the sections
  come to what the cash accounts actually moved.
- **Comparative periods** on the profit & loss, with prior period, same period
  last year, and year to date. An account with activity in only one column
  survives with a zero rather than vanishing — "we stopped spending on this" is
  exactly what a comparative is read to find out.
- **Undeposited funds and deposits.** Three cheques banked together are one
  line on the statement. Without a deposit they are three in the books and
  reconciliation cannot match them; the usual workaround is one lump receipt,
  which loses which customer paid what and breaks the receivable, the
  statement, and the aging report at once. A processing fee is a negative line,
  so the bank account carries the figure the bank processed rather than the
  gross.
- **Vendor credits**, the AP mirror of a credit note — same table, one `party`
  column, the way `payments` holds receipts and disbursements. There is
  deliberately **no vendor write-off**: a debt the supplier stopped chasing is
  a judgement about whether the obligation is really gone, not a bookkeeping
  operation.
- **Cash basis now understands accruals** — the Phase 11 defect. A manual
  accrual used to show as an expense on a cash-basis P&L. Every timing
  difference is written down twice, and which entry is the cash one is visible
  in what its *other* legs are: a recognition entry's are income-statement
  accounts, a cash entry's include cash. So the recognition entry is removed
  and what it said the money was for is put back on the cash entry. A
  prepayment is deducted when paid, a deposit taken in advance is revenue when
  it arrives, and depreciation is untouched — it looks identical to an accrual
  and is not one, which is why the rule is by account and not by shape.
- **A closed year that has moved says so.** Closing does not lock the period,
  by design, so an entry can still land in a closed year — and it makes the
  figure transferred to Retained Earnings wrong. The drift is recomputed and
  reported rather than the entry being blocked, and two corrections that cancel
  are reported as cancelling.

### The security controls (two-factor, login history, export, backups)

Spec §19 names a security review as the gate in front of production use of
payroll, tax filing, payment features, and automated financial actions — most of
what the last five phases built. This is the part of that gate which is code.
The claim: **a stolen password is not enough, and every attempt to use one is on
the record.**

- **Two-factor authentication (TOTP)**, tested against RFC 6238's published
  vectors. Four details are load-bearing and each is a way sixty lines could be
  quietly wrong: constant-time comparison, so timing does not leak how many
  digits were right; ±1 step of drift and no more; the counter floored to
  30-second steps; and **a used code cannot be used again**, which is the one
  most implementations skip — without it a code read over a shoulder works for a
  full minute.
- **Enrolment is two steps.** The secret is stored unconfirmed and MFA only
  switches on after a code from it has worked. Enabling on generation would lock
  out everybody who scanned the wrong QR code, and they would find out at their
  next sign-in with no way back in.
- **Ten single-use recovery codes**, shown once, hashed the way passwords are.
  Without them, MFA is one dropped phone away from a support process that
  consists of switching it off for whoever asks.
- **The half-signed-in state is not a session.** It is a five-minute signed
  token that grants exactly one thing — the right to present a second factor —
  bound to the password hash, so changing the password kills it.
- **The policy is enforced at `requireActor`**, the one function every page and
  action already starts at. A company can require two-factor for everybody;
  members without it can reach the security page and nothing else. Opt-in MFA is
  adopted by the people who were never the risk.
- **Login history and lockout.** Every attempt is recorded with a named outcome,
  because "twelve wrong passwords for one address" and "twelve addresses that do
  not exist" are the same under a boolean and mean different things. Failures
  are counted since the last success, so a bad typing day does not accumulate a
  lockout. Addresses are kept to the network, never the host.
- **Changing a password ends every other session.** On its own a new password
  achieves nothing — the attacker's cookie is still valid, and they stay signed
  in while the victim congratulates themselves.
- **Export everything** as CSV another package can read. Judged by whether an
  accountant could rebuild the books from it, which is why journal lines carry
  their account number and name rather than ids, and why money is in units.
- **A tested restore, not a documented one.** `npm run db:verify-restore` dumps,
  restores into a scratch database, and compares row counts table by table. It
  reports **PASS — 93 tables and 656 rows restored identically** on this
  repository's own database. Everybody has backups; the organisations that lose
  data are the ones whose backups had never been restored.

Two bugs the tests caught, both of which leave no trace in production: `NULL <>
'uuid'` is NULL rather than true, so "sign out everywhere else" silently spared
every session that had no device — exactly the one an attacker would keep; and a
burst of retries could push real failures out of the lockout window and lift the
lock it had just triggered.

### Inventory (Phase 14)

Eight of the ten industry modules were declared and empty. Inventory is the one
that carries five of them: retail, restaurant, manufacturing, e-commerce, and
wholesale all name stock first, and they are **not five features** — a
restaurant's food cost and a wholesaler's warehouse are the same perpetual
inventory with different words on the screen.

The claim: **the inventory subledger equals the Inventory account in the ledger,
always.**

- **A lot carries its value, not a rate to recompute from.** The first
  implementation derived value as `quantity × unit cost` and passed 29 of 31
  tests. It was out by 25 cents on one ordinary sale, because deriving re-rounds
  on every read against a rate a pooled consumption never used. The lot now
  stores its remaining value; the rate is for reading only. See ADR 0014 for the
  worked example.
- **FIFO and weighted average**, one setting for the company. Mixing them makes
  cost of sales unexplainable — asked "how is this valued", nobody wants the
  answer "it depends which line".
- **Lots are kept under both methods**, so changing method is a setting rather
  than a migration, and so a cost can be explained to an auditor with four
  receipts rather than an average.
- **A purchase order posts nothing.** It is a commitment, not a transaction.
  What it buys is the first leg of the three-way match: ordered 100, received
  96, billed for 100 says a supplier is charging for four units that never
  arrived.
- **Receiving posts to Goods Received Not Invoiced**, not Accounts Payable.
  Systems that wait for the bill leave stock physically on the shelf and absent
  from the books for weeks — misstating inventory, cost of sales, and margin at
  the same time.
- **The cost posts inside the invoice's own transaction**, so a sale can never
  exist with its cost of sales missing.
- **Selling stock you do not have is recorded, not refused**, and the shortfall
  is reported. A shop that sells the last one twice on a busy Saturday has a
  real problem, and refusing to record it teaches people to record a lie.
- **A return goes back at the cost it left at.** Restoring at today's average
  invents value from nothing.
- **Shrinkage is its own account.** Stock sold and stock stolen are different
  facts, and a margin quietly containing theft explains nothing. Every count
  needs a reason.

### Time and billing (Phase 15)

Professional services is the largest small-business segment, and `time_billing`
was declared in Phase 0 and left empty. Unlike inventory it needs no new
accounting concepts — a timesheet becomes an invoice line, and the invoice
already exists.

The claim: **an hour is billed once, or not at all.** The second half is the
expensive one. Double-billing is a client dispute; *losing* an hour is revenue
that was earned, recorded, and never charged for — and nobody notices, because
nothing looks wrong on any report.

- **The precondition is in the WHERE.** The update that marks time billed
  carries `AND status = 'approved' AND invoice_id IS NULL`, inside the invoice's
  own transaction. Two partners billing the same engagement at once both build
  an invoice; only one update matches, and the loser's invoice rolls back
  entire. A test runs them concurrently and asserts one invoice exists.
- **Recording time posts nothing** — the same decision as a purchase order
  posting nothing. Unbilled time is not revenue, and booking profit on your own
  labour before anybody is billed is what flatters a firm into insolvency. The
  pack's `1150 Unbilled Work in Progress` is there for firms whose policy is to
  accrue it; the report reads the timesheet instead.
- **Money comes from minutes, never displayed hours.** Ten minutes at $90 is
  $15.00; via a rounded 0.167 hours it is $15.03, and forty of those is a
  client asking why the lines do not add to the total.
- **Rate resolution says where it looked** — entry, person-on-engagement,
  engagement, person, list price — and returns the source, so "why $150 and not
  $175" is answerable in the interface. Zero is a rate; `null` is the absence of
  one.
- **Grouping is presentation.** One line per person, per day, per kind of work,
  or one for the lot — all four foot to the same total, because amounts are
  summed from the entries rather than recomputed.
- **A retainer is a liability**, not revenue on arrival — the commonest error in
  services bookkeeping, and it flatters a quarter by the work still owed.
  Drawing it down is capped at what is left *and* at what the invoice owes.
- **Written-off time is kept, with a reason**, and stays in the utilization
  denominator — so a firm cannot improve its numbers by giving work away.

### Dimensions and fixed assets (Phase 16)

The last two things spec §13 asked for: user-defined accounting dimensions —
§13 says "classes/departments/locations/projects/jobs **or equivalent**", and
projects were only ever half of that — and a fixed asset register with
depreciation.

They share a claim: **the parts sum to the whole.** Both are derived views of
the same ledger, and a view that disagrees with the ledger is a second set of
books printed on the same paper.

- **A dimension is a row, not a column.** A restaurant with three sites, an
  agency with two departments, a nonprofit with restricted funds — a location
  does not start, finish, or get billed, so it is not a project. Adding
  "Region" is a thing an owner does on a Tuesday, not a migration.
- **`unique(journal_line_id, dimension_id)` is the whole model.** One value per
  dimension per line, so a line cannot be counted in two columns and the report
  cannot sum to more than the account it came from. `totalsAgree` is computed
  on every run and the screen says so if it is ever false.
- **Unassigned is a column, not an omission.** Filtering to tagged lines gives
  a page that is internally consistent, adds up to less than the business
  earned, and hides by how much. Coverage is measured on *gross* movement,
  because $50,000 of untagged revenue against $50,000 of untagged cost nets to
  zero and "100% covered" would be a lie about $100,000.
- **Reclassifying moves no money**, so it is allowed inside a closed period —
  and audited anyway, because the ledger has no record of who moved a quarter
  of the year's costs to another site.
- **There is no balance sheet by dimension.** Assets can be tagged; equity
  cannot. Every product that ships one balances it with a plug the business
  never transacted.
- **A depreciation schedule sums exactly to the depreciable base.** 756
  schedules across every method, convention, life and awkward cost are asserted
  to the cent, because an asset that never quite finishes depreciating survives
  ten years of closes and then has to be explained.
- **Registering an asset posts nothing** — the money was already spent and
  coded when the bill was entered, and posting it again puts the truck on the
  balance sheet twice. `reconcileFixedAssets` proves cost against Fixed Assets
  and depreciation against Accumulated Depreciation, which is the only report
  that finds an asset nobody coded or a purchase nobody registered.
- **`unique(fixed_asset_id, period_end)` makes running depreciation twice
  safe** — a person clicks, a job fires an hour later — and arrears are charged
  to *their own months*, because that is when the truck was wearing out.
- **Disposal charges the arrears first**, so gain or loss comes from the ledger
  rather than from the schedule, and lands in Other income or Other expense
  rather than flattering the trading margin.

### Bringing your books in (Phase 17)

Every phase before this one built something for a company that starts from
zero. No such company exists among the ones this is for. A business that adopts
a new accounting system in August has seven months behind it, a customer list,
and a set of balances that have to still be true afterwards — and until now the
only company that could use Accountrix Plus was one that had never traded.

There is also an account that has been waiting the whole time. `3900 Opening
Balance Equity` has been in the standard chart since the first commit,
described as *"Offsets opening balances during setup. Should clear to zero."*
Nothing had ever written to it. That description turns out to be the
specification.

- **Nothing is imported until all of it can be.** Every importer builds a plan
  first, and one error anywhere stops the whole file. The alternative leaves a
  company with 137 of 400 customers and no way to tell which 137 — and on a
  trial balance, with an unbalanced ledger caused by the tool they would have
  to use to find it.
- **Opening Balance Equity clears to zero, or names the gap.** That is the
  whole migration in one number, and its value is in the failure case: a
  non-zero balance is *exactly* the amount by which the customer detail
  disagrees with the receivables the old system reported.
- **The trial balance does not post receivables or payables.** It reads them
  and keeps them to check against; the open documents supply the balances. A
  receivable is not a number — it is a list of people who owe you, and the
  total without the list gives an aging report that agrees with nothing.
  Posting both was the first version's arithmetic, and it doubled the
  receivable.
- **An open invoice recognises no revenue.** The sale happened in the old
  system and was reported there.
- **Refuse rather than guess.** `1.234,56` is rejected because it means two
  different amounts on two continents; `1,23` because reading the comma as a
  separator turns $1.23 into $123.00; `02/31/2026` because it is not a day. An
  ambiguous numeric date is read by a setting the wizard asks for, and the
  preview says how many rows depended on it.
- **The delimiter is found by consistency, not frequency.** A tab-separated
  file of addresses has more commas than tabs.
- **An import can be undone**, by name rather than by timestamp — and it
  refuses when what it created has since been used, rather than cascading and
  taking the newer work with it. Journal entries are voided, never deleted.

### Accountant practice mode (Phase 18)

§14's last deferred sentence, and the one the whole tenancy design was built to
survive. Since Phase 1 every service has taken an explicit `ActorContext` and
there has been no ambient "current company" anywhere — a decision that cost
something on every function signature for eighteen phases, made for a case that
did not exist yet. An accountant who legitimately belongs to twenty companies
at once is that case, and this is the first time the design is tested rather
than asserted.

- **Access is granted, never claimed.** Whichever side asks, the *other* side
  has to agree — one comparison, no flag that turns it off. "The firm adds the
  client and the client is notified" is how a support tool ends up able to read
  every customer's ledger, and more mundanely how one mistyped email address
  hands a stranger the books.
- **Ending it is asymmetric on purpose.** Starting an engagement needs both
  signatures; ending one needs either. A client must never need their
  accountant's permission to take their books back — and revocation takes
  effect on the accountant's *next click*, not when their session expires.
- **An engagement grants memberships and steps out of the way.** Everything
  downstream — permissions, audit, session resolution, `scoped()` — needed no
  changes. Deriving access at read time would give two answers to "can this
  person see these books", and two answers can disagree.
- **The client's role choice is a ceiling.** A firm that would like its people
  to be owners still arrives as whatever the client agreed to.
- **Leaving the firm ends access everywhere at once** — one revocation, not
  forty. Somebody who leaves on Friday should not read a client's ledger on
  Monday because one company got missed.
- **Switching mints a new context, never a wider one.** A context carrying a
  *set* of company ids would mean re-reading several hundred call sites to
  decide whether each meant one or many, and one missed leaks a client's ledger
  to another client's accountant.
- **Exactly one query crosses tenants**, and it is built not to be pointed
  anywhere else: the company set is derived inside the function from the
  caller's own memberships, practice membership is a gate checked before
  anything is read, each count names a company already proven reachable, and it
  returns counts rather than rows.
- **The audit log names the firm** — "Dana Chen (Hartley & Co)" — and the
  switch is recorded in the company being *entered*, because "who opened our
  books, and when" is the client's question.

### Transactional mail, password reset and invitations (Phase 19)

Two things deferred with a stated reason, and both reasons had expired. Phase
13 left password reset out because *"a half-built reset flow is a bypass for
everything above it"*; Phase 18 shipped a screen that asked an owner to type a
colleague's first password and then tell them what it was — spec §14's "never
share owner credentials" in a subtler form.

- **A password reset is not marketing, and the type says so.** Phase 5's
  `OutboundMessage` *requires* an unsubscribe URL; a `TransactionalMessage` has
  no field to put one in. You cannot attach an unsubscribe link to a password
  reset — which would offer to stop sending somebody the only mail that can let
  them in — and nothing marketing-shaped can be pushed down this pipe to dodge
  an unsubscribe. Somebody who unsubscribed from the newsletter in March still
  gets back into their own books in August, and a test asserts exactly that.
- **An invitation proves an address; it never carries a password.** No user and
  no membership exist until the invitee clicks and chooses one, so a mistyped
  address hands a stranger *nothing* rather than a working login. Somebody who
  already has an account is not asked for a password at all — that page was
  reached from an email, and asking there teaches the habit that gets people
  phished.
- **One token mechanism, three jobs**, because reset, company invitation and
  practice invitation are the same sentence: *whoever can read this address may
  do this one thing, once, soon.* Hashed at rest, spent by a
  `WHERE redeemed_at IS NULL` claim inside the transaction that does the work,
  and shorter-lived for a reset (an hour) than an invitation (a week).
- **The shape of a token is a database constraint.** A company invitation must
  name a company, a practice invitation a practice, a reset a user — and the
  constraint caught two of this phase's own tests.
- **The reset form is not an oracle.** Identical response whether or not the
  address exists; even a rate-limit refusal is swallowed, because "you have
  asked five times already" tells an attacker their guess was real.
- **A reset is not an MFA bypass.** Enrolment is untouched, and the letter says
  so plainly rather than leaving somebody to wonder. Completing one ends *every*
  session, because the usual reason to reset is thinking somebody else has it.
- **A practice invitee arrives able to work**, through the same helper the
  added-by-hand route uses — two implementations of "which clients does a new
  colleague reach" is how the two routes come to disagree, and the disagreement
  would be somebody quietly retaining access.
- **The mock provider prints to the terminal in development**, so `/forgot`
  works with no mail server. Without it a developer who clicks it on their own
  dev server is genuinely locked out: the token is hashed the moment it is
  stored, and nothing anywhere can show them the link.

### Attachments and accountant notes (Phase 20)

§13's list ends *"period close/lock controls, audit trail, accountant notes,
attachments, exports"*. Four of those five had existed since Phase 12. The two
that had not turn out to be one problem — a thing that hangs off *any* record
and belongs to whoever may read that record — and until now exactly one kind of
record could carry evidence, as a `jsonb` array written for the mobile app.

- **One file, stored once.** The storage key is the SHA-256 of the content, so
  a supplier invoice attached to the bill, the payment and the month's journal
  entry is one blob, one document, three links. Re-sending the same emailed
  receipt returns the document that already exists rather than filling the
  evidence list with copies of one thing.
- **Removing one reference never breaks another.** Two companies holding
  identical bytes share them; one deleting its copy leaves the other's
  downloading. The delete path consults the `documents` rows rather than the
  cached reference count — a count that has drifted upwards leaks storage for
  ever and one that has drifted downwards destroys somebody's evidence, and
  rows cannot drift. A foreign key sits underneath as a third line of defence,
  and it is what caught the first version of this during its own test.
- **Bytes are freed after the transaction commits, never inside it.** No object
  store can join a Postgres transaction, so a rollback would restore the row and
  leave the file gone. The other order leaves an orphaned blob a sweep collects.
  Where two orders are not symmetric, take the recoverable one.
- **A document is reachable only through a record you may read.** The store is
  content-addressed and therefore *not* partitioned by tenant, so every
  guarantee rests on one lookup — and `readDocument` is the only function
  anywhere that reads the store. Knowing another company's document id gets a
  404.
- **What may carry evidence is a registry, not a switch in each caller.** Eleven
  kinds of record, each naming the table that proves it exists and the two
  permissions that guard it. A read-only auditor sees the receipt and cannot
  remove it; a bookkeeper attaches one to a transaction and is refused at the
  payroll run, where the evidence is what individual people are paid.
- **A note is not an audit event.** The audit log records what the software did
  and answers no question beginning with *why*. A note records what a person
  concluded, is never edited and never deleted, and carries the practice name
  when an accountant writes it.
- **A question is a different thing from a remark.** A question goes on a
  company-wide work list until somebody answers it; answering adds a note beside
  it rather than overwriting what was asked. A CHECK constraint refuses to
  resolve a remark, so nothing can quietly hide a statement from a list it was
  never on.
- **The mobile receipt path became a front, not a fork.** It keeps the part that
  was about phones — a 2 MB ceiling against the desk's 10 MB, because one
  protects a data allowance and the other protects the server — and its replay
  safety moved from a read-then-write into a unique index, which is stronger
  than what it replaced.

### Server-side PDF and immutable snapshots (Phase 21)

§18's last unbuilt infrastructure line: *"server-side PDF generation and immutable
proposal-version snapshots."* ADR 0004 deferred it with a real choice — a headless browser in the
deployment, or a layout library re-implementing pagination — and shipped a print stylesheet
instead. Two holes were left: a client's browser cannot produce the *server's* copy, so nothing
knew what anybody received; and `proposal_versions` snapshotted the data while the brand kit, the
layout and the clause text stayed live, so restyling proposals in June silently restyled every
proposal ever sent.

- **The same input produces the same bytes.** The writer is a few hundred lines of PDF 1.4 with no
  clock and no randomness; the creation date is a parameter all the way down. A browser cannot make
  that promise — Chromium stamps its own version and a wall-clock date into every file, so
  upgrading it would rewrite the bytes of every historical document. Determinism is what makes a
  digest usable as evidence, and it is the property neither option in ADR 0004 was judged on.
- **What the client was sent never changes.** The PDF is rendered inside the transaction that
  records the send, so a proposal is never marked sent without the document that was sent. A test
  sends one, then moves the brand kit, the wording and the prices underneath it, and asserts the
  digest is unchanged — and asserts that a *live preview* does move, because otherwise the first
  assertion would be equally true of a renderer that ignored its inputs.
- **The digest is the proof, and Phase 20 supplies it.** Sending the same unchanged proposal twice
  within one second produces byte-identical files, so the content-addressed store hands back the
  same document to both versions: two rows in `proposal_versions`, one row in `documents`, one
  blob. The two phases compose rather than merely coexist.
- **The public link serves the snapshot, never a live render.** A client opening their link a month
  after the price list moved downloads what they were sent.
- **A proposal with no document can still be sent.** The record of what was sent matters more than
  the rendering of it, so the version simply carries no PDF and the download is not offered.
- **Invoices are rendered, not snapshotted.** An invoice is not a negotiating position: if it was
  wrong it is credited and reissued, and the ledger is the authority for what is owed. Snapshotting
  one would create a second answer to "how much does this customer owe".
- **Real typography, not ASCII folding.** The first rendered proposal came out titled
  "Reroofing -- North Wing". WinAnsiEncoding has the actual em dash, curly quotes and ellipsis, so
  they are emitted as bytes with their own width entries. Only characters with no glyph fold, and
  the last resort is `?` — visibly wrong beats invisibly missing.
- **Measure, then place.** Every block reports its height before anything is drawn; a heading keeps
  with what follows it, a long paragraph splits by line rather than jumping a page whole, and
  inter-block spacing is dropped at the top of a page so a document never starts an inch too low.

### Communications and follow-ups (Phase 22)

§16 lists the core data model entity by entity, and by Phase 21 every one of them existed except
two. `Communication` did not exist at all, so §6's requirement that an opportunity store
"communications, files, and activity history" was met on two counts of three — files arrived in
Phase 20, activity history in Phase 3, and what anybody actually *said* was nowhere. `Task` existed
as half a table: written only by marketing engagement, read only by the marketing overview,
reachable from one screen nobody in sales opens.

- **Every letter the system sends is recorded against the person it went to.** Phase 19 logs sends
  in `transactional_messages`, which answers "did the mail go?" and knows nothing about the CRM.
  When an address belongs to a known contact, the send now lands on that contact's timeline beside
  the hand-logged calls. Recording it can never fail the sending, and catching the error is only
  half of that: Postgres aborts a whole transaction on any failed statement, so a swallowed
  exception inside the caller's would leave it holding a dead connection. The record runs in a
  savepoint, and a test writes a communication after a deliberately-failed one, inside a single
  transaction, to prove the caller survives.
- **Campaign sends are deliberately excluded.** `campaign_recipients` already records every
  marketing send per contact with opens and clicks. Mirroring them in would put a row on every
  recipient's timeline for every newsletter, and a log where the quarterly mailshot outnumbers the
  three sentences somebody typed after a difficult call is a log people stop reading.
- **An activity is not a communication.** `opportunity_activities` records what the software did and
  nobody writes it; a communication records what a person said to somebody outside the company. They
  are stored separately so the useful half does not scroll out of sight behind forty automatic stage
  changes, and shown together — separate storage, one view.
- **Real foreign keys, not the Phase 20 registry.** A communication is always with a party: an
  organization, one of its people, optionally the deal being discussed. Three columns the database
  can constrain, plus a CHECK requiring at least one — the polymorphic subject registry would have
  made "log a phone call against a bank transaction" expressible.
- **The client is derived from the person, and from the deal.** Somebody logging a call against the
  contact they spoke to does not also name that contact's employer, and a follow-up raised on an
  opportunity belongs to that opportunity's client. The read side matches from the other end:
  exchanges filed against the client, its contacts *and* its deals all appear on the client's
  timeline. Without the derivation a promise made on a deal appears on no client's timeline and
  carries no name on the board — which is how a client history quietly acquires holes.
- **An internal note is not contact.** `lastContactedAt` excludes `internal`, because "must remember
  to call these people" is worth writing down and is not evidence of having called them.
- **A task is never silently lost.** It survives without an owner — `myWork` shows unclaimed work by
  default, since a task nobody owns is everybody's problem and hiding it until somebody claims it is
  how it stops being anybody's. It surfaces when it is late. And closing it is a claim, not an
  update: `WHERE status = 'open' … RETURNING`, the same shape as Phase 15's billed-once clause, so
  two people closing the same follow-up produce one completion and one honest refusal.
- **A finished task carries a finish time, enforced.** `CHECK ((status = 'open') = (completed_at IS
  NULL))`. Cancelling stamps the time too, and keeps its reason — a task that simply vanishes
  teaches nobody anything. The migration backfills existing rows into shape before adding the
  constraint.
- **Closing is undoable from the screen that closes.** The board lists what was closed this week,
  done and dropped together, each with a Reopen beside it. Without that list one mis-click is
  permanent, and "a task is never silently lost" would have a hole in it exactly the size of the
  Done button.
- **Overdue is measured against a date, not the clock.** `openWork` and `workSummary` take `asOf`,
  the same rule Phase 21 applied to the PDF's timestamp: a report that reads the clock cannot be run
  for last Tuesday and cannot be asserted on.
- **One work list, two screens.** `/crm/work` is the shared board — mine, unclaimed, overdue, done
  this week — and every client row on `/crm/organizations` expands into its own timeline with the
  two things somebody does next: log what was said, raise what was promised.

### Property management (Phase 23)

Spec §5's Real Estate / Property row asks for "properties, tenants, rents, CAM/expenses,
property-level reporting". The `properties` module was declared in Phase 0, switched on by that
pack, and did nothing — and so did the four accounts the pack has been installing ever since:
`2580 Tenant Security Deposits`, `4300 Rental Income`, `4310 CAM Reimbursements`,
`4320 Late Fee Income`. It is the fifth of ten industry modules to become real.

- **A security deposit is somebody else's money.** It credits a liability on the way in and never
  reaches the profit and loss; refunding it debits that liability and is **not an expense**, because
  money that was never income cannot become a cost on the way out. Booking a refund to an expense
  account is how property books show a loss in every month somebody moves out.
- **Keeping it is the only moment it becomes income — and even then it depends.** Applied against an
  unpaid invoice it settles the receivable and recognises nothing, because the rent was already
  recognised when the invoice was raised; recognising it again would count the same month twice.
  Applied against damage that nothing has billed, it is income at that moment. Both are asserted
  against the profit and loss rather than against journal lines.
- **A settled deposit is not a payment.** A receipt with no financial account means *cash in hand,
  not yet banked* — it appears on Phase 12's undeposited funds list and the bank deposit screen
  offers to pay it in. A deposit being kept is money banked months ago moving out of a liability, so
  it settles the invoice directly, and a test asserts the undeposited list stays empty.
- **The held balance is derived, never stored.** `Σ received − Σ refunded − Σ applied`, from the
  movement rows. Phase 20's cached `reference_count` taught the lesson; here the stakes are higher
  than storage, because a drifted balance is a landlord refunding money they no longer hold.
- **The register reconciles to the account.** `Σ movements === the 2580 balance`, the same shape as
  Phase 16's fixed asset reconciliation, and shown on the screen rather than buried in a report.
- **Rent is billed once per lease per period.** `unique(lease_id, period_start)`, and the charge row
  is inserted *before* the invoice so a losing run rolls back having raised nothing. Two runs fired
  at the same instant produce one invoice between them — asserted, not assumed. One transaction per
  lease, so a block of forty flats where the thirty-ninth has a problem bills thirty-nine.
- **Prorated by day, and never prorated whole.** A tenancy starting on the 15th pays from the 15th
  inclusive; one ending on the 10th pays to the 10th. A whole month never divides, so the common
  case returns exactly the rent on the lease. `Math.round`, not the landlord's favour. The rent day
  is capped at 28 so February never shifts a due date.
- **A property is a dimension, not a report.** `propertyProfitAndLoss` is four lines that call
  Phase 16's dimensional report. A per-property report written inside the module would miss the
  insurance premium somebody coded from the transaction inbox — a test posts a roof repair through
  no part of this module and asserts it lands on the property's column.
- **Occupancy is measured against units.** Four flats and one tenant is 25% let; measuring against
  leases would report 100%, which is why units are a table separate from tenancies. A unit held back
  for refurbishment stays in the denominator.
- **The module installs the accounts it needs.** A contractor who bought the yard next door and
  switched it on has no `4300`. Without this, everything works until the first rent run fails with a
  message about a chart of accounts the application could have fixed itself.

**A gap closed on the way.** `DocumentLineInput` carried job dimensions and not user-defined ones,
so an invoice could not be tagged with a Location or a Property — the README has called that "the
largest gap in Phase 16" ever since, because a company slicing its books by Location saw its costs
and missed its revenue. Invoices and bills now carry `dimensions` through to their journal lines.

### Retention, and the work nobody was doing (Phase 24)

Six phases each finished a feature, noticed the same missing thing, and wrote it in this README
instead of building it: `login_attempts` never pruned (Phase 13), `action_tokens` pruned on demand
only (Phase 19), `sweepOrphanedBlobs` unscheduled (Phase 20), nothing chasing an overdue follow-up
(Phase 22), nothing scheduling the rent run (Phase 23), and nothing telling anybody about a dead job
(Phase 10). Each was correctly deferred. What none could do alone was decide *how long anything is
kept* — one decision about the whole application, which taken six times would have had six answers.

- **The policy is data, in one place.** Nine tables, how many days each, whether strangers can write
  to it, and why — read by the sweeps and shown on the operations page. *"What do you hold about me,
  and for how long"* is the question a data-protection request actually asks, and it now has an
  answer that is not "read every module".
- **The allowlist is the safety property.** Every policy names exactly one table, and that list is
  the entire set of tables anything in the module may delete from. `NEVER_SWEPT` writes down the
  other half — the ledger, the audit log, the documents, the notes, dead jobs — and a test asserts
  the two never intersect, so a policy for `journal_lines` fails the suite rather than the year-end.
  A second test posts an entry dated 2019, runs every sweep as at 2030, and asserts the lines are
  still there.
- **Counting is a separate query from deleting.** The page shows what each policy holds and what it
  would remove, before it removes it — a number nobody can check beforehand is a number nobody can
  dispute afterwards.
- **Three policies are narrower than their table.** `domain_events` sweeps only what was actually
  relayed, because an outbox that deletes work in progress is not an outbox. `lead_submissions`
  sweeps only what never became an opportunity, which is what lets the window be six months.
  `action_tokens` measures from expiry, not issue — a week-long invitation issued 29 days ago has
  not been expired for 30.
- **Dead jobs are never swept**, alongside the ledger, for Phase 10's reason: a failure nobody looked
  at is not evidence to be tidied away.
- **Scheduling arrived last because it is the easy part.** Four handlers, and not one needed the
  feature it drives to change — `runRent` was already idempotent, `completeTask` was already a claim,
  the sweeps were already ranged deletes. A scheduled job that can run twice is safe *only* because
  the precondition lives in the database, and that was built first.
- **One message per person, not one per task.** Somebody with eleven late follow-ups gets one
  notification saying eleven, with a `tag` that replaces yesterday's rather than stacking. Unclaimed
  overdue work is told separately to whoever could claim it, because "three of yours are late" and
  "two are late and unclaimed" are different sentences.
- **The digest is silent on a quiet day.** One message, with a count, and nothing at all when the
  count is zero — silence has to mean something, or the digest becomes a daily "everything is fine"
  nobody reads and therefore cannot notice the day it says otherwise. The digest and the page run the
  same query, because a notification saying two beside a page showing three costs you the page.
- **Bounced mail is finally shown to somebody.** `failedDeliveries` has existed since Phase 19 with
  no screen calling it, so an invitation to a mistyped address failed silently and the person waiting
  simply never heard.

### Who at the firm is on which client (Phase 25)

Phase 18 built practice mode and named its own largest hole in this README: *a practice member
reaches every client of the firm*. That was the right trade then — Phase 18's claim was about the
boundary between two organisations, and who inside the firm does the work is a different question.
It is also the question every real firm has. One client is a director's brother-in-law, another is
in a dispute with a member of staff, another has an independence policy; a ten-person firm with
forty clients does not put ten people on forty sets of books. Spec §14 asks for "granular
overrides", and this is them.

- **A staffing mode per client, not per firm.** `whole_firm` or `assigned_only`, on the engagement.
  A firm-wide switch would have been one column less and the wrong shape: the firm that needs this
  needs it for *one* client, and forcing the strict mode on all forty means assigning forty clients
  by hand on the day of the switch, or never switching. The default is `whole_firm`, so every
  engagement built before this phase means what it always meant.
- **One place decides who should be on the books.** Four things change the answer — accepting an
  engagement, somebody joining the firm, an assignment made or withdrawn, the mode changed — and all
  four go through `entitledStaff` and then reconcile. Four call sites answering "who can open these
  books" separately is four chances to answer it differently, and the one that counts is whichever
  ran last, which is a race rather than a rule. `grantAtLiveEngagements` was rewritten to reconcile,
  which is what makes joining a firm stop meaning "reach every client" without the invitation flow
  knowing anything changed.
- **Roles narrow, and only narrow.** An assignment may carry a role that narrows what somebody holds
  at that client; the engagement's cap is applied last and applied always. An `owner` assigned to an
  `accountant` engagement arrives as an accountant, because that is what the client agreed to.
- **The preview comes before the button.** "This tightens access" and "this locks four people out of
  a client mid-close" are the same click, and the difference is a number. It is rendered beside the
  button rather than in the result — a permissions change nobody could see coming is one somebody
  reverses in a panic.
- **Switching refuses to leave a live client with nobody.** A firm that locks itself out of books it
  accepted responsibility for has not tightened its security, it has created an incident whose only
  exit is a client re-inviting the firm they already engaged. The refusal carries the fix: assign
  somebody first. A *pending* engagement may be staffed to nobody, because deciding who will be on a
  client before the client says yes is the order a firm actually works in.
- **An assignment under `whole_firm` grants nothing, and is kept anyway.** That is what lets a firm
  assemble the list over a week and tighten afterwards, which is the only sequence that does not
  produce an outage.
- **The client is told the shape, not the roster.** `/settings/access` distinguishes "everybody at
  the firm" from "assigned to you specifically". It does not show the firm's assignment list: the
  client chose a firm and capped its role, and a client with a veto over which junior is on their
  file has hired the junior rather than the firm. What they are entitled to know is that "any of
  Hartley & Co's ten people can read this" and "these two can" are different answers — and a list of
  names alone cannot tell them apart.
- **Revocation lands on the next click, and nothing new was needed for it.** Taking somebody off
  deletes their membership in the same transaction, and `resolveSession` has re-read the membership
  on every request since Phase 13. No session invalidation, no token version, no cache to bust.

### Money given for a purpose (Phase 26)

`funds` has been a declared industry module since Phase 0, switched on by the nonprofit pack, doing
nothing — and so have the nine accounts that pack installs. This is the fifth of §5's fourteen rows
to get a real module, and the one least like the others: a job, a stock item and a tenancy are
things a business *does*, while a restriction is a statement about what it is **allowed to do with
money it already holds**. The constraint belongs to somebody who is not the user.

- **A fund is a dimension value, and there is no per-fund profit and loss.** The same trick as a
  property, and the absence is the design: a bill coded to the roof appeal by a bookkeeper who has
  never opened the funds screen is spending against the roof appeal, and earns its release. A
  module that only counted expenditure booked through its own API would under-release exactly the
  charities big enough to employ a bookkeeper.
- **A fund is not a bank account.** Restricted money sits in the same current account as everything
  else; the restriction is a promise about what the charity may do, not a statement about where the
  money is. Making a fund an account would force an internal transfer on every supplier payment and
  would report as solvent a charity that had spent its endowment.
- **Release the lesser of what was given and what was spent.** One comparison, and the whole phase.
  Releasing the spend regardless of the balance drives a fund negative, which on a balance sheet
  reads as a donor owing the charity money. Releasing the balance regardless of the spend reports a
  condition met that has not been met.
- **A release changes no total.** The debit and the credit are both income accounts and they sum to
  zero, so the year's income is identical either side of a run — what changes is which column it
  sits in. Two accounts rather than one signed number, because a reader has to be able to see that
  £400 left the restricted column *because* £400 arrived in the unrestricted one.
- **A promise is revenue on the day it is made.** An unconditional pledge is a receivable: a charity
  told in December it will get £50,000 in March has the revenue in December. Waiting for the cheque
  would report the year the appeal succeeded as the worse year. The consequence is the part that is
  easy to get wrong — **receiving a pledge posts no revenue at all**, and an entry there that
  touched income would double-count in a way that reconciles perfectly: the bank agrees, the fund
  agrees, and only the income for the year is wrong by the size of the appeal.
- **An endowment's principal is never released.** A donor who gave money to be held forever did not
  give money to be spent, and a charity that released principal as it spent would report a growing
  unrestricted balance made entirely of money it may not touch.
- **The restriction cannot be edited.** `updateFund` does not take one, and there is no other way to
  change it. A fund whose class could be edited would let a charity move money between the two
  columns of its balance sheet without posting an entry anybody could see.
- **An overspend is recorded, not hidden and not blocked.** A charity really can spend more on a
  programme than was given for it. The run releases what the fund can cover and keeps the excess on
  the row — refusing to post would leave the books wrong in order to protest about a decision
  already taken, and recomputing the figure later would quietly forgive an overspend a subsequent
  donation happened to cover.
- **The check is for money the page cannot see.** Net assets reports contribution revenue carrying
  *no fund at all* — a genuinely independent comparison, unlike totalling the funds and comparing
  them to a total derived from the funds, which reconciles perfectly and proves nothing.

### Cost moving through a factory (Phase 27)

`manufacturing` has been a declared module since Phase 0, switched on by the manufacturing pack,
doing nothing — and so have the seven accounts that pack installs. Phase 14 built one perpetual
inventory for five industry packs and left a seam in it with a comment: *"A business that keeps raw
materials and finished goods on separate balance sheet lines sets them on the items."* Thirteen
phases later, this is that business.

- **There is no second costing engine, and no second inventory.** A raw material and a finished good
  are ordinary inventoried items. Issuing material is Phase 14's `consumeStock` debiting WIP instead
  of COGS; finishing a run is `receiveStock` crediting WIP instead of a supplier. A run's cost is
  whatever the lots it consumed were worth, by FIFO or weighted average, exactly as a sale's is. The
  alternative — a standard cost on the BOM with variances against actual — is a second source of
  truth about what a thing cost, and a factory is not the place to start having those.
- **The seam was widened, not duplicated.** `consumeStockForSale` became a thin caller of a general
  `consumeStock` that names its debit account, mirroring `receiveStock`. Phase 14's 31 tests pass
  unchanged, which is the point: the refactor is asserted behaviour-preserving by tests written
  before it existed.
- **A bill of materials is written per batch, not per unit.** A component used a third of a time per
  unit accumulates a third of a thousandth of error on every unit of a run; scaling once from batch
  to run does not. Expected wastage sits on the component in basis points, because it is a property
  of the material rather than of the day.
- **A BOM says how much, never how much it cost.** The variance is on quantity. A run that cost more
  did so because it used more material or because material had gone up, and one number covering both
  tells a production manager nothing they can act on.
- **Scrap raises the unit cost.** A run that consumed the material for 100 and yielded 95 cost the
  same money and made less, so the 95 carry all of it. Yield is measured against the plan and scrap
  against total output — a run stopped early has a terrible yield and perfect scrap, and one figure
  could not tell those apart.
- **Completing a run clears WIP to exactly zero**, enforced by the service, by a check constraint,
  and by a test that reads account 1450 afterwards. Where the cost does not divide — £100 over three
  units — the remainder is posted *and the lot corrected*, in one transaction. Fixing only the
  ledger would leave the finished-goods lot carrying the extended figure, so the subledger and the
  accounts would disagree by pennies for ever.
- **Absorbing labour credits the expense.** That reads oddly and is right: the cost was incurred when
  the wages were paid, and this is the moment it stops being the period's and becomes part of what is
  on a shelf. What is left in 5070 at a period end is labour that was never absorbed — idle time.
- **A cancelled run is written off to overhead, not back to the store.** The material was cut and
  mixed; crediting raw materials would put back stock nobody can pick.

**Two defects this phase found, both in code with passing tests.** A left join multiplied the
finished-goods shelf by the number of runs that had ever made the item. And a raw `OR` inside
drizzle's `and()` — unparenthesised, against SQL's AND-binds-tighter rule — collapsed an account
filter into `(everything else) OR line IS NULL`, so a three-line report returned the entire chart of
accounts. The test asserting the three figures passed, because the three were right and eighty more
came with them; **it was caught in a browser.** Both now have tests that pin the shape and not just
the numbers.

**And one improvement to Phase 14 it forced.** `reconcileInventory` compared all lots against
account 1400 alone. Correct while every item used the default — and this factory is the first
company where none does. It reported a difference the size of the whole subledger on books that were
perfectly correct, which is worse than not checking. It now sums every account an inventoried item
actually names.

### A day of trading, arriving from somebody else's system (Phase 28)

`pos_import` has been a declared module since Phase 0, switched on by the restaurant and e-commerce
packs, doing nothing. It is the first module to serve **two** of §5's fourteen rows, and that is the
whole argument for it: a restaurant's Z-report and a marketplace's settlement file look nothing
alike — one has tips and a cash drawer, the other has commission and returns — but they are the same
fact, *a day of trading happened inside somebody else's system and has to become double-entry here.*

- **A day is one journal entry, not four hundred.** A café serving four hundred covers produces four
  hundred sales and one useful accounting fact. Importing the four hundred gives a ledger nobody can
  read and promises the detail is trustworthy, which — a POS export not being a system of record —
  it is not. The categories and tenders are stored as evidence of what the source said; they are not
  postings.
- **Gross, not net.** The clearing account is debited at the *net* deposit and the fee is debited
  separately, so the credit side still carries the full gross. Booking the deposit understates the
  sales and hides the cost of selling in one move, and it is nearly impossible to detect afterwards
  because the books still balance. Fees are recorded per tender, so card at 1.6% and a delivery
  platform at 15% can be told apart.
- **Tips are somebody else's money.** Credited to 2310 and touching no revenue account, so they
  appear on no profit and loss — asserted by running the P&L and checking the total is the sales
  figure and not the sales figure plus the tips. ADR 0023's rule, in a different industry.
- **The till is counted, and the difference is named.** Cash is banked at what was *counted*, and the
  gap goes to 6870 Cash Over and Short. A summary that quietly adjusts cash to match the register
  balances perfectly and hides theft. "Nobody counted" is stored as null and is not the same as
  counting and finding it exact.
- **A day imported twice is imported once.** `unique(company_id, business_date, source)`, claimed
  before anything is posted. A second call returns `created: false` with the row that is there
  instead of raising — a nightly importer retrying is not an error, and an exception there produces
  a dead job and eventually somebody who turns the alerting off.
- **When the source contradicts itself, the difference is named rather than refused.** The first
  implementation rejected a day whose tenders did not equal its sales, reasoning that a plug is a lie
  that balances. That was wrong, and the test written to describe the wanted behaviour is what
  surfaced it: an entry has to balance, so the choice is never *plug or don't* but **which account
  absorbs it** — and refusing is the worst option, because what happens next is somebody keys the day
  in by hand and the discrepancy is never seen again. It goes to 1220 POS Import Suspense, on the
  row and on the screen. That left the balance assertion doing something real: it is now a check on
  our own arithmetic rather than on anybody's data.
- **The tips reconciliation compares two different things.** What the days say was collected, against
  what 2310 holds after payroll has drawn on it. Money leaves that account by a door this module does
  not control — the seed and the test both pay staff with an ordinary journal entry, deliberately.

### A diary that owes people money (Phase 29)

`appointments` has been a declared module since Phase 0, switched on by the healthcare and
personal-care packs, doing nothing. Like Phase 28 it serves two of §5's rows, because a dentist and
a hair salon do the same thing: keep a diary, deliver a service out of it, and owe a share of what
it earned to the person who did the work. Three things here are not scheduling, and they are why
this is a module rather than a calendar widget.

- **The database refuses a double-booking, because a check cannot.** Bookings at 10:00 and 10:30
  collide on no *column* — they collide on an **interval**, and only Postgres knows that at the
  moment of insert. An `EXCLUDE USING gist` constraint over `(practitioner_id, tstzrange(starts_at,
  ends_at))` does it, hand-written into the migration because drizzle-kit cannot generate one. A
  read-then-write check is correct right up until the receptionist and the online form act in the
  same second. Two details carry weight: the constraint's `WHERE` clause frees a cancelled slot, or
  calling off Tuesday blocks that hour for ever; and `tstzrange` is half-open, so a back-to-back
  diary is legal.
- **A booking posts nothing at all.** Revenue happens when the service is delivered. If booking
  posted, every cancellation would need a reversal and a practice's revenue would be whatever its
  diary happened to hold. The forward book is reported and named separately from what was earned, so
  nobody adds the two together.
- **The share is a cost, never netted off the revenue.** The salon earned the whole £65 and owes
  £29.25 of it to the person who did the work. Netting to £35.75 of revenue would understate both the
  turnover and the cost of producing it, and hide the payout from anybody reading the profit and
  loss — which is exactly the figure an owner is looking for when they ask why a busy month made no
  money. It credits 2320 whether the person is a contractor or an employee: the liability is the same
  fact, and which door the money leaves by is payroll's business.
- **Rates are copied onto the booking, and the split always sums to the price.** A rise in April must
  not restate what March's work was worth. Service and retail carry separate rates, because a stylist
  on 45% of the cut is commonly on 10% of the shampoo. The practitioner's share is computed and the
  business takes *the remainder*, so the two halves add to the whole by construction; the business
  absorbs the half-penny, and `roundingCents` says so.
- **A gift card is money owed, not money earned — and spending it earns nothing extra.** Selling one
  credits 2590 and touches no revenue. Redeeming one settles the receivable. The personal-care pack
  installs `4720 Gift Card Redemptions` and **this module never posts to it**: the revenue was
  already recognised at delivery, so crediting 4720 as well would state £130 of income for one £65
  haircut. Having an account in the pack is not a reason to post to it.
- **A practitioner is not a user.** Most never sign in — a chair renter and a visiting
  physiotherapist earn a share and have no login. Modelling them as users would mean dormant
  accounts somebody could sign into.
- **A no-show is not a cancellation.** A cancellation is a slot given back in time to sell again; a
  no-show is one that was lost. Neither posts, and a no-show *fee* is deliberately not booked here —
  it is a fee, with a different revenue account and different tax treatment, not the service revenue
  for a service nobody received.
- **Two reconciliations, and they are not the same kind.** Payouts against 2320 are *expected* to
  diverge once anybody has been paid — the gap is the answer to "what went out this month". Gift
  cards against 2590 **should** match exactly, because nothing legitimately moves that account
  except selling and spending a card. A test journals straight at 2590 by hand and asserts the
  report catches it.

### The estimate nobody may bill past (Phase 30)

`vehicles` is the **tenth and last** of the modules declared in Phase 0, and it was left until last
on what looked like a good reason: a vehicle is a dimension, and Phase 16 has reported per dimension
since then. That reading was wrong about the spec. §5's automotive row says **customer vehicles**,
and the accounting content is not in the vehicle — it is in the estimate. **A repair shop may not
bill past what the customer authorised**, and in most jurisdictions that is a statute rather than a
policy, which makes this the only module here whose central rule exists because the law says so.

- **The ceiling is enforced at billing, not at quoting.** An advisor has to be able to price the
  extra work *in order to ring up and ask about it*, so lines can be added freely and the refusal
  lands at the one moment it matters. The message names the **additional** amount, because that is
  what the customer is being asked to agree to — asking only up to the ceiling would let the
  tolerance apply again on top of the new authorisation, and a limit that compounds is not a limit.
- **The tolerance applies to what was authorised, never to the quote.** 10% on £400 is a £440
  ceiling and stays £440 however large the quote grows; applying it to the quote would make the
  allowance grow with the overspend. The ceiling rounds *down* — one that rounds up is a ceiling the
  shop set for itself. Zero tolerance is the default and means every penny over needs a fresh yes.
- **An authorisation is a row, not a column.** How much more, down which channel, who said yes, who
  took it, when. A shop challenged over a bill has to be able to say "you approved a further £175 by
  telephone at 14:20 on the 6th, and Marek took the call", and a running total cannot say any of it.
  A mistaken approval is reversed by a negative row, never by editing history.
- **An odometer does not go backwards.** Three verdicts rather than a boolean: *unmoved* is a car
  towed in and collected without being driven — real, common, not an error. *Backwards* is refused;
  the honest explanations are a typo or a replaced instrument cluster and both should have to be
  asserted deliberately, with a reason and an audit event, because the dishonest one is a crime.
- **Parts, labour and sublet are three revenue accounts.** Labour is capacity, parts are a margin on
  somebody else's product, and sublet is neither. `4620 Sublet Revenue` is in no industry pack and is
  installed on first use: a shop that books sublet as labour believes its own bay is more productive
  than it is, and prices accordingly. A part fitted is a genuine sale, so it reuses Phase 14's
  existing `sale` movement kind — only the account it debits differs.
- **A sublet's cost is deliberately not posted.** The machine shop's invoice comes in through
  accounts payable coded to 5180; accruing it at completion too would double-count it the moment
  the real bill arrived. The cost is still recorded on the line, so the margin on sent-out work is
  reportable — usually a disappointing number, and worth knowing.
- **The record follows the car.** `customer_id` is the current keeper and may change; the vehicle and
  its repair orders stay put. A history that reset on sale is worth far less to the next owner and
  to the shop that wants the work.

**The defect this phase found.** Two report totals silently returned zero, with no error. Both were
correlated subqueries in the select projection — and **drizzle omits table qualification in a
single-table query**, so `${repairOrders.id}` rendered as bare `"id"`, which inside the subquery's
own `FROM` resolved to *its* `id`. The correlation became `a.repair_order_id = a.id`: valid SQL,
never true. The same pattern in `marketing/audience.ts` and `evidence/service.ts` has always worked
because both queries join, and a join makes the reference qualified. Worth recording for how it was
nearly mis-diagnosed: the first instinct was to assume the broken form everywhere and confirm it by
running that form in psql — which proves the hypothesis, not the code. **Dumping `.toSQL()` for each
real query is what settled it**, and is the only thing that would have.

### What is owed is owed by somebody (Phase 31)

Three consecutive ADRs listed the same follow-up — *nothing settles a receivable at the counter* —
and it read like a missing feature. It was a defect, and the follow-up list was the wrong place for
it. Phases 29 and 30 each posted `Dr 1100 / Cr revenue` by hand for what a customer owed. Balanced,
tested, and wrong: **Accounts Receivable is a control account**, the ledger's one-line summary of a
subledger made of customers, and both modules posted to the summary without touching the subledger.

Measured on the seeded demo before the fix:

| Company | Balance sheet | Aging report |
| --- | ---: | ---: |
| Ashgrove Motors | $365.00 | $0.00 |
| Fenwick Row Studio | $199.00 | $0.00 |
| Ridgeline Construction | $39,891.94 | $39,891.94 |

Ridgeline agrees because Phase 7 raises real invoices. The other two are each internally consistent
and never mention each other — so a garage owner could read $365 of receivables off the balance
sheet and have **no way to find out who owed it**: no aging, no statement, no dunning, no PDF, and
no way to record the payment when the customer paid at the counter.

- **Service documents raise real invoices.** `completeAppointment` and `completeRepairOrder` call
  Phase 2's `createInvoice` inside their own transaction. Everything that reads invoices works
  immediately, because none of it had to change — the fix is mostly a deletion. This is ADR 0007's
  rule pointed inward: the modules were told not to fork the ledger, and forked the *receivable*
  instead, which is the same mistake one level down.
- **The practitioner's share stays off the client's bill.** It is a cost of delivering what the
  invoice sold, not something the client is being charged for.
- **A walk-in is somebody.** Half a salon's book is people who rang that morning, so an unnamed
  visit bills to a single house account rather than to nobody — which is what a shop does on paper,
  and a counter payment clears it. A repair order still refuses: a garage knows whose car it is.
- **A gift card settles the invoice**, not just the ledger. That surfaced an ordering bug: after
  the fix the first redemption clears the invoice, so a retried click hit "nothing owing" and threw
  where it used to return quietly. The idempotency claim is now checked first — the honest answer to
  doing something twice is "it is already done".
- **`controlAccounts` is the detector**, and it lives with the ledger rather than in any industry
  module, because the property belongs to double-entry bookkeeping. Unlike the tips and payout
  positions, these two **should** agree exactly — nothing legitimately moves a control account
  except a document — so a difference is always a fault, and the report names the parties.

**And one more bug it found.** `createInvoice` accepts an executor so it can run inside a caller's
transaction, and read the customer through `db` regardless. A function handed an executor has to use
it for its **reads** as well as its writes, or it cannot see rows the caller created in the same
transaction. Always wrong, never mattered — until the walk-in fallback created a customer and
invoiced it in one go.

### Change is not a transaction (Phase 32)

Phase 31 closed the counter gap *at the ledger* and said so explicitly. This closes it at the till:
a delivered visit and a billed repair order can each be paid in one press, from the row that shows
what is owed.

The accounting already existed. What was missing was the gesture, and one piece of arithmetic the
accounting has no opinion about. A customer hands over $50 for a $20 bill. The business has $50 in
its hand and $20 of revenue settled — and **the $30 that goes back across the counter is not a
transaction at all.** No account changes, nothing is owed, nothing is earned; it is the same note
travelling back. Software that posts a $50 receipt and a $30 disbursement doubles the day's apparent
cash movement and gives the bank reconciliation two rows to match against a deposit that will only
ever show $20.

- **Non-cash is applied first**, because only cash can give change. An $80 bill paid with a $50 card
  and a $50 note charges the card $50, takes $30 of the cash, and hands $20 back. Applying cash
  first would charge the card the wrong amount — not a rounding difference.
- **A card over the bill is refused**, with the amount and what to take instead: *"That takes $30.00
  more than is owed, and change cannot be given on a card. Take $20.00 instead."* Accepting it as a
  customer credit was the rejected alternative: somebody typing $50 for a $20 card sale has
  mis-keyed, and the job is to say so before the card is charged rather than invent a liability out
  of a typo.
- **Each tender is its own payment.** The card one appears on a merchant statement three days later;
  the cash one appears in a deposit slip. A bank reconciliation has to match each against what it
  actually became, and one combined payment matches neither.
- **It lands in Undeposited Funds** — for card as well as cash. A card sale at 10am is in a batch
  that settles net of fees on the acquirer's schedule, not in the bank at 10am.
- **The control is one shared component**, used by both boards. Not for reuse — it is eighty lines —
  but because it mirrors `tenderFor` client-side to show the change *before* anything is submitted,
  and that mirror has to be identical in both places or one of them is wrong.

Measured end to end on the seeded demo: a $50 note against Fenwick Row's $20 remainder posted
`Dr 1200 Undeposited Funds $20.00 / Cr 1100 Accounts Receivable $20.00` and nothing else — the $30
appears in no entry — and Phase 31's `controlAccounts` still agrees on both sides afterwards.

### A check nobody runs is not a check (Phase 33)

Eleven phases each wrote a reconciliation — the stock lots against the Inventory account, the asset
register against 1500, the deposits against 2580, the funds, work in process, the tips, the gift
cards, the authorisation cache, the control accounts. Each was written carefully, tested, and put on
a page.

Measured before this phase: **nine reconciliation functions across nine modules, and not one of the
seventeen scheduled job kinds ran any of them.** Every check in the books existed only in the moment
somebody opened the page that called it — which is the exact inversion of what a reconciliation is
for. It is meant to catch a drift *nobody is looking for*.

- **Ten checks, one register, run nightly.** `src/modules/integrity/register.ts` names each one: its
  key, what two things it compares, which module has to be on, and what a difference *means*. A
  check that exists only as a function called from one page is invisible to anything that wants to
  run all of them, and all ten were invisible in exactly that way.
- **Three of the ten are positions, not faults**, and getting this wrong would have made the whole
  thing worthless. What practitioners have earned differs from account 2320 the moment payroll draws
  on it; so do tips; and a charity really does receive unrestricted money with no appeal attached.
  A register that alarmed on those would fire every payday — and an alarm that fires on ordinary
  trading is switched off before the night it matters.
- **Three outcomes, kept apart.** Ran and agrees; ran and disagrees; *did not run* — either skipped
  because the module is off, or errored because the check itself threw. A check that throws and is
  swallowed looks exactly like one that passed, so an error is its own finding: **"these disagree"
  and "nobody knows whether these agree" are different problems.** And a skip is not a pass — the
  page says *"6 run, 5 skipped because their module is switched off — which is not the same as
  passing."*
- **One drift is one alarm.** A stock difference from a bad import in March is still there in April,
  so a nightly digest of everything currently wrong would stop being read by about the time a second
  drift appeared. Only what broke *since last night* reaches a phone.
- **The run is written down even when nothing is wrong**, because a company with no findings and a
  company whose scheduled job stopped firing three weeks ago are otherwise indistinguishable — this
  phase's own argument, one level up. The page has a distinct *"the books have never been checked"*
  state and says so.

Verified end to end on the seeded demo. A hand-written entry against 1100 was caught the same night:
`faults: 1, newlyBroken: 1`. The two runs after it reported `faults: 1, newlyBroken: 0` — still on
the page, no second notification. And the salon's page reads **"1 check has stopped agreeing"** while
displaying two differences, because only one of them is a fault.

**And the bug it found on the way, which was worse than the one it set out to fix.** Checking whether
"the books are checked nightly" was actually *true* turned up that the schedule was never installed.
`installCompanySchedules` was called from `src/db/seed.ts` and nowhere else, and `registerCompany`
never touched schedules — so **no company created through the sign-up form had a single schedule.**
No bank sync, no campaign send, no rent run, no remittance reminder, no follow-up chase, no failure
digest: six phases of scheduled work that ran in the demo, passed their tests, and did nothing
whatever in production. `ensureSchedules()` now runs at the top of every worker tick, reading what
exists and writing only what is missing. That is the same failure this phase exists to catch —
work written, tested, and silently never performed — found inside the machinery that performs the
checks.

### The drawer is counted, and the difference is named (Phase 34)

Phase 32 wrote its own limitation down: *"There is no cash drawer, shift or Z-reading… a drawer
counted against the ledger will show $50 in and $30 out where the ledger says $20 — correct, and a
thing to know before reconciling one."* This is the reconciling.

- **A shift, not a day.** Phase 28's `pos_import` handles a day somebody else's till reported. Here
  the software *is* the till, and the unit is a shift — two people working a morning and an
  afternoon on one drawer are two counts and two accountabilities, and a day would average them.
- **The arithmetic works because Phase 32 posts only what was kept.** A drawer should hold
  `float + Σ cash applied − Σ paid out`, and change appears nowhere in it. A system that had
  recorded $50 in and $30 out would have to net them back off to count a till.
- **A float is not revenue** — `Dr 1060 Cash Drawers / Cr 1050 Petty Cash`. Nothing is earned, and a
  system that booked a float as takings would report a shop as having sold $100 before it opened
  the door. The float stays on the *expected* side, so a till opened with $80 instead of $100 reads
  as $20 short on the day rather than balancing quietly.
- **The database refuses the second shift** — a partial unique index `WHERE status = 'open'`, for
  Phase 29's reason: where two people can act at the same moment, nothing else actually arbitrates.
  The refusal names who has it, because "try again" is not information.
- **Only cash goes in a drawer**, and only when it is unambiguous. One shift open, it is used
  without asking; none or more than one, cash falls back to Undeposited Funds rather than being
  guessed — a note in the wrong till is a short drawer for one person and a long one for another.
- **Counting is a declaration.** The count field starts **empty**, not pre-filled with what was
  expected: this is the one place where showing the answer first would be wrong, because a
  pre-filled count is not a count. The difference posts to `6870 Cash Over and Short` rather than
  being absorbed — a shop that is $2 short every Friday has a fact about Fridays, and it only
  exists because the $2 was booked.
- **A closed shift is signed.** Re-counting is refused; correcting a genuine mis-count is a journal
  entry with a memo saying so.

**And the bug browser verification caught, which would have been embarrassing.** The nightly check
this phase adds to Phase 33's register summed only the *open* shifts against 1060 — so a till closed
with its float still in it read as $100 adrift, every night, for every shop that keeps a float
overnight. Which is every shop. One phase after writing down that an alarm firing on ordinary
trading is one somebody switches off, this phase nearly shipped exactly that. The unit is now the
**drawer**, not the shift: a drawer holds money whether or not anybody is standing at it.

Verified end to end: a till open with $100 float less $15 to the window cleaner reads *should hold
$85*; a $100 note for an $80 bill takes it to $165 with the $20 change in no entry; a typed count of
$162.50 says *"$2.50 short. This will be posted to 6870 Cash Over and Short, not absorbed"*; and
closing it banks $62.50, leaves $100 in for tomorrow, and leaves the tills agreeing with 1060.

### A document is owed in its own currency (Phase 35)

A consultancy in Ohio invoices a client in Bremen for €4,000. Every number in this codebase up to
now has been a US cent, and that one is not. Storing $4,334 and forgetting the euros can never
answer *what do they still owe me* in the currency the answer has to be given in.

- **Two amounts on the document, one in the ledger.** `invoices` and `bills` carry `currency`, the
  rate, and the home-currency total and balance beside their own. Journal lines are always in the
  company's currency. Neither number is derived from the other at read time.
- **Rates are millionths**, for ADR 0002's reason: a rate is a multiplier on money, and floating
  point has no business near money. 1.083500 is `1_083_500`, and six places is what feeds carry.
- **A rate is a fact with a date and a source.** "The rate we used" is the one number in a foreign
  transaction nobody outside the business can check, so it is stored with where it came from. The
  lookup walks *backwards only* — a rate published after a transaction is not what it happened at.
- **A missing rate refuses**, naming the pair and the day. Quietly using parity turns a €4,000
  invoice into a $4,000 one, and nothing downstream ever looks wrong enough for anybody to notice.
- **The stored home total *is* what was posted.** The lines are converted and their sum is both the
  journal entry and the column — converting the total separately would differ by a cent and
  manufacture, at the moment of posting, exactly the drift Phase 31 exists to catch.
- **Paying at a different rate realises a real gain or loss**, in `7100 Foreign Exchange Gain or
  Loss` — one account, not two, and in *other income*, because currency movement is not something
  the business did. It sold what it sold; the rate moved underneath.
- **What is still owed is exposure, reported and never posted.** A small business whose result is
  driven by a number it does not control, has not received, and will restate next month is one
  whose accountant spends December explaining that the profit is not real. `/accounting/currencies`
  shows both halves — what is realised and in the profit and loss, and what is merely exposed.
- **Four operations refuse rather than approximate.** Crediting a foreign invoice or bill, applying
  a credit note to one, and drawing a retainer against one all stop and say what to do instead: the
  home amount for a multi-line credit is the sum of the converted lines rather than the conversion
  of the sum, and which one is right is a decision somebody should make. A **write-off is allowed**,
  because one amount and two lines convert exactly.

**And the bug this phase's own check caught.** The first draft put "reduce the home balance too"
inside the payment path. A gift card, a credit note, a write-off, a vendor credit and a retainer
draw all reduce a balance somewhere else — five paths moved the face balance and left the home one
untouched, and Phase 31's control check reported $65.00 owed where $15.00 was. The rule now lives in
one pure function every path calls, and each of the five is a test. That is ADR 0033's whole
argument arriving on schedule.

Verified end to end: two euro invoices raised at 1.0835; the €4,000 one paid at 1.1000 leaves
**$66.00 realised in 7100**; the €2,500 one still open reads *€2,500.00 owed, $2,708.75 carried,
$2,750.00 worth today* — **$41.25 exposed and posted nowhere**; a rate typed as `1,0900` is refused
with *"uses a comma. Write it with a full stop, like 1.0835"*; and a read-only user sees the check
and the rates with no exposure section at all rather than a heading with nothing under it.

### A plan is not a second ledger (Phase 36)

Thirty-five phases in, this system could say precisely what a business earned and spent. It could
not say whether that was what anybody expected. A budget is the first thing here that describes an
*intention*, and the comparison is the number a small business actually runs on — not "revenue was
$66,942" but "revenue was $108,057 short of what we told the bank".

- **Nothing here posts.** `budget_lines` is the first table holding money that the trial balance has
  never heard of, and it has to stay that way: a budget that posted would appear in the actuals it
  exists to be compared against, and every business would hit its plan exactly.
- **A variance is signed by what the account is for.** Revenue $100 under plan and rent $50 under
  plan are both negative numbers and opposite kinds of news. `varianceFor` decides once — more is
  better for revenue and other income, less is better for costs — so the screen says *adverse* and
  *favourable* rather than making somebody work it out row by row. Same lesson as
  `balanceForAccount` returning the normal balance.
- **A section is judged on its totals, not by counting favourable rows.** Nine rows a dollar under
  and one row a fortune over is not a favourable section, and a majority vote would say it was.
- **The remainder is placed, not dropped.** $10,000 across twelve months is $833.33 twelve times,
  which is $9,999.96. An even spread gives the leftover cents to the earliest months; a **weighted**
  one gives them to the months that lost the most to rounding, because earliest-first would
  systematically favour January in a seasonal business.
- **Whole months only.** A range ending on the 14th has no defensible share of February's plan, and
  pro-rating would look precise and be arbitrary.
- **The actuals come from the Profit & Loss itself** — the same function, not a second query that
  filters the same way. A deliberate departure from the two-independent-derivations pattern of
  Phases 26 and 31: independence where the point is to catch drift, one source where the point is to
  be believed.
- **An unbudgeted account is not an account budgeted at zero.** $400 of legal fees nobody planned
  for shown as "budget $0, 100% over" is a percentage of nothing, sorted among rows that merely
  drifted. Those accounts are listed apart with no variance at all. The reverse too: a budgeted
  account with no activity reports its full budget unspent rather than vanishing.
- **Several plans per year, and approving one archives the last**, so "the plan" is never ambiguous.
  Approval is not a lock — ADR 0011's distinction reused — because a plan somebody keeps adjusting is
  still a plan, and refusing would send the adjusting into a spreadsheet.
- **No integrity check, deliberately.** A budget posts nothing, so a check could only ever agree,
  and ADR 0033's argument is that a register stays useful exactly as long as everything in it can
  fail. A test asserts no `budget.*` key exists.

**And the two bugs browser verification caught — both this phase's own thesis, broken in this
phase's own report.** The variance screen showed *"NOT BUDGETED AT ALL — $37,906.35"*, one figure
summing unbudgeted rental income with unbudgeted wages; it reads as an overspend and was really
$6,558 of unplanned income against $44,464 of unplanned cost. The plan grid did it again, with a
"Total" row adding planned revenue to planned rent. Both now keep income and cost apart with a net
that means something. A principle written in a doc comment is not a principle in the code, and
reading the screen is what found it.

Verified end to end on seven months of the demo books: revenue **$66,942.75 against a plan of
$175,000.00 — adverse**; operating expenses **$32,250.00 against $35,000.00 — favourable**. Both
differences negative, opposite readings. $31,348.41 of cost and $6,557.94 of income landed on
accounts nobody planned for, net **−$24,790.47** on the result. A read-only user sees the plan and
no variance section at all.

### A schedule is a promise to bill, not a bill (Phase 37)

Phase 11 built recurring *journal entries*; Phase 23 built rent invoicing, gated on the properties
module and keyed to a lease. Neither covers the commonest arrangement a small business has: **bill
this customer this amount every month** — a retainer, a maintenance contract, a subscription.
Without it somebody types the same invoice twelve times a year and eventually forgets one.

- **Nothing is owed until a period arrives.** No receivable, no revenue, nothing ageing, nothing on
  a statement. A business that set up twelve arrangements has not thereby been owed anything —
  Phase 29's "a booking is a promise, and a promise is not revenue", on the other side of the year.
- **What it raises is a real invoice**, through Phase 2's `createInvoice` inside the occurrence's
  own transaction. Phase 31 cost a whole phase to learn why: a module that hand-posts
  `Dr AR / Cr Revenue` makes a receivable no aging report knows about and no payment can settle.
- **The database decides that a period is billed once.** The occurrence row is written *first*,
  `ON CONFLICT DO NOTHING`, in the same transaction as the invoice. The scheduler guarantees at
  least once, so something has to make the second attempt harmless — and a read-then-write lets a
  worker and a person both bill December.
- **The cadence and the date arithmetic are Phase 11's**, imported rather than reimplemented. Two
  answers to "what is the next monthly date" drift apart on exactly the dates that are hard. The
  day is capped at the 28th and the refusal says why.
- **Automatic, or claimed and waiting.** A fixed retainer is safe to raise; anything whose amount
  somebody checks first is not. When it waits, the run still *claims* the period — otherwise a
  schedule somebody is reviewing gets offered again tomorrow, and the day after.
- **Pausing unbills nothing, and resuming does not replay.** A schedule is switched off rather than
  deleted, and one switched back on starts from today: catching up automatically would send a
  customer four invoices the morning somebody flipped a switch.
- **What is coming is a forecast, posted nowhere.** The largest figure on the screen is not a
  receivable, so the total row says *"Forecast total — not owed by anybody"* out loud.
- **It runs daily on the Phase 10 worker**, not monthly — a weekly arrangement and one on the 15th
  are both real, and a monthly job would bill one four times at once and the other late.
- **No integrity check, deliberately**, for Phase 36's reason: the invoice and its occurrence are
  written in one transaction, so there is no pair of independent figures that could drift.

**And the two bugs browser verification caught — both invisible to the tests, because both
behaviours were exactly what the code said.** The catch-up loop broke on *any* skipped result,
which is right for "a concurrent worker got there first" and wrong for "waiting for somebody" — so
a quarterly arrangement nobody attended to claimed April and then silently stopped, and July was
never billed and appeared nowhere. The symptom on screen was a schedule whose **Next** was a date
in the past. The second: the forecast window opened at *today*, so that same overdue quarter was
filtered out of the one report meant to show what is coming. `RunResult` now carries `claimed` and
the loop stops only when nothing was claimed; the forecast has no lower bound and reports overdue
as its own figure.

Verified end to end on the demo books: four invoices raised from a monthly retainer for
**$7,400.00**, **two** overdue quarters waiting for a person at $4,200.00 each, and **$9,750.00**
forecast to the end of November — owed by nobody. A read-only user sees the arrangements and the
work list with no buttons and no forecast at all.

### Two adapters, or the interface is a guess (Phase 38)

`TransactionalProvider` had existed since Phase 19 with exactly one
implementation, and that implementation always succeeded. The consequence
surfaced in production: a deployment with real users had no way to send a
password reset, and the honest advice was *write the password down.*

- **Mail leaves over HTTP, not SMTP.** A serverless invocation is good at one
  request and bad at a stateful socket it may be frozen inside. No new
  dependency — it is `fetch`.
- **`retryable` now means something**, derived from the status rather than
  guessed: 429/408/5xx transient, every other 4xx permanent, a thrown fetch
  transient by construction because nothing about the message was read.
  Classified in one place rather than copied per vendor.
- **Two adapters, and Postmark is why.** It answers `200` and means no — a
  rejection arrives as HTTP 200 with a non-zero `ErrorCode`. Written against
  Resend alone, "2xx means sent" is obvious and correct, and would have
  recorded rejected messages as delivered on the one channel where a lost
  message locks somebody out of their own books.
- **A delivery failure is not a second enumeration channel.** `/forgot` says
  the same sentence whether the address exists, does not, or bounced.

**And the bug browser verification caught, which falsified this phase's own
documentation.** A failed reset was correctly recorded — and then appeared on
no operations screen, where the ADR and the deploy guide both said it would.
`failedDeliveries` filters `company_id = $1`, and **a password reset has no
company**: it is a pre-authentication act. `= $1` never matches NULL, so every
failed reset was invisible to every operator. Latent since Phase 19, and
unsurfaceable until a provider existed that could fail. Resets are now
attributed to the recipient's oldest membership — deliberately not shown to
every tenant, which is what Phase 10 does for dead jobs, because a dead job
carries no personal data and a bounced reset carries an email address.

### A statement row has no name, so it is given one (Phase 39)

Transactions could only arrive through a `BankProvider`, and the only adapter
is the mock — so a real business could not get a single real transaction in,
and the whole of Phase 1 and 2 was unreachable with their own money. Every bank
on earth exports CSV. This is the path that needs no vendor.

- **It imports into the feed, not the ledger.** Rows land in the same inbox at
  `review_state = 'new'`. Nothing posts. A statement is evidence of what
  happened, not a decision about which account it belongs in, and
  categorisation, the rules engine and reconciliation are all reached
  unchanged.
- **A content hash alone silently loses money.** `bank_transactions` dedups on
  the provider's immutable id, and a CSV has none. Hashing
  `(date, amount, description)` looks sufficient: somebody who buys two
  identical coffees on one day then has **two transactions and one hash**, and
  the second disappears with no error at all. So the fingerprint carries an
  **ordinal** — the position among otherwise-identical rows — and two coffees
  stay two transactions while the same file twice imports nothing.
- **The bank's debit is money leaving you**, because the statement is written
  from their side, where your balance is their liability. Getting it backwards
  inverts every figure on the profit and loss. A magnitude is used in a column
  already labelled Withdrawal, and a row with figures in *both* columns is a
  refusal rather than a sum — netting would post a transaction appearing
  nowhere on the statement.
- **Reversal deletes rather than voids**, because a feed row is not a posted
  entry, and refuses once a row has been categorised and posted or cleared on a
  reconciliation. Re-importing the file puts a deleted row back identically,
  which is the fingerprint earning its keep twice.
- **Importing a statement is a bookkeeper's job, and so is undoing it.**
  Reversal wanted `accounting:journal`, which a bookkeeper does not have —
  meaning the person who imported the wrong file had to find somebody else to
  fix it. The permission now matches the run, and the wizard shows each person
  the kinds they may actually import.

**And the bug browser verification caught.** Re-importing last month's file
said **"Ready to import"** over **"To add: 0"**, with a live button.
`canCommit` is `errors === 0 && total > 0`, which is right for every kind that
came before — a statement is the first where every row can be a legitimate
skip. Committing would have written a run of three rows and nought created: a
line saying an import happened when none did, in the one place that exists to
answer *"where did these come from"*. It now refuses with the true reason —
*you already have all 3 of these* — and the screen says "You already have all
of this" rather than sending somebody to hunt for a problem in a good file.

Verified end to end on the demo books: four rows imported into Business
Checking for a net **$1,678.60**, two identical coffees kept apart, the same
file re-previewed as **0 to add, 4 already have**, the rows reachable and
uncategorised in the inbox, and **"Removed 4 bank transactions"** on undo.

### A bank account is an account, not a label on somebody else's (Phase 40)

Two things were wrong, and the second was hiding behind the first.

**A business could not open a bank account at all.** `financial_accounts` rows
were only ever written by an aggregator or the seed — so a company that signed
up and banked somewhere the aggregator does not reach had none, and without one
there is no statement import, no reconciliation, no deposit, no counter takings
and no payroll remittance. Phase 39 shipped a statement importer whose account
picker, for a real new customer, was empty. The only button that made one
connects the mock provider, which invents transactions and files them in real
books.

**And the accounts that did exist shared ledger accounts.** Everything that was
not a credit card pointed at `1000 Checking Account`, so the seeded demo had a
current account and a deposit account on one balance-sheet line.

- **One bank account, one ledger account**, enforced by a unique index rather
  than remembered — two people connecting institutions at once would both pass
  an application check. A line covering two real accounts can say what the two
  hold together and cannot say what either holds, which is the only question a
  bank statement asks.
- **Opening an account mints its ledger account**, so nobody needs to know what
  a chart account is to open one. Numbering is banded by kind — checking
  1000–1009, savings 1010–1039, cards 2100–2139 — because every report sorts by
  number and a current account at 1150 would sit among the receivables for ever.
  The first of a kind reuses the number the standard chart already names, but
  only that one and only when nothing posts to it: renaming an account that
  carries a balance would relabel history.
- **Closed, never deleted**, and the ledger account goes inactive with it — an
  account still offered for categorisation is one somebody posts to by accident
  and that never reconciles. Refused while a reconciliation is open.
- **A tie-out per account that could not have existed before.** With two
  accounts on one ledger account the ledger figure covers both, so the
  comparison is meaningless in exactly the case somebody needs it. Reported as a
  *position*, not a fault: money legitimately enters an account from an invoice
  payment with no feed row, and rows in the inbox have not posted.
- **A migration that repairs existing books, honestly.** Each sharing account
  gets a line of its own and the postings that *provably* belong to it move —
  only entries derived from its own bank transactions. A payment recorded
  against an invoice names a chart account and nothing else, so nobody can now
  say which real account it went into, and those lines stay put rather than
  being guessed at.

**And the bug browser verification caught.** The tie-out finding read
*"difference $92,279.30 — Business Checking −$92,476.00, Business Credit Card
$196.70"*. One finding, one word, two signs: the register computes
`left − right` with left the subledger side, and `cashTieOut` computed its
per-account difference the other way round. Both internally consistent,
contradicting each other on the same row. Invisible to the tests, because the
only per-account assertion was that a balanced account differs by zero — and
zero has no sign.

Verified end to end by registering a company from scratch: no accounts, the
import wizard now links to somewhere real, three accounts opened onto **1000,
1001 and 2100**, a statement imported into the first, and after coding it the
account reads **$5,000.00 in the ledger against $5,000.00 in the feed** with
the balance sheet naming *"1000 Barclays Current ••8812"*. A fresh seed
produces no shared ledger accounts anywhere.

### The document you raise yourself (Phase 41)

`createInvoice`, `createBill`, `recordPayment`, `createCustomer` and
`createVendor` have been written, posted, audited and tested since Phase 2.
**Not one of them was reachable from a screen.**

Every invoice in the system arrived as a by-product of something else: a won
opportunity, a completed appointment, a repair order, a rent schedule, a
progress claim, a recurring arrangement. All real paths, and none of them is
*"bill this customer for a day's work"*. So the application could age a
receivable, chase it, credit it, write it off, recover the write-off, put it on
a statement, render it as a PDF and reconcile the cash that settled it — for
invoices a business had no way to create. A plumber who signed up, opened a
bank account and imported a statement still could not invoice anybody.

- **Allocation is a decision, made in one place.** `recordPayment` has required
  applications summing exactly to the amount since Phase 2 — a payment that
  half-lands is worse than one refused — which pushes the real question up:
  £1,000 arrives against three open invoices and nobody said which. Oldest
  first, never past a balance (that leaves a negative one and a control account
  that no longer ties), and never absorbing the remainder (cash against nothing
  balances the bank and not the customer's statement). An overpayment is
  refused **with the arithmetic**, not recorded and parked.
- **A written-off invoice is not open.** Money against it is a *recovery*,
  which posts differently and takes the bad debt back off the P&L. Applying a
  receipt to it silently would make that decision in the direction that
  flatters the result.
- **The account list is where the invariants get protected.** Income on an
  invoice, costs and assets on a bill — a van arrives on a supplier bill. But
  never the accounts something else maintains (receivables, payables,
  undeposited funds, accumulated depreciation), and never cash, because each
  has an integrity check that coding a line to it would break.
- **No default account on a line.** The party defaults, the date defaults; the
  account does not. Coding a sale to whichever revenue account is first is a
  quiet mistake that surfaces a quarter later on a P&L nobody can explain.

**And the three bugs browser verification caught.** Adding your first customer
from inside the composer refreshed the party list underneath held state, so the
select displayed "Harborview LLC" while the value was still `''` — the form
looked complete and refused to submit under a hint asking for a customer. A
bill line could be coded to Accounts Receivable or to a bank account, both
invariant-breaking and both invisible until the list was read on screen. And
the fix for that was *half* a fix: excluding cash by "has a bank account
pointing at it" leaves a brand-new company's 1000 Checking Account on the list,
because nobody has opened one yet — which is exactly the company this phase is
for. Written the obvious way, the replacement then removed nearly the whole
cost side, because `subtype NOT IN (...)` is unknown rather than true when
subtype is NULL and most expense accounts have none.

Verified end to end on a company registered from scratch: no customers, added
one from inside the composer, raised **INV-1001 for $1,350.00** (3 × $450.00,
totalled live) and **INV-1002 for $800.00**, took **$1,500.00** which settled
1001 in full and 1002 in part and said so, had **$99,999.00 refused** with
*"more than the $650.00 outstanding"*, and saw $650.00 land on the A/R aging
and $2,150.00 on the profit and loss. Then a supplier and a bill for $125.40 on
the other side of the same screen.

### What the customer opens is the ledger, not a copy of it (Phase 42)

Every piece existed and none were joined. Phase 21 renders an invoice as a PDF
— behind `requireActor()`, so only somebody signed in to the company can fetch
it. Phase 38 can put a letter on the internet. Phase 22 logs communications on
a customer's timeline. `TransactionalKind` had four values and none was an
invoice. So the only way to get an invoice to the person who owed it was to
sign in, download the PDF, open your own email client and attach it.

- **A link to the live record, not a snapshot** — against the obvious build,
  because an earlier phase argued the case at the top of
  `modules/pdf/invoice.ts`: a stored copy would be *"a second answer to how
  much does this customer owe"*. Phase 41 strengthened it, since an invoice
  cannot be edited. So a snapshot would differ from the record in exactly one
  way — it would keep showing the original amount after a payment, which is the
  wrong behaviour. A customer part-pays in April and opens the link in October;
  what they need is what is *still* outstanding. What gets stored is the
  communication — who, when, how often, whether they opened it — which is
  evidence of *asking*, a different claim from evidence of the amount.
- **The projection is an allowlist.** `/i/[token]` is unauthenticated, so the
  question is not "how do we display an invoice" but "which fields may leave
  the building". Built field by field from named inputs: a subtraction leaks by
  default the moment somebody adds a field and forgets. A test hands it a row
  stuffed with `internalNotes`, `marginBp` and a cost code and asserts none of
  them come out.
- **The token is the whole of the security** — 32 random bytes, unique across
  every company, minted on the first send rather than at creation, never
  rotated after. Revoking kills the door without touching the debt. A wrong
  token, a revoked one and a voided invoice are all the same 404, because
  distinguishing them tells somebody probing which invoices exist.
- **The record moves before the send.** A message that leaves unrecorded means
  a customer holds an invoice the business does not know it sent;
  recorded-but-not-sent shows up as a failure somebody can act on, and the
  action says so rather than reporting success.

**And the three bugs browser verification caught.** The view counter never
worked and said nothing: a raw `Date` inside a `sql` template loses its type,
the driver refused the whole statement, and a bare `.catch(() => {})` swallowed
it — best-effort was right for a page render, *silent* was not. A shared
invoice read as **"not sent"** and hid the view count with it, because the
column had two states where there are three — so a business could share a link,
watch the customer open it twice, and see a row saying nobody had been asked.
And the refusal for a customer with no address said *"type one below"* when
there was no below: the add-customer form never asked for an email, so a
customer created there could never be sent anything.

Verified end to end on a company registered from scratch: raised an invoice,
had the send refused honestly, took a link, opened it in a **clean browser with
no session** — the page showed the invoice and nothing else, no owner name, no
navigation, no links at all, and `/accounting/invoices` bounced the stranger to
`/login`. Part-paid $200.00 and the customer's page moved from **$1,200.00 to
$1,000.00** with *"$200.00 received, thank you"*. Revoked, and the link 404s.
Then a second customer with an address: **sent**, and **reminded**, both
recorded on the row.

### A business that has to remember to chase does not chase (Phase 43)

The aging report has known who owes what since Phase 2. Phase 42 built the
send — wording, reminder flag, count, delivery record. Phase 10 built a worker
with schedules. `engagement.chase_overdue` already existed and chases *internal
tasks to staff*. Nothing chased an invoice to the person holding the money. So
every part was there and the only hard question was unanswered: **when**.

- **Two expensive wrong answers set every rule.** Chasing something already
  settled is the worst by a distance — a customer who paid last week and gets a
  demand this week does not think the software is confused, they think these
  people do not know what they are owed, and every figure after that is
  doubted. So it is not *chase what is overdue*: it is chase only what is open,
  unsettled, not written off, actually sent, not just part-paid, and worth an
  email. Chasing too often is how a sender gets blocked, so there is a cadence,
  a ceiling of three, and a per-run cap — and after the ceiling the debt becomes
  a person's problem, which is where something that survived three polite emails
  belongs.
- **Off by default, with no backfill.** This is the only automatic behaviour in
  the system that emails somebody who is *not a user of it*, over a company's
  own name, with nobody present. Absence of a settings row means off, and the
  migration creates none — the column defaults describe what a company gets
  when a person switches it on, not what happens tonight.
- **The anchor decides which chase; the gap decides whether any.** The cadence
  runs from the due date, so a worker that misses Tuesday catches up on
  Wednesday instead of sliding for ever. That alone is wrong, and the proving
  case is the one that matters most: switch chasing on with a year of unpaid
  invoices behind you and every anchored date for every stage is already past,
  so the first run sends chase one and the next sends chase two — a six-week
  sequence arriving in three minutes. The minimum silence since the last send
  is what stops it, and it is also what makes the job idempotent: there is no
  "already chased today" flag, `sendInvoice` stamps `sent_at` and the second run
  reads it and declines. The state that prevents the repeat is the state that
  records the first send.
- **A chase is an ordinary send.** It goes through Phase 42's `sendInvoice` —
  the same call the button makes — so it is counted, rate limited, logged and
  audited identically. A separate chase path would have meant a second answer to
  *how many times have we asked*.
- **The preview is the screen.** Nobody switches on something that emails their
  customers on the strength of a description, so `/settings/chasing` leads with
  what would go out today and, under it, every invoice that would not, with the
  reason by name and the date it next falls due one. Same `planChases` the
  worker runs.

**Three defects caught.** The whole sequence firing at once, above — found by
the integration test on a second identical run, invisible to the pure tests
because each asked about a single day. Then, in the browser: the preview was
**blank at exactly the moment it mattered**, because planning against the stored
policy made every row read *"chasing is switched off"* under a heading promising
to show what would go out if it were on. And **nothing in the demo had ever been
sent**, so the preview's whole content was "never sent to the customer" eleven
times — Phase 42's Sent column had been dead on the demo since the day it was
built.

Verified on the demo: eleven open invoices, five of them emailed. With the
switch untouched, the preview listed **five going out** — oldest debt first, 149
days down to 74, each *first of 3*, each with its next date — and seven held,
one *not an open invoice* and six *never sent to the customer*. Switched on,
pressed **Send today's now**: *"5 sent"*, and the five moved to **chased
recently** with **2026-09-11** beside them. Pressed it again: *"Nothing was due
today."*

### The money is not at the bank yet (Phase 44)

Four phases built a path — open a bank account, raise an invoice, send it,
chase it — and at the end of it the customer opens a link, reads what they owe,
and has no way to hand the money over. The chart of accounts had been saying so
for longer: **`6850 Merchant and Processing Fees` has been in the standard
chart since Phase 0 and used by nothing.**

- **Three entries, because there are three events.** The obvious entry for a
  $1,000 card payment is `Dr Bank / Cr Accounts Receivable`, and it is wrong
  twice. The amount is wrong — the processor keeps a fee, $970.70 arrives, and
  booking the gross overstates cash while hiding a real cost that never reaches
  the profit and loss. The shape is wrong — the money is at the processor on
  Tuesday and arrives Friday *batched* with eleven others as one deposit, so
  the statement has one line and the ledger has twelve on three days, and Phase
  40's tie-out cannot be made to pass. So the money goes to **1250 Payments in
  Transit** at capture, the fee to 6850, and the payout moves it to the bank as
  the single row the statement shows.
- **Not Undeposited Funds**, deliberately: that is cash in hand waiting to be
  walked to the bank and Phase 12's deposit screen offers to bank it. Money at
  a processor is neither in hand nor bankable.
- **The gross settles the debt.** The customer paid what they were asked for;
  charging the fee back to their balance would leave every card-paid invoice
  showing 29 dollars owing for ever. And `net = gross − fee` by subtraction, so
  no rounding rule can strand a penny in an account that then never clears — a
  test walks every amount from nothing to $50 and asserts they add up.
- **No card data ever touches this application.** `createCheckout` returns a
  URL, not a form: a payment form served from here would put the whole
  application in PCI DSS scope. The mock's stand-in page says so out loud
  rather than dressing itself as a card form, and the one endpoint that can
  mark a payment succeeded without a processor saying so refuses to run at all
  once a real adapter is configured.
- **The database stops the double payment.** `checkouts.payment_id` is unique
  and claiming a checkout is a conditional update that only fires while it is
  pending — the loser of the race reads back what already happened and reports
  success, because from the customer's point of view nothing is wrong. Three
  things can settle a checkout and all three racing is the expected case.
- **The clearing account is checkable, and that is the point.** Nothing posts
  to 1250 except those three entries, so `payments.in_transit` is a *fault*
  where the bank tie-out is a position — a difference means a fee without a
  capture, a payout that swept something it did not settle, or the expensive
  one: a payment the customer made that never reached these books.

**The defect browser verification caught: the deposit posted two days before it
arrived.** The processor announced a batch arriving on the 30th and the import
posted it on the 28th, so the bank ledger showed $23,303.70 the business did
not have — the exact error the phase exists to prevent, committed at the last
step instead of the first. An unarrived batch is now left alone; the money
stays in 1250 until it lands. Every unit test passed while this was broken,
because each asked about balances rather than dates.

Verified on the demo end to end: switching on was refused until a payout
account was chosen; a stranger opened a shared invoice for **$1,850.00**,
pressed Pay, saw a page saying plainly that no card was being taken, and paid.
The invoice went to **paid in full**, the Pay button disappeared, and the
business's screen read **$1,796.05 at the processor** with 1250 agreeing and a
fee of **−$53.95**. "Check for deposits" posted one deposit dated **2026-08-28**
— today, not Sunday — the row moved to *in your bank*, and the clearing account
went to zero.

### The record you can never fix (Phase 45)

Customers and vendors have existed since Phase 2 as a dropdown inside the
invoice composer and nothing else — no page listing them, no way to reach one,
and **no update function of any kind**. A typo in an email meant that customer
could never be sent an invoice (Phase 42) and never be chased (Phase 43), for
ever, and the only escape was a second record that splits their aging, their
statement and their balance in two.

A smaller find of the same shape: `modules/pdf/invoice.ts` has composed a
"Billed to" block from `addressLine1`, `city` and `postalCode` since Phase 21,
and **nothing has ever written any of the three**. Every invoice PDF carried a
billing address consisting of the customer's name. The PDF needed no change; it
needed somewhere to type.

- **Three kinds of field, not one.** A **description** — name, email, address —
  says how to refer to somebody, so correcting one corrects it everywhere,
  including on invoices already sent; that is ADR 0042's live-record argument
  applied consistently, since a document showing a stale spelling is showing
  something never true. A **default** — payment terms — decides the *next*
  invoice and must not move a due date somebody was already told, so nothing
  reaches into `invoices` and the form says so. A **consequence** — a vendor's
  tax ID and 1099 status — is a position taken for a filing, and changing one
  after a year is reported restates it, so the notice says what it did.
- **A partial update, so a form cannot destroy what it did not ask about.** The
  commonest way an edit screen loses data is blanking the columns its form
  omitted. Saving an untouched form writes no audit entry at all, or the log
  fills with noise and the one real edit is buried.
- **The audit trail here is not decoration.** Changing a vendor's payment
  details is the commonest invoice-fraud vector a small business meets — an
  email saying "our bank has changed", a quiet edit, and the next payment run
  goes to a stranger. Before *and* after are recorded, which is the whole
  reason to prefer an update over a delete-and-recreate, and editing a vendor
  needs a stronger permission than creating one.
- **Archive, never delete**, and refused while there is open business: a
  customer hidden from every picker while still owing money is a debt nobody
  will chase.

**Two defects this turned up.** Reseeding onto the new screen showed **two
customers both called Harborview Development LLC** — `convertWonOpportunity`
deduplicated only against a customer already linked to the organization, so a
client invoiced *before* being won in the CRM got a second record. It now adopts
an unlinked exact-name match instead. That the demo had carried that duplicate
for many phases is the point: until there was a screen listing customers, there
was nowhere it could be seen. And in the browser, a refusal **followed the user
to the next record** — "there is still money outstanding" sat above a supplier
owing nothing, because a notice raised on one party stayed up while another was
opened.

Verified on the demo: filled in an address and corrected an email in one form,
and got back *"Email, address, city and postcode updated."*; saved the same
form untouched and got *"Nothing changed."*; tried to archive a customer owing
$9,400 and was refused with the reason; and the invoice PDF now prints the
street, city and postcode it has been asking for since Phase 21.

### The payment nobody came back from (Phase 46)

Phase 44 settled a card payment when the customer's browser returned to the
"thank you" page. That is the **least reliable moment in the whole flow** — the
tab gets closed, the phone loses signal, the redirect fails — and the processor
has taken the money either way. When it did not happen the checkout stayed
`pending`, nothing posted, the invoice still read unpaid, and **Phase 43 chased
the customer by email for an invoice they had already paid**.

And ADR 0044 claimed the nightly `payments.in_transit` check would catch exactly
this. **It could not.** The processor side of that comparison counted only
checkouts already marked `succeeded`, so a stranded one contributed zero to
*both* sides and the check reported agreement. The one failure it was written
for was the one it was blind to. A test that passed before the fix existed is
what proved it.

- **Ask the processor, hourly.** Everything else on the schedule is money the
  business is waiting for. This is money it already **has** and does not know
  about, so the gap between being paid and knowing has to be short.
- **A processor's answer beats our own record.** `succeeded` settles a checkout
  even if we had written it off as expired — it is the party holding the money.
- **An unknown is never an abandonment.** If the processor cannot say what
  happened, expiring the checkout writes off a customer's money in silence and
  no later answer reopens it. `unknown` is a distinct status from `failed`, is
  never resolved by the machine in either direction, and is the *only* thing
  that wakes a person: a recovered payment is the sweep working and an expired
  one is a customer changing their mind, and alerting on either teaches somebody
  to ignore the alert that matters.
- **The check now counts what it cannot value.** It refuses to report agreement
  while any checkout is unresolved, without inventing an amount for it — an
  unresolved payment is worth its gross or nothing, and there is no third figure
  that is honest.

**The defect browser verification turned up was the phase's own shape.** The
sweep correctly reported *"1 the processor cannot account for — somebody needs
to look"* — into a toast that was gone on reload, leaving the row sitting under
a heading whose copy says most of these are customers who changed their mind.
The alarming row looked exactly like the harmless ones, for ever. Checkouts now
record what the processor last said and when, and the screen splits into **"The
processor has no record of these"** — red, with the reference to paste into the
processor's own dashboard — and a quiet "Started and never finished". A finding
nobody can see an hour later is a finding the sweep did not make.

Verified on the demo: started a payment and closed the tab, and *"Nothing to
resolve — 1 still with a customer"*; a day later, *"1 abandoned"* and the row
correctly closed with "the processor took nothing"; and with the processor
unable to account for a payment, *"1 the processor cannot account for"* — the
row left open, not written off, listed with its reference and the date it was
last asked.

### The supplier's reference is not our number (Phase 47)

The bill composer has a field labelled **"Their reference"**, placeholder
`INV-4471`. It wrote into `bills.number` — which is also where this system puts
its own `BILL-1002`, and which is unique **per company**. One column, two
meanings, and the constraint was wrong in both directions at once.

**It refused what it should allow.** Two suppliers both numbering an invoice
`INV-4471` is not a coincidence; it is how invoice numbering works. The second
bill hit a raw Postgres unique violation — and because `createBill` threw a
plain `Error`, the person holding a real supplier invoice was told *"Something
went wrong."* and left with no way to enter it.

**It allowed what it should refuse.** The same supplier's invoice entered twice
— once from the emailed PDF, once from the posted copy — was caught only if
somebody typed the reference both times. The field is optional, so the safe path
was the one nobody took, and both copies got paid.

- **A reference identifies a document within a supplier.** Everything follows.
  `vendor_reference` is theirs, kept verbatim because it is a quotation;
  `reference_key` is it normalised, unique **per vendor** on a partial index —
  partial because most bills carry no reference and null is not "the same as"
  another null.
- **Refuse only what is certain.** A supplier does not issue two invoices under
  one number, so a repeated reference is the same document and is not
  overridable. Everything else warns and hands the decision back: same amount
  the same day, or within a fortnight. Same amount a *month* later is silent —
  that is rent, and a warning that fires every month is one nobody reads by the
  third. Two references that differ are silent too: the supplier has already
  said these are two documents.
- **The messages were always there.** `createBill` and `recordPayment` threw
  plain `Error` — **thirty-three** of them, every one written for a person
  (*"Record one payment per currency"*, *"Retainage must be less than the bill
  total"*) — and `messageFor` collapsed all of them to *"Something went wrong."*
- **The highest number, not the count.** `nextDocumentNumber` counted rows,
  which is only the same answer while nothing was ever numbered by hand.
- **Find the ones already in there.** A rule at the door does nothing for the
  six months already in the books, which is where the bill that gets paid twice
  actually is. `payables.duplicate_bills` pairs them with the same pure verdict
  the composer uses — reported as a *position*, because two bills a week apart
  is how a weekly delivery looks and alarming on a suspicion is how a check gets
  ignored.

**The defect browser verification turned up cut underneath all of it.** The
supplier dropdown offered **Delta Electrical twice**. The duplicate rule is
keyed on the vendor, so a supplier split across two records is invisible to it —
the same invoice entered against each reads as "two suppliers using the same
number", the case this phase deliberately allows. Adding a party under a name
already on the books is now a question rather than a silent second record, and
the seed that caused it reuses the vendor it had already created.

Verified on the demo: entered `INV-4471` for two different suppliers and both
landed; tried `inv 4471` again for the first and got *"This supplier's reference
is already on BILL-1004, dated 2026-08-10"* with **no** way to override; entered
two unreferenced bills for the same amount a day apart and was asked, then let
through on *"It is a different bill"*; and the pair then appeared under **Bills
that look like the same invoice twice** with $4,000.00 still owed.

### The bill for goods you already have (Phase 48)

Receiving stock posts `Dr Inventory / Cr Goods Received Not Invoiced` — the
goods are on the shelf, the money is owed, but not yet to a named supplier on a
named invoice, so `2050` holds it. That has worked since Phase 14.

Then the supplier's invoice arrives, and **the bill that clears `2050` could not
be entered.** A bill line may name an expense, COGS or asset account; `2050` is
a liability. `attachBillToReceipts` — written in Phase 14 for exactly this, with
a doc comment describing the posting — had **no caller anywhere**.

So every delivery was billed to inventory or an expense instead, **recognising
the cost twice**, and `2050` grew for ever with nothing able to debit it. On the
demo: `1400 Inventory` at $28,559.20 and `2050` at **$28,700.00** — a clearing
account holding almost the whole value of the stock, which nothing could clear.
The inventory screen displayed that balance, itemised, beside no control at all.
And no integrity check watched the account, so nothing ever said so.

- **A caller that may name the account, because it derived it.** The rule that
  keeps `2050` off a hand-typed bill is right and stays. `billReceipts` takes
  *deliveries*, not accounts: it derives the amount from the receipts, names
  `2050` because that is the only account it may name, and marks them in the
  same breath.
- **What comes out is what went in.** `2050` was credited with what the goods
  were taken in at, so that is what comes back out — not what the invoice says.
  This **corrects Phase 14's stated decision** that the difference should stay
  in the account "as a visible residue": it is not visible, because a residue
  there is indistinguishable from a delivery nobody has billed. That is exactly
  how the balance reached $28,700 unseen. The difference posts to `5450
  Purchase Price Variance` instead, where it is on the profit and loss.
- **The difference is its own entry.** An undercharge needs a *credit* to
  variance and a bill line is always a debit — `journal_lines_single_side`
  refuses a negative one, correctly.
- **Posted always, mentioned at half a percent.** Below that it is a rounded
  freight charge, and a notice on every delivery is one nobody reads.
- **`inventory.goods_received`**, the check that was missing: unbilled receipts
  against `2050`, as a fault. The left side is summed from the deliveries rather
  than from the ledger — a check that reads the ledger twice agrees with itself
  and proves nothing. Had it existed in Phase 14, this would have shown on the
  first delivery instead of the twenty-eight-thousandth dollar.

**The defect this turned up was between the last phase and this one.** A
supplier delivering the same order twice in a week sends two invoices for the
same amount, and Phase 47 refuses the second unless somebody says "it is a
different bill" — which `billReceipts` had no way to say. The second delivery
could be received and never billed, putting back the exact balance this phase
clears. Choosing a *different delivery* is now the answer to that question: two
bills because two deliveries, named on both. The same delivery still cannot be
billed twice.

Verified on the demo: billed both outstanding deliveries from the inventory
screen, one agreeing exactly and one where the supplier asked $40 more. After
it, `2050` reads **$0.00**, `1400` is unchanged at $28,559.20 — the cost was not
counted twice — `5450` carries the $40, and both bills are on the payables
screen against Cascade Building Supply.

### What you owe, and choosing what to pay (Phase 49)

Two things were missing, and the second is the serious one.

**No work queue.** A/P aging has existed since Phase 2 as an as-of snapshot —
correct, printable, and inert, with nothing on it clickable and nothing payable
from it. The bill list is ordered by issue date with no totals and no overdue
marking. Neither answers the question a business asks itself every Friday.

**The selection was never sent.** `recordPaymentAction` has accepted
`documentIds` since Phase 41 and honours the order given — and **no screen ever
sent them.** Selection was per *vendor*, and `allocate` then consumed oldest
first, so a business paying a supplier's third invoice while disputing the first
two could not: the money landed on the disputed bills and marked them settled.
That is not a missing feature; it is the application overriding a decision the
business made.

- **The choice is respected absolutely.** A bill nobody ticked is never touched.
  Within what *was* ticked, the oldest settles first — what a supplier expects
  and what keeps an aging report sensible — but the boundary of the selection is
  inviolable.
- **One payment per supplier**, not one per bill. Four ledger rows against one
  bank statement line is a reconciliation nobody can do.
- **A shortfall warns, never refuses.** The figure is the *ledger's*, not the
  bank's — a cheque written last week may not have cleared — and refusing on it
  would stop a business paying suppliers over a timing difference.
- **A stranded credit is money.** `applyVendorCredit` and its server action have
  existed since Phase 12 with **no caller anywhere in `src/app`**, so a credit
  with anything left was unusable and the screen showed its balance beside no
  control. Applying one posts *no journal entry* — the ledger moved when the
  credit note was raised — and the tests say so rather than leaving it assumed.

**The defect browser verification found was in this phase's own screen.** The
account picker offers every active account, and paying a supplier by company
card is ordinary — but `balanceForAccount` signs in the account's *normal*
direction, so a card's credit balance comes back positive and the screen said:

> *Business Credit Card holds $1,404.79 on the ledger. $154.79 left afterwards.*

Exactly backwards. That $1,404.79 is what the business **owes**; paying $1,250 by
card takes the debt to $2,654.79, and somebody reading "$154.79 left" would think
they had headroom. A liability account now reports no available figure at all —
its headroom is its credit limit less its balance and this system does not know
the limit, so saying nothing is the only honest answer.

Verified on the demo: ticked one supplier's newest bill and another supplier's,
deliberately skipping the *overdue* one, and got *"$18,254.00 paid — 2 payments,
one per supplier, settling 2 bills"* with the overdue bill still sitting
untouched at the top of the queue. And a vendor credit raised against a
part-paid bill stranded **$142** with nowhere to go — now offered against
another of that supplier's bills and reported as *"$142.00 of credit applied.
That credit is used up."*

### The payment nobody approved (Phase 50)

Three phases each added a step, and together they closed a loop nobody had
looked at whole. With **one** permission — `accounting:journal` — a person could
create a supplier (Phase 45), enter a bill to it (Phase 41) and pay it (Phase
49). Nothing recorded who entered the bill, and Phase 49 had just turned the
last step into a single click across a whole batch. That is the
fictitious-supplier fraud, and it is the control most small-business theft
actually exploits — not a clever exploit, just nobody looking.

The obvious fix does not work here. Splitting it by role — a bookkeeper enters,
an accountant approves — fails because **a bookkeeper cannot enter a bill at
all**: `createBill` wants `accounting:journal`, which that role has not got. So
everybody who *can* enter a bill is already senior enough to approve one, and a
role split alone would have shipped a control that constrains nobody.

- **The rule that bites is "not the bill you entered yourself."** `createBill`
  now stamps `entered_by`, and `mayApprove` refuses when it matches the person
  pressing the button. `accounting:approve` exists as its own permission so
  entering and approving stay separately grantable, but the code says plainly
  that it is a seam rather than today's enforcement.
- **Off by default.** A sole trader is their own bookkeeper and their own
  approver. The costly wrong answer is not a bill waiting a day — it is making a
  business that does not want this unable to pay anybody.
- **A threshold, not all-or-nothing.** The point is attention, and attention is
  finite: a rule that stops the week for a $4 parking receipt is a rule somebody
  approves without reading, which is worse than no rule at all.
- **A pay run holds back rather than refusing.** Tick eight bills of which one
  needs approving and seven get paid, with a sentence about the eighth.
  Refusing the lot teaches people to switch approvals off.
- **Nothing is backfilled.** A bill entered before this phase has no honest
  answer to "who entered it", and inventing one puts a name against a decision
  that person may never have made. Null means *we do not know*, and the
  two-person rule stands aside rather than leaving those unapprovable for ever.
- **An approval cannot be withdrawn once the money has gone.** That would leave
  a paid bill reading as though it was never authorised — void the payment
  instead.

**Browser verification found two defects, both in the first three clicks.**
Ticking "Require approval" and nothing else saved a threshold of **zero**,
because the service seeded its first write from `APPROVAL_OFF` — whose threshold
is zero precisely because nothing reads it while the control is off. So turning
approvals on made every bill need a second person and silently overrode the
$1,000 the schema had chosen. And both switches, bound to the server value
alone, visibly snapped back when pressed; Playwright failed outright with
*"clicking the checkbox did not change its state"*, and a person does the
obvious thing — clicks again, turning the control back off.

Verified on the demo: entered a $2,400 bill as Dana, switched approvals on
(threshold now correctly *"$1,000.00 and up"*), and the screen held back four
bills worth $11,650.00. The one Dana had just entered offered no Approve button
at all, only *"Yours to enter, theirs to approve"*; the $718 bill below the
threshold stayed freely payable. Approving one and paying gave *"$1,968.00 paid
— 2 payments, one per supplier, settling 2 bills"* with the three unapproved
ones untouched, and an approval taken back returned its bill to *"Needs
approving"*.

### The entry you cannot correct, and the one you must not (Phase 51)

The journal screen has told users this since Phase 2:

> *Voided entries stay listed — the ledger corrects by reversal, never by
> deletion.*

It then showed number, date, memo, source and status — **no debits, no credits,
no money at all** — beside no correction of any kind. Three functions had
existed since Phase 2 with no caller anywhere in `src/app`: `entryWithLines`,
`voidEntry` (called only by a server action no screen ever called) and
`reverseEntry`. An entry posted to the wrong account could neither be read nor
put right.

**The costly wrong answer is not the missing button — it is wiring it up
naively.** `voidEntry` checked a permission and an open period and nothing else,
so voiding the entry behind INV-1002 would leave the invoice claiming $24,000
that Accounts Receivable no longer carried: the one disagreement Phase 31 went
to the trouble of proving never happens, with a nightly check that would notice
and nothing that would prevent it. It never bit because the button was missing,
not because it was guarded.

- **A derived entry is corrected by correcting its document.** The refusal names
  where to go — *"Void the bill on Invoices & bills; the ledger follows it"*.
  The guard sits on the person-initiated path only; a document still voids its
  own entry internally, in the same transaction, so both halves move together.
- **An entry in a closed period is reversed, not voided.** Voiding silently
  changes numbers somebody has already given to a bank. A reversal shows the
  correction in the current period, with both entries standing and pointing at
  each other.
- **Reversing is allowed wherever voiding is; the reverse is not.** An open
  period is not proof nobody has reported on it, so *"Reverse it instead"* sits
  beside *"Void it"* — but asking to void a closed period is refused either way.
- **You can see what an entry says**, fetched when you open a row rather than
  shipped with all hundred.

Browser verification found a React key warning on the first render — the row and
its expanded detail are two `<tr>`s for one entry and the fragment wrapping them
carried no key. Smaller than what the last few phases turned up, and worth
saying so.

Verified on the demo: a bill's entry showed its two lines and refused correction
with *"Entry #91 is the ledger half of a document… Void the bill on Invoices &
bills"*; a hand-posted entry offered both corrections and reversing #94 gave
*"reversed by #95 — both stay on the books, that is what makes the correction
visible"*; and an entry dated 2026-03-15 with January–June closed offered
**only** *"Reverse it"*, landing #98 on 2026-08-28.

### The payment you cannot take back (Phase 52)

Not a function with no caller. Not a screen missing a button. **Nothing at
all** — no status column on `payments`, no service function, no action.

`recordPayment` has existed since Phase 2; Phase 41 made it reachable, Phase 44
gave it a card path, Phase 49 turned it into a batch that pays several suppliers
in one click. A receipt keyed as $1,500 instead of $150, or a pay run aimed at
the wrong supplier, was **permanent**: the document showed settled, the bank
showed the money gone, and the only move left was a hand-posted journal entry
that fixes the ledger and leaves the invoice still claiming to be paid. Phase 51
then closed the last bad door and its refusal read *"Void the payment that
produced it"* — pointing at nothing.

**The costly wrong answer is not the missing button. It is unwinding a payment
whose money somebody else has already counted.** A receipt banked on a deposit,
counted into a till at the end of a shift, or settled by a card processor is
money a second record already claims.

- **Four refusals, ordered by whose record it is**: banked on a deposit, counted
  into a closed shift, settled at the processor, or settling a document that has
  since been voided. A deposit outranks a closed period even when both are true,
  because *"the bank has this money"* is the more useful thing to hear first.
- **The ledger unwinds by Phase 51's rule** — voided in an open period, reversed
  in a closed one — through the *internal* path, so Phase 51's guard on
  person-initiated voids stays intact rather than being routed around.
- **The applications stay, and eight query sites now exclude void payments**:
  cash-basis reporting above all (a voided receipt left in place reports revenue
  never received), plus 1099 reporting, customer statements, the chase run,
  undeposited funds, deposit creation and two drawer sums.
- **A reason is required.** A void with no reason is a hole somebody
  reconstructs from dates six months later.
- **A document goes back to `open` or `partial`, never `draft`** — one that was
  issued and part-paid was still issued.

Payments were also never listed anywhere, so **Money in and out** is now a
screen.

**Browser verification found the refusal naming an operation that does not
exist.** Its first draft said *"take it off the deposit first"*; there is no
such thing — a deposit is voided whole. That is exactly the defect Phase 51
shipped and this phase existed to fix, and it was found by *following* the
sentence rather than reading it.

Verified on the demo: taking back a $5,040 cheque gave *"INV-1008 is owed again.
The ledger entry is void with it"*, the invoice went `paid` → `partial` at
$5,040 outstanding, its journal entry read `void`, and the AR control account
still equalled the sum of open invoice functional balances to the cent. Banking
a receipt turned its row from "Take it back" to *"cannot be undone"* naming
DEP-1001.

### The money you cannot bank (Phase 53)

A customer owed $7,400 and sent $8,000. The screen said:

> *"$8,000.00 is more than the $7,400.00 outstanding. **Reduce it to $7,400.00**,
> or raise the document the rest covers first."*

Both instructions are wrong, and the first is worse. **"Reduce it"** puts a
figure in the books the bank statement disagrees with, and the reconciliation
stays $600 out *for ever* — the difference was never recorded as anything, so no
later event resolves it. **"Raise the document the rest covers"** means inventing
an invoice for money the customer does not owe, fabricating $600 of revenue to
make a bank line match.

`allocate` had computed the leftover correctly since Phase 41. Nothing was ever
done with it except refuse. And this is not exotic: a customer rounding up,
paying an invoice twice, paying the gross when a credit note reduced it, or
sending a deposit before the invoice exists all hit it.

- **The leftover is a liability** — `2520 Customer Overpayments`. Not revenue
  (nothing more was sold), not a negative receivable (netting it hides it inside
  the aging report and overstates collectable cash), and not `2500 Unearned
  Revenue` (that is money for work that *will be done*; an overpayment is often
  a keying error whose honest end is a refund).
- **Two refusals survive.** Overpaying a *supplier* leaves them owing you, which
  is an asset and what vendor credits are for; and a leftover with nobody named
  has nowhere to attach, which is how Phase 46's stranded payments happened.
- **It has an end, built in the same phase** — applied to a later invoice or
  refunded. Phase 49 found `applyVendorCredit` uncalled since Phase 12 stranding
  real money, and Phase 48 found a clearing account grown to $28,700 that
  nothing could clear. Once each is enough.
- **A refund is not a void.** A void says the payment never happened; a refund
  says it happened and then went back, and the customer's bank statement can
  tell them apart.
- **A check ships with the account**: unapplied receipts against 2520, as a
  fault.

**Caught while writing the ledger lines**: `fxCents` compared the *whole* receipt
against what the documents were relieved by, so a domestic $600 overpayment read
as a $600 exchange gain — inventing profit from a customer rounding up. The
wrong version would have balanced perfectly.

Verified on the demo: the same $8,000 now records as *"$600.00 more than was
owed is held as credit for them"*, the credit appears on **Money in and out**,
$400 of it settled a new invoice and $200 was refunded — and both control
accounts still agreed to the cent afterwards.

Two exports were deleted before commit rather than shipped: `describeCredit` and
`creditFor` were written, tested and called from nowhere — the exact pattern
Phases 48, 49 and 51 each found as a live defect.

### The letter that asks for money we are holding (Phase 54)

Phase 53 closed a real hole and opened two — and this phase fixes damage the
previous one did, rather than something that was always broken. Once a customer
could hold $600 of credit against a $900 open invoice:

- **The chase run** reads invoice balances and nothing else, so it would have
  emailed that customer a demand for $900. Phase 43's whole design is that these
  letters go out *without anybody deciding again*, which is exactly what makes a
  wrong one serious — nobody is in the loop to catch it.
- **The statement** computes its closing balance from open invoices, so the same
  customer would receive a document claiming $900 is due. That is a claim they
  can disprove from their own bank records.

- **Nothing goes out while anything is held**, decided on the customer's whole
  position rather than invoice by invoice. A customer holding $600 with two $500
  invoices owes $400 on net: chasing the older one for its full $500 asks for
  more than is due, and chasing neither leaves $400 uncollected for ever.
- **It is a pause, not an exemption.** Somebody has to decide where the credit
  belongs — apply it or refund it — and that is a person's call, not a
  scheduler's. Chasing resumes the moment the credit is nil, through all three
  ends: applied, refunded, or the receipt voided (Phase 52).
- **The statement keeps the gross and adds the net.** Replacing the gross would
  break its other job — a customer reconciling against their own purchase ledger
  needs to see what was *billed*. So it says both, plus a sentence.
- **Not netted into the aging report.** Aging is about receivables, by age, so
  somebody can judge how collectable they are; held credit is a liability on the
  other side of the balance sheet, and netting it in would hide it. A statement
  and a chase are different — both address one customer and claim what *they*
  should do next, and for those the gross is not merely unhelpful, it is untrue.
- **A saved statement is read back, never recomputed** — otherwise one sent in
  March quietly changes its mind in July, and "what did we tell them?" is the
  only question that list answers.

**The browser found two real things.** The sentence had no currency symbol —
*"1540.00 is due"* beside a table of `$` figures — and the payment form still
promised Phase 53's removed refusal: *"A payment for more than is outstanding is
refused."* Both fixed. The walk-through then recorded $29,500 against $29,040
outstanding, moved the customer's next invoice out of **Would go out today** into
**Not being chased** under *"we are holding credit for this customer"*, and read
Billed $2,000.00 / Held $460.00 / Asked for $1,540.00 on the statement — with
both control accounts still agreeing to the cent.

### The statement you could not send (Phase 55)

`statements.ts` has said since Phase 11 that *"what did we send them, and when"
is the first question in any collections conversation*. It was the one question
the data could not answer: **`sent_at` was written by nothing, in fifty-four
phases.**

`sent_to` was worse than a null column. `saveStatement` filled it in from the
customer's record at *save* time, and the board rendered it under a heading
reading "To" — so a business looking at that row would conclude the customer had
been told. On the demo books: five statements saved, four showing an address,
**zero sends**. Phase 54 then froze a sentence written for a customer who had no
way of ever reading it.

- **The customer's page is frozen, and the invoice page is not.** This is the
  one real design decision, and copying Phase 42 would have destroyed the
  document. An invoice link renders the live record — a customer chasing their
  own payables wants to know what is outstanding *now*. A statement is a claim
  about a **moment**, and it exists so two parties can reconcile against a fixed
  thing; a page that silently restated itself would mean they could never be
  looking at the same document. The email footnotes are inverted for the same
  reason: one promises the figure keeps up, the other promises it does not.
- **The token is per statement**, not per customer — otherwise whoever holds
  June's letter can read December's.
- **A link is not a letter.** "Get link" mints the token and deliberately does
  not touch `sent_at`, because recording it as a send would put back exactly the
  claim this phase removed. It is also what the refusal tells you to do when the
  customer has no address on file.
- **Sending needs `accounting:view`**, not `accounting:journal`. A statement
  asserts nothing new — every figure was frozen when it was saved, and saving
  already required that permission. Requiring more to post the letter than to
  compose it puts the gate in the wrong place.
- The migration **clears every address written against an unsent row**, and the
  column is renamed from "To" to "Sent". It reads *"Not sent"* until it goes.

**How it was found**: not in the browser, but by asking the database a question
the screen could not — `select count(*), count(sent_at), count(sent_to) from
customer_statements` returned `5, 0, 4`. The freeze was then tested the only way
that means anything: $1,540 was paid against the invoice the statement lists,
and the customer's page still read **due $1,540.00, billed $2,000.00** — exactly
what it said when it went.

### The balance that added currencies together (Phase 56)

Two defects on one column of the customers and suppliers screen, both live on
the demo books.

**It added currencies together.** `listCustomerSummaries` summed
`invoices.balance_cents` — the *document* amount — and the board rendered it with
`formatCents`, which defaults to USD. Bremen Hafenbau GmbH owes **€2,500**, worth
$2,708.75 on these books, and the screen said **$2,500.00**. A customer billed in
both currencies would have had their $1,000 and their €2,500 added to "$3,500.00"
— which Phase 35 called *"3,500 of nothing with a dollar sign in front of it"*
when it fixed this identical bug one query away, and left this one alone.

**It could not see held credit.** Phase 53 gave an overpayment a home and Phase 54
netted it off the statement and the chase; this screen — the one somebody opens
when the customer rings — still showed the gross. Both ADRs named it as the
follow-up.

- **The figure is the functional balance**, and the row says *"includes documents
  in another currency"* out loud rather than silently converting, so nobody
  quotes $2,708.75 down a phone to somebody holding a euro invoice.
- **The number is the net, with the gross beneath it** — the shape Phase 54 chose
  for the statement, for the same reason. On the supplier side the mirror is an
  unspent vendor credit, which overstates what is about to leave the bank.
- **The band follows the net, not the age.** A customer with a $900 invoice two
  hundred days old and $900 of their own money in `2520` is not somebody to
  chase; painting that row red sends a person to have the wrong conversation.
- **It composes `netPosition` rather than answering again.** "What does this
  party owe on net" was decided in Phase 54, and a second implementation would be
  two answers to one question. This module adds only the age and the wording.
- **`asOf` comes from the server**, because the board is a client component and
  an age computed from the reader's clock is one two people disagree about.

**How it was found**: by reading the query, then confirming against the books
before changing anything — `select currency, balance_cents,
functional_balance_cents` showed Bremen at `EUR / 250000 / 270875` while the
screen said $2,500.00. Afterwards the row reads **$2,708.75**, City Works
Authority reads *"They owe $9,400.00, oldest 106 days overdue"*, and Harborview —
owing $460 with a $460 overpayment held — reads **nothing due**.

### The statement run nobody has time for (Phase 57)

Phase 55's own ADR nominated this one: *"a scheduler that emails every customer
without anybody deciding again is the feature that most deserves its own phase,
with its own preview screen."*

Sending statements is the highest-leverage collections act a small business has,
for an unglamorous reason: **most late payment is not refusal.** It is an invoice
that fell behind a filing cabinet, went to somebody who left, or was never
matched to a purchase order. A monthly summary fixes all three without anybody
having a difficult conversation — and it is exactly the sort of repetitive,
unurgent, mildly awkward job that never actually happens.

- **A run creates the document, then sends it** — the real difference from a
  chase, which sends one that already exists. A statement has to be saved first
  because saving is what freezes the figures. So a failed send leaves a saved
  statement behind, which is right: that row is the evidence the business tried,
  and deleting it on a bounce would destroy the only record.
- **A customer whose money we hold gets one too.** The rule is an open balance
  *or* held credit — Phase 54's argument reaching the schedule. They are owed a
  refund or an application and only the business knows it, so the
  minimum-balance floor is exempted for credit: a floor stops trivial *demands*,
  and this is not one.
- **Once per period, enforced by the send itself.** Not a separate "already ran"
  flag, which can fall out of step with what went out, but `quietDays` measured
  against `sent_at` — the same state that records the first send, and a question
  only answerable since Phase 55 finally wrote that column. It also means a
  statement sent by hand on the 29th stops the run sending another on the 1st.
- **The day is capped at the 28th**, because later ones do not exist in seven
  months of the year and a schedule that silently skips February is worse than
  one on the 28th — the failure is invisible.
- **The preview is asked as if it were on, and as if today were the day.**
  Phase 43's lesson exactly: computed against the real policy, every row reads
  "switched off", or on 27 days a month "not the day", and the preview is empty
  at precisely the moment it is the whole point.
- **Its own settings table**, not more columns on `chase_settings`. Chasing is a
  demand about one invoice; a statement is a summary of an account, and plenty
  of companies want the second without ever wanting the first.

**The browser found the bug this phase claims to avoid, in this phase's own
code.** Opened on the 29th, the preview read *"Nobody is due a statement"* with
every customer under *"not the day of the month for the run"* — because forcing
the day to today is not the same as skipping the check, and `isRunDay` clamps to
28. Fixed, with two tests pinning the 29th.

Afterwards the preview earned its place at once: alongside Foxglove ($6,491.94)
and Bremen ($2,708.75) going out, it showed that **City Works Authority owes
$9,400 and has no email address on file** — a real finding about the demo books
no other screen surfaces. **Run it now**, pressed on the 29th with the run day
set to the 1st, declined honestly rather than forcing a send the schedule would
never make.

### Telling a supplier what a payment was for (Phase 58)

Phase 57's ADR nominated this one: *"the useful version is a remittance advice —
what a pay run just paid and against which bills."*

Phase 49 made one payment settle four bills. What reaches the supplier's bank is
a single line — `BACS 88213`, $12,054.00 — against a ledger carrying nine open
invoices, and they have to guess which. Guessing wrong leaves invoices showing as
unpaid, which produces a statement chasing money already sent, which produces the
phone call. Every figure needed to prevent that already sat in
`payment_applications`; nothing had ever pointed it at the person who needed it.

**Advise** on the payments board emails the supplier a link to `/r/<token>`,
which lists what the payment covered — **their** invoice reference first, because
`BILL-1005` means nothing on their side of the transaction (Phase 47). **Get
link** mints the same URL without claiming an advice was sent, which is also what
a supplier with no address on file is told to use.

**The advice is not frozen, and that is the whole design.** Phase 55 froze a
statement because a statement is a claim about a *moment* and the books move
underneath it. This is a claim about a *payment*, and a posted payment does not
change — so a snapshot table would only be a second copy of figures that cannot
drift.

**With one exception, and it is the exception that decided it.** Phase 52 made a
payment voidable, and reading live is exactly what lets the page tell a supplier
the money came back:

> **This payment was reversed.** The money described below came back, so the
> invoices it covered are outstanding again. Reason given: Paid the wrong
> supplier.

Verified in the browser end to end: advised Supply Depot ($6,200.00 against
BILL-1001), opened the supplier's page, took the payment back, and reloaded **the
same link** — which now leads with the reversal, strikes through the amount and
relabels it *Was paid*. A stored snapshot would have gone on insisting the
payment stood. It is the first public page in the system that changes what it
says after the fact, and it does so because the underlying fact changed.

Sending is gated on `accounting:view` rather than the permission that moves
money: telling somebody what they were already paid asserts nothing new.

### The pay run that half-happened (Phase 59)

`payRunAction` has paid suppliers one at a time since Phase 49, and the doc
comment above its loop said *"the message says how far it got."* It never did.
`paid` and `paidCents` were accumulated inside the loop and **thrown away by the
`catch`**, which returned *"That pay run could not be completed."*

So a business ticking eight bills across four suppliers, where the third failed,
was told the run failed while real money had already left its bank for the first
two — with no way to find out which. The ledger was correct throughout. The
message was wrong about the only thing that mattered: **what the person now has
to do.** It reads as "nothing happened, try again."

Pressing again is in fact safe — `payableQueue` only returns bills with a
balance, so a settled bill is no longer selectable — and there is a test pinning
that. But somebody told a payment failed does not only press the button again.
They ring the supplier, or key it into the bank by hand.

**A partial run is now a success with a warning.** Verified in the browser
against a supplier who had invoiced in both euro and dollars — one payment per
supplier is how the money leaves, and there is no single amount of money that
arrives:

> $6,200.00 paid — 1 payment, one per supplier, settling 1 bill. 1 supplier
> could not be paid, leaving $8,000.00 still owed: Cascade Building Supply (That
> payment settles documents in EUR and USD. Record one payment per currency).
> **The money above has gone — do not send it again.**

A run is also a **row** now, not a transient selection. Grouping payments by
date and reference afterwards would be a guess, and a run that paid *nobody* has
no payments to group — which is the case most worth keeping. **Pay runs** on the
What we owe screen shows each press of Pay, what became of it, and the failure
verbatim, because the sentence somebody reads a week later has to be the one the
domain wrote at the time.

**Advise all** then tells every supplier in a run what their payment covered —
the follow-up ADR 0058 nominated. It uses the same batch core as the pay run, so
the two cannot drift on what "partly worked" means, and a supplier with no
address on file does not stop the rest of the run being told.

There is still no transaction around a run, deliberately and unchanged: rolling
back would undo payments a business may already have sent from its bank. What
was missing was the honest report. The loop itself moved out of `src/app` into
`src/modules/payables/`, where a test can reach it — the one piece of behaviour
this phase is about was sitting in the layer this project keeps no logic in.

### The bill in euro that said dollars (Phase 60)

ADR 0059 recorded one figure as a known limitation — a pay run's "still owed"
added euro to dollars. Looking properly, it was not one figure.

`payableQueue` never selected `currency` or `functional_balance_cents` **at
all**, so every number on What we owe was computed from an amount whose currency
nothing downstream knew: the four bucket cards, the outstanding-in-total
headline, the per-supplier lines, the figure on the **Pay** button, the coverage
check against the bank, Phase 50's approval threshold, and Phase 59's still-owed.

And the row itself. A €4,000 bill rendered as **`$4,000.00`** with no marker of
any kind — the screen did not merely add wrongly, it did not know there was
anything to add. It is the defect Phase 56 fixed on the customers screen, except
that here there is a button underneath it that spends money.

The rule is short enough to state once, and every change falls out of it: **a sum
only means something when its terms are in one currency; a supplier is only owed
money in theirs.** So a bill carries both — `balanceCents`, which is what the
supplier is owed and what the row shows, and `functionalBalanceCents`, which is
the only figure allowed to be added or compared.

**A supplier with bills in two currencies now has no total at all** rather than a
wrong one. One payment per supplier is how the money leaves, and a single
transfer cannot be €4,000 and $1,000 at once. A converted total would be worse
than none: it is a number the business cannot actually send. `planRun` returns
those suppliers as `blocked` and the screen names them **before** the press —
Phase 47's rule — where Phase 59 discovered the same thing by trying and failing.

**The one that is not a wrong number but a control switched off:** Phase 50 lets
a company say "bills of $1,000 and up need approving, and not by the person who
entered them", and `approvalState` compared the bill's *document* amount against
that. At 1.08 a €950 bill is $1,026 — over the line, and `95,000 < 100,000` said
it was not. So a foreign bill above the threshold could be entered and paid by
one person, which is the exact thing Phase 50 exists to prevent. The comparison
is in the company's currency now, and the field is required rather than optional
so no future call site can quietly reintroduce it.

### The statement that told the customer a made-up number (Phase 61)

ADR 0060 nominated the chase queue for this check. The chase queue was indeed
wrong, and it was not the serious one.

`openInvoices` selected `invoices.balance_cents` — the amount the customer was
invoiced in **their** currency — and the statement added those together. Two
hundred lines further down the same file:

> The company's own currency, because every figure on this statement is the
> home-currency one (Phase 35) — including the balance the sentence restates.

It was not. A customer invoiced €1,241.94 and $5,250.00 was told they owed
**$6,491.94**: a number in no currency at all, with a dollar sign on it.

This is the worst place in the system for that to be true. It is not an internal
report — Phase 42 links the customer to it, Phase 55 emails it, and Phase 57
sends it **every month with nobody looking**. It is the one document the business
puts in front of somebody else and asks them to pay against, and a customer who
can disprove it from their own purchase ledger stops believing every figure that
comes after it.

**A statement now states a balance per currency.** Converting instead would give
a German customer a figure they cannot send, at a rate they did not agree, that
will not match their ledger. Verified in the browser end to end — saved a
statement for a customer with a euro invoice among dollar ones and opened the
customer's own link:

> **Billed and open in USD** $5,250.00
> **Billed and open in EUR** €1,241.94

**Held credit nets against the home-currency balance alone.** A payment carries
no currency column (Phase 58), so what a receipt had left over can only safely be
read as the company's own money — and setting a dollar credit against a euro
invoice would be this phase's own defect one level up. The foreign balance gets
its own sentence instead, because silence would leave somebody reading "nothing
is due" over a euro invoice three lines above it:

> €1,241.94 is outstanding separately, and payable in that currency. Any credit
> we are holding is in USD and has not been set against it.

The frozen statement **derives** its currency split from its saved lines rather
than storing a new column: a statement written before this phase has no currency
on its lines, and reading those as the company's own is exactly what it claimed
when it was written — which is what freezing is for.

And the nominated one: the chase floor is set in the company's currency, so
comparing an invoice's face value against it chased or spared foreign invoices on
the wrong number.

### The money that did not know its own currency (Phase 62)

ADR 0061 hit a wall it could not get past, and said so: *"nothing on the payment
records which currency that receipt was in."*

That was true, and it was not inevitable. `recordPayment` has done this on every
payment since Phase 35:

```ts
const paymentCurrency = await documentCurrency(ctx, input.kind, input.applications)
const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, ...)).rateMillionths
```

— known at the moment the row was written, used once, and **thrown away**. It is
the third time this project has found the same shape: Phase 55's `sent_at`
written by nothing, Phase 59's `paid` list discarded by a `catch`, and now this.
A fact the code has and does not keep.

The cost lands on `unapplied_cents` — money a customer overpaid — which five
queries sum across a party's receipts and read as the company's own money. A
customer who overpaid a €4,000 invoice by €500 was recorded as holding **$500**,
and told so on a statement.

So the payment keeps its currency now, backfilled from the documents each one
settled. **Netting follows**: `netByCurrency` composes Phase 54's `netPosition`
once per currency, so a euro credit meets a euro invoice and a dollar credit does
not — which is what the customer has already done in their own ledger.

Verified through the real path in the browser: recorded €3,000 against Bremen's
€2,500 euro invoice, confirmed the payment stored `EUR`, and opened the
customer's own statement link, which now reads

> Held for you **−€500.00** · Amount due **€0.00**

where it said `−$500.00`. The positions are frozen into the saved statement
alongside the held total, because the total alone cannot say which currency it
was in and Phase 55's rule is that a statement keeps saying what it said.

It also removes a second answer: `remittance-send.ts` derived a payment's
currency again as `bills[0]?.currency ?? company.currency`, agreeing with
`documentCurrency` by luck rather than by construction. Both go through one
function now, and the advice reads the stored fact.

**Two of the five, honestly.** Knowing the currency fixes the places that net a
credit against a *particular* balance. The customers screen, the statement run's
floor and the statements picker want one comparable figure across every currency
a party holds — that needs the payment's rate as well, and half-doing it would
put a converted number beside an unconverted one.

### The euro invoice you could not credit (Phase 63)

ADR 0062 named this one itself: *"Credit notes still carry no currency […] it is
the identical defect one table over and it deserves the same treatment."*

The consequence was worse than a wrong symbol. Since Phase 35, `refuseForeign`
stopped four operations **outright** — crediting an invoice, crediting a bill,
applying a credit, drawing a retainer — so a business invoicing in euro could not
issue a credit note to a euro customer at all. Not wrongly. The button errored.

It refused for an honest reason: for a multi-line document the functional amount
is the *sum of the converted lines*, not the conversion of the sum, and picking
either without deciding is how books acquire a drift nobody can explain.

**Nobody had to decide.** `createInvoice` decided it when it raised the document:
each line converts on its own and the total is their sum. A credit note reverses
a document, and reversing it by different arithmetic than raised it *is* the
drift. So the rule moves to one place — `functionalAmounts` in
`src/modules/fx/denomination.ts`, pure, with a test that proves the two really do
differ at a four-decimal rate — and a credit note becomes a document like any
other: `currency`, `exchange_rate_millionths`, `functional_total_cents`,
`functional_remaining_cents`, the shape Phase 35 gave invoices and bills.

The currency is **inherited, never chosen** — from the document being credited,
or the company's own for a standalone goodwill note. A €4,000 invoice is reduced
by €500, not by "$540 worth of euro"; the customer's ledger will show €500.

Applying a credit *across* currencies is still refused, naming both documents:
Phase 62's rule one document over. And `refuseForeign` keeps one caller — the
retainer draw — because that one is a **settlement**, not a reversal. It decides
at what rate held money discharges a new demand, which has a profit effect and is
an accounting decision, not arithmetic already made.

The backfill is trivially correct for an unusual reason: the refusal this phase
lifts guaranteed there was nothing to get wrong.

Verified through the real path in the browser — picked `INV-1021 — Bremen
Hafenbau GmbH — €4,000.00` from the credit picker (labelled `$4,000.00` before
this phase), issued the note, and confirmed CN-1003 stored `EUR` at 1.0835 with
a functional total of `$4,334.00` and a journal entry balancing to the cent.

**The browser found a defect the tests had not.** Applying a credit took
`remaining_cents` to zero and left `functional_remaining_cents` untouched, so the
screen offered $4,334.00 of credit that was already spent. Both halves now move
together through `relieveFunctional` — the invoice's rule, borrowed rather than
rewritten — and two tests pin it.

### The euro invoice you could not raise (Phase 64)

ADR 0063 named this at the top of what it did not do: *"a foreign invoice still
cannot be raised from the UI […] which makes this the next visible gap rather
than a hidden one."*

Phases 60 through 63 taught the payables queue, the statement, the chase decision
and the credit note to handle a foreign document properly, and a business that
invoices in euro could not create one. Same shape as Phase 41, which found
`createInvoice` written and tested since Phase 2 and reachable from no screen.

**Offer only what can be posted.** The composer's currency selector lists the
company's own currency always — a domestic document is not a conversion and needs
no rate — and a foreign one only where a rate exists. Offering EUR to a company
that has never recorded a EUR rate is a choice `rateFor` refuses the moment it is
taken, which is Phase 47's defect: a refusal behind a button. The selector is not
rendered at all when there is nothing to choose between.

**Say what it books at, before the button.** A document's rate is fixed at issue
and never recomputed, so the composer is the *last* moment the number can be
questioned — after that a wrong rate surfaces on a profit and loss a month later.
So it shows, live:

> €4,000.00 books as $4,334.00 at 1.083500, the rate of 2026-08-01. Fixed now and
> never recomputed, so the books keep saying what this was worth on the day.

It names the rate's own date, because `rateFor` walks backwards — an invoice
dated the 15th is routinely raised at the 1st's rate, and this is the only place
anybody is told which. Nothing is shown for a domestic document: "$4,000.00 books
as $4,000.00 at 1.000000" is noise that teaches people to stop reading.

The preview composes Phase 63's `functionalAmounts` rather than converting the
total, so it *is* the posting's arithmetic. A test quotes a three-line euro
document, raises it, and asserts the two agree.

**A missing rate is an answer, not an exception.** `rateFor` throws, and should —
a posting that cannot honestly convert must stop. But the composer is asking a
question before anybody has committed, so `quoteDocument` catches the refusal and
reports it, and the composer puts it on the row with a link to the rates screen
and disables the button. The sentence is `rateFor`'s own: a second one about a
missing rate would drift from the one a person sees when a posting is refused.

Verified through the real path in the browser: chose `EUR` beside a $4,000 line
and read the quote above; back-dated to 2020-01-15 and watched the row say *"No
EUR/USD rate on file for 2020-01-15 or before it"* with **Raise it** disabled;
put the date back and raised INV-1022 — `€4,000.00`, stored EUR at 1.0835, a
journal entry of $4,334.00 balancing to the cent, and `€4,000.00` in the invoice
list beside its dollar neighbours.

### The credit netted against a converted balance (Phase 65)

ADR 0062 named three sums that add currencies; 0063 and 0064 both left them open
for want of the payment's rate. Read properly the defect is sharper than that.
The customers screen builds a party's standing out of two sums:

```sql
balanceCents:    coalesce(sum(invoices.functional_balance_cents), 0)  -- converted
heldCreditCents: coalesce(max(held_credit.held_cents), 0)             -- face amount
```

and Phase 54 nets one against the other. Bremen Hafenbau, in the development
database: a €4,000 invoice carried at $4,334.00 and a €500 overpayment showed
**$3,834.00** due — `4334.00 - 500` — a figure that is not dollars, not euro,
and not what anybody owes.

**`recordPayment` already had what closes it**, and has since Phase 35: it
fetches `paymentRateMillionths`, uses it once and drops it, then computes
`heldFunctionalCents = received - applied` outright and drops that too. Phase 62
kept `paymentCurrency` from the line above these and left both behind. It is the
fourth time this project has found the same shape — Phase 55's `sent_at` written
by nothing, Phase 59's `paid` list discarded by a `catch`, Phase 62's currency,
and now this: **a fact the code has and does not keep.**

**One comparable figure, and the truth beside it.** Phase 61 rightly refuses to
total two currencies on a *statement* — a customer is owed money in theirs. But
"which customer is holding the most of my money" has an answer, and it is what
those receipts were worth when they arrived. So the figure is converted and the
screen says so, rather than quietly showing a conversion:

> €500.00 held. The $541.75 shown is what that was worth when it was received —
> it is repayable in the currency it came in.

Both halves move together on every draw-down and refund, through
`relieveFunctional` — the rule the invoice and the credit note already use — so
neither column strands a cent. That is the defect Phase 63's browser check found
on credit notes, caught this time before it shipped.

**The data caught a bug in the backfill.** Its first draft reconstructed the held
amount from `amount - applications`, and claimed $200.00 was still held on a
receipt that had been refunded — a refund leaves no application behind.
`unapplied_cents` is the only column that knows what is left now.

Verified in the browser on `/accounting/people`: Bremen now reads **$4,334.00
billed − $541.75 held = $3,792.25 due**, every term in one currency, with the
euro truth beneath it; Harborview's domestic $460.00 holding carries no note,
because there is nothing to explain.

### The retainer you could not draw (Phase 66)

`refuseForeign` stopped four operations from Phase 35. Phase 63 lifted three and
kept this one on purpose; ADR 0065 left it standing for the same reason. Both
were right — a retainer draw is a **settlement**, deciding at what rate money
already held discharges a new demand, with a real effect on reported profit.

**It is the receipt's rule.** A retainer is cash received and held, so drawing it
against an invoice is a receipt that arrived early — and `recordPayment` has
decided what happens then since Phase 35: `fxCents = applied − carried`. Neither
rate needed choosing. The retainer has been carried at the rate the money arrived
at and the invoice at the rate it was raised at, and the gap is a realised gain
or loss. What this phase decides is that it *is* the same rule, written once in
`settleHeld` rather than a third hand-rolled subtraction.

**A database check caught the first draft.** `settleHeld` originally took the
held money's rate and converted each draw; a €10,000 retainer drawn in three
parts would have taken its face amount to zero while the sum of three conversions
missed the functional amount by a cent — a liability saying money is held for a
client who has spent all of it. Both sides now come from `relieveFunctional`,
whose rule that the final relief takes the whole remainder is what stops either
side stranding a cent.

`retainers` gains `currency`, `exchange_rate_millionths` and
`functional_remaining_cents`. The currency is **chosen** rather than inherited,
unlike a credit note's — a retainer arrives before there is any document to
inherit from. A draw *across* currencies is still refused, sharing one function
with Phase 63's credit refusal for the comparison and for naming both sides.

**`refuseForeign` is gone**, with no callers left. A comment stays where it was,
because the shape is worth keeping: a refusal is not a permanent verdict, it is a
question nobody has answered yet, and the cost of removing one is a phase of work
rather than a wrong number for years.

Verified in the browser: took a €10,000 retainer (stored at 1.0835, posted as
$10,835.00), billed €1,485 of work against it, then — after moving the rate to
1.10 — billed €300 more and watched the entry come out as

```
Dr Unearned Revenue              $325.05
Dr Foreign Exchange Gain or Loss   $4.95   Exchange loss
Cr Accounts Receivable                     $330.00
```

the same $4.95 the unit test predicted. The picker reads **€8,515.00 left**,
where before this phase it would have said `$8,515.00`.

### The money you gave back at the wrong rate (Phase 67)

Two halves of one rule, and ADR 0066 named both of them.

**The operation that was missing.** A retainer could not be refunded — not in
euro, not at all. Money taken before the work is done sits on `2550 Client
Retainers Held` as somebody else's, and an engagement that ends with some of it
unearned left a liability nobody could clear and a client owed money the product
could not record returning. That is Phase 49's lesson again: a balance with no
way out is not merely inconvenient, it is a number that becomes wrong and stays
wrong.

**The operation that was wrong.** `refundCredit`, built in Phase 53 for a
customer's overpayment, posted the **face amount** on both legs with no
conversion. That was right while every holding was in the company's own money.
Phase 62 let a receipt arrive in euro and Phase 65 taught the column to carry
what it was worth, and this entry was left behind — refunding a €500 overpayment
put 50000 on a dollar ledger and released 50000 of a liability carried at 54175,
stranding $41.75 of somebody else's money on the balance sheet for ever.

Both are the same decision, and Phase 66 already made it. `settleHeld` takes the
liability out at what it has been carried at, pays the bank what actually left,
and realises the difference:

- `releasedCents` from `relieveFunctional` on the holding, so the last refund
  takes the whole remaining functional balance and the liability lands on zero;
- `paidCents` from the rate on the day the money left, because that is what the
  bank statement will say;
- `realisedCents` the gap, so `released === relieved + realised` by construction.

`retainer_refunds` keeps all three amounts and the rate. Storing only the face
amount would be Phase 65's defect over again — a fact the code has and does not
keep — and the reconciliation would have no way to tell $10,835.00 of liability
from $11,000.00 of cash.

`mayUse` has said *"Only 8515.00 is held"* since Phase 53. It now takes an
optional currency, so callers that know the answer say it and every caller
written before this phase keeps the sentence it had.

Verified in the browser: the time screen listed **€8,215.00 still held** for
Bremen Hafenbau GmbH, refused €99,000 with *"Only €8,215.00 is held for this
customer"*, and returned €1,000 with

> €1,000.00 returned to the client. €7,215.00 of the retainer is left. The rate
> moved since it arrived, so $16.50 is a realised exchange loss.

— the euro taken in at 1.0835 and given back at 1.10. `7100 Foreign Exchange Gain
or Loss` moved by exactly that $16.50.

### The money the supplier owes you back (Phase 68)

The last of the no-way-out balances ADR 0067 listed. A vendor credit posts
`Dr Accounts Payable / Cr Expense` when it is issued, and applying it to a bill
posts nothing — so an unapplied credit is a **debit sitting in payables**: money
the supplier owes back, netted against everything else the business owes them.
Right while more bills are coming; wrong for ever once the relationship ends,
because no bill arrives to apply it to and the credit quietly understates what is
owed to everybody else.

**The sign is decided by which side the balance is on.** Recovering a credit
debits the bank and credits the payable — Phase 66's settlement with the sides
swapped. Handing those amounts to `settleHeld` returns the right magnitude with
the wrong sign, *in an entry that still balances*, which is what makes it
dangerous rather than merely wrong. So the invariant is stated once, and it is
not about liabilities at all:

> `realised` is the debit side less the credit side. Positive credits the
> exchange account, because `Dr A = Cr B + Cr (A − B)` is the only way a
> three-line entry balances.

`settleHeld` and `recoverHeld` differ only in naming which amount is the debit.
Given the same pair they disagree, and both are right: **a euro that got dearer
is a loss on money you hold for somebody else and a gain on money somebody else
holds for you.** Phase 67 realised a $16.50 loss on exactly the rate movement
this phase realises an $8.25 gain on.

**One `refunds` table**, replacing the `retainer_refunds` Phase 67 created one
phase earlier. That phase was right that a refund is three facts and wrong about
the scope of the noun: it left three refunds with three answers to "where is it
written down" — a table, a bare journal entry, and nothing at all. A second
table beside the first would have made the split permanent, which the
vendor-credits module has warned against since Phase 12 about this very shape.
`direction` is a stored column, and a check constraint refuses a row whose three
amounts do not add up the way its direction claims.

**A refusal nobody can read is not a refusal.** Found in the browser: recovering
too much returned *"Something went wrong."* Only `DomainError` survives the
server-action boundary, and this module threw plain `Error` for all 25 of its
refusals — so every one had been invisible since Phase 12. Twenty-two are now
`DomainError`; the three that report a broken chart stay logged as unexpected.
The integration tests passed throughout, because they call the service directly
and never cross the boundary that ate the message.

Verified in the browser: a €2,000 vendor credit from Supply Depot, raised at
1.0835 and carried at $2,167.00, refused €9,000 with *"Only €1,000.00 is held
for this supplier"*, and recovered €500 with

> €500.00 recovered from the supplier. €500.00 of VC-1004 is left. The rate moved
> since it was raised, so $8.25 is a realised exchange gain.

`refunds` now holds both directions side by side — the retainer at `-1650` and
the recoveries at `+825`, on the same rate movement.

### The refund you could not take back (Phase 69)

ADR 0068 named it: Phase 52 taught payments to unwind, and none of the three
refunds could. A refund is the easiest thing in this system to key wrongly — it
is entered from a bank line, in somebody else's currency, on a day somebody
chooses — and €500 typed as €5,000 was **permanent**. The balance showed spent,
the ledger showed the money gone, and the only move left was a hand-posted
journal that fixed the ledger and left `refunds` still claiming it happened.

**A reversal looks nothing up.** This is the decision, and it is a refusal. A
reversal is not a new economic event: it does not say "the money came back today
at today's rate", it says *the refund did not happen*. So `reversalOf` puts back
exactly the three amounts the row already carries and takes no rate argument at
all.

That is only possible because Phase 68 **stored** `carried`, `cash` and
`realised` rather than deriving them. A reversal that had to re-derive would need
the rate on the original day, would round independently, and would leave a few
cents of permanent noise in `7100` every time somebody corrected a typo. The
column that looked like redundancy one phase ago is what makes the correction
exact.

**One function for three refunds**, which is the payoff of Phase 68 collapsing
three records into one table. A retainer given back, an overpayment returned and
a supplier's credit recovered are three operations to *record* and one to *undo*
— put the balance back, put the functional half back, void the entry, unwind the
gap. Written three times it would be three places for the sign to drift.

**The ledger half is a void, not a mirror.** The first draft of the schema had a
`void_entry_id` for a reversing entry; that would have given the books two
answers to whether the refund happened. `voidJournalEntry` marks the original
entry void and balance queries filter on posted — the ledger's way since Phase 2.

`refunds` also gains the `currency` it always knew and threw away: Phase 65's
defect a fifth time, noticed the moment a reversal had to print the figure back
to somebody.

Verified in the browser: the credits screen listed the €500.00 recovery against
Vendor credit VC-1004 with its $8.25 gain, and undoing it said

> Refund taken back. €500.00 is available again. The $8.25 exchange gain it
> realised is unwound.

`7100` went from $132.00 credit to $123.75 — that $8.25 and nothing else — and
the credit went back to €1,000.00 face / $1,083.50 functional, open again.

### One answer to four questions (Phase 70)

This codebase keeps refactoring out the same fault — **two answers to one
question**. Phase 70 is that fault upside down.

By the end of Phase 69 the words **"Take it back"** appeared on three screens
meaning three different things: withdraw a bill's approval (nothing posted, redo
it in a minute), void a payment (money comes back onto the books), and confirm
undoing a refund (money the other party already had). "Undo it" opened the third
of those, so one act had two words on one screen. Cancelling a document said
"Void"; unbanking a deposit said "Reverse". That is worse for the person holding
the mouse than the usual defect, because the four differ in exactly the way that
matters: **what they move.**

**One vocabulary, in one file.** `corrections/vocabulary` names all five
corrections once — the verb its button uses, what the confirmation is headed,
what the notice says afterwards, the prompt above the reason box. Nothing else
writes those words. The point is not tidiness: a screen *cannot* reuse a verb
that already means something else, because a test asserts the list has no
duplicates.

| Correction | Reach | The button |
| --- | --- | --- |
| Payment | moved money | Void the payment |
| Refund | moved money | Undo the refund |
| Invoice or bill | reached somebody | Cancel the document |
| Deposit | internal | Unbank the deposit |
| Approval | internal | Withdraw approval |

**Which corrections must say why.** `voidPayment` has insisted on a reason since
Phase 52 — *a void with no reason is a hole somebody has to reconstruct from
dates months later* — and for eighteen phases it was the **only** one that did.
The other four took none, so the same reasoning produced opposite behaviour
depending on which screen somebody was on. The rule, stated once:

> A correction that moved money, or that reached somebody outside the business,
> must say why. One that only rearranges what is on our own screens need not.

`reach` is its own field rather than a bare `reasonRequired` flag, so the next
correction has to answer the question that matters instead of copying a boolean
from the row above. Demanding a reason for the two internal ones would train
people to type "x", which is worse than not asking — an audit trail that looks
complete and says nothing. One given anyway is still kept.

The rule lives at the **action layer**, not in five Zod schemas. Phase 52 wrote
it into `voidSchema` and that is exactly why it never spread; the schema is now
back to `.optional()` and every action runs `reasonFor` and throws a
`DomainError`, so the refusal reaches the browser and the sentence somebody reads
when stopped is the sentence that asked them in the first place.

**One confirmation panel.** `components/correction-panel` is what all five
screens open, reading the verb and the rule from the vocabulary — so a screen
cannot ask for less than the action will insist on. "Never mind" closes every one
of them; it was "Cancel" on payments, which on a screen full of things that can
be cancelled is a fifth meaning nobody needed.

**Found by this phase's own test:** withdrawing an approval recorded itself under
the *same* audit action as granting one, `bill.approve`, distinguished only by a
`withdrawn: true` flag inside the payload. So "when was this bill approved" could
not be answered by asking for `bill.approve` — you got the withdrawal too. That
is this phase's defect sitting in the audit trail, where no amount of vocabulary
on the buttons would have found it. `bill.approval_withdraw` is now its own
action.

The workspace also moved onto the design canvas's palette in this phase: dark
chrome over a light workspace, blue for actions on white, and the lime kept for
the one place the design shouts. Lime at button weight on white is unreadable,
and a primary action nobody can read is worse than a less striking one.

Nothing in the ledger changed and there is no migration. What changed is what the
five corrections are called, what they ask for, and what the audit trail can be
asked.

### The record nobody could read (Phase 71)

The audit log has been written since Phase 3 — 224 distinct actions, each with
an actor, a time and a before-and-after payload. `historyFor` and
`recentActivity` have existed just as long, and **every caller of either is in
`tests/`.** No screen had ever shown one.

Two phases had spent real effort on facts that land there and nowhere else.
Phase 45 records a party's before and after on every edit — *"the whole reason
to prefer an update over a delete and recreate"* — so that "their email changed
on the 3rd, and Dana did it" has an answer. Phase 70 made five corrections
insist on a reason *"so somebody reading the books later does not have to
guess"*. Neither could be displayed. Phase 70 was half-built, and this is the
other half.

**`audit:view` is enforced for the first time.** It was declared in Phase 3 for
exactly this, granted to an owner and an accountant, and *reasoned about in
other modules' comments as though it were the gate* — the 1099 code keeps a tax
identifier out of the log because that table is "read by everyone with
`audit:view`". A precaution taken against a gate that was not there.

**You may read the history of a record you may read.** The company-wide feed and
one record's history are different questions, so `READABLE_BY` maps entity type
to the permission that opens that record — a bookkeeper keeps their
transaction's history without holding the key to everything. An entity type
nobody has placed falls back to `audit:view`, the strict end.

**One answer to "what happened to this record".** There were two
implementations: `historyFor` (no permission check, every column, unbounded) and
`transactionHistory` (gated, explicit columns). The careful one is why anybody
noticed the careless one; its rules moved into `historyFor` and it became a
one-line call. `ipAddress` and `userAgent` no longer reach a caller. `userId`
stays — it is the durable identity behind a display name, and the activity
feed's actor filter keys on it, because a log that quietly merges two colleagues
called Dana is worse than one with no filter.

**Words we have decided are used; words we have not are not invented.** The
tempting move is a conjugation rule over all 224 actions — which writes 224
sentences nobody checked and gets them wrong (`write_off` is not "write offed"),
in the log somebody is reading *because* something went wrong. So the five
corrections read their phrases from `corrections/vocabulary` — read, not copied,
so renaming a button moves the history with it — and every other action is shown
as its own name, rendered as the code it is. What was missing was never the
prose: it was the before-and-after diff, written for sixty phases and displayed
zero times, and the reason, lifted out so it leads the entry instead of sitting
seventh in a field list.

There is a history panel on the payments and the customers-and-suppliers
screens, and an **Activity** screen for the whole company. No migration; nothing
in the ledger moved. What changed is that what was already recorded can be read,
and that reading it requires being allowed to.

### The screen that showed what the permission withheld (Phase 72)

Phase 71 gave the audit log a reader without asking what was in it.

Three modules had already decided, independently, that certain values must never
reach that table — reasoning carefully about a reader who did not exist. The
payroll module records an employee without their rate: *"an audit log is read by
more people than a payroll record should be."* The 1099 code records **whether**
a tax identifier was set rather than what it was, *"because recording what it
was would put a tax number in a table read by everyone with `audit:view`."*

Other writers put exactly those kinds of value in freely, because there was
nothing to worry about. `payroll.post` carries a run's gross, net and employer
cost; the party editor wrote a supplier's tax identifier verbatim. Then Phase 71
built the screen.

```
manager has audit:view  : True
manager has payroll:view: False
```

Phase 9 wrote that gap deliberately and said why: *"the decision to show one
colleague another's pay is always deliberate."* Phase 71's activity screen showed
that manager every payroll event on the books. For a business with three people
on the payroll, a run's gross is a short step from one person's pay.

**The log keeps everything; a reader is shown only what they may know.**
Redaction belongs to the reader, not the writer — scrubbing writers would lose
facts an investigation needs and would do nothing about the rows already
written. Phase 71's `READABLE_BY` and Phase 72's guarded domains are **one**
registry, not two, because two tables answering "who may see this entity type"
is the defect this codebase keeps removing. Payroll needs `payroll:view`, tax
records need `tax:view`, and anything unplaced still needs `audit:view`.

The feed filters **in SQL**. Filtering afterwards would apply the `limit` first,
so somebody would get a short page of what they may see rather than a full one —
and a short page reads as "not much happened", which is a lie told by omission.

A secret value reads as **"set"**, not `••••`: a mask shaped like the value tells
somebody how long it was, and a reader shown asterisks reasonably assumes the
real thing is one click away. That it changed and by whom is the auditable fact;
what it changed to is not.

Two of the phase's own assertions turned out wrong, and both were the test
rather than the code: a manager's feed shows no supplier events either, because
a manager does not hold `accounting:view` — the rule working, not failing — and
Phase 71's "field that was emptied" test had used a tax ID as its example.

### The mark nobody looked at (Phase 73)

Two defects, and the second is worse.

**One thing, five answers.** The application named itself in five places and no
two the same way: the rail drew a lime square with "A+" typed into it, login had
an `<h1>`, the reset page a `<p>`, and the marketing header and footer a `<span>`
each. That is the shape this codebase keeps removing — Phase 70 removed it from
the words for corrections, and this removes it from the product's own name.

**The stale one.** `icon.svg` was a **teal `#0d6e60`** square with a white A, and
the web manifest painted its splash screen and status bar the same teal. Both
predate Phase 70's retheme by thirty phases, so the icon on somebody's home
screen belonged to a design this product stopped using long ago. Nobody noticed,
because a favicon is the one part of an interface its builders never look at.

**The name and the mark are named data.** `modules/brand/identity` holds the
name, the suffix, three colours and two paths. The colours are hex rather than
the CSS custom properties they mirror, deliberately: an `.svg` served to a
browser tab and a `.webmanifest` read by an operating system have no `:root`,
and a favicon that tried to resolve `var(--brand)` would render as nothing.

**One logo, two tones, one drawing.** The mark never changes between them — a
lime ground carries its own contrast. What changes is the wordmark and the
badge's hairline, which on the rail is `--chrome-line`, the token Phase 70's
stylesheet had already named "the badge hairline". The lime is type only inside
its own outline, which is why "PLUS" is a badge and not a word.

**The raster icons are generated**, from the same geometry, with Chromium as the
rasteriser. The script is a plain `.mjs` and cannot import a TypeScript module
behind a path alias, so it repeats the constants — the same defect one level
down — and the honest mitigation is a test that fails the moment the two copies
disagree.

**And `/favicon.ico` exists.** Found while verifying: every declared icon path
returned 200 and this one returned 404 on every page load — the one request no
page declares and every browser makes anyway.

### Whose letter is it (Phase 74)

Phase 73 nominated the two places the product names itself to somebody who is
not looking at a screen: an email subject and a PDF's `/Producer`. Grepping
`'Accountrix Plus'` found it in **six modules and sixty-eight pages**, meaning
**three different things** — and two of the three were defects.

**Ours.** The authenticator issuer, the password-reset subject, the invitation
body, the transactional `From:`, the actor on an automatic send, the PDF
producer. All correct: those letters *are* from us, and signing them with a
company's name would be the lie in the other direction — a reset that looks like
it came from your employer is one you cannot tell from a phishing attempt. Six
literals, now one `OUR_NAME`.

**Theirs, signed by us.** `campaigns.ts` ended its sender chain
`?? 'Accountrix Plus'` — on a **marketing campaign a business sends to its own
contacts, over its own unsubscribe link**. It read the optional
`company_profiles` table and never loaded `companies`, whose `name` is
`NOT NULL`. Two states reach the end of that chain and fail differently: a
company whose profile row is missing sent its marketing under *our* name, and a
company that **cleared the Legal name box** sent it from **nobody** — the box is
`.optional()` with no `.min(1)` and the form is controlled, so clearing it saves
`''`, and `''` does not trip `??`. That second one is the reachable one.

`modules/brand/voice` holds the rule: *a letter is either ours or theirs; ours
may carry our name, theirs never may.* `senderName` cannot return `OUR_NAME` —
blank is not a choice, and the chain ends at the company's own name.

**The fallback nobody chose.** `session?.companyName ?? 'Accountrix Plus'`,
written **seventy-seven times across sixty-eight pages**. It is what you write
to make the type checker stop: `currentSession()` is `Session | null`, and every
one of those pages calls `requireActor()` first, which redirects when there is
no session. The branch was never reachable — and it put our name in the one
place on the screen that answers *whose books am I in*, the account card at the
foot of the rail. So it is deleted rather than improved: `requireSession()`
returns a session or redirects, and seventy-seven fallbacks become
`session.companyName`. A defect that cannot be written beats one written
correctly seventy-seven times.

### The letterhead that was never on the letter (Phase 75)

Phase 74 nominated the thirteen Design Center boxes that save `''` when cleared.
Following them into the documents found something worse than a blank-handling
bug.

**The invoice had no letterhead.** It carried `companies.name` on the cover, the
same string in the footer, and nothing else from the profile but the payment
instructions — no address, no telephone number, no email, no website. On the one
document this application produces that a stranger receives, has to pay against,
and in most places has to keep. The company had typed all of it in; nothing ever
asked for it.

**And `documentFooter` reached the wrong document.** The schema calls it
"default footer language for generated documents"; its only consumer was the
footer of a marketing email. The seeded value is a contractor licence number —
the kind of text a trade is required to publish on the documents it bills with,
and it appeared on none of them.

**Four spellings of one question.** "What is this company called, and how do you
reach it" was answered four ways — and two of them sit in the same file thirty
lines apart, differing by one character: `profile?.legalName ?? company.name` in
the marketing preview against `|| company.name` in the proposal. `??` keeps `''`
and `||` does not, so with a legal name cleared the proposal was right and the
marketing preview showed a company with no name. The Phase 74 defect, still
live, one file over.

`modules/brand/letterhead` holds the rule: **a blank box is an unanswered
question, not an answer.** Every field is dropped when missing, null or blank;
a company that has filled in nothing gets its name and nothing else. The name
comes from Phase 74's `senderName`, so a document's masthead and the `From:`
line of the letter carrying it cannot disagree. The registered name heads it
(that is where a payment must go) with *trading as …* beneath (that is the name
the customer recognises), and the three contact channels stay separate, because
a PDF prints all three while the web page wants the email as a `mailto:`.

The same change fixed the customer-facing pages, which had a fourth, partial
copy of the shape — `{ name, email, phone, addressLine }` declared identically
in three modules, where `addressLine` was line one alone, so a customer got the
street and never the city. All three now take the whole letterhead. Doing it in
this phase rather than the next was the point: a full address on the PDF and one
line on the web page would have *created* a divergence in the same change that
removed four.

The tax ID is deliberately **not** printed. Publishing an identifier on a
company's behalf is not a decision to make from a box labelled "Tax ID" — and a
company that wants it on their documents already has the field for that, which
is exactly what the seed does with its licence number.

### The contract that named one party (Phase 76)

ADR 0075 nominated the proposal, whose letterhead is whatever its author
composed. Following that found the sharper version.

**A signed proposal named one of its two parties.** `proposal_acceptances`
records the client's side completely — signer name, title, email, the typed
signature, the version they were looking at, the network they signed from — and
the agreement text names them: *"on behalf of {{client.name}}"*. The company was
never named. A document that becomes a binding agreement identified the side
that signed it and not the side that would be bound by it.

**A second address formatter.** `merge-fields` had its own, reading four
columns where Phase 75's `addressLines` reads six. A company with a suite number
got it on their invoice and not in `{{company.address}}` on their proposal — two
documents from one business, disagreeing about where the business is. And
`company.legalName` resolved as `profile.legalName ?? company.name` while
`company.name` resolved by its own route: two offered fields, differently
derived, usually equal, with nothing making them stay that way.

So: `formatAddress` is deleted and `addressLines` lays out **anybody's** postal
address, a client's included. `buildMergeContext` takes the letterhead rather
than hand-picked profile columns, so every field the designer offers comes off
the object the invoice prints its masthead from. The name that was actually
being lost gets its own key, `company.tradingName`.

And the signature block draws *Offered by …* with the company's address,
opposite the client the agreement already names. It reads the **merge context**
rather than a new field on the block — deliberately: a new field would appear on
documents created from a template after today and on nothing else, while the
proposals most likely to be signed are the ones already composed. Snapshots do
not move; a proposal already sent keeps the bytes it was sent as.

### The parties nobody wrote down (Phase 77)

A signed proposal is a contract, and this application froze everything about one
except the two parties to it.

| Question | Where the answer lived | Did it move? |
| --- | --- | --- |
| What was offered | `proposal_versions.snapshot` | no |
| What the client looked at | the content-addressed PDF | no |
| Who signed, their title, their signature, the network | `proposal_acceptances` | no |
| **Which two businesses are bound** | a walk to live rows | **yes** |

The company resolved through `company_id` to `companies` and
`company_profiles`; the client through the opportunity to `organizations`. Both
are ordinary editable records — Phase 74 established that people rename a
company in the Design Center, and ADR 0045 made correcting a client a
first-class action. Do either, and every acceptance already signed reports a
contract with a party that did not exist when it was signed. It was the one
unfrozen fact in an otherwise carefully frozen record, and the fact a dispute is
about.

Phase 76 made it worse before making it visible: putting both parties into the
PDF meant the picture became right forever while the record still resolved
live, so the two could disagree.

`proposal_versions.parties` now freezes them in the transaction that writes the
snapshot and renders the PDF. A `Party` is `{ names, address }` rather than a
name plus a legal name, because the two sides disagree about which is which — a
company is registered as one thing and trades as another, while `organizations`
has one name and no registration at all.

**Nothing is backfilled.** The obvious backfill is a join to the three live
tables, which is the read this column exists to remove; it would write today's
names onto yesterday's agreements and make them look authoritative. Old rows
stay null and every reader says so.

### The client nobody could correct (Phase 78)

ADR 0077 nominated one line: `createOrganization` takes a city and a region and
no street, postcode or country, though `organizations` has all six columns.
Looking at the write paths found the larger shape — there were only ever three,
and **none of them was an edit**. The public lead form creates an organisation,
`createOrganization` creates one, and winning a deal sets its lifecycle stage.
There was no update service, no action and no form.

So an organisation created with a typo at lead intake kept it for ever, and the
only escape was a second record — which splits its opportunities, its proposals
and its timeline in two. That is the sentence `modules/parties/changes` opens
with, written in Phase 45 about customers. Phase 45 then built the whole
vocabulary for fixing it and gave it to `customers` and `vendors`; the CRM's own
record of who the client is got none of it. `'organization.update'` has been in
the audit action union since Phase 3 with nothing ever writing it.

Phase 77 raised the stakes: a client's name and address are now frozen into
every agreement they sign, so a typo is copied into the record of a contract and
kept there deliberately.

`ORGANIZATION_FIELDS` now sits beside the other two registries and
`updateOrganization` mirrors `updateCustomer` — a partial input so a form
showing six of thirteen fields cannot blank the other seven, and no audit entry
when nothing changed. `normaliseParty` and `auditable` moved out of
`receivables/service` to sit beside `diffParty`, rather than being copied a
third time.

**And the CRM can now read its own history.** Found while giving
`organization.update` a writer: six CRM entity types have written audit events
since Phase 3 and **none** was ever listed in `READABLE_BY`, so every one fell
through to `audit:view` — which `sales` does not hold. A salesperson could move
an opportunity, send a proposal and correct a client, then read the history of
none of it. All six are `crm:view` now.

### The teal that outlived the design (Phase 79)

An audit of every page against the Phase 70 palette came back clean, and that
was the interesting part. All 181 components under `src/app` and
`src/components` paint exclusively in design tokens — **not one raw Tailwind
palette class in the tree**, 348 uses of `.card`, 702 of `.btn`, and zero
hand-expanded copies of either. Sixty-six of the eighty-six pages sit in
`AppShell`; every one of the twenty that does not is deliberate.

The teal was in the frames around it. `#0d6e60` — the colour this application
stopped using nine phases ago — survived in eight places, every one somewhere a
stylesheet cannot reach: the `<meta name="theme-color">` a browser paints behind
its address bar, the offline page the service worker serves when the signal
drops, five column defaults, three separately-written default brand kits, a
form's nine fallbacks, and three float triples in the PDF writer.

**Phase 73 thought it had fixed the first one.** It repainted the icon and the
manifest, and the manifest loses: a browser prefers the meta tag for the page it
is on, so nothing anybody could see while the app was open had changed.

`modules/brand/palette` now mirrors all nineteen tokens in both schemes, and
`tests/palette.test.ts` reads `globals.css` and fails if one value disagrees —
which is what makes the copy safe, since the surfaces that need it are a meta
tag, a web manifest and a page that has to render with no stylesheet at all. The
offline page keeps an inline copy of the five tokens it uses; the two it
declared and never read are gone, because a value nothing reads is a value
nothing can notice going stale.

**The document default stays teal on purpose.** Those are the customer's
letterhead colours, not our chrome, and repainting them would change the
proposals of every company that never chose one. It is now written once, in
`DEFAULT_BRAND_KIT`.

**And a real bug fell out of counting the copies.** The sixth was three float
triples in `pdf/layout`, a hand conversion of the same hexes, all three drifted
by a digit. They fire when a stored brand colour will not parse — which looked
unreachable and was not: `isHexColor`, the guard on the only path a brand colour
takes into the database, accepts three-digit hex and `parseColor` took only six.
A company whose kit said `#fff` got a white document on screen and three
slightly-wrong teals on paper. `parseColor` now expands `#abc` to `#aabbcc`.

### The comment that was doing the escaping (Phase 80)

ADR 0079 nominated the check: widening a validator is the moment to ask who else
trusted it. The Design Center refused any colour that was not plain hex and said
why — *they land in a `style` attribute on client-facing pages* — and that
comment was the whole defence. The email renderer interpolates brand values
straight into `style="…"`, twenty-two times, none escaped, in a file whose own
rule is that every author string passes through `escapeHtml`.

**And the guard named five fields while the renderer used seven.**
`headingFont` and `bodyFont` were `z.string().max(200)` with no rule at all, so
a body font of `serif" onload="…` closes the attribute. The picker offers four
stacks; a server action takes whatever is posted.

Stated plainly, because it changes what this is: storing an arbitrary string in
those two columns was reachable, and the injection was not. `renderEmailHtml`
has taken a `brand` since Phase 5 and **nothing ever passed one** — a loaded gun
whose safety was that nobody had wired the trigger.

**Which is the finding worth the most.** A company sets its brand in the Design
Center, its proposals and invoices use it, and every marketing campaign this
application has ever sent went out in the default teal. Phase 74 stopped a
company's marketing going out under our name; Phase 80 stops it going out in our
colours. The send path loads the kit once per run and hands it over — and the
body font stays the email stack on purpose, because an email renders in Outlook,
which has no `system-ui`.

Wiring that caller is what makes the guard load-bearing, so it happens in the
same phase, after it. `modules/design/style-values` holds the rule as data —
`isHexColor` moved out of the service, a new `isFontStack`, and the registry of
every field that reaches a style attribute — and the renderer escapes anyway.
The test asserts the outcome rather than the guard: render with a hostile kit and
check the `<body>` tag still has exactly two quote characters.

**And the browser check found a third thing.** `messageFor` denies by default —
only a `DomainError` reaches a person — and the brand-kit guard threw a bare
`Error`. So the sentence it had been throwing since Phase 4, written for whoever
hit it, had never once been shown to anybody: the Design Center said *"Something
went wrong."* It says `Heading font must be a font list such as Georgia, serif.`
now, and the caption comes from the same registry the picker renders, because
naming the column beside a field labelled "Heading font" is the same defect one
level down.

**A correction to the section above (Phase 80).** The default brand kit was
written out seven times, not six. `DEFAULT_EMAIL_BRAND` is the same three colours again, in
a different type in a different module, which is how the Phase 79 sweep went
past it.

### The open redirect three comments said was not one (Phase 81)

ADR 0080 nominated this phase on a theory that turned out to be wrong — the
tracking round trip re-validates properly and always did. Checking the
nomination before building on it is the point. The defect was one layer up.

Every link in a campaign email is rewritten to `/api/track/:token?u=<url>`, and
`recordClick` put the destination through `safeUrl` before following it, under
three assurances that this closed an open redirect: one in the service, one on
the route, and **one as the name of the test for it** — *"re-validates the click
destination, so a forged link is not an open redirect."*

`safeUrl` confines a link to `http(s)` and `mailto`. That stops a `javascript:`
target, which is stored XSS and a different problem. It says nothing about
*which* https destination, and an open redirect is entirely a question of which.
`?u=https://phishing.test` satisfied all three. The test asserted only that
`javascript:alert(1)` is refused and called that open-redirect safety — scheme
safety read as destination safety, and the name made the mistake durable.

It took a recipient token, which is in the URL of every link in every campaign
email that recipient received. So anyone on a company's mailing list could mint
a link beginning with that company's real domain and ending anywhere.

The destination is now signed when the link is built and verified when it is
followed: a URL nobody sent is a URL nobody signed. **A link in an email already
delivered carries no signature and lands on the home page instead** — the same
treatment as a forged one, and the smaller cost.

**And a fourth copy of the signing secret was about to be written.**
`auth/session`, `auth/challenge` and `auth/secret-box` each read one from the
environment the same way, and `secret-box`'s comment says so. `lib/signing` names
the shape once, makes `challenge`'s `:mfa-challenge` domain separation the rule
for everything new, and keeps the session cookie on the bare secret — a suffix
would invalidate every cookie in a browser, and a refactor is not a logout.

`safeUrl` also now returns something that is a URL. `BARE_DOMAIN`'s tail is `.*`,
so `evil.com/x" onmouseover=` was prefixed rather than refused. Both sinks escape,
so it was never exploitable — but it is the Phase 80 shape again: a promise wider
than the guarantee kept.

### The header three comments described and nothing built (Phase 82)

ADR 0081 nominated the tracking pixel. Checking it first found three things
already right, which is worth recording because the absence of a defect is also
a finding: the reported "opened" figure already counts distinct recipients rather
than pixel fetches, `campaign_events` is swept under a Phase 24 retention policy,
and the unsubscribe page renders a confirm button rather than acting on GET.
What is left of that nomination — a pixel URL is a GET anyone can replay — is
inherent to the medium and is now a caveat rather than a fix.

One layer out was the real thing. `OutboundMessage` has carried
`unsubscribeUrl` and `unsubscribePostUrl` since Phase 5, and **three** comments
say they become the `List-Unsubscribe` headers: the field docs, the mock
provider's promise that a test can assert "including the unsubscribe header",
and the POST route's own header. No code anywhere built one. Two strings on a
type, called headers by prose.

That promise decides whether the mail arrives. Gmail and Yahoo have required
one-click unsubscribe from bulk senders since February 2024, and a campaign
without the headers is **filtered rather than refused** — the delivery rate falls
with nothing saying why.

**And the two field docs disagreed.** `unsubscribeUrl`'s said it goes in the
header; it must not. RFC 8058 has the client *POST* to that URI, and that field
is the confirmation page — whose whole purpose is not to change state without a
person pressing a button. A client posting there would unsubscribe nobody, and
the reader would stay subscribed believing they had left. `unsubscribePostUrl`'s
doc had it right, one field away.

The pipeline now builds the headers and the message carries them as a required
field, so an adapter passes them through verbatim instead of rediscovering RFC
8058 — and `listUnsubscribeHeaders` **throws** rather than omitting on a URL that
cannot go in a header, because a send that silently loses it fails invisibly.

### The bounce that was a failed API call (Phase 83)

`sendStep` had two outcomes, and called the unhappy one `bounced` — with the
provider's error string in `skipReason`, a column documented as *why a recipient
was skipped: no_consent, suppressed, no_email*.

Neither half was true. A provider refusing an API call is a **send failure**:
ours, usually transient, no reason to touch the address. A **bounce** is the
receiving server rejecting the message after the provider accepted it, hours
later — and that never reached this application at all.

**Five places had been waiting for it since Phase 5.**
`provider_message_id` is stored "for reconciling delivery webhooks later";
`recipient_status` has `delivered` and `complained`, both unreachable;
`campaign_events.kind` names bounce and complaint; `suppressions.reason` names
them too and only ever held `unsubscribe`; and `campaignStats` reports a bounce
rate. Five anticipations, no arrival — the schema playing the part the comments
played in Phases 79 to 82.

It matters because a hard bounce that never suppresses means the same dead
mailbox is mailed on every campaign, which is the fastest way to lose a sending
domain's reputation. Phase 82 got the headers right to reach the inbox; this is
what keeps a sender there.

A send failure is now `failed` with its own `failure_reason`. The delivery
callback has an endpoint that **fails closed** — a shared bearer secret with no
development fallback, because an unconfigured webhook loses bounce handling
while an unauthenticated one hands somebody a way to suppress a company's list.
And the judgement lives in a core rather than an adapter: a hard bounce
suppresses, a **soft** bounce does not (a full mailbox is temporary, and
silencing a real customer over one bad afternoon is the worse mistake), and a
complaint always does.

### The number that gets worse while nobody looks (Phase 84)

Phase 83 made a bounce a real thing and the rate measurable. Nothing watched it.

Phase 24 built a digest under a rule worth restating: *one message a day, with a
count, and nothing at all when the count is zero — silence has to mean
something.* A rising bounce rate is a fact of the same kind and a worse one,
because it is **the only failure in this application that gets worse while
nobody does anything about it**. A dead job is still there tomorrow, unchanged,
waiting. A sending domain is not: mailbox providers score a sender over weeks,
and by the time the symptom shows — campaigns quietly "not arriving" — the
reputation that has to recover has already been spent. Nothing errors. The mail
is accepted, delivered to a mailbox that rejects it, and filtered thereafter.

**A rate needs a denominator.** One bad address in a ten-recipient campaign is a
10% bounce rate and means nothing at all; a digest that woke somebody for it
would teach them to ignore the one that matters. Below a hundred accepted
messages `sendingHealth` returns **no verdict** rather than a reassuring one —
"we have not sent enough to know" and "we have sent plenty and it is fine" are
different answers, and showing the second when you mean the first is lying
quietly.

**The thresholds are the mailbox providers' own**, not numbers chosen to look
calm: 2% and 5% for bounces, 0.1% and 0.3% for complaints — Google's published
"stay under" figure and its ceiling. The watch level is deliberately below where
anything bad has happened yet, because the entire value of the number is the
weeks of warning it gives.

**The window is a week, not the digest's day.** A bounce arrives hours or days
after the send, so a rate over the last twenty-four hours of *sends* misses the
bounces those sends are about to produce and flatters itself exactly when things
are going wrong.

And the digest now speaks on `worthSaying` rather than a count, because a
reputation going bad **is not a count of anything — nothing failed**, which is
what makes it easy to miss. The rule is unchanged in spirit: still nothing on a
quiet day, still one message, and an urgent sending problem takes the front of
the sentence. It says the number and links to the page; it does not pause a
campaign, because a company's mailing list is its own.

### The culprit the digest could not name (Phase 85)

Phase 84's verdict is company-wide. The cause almost never is — one
badly-sourced list, one import from a conference badge scanner, one campaign to
a segment nobody had mailed in three years. The digest said the domain was in
trouble and left the reader to find which send did it, from a per-campaign
bounce rate that has existed since Phase 5 and that nobody opens until they
already know something is wrong. **Knowing to worry and knowing what to stop are
different facts, and only the second one can be acted on.**

**A culprit is a counterfactual, not a maximum.** Naming the campaign with the
worst rate is the obvious implementation and it is wrong in the way that
matters: the worst rate in any window usually belongs to the *smallest* campaign
in it. Three bounces out of eight is 37% and moves a four-thousand-message week
by four hundredths of a per cent. So the question asked is the one a person
actually has — *would we still be over the line if this campaign had not gone
out?* — and the materiality test comes free, because a campaign too small to
matter cannot move the number.

**Naming somebody has to be worth acting on**, which the unit tests did not
catch and the browser check did. Two equally bad campaigns plus a little clean
traffic makes both of them worse than the average they are pulling up, so one
was always named — and stopping it would have moved the rate from 11.9% to
11.8%. A culprit now also has to move a rate by at least one watch threshold's
worth. Where none does, the answer is **no name at all**: a uniformly bad list
has no culprit, and the biggest campaign in it is the biggest campaign rather
than the cause.

And **one definition of what a provider accepted**, found while writing the
per-campaign query. Three answers lived in `analytics.ts`, which is why the
disagreement was hard to see. `marketingOverview` was never revisited when Phase
83 introduced `failed`, so it counted rows a provider had *refused* as sent and
dropped the bounced rows a provider had *accepted* — wrong twice, and every rate
on the marketing dashboard was computed against it. There is now one list,
applied in TypeScript and in SQL, and it is an allow-list: a status added to the
enum and forgotten falls out of the denominator and makes the rates look worse
than they are, which is a false alarm rather than a missed one.

### The number written down where nobody reads it (Phase 86)

Phase 84 measures the reputation and Phase 85 attributes it. Both answer *how
bad is it now*. Neither answers the question a reputation metric exists for —
**is this getting better or worse** — and the two call for opposite actions. 3%
that was 1% last week is a domain sliding; 3% that was 6% last week is a list
somebody has already cleaned, and telling them to clean it again is telling them
to undo their own fix.

There was almost a history already, failing in three ways at once. The digest
has recorded its verdict in `background_jobs.result` on every run since Phase 84,
and that table is `NEVER_SWEPT` so nothing ever deleted it — but it stores the
**level**, so 2.1% and 4.9% are both `watch`; the quiet-day early return omits
sending entirely, so the record is blank on exactly the days that are the
baseline; and nothing reads it. The number was written down every night, in a
column nobody reads, without the number in it.

**Consecutive readings are not two measurements.** The rate is a rolling
seven-day window, so today's reading and yesterday's share six of their seven
days — a day-on-day difference is one day of new mail moving an average of
seven. A comparison reaches back a **full window**, where the two cohorts stop
overlapping and the difference is between two populations rather than an
artefact of a sliding average. Not the oldest reading either: a company with a
year of history is compared against last week, not last January.

**The counts are stored, not the rates**, because a rate is those numbers
divided and storing it beside them is a second answer to a question that has
one. And the reading is written **every day, including the good ones** —
recording only the bad days would build the very hole that makes the existing
accidental history useless, into a table whose purpose is to have none.

The operations panel can now be raised by the direction alone: every rate under
every threshold and still *"heading the wrong way"*. Phase 84 argued the value
of the number is the weeks of warning it gives; this is the first phase where
that is true, because until now the earliest anything could be said was the
watch threshold.

### The queue that asks one question (Phase 87)

Phase 18 built the firm's work queue — the one query here that legitimately
crosses tenants, written so it cannot be pointed anywhere but at the caller's
own live engagements. It reported **one signal**: the count of bank transactions
waiting to be categorized, which is the least urgent thing this application
knows about a set of books.

Since then it has learned to notice, one client at a time, that the books
disagree with themselves (Phase 33), that background work has given up and
letters have bounced (Phase 24), and that a sending domain is going bad and
which way (Phases 84–86). Every one of those outranks a backlog, and none was on
the page a firm actually opens. An accountant with twelve clients would have to
open twelve operations pages to find out which one needs them — **which means
they will open none.**

**A ladder, not a score.** A health score compresses incomparable things into a
number nobody can argue with, sorts by it, and hides which thing is wrong.
Concerns are ranked instead by *what happens if you leave it until next week*:
`wrong` (something gets filed that is not true) above `spending` (it is getting
worse on its own) above `stuck` (the machine gave up) above `waiting` (the
normal state of bookkeeping) above `unchecked` above `clear`. The array of rungs
**is** the ordering — there is no numeric severity, and weights only ever
compare two clients already on the same rung.

Two rules carried forward. **A count without an age is not a signal**: the
seeded practice's own client now reads *"66 waiting, oldest 92 days"* where the
old page printed `66` and a date in two columns and left the reader to subtract.
And **"never checked" is not "clean"** — a company nobody has examined gets
`unchecked`, never a green tick, the same distinction `sendingHealth` draws with
`null` rather than `ok`.

It is affordable only because of what came before it: the integrity register
writes one summary row per run and Phase 86 writes one sending snapshot per
company per day, so the two most valuable signals cost one indexed read each
rather than the four-query `health()` the single-company page runs.

### The digest that reaches the one person who cannot act (Phase 88)

Phase 24's daily digest goes to the memberships holding `company:manage`, and in
the permission matrix that belongs to **`owner` alone**. A practice engagement
grants `accountant` by default and is capped by the client, never above it.

So the digest reaches the client's owner and never the firm. The bookkeeper
engaged to keep those books — the person who would actually retry the dead job or
clean the bounced list — is told nothing, and the person who *is* told is the one
least equipped to act. Phases 84–87 built the ability to notice these things and
rank them across a roster; the one channel that reaches out to a person still
reached only the person who could not use it.

**One brief a firm, not one per client.** Adding practice members to the
per-company digest would wake a forty-client firm forty times a morning — the
noise failure ADR 0024 exists to prevent, multiplied by the roster.

**News, not state.** A client appears only when its rung is worse than the last
one *observed*. Broken yesterday and broken today is not news; a slide from
`waiting` to `stuck` to `wrong` is news on each of the three days. That is Phase
33's `newlyBroken` generalised from one company's checks to a whole roster, and
it reuses Phase 87's ladder rather than inventing a second ordering. The memory
records **every** client's rung, including the ones nothing was said about —
without that, a client that recovers and breaks again looks exactly like one that
was broken all along.

**Mail, not the push topic.** A push subscription is keyed on `(company, user)`,
so that route would deliver a firm's brief once per client. The better reason is
that a roster does not fit in a push notification: a per-company digest is one
sentence and belongs on a phone, a firm's morning list belongs in an inbox. The
letter is filed against **no company at all**, because a letter about twelve
clients does not belong on one client's record.

### The preference that assumed a company (Phase 89)

Phase 8 gave every notification topic a per-person switch, because **a channel
nobody can quiet is a channel that gets filtered to a folder** — and then the one
message that mattered is filtered with it. That switch is keyed on
`(user, company, topic)` with a non-null company, and every function that touches
it takes an actor naming exactly one company. The premise held for eight phases
because every notification belonged to a company.

Phase 88 made it false. The firm's brief belongs to a *practice*, so the one
channel arriving unannounced in an inbox was the one with no switch — and the
machinery could not be pointed at it, because there was nowhere to put the row.

**A preference names an audience**, exactly one of a company or a practice. Not a
nullable company: that makes "no company" a missing value rather than a different
owner, and two null-company rows are *distinct* to an ordinary unique constraint
— the trap `installGlobalSchedules` already documents for schedules, survivable
there only because it runs at deploy time. So the check constraint says exactly
one owner and the unique index is **`NULLS NOT DISTINCT`**, and the upsert stays
an upsert.

**A topic belongs to one kind of audience**, listed exhaustively as named data so
the next one has to choose deliberately. A company topic stored against a
practice is a row nothing ever reads — worse than no preference, because the
person set it and believes they are covered.

The switch is checked per person rather than per firm: one member wanting out is
not the firm wanting out.

### The decision nobody recorded (Phase 90)

Phase 8 built `notification_log` because **"why did I not get told about that"
needs an answer that is not a guess** — so every path writes a row, including the
suppressed one. Phase 88 broke the promise: the firm's brief travels by mail
rather than push, so a *sent* one left a letter in `transactional_messages` and a
*suppressed* one left nothing but a counter in a job result. Somebody who
switched the brief off in March and forgot could not, in July, find out that they
were the cause.

The tempting fix is to merge the two logs, and it is wrong. **They answer
different questions.** `transactional_messages` records a *transmission* — this
address, this provider, did the hop succeed. `notification_log` records a
*decision* — we chose to tell this person or chose not to, and here is why. A
suppression has no transmission at all, which is precisely why it fits in one and
not the other. So the boundary stays and is written down instead of assumed.

A log row now names an **audience**, the same exactly-one-owner shape Phase 89
gave preferences, so a firm-wide letter lands on no client's record. Two readers
share the table and neither can see the other's rows.

**The body is stored only when nothing else stores it.** A push message's text
exists nowhere else, so the row keeps it; a letter's text is already rendered in
`transactional_messages`, and a second copy is the two-answers-to-one-question
defect this project keeps finding — an edit to the wording would fix one and
leave the other lying. A `channel` column sits beside it so a reader can tell
*why* a body is null rather than assuming there was nothing to say.

The sentence a person reads lives in the core rather than a template, because two
screens now ask the same question and two templates is how they come to disagree.

### The letter nobody kept (Phase 91)

**A correction first.** The section above originally said a mail-backed
notification's text was "already rendered in `transactional_messages`". That was
false: the table held the subject, the address, the outcome and the provider's
id, and no body at all. `sendTransactional` composed the text, handed it to the
provider, and kept neither. The conclusion — no body on the log's mail rows —
survives on a better footing, *the body belongs to the letter rather than to the
decision about it*, but the argument given for it named a place that did not
exist. A wrong reason written down is more dangerous than none, because the next
person builds on it instead of checking it.

Nobody noticed for eighteen phases because every question asked of that table was
a delivery question — *did the mail go* — which the subject answers. Phase 90
made it a different question by telling somebody, on their own roster, that a
letter had been sent; the obvious next thing to ask is what it said.

**The body is what was said; the link is what it granted.** Keeping a letter
verbatim is not free, and the reason is in the renderer: it appends the action
URL to the text, and that URL is a capability in every kind this application
sends — a reset token, a join token, a signed invoice link. Storing the rendered
text would turn a year-long delivery log, readable by more people than were sent
the letter, into a store of live credentials. So the paragraphs and the footnote
are kept, the URL never is, and the action's **label** stands in its place.

Deliberately one rule rather than an allow-list of kinds that may be stored: an
allow-list is a thing to forget, and forgetting either loses a letter or stores a
token. A rule that holds for every kind has nothing to forget.

The decision row now names the letter it produced — the join Phase 90 left
unmade — with `ON DELETE SET NULL`, because retention sweeps letters at a year
and *"we told you, and the letter has since expired"* is a true answer while the
row vanishing is not. A suppression is refused a letter outright: it composed
none, so an id there would open somebody else's.

### The letter the timeline never read (Phase 92)

Phase 22 built the communications log to answer what `transactional_messages`
cannot: *what have we said to this client?* When a letter goes to an address the
CRM knows it lands on that contact's timeline, and the row has stored the
letter's id ever since. **Nothing ever followed the link.** Both readers used
that column as a boolean, and the entry's own body is null for a letter that
arrived — so the timeline could say "we sent them an invoice on the 3rd" and not
what the invoice said. Honest until Phase 91 kept the words; after that, just an
unfollowed join.

**Follow the link, never copy the text.** Writing the letter's body onto the
communications row would work and would be the exact defect Phase 91 is named
after. The reader follows the foreign key instead, as a correlated subquery
rather than another table in the from-clause — these readers already `or`
together three matches across two left joins, and a fourth table in that shape is
how a timeline quietly starts showing an entry twice.

**Two sources, never blended.** An entry can carry a *note*, what somebody here
wrote down, and a *letter*, what this company sent. One `body` field falling back
from the first to the second is wrong for a reason beyond tidiness: in a dispute
— the case a communications log exists for — those are different kinds of
evidence, and only one is something the customer also holds a copy of. So an
entry resolves to labelled parts, and a screen cannot render one without saying
which it is. A bounce shows both, note first, because the failure changes what
the letter below it means; a letter shows only on a system send, so words are
never attributed to a company that did not send them.

### The letter filed against nobody (Phase 93)

`recordOutboundMail` resolved an address through `contacts` — right for Phase
22's invitations and password resets, wrong for the letters this application
mostly sends. An invoice goes to the address on the `customers` row, and a
business that bills people it never courted has no contact for any of them. On
this repository's own seed data, **none of the five customers with an email
matches a contact**, so every invoice, statement and reminder appeared on
nobody's timeline. Phase 91 kept the words and Phase 92 read them; neither helps
a letter that never gets an entry.

**An address is not an identity.** One inbox can be a contact somebody met, a
customer who owes money and a supplier who invoices for plant hire — a firm that
both buys from you and sells to you. Resolving an address gives candidates, not
an answer, and the queries carry no `limit(1)` on purpose: the core has to *see*
a duplicate to refuse it.

**What the letter is says which party it concerns.** A fixed precedence would
file a remittance advice on a customer's record — evidence about a payables
relationship stored against a receivables one, which the next person to open that
customer reads as something we sent them about their own debt. `KIND_CONCERNS`
writes the mapping down exhaustively, so the next kind chooses rather than
inherits.

**The fallback never crosses the divide.** When the concerned party is absent it
falls back to a contact and nothing else, because a contact is a person rather
than a side of the books. Filing nothing loses an entry — the lesser harm,
because it is not *wrong*. The same reasoning settles a duplicate address: two
customers sharing one means filing on either is a coin flip, so nothing is filed.
A timeline that is quietly wrong is worse than one quietly short.

The database holds the shape too: Phase 22's "an exchange is with somebody" check
is widened rather than dropped, and a second check refuses a row that is somehow
both a customer's and a supplier's. On the customers and suppliers screen the
post gets its own **Post** panel beside Phase 71's **History**, because what we
*sent* a party is not what *changed* about their record.

### The address two customers share (Phase 94)

Phase 93's refusal to file when two parties of one kind share an address is
right, and silent. So the application detects a real data-quality problem and
tells nobody — the shape Phase 33's register exists to fix, whose own words are
that **a check nobody runs is not a check**. The lost filing is not the worst of
it: both accounts are chased at that inbox, both statements arrive there, and the
person reading them cannot tell which account either refers to.

**Across the sides is business; within a side is a defect.** Phase 93's insight
inverted, and easy to get backwards. One inbox that is both a customer and a
supplier is a firm that buys from you and sells to you, and flagging it would
raise an alarm on every such firm — which the register already warns is how an
alarm gets switched off before the day it matters. So the grouping is by side
*and* address together, in the core rather than as a filter afterwards.

Normalisation stops at case and whitespace, which are typing. Plus-addressing is
deliberately not collapsed: `accounts+ridgeline@` and `accounts+kestrel@` are
somebody splitting their post by account on purpose, and merging them would
report the tidy arrangement as the mess.

It is a **position**, not a fault — a parent and its subsidiary genuinely may
share an inbox — and it names the parties rather than counting them, because a
number with no name in it is a number nobody can act on.

**And a check that counts things no longer reports money.** Found in the browser:
the operations page rendered every disagreement as an amount, so two customers on
one email address displayed as *"$0.01 apart"* — not merely unhelpful but false,
in a register whose whole job is telling the truth about the books. A check now
declares its `unit`; counting checks say "worth a look" and leave the specifics
to their detail line. `banking.shared_ledger_accounts` had the same problem
unnoticed since Phase 40 and is fixed with it.

### The duplicate the screen could not see (Phase 95)

Phase 94's finding named the problem on a page somebody reads, and then stopped.
The person reading *"2 customers share accounts@cascade.test"* went to the
customers screen, found both records by hand, and decided which one the invoices
should have gone to with nothing in front of them but two names that look alike.
A finding nobody can act on decays into a finding nobody reads.

**A record with a document on it is history, and history is merged, not
retired.** One rule, deliberately not a ladder of cases. A customer nobody has
ever invoiced is a mistake — retiring it loses nothing. A customer with one
settled invoice from four years ago is evidence: archiving it does not delete it,
but the history stays attached to a separate identity, so *"what did this
business buy from us"* still has two answers. So `resolve` says **retire the
empty ones** when exactly one record has traded, **merge** when two or more have,
and **choose** when none has. Under `merge` nothing is offered — not even the
settled record Phase 56 would happily deactivate, because offering it would be
the application recommending somebody hide half a customer's history.

**It never says the two records are the same business.** They share an inbox;
that is all anybody knows, and it is why Phase 94 made this a position rather
than a fault. A test asserts the wording never reaches for *duplicate* or *the
same customer* — a claim that would be wrong exactly when getting it wrong
matters most.

The panel shows each record's standing above the advice, because *never invoiced*
is a fact somebody can check against the row two inches below it while *archive
this one* is a conclusion they would have to take on trust. No second query and
no second action: `PartySummary` has carried the whole footprint since Phase 56,
and archiving already lives on the row with Phase 56's refusal behind it.

## Deploying

For Vercel and Supabase, see **[docs/DEPLOY.md](docs/DEPLOY.md)**. The two things
that catch people out are both database connection details: the application must use
Supabase's *transaction* pooler on port 6543 (the direct host is IPv6-only and Vercel
cannot reach it), and migrations must use the *session* pooler on 5432 (DDL needs one
backend for the whole transaction). The code detects both and `npm run db:migrate`
refuses the wrong one rather than half-applying a migration.

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

# 7. In a second terminal, start the background worker.
#    Without it nothing scheduled runs: no campaign sends, no reminders,
#    no proposed entries. /settings/operations says so in as many words.
npm run worker
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
| `tests/drawer.test.ts` | **The drawer is counted.** Against a pure core: what a till should hold as float plus what was kept less what was paid out; a short one and an over one named by the same arithmetic; **the float kept on the expected side so a wrong float shows up on the day**; banking what was counted rather than what was expected; never retaining more float than is actually there; a drawer that paid out more than ever went in refused; and a figure the ledger cannot hold refused rather than quietly zeroed. Then against the database: **a float that moves petty cash into 1060 and earns nothing**, the account installed on first use, a till opened empty, **a second shift on one drawer refused by the database with the holder named**, two drawers open side by side, the module gate and the permission. **Cash at the counter landing in the open till rather than Undeposited Funds** with the change in no entry, **a card never entering a drawer**, a mixed tender split between the till and the batch, a fallback to Undeposited Funds with nothing open, **a refusal to guess between two open tills**, and the till that was named being used. A payout recorded with its reason and taken out of the drawer, and one with no reason refused. Then the count: **nothing posted to over-and-short when it balances**, **a short drawer posted rather than absorbed** and an over one as a negative cost, the drawer emptied when no float is retained, **a second count on a closed shift refused**, the drawer freed for the next shift, and what was counted kept unadjusted. And the eleventh check: agreeing with nothing open, after a float and a sale and a payout, **when a float is left in overnight** — the case that would have cried wolf nightly — and with a shut till and an open one counted together |
| `tests/fx.test.ts` | **A document is owed in its own currency.** Against a pure core: multiplying by a rate and rounding half away from zero; **parity leaving an amount byte-identical**, so no historical figure moves; a rate of zero or less refused; a figure the arithmetic cannot hold exactly refused rather than silently losing precision; a currency code checked for shape rather than against a list; and a rate typed with a **comma refused** rather than read as ten thousand. Then rates as facts: one per pair per day with a correction replacing rather than sitting alongside, **the lookup walking backwards only**, and a **missing rate refusing rather than guessing parity**. Then the documents: a euro invoice carrying both amounts, the ledger carrying only one, **the stored home total being exactly what posted**; a payment at a different rate **realising the gain into 7100** and a loss the other way; a payable's sign flipped; and a payment spanning two currencies refused. Then the exposure: restated at a closing rate, netted across receivables and payables, reported and **posted nowhere**, and refusing when the closing rate is missing. Then the relief rule: a part payment at the document's own rate, **the last payment taking the whole remainder so no cent is stranded**, and every path that reduces a balance moving both numbers — a **write-off on a foreign invoice allowed because it converts exactly**, a **credit note refused because it does not**, and a domestic invoice in the same company still creditable. And the twelfth check: agreeing when freshly raised, agreeing after a part payment within the cent it allows, and ungated because currency is not an industry |
| `tests/budget.test.ts` | **A plan, and whether missing it is good news.** Against a pure core: an annual figure spread across twelve months with **the four leftover cents placed rather than dropped**, a division that divides exactly, a negative budget carrying its sign, a weighted spread that still sums to the year and **hands the leftover to the months that lost most to rounding** rather than to January, a period weighted to zero for a business that shuts, weights refused when fractional or negative or the wrong number of them, a figure finer than the ledger refused, and a leap February measured without a table. Then the judgement: **under on revenue adverse and under on expenses favourable from the same −$500**, over read the same way round for all four account types, **exactly on plan called favourable rather than adverse**, and a percentage refused when the plan was nothing. Then the model: **no journal entry written, ever**, and the P&L untouched; all twelve months written including the zeros; a second budget of the same name in one year refused and a differently named revision allowed; a yearly figure and the months together refused; **approving one budget archiving the previously approved one** so the plan is never ambiguous; an archived budget refusing edits; clearing an account rather than budgeting it zero; the journal permission; and one company's plan off another's books. Then building from history: **last year copied month by month so the seasonality survives**, a flat uplift in basis points, and a source year with no trading refused rather than writing a budget of nothing. Then the comparison: a revenue shortfall named adverse and an expense saving favourable **in the same report**, the figures **agreeing with the Profit & Loss they are built on**, **an unbudgeted account reported as unbudgeted rather than 100% over**, a budgeted account with no activity reported fully unspent rather than dropped, **a section judged on its totals rather than by counting favourable rows**, whole months only, a year nobody planned refused, and the financial reports permission. And the two things browser verification caught: **the plan grid keeping income and cost apart** rather than adding revenue to rent, and **the unbudgeted total doing the same**. Plus the check this phase deliberately does *not* add |
| `tests/billing.test.ts` | **A schedule is a promise to bill.** Setting one up leaving **no invoice, nothing in receivables and nothing on the aging report**; Phase 11's cadence reused rather than reimplemented; a day of the month some months do not have refused, along with no lines, a negative price, an empty description and an end before the start; the journal permission; and one company's arrangements off another's books. Then the billing: a real invoice raised and **the second run doing nothing at all**, four months caught up in one run with an invoice each, **two runs racing for the same period and exactly one winning**, **nothing raised when the schedule would bill nothing** rather than a $0.00 document, and a schedule stopping on its end date rather than being deleted. Then what it produced: **ageing, reaching the control accounts and appearing on the aging report** — the Phase 31 lesson — the schedule's own payment terms on the invoice, and a manual schedule **claiming the period but waiting for a person**, then raising it once and refusing a second time. Then stopping: the invoices it already raised standing, a paused schedule raising nothing more, and **a resumed one not replaying the months nobody billed**. Then the forecast: each schedule walked on its own cadence, **posted nowhere**, automatic kept apart from what waits for somebody, stopped at an end date, a paused schedule left out, and the financial-reports permission. And the two things browser verification caught: **every overdue period on a manual schedule claimed rather than only the first**, the break still correct on a genuine conflict, and **an overdue period shown in the forecast rather than hidden behind the window** |
| `tests/integrity.test.ts` | Money arithmetic, chart-of-accounts consistency, split balancing, transfers, audit trail and undo |
| `tests/ledger.test.ts` | Balanced-entry validation, normal balances, derived postings, void and reversal, period locking, statements |
| `tests/reconciliation.test.ts` | Difference arithmetic, balance chaining, completion gating, locking and controlled reopen |
| `tests/receivables.test.ts` | Invoice and bill posting, payment application, overpayment rejection, aging buckets |
| `tests/crm.test.ts` | Stage transitions, probability tracking, consent-based marketing eligibility, conversion idempotence, win/loss maths |
| `tests/proposals.test.ts` | Optional-item pricing, send-time versioning, forward-only stage advances, view tracking, proposal-to-invoice |
| `tests/intake.test.ts` | Honeypot, rate limiting, log ceiling, origin allowlist, address truncation, key scoping and enumeration |
| `tests/design.test.ts` | Block validation, merge-field resolution, template composition, brand colour validation, clause versioning |
| `tests/acceptance.test.ts` | Server-side total recomputation, signature matching, expiry, double-acceptance, foreign item ids |
| `tests/marketing.test.ts` | Segment matching, contactability, link safety, email rendering and escaping, send-time consent, suppression, engagement tracking, unsubscribe idempotence, analytics — including **the same send count three ways**, a bounce counted as sent because it was and a provider's refusal not, and the window split by campaign with one company's sends out of another's denominators, tenant and role isolation |
| `tests/mobile.test.ts` | Replay safety under sequential and concurrent retries, fingerprint conflicts, key scoping and rollback, the outbox's ordering/superseding/backoff/classification rules, device revocation and session invalidation, receipt permissions and idempotent attachment, notification defaults and delivery outcomes, the proposal-acceptance push, a full offline session, and a regression test for the journal-numbering deadlock |
| `tests/jobs.test.ts` | Module resolution from pack plus override, workflow gating, terminology, the cost-code dimension end to end, budget vs actual, change-order approval posting nothing, application pricing and increments, retainage splitting AR from Retainage Receivable, the AR-control-equals-subledger identity, retainage release without double-recognizing revenue, WIP arithmetic, compliance expiry, and the no-forked-ledger reconciliation |
| `tests/payroll.test.ts` | The payroll identity and the arithmetic behind it, the entry's shape line by line (withholding never touching an expense account), negative net pay refused, voiding reversing rather than deleting, liability positions read from the ledger, over-remitting and kind/account mismatches refused, a remittance touching no expense, sales tax per jurisdiction with exempt sales and a frozen rate, an invoice pricing its own tax from its codes, contractor payments counted from payments not bills, a tax identifier never reaching the audit log, the manual adapter's refusal and the registry's absence of a fallback, illustrative runs marked in the database, the workpaper exceptions, and a filing blocked until its blocker is cleared |
| `tests/cash-basis.test.ts` | Splitting an amount without losing cents; an unpaid invoice as revenue on one basis and nothing on the other; a part payment split across the accounts it was raised against; instalments summing back to the whole; bills recognized when paid; transactions that were already cash left alone; the bank balance identical on both bases; both balance sheets balancing over busy books and agreeing once everything settles; and the three cases that broke the first implementation — a write-off's stranded receivable, a recovery's revenue, and a construction company's retainage |
| `tests/accounting-core.test.ts` | A credit note reversing revenue against a write-off keeping it; `written_off` never reading as `paid`; a write-off refused without a reason, over the balance, or twice; a recovery reversing the expense rather than recognizing revenue; credits applying without a second entry and never across customers; open-item and balance-forward statements; a write-off shown as a write-off on a statement; frozen saved figures; recurring cadences always moving forward and not skipping a month; a template refused if it does not balance; posting versus drafting; catching up with correctly dated occurrences and running twice changing nothing; and the close emptying period accounts into Retained Earnings, refusing a second time, warning about drafts, handling a loss, and reversing on reopen |
| `tests/worker.test.ts` | Backoff growth, cap, and upward-only jitter; concurrent workers claiming a job once; run-at honoured; dedupe dropping rather than stacking; dead-lettering and never sweeping a dead job; stealing an expired claim; priority; retry resetting attempts; the runner surviving one bad job in a batch; unknown kinds dying immediately; a tenant job with no company refused; a global handler getting no actor; heartbeat liveness; `nextRunAt` strictly after and across month rollovers; a due schedule firing exactly once; the outbox rolling back with its transaction, relaying idempotently, and `invoice.paid` on full settlement only; a scheduled task that cannot sign in and belongs to no company; and the draft entry that changes no report until a person posts it |
| `tests/statements.test.ts` | Account classification, including the two that look wrong and are right — accumulated depreciation in operating, and depreciation not being a timing difference; the cash flow statement reconciling to what the cash accounts moved, and an unpaid invoice as profit that is not yet cash; comparison windows including 29 February; an account surviving in only one column; a comparative balancing in every column; three cheques banked as one line, a processing fee, the same cheque refused twice, a deposit a fee has eaten, and a reversal making the receipts depositable again; a vendor credit reversing the cost on the bill's own account, a customer credit refused against a bill, and the two numbering series kept apart; an accrual not being an expense on a cash basis, an accrual settled straight from the bank still becoming one, a prepayment deducted when paid, a deposit taken in advance as revenue when it arrives, the transformation still balancing, and the caveat naming what it could not resolve; and a closed year reporting its drift rather than blocking the entry |
| `tests/security.test.ts` | TOTP against RFC 6238's published vectors, base32 round-tripping, ±1 step of drift and no more, a used code refused inside its own window, and non-numeric codes rejected; secrets round-tripping under encryption with a fresh IV each time and a tampered ciphertext throwing rather than decrypting to something else; enrolment not switching on until a code has worked, the secret never stored in the clear, recovery codes single-use and never stored in the clear and invalidated when regenerated, the password required to switch MFA off, and a working factor never silently replaced; the challenge token rejecting tampering, dying when the password changes, and expiring; the network kept and the host discarded, lockout after repeated failures cleared by a success and not extended by retries, and the window expiring; signing out everywhere else keeping this session, ending a device-less session a device sweep would miss, a password change ending every other session, the company session length honoured, and a forged cookie rejected; CSV quoting fields that would otherwise shift every column, an export an accountant could rebuild the books from, the export recorded in two places, a role without ledger access refused, and one company's export containing nothing of another's; and the policy refusing settings that would lock everybody out |
| `tests/inventory.test.ts` | FIFO taking oldest first against weighted average pooling, the parts summing to the whole across a thousand awkward quantities under both methods, consuming everything costing exactly the pool, a shortfall reported rather than thrown, receipt-date ties broken deterministically, and a return valued at what left; the subledger equalling the Inventory account after a busy month under both cost methods; the cost posting inside the invoice's transaction, a service line left alone, an empty shelf still recording the sale, and a return restored at its original cost while prices moved; a shortage booked to Shrinkage and not to Cost of Goods Sold, a count with no reason refused, a count that found the right quantity posting nothing, and a surplus valued at the current average; an order posting nothing, a receipt landing in Goods Received Not Invoiced rather than payables, a short shipment surfacing in the match, unbilled receipts itemised, and an order closing once every line is satisfied; and the guards — a service refused as stock, a negative cost refused, the module gate, and one company's stock invisible to another |
| `tests/timebilling.test.ts` | Rate resolution most-specific-first with zero treated as a rate and null as its absence; money computed from minutes rather than displayed hours, and the three-cent divergence demonstrated; every duration format people type; markup in basis points; utilization measured against time recorded; recording time posting nothing; a description and a sane duration insisted on; the draft/submitted/approved path; billed time refusing to be edited; written-off time kept with a reason; **two concurrent billings producing exactly one invoice**, a second attempt finding nothing, the invoice footing to the preview, unapproved and non-billable time left alone, a cut-off date honoured, and the rate frozen at what was billed; all four groupings footing to the same total; an expense posting nothing and billing at cost plus markup to its own revenue account; a retainer as a liability, drawn down without cash moving, capped at what is left and what is owed, refused across clients, and its cash-basis limitation asserted and named; unbilled work with its age; and the guards |
| `tests/assets.test.ts` | 756 depreciation schedules across every method, convention, life and awkward cost, each summing exactly to the depreciable base and ending on the salvage value with no zero-amount period; a half-year convention giving exactly half a year in year one and a mid-month one half a month at each end; declining balance front-loading and still landing on salvage, and the crossover removing the final lump; month arithmetic across leap years; registering an asset posting nothing, sequential tags, and salvage above cost refused; arrears charged to their own months rather than the run date, **a month that has not finished not charged**, the same period run twice charging once, two concurrent runs posting one set between them, one entry a month covering every asset, and an exhausted schedule marking the asset; **cost and accumulated depreciation both reconciling to the ledger** across several assets on different methods, and a disagreement reported when an asset was never posted; disposal charging the arrears first so book value comes from the ledger, a gain landing in Other income rather than Sales Revenue, a loss in Other expense, the asset leaving the balance sheet entirely, and disposal through the same account list the screen offers |
| `tests/dimensions.test.ts` | Code normalization, a parent from another dimension refused, and a retired dimension keeping its history; values attached at posting time, **each line of a two-site entry keeping its own value**, a value from the wrong dimension or another company refused; **every row's columns summing to the ordinary profit and loss**, checked against a report built by a different query; untagged activity as a column rather than an omission, the Unassigned column dropped when nothing is untagged, an unused value left off the page, and each site getting its own bottom line; coverage measured on gross movement so offsetting amounts cannot hide, reported only for dimensions marked expected, and null when nothing happened; reclassifying leaving the trial balance untouched, replacing rather than duplicating, clearing back to Unassigned, and silently ignoring another company's lines; defaults filling an unset dimension, never overriding a choice, the more specific owner winning, and replacing rather than duplicating; and balance-sheet movement by value with no equity row |
| `tests/importing.test.ts` | Quoted commas, embedded newlines, doubled quotes, CRLF and the byte-order mark Excel writes; the delimiter found by consistency so a tab-separated file of addresses is not shredded by its own commas; blank rows dropped, short rows padded, unclosed quotes and empty files refused; money in every shape an accounting package writes it, and **European notation, a comma that is not a thousands separator, and sub-cent precision all refused rather than guessed**; dates in five formats with the ambiguous ones settled by the row where it can and by a setting where it cannot, 31 February and 29 February in a non-leap year refused; a QuickBooks chart export mapped unasked, one header serving one field, missing required columns named; four hundred identical problems collapsed to one line; account types translated from what other systems call them and an unknown one refused; a duplicate account number refused, and an existing account's type never changed; contacts matched across `Acme, Inc.` and `Acme Inc` without merging `Acme Northwest` into `Acme North West`, a bad email warned about but imported, and an update filling gaps without blanking newer values; **a trial balance that does not balance refusing and posting nothing**, a balance for a non-existent account refused, a row with both a debit and a credit refused, a signed balance column read; **Opening Balance Equity clearing to exactly zero when the detail agrees**, and naming the $3,200 gap when it does not; an open invoice bringing its receivable without recognising revenue again; an unknown customer refused; ambiguous dates warned about across the file; undo removing only what it created, voiding entries rather than deleting them, refusing when an imported customer has since been invoiced, refusing twice, keeping the history, and one company's imports invisible to another |
| `tests/practice.test.ts` | A practice created without needing any company membership, only owners adding staff, and a firm found by name; **the practice refused when it tries to accept its own request and the client refused when it tries to accept its own offer**, nothing granted while one is pending, a second live engagement refused and a re-engagement after ending allowed; a membership for every practice member on acceptance, and the client's role choice capping the firm's either way round; **a practice member seeing one client's trial balance at a time across two engagements**, the switcher marking the current company, a switch into an ungranted company refused, and the session naming one company after switching rather than two; the switch recorded in the company being entered and attributed as "Dana Chen (Hartley & Co)"; the client ending it alone with the session resolving to null on the next request, the practice ending it alone, only the memberships that engagement created removed while a directly-hired bookkeeper survives, ending twice refused, and another company's engagement refused; leaving the firm ending access at every client at once and a new hire reaching every client immediately; **the cross-tenant work queue returning nothing for a practice the caller does not work at**, showing only that practice's clients, dropping a client the moment the engagement ends, and returning counts rather than rows; one company's engagements invisible to another; and **an engagement staffed `assigned_only` granting only the assigned** — a new hire reaching the whole-firm client and not that one, an assignment granting on the spot and unassigning revoking on the next request, an assignment's role narrowing while the client's cap still wins, an assignment under `whole_firm` granting nothing but surviving the switch that makes it matter, the preview counting what a switch would take before it takes it, switching a live client to nobody refused, staffing by somebody who is not a practice owner refused, assigning somebody who does not work at the firm refused, and an assignment for somebody who has left the firm entitling nobody; and **the roster asking the other questions** (Phase 87) — the client whose books disagree put above the one that is alphabetically first, a dead job seen without entering anybody's books, the sending reputation read from the daily snapshot, **a client nobody has checked reported as unchecked rather than clear**, and one firm's broken client still invisible on another firm's roster; and **the morning brief** (Phase 88) — one letter to each person at the firm rather than one per client, **nothing at all the second morning about the same trouble**, a further line when the same client slides another rung, **silence on a recovery and news again on the relapse**, one firm's trouble kept out of another firm's post, and the letter filed against no company at all |
| `tests/notify.test.ts` | **A transactional letter carrying no unsubscribe link**, in the type and at runtime; the URL written out in full so a person can read where it goes; a bounce recorded rather than swallowed; the hourly limit per address per kind, and an invitation not blocked by somebody hammering the reset form; tokens stored as hashes with only an eight-character prefix in the clear, **spent exactly once by two simultaneous claims**, a new one superseding the last, an hour for a reset against a week for an invitation, and old ones pruned while live ones survive; **the reset form saying the same thing whether or not the address exists**, and **reaching somebody who unsubscribed from marketing company-wide**; a reset changing the password, ending every session, and auditing into each company the person belongs to; the same link refused twice with the first password left standing; a link dying once the address is no longer theirs; a dead link reported before anybody types, and checking not spending it; **an invitation creating no user and no membership until it is accepted**, the offer shown before anybody types, the invitee's own password taking effect, a short password refused with the link still usable, **an existing account never asked for a password**, **one account created when the same link is clicked twice at once**, somebody already inside told rather than mailed, another company unable to withdraw the invitation by id, and a practice invitee landing with access at every client the firm already serves |
| `tests/evidence.test.ts` | Bytes addressed by what they are; both store adapters round-tripping, putting twice being a no-op, and deleting what is not there not being an error; **the same bytes uploaded twice returning the one document that already exists**, two companies sharing a blob and each counted, **one company deleting its copy leaving the other's downloading**, and the bytes going only when the last of them does; an orphan collected after a simulated crash between commit and free, and **bytes a document still points at never freed however far the count has drifted**; a type that can carry script, an empty file, and one over 10 MB all refused; one document on a transaction and a fixed asset at once with detaching one leaving the other, **three concurrent attachments of the same file leaving one link**, deleting a document taking it off every record, a page of records counted in one query, and the bare ones named; **a record from another company refused, a document from another company refused, and another company's bytes not served on a known id**; each kind of record guarded by its own permission, and a read-only auditor seeing the evidence and refused the removal; a note recorded and audited, an empty one refused, **a question on the work list until answered with the answer added beside it rather than over it**, one answer between two simultaneous clicks, a remark refused by the CHECK constraint, one company's questions invisible to another, and the list filtered kind by kind; and the mobile path uploading, attaching idempotently, reading back as an ordinary document, and keeping the phone's tighter limit |
| `tests/pdf.test.ts` | A structurally valid file with every cross-reference offset landing on its object; **the same input rendering byte-identically**, and the bytes changing when the date, the title, a brand token the document actually uses, or the base size changes; parentheses and backslashes escaped so a content stream cannot be corrupted; **real em dashes, curly quotes and ellipses rather than ASCII folding**, control characters dropped, and a glyphless character visibly `?`; the standard-font metrics including the typographic extras and Courier's monospacing; wrapping that fits every line and leaves an over-long URL alone rather than chopping it, keeping blank lines as the paragraph breaks somebody typed; truncation with an ellipsis; colour parsing with a fallback rather than a throw; page numbers only when asked and counted correctly, matched as a drawn string rather than a substring; a page break starting one page and two in a row not leaving a blank sheet; **all fifteen block types rendered**, with the figures coming from the caller and an unselected optional item shown and priced at nothing; merge fields resolved with nothing left behind for an unknown one; **the PDF filed against the version inside the send transaction**, **the bytes unchanged after the brand kit, the wording and the prices all move**, while a live preview does move; each version kept separately with the public link serving the newest; a proposal with no document sent anyway and reporting no PDF; another company's snapshot unreachable; **two identical sends stored once and shared by both versions** — against a pinned clock, because the PDF's timestamp has one-second resolution and the test was relying on both sends landing inside the same second; and an invoice rendered from the record with another company's refused |
| `tests/engagement.test.ts` | An exchange recorded with the client derived from the person spoken to, and a call logged against a contact or a deal appearing on that client's timeline; the day it happened kept rather than the day it was typed; an exchange with nobody and one with no summary refused, another company's client refused, and `crm:manage` needed to write against `crm:view` to read; **when each client was last spoken to, with a note to self not counted as contact**; **a letter the system sends landing on the timeline of the person it went to**, a bounce shown as such, nothing recorded for an address the CRM does not know, **a send never failed because the log could not be written**, and **the caller's transaction still usable after one fails**; a follow-up surviving with no owner and staying on the shared list, **closed once however many people click at the same moment**, a dropped one kept with its reason, reopened when it turns out it was not done, and what is late measured against a date rather than the clock; work refused to somebody who does not work here, a task about another company's client and an empty title refused, and one company's work off another's list; a client's follow-ups with the open ones first, **a follow-up raised on a deal belonging to that deal's client**; **what was closed listed with its reason and reopened from the same place**, work closed before the window neither listed nor counted, and one company's closed work off another's list; and the timeline merging what the system did, what people said and what is owed, **an open follow-up placed at its due date rather than when it was typed**, and nothing of another company shown |
| `tests/properties.test.ts` | Rent arithmetic against a pure core: a whole month charged exactly what the lease says without ever dividing, a tenancy starting on the 15th charged 17 days rather than 16 and one ending on the 10th charged to the 10th, nothing charged for a period the tenancy does not touch, February in a leap year and out of one, **a proration that rounds away to nothing raising no charge at all**, periods walked inclusively across a year boundary, and a due date that stays inside its own month; a property reportable the moment it exists with one Property dimension however many properties, two live tenancies on one unit refused while back-to-back ones are allowed, a unit occupied while let and available after, a property with somebody living in it refused retirement and kept rather than deleted once empty, and **the module installing the four accounts a pack that never had them cannot supply**; the industry gate, the terminology seam calling a customer a Tenant while the record stays a `customers` row, and one landlord's properties off another's books; **one invoice per tenancy raised against Rental Income**, **a period billed once however many times the run fires**, **one invoice between two runs fired at the same instant**, the first month prorated and the rest whole, an agreed-but-unstarted tenancy billing nothing, the month taken as a parameter rather than read from the clock, and the permissions on running against previewing; **a deposit as a liability with the profit and loss unmoved**, **a refund that is not an expense**, more refused than is held either way round, **unpaid rent settled without recognising the rent twice**, **a settled deposit kept off the undeposited funds list**, income recognised only when a deposit is kept for something unbilled, **what is held reconciled to account 2580**, a shortfall reported, every movement tied to the entry that posted it, and one landlord's deposits off another's reconciliation; a rent roll counting the empty flat, billed and outstanding per unit, and a unit held back for works kept in the denominator; and property-level reporting through the dimensional profit and loss, **seeing a roof repair this module never posted**, footing to the ordinary profit and loss, and **the rent invoice itself carrying the property tag** |
| `tests/funds.test.ts` | The restriction arithmetic against a pure core: **the lesser of what was given and what was spent** released in both directions, nothing released from an empty fund and nothing conjured from an overdrawn one, spending nothing treated as releasing nothing rather than as a shortfall, an endowment placed in the restricted column and refused release, **February refused March's money** while a month may spend what it was given in that same month, and release earned but not posted counted without being spent twice; a fund reportable the moment it exists with one Fund dimension, **the module installing the seven accounts a pack that never had them cannot supply**, the industry gate, the journal permission, **no way at all to edit what the donor said**, and a fund closed while it still holds money rather than the close being refused; **a pledge recognised as income the day it is promised** and sitting in Pledges Receivable rather than the bank, **no income at all posted when the money arrives**, instalments with what is still owed, more refused than was promised, a gift refused a second receipt, and an anonymous gift from a collection tin; **a release that leaves the year's income and net income exactly where they were**, the fund's balance down by precisely what it released, **one release per fund per month however many times the run fires**, **one release between two runs fired at the same instant**, the same donation never released twice across two months, **nor when the months are run out of order**, a fund never driven negative however much is spent, **an endowment's principal never released**, a preview that posts nothing by looking, the month taken as a parameter rather than read from the clock, and the permission on running against previewing; **spending counted from a bill this module never posted**, per-fund reporting through the dimensional profit and loss, and a supplier refund netted off rather than ignored; and net assets split into the two columns, moved from one to the other by the run with the total unchanged, **a donation belonging to no fund at all detected**, overspent funds listed with what they went beyond, an answer as at a date rather than as at now, and one charity's funds off another's books |
| `tests/manufacturing.test.ts` | The batch arithmetic against a pure core: a recipe scaled in one step rather than per unit then multiplied, expected wastage added on top of the drawing, a bill of materials that makes nothing refused, the whole cost divided over the good units, **scrap raising the unit cost while leaving the total alone**, the rounding handed back rather than dropped and always adding back to the total, a run that made nothing saying so instead of dividing by zero, **yield measured against the plan and scrap against total output** so a run stopped early is not confused with a run going wrong, and a component nobody expected reported beside one used heavily; material out of raw materials and into WIP, **costed from the lots and not from the item's planning figure or a BOM**, recorded as its own movement kind rather than as shrinkage, labour absorbed by crediting the expense so what is left is idle time, **work in process cleared to exactly zero on completion** with not one penny left behind when the cost does not divide, the finished goods a lot like any other, a scrapped run's cost landing on its survivors, **a cancelled run written off to overhead rather than back to the store**, a run that absorbed nothing refused completion, a finished run refused more material, and an empty store issuing nothing and saying so; a stored recipe exploded to a run size, one that makes something out of itself refused, one with no components refused, **the module installing the five accounts a pack that never had them cannot supply**, the industry gate, the journal permission, and one factory's runs off another's floor; and **the WIP register agreeing with account 1450** while a run is open and after it closes, stock split across the three stages, **three stages reported and not the whole chart of accounts**, a stage kept at zero rather than dropped when nothing has moved, **the inventory subledger still equal to the ledger with a factory in the middle**, a shelf not multiplied by the number of runs that made it, a run compared against what its recipe expected, no variance where there was no recipe, and what a run absorbed listed in the order it happened |
| `tests/pos.test.ts` | A day turned into lines by a pure core: a plain day balancing, **the gross booked and the fee debited separately so the deposit is never the revenue**, a short till named in Cash Over and Short rather than plugged into cash, a till that is over credited the same way, **"nobody counted" told apart from "counted, and exact"**, tips and tax kept off revenue entirely, discounts and refunds reported rather than netted into sales, **a source that contradicts itself surfaced and given its own account rather than absorbed**, and a day of several categories and tenders still balancing; a whole day posted as **one journal entry** with three lines, the same day and source refused a second time with **revenue not doubled**, **two importers racing for the same day and exactly one creating it**, a till and a marketplace both allowed to report the same date, **the module installing the accounts it posts to even off a pack that never had them**, a category pointed at an account that does not exist refused, an empty day refused, the module gate, the journal permission, what was sold and how it was paid for recorded, and one café's days off another's books; and afterwards **the profit and loss showing the gross with the fee as a cost**, **tips nowhere on it at all**, what is still owed to staff against what payroll has paid out **through a door this module does not control**, the counted cash banked with the shortfall where somebody will see it, and a disagreeing source posted anyway with the difference sitting in 1220 and **neither cash nor revenue touched by it** |
| `tests/appointments.test.ts` | The split against a pure core: two halves that **always add to the price** across a sweep of awkward prices and rates, the fraction of a penny named and attributed, a discounted service split on **what was charged rather than what was listed**, a nonsense rate clamped as the typo it is, service and retail split at their own rates, and a card that can pay **neither more than it holds nor more than the bill**; a practitioner refused a second place at the same time, **back-to-back slots allowed because the range is half-open**, two practitioners allowed the same hour, **a cancelled slot freed to sell again**, two receptionists racing for one slot and exactly one winning, an appointment that ends before it starts refused, the module gate, the journal permission, and one salon's diary out of another's; **a booking posting nothing at all** while the forward book is still counted, the whole fee booked as revenue with the share as a cost and **never netted**, retail through its own account at its own rate, completing twice posting once, **the rate that was agreed surviving a later rise**, a free visit completed without inventing an entry, **a no-show told from a cancellation** with neither posting, a no-show refused completion and a delivered visit refused un-delivery; and a sold card **on the balance sheet with revenue still at zero**, a redemption earning nothing a second time so one £65 haircut is £65 of income, **no change given in cash**, a card refused a second spend on the same visit, a card refused against a visit that has not happened, a duplicate card code refused, the cards **agreeing with account 2590** and a hand-written entry against it caught, what each practitioner is owed before and after payday, **the diary kept out of revenue**, and one delivered visit as one balanced five-line entry |
| `tests/vehicles.test.ts` | The ceiling against a pure core: **a tolerance applied to what was authorised and not to the quote**, so it does not grow with the overspend; the headroom and the overage as separate sentences; **the additional amount asked for rather than the new total**, so the allowance cannot compound; a ceiling rounded down; a nonsense tolerance clamped; and nothing authorised meaning nothing may be billed. An odometer accepted on its first reading whatever it says, the distance reported, **a car that has not moved told from one that has**, a reading below the last refused, the write refused without somebody asking for it, and a replaced instrument cluster recorded with an audit event when they do. **The history kept when the car changes hands**, a duplicate VIN refused, and one garage's cars off another's ramp. **An estimate nobody agreed to refused billing** with nothing posted, work priced past the authority but only the bill refused, **billing allowed once the customer says yes to the rest**, a tolerance that is not an open cheque, **every approval kept as its own row with who and how**, an approval withdrawn by a further row rather than by editing history, a withdrawal refused below zero, an over-authority order flagged on the board **without alarming about an estimate that has no authority yet**, an empty order refused, a cancelled order refused both more work and a bill, one bill however many times the button is pressed, the module gate and the journal permission. And **the bill split three ways with the shelf relieved for the parts** at what they actually cost, **the sublet's cost left to the supplier's bill** while its margin stays reportable, the shop's mix counting only what was billed, one balanced entry per order, **a part the shelf could not supply billed with the shortfall named**, a part line with no part refused, the odometer out recorded, and **a car leaving with fewer miles than it arrived refusing the whole completion** |
| `tests/control-accounts.test.ts` | **What the balance sheet says is owed, against the documents behind it** — the check that would have caught Phases 29 and 30 on their first day. An empty company agreeing; a delivered visit agreeing **and naming who owes it**, with the aging report able to see it too; a billed repair order agreeing against its keeper; **a walk-in billed to one house account** however many of them there are, rather than to nobody; **a hand-written journal entry against 1100 caught** with the difference named, because that is the one thing that genuinely breaks the agreement; payables checked the same way **without blaming receivables for one fault**; one company's control accounts out of another's; and **a gift card settling the invoice and not just the ledger**, so the two sides still agree at £15 after a £50 card is spent on a £65 visit |
| `tests/books-integrity.test.ts` | **The books checking themselves.** Every check in the register given a stable key, a module gate, a severity and a *meaning* — a number nobody can argue with is a number with no argument. **The three positions that legitimately differ classified as positions** and the other seven as faults, by name, so a reclassification has to be deliberate. Then: an empty company where **every register entry is accounted for, run or skipped, never silently absent**; a check skipped because its module is off and **absent from the findings rather than present and green**; the same check running once the module is on; **a hand-written entry against 1100 caught** with the difference and the severity; **a position that differs not counted as a fault**; **a check that threw recorded rather than swallowed**, as an admission and not an assertion, and not counted as a fault because nobody knows whether they agree; **the rest of the register still running after one check throws**, with the exploding one inserted first so a loop that stopped would report almost nothing; the permission; and one company's findings out of another's. On the record: a run and a finding written per check, the latest read back **with what it skipped**, **"never run" told apart from "nothing wrong"**, **when a difference started answered** across three nights, and a dry run leaving nothing behind. And the alarm: **everything broken reported on a first run**, **nothing said the second night about the same drift**, **a second different check speaking up**, silence when nothing is wrong, and the handler registered, scheduled daily, and **still writing the run down on the firing it says nothing about** |
| `tests/counter.test.ts` | **Change is not a transaction** — $50 against a $20 bill settles $20 and hands $30 back, with only the $20 posted. Against a pure core: **non-cash applied before cash**, because only cash can give change, so an $80 bill met with a $50 card and a $50 note charges the card $50 and takes $30 of the cash; **a card over the bill refused outright** with the amount and what to take instead, and every non-cash kind treated the same way; change taken out of the cash when a card covers part of it; **several notes collapsed into one payment** while each non-cash tender stays its own; under-tendering leaving the rest owing; an empty offer, a tender of nothing, and **a figure the ledger cannot hold refused rather than quietly zeroed**. Then against the database: the bill settled with **the money in the drawer and not the bank**, each tender recorded as its own payment, banked directly when somebody says where, part of a bill taken with the rest left owing, **a settled bill refused a second payment**, an over-charged card refused **with nothing taken at all**, the journal permission required, and one shop's till out of another's. And end to end: a visit delivered, billed, and paid with a $70 note — **$5 change, the invoice settled, Phase 31's control accounts still agreeing on both sides, $65 in Undeposited Funds, and the stylist still owed their $29.25**, because taking the client's money does not pay the staff |
| `tests/retention.test.ts` | **No policy naming a table that holds the books**, checked against the ledger, the audit log, the documents, the notes and dead jobs by name; every policy explaining itself in more than a line, each kind and each table named exactly once so there is one answer to how long; the cutoff measured from a date it is given rather than the clock, and null for the sweep that asks about reachability; sign-in attempts past the window deleted with the recent ones kept, **a second run deleting nothing**, a token held until well past its expiry rather than its issue, **an event that has not been relayed never swept**, **a lead that became an opportunity never swept however old**, and every policy run in one pass; **a journal entry dated 2019 still there after every sweep runs as at 2030**; the report counting what is held and what would go without deleting any of it; a handler registered for every schedule and a schedule for every handler the phase added, with housekeeping global and the rest per company; a dead job and a bounced letter found in one shape, **nothing at all on a quiet day** and nothing said about a sending reputation nobody has the volume to judge, **the digest speaking when the mail is bouncing though nothing failed**, **the send that did it named** and **nobody named when every campaign is as bad as the rest**, **which way it is going once two readings sit a window apart** with nothing claimed on one reading, **the day's reading written down on a quiet day too** and once however often the digest fires, one company's readings out of another's trend, a month-old bounce not reported as today's news, `company:manage` needed to see any of it, and one company's failures off another's digest; and overdue follow-ups grouped per person with the unclaimed ones counted apart |
| `tests/ai.test.ts` | The core-works-without-AI guarantee, cost arithmetic in micros, gateway ordering and schema rejection, quotas and ceilings, provider fallback, prompt versioning and rollback, permission-gated retrieval, human-in-the-loop approval and audit attribution, capability behaviour, tenant isolation |

```bash
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

### Backups

```bash
npm run db:backup           # pg_dump -Fc into ./backups, with retention
npm run db:verify-restore   # dump, restore into a scratch database, compare row counts
```

`db:verify-restore` is the tested half of spec §19's "tested restore
procedure". It never writes to the source database and drops its scratch copy
afterwards. Run it on a schedule beside the backup itself — a backup nobody has
restored is a belief, not a control.

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

26. **Design Center** — open the **Design Center**. The profile fills merge fields; the **Brand**
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

### Payroll and tax (Phase 9)

89. **The notice is in the product** — every screen under **Payroll & Tax** leads with the spec §19
    warning: this workspace records payroll and tax and posts the entries, it does not calculate
    withholding, move money, or submit a return. The person about to remit against these figures is
    the one who needs to know, and they will never open this README.
90. **Cost to the employer, not gross pay** — `/payroll` leads with $15,011.00, not the $14,056.00
    gross. The employer's own taxes are real money that never appears on a payslip, and a business
    budgeting off gross is short by them every month.
91. **Ask the adapter to calculate, and watch it refuse** — **Run payroll**, fill in the dates,
    press **Ask the adapter**. The default says *"This adapter does not calculate payroll. Enter
    the figures from your payroll provider's report…"* and drops you straight into the form to do
    that in. That is the honest default, not a degraded mode.
92. **See the entry before it posts** — enter a salary line and a tax-withheld line, then press
    **Show me the entry**. Step 3 is the journal entry itself: Dr 6500 the *gross*, Cr 2300 the
    withholding, Cr 2350 the net. Underneath, "Why it balances" shows the identity as arithmetic —
    what it costs the employer on one side, where that money goes on the other.
93. **Kind a line wrongly and the entry changes shape** — go back, switch the withholding line to
    *Employer tax*, and look again. The same total now debits 6550 as well, because an employer tax
    is a cost on top of gross while withholding is somebody else's money in transit. The totals row
    would have looked identical either way; this is the only screen where the difference shows.
94. **Try to remit more than is owed** — **Liabilities** shows what the *ledger* says, not what the
    runs say. Enter a wild figure and it refuses in money, naming the balance and the date:
    over-remitting drives a liability negative, which reads on a balance sheet as the agency owing
    *you* money and goes unnoticed for months.
95. **The kind and the account cannot disagree** — switch the remittance to **Sales tax** and the
    account list changes to 2200 alone. A payroll remittance against Sales Tax Payable balances
    perfectly and leaves both accounts wrong; the service refuses it, so the form never offers it.
96. **A remittance is not an expense** — record one, then check **Accounting → Reports**. The P&L is
    unchanged. The cost was recognised when the payroll ran; this settles a debt.
97. **Sales tax is priced from your codes** — **Sales tax** shows two jurisdictions at rates the
    company entered. The seeded invoice carries $328.00 split between them, and it foots to the
    ledger exactly: the invoice header and the per-jurisdiction breakdown come from one read of
    the codes inside one transaction.
98. **A rate change does not restate history** — the rate shown against each line is the rate *as
    applied*. Change a code's rate and the past quarter does not move.
99. **The uncoded-sales warning is a real gap, not noise** — the demo has $29,600.00 of invoiced
    sales carrying no tax code, so they appear on no jurisdiction's return. Most software would
    show a short figure and say nothing.
100. **What is stopping a filing** — **Contractors** lists Delta Electrical: paid $3,400.00, marked
     reportable, and *no tax identifier on file*. The figure was the easy part. That missing number
     is what actually stops a filing in January, when they no longer answer the phone.
101. **The pack refuses, and says exactly why** — **Workpapers** → **Prepare**. It refuses:
     *"This period has 1 unresolved problem: Delta Electrical: No tax identifier on file."* Then the
     override box appears, with a field for the reason — offered *after* you have read the blocker,
     not before.
102. **Clear it and prepare properly** — go back to **Contractors**, press **Add id**, enter one.
     Return to **Workpapers**: blockers reads 0, and **Prepare** succeeds. The exceptions that
     *were* found are frozen onto the filing alongside the figures, so a return questioned later
     shows what was known at the time.
103. **There is no "filed"** — a prepared filing offers **Record as filed**, which wants a date and
     a note saying where and with what reference. The status becomes *filed elsewhere*. The enum has
     no `filed` value at all, because this system does not submit returns.
104. **A tax identifier never reaches the audit log** — after setting Delta's, check
     **Settings → Audit**. The entry records `hasTaxId: true` and not the number. An audit log is
     read by everybody with permission to see it.
105. **Payroll is not implied by seeing the books** — add a bookkeeper and sign in as them. They get
     **Sales tax**, **Contractors**, **Liabilities**, and **Workpapers**, and no **Overview**, no
     **People**, no **Run payroll**. What people are paid is the most sensitive data a small
     business holds.

### Background work (Phase 10)

106. **Start it** — `npm run worker` in a second terminal. It logs each tick that did something and
     nothing when there was nothing to do. Stop it with Ctrl-C: it finishes the tick it is in
     rather than abandoning a job mid-flight.
107. **See that it is alive** — `/settings/operations` leads with how many workers are running and
     how many jobs each has done. Now stop the worker and reload after two minutes: the page turns
     red and says nothing in the queue will run. That is the whole reason this page exists —
     everywhere else, a dead worker looks exactly like a quiet one.
108. **A failure that stopped trying** — the seed queues one job whose handler does not exist. It
     is `dead` after a single attempt, not five, because retrying cannot conjure a handler back and
     burning an hour of backoff to rediscover that hides the real problem. The error names every
     handler that *is* registered.
109. **Retry it and watch it die again** — press **Retry**, then **Run a tick now**. Attempts reset
     to zero (somebody pressing retry has usually just fixed the cause), it runs, and it dies again
     because the handler is still missing. Honest rather than optimistic.
110. **The proposal a machine would not post** — under "waiting for a decision" is a WIP adjusting
     entry, written by a scheduled task. Open **Accounting → Reports** first and note the figures.
     Then press **Post it** and look again: *now* they move. Before you pressed it, the entry was
     balanced, validated, numbered — and counted for nothing.
111. **Discard one instead** — a draft can be thrown away; a posted entry cannot. Try **Discard** on
     something already posted and it refuses: "a posted entry is voided, never deleted."
112. **Who did it** — check **Settings → Audit** after posting. The draft was created by *Scheduled
     task* and posted by you. An owner's name never appears on an entry they did not post.
113. **The outbox, end to end** — pay an invoice in full from **Accounting**. A `invoice.paid` event
     appears on the operations page marked *waiting*; run a tick and it becomes *relayed*, with a
     notification job queued behind it. Pay one only partly and no event appears — "they paid some
     of it" is a balance, not news.
114. **It cannot come apart from the change** — the event is written inside the payment's own
     transaction. If the payment rolls back, so does the event. `tests/worker.test.ts` asserts that
     directly, because an event claiming something happened when it did not is worse than a lost
     notification.
115. **Pause a schedule** — the campaign check runs hourly. Pause it and it stops firing until
     resumed; the row says so plainly rather than disappearing.
116. **Two workers do not collide** — run `npm run worker` twice. They claim different jobs rather
     than the same one or blocking on each other, which is what `FOR UPDATE SKIP LOCKED` buys.
117. **Or no long-running process at all** — `npm run worker:once` does exactly one tick and exits,
     for a deployment whose scheduler is a container platform's cron. It calls the same `runOnce`
     the loop and the tests call, so there is no second behaviour to keep in step.

### The accounting core (Phase 11)

118. **The same books, read two ways** — **Accounting → Reports → Profit & loss**, then flip the
     **Basis** chip. Accrual shows $75,198.33 of revenue; cash shows $28,998.33. The difference is
     exactly what has been invoiced and not yet paid, and it is the number most small businesses
     actually file on.
119. **A cash-basis balance sheet has no receivables** — switch to **Balance sheet** on each basis.
     Accrual lists 1100 Accounts Receivable; cash does not list it at all. That is what cash basis
     means, and the page says so rather than leaving somebody to wonder where a figure went.
120. **Both of them balance** — the footer says "assets equal liabilities plus equity" on either
     basis. That is the property the whole transformation rests on, and it took two attempts to get
     right: see ADR 0011 for the retainage case that broke the first one.
121. **The caveats come from your books** — on cash basis the P&L carries a note about payroll
     timing and sales tax, because this company has both. A company with neither is not warned
     about them.
122. **Revenue is split, not lumped** — cash-basis revenue appears against 4200 Contract Revenue,
     not against a single "receipts" line. Reporting bank movements would have been far easier and
     would have produced a statement nobody can file from.
123. **Credit note or write-off?** — **Accounting → Credits & statements** puts the two side by
     side with what each does to the books. The seed has one of each: a mis-billed survey credited
     (revenue reversed, never earned) and a culvert repair written off (revenue kept, $2,400 in Bad
     Debt).
124. **Check the P&L for both** — the credited invoice is gone from revenue entirely; the written-off
     one is still in revenue with a matching Bad Debt expense. A company that wrote bad debt off as
     a credit note would show lower revenue, no bad debt, and no sign it had a collections problem.
125. **They paid after all** — press **They paid** on the write-off. It reverses the bad-debt
     expense rather than recognizing new revenue, because the revenue was recognized when the
     invoice was raised and never taken back.
126. **A statement a customer would recognize** — pick a customer and save an open-item statement,
     then a balance-forward one for the same period. Open-item lists what is unpaid; balance-forward
     carries a total in and out. A write-off appears as "written off", never as a payment.
127. **Saved statements do not move** — save one, raise another invoice, and look again. The saved
     figures are unchanged, because a statement regenerated from today's data is not the document
     the customer is holding.
128. **Recurring entries, and who decides** — **Accounting → Recurring & close** has two templates.
     The rent accrual posts automatically; the depreciation estimate is proposed as a draft. Both
     have caught up from January, each occurrence correctly dated.
129. **The drafts are waiting for you** — nine proposed entries sit at the top of the page, from the
     estimate template and Phase 10's WIP proposal. None of them affects a single figure until
     somebody presses **Post it**.
130. **Close a year** — the page defaults to *last* year, because closing the year you are still in
     is unusual. It shows revenue, expenses, and what would move to Retained Earnings, plus anything
     worth checking first.
131. **It will not close twice** — close it, then try again. Blocked, with no override: unlike a tax
     filing there is no reason that makes closing a year twice correct.
132. **Watch the balance sheet's earnings line empty** — before closing, equity carries "net income
     for the period (not yet closed to retained earnings)". After, that line is zero and Retained
     Earnings holds it. The balance sheet has shown it separately since Phase 2 precisely because
     this entry had not been written yet.
133. **Reopening leaves a trail** — reopen the year with a reason. The closing entry is voided, not
     deleted, so an auditor asking why Retained Earnings moves twice in January has an answer.

### The statements an accountant asks for (Phase 12)

134. **Run a cash flow statement** — **Accounting → Reports → Cash flow**. Three sections and, at
     the bottom, cash at the start of the range and cash at the end. There is no basis switch here
     on purpose: the indirect method exists to explain the gap between accrual profit and cash, and
     on a cash basis there is no gap.
135. **Find the depreciation add-back** — the seeded books carry a depreciation charge. It is the
     first line under operating activities, and no cash left for it. That line is not a rule applied
     afterwards; it is Accumulated Depreciation's own movement, negated.
136. **Check it against the balance sheet** — the closing cash figure equals the bank and cash
     accounts on the balance sheet for the same date. If it ever did not, the page would say so
     above the report rather than let you find out later.
137. **Compare two periods** — **Reports → Comparative P&L**, then *Same period last year*. Every
     account the two periods share appears once with both figures and a variance. Accounts with
     activity in only one of them still appear, with a zero and a dash where a percentage would be
     meaningless.
138. **Bank three cheques as one line** — **Accounting → Deposits** lists receipts that arrived and
     have not been banked. Tick them and watch the slip total: that is the figure the bank statement
     will carry, and matching it is the whole reason the screen exists.
139. **Add a processing fee** — enter one and choose Merchant and Processing Fees. The bank is
     debited for the net, the fee for its cut, and Undeposited Funds credited with the gross the
     customers actually paid. Reconciliation now has one line to match, not three.
140. **Try to bank the same cheque twice** — reverse a deposit, then include one of its receipts in
     two deposits. Refused by a unique index rather than a check, because two people clicking at
     once would both pass a read-then-check.
141. **Issue a vendor credit** — **Accounting → Credits & statements**, bottom of the page. Pick a
     bill; the credit defaults to that bill's own lines, so the cost comes back off the account it
     was booked to rather than into a "purchase returns" bucket that tells nobody which cost went
     away. Note there is no vendor *write-off* beside it, and why.
142. **The accrual that is not a cash expense** — post `Dr Rent / Cr Accrued Liabilities` dated
     today, then run the P&L for this month on both bases. Accrual shows the cost; cash shows
     nothing, because no money moved. Before Phase 12 both showed it.
143. **Then settle it from the bank** — post `Dr Accrued Liabilities / Cr Checking`. Now the
     cash-basis P&L shows the expense, on the account the accrual named, in the month the money
     left. Dropping the accrual and stopping there would have lost it permanently.
144. **Post into a closed year** — after closing 2025 above, post an entry dated inside it.
     **Recurring & close** now carries a warning naming the year, the number of entries, and how far
     net income has drifted from what was transferred to Retained Earnings. It is not a block:
     locking is the control that stops entries, and this only says the frozen figures no longer
     match the books.

### The security controls (Phase 13)

145. **Turn on two-factor** — **Settings → Security → Set up**. Add the secret to any authenticator
     app, then enter the code it shows. Note that it does *not* switch on until a code has worked:
     a mistyped secret cannot lock you out.
146. **Save the recovery codes** — ten of them, shown once. They are hashed on the way in, so the
     server cannot show them again even if you ask.
147. **Sign out and back in** — the password alone now lands you on `/login/verify` rather than in
     the books. Try navigating straight to `/bookkeeping` from there: you are sent back to the
     login page, because the half-signed-in state is not a session.
148. **Enter the wrong code** — refused, and recorded. Then enter a recovery code and watch it work
     once and never again.
149. **Read your own sign-in history** — every attempt, with what happened to it. Addresses are
     kept to the network only, not the exact host.
150. **Change your password** — the message tells you how many other sessions it just ended. That
     is the point: on its own a new password leaves whoever stole the old one still signed in.
151. **Require two-factor for everybody** — tick the company policy. A member without it can reach
     the security page and nothing else until they set it up.
152. **Export the books** — the whole chart of accounts, journal, transactions, customers,
     invoices, vendors, bills, and payments as CSV. Open `journal.csv` in a spreadsheet: it shows
     account numbers and names, and `1080.00` rather than `108000`.
153. **Check the export was recorded** — it appears under the button, and in the audit log. It is
     the broadest read anybody can perform.
154. **Prove the backup restores** — `npm run db:verify-restore`. It dumps, restores into a scratch
     database, compares every table's row count, and drops the scratch copy. Everybody has backups;
     the ones who lose data are the ones who never restored one.

### Inventory (Phase 14)

155. **Switch inventory on** — the retail, restaurant, manufacturing, e-commerce, and wholesale
     packs switch it on themselves; on any other pack, **Settings → Modules**. An **Inventory**
     workspace appears in the top navigation.
156. **Add an item and receive some stock** — the receipt posts `Dr Inventory / Cr Goods Received
     Not Invoiced`. Check the trial balance: the stock is on the balance sheet and Accounts Payable
     is untouched, because no supplier has invoiced yet.
157. **Raise a purchase order** — and note the trial balance does not move. An order is a
     commitment, not a transaction.
158. **Receive 96 of 100** — the order goes to *partial*, and the three-way match shows the four
     units that never arrived. That comparison is the whole control.
159. **Sell some** — put the item on an invoice. The cost of sales posts in the same transaction as
     the revenue, so the P&L shows a real margin rather than revenue with no cost against it.
160. **Watch the identity hold** — the banner at the top of the workspace compares the stock records
     against the Inventory account. They are computed separately, so agreeing is evidence.
161. **Count the shelf and find it short** — the difference goes to *Inventory Shrinkage*, not Cost
     of Goods Sold, and the count refuses to save without a reason. Stock sold and stock stolen are
     different facts.
162. **Sell more than you have** — it is recorded, and the shortfall is reported back. Refusing
     would teach somebody to record something else instead.
163. **Switch the cost method** — set `inventory_cost_method` to `fifo` on the company and sell
     again. FIFO follows what you actually paid, in order; weighted average pools it. The subledger
     still equals the ledger either way, which is the point.

### Time and billing (Phase 15)

164. **Switch time and billing on** — the professional-services pack does it itself; on any other,
     **Settings → Modules**. A **Time** workspace appears.
165. **Log an hour** — type `1.5`, `1:30`, or `90m`. The form echoes back what it understood, because
     `1:30` and `1.30` are an easy thing to confuse and an expensive one. Check the trial balance
     afterwards: nothing posted, because unbilled time is not revenue.
166. **Approve it, then look at "Ready to bill"** — the value of work done and not yet charged for,
     with the date of the oldest item. Two hours from last week is nothing; two hours from March
     means the billing is broken.
167. **Bill it** — pick how the lines are grouped and raise the invoice. Switch the grouping and
     raise it again on another engagement: the totals are identical, because amounts come from the
     entries rather than from the group.
168. **Try to bill it twice** — refused, because there is no approved unbilled work left. The
     protection underneath is stronger than the message: the update that marks time billed carries
     its own precondition, so two people billing at the same instant produce one invoice.
169. **Edit billed time** — refused. An invoice has gone to a client; correcting it is a credit note
     and a fresh entry.
170. **Write an hour off** — it needs a reason and it stays on the timesheet. Deleting it would make
     the engagement look more profitable than it was.
171. **Take a retainer** — it lands in *Client Retainers Held*, a liability. Check the P&L: no
     revenue, because none has been earned. Then bill some work against it and watch the liability
     fall without any cash moving.

### Dimensions and fixed assets (Phase 16)

172. **Open Accounting → Dimensions** — the demo ships a *Location* with two yards, deliberately
     only ~90% tagged. Read the coverage figure first: it is what tells you how much of the report
     you are entitled to believe.
173. **Read a row across** — Contract Revenue under North yard plus South yard plus Unassigned is
     exactly what the ordinary profit and loss shows for Contract Revenue. That is the claim, and
     the page computes it on every run rather than trusting itself.
174. **Look at the bottom line per column** — one yard is profitable and the other is not, which the
     company-wide figure hides completely. That is the whole reason to have dimensions.
175. **Tick some untagged lines and assign them** — then check the trial balance. Identical. No
     money moved; only which column it appears in. That is why reclassifying is allowed inside a
     closed period, and why it is audited anyway.
176. **Notice what is absent** — there is no balance sheet by location, and the page says why.
     Assets can be tagged and equity cannot, so one would have to be balanced with a number the
     business never transacted.
177. **Open Accounting → Fixed assets** — the reconciliation is first, above the asset list.
     Register cost against Fixed Assets, register depreciation against Accumulated Depreciation.
     Nothing else in the application can tell you these agree.
178. **Register an asset without posting it** — leave "already in the books" ticked, which is the
     normal case. Then look at the reconciliation: it now disagrees by exactly that cost, because
     you have described something the ledger has never heard of. That is the feature working.
179. **Run depreciation** — the months owed are listed before you post, each dated to itself rather
     than to today. Click it twice: the second run charges nothing.
180. **Dispose of something** — the form shows the projected gain or loss before you commit, and any
     depreciation still owed is charged to its own months first, so the figure comes from the ledger
     rather than from the schedule. A gain lands in *Other income*, never in Sales Revenue.
181. **Open Accounting → Reports → Comparative balance sheet** — two dates rather than two ranges,
     with net income shown inside equity because it is what makes the columns balance, and a line
     stating whether each one does.

### Bringing your books in (Phase 17)

182. **Open Settings → Bring in your books** on the demo company. It says no opening balances have
     been imported — which is honest, because Ridgeline was born inside the application. It does
     *not* say the opening position is complete, because that would be congratulating somebody on a
     migration they never attempted.
183. **Register a second company** and migrate it, in this order. Paste each file in turn:

     ```
     Account #,Account Name,Account Type
     1000,Business Checking,Bank
     1400,Timber and Materials,Other Current Asset
     4000,Joinery Sales,Income
     5000,Materials Used,Cost of Goods Sold
     6400,Workshop Rent,Expense
     ```
     ```
     Display Name,Main Email
     Harborview LLC,jo@harborview.test
     Cityworks Inc.,dana@cityworks.test
     ```
     ```
     Name
     Timberline Supply
     ```
     ```
     Account,Description,Debit,Credit
     1000,Business Checking,"25,000.00",
     1100,Accounts Receivable,"8,400.00",
     1400,Timber and Materials,"3,600.00",
     2000,Accounts Payable,,"5,200.00"
     4000,Joinery Sales,,"31,800.00"
     ```
     ```
     Customer,Invoice No,Date,Due Date,Open Balance
     Harborview LLC,INV-9001,01/15/2026,02/14/2026,"5,200.00"
     Cityworks Inc,INV-9002,01/28/2026,02/27/2026,"3,200.00"
     ```
     ```
     Vendor,Bill No,Date,Open Balance
     Timberline Supply,B-7781,01/20/2026,"5,200.00"
     ```

184. **Watch Opening Balance Equity reach zero.** After the trial balance it carries $3,200; after
     the invoices it swings the other way; after the bills it lands on nothing. That last figure is
     the whole migration in one number.
185. **Import only one of the two invoices** instead, and read the diagnosis: "the customer detail
     is $3,200.00 less than the receivables balance the trial balance reported." A non-zero Opening
     Balance Equity is never a mystery.
186. **Paste a file with real problems** — a bad account type, a missing number, a duplicate — and
     notice there is no Import button. Every problem is listed at once, because fixing them one
     round-trip at a time is how a four-hundred-row file takes an afternoon.
187. **Try a trial balance that does not balance.** Refused, and nothing posts. Check the trial
     balance afterwards: unchanged.
188. **Undo an import** from the history. The chart import comes straight back out; the customers
     say "in use", because invoices were imported against them and deleting them would take the
     invoices too.
189. **Look at the balance sheet of the migrated company** — it is exactly the trial balance that
     went in, with the receivable built from two named invoices rather than typed as a total.

### Accountant practice mode (Phase 18)

190. **Sign in as `robin@hartleyco.test`** with the same password. Robin owns no company at all —
     they arrive straight inside a client's books, with the header saying *acting for a client via
     Hartley & Co*.
191. **Open Practice.** Two clients, the transaction backlog of each, and the role Robin holds at
     each one — `accountant` at Ridgeline, `bookkeeper` at Kestrel, because the two companies made
     separate decisions. It is deliberately not dressed in any company's chrome: this page is about
     the person, not the books.
192. **Open Kestrel Joinery's books, then switch to Ridgeline.** Kestrel shows nothing to review;
     Ridgeline shows fifty-four. Ridgeline's transactions are not visible from inside Kestrel and
     never were — that is the isolation claim, and it is the reason every service in this codebase
     takes an explicit context.
193. **Sign back in as `owner@ridgeline.test` and open Settings → Who has access.** Three people:
     the owner who works there, and two from Hartley & Co, marked as such.
194. **End it.** Both accountants disappear at once, the engagement moves to Past, and the message
     says access stops on their next click rather than when their session expires. You did not need
     the firm's agreement — starting an engagement takes two signatures, ending one takes either.
195. **Invite them back.** Search for "Hartley", pick a role, offer access. Nothing is granted:
     the offer waits for the firm to accept, and the firm cannot accept on the client's behalf.
196. **Try it from the other side.** As Robin, request access to a company and watch it sit there.
     A firm cannot give itself the books.

### Transactional mail, reset and invitations (Phase 19)

197. **As `owner@ridgeline.test`, open Settings → Who has access.** Priya Raman is waiting to be
     accepted — an invitation the seed sent and nobody set a password for. The form above it has an
     email, a name and a role, and no password field at all. That is the phase.
198. **Open the invitation link the seed printed** (`/invite?token=…`) in a private window. It says
     which books, in what role, at which address, *before* asking for anything — an invitation that
     only says "you have been invited" gives nobody a way to notice it is for the wrong company.
199. **Choose a password and accept.** You land in Ridgeline's inbox signed in as Priya, a
     bookkeeper. Nobody else has ever known that password, and the audit log now has her name in it
     rather than the owner's.
200. **Click the same link again.** *That invitation has already been accepted.* The precondition is
     in the write — `WHERE redeemed_at IS NULL` — so two simultaneous clicks create one account.
201. **Go to `/forgot` and ask for a reset for `owner@ridgeline.test`.** The link is printed in the
     terminal running `npm run dev`, because the mock provider is the whole outbox in development.
     Then ask for a reset for an address that does not exist: the page says exactly the same thing.
202. **Open the reset link.** Choose a new password. Every session signed in as Dana ends — leave a
     second tab open on `/bookkeeping` and watch it land on the sign-in page — and the old password
     stops working immediately. Reload the reset link: it is spent.
203. **Withdraw an invitation.** Send one to any address, then withdraw it, then open its link. It
     is dead, and no other company could have withdrawn it: the query is scoped, so an invitation id
     is not a lever on somebody else's books.

### Attachments and accountant notes (Phase 20)

204. **Open Accounting → Fixed assets and click the paperwork count on the Ford F-350.** The dealer
     invoice is attached, with a remark explaining the five-year life and one open question about
     the extended warranty. The seed uploaded that invoice *twice* under different names; there is
     one file, because the second upload returned the document the first one made.
205. **Attach something of your own**, then attach the same file again to a second asset. The
     documents page shows one file used twice, not two files.
206. **Open Accounting → Documents.** Every file, how many records each hangs on, and the open
     questions across the whole company. A file attached to nothing is called out — that is one
     somebody uploaded and forgot.
207. **Press Remove on one record, then Delete on the same file.** Remove takes it off that record
     and leaves the file; Delete removes it everywhere it was attached and frees the bytes. The
     button says which it will be, and how many records it touches.
208. **Ask a question and then answer it.** The question stays on the list until answered, and the
     answer is added beside it rather than replacing it — what was asked is half of why the
     exchange is worth keeping. Try to mark a plain remark answered: the database refuses.
209. **Attach a receipt from the phone** at `/m`, then look at Accounting → Documents. It is the
     same document, in the same list, with the same delete path. Before this phase a receipt lived
     in a `jsonb` array on the transaction and appeared in no list at all.

### Server-side PDF and immutable snapshots (Phase 21)

210. **Open the client link the seed printed and press "Download the PDF".** A real PDF, rendered
     on the server — cover band in the company's colours, wrapped prose, the fee table with its
     optional items priced or struck, page numbers in the footer.
211. **Open Clients & Sales → Proposals.** Under the open proposal, the sent versions are listed:
     v1 in grey because it was sent before the document existed, v2 as a link to exactly what the
     client received. Click it.
212. **Now change something.** Open the Design Center, change the brand's primary colour, then open
     the designer and rewrite a paragraph. Reload the client's PDF link: **it is unchanged.** The
     web view beside it has moved; the file the client was sent has not.
213. **Send it again.** A new version appears with a new PDF carrying the new brand — and the old
     one still says what it said. Both are downloadable, side by side.
214. **Look at Accounting → Documents.** The snapshots are ordinary documents, listed with the
     receipts, each attached to the sent version it belongs to.
215. **Open an invoice PDF** from Accounting → Credits & statements: choose an invoice and press
     Invoice PDF. Rendered from the record on every request, not snapshotted — an invoice that was
     wrong is credited and reissued, and the ledger is the authority for what is owed.

### Communications and follow-ups (Phase 22)

216. **Open Clients & Sales → Follow-ups.** Three seeded promises: one late and high priority, one
     due later, and one nobody owns — the late one under **Late**, separately from the rest,
     because "three of these are late" is a different fact from "these are your next three". The
     line across the top counts open, late, due today, and the ones with nobody's name on.
217. **Put your name on the unclaimed one** from the dropdown beside it, then take it off again. It
     goes back to the shared list rather than nowhere: unclaimed is a state, not an omission.
218. **Press Done on the late one, then open "Closed this week".** It is there with what was said
     about it. Press **Reopen** and it comes back onto the list with its completion time cleared —
     a row that is open and carries a completion date is exactly what the CHECK constraint refuses,
     so the count and the list can never disagree.
219. **Press Drop on another one** and look in the same place. A dropped follow-up keeps its reason
     and sits beside the completed one, because both are finished — and it is recoverable by the
     same button.
220. **Open Clients & Sales → Clients and expand History and follow-ups on Summit Builders.** The
     two seeded exchanges, the automatic stage changes, and the outstanding follow-ups, in one list,
     newest first. Each client row says when it was last spoken to, or *never spoken to*.
221. **Log a call from that panel** — pick call, "They contacted us", one line of what was said. It
     appears immediately, and the row's "last spoken to" moves.
222. **Log an internal note instead.** It appears on the timeline and the "last spoken to" date does
     *not* move: a note to self is not evidence of having called anybody.
223. **Raise a follow-up from the same panel** with a date in the past. It appears on the timeline at
     its due date, and on the Follow-ups board under Overdue.
224. **Look again at Summit Property Group's timeline.** One entry there was written by nobody: the
     seed gives Alex Whitfield, the client's project manager, read-only access to watch the job, and
     the invitation filed itself against him. Phase 19 sent it; Phase 22 put it where the next
     person to ring him will see it. Priya's invitation, sent in the same breath to a staff address
     the CRM has never seen, is recorded as mail and appears on no timeline — which is the same rule
     working, not a different one.

### Property management (Phase 23)

225. **Open Properties.** Ridgeline is a contractor who bought the yard next door — the tab is there
     because the *module* is on, not because the industry is real estate, and the four accounts the
     real-estate pack would have supplied were created when the property was.
226. **Read the rent roll.** Two units, one let: `DEPOT A` to Foxglove Cabinetry, `DEPOT B` empty
     and marked so. The header says **50.0% let** and names the rent the empty unit is not earning.
     Occupancy is measured against units, so the void is a row rather than an omission.
227. **Open the Rent run tab.** Four charges, and the March one marked *prorated* — the tenancy
     started on the 10th, so 22 of 31 days. The billed total is $6,491.94: three whole months plus
     that fraction.
228. **Press the rent run for a month already billed.** *Nothing to bill — every tenancy already has
     an invoice for that month.* The seed does this once on purpose; the second attempt loses on a
     unique index rather than being filtered out and hoped over.
229. **Open Deposits held.** Register $1,750.00, account 2580 $1,750.00, **Agrees: Yes**. That is
     the figure a landlord has to be able to show, and it is derived from the movement rows rather
     than read from a column that could have drifted.
230. **Look at the balance sheet.** Tenant Security Deposits sits in liabilities at $1,750.00 and
     appears nowhere on the profit and loss. Take a deposit and check again: revenue does not move.
231. **Give one back** from *Take, return or keep*. Expenses do not move either — money that was
     never income cannot become a cost. Then try to return more than is held: refused, because the
     books would otherwise show a tenant owing the landlord their own deposit.
232. **Keep some instead.** *Kept, and recognised as income now* — the one moment somebody else's
     money becomes the landlord's, and only because nothing had billed the damage. Apply a deposit
     to an unpaid rent invoice instead and the message is different: the rent was already
     recognised, so the invoice settles and revenue stays where it was.
233. **Open Accounting → Dimensions and pick Property.** DEPOT has its own column, built from the
     rent invoices this module raised. Post a repair by hand against the property from the journal,
     and it lands in the same column — which is why there is no per-property report in the
     properties module at all.

### Retention and the scheduled work (Phase 24)

234. **Open Settings → Background work and scroll to "What is kept, and for how long".** Nine
     policies, each with its window, its reason, what it is holding, and what it would remove if it
     ran now. Six of them are marked *written by the public* — those are the ones where an attacker
     picks the rate.
235. **Read the panel's subtitle.** Nothing there can reach the ledger, the audit log or a document:
     the policy list is an allowlist and the suite fails if the books ever appear on it. A test
     posts an entry dated 2019, runs every sweep as at 2030, and checks the lines are still there.
236. **Look at Sign-in attempts: 90 days, 2 would be removed.** The seed writes two failed sign-ins
     from 2022 — the kind of row nobody ever looks at and which nothing had ever deleted.
237. **Press "Delete what the retention policy no longer keeps"**, then run a worker tick. The job
     queues, runs, and reports `{"removed": 2, "byPolicy": {"login_attempts": 2}}`. Reload: the
     count is zero and today's successful sign-in is untouched.
238. **Press it again.** Nothing is removed. Every sweep is a ranged delete on a cutoff, so running
     twice deletes once without needing to know the first run happened.
239. **Scroll up to "1 letter did not arrive".** An invitation to `jordan@ridgelien.test` — a
     mistyped domain — with the provider's own error. It has been recorded since Phase 19 and shown
     to nobody until now; the person waiting for it simply never heard.
240. **Look at the schedules list.** Four new rows: the nightly sweep, the daily follow-up chase, the
     rent run on the 1st, and the daily failure digest. None of them needed the feature it drives to
     change — the safety was built first, which is why scheduling could arrive last.

### Who at the firm is on which client (Phase 25)

241. **Sign out and sign in as `robin@hartleyco.test`, then open Practice.** Below the client list,
     *Who is on which client*: Kestrel Joinery is marked **assigned people only** and Ridgeline
     Construction **the whole firm**. Both engagements were accepted the same way; the difference is
     the phase.
242. **Press "Who is on it" under Kestrel.** *Only the people named below can open Kestrel Joinery's
     books.* Robin holds `bookkeeper` — their firm default is `accountant`, narrowed by what Kestrel
     agreed to. Sam Okafor works at the firm and shows **no access**, which before this phase was not
     expressible at all.
243. **Read the number beside "Open to the whole firm": *1 more person would gain access.*** The
     count is computed before the button rather than reported after it — a permissions change nobody
     could see coming is one somebody reverses in a panic.
244. **Press "Put on" beside Sam, then "Take off" again.** *On the client, and able to open their
     books now*, then *Taken off. Their access stops on their next click, not when a session
     expires.* The membership row goes in the same transaction, and `resolveSession` has re-read the
     membership on every request since Phase 13 — nothing new was needed for revocation to land.
245. **Open Ridgeline's panel instead.** Everybody at the firm is listed with access, and Sam's
     dropdown reads *as readonly*: an assignment on a whole-firm client grants nothing new, and
     narrows anyway. That is how a firm assembles a list *before* it tightens, which is the only
     order that does not cause an outage.
246. **Take Sam off Ridgeline — the only assignment it has — and then press "Restrict to the
     assigned".** Refused, with the fix in the message: assign somebody first. A firm that locks
     itself out of books it has accepted responsibility for has not tightened its security, it has
     created an incident whose only exit is the client re-inviting the firm they already engaged.
     (Taking Sam off changed nothing else: under *the whole firm* he still reaches Ridgeline, now at
     the firm's `accountant` default rather than the narrower `readonly`.)
247. **Sign back in as `owner@ridgeline.test` and open Settings → Who can open these books.** Sam is
     listed *via Hartley & Co*, **everybody at the firm**. The client is told the shape of the
     exposure and not the firm's roster: "any of their ten people can read this" and "these two can"
     are different answers, and a list of names alone cannot tell them apart.

### Money given for a purpose (Phase 26)

*A different company: sign in as `nadia@riverside.test`. A contractor has no funds, and
demonstrating this on Ridgeline would show the screen rather than the accounting.*

248. **Open Funds.** Three funds and *$8,440.00 still restricted*. The Hall roof appeal was given
     $3,840.00 and still has $3,440.00; the Hoyle legacy is marked **endowment — principal never
     spendable**; General funds is unrestricted.
249. **Read Net assets.** $620.00 without donor restrictions, $8,440.00 with, $9,060.00 in total —
     and the total is assets less liabilities, not the balance on the equity accounts, which
     mid-year still hold last year's close.
250. **Below it: *Every donation on the books belongs to a named fund*.** That is not the page
     adding up to itself. It compares every line posted to the contribution accounts against the
     subset carrying a Fund tag — post a donation straight to 4500 with no fund and the sentence
     changes to name the amount that is now outside every figure above.
251. **Open the Release run tab.** Only the Hall roof appeal is listed. The endowment is not
     offered at all, because a donor who gave money to be held forever did not give money to be
     spent — and the unrestricted fund has no restriction to release.
252. **The $400.00 it spent in March is marked *already released*** and the button is disabled. The
     run is idempotent on `unique(fund_id, period_start)`; two people pressing it in the same
     second produce one release because the database refuses the second.
253. **Look at Accounting → Reports.** `4590 Net Assets Released from Restriction` $400.00 debit and
     `4595 Net Assets Released — Unrestricted` $400.00 credit. Both are income accounts and they
     sum to zero: **the release changed no total**, only which column the money sits in.
254. **On the same trial balance, `4510 Grant Revenue` is $2,500.00 — once.** The seeded grant was
     *promised*, not received, and it was income the day it was promised. `1180 Pledges Receivable`
     shows $2,500.00 raised against $2,500.00 cleared, netting to nothing.
255. **Go back to Funds → Donors and promises and press "It arrived" on Marguerite's grant.**
     *Promise settled in full. No income was posted — it was recognised when the promise was made.*
     Return to the trial balance: the bank is up and revenue has not moved. Counting it again here
     would reconcile perfectly — bank agrees, fund agrees — and only the income for the year would
     be wrong, by the size of the appeal.
256. **Open Accounting → Dimensions and pick Fund.** ROOF, GENERAL and LEGACY each have a column,
     including the $400.00 of scaffolding — which was posted as an ordinary journal entry through
     no part of the funds module. That is why there is no per-fund profit and loss in this
     workspace: a fund is a dimension, and Phase 16 already answers the question.

### Cost moving through a factory (Phase 27)

*A third company: sign in as `tomasz@kestrelfab.test`. Ridgeline builds on site and Riverside is a
charity — neither has a work in process account.*

257. **Open Manufacturing.** *1 run on the floor · $126.00 in work in process.* Two runs are listed:
     WO-1001 finished, WO-1002 still open and holding cost.
258. **Open WO-1001.** $337.00 material, $960.00 labour, $240.00 overhead — **$170.78 each**. Ten
     cabinets' worth of cost landed on nine, because one was scrapped. A "cost per unit from the
     bill of materials" would have said $153.70 and been wrong in the direction that matters.
259. **Note what the material cost.** The steel was bought at $40.00 and $46.00 a sheet; the run was
     costed at the pooled $42.00, from the lots. The item's own `unitCostCents` of $42.00 and the
     recipe's quantities had no say in it — a BOM says *how much*, never *how much it cost*.
260. **Open the Bills of materials tab.** *Makes 10 × Tool cabinet* — written per batch, so half a
     sheet each needs no rounding. The steel line carries **5.00% wastage**, which is a property of
     the material rather than of the day.
261. **Open Where the value sits.** Open runs $126.00, account 1450 $126.00, **Agrees: Yes**. Those
     are two different things — a subledger this module maintains as it issues material, and what
     the journal lines add up to — so agreement means something.
262. **Read the three stages: 1440 $2,567.00, 1450 $126.00, 1460 $1,537.00.** Three balance-sheet
     lines rather than one. A factory with most of its stock in unmachined bar is a different
     business from one holding finished units, and a single Inventory line cannot say which.
263. **Look at the shelf below: 9 cabinets, $1,537.00, $170.78 each.** Nine, not twenty-seven — the
     first defect this phase caught was a join that multiplied the shelf by the number of runs that
     had ever made the item.
264. **Open Accounting → Reports.** `1450 Work in Process` and `1460 Finished Goods` both appear, and
     `5070 Direct Labor` carries a credit of $960.00. The wages were an expense when they were paid;
     absorbing them is the moment that cost became part of something on a shelf. What is left in
     5070 at a period end is labour that was never absorbed — idle time.

265. **Sign out and sign in as `ines@marlowestreet.test`, then open Takings.** *3 days imported ·
     $2,400.00 net sales · 1 till did not agree.* Three days of a café's trading, each one journal
     entry rather than four hundred.
266. **Read the Tips card.** Collected $214.00, still owed $64.00, paid out $150.00. Those two sides
     are maintained by different code: the left is what the tills reported, the right is the balance
     on 2310 after payroll drew on it. The seed pays the staff with an ordinary journal entry, on
     purpose — a reconciliation whose two halves come from the same place proves nothing.
267. **Look at the 2026-03-11 row: source `marketplace`, $282.00 net sales, $42.30 of fees.** The
     delivery platform deposited $239.70. The books say the café sold $282.00 and paid $42.30 to
     sell it, which are two facts; the deposit is neither of them.
268. **Click the row for 2026-03-10.** *Sold* on the left, *Taken* on the right, and the totals under
     each. Food $542.00, drinks $438.00, less $22.00 refunded — and a card tender of $831.00 with
     *less $13.20 fee* named on the tender that charged it, not lumped into a day-level figure.
269. **Look at the Till column on that row: *$8.50 short*.** Somebody counted the drawer and it was
     light. The cash debit is what was *counted*, and the $8.50 is in `6870 Cash Over and Short`
     with a name on it. A summary that quietly adjusts cash to match the register balances
     perfectly and hides theft.
270. **The 2026-03-11 row says *not counted*, which is not the same as *exact*.** Nobody counted a
     marketplace settlement — there is no drawer. That is stored as null and produces no over/short
     line at all, rather than being recorded as a perfect count nobody performed.
271. **Open Accounting → Reports → Profit & loss for 2026.** Revenue $2,400.00, with `6860
     Marketplace and Platform Fees` $71.90 and `6870 Cash Over and Short` $8.50 as costs. The
     revenue is the gross of every fee.
272. **Now look for the $214.00 of tips on that report.** It is not there, and it is not supposed to
     be. Tips are somebody else's money from the moment they are taken — the same rule ADR 0023
     applied to a tenant's deposit, in a different industry. Switch to the trial balance and they
     are on `2310 Tips Payable`, at $64.00, because $150.00 has gone out.
273. **Press "Import a day" and re-enter 2026-03-09 from the register.** *2026-03-09 was already in.
     Nothing was posted a second time.* Not an error — a nightly importer retrying is not a fault,
     and an exception there produces a dead job and eventually somebody who turns the alerting off.
     The claim row goes in before the entry, so a retry cannot double a café's revenue.

274. **Sign out and sign in as `delphine@fenwickrow.test`, then open Appointments.** *4 delivered ·
     $264.00 earned · 3 still in the diary worth $210.00, which is not revenue.* Those are two
     numbers on purpose. A forward book is useful and dangerous, and adding it to the earned figure
     is how a diary starts pretending to be a sales ledger.
275. **Press "Book somebody in", pick Sam Okafor, and book 2026-04-20 at 10:00 for 60 minutes.**
     *In the diary. Nothing has been posted — a booking is a promise, not a sale.*
276. **Do it again at 10:30.** *Sam Okafor already has an appointment overlapping that time. Two
     people cannot be in the same chair at once.* That refusal is Postgres, not application code:
     an `EXCLUDE USING gist` constraint over the practitioner and the time range. A check that read
     the diary first and then inserted would be correct until the receptionist and the online
     booking form acted in the same second.
277. **Now book 11:00.** It goes in. `tstzrange` is half-open, so 11:00 does not overlap
     10:00–11:00 — a closed range would have refused a normal back-to-back day.
278. **Look at the diary rows for 2026-04-02: one no-show and one cancellation.** Two statuses on
     purpose. The cancelled hour was given back in time to sell again; the no-show hour was lost.
     Neither posted anything, and the no-show *fee* is deliberately not booked as service revenue
     for a service nobody received.
279. **Open "Who is owed".** Earned $123.90, still owed $73.90, paid out $50.00. Rae is on 55% and
     Sam on 45% of the service with 10% of the retail, and both rates were copied onto each booking
     — a rise next month cannot restate what this month's work was worth.
280. **The two sides of that card are maintained by different code.** The left is what delivered
     visits say was earned; the right is account 2320 after payroll drew on it. The seed pays Sam
     with an ordinary journal entry no part of this module, which is what makes the comparison
     worth anything.
281. **Open "Gift cards".** $35.00 on the cards, $35.00 on account 2590, *Agrees: Yes*. A $100 card
     was sold in March and $65 of it spent on Sam's first client in April. Unlike the payout figures
     these two **should** match exactly — nothing legitimately moves 2590 except selling and
     spending a card, and both do it in the same transaction as the balance.
282. **Open Accounting → Reports → Profit & loss for 2026.** Revenue $264.00, cost of sales
     $123.90, gross profit $140.10. The salon earned the whole $264 and owes $123.90 of it. Netting
     the split off the revenue would show $140.10 of income and no cost at all — and hide the
     payout from the one person most likely to be asking why a busy month made no money.
283. **Now look for the $100 gift card on that report.** It is not there, and $65 of it has been
     spent. The revenue was recognised when the haircut happened; crediting `4720 Gift Card
     Redemptions` as well would state $130 of income for one $65 haircut. The personal-care pack
     installs that account and this module never posts to it — having an account is not a reason to
     use it.

284. **Sign out and sign in as `marek@ashgrovemotors.test`, then open The shop.** *0 open · 1
     vehicle on file · 1 over what the customer agreed to.* One job billed, one waiting on a phone
     call.
285. **Look at RO-1002: *$85.00 over — needs a yes*.** A service and rear brakes come to $205.00
     against $120.00 authorised. The order is not wrong and the work is not wrong; the *bill* is not
     yet allowed.
286. **Open it and press "Bill it".** *This order comes to more than the customer agreed to.
     Authorised 120.00, the work comes to 205.00. Get a further 85.00 authorised before billing.*
     In most jurisdictions that refusal is a statute, not a preference.
287. **Note the number it asks for: $85.00, the extra — not $205.00, the new total.** That is what
     the customer is being asked to agree to. Asking only up to the ceiling would let the tolerance
     apply again on top of the new authorisation, and a limit that compounds is not a limit.
288. **Record a further $85.00 by phone from Priya Raman, then press "Bill it" again.** It posts.
     Every approval is its own row — how much, down which channel, who said yes and who took it —
     because a shop challenged over a bill has to be able to say exactly that.
289. **Open RO-1001, the job that already went through this.** $180.00 signed at the counter, then
     $185.00 more by phone once the technician found a seized caliper and sent the discs out. Two
     rows, one bill, $365.00.
290. **Open "What the shop was made of".** Labour $430.00, parts $80.00, sublet $60.00, and *made
     on sublet $20.00*. Three kinds kept apart because they behave differently — one revenue figure
     cannot tell a busy bay from an expensive gearbox.
291. **Read the note under it.** The sublet *cost* is not posted by the repair order: the machine
     shop's invoice arrives through accounts payable coded to 5180. Accruing it here as well is how
     a shop ends up paying for the same gearbox twice on its own books.
292. **Below that: *Do the approvals add up?* — Yes.** Each order's authorised total against its own
     approval rows. The total is a cache and the rows are the record, written by different
     statements — and it is the cache the billing ceiling is computed from, so a drift here would be
     a bill nobody could defend.
293. **Open Accounting → Reports → Profit & loss.** `4600 Labor Revenue`, `4610 Parts Revenue` and
     `4620 Sublet Revenue` are three lines, with `5160 Parts Cost` beneath at what the pads actually
     cost out of the lot they came from. 4620 is in no industry pack — it is installed on first use,
     because a shop that books sublet as labour believes its own bay is more productive than it is.
294. **Open the Vehicles tab and press History on YK21 ZRT.** Both orders, with the odometer at each
     visit. The history is keyed on the car, not the keeper: sell it tomorrow and the record stays
     with the vehicle, which is what makes it worth anything to the next owner.
295. **Still on the ramp, look at RO-1001: *billed · $365.00 owing*, with a "Take $365.00" button.**
     Phase 31 made it a real invoice; this is the till. Press it, choose **Card**, leave the amount,
     and take it. *"$365.00 taken. INV-1001 settled."* The row now reads *billed · paid*.
296. **Sign back in as `delphine@fenwickrow.test` and open Appointments.** Three delivered visits
     show what is owed, and the gift-card one already reads *paid* — because Phase 31 made
     redemption settle the invoice rather than only the ledger.
297. **Press "Take $80.00" on Rae Lindqvist's visit and type 100.00.** Before anything is submitted:
     *"$80.00 taken · **$20.00 change**"*. The number is in front of the person counting notes, at
     the moment they are counting them.
298. **Now switch the same $100.00 to Card.** *"That is $20.00 more than is owed, and change cannot
     be given on a card. Take $80.00 instead."* The button greys out. Somebody typing $100 for an
     $80 card sale has mis-keyed, and the software says so before the card is charged.
299. **Switch back to Cash and take it.** *"$80.00 taken. $20.00 change. INV-1003 settled."*
300. **Open Accounting → Journal and find the entry.** `Dr 1200 Undeposited Funds $80.00 /
     Cr 1100 Accounts Receivable $80.00`, and **that is the whole entry**. The $20 of change is in
     no journal, on no account, in no report — it is the same note travelling back across the
     counter, and it was never a transaction.
301. **Note where it landed: Undeposited Funds, not the bank.** So did the card in step 295. A note
     in a drawer and a card batch not yet settled are both money at the counter; Phase 12's deposit
     slip is what moves either of them to a bank account, when somebody actually walks to the bank.
302. **Open Settings → Background work.** Near the top: *"The books have never been checked. A
     nightly job runs every reconciliation this application has. Nothing has run one yet — which is
     not the same as nothing being wrong."* That state exists because those two look identical
     otherwise, and only one of them is good news.
303. **Under "Run something now", press "Check that the books still agree with themselves".** With
     `npm run worker` going it lands within a few seconds. Reload.
304. **Read the header: *the books agree with themselves*, and the line under it.** *"6 run, 5
     skipped because their module is switched off — which is not the same as passing."* A module
     switched off by accident must not read as a module in good order.
305. **Look at the second row: *What practitioners have earned, against what is still owed them*,
     chipped "a position, not a fault".** It may well show a difference — money leaves account 2320
     through payroll, which is payday rather than a defect. Three of the ten checks are like this,
     and a register that alarmed on them would fire every payday until somebody switched the alarm
     off.
306. **Now break something.** In psql, post an entry straight at `1100 Accounts Receivable` against
     any revenue account — the one thing that genuinely breaks a control account. Press the button
     again and reload.
307. **The header changes to *1 check has stopped agreeing*.** The receivables row reads **$250.00
     apart** in red, with what a difference there means and the name of who owes it. The payouts row
     is still showing its own difference and is still not counted, which is the whole distinction.
308. **Press it a third time and reload.** Still *1 check has stopped agreeing*, and no second
     notification was sent — check the job's result in "Recent jobs": `faults: 1, newlyBroken: 0`.
     A drift is persistent by nature, and a digest that reported it every night would stop being
     read by about the time a second one appeared.
309. **Sign in as `delphine@fenwickrow.test` and open Tills.** The front counter is open: *Float
     $100.00 · Taken in cash $0.00 · Paid out $15.00 · **Should hold $85.00***, with the window
     cleaner named underneath. A float is not takings — it came out of petty cash, and the balance
     sheet total did not move when the till opened.
310. **Note the count box is empty**, and says so: *"Type what is in the drawer. Nothing is filled
     in for you — a count that was suggested is not a count."* This is the one place in the
     application where showing the answer first would be wrong.
311. **Go to Appointments and take $100.00 in cash against an $80.00 visit.** *"$80.00 taken. $20.00
     change."* Come back to Tills: the till now says **$165.00** — $100 float, plus the $80 that was
     kept, less the $15 paid out. The $20 of change is in no entry, which is exactly what makes
     this sum come out.
312. **Type 162.50 into the count box.** Before anything is submitted: *"$2.50 short. This will be
     posted to 6870 Cash Over and Short, not absorbed."* Somebody gave the wrong change, and the
     person counting can see it while the drawer is still in front of them.
313. **Press "Count it and close".** *"Front counter counted at $162.50, against $165.00 expected.
     $2.50 short. $62.50 to bank. $100.00 left in for the next shift."*
314. **Scroll to "Do the tills agree with the books?" — Yes, at $100.00 each side.** The shift is
     closed and the float is still in the drawer, and the check counts the *drawer* rather than the
     shift for exactly that reason. Counting only open shifts would have reported every shop that
     keeps a float overnight as $100 adrift, every night.
315. **Try to count it again.** There is nothing to count — the shift is closed and gone from the
     top of the page. A Z-reading whose number can be revised afterwards proves nothing about the
     moment it was taken, and the moment is the whole control.
316. **Sign back in as `owner@ridgeline.test` and open Accounting → Currencies.** *"These books are
     kept in USD."* Two rates on file from the ECB — 1.083500 on 1 April, 1.100000 on 30 June — and
     both halves of what currency has done, side by side.
317. **Read "What currency has already done": $66.00 realised, in account 7100.** A €4,000 invoice
     was raised at 1.0835 and paid at 1.1000. That $66.00 is settled, in the profit and loss, and
     nobody has to decide anything about it.
318. **Read "What the open balances are worth" underneath.** INV-1013 for Bremen Hafenbau: *€2,500.00
     still owed, $2,708.75 carried, $2,750.00 worth today* — **$41.25**, and it is posted **nowhere**.
     The rate can be back at 1.07 before they pay. This is a report, not an entry.
319. **Change "At the rate on" to a date before 1 April.** The exposure refuses rather than
     guessing: *"No EUR/USD rate on file for that date or before it."* Reporting at the original
     rate would show zero exposure, which is the one answer guaranteed to be wrong.
320. **Type `1,0900` into the rate box and press Record.** *"'1,0900' uses a comma. Write it with a
     full stop, like 1.0835."* Read as an English number that is ten thousand eight hundred and
     thirty-five, which would convert a €4,000 invoice into a $43,340,000 one.
321. **Type `1.0925` and press Record.** *"EUR on today is 1.092500. Documents already posted keep
     the rate they were posted at."* The exposure moves to **$22.50**; INV-1013 still says *raised
     at 1.083500* and still carries $2,708.75. Nothing converted a converted number.
322. **Scroll to "Do the documents carry what their own rates produce?" — Yes, $2,708.75 both
     sides.** The twelfth check, and the same comparison the nightly register runs.
323. **Open Accounting → Credits & statements and look at the customer picker.** Bremen Hafenbau
     reads **$2,708.75**, not $2,500.00 — a list that totals several customers cannot be in a
     document's currency, because the documents need not share one. Browser verification caught
     this one: it read `$2,500.00` until the aggregate was moved onto the home-currency column.
324. **Sign in as `sam@hartleyco.test` and open the same page.** No rate form and **no exposure
     section at all** — not a heading with nothing under it. The check and the rates are there,
     because a reconciliation is not a financial report.
325. **Back as the owner, open Accounting → Budgets.** *"2026 Approved"* is the agreed plan, with
     *"2026 Revised — if the Bremen work lands"* sitting beside it rather than over the top of it.
     The header says the thing that matters: **nothing here posts to the ledger.**
326. **Set the range to 1 January – 31 July and read the two totals.** Revenue **$66,942.75 against
     a plan of $175,000.00 — adverse**. Operating expenses **$32,250.00 against $35,000.00 —
     favourable**. Both differences are negative numbers. Only one of them is bad news, and the
     screen says which without anybody working it out.
327. **Look at the row level inside operating expenses.** Advertising is $14,000 under plan and
     reads *favourable*; rent is $11,250 over and reads *adverse*. The **section** reads favourable
     on its totals — not by counting rows, which would have called it favourable for the wrong
     reason.
328. **Read “7 whole months compared”.** August is excluded because the range stops on the 31st of
     July; a range ending mid-month drops that month entirely rather than pro-rating a plan a
     business does not earn evenly.
329. **Scroll to “Not budgeted at all”.** Unplanned income **$6,557.94**, unplanned cost
     **$31,348.41**, net effect on the result **−$24,790.47** — three figures, never one. Ten
     accounts nobody planned for, each labelled income or cost. None of them is given a variance,
     because there is no plan to vary from.
330. **Note what is *not* in that list: 4000 Sales Revenue**, which was budgeted $35,000 and earned
     nothing. It is in the revenue section reading −100% adverse, because a budgeted account with no
     activity is a fact somebody needs, not a row to drop.
331. **Look at the bottom of “The plan, month by month”.** Three rows — *Planned income*, *Planned
     cost*, *Planned result* — and no single "Total". Adding $25,000 of planned revenue to $5,000 of
     planned rent and calling it $30,000 is the mistake this whole phase argues against, and it
     shipped in that grid until somebody read it on screen.
332. **Choose 6200 Insurance, type `120,000.00`, and press "Spread across the year".**
     *"$120,000.00 across the year. The months add back to exactly that — the odd cents are placed,
     not dropped."* Now type `10000` and spread that instead: seven months of it reads
     **$5,833.35**, not $5,833.31, because the four cents that would not divide went to the first
     four months rather than being lost.
333. **Press "Copy" against 2025.** *"2025 has nothing on the profit and loss to copy. Choose a
     year with trading in it, or enter the figures by hand."* A budget of nothing is not a budget,
     so it refuses rather than writing twelve zeros and looking finished.
334. **Switch the year to 2027, create "2027 Draft", then copy from 2026 with a 5% uplift.**
     *"13 accounts filled in from 2026, month by month, up 5%."* Look at Contract Revenue across
     the year — $2,520 in January, $31,080 in July, nothing after August. That shape is the most
     useful thing last year knows, and spreading the annual total in twelfths would have thrown it
     away.
335. **Sign in as `sam@hartleyco.test` and open Budgets.** The plan and its month grid, and **no
     variance section and no editing controls at all**. Writing a plan needs the journal permission;
     reading the result against it needs the financial-reports one.
336. **Back as the owner, open Accounting → Recurring billing.** Two arrangements: a monthly
     retainer that raises its own invoices, and a quarterly review that waits for a person. The
     header says the thing that matters: **a schedule is a promise to bill, not a bill.**
337. **Read the top section — two periods waiting.** The quarterly review came due on 1 April *and*
     1 July, and both are listed. That is the bug browser verification caught: the run used to stop
     at the first one, so July was never claimed, never billed, and appeared nowhere.
338. **Open the Meridian retainer and read "What it has billed".** Four invoices, INV-1014 to
     INV-1017, one per month from May, each $1,850.00 and each still owed. They are **real
     invoices** — they age, reach a statement and can be paid, because the schedule went through
     the same door as one somebody typed.
339. **Press "Raise anything due now".** *"Nothing was due."* Everything through today is already
     billed, and pressing it again changes nothing — the period is claimed by the database rather
     than by whoever pressed the button.
340. **Read the forecast: $9,750.00 to the end of November, "not owed by anybody".** Nobody has
     been invoiced for a penny of it. $5,550.00 raises itself; $4,200.00 waits for somebody. This
     is the same rule as Phase 35's exposure and Phase 36's plan — reported, posted nowhere.
341. **Press "Raise the invoice" on the April period.** An invoice appears, the period drops off
     the work list, and the forecast is unchanged — it was never counting a period that had already
     come due on this side of the line.
342. **Open Accounting → Reports → A/R aging, as at 31 December.** Meridian Facilities Ltd shows
     **$7,400.00** outstanding — the retainer's four invoices, ageing by their own due dates.
     Nothing about the *schedule* appears anywhere on it: only what it raised.
343. **Sign in as `sam@hartleyco.test` and open Recurring billing.** The arrangements and the work
     list, with **no buttons and no forecast**. Reading what is going to be billed is a financial
     report; raising it is not something a read-only user does.

## Project layout

```
src/
  app/                    Routes, server actions, and UI (no business logic)
    actions/              Server actions — resolve the actor, call one service
    bookkeeping/          Transaction Inbox
    accounting/           Reports, journal, reconciliation workspace
    crm/                  Pipeline, dashboard, clients, proposals, designer
    crm/work/             The shared follow-up board — mine, unclaimed, overdue, done
    marketing/            Overview, campaigns, segments, creative, suppressions
    ai/                   AI module admin, usage ledger, insights, prompt registry
    jobs/                 WIP schedule, job detail, cost codes, subcontractors
    payroll/              Payroll runs, people, liabilities, sales tax, workpapers
    settings/operations/  The queue, schedules, events, and proposed entries
    accounting/receivables/  Credit notes, write-offs, and customer statements
    accounting/periods/   Recurring entries and the year-end close
    settings/modules/     Industry module switches
    accounting/documents/  Every file, what it hangs on, and the open questions
    api/pdf/               Invoice and sent-version PDFs, session-scoped
    p/[token]/pdf/         The client's copy of a proposal, exactly as sent
    accounting/dimensions/  Profit and loss by location, and the reclassify work list
    accounting/assets/    The fixed asset register and its reconciliation
    settings/import/      The migration wizard and the opening-balance check
    settings/access/      Who can open these books, and one click to stop them
    practice/             The firm's own workspace — outside any company's chrome
    forgot/, reset/       Password reset, both pages reachable without a session
    invite/              Accepting an invitation and choosing a first password
    inventory/            Stock on hand, receiving, counts
    time/                 Timesheets, unbilled work, billing, retainers
    properties/           Rent roll and occupancy, the rent run, deposits held
    funds/                Funds, donors and promises, the release run, net assets
    manufacturing/        Runs on the floor, bills of materials, where the value sits
    takings/              Days imported, what each was made of, and the tips position
    appointments/         The diary, who is owed what, and gift cards outstanding
    shop/                 The ramp, customer vehicles, and what the shop was made of
    m/                    The mobile app — Today, review deck, receipts, devices
    api/mobile/v1/        Versioned mobile API: sync (outbox + state), receipts
    studio/               Design Center — profile, brand, catalog, clauses
    api/intake/[key]/     Public lead-capture endpoint (unauthenticated)
    api/proposals/        Public proposal acceptance (unauthenticated)
    api/track/[token]/    Public open pixel and click redirect (unauthenticated)
    api/unsubscribe/      Public RFC 8058 one-click unsubscribe (unauthenticated)
    api/assets/[id]/      Asset serving, authorized by session or proposal token
    api/documents/[id]/   Attachment serving — session only, never a public token
    p/[token]/            Public client-facing proposal link (unauthenticated)
    u/[token]/            Public unsubscribe confirmation (unauthenticated)
  components/
    evidence-panel.tsx    Paperwork and notes on any record, one component for all of them
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
    payroll/              Payroll provider, runs and the entry, remittance, sales tax, workpapers
    worker/               Queue, handler registry, runner, schedules, outbox, system actor
    studio/               Company profile, brand kits, assets, clause library
    ledger/               Journal engine, derived postings, balances, statements
    inventory/            Lot costing, stock movements, purchasing, valuation
    timebilling/          Rates, time entries, reimbursable expenses, retainers
    dimensions/           User-defined dimensions, assignment, dimensional reporting
    assets/               Depreciation schedules and the fixed asset register
    importing/            Delimited parsing, coercion, column mapping, opening balances
    practice/             Firms, engagements, staffing a client, company switching, the work queue
    funds/                Funds and restrictions, contributions and pledges, the release run
    manufacturing/        Bills of materials, work orders, and cost moving through WIP
    pos/                  A day's takings as one entry: gross, fees, tips, and the till count
    appointments/         The diary, the practitioner split, and gift cards as a liability
    vehicles/             Customer vehicles, repair orders, and the authorisation ceiling
    counter/              Settling a bill at the desk: what the tenders cover, and the change
    integrity/            Every reconciliation as named data, and the nightly run of all of them
    drawer/               Tills, shifts, and the count that closes one
    fx/                   Rates as facts, conversion, and what is exposed but unrealised
    budget/               The plan, the spread, and which way a variance reads
    billing/              Arrangements that invoice a customer every period
    notify/               Transactional mail, single-use tokens, reset, invitations
    evidence/             Object store, attachments, the subject registry, accountant notes
    pdf/                  A deterministic PDF writer, the layout pass, and the snapshot service
    engagement/           The communications log, follow-up tasks, and the merged timeline
    properties/           Properties and units, tenancies, the rent run, security deposits
    retention/            What is kept and for how long, and the sweeps that enforce it
    permissions/          Roles, permissions, overrides
    receivables/          Customers, vendors, invoices, bills, payments
    reconciliation/       Statement sessions, clearing, locking
    tenancy/              Actor context, tenant scoping, onboarding
public/                   PWA manifest, service worker, icons, offline fallback
  worker.ts               The worker process entry point (npm run worker)
  worker-once.ts          One tick, then exit (npm run worker:once)
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

## The background worker

```bash
npm run worker        # the loop: poll, drain, repeat
npm run worker:once   # exactly one tick, then exit
```

A separate process from the web app on purpose. A Next.js server that also
drained the queue would run one copy per instance with no coordination, so
scaling the website would scale the number of things sending campaigns.

**Several can run at once.** Claims use `FOR UPDATE SKIP LOCKED`, so a second
worker takes different jobs rather than blocking on the first or duplicating
it. Stopping one with Ctrl-C finishes the tick it is in; killing it outright is
survivable too — the claim expires and another worker picks the job up, which is
safe precisely because every handler tolerates running twice.

`worker:once` is for a deployment whose scheduler is external — a container
platform's cron, a systemd timer. It calls the same `runOnce` the loop and the
tests call, so there is no second code path.

Tune with `WORKER_POLL_MS` (default 5000) and `WORKER_BATCH_SIZE` (default 10).

If no worker is running, `/settings/operations` says so in as many words and
offers a single tick from the browser. That is a development convenience and the
page says as much — it runs inside a web request, which is not how this should
work in production.

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

## Switching payroll providers

Set `PAYROLL_PROVIDER`. The default is `manual`, which **calculates nothing** — it takes what a
payroll bureau already worked out and records it, and posts the journal entry for it. That is how
most small businesses run payroll, and it is the only answer this codebase can give honestly:
withholding depends on jurisdiction, filing status, year-to-date position, and rules that change
every year, and a wrong figure takes money out of a real person's pay packet.

`illustrative` uses invented flat rates for the demo and the tests. They correspond to no
jurisdiction. Every run it produces is marked `is_illustrative` in the database, every screen says
so, and `prepareFiling` refuses on it.

To add a real one:

1. Implement the `PayrollProvider` interface from `src/modules/payroll/provider.ts`.
2. Register it with `registerPayrollProvider`.
3. Set its credentials in the server environment and `PAYROLL_PROVIDER` to its key.

**Unlike every other provider registry in this codebase, there is no fallback.** The others degrade
to a mock when the real adapter is unconfigured, because sending no email beats crashing. Here,
silently substituting one source of payroll figures for another *is* the failure — so an
unrecognised `PAYROLL_PROVIDER` throws the first time payroll is touched rather than quietly
reverting to invented rates.

Per spec §19, none of this is reviewed for production use. The warning saying so is at the top of
every screen in the workspace.

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

- **Phase 8 — Payroll / Tax / Advanced Integrations.** Payroll, sales tax, contractor reporting,
  and tax workpapers are built (see *Payroll and tax* above). What is **not** built, and will not
  be without the spec §19 security review, is anything that calculates a real person's withholding
  or submits a return. Of "advanced integrations", CSV migration is built (see *Bringing your books
  in*); there is still no payments processor and no e-filing.

- **Past the roadmap — the background worker and outbox.** Spec §20 stops at Phase 8. The worker is
  spec §18 infrastructure rather than a roadmap phase, and it was built next because four
  consecutive ADRs had recorded it as the thing blocking features that were otherwise finished.


Gaps within the phases already built:

- **§13's accounting workspace is complete.** Cash Flow, comparative periods (both statements,
  both with screens), deposits and undeposited funds, vendor credits, user-defined dimensions, and
  the fixed asset register are all built. What remains inside them is listed below.
- **Invoices and bills can carry a dimension; nothing fills one in for them.** Phase 23 threaded
  `dimensions` through `DocumentLineInput` to the journal line, so the revenue side of a
  dimensional report is no longer blank — but `dimension_defaults` and `resolveDefaults` are still
  called by nothing, so a dimension is set by whatever raises the document, by hand on a manual
  entry, or by reclassifying afterwards. Payroll still sets none. Half of what used to be the
  largest gap in Phase 16.
- **A dimension cannot be reported hierarchically.** Values nest and `parentId` is validated; no
  report rolls a child into its parent, so "West / Portland" and "West / Seattle" are two columns
  rather than one with a subtotal.
- **No dimension picker on the transaction inbox**, which is the natural moment to tag a cost.
- **Dimensional reporting is accrual only.** Cash basis restates entries through payment
  applications, and a restated figure has no single journal line to inherit a dimension from.
- **A dimension marked `expected` is advisory.** Coverage is measured and reported; a posting
  without one is not refused, because refusing would stop payroll and inventory relief working.
  See ADR 0016.
- **Depreciation is a button, not a schedule.** The idempotency that would make a monthly job safe
  is already in place — the unique index exists so a job and a person can both fire it — and no
  schedule is registered on the Phase 10 worker.
- **One depreciation book per asset.** A company keeping a book life and a different tax life has
  to keep the second somewhere else, which is most companies past a certain size. No revaluation,
  impairment, or componentisation either.
- **A part-month disposal charges no part-month.** Only completed months are charged, so an asset
  sold on the 15th gets nothing for that month.
- **An import brings balances, not history.** A company's opening position and its open documents
  come across; five years of transaction detail does not. Any report before the opening date will
  be empty, and prior-period comparatives have nothing to compare to.
- **No credit notes or part-paid documents on import.** An open document is a number outstanding,
  so an invoice originally for $10,000 with $4,000 paid arrives as a $6,000 invoice — the balance
  is right and the payment history is lost. A negative outstanding amount is refused rather than
  turned into a credit note.
- **No inventory or fixed-asset detail on import.** The trial balance carries both *totals*, and
  the subledgers Phases 14 and 16 built start empty — so both reconciliations report a
  disagreement until somebody enters the detail by hand. The readiness diagnosis names this case
  rather than leaving it to be discovered.
- **CSV only, and single-currency.** No `.xlsx`, no QuickBooks `.qbo`/`.iif`, no API pull from
  another product, and a file of euro balances imports as dollars without complaint.
- **The import file is held in memory.** Fine for the tens of thousands of rows a small business
  has, wrong for a hundred-megabyte file.
- **Reversal is all-or-nothing per run.** There is no way to undo forty rows of a four-hundred-row
  import.
- **Accruals are pooled per account, not matched per item.** Cash basis works out what a
  prepayment or accrual was for by reading the recognition entries on that account. A company
  running two prepaid insurance policies through one account gets the pool, not the policy, and one
  that has never amortized a prepayment gets it left on the balance sheet with a caveat naming the
  amount. Matching per item needs the accrual linked to its settlement the way
  `payment_applications` links a payment to its invoice.
- **No WebAuthn or passkeys.** TOTP works with any authenticator app and no hardware, but it is
  phishable in a way a passkey is not.
- ~~**`login_attempts` is never pruned.**~~ Ninety days since Phase 24, on a nightly sweep, with the
  window and the reason on the operations page.
- **The export is built in memory.** Fine for a small company, wrong for a large one — it needs the
  object store §18 asks for and this repository does not have.
- ~~**A practice member reaches every client of the firm.**~~ Since Phase 25 an engagement is staffed
  `whole_firm` or `assigned_only`, per client, and joining the firm no longer reaches a client the
  firm has not put you on. What is still true is that **only a practice owner can staff a client** —
  a firm with a managing partner per office cannot delegate it, because `practice_role` has two
  values.
- **Engagements are found by name, not by an invitation link.** A client searches a directory of
  practices and offers access. People are now invited by email (Phase 19) but *firms* are not, so a
  firm must already exist in the system before a client can invite them.
- **The practice directory cannot be opted out of.** Name and contact email are visible to any
  signed-in user — deliberately not client counts, which would be a competitive-intelligence feed —
  but a firm cannot hide.
- **No practice-level security policy.** A client can require a second factor of everybody in their
  company, which does cover practice members; a firm cannot impose one on its own staff.
- ~~**The practice work queue counts one thing** — transactions awaiting review.~~ Since Phase 87 it
  also asks about books that disagree with themselves, work the machine gave up on, and a sending
  reputation, and sorts the roster worst first.
- **What it still does not ask about.** Unreconciled accounts, open periods and unposted drafts —
  the things a firm chasing period-end wants — are not among the signals. The ladder is the part
  that was hard; adding a rung to it is not.
- **The rungs and their thresholds are the same for every firm.** A month for a stale backlog and a
  fortnight for a stale check are this application's opinion presented as arithmetic. A bookkeeping
  practice and a tax firm have genuinely different ideas of what "needs somebody" means, and
  neither can say so — though Phase 43 already established the pattern, by making the chase policy
  named data a person can change.
- ~~**The roster is not a notification.**~~ Since Phase 88 a firm gets one letter a day, and only
  about clients that got worse than the last thing said about them.
- ~~**The brief cannot be switched off.**~~ Since Phase 89 it is a topic like any other, with the
  switch on the practice roster and checked per person.
- ~~**The brief is invisible to the notification log.**~~ Since Phase 90 both outcomes are
  recorded against the firm, and the roster shows each person what arrived and what did not.
- ~~**The letter itself cannot be opened.**~~ Since Phase 91 the letter keeps its words, the
  decision row names it, and the roster opens it in place.
- ~~**The company side still cannot open its letters.**~~ Since Phase 92 the CRM timeline follows
  the link it has held since Phase 22 and shows what the letter said, labelled apart from any note
  somebody typed.
- ~~**A letter only lands on a timeline when the address belongs to a CRM contact.**~~ Since Phase
  93 it is filed against the customer or supplier it was about, decided from what the letter is.
- ~~**Nothing says when a letter went unfiled.**~~ Since Phase 94 the duplicate-address case is
  reported nightly by the integrity register. The other two silences remain indistinguishable from
  outside `recordOutboundMail`, which is honest: a letter to a stranger is the ordinary case.
- ~~**The finding names duplicates and nothing acts on them.**~~ Since Phase 95 the customers and
  suppliers screen shows the clash, what each record carries, and which of them can be archived.
- **Nothing merges two customers.** The check reports, the screen explains, a person decides. Two
  live customers on one inbox is the case most worth fixing and the only one the screen answers
  with a shrug — what a merge would mean for the documents, the audit trail on both records and
  whether the losing record survives as an alias is unbuilt and undecided.
- **No backfill.** Letters sent before Phase 93 have no communications row and do not get one:
  which party they were about was never decided, and inventing it now would be a guess dressed as
  a record.
- **No backfill, and no HTML.** Letters sent before Phase 91 have a null body because their words
  are genuinely gone, and only the text part is kept — the HTML is a rendering of the same
  paragraphs, and keeping both would be the two-copies defect committed twice.
- **A silent morning records nothing.** When the brief says nothing there is no decision about a
  person to record, so the history has gaps rather than a row saying "nothing to say". Which
  client was seen on which morning is `practice_brief_state`'s job, and a second copy of it here
  would be the defect this phase exists to avoid.
- **One practice topic, so one line rather than a settings page.** `preferencesFor` already returns
  every practice topic; the roster shows the only one there is.
- **The brief is the firm's, not each person's.** The roster is read once, through the first
  member, and the same letter goes to everybody. Under `assigned_only` staffing two members
  legitimately see different clients, so somebody can be told about a client they are not on. A
  strictly correct version reads the roster per person and repeats a five-query-per-client scan for
  every member of the firm.
- **The client is not told their accountant was told.** Defensible — the firm has access by an
  engagement the client agreed to — but a decision rather than an oversight.
- **A firm with no email address for a member hears nothing.** Delivery is by mail alone; there is
  no fallback to the push channel, which is deliberate (a roster does not fit in a push
  notification) and still means one missing address is one silent person.
- **Five counts per client, per page load.** Fine for a firm with forty clients and wrong for one
  with four hundred — the same shape as the retention counts on the operations page, and not yet a
  problem worth a materialised roll-up.
- **The only mail adapter is the mock.** Every letter goes to a process-local array and, in
  development, to the terminal. The seam is one interface and one variable, but nothing has been
  sent over SMTP or through a real provider, so none of the delivery problems — DKIM, bounces,
  complaint feedback loops, suppression at the provider — have been met.
- **Bounced transactional mail is recorded, not surfaced.** `failedDeliveries` exists and no screen
  calls it, so nobody is told when an invitation to a mistyped address never arrives.
- **No email verification for a self-registered owner.** Invitees and resetters prove they own an
  address; somebody registering a company still proves nothing. The mechanism to fix it now exists.
- **No confirmed change of email.** Reset re-checks the current address, so the machinery is ready,
  but changing your email is still a direct write with no confirmation to either address.
- ~~**`action_tokens` is pruned on demand, never on a schedule.**~~ Thirty days past expiry since
  Phase 24 — measured from expiry rather than issue, so a week-long invitation is not swept early.
- **Reset requests are rate-limited per address, not per IP.** It bounds using this application to
  post mail at one stranger; a spread attempt across many addresses is not bounded at all.
- **An invitation cannot be resent.** Withdraw and re-invite issues a new token and silently kills
  the old link, and an invitation that expires vanishes from the list rather than showing as
  expired — so an owner watching for somebody to accept sees the row disappear unexplained.
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

- **All ten industry modules are implemented**, as of Phase 30. `job_costing`, `projects`,
  `inventory`, `time_billing`, `properties`, `funds`, `manufacturing`, `pos_import`,
  `appointments` and `vehicles` all have workflows behind them, and the module settings page's
  "Not built yet" section is empty for the first time since Phase 7. It is kept rather than
  deleted, because the next module declared will need it.
- **No POS integration, and no settlement file upload.** A day arrives through `importDay`, from a
  form or a caller. There is no adapter for Square, Toast, Shopify or Amazon, and no CSV upload —
  even though Phase 17 has a parser that could be pointed at one. The module is the accounting half
  of the problem; the feed half is a provider abstraction that does not exist yet.
- **A day cannot be un-imported.** The claim row makes re-import impossible by design, which is the
  point, but nothing reverses one. Getting Tuesday wrong means a manual journal entry against it.
- **A day's sales tax is one figure.** It credits 2200 in total with no jurisdiction breakdown, so
  Phase 9's per-jurisdiction return cannot see inside a day's takings.
- **Tips are one balance, not a balance per person.** Who is owed what out of 2310 is not modelled,
  and paying it out is payroll's job.
- **`1220 POS Import Suspense` accumulates silently.** It is on the day row, on the takings board and
  on the balance sheet, but nothing chases it — no alert, and no entry in Phase 24's health surface.
- **A practice running both appointments and daily takings would double-count.** Phase 29 recognises
  revenue per visit and Phase 28 per day. Nothing prevents both being run against the same trading,
  and nothing warns about it.
- **No recurring appointments, reminders, or waiting list.** A standing Tuesday slot is typed out
  week by week, and nothing tells a client their appointment is tomorrow — even though Phase 19 has
  the mail channel and Phase 10 has the scheduler.
- **Only a practitioner can be double-booked.** A treatment room, a chair or a piece of equipment
  can be booked twice over; the exclusion constraint is keyed on the practitioner alone.
- **No gift card expiry or breakage.** Recognising revenue on cards nobody will ever use needs a
  judgement about how many never come back, and a wrong one books revenue that has to be given back.
  Cards sit on 2590 indefinitely, and nothing reports how old they are.
- **There is no cash-in-transit account.** Counted takings go straight to Undeposited Funds, so a
  shop where the money sits in a safe for two days before banking has one account doing two jobs.
- **A shift has no printable Z-reading.** The record exists and the screen shows it; a piece of
  paper somebody initials does not, and that is still how many businesses close a till.
- **Nothing enforces that a drawer is ever counted.** A shift can stay open for a week, and the only
  thing that notices is the nightly check quietly agreeing with a very large expected figure.
- **Over and short is recorded and unanalysed.** The number that turns this into an answer rather
  than a record — over-and-short by person and by weekday — is not reported anywhere.
- **Split tender is in the core but not on the screen.** `takePayment` and `tenderFor` handle
  several tenders on one bill and the tests cover it; the on-screen control takes one at a time.
  Pressing it twice does the same thing, which is why it did not earn a second form.
- **Nothing enforces that a new reconciliation joins the register.** A twelfth module could add a
  check and forget, and Phase 33 would not notice — the same class of omission it exists to fix, one
  level up. The register's own doc comment is the record; a lint rule would be better.

- **A foreign invoice cannot be credited**, only paid or written off. A credit note's home amount is
  the sum of its converted lines rather than the conversion of its total, and the two differ by a
  cent often enough to matter — so crediting an invoice or a bill in a foreign currency, applying a
  credit note to one, and drawing a retainer against one all refuse and say why. A **write-off is
  allowed**, because one amount and two lines convert exactly.
- **Nothing revalues automatically.** Unrealised movement is reported and never posted (ADR 0035),
  so a business whose accountant wants it in the ledger posts the journal entry the exposure report
  describes, every period, by hand.
- **There is no multi-currency bank account.** Money arriving in euros is recorded as the
  home-currency amount that reached the account, so a business actually *holding* a euro balance has
  nowhere to hold it and no period-end translation of it.
- **Nothing fills the rate table.** `exchange_rates` was shaped for a feed running through the Phase
  10 worker, and no feed exists — rates are typed, and a day nobody typed is a refusal to post.
- **The functional currency cannot be changed.** It is a company field with no control, which is
  correct: changing the currency a set of books is kept in is a migration, not a setting.
- **The invoice PDF and the customer statement do not name the currency.** They print the document's
  own figures, which are euros on a euro invoice and labelled as though they were not.
- **`createBill` with `taxCents > 0` posts an unbalanced entry** — debits are the subtotal, credits
  the total. Pre-existing and unreachable, since no caller passes it, and left alone deliberately:
  choosing recoverable against non-recoverable input tax is an accounting decision, not a fix.

- **A budget is per account and nothing else.** Not per dimension, not per job, not per customer —
  so a company with three sites (Phase 16's dimensions) can report them apart and cannot plan them
  apart.
- **Fiscal years start in January.** `month` is 1–12 against a calendar year, and a business whose
  year begins in April has no way to say so.
- **There is no cash-flow budget**, which is the one a small business actually loses sleep over.
  This is profit and loss only.
- **Nothing warns when actuals drift past plan.** The variance answers when somebody opens the
  page; Phase 24's scheduler and Phase 33's notifier could make it arrive, and neither is wired to
  it.
- **Approving a budget does not freeze its figures**, so "the plan we agreed" is a name rather than
  a guarantee. Every change is in the audit log, which is the honest half of that trade.
- **The variance sections and net income do not add up when anything is unbudgeted**, deliberately:
  net income is the income statement's own figure and includes the unplanned accounts, while the
  sections cover only what was planned. The unbudgeted block sits next to them so the difference is
  visible rather than mysterious.
- **A budget cannot be imported.** Most of them currently live in a spreadsheet, and Phase 17's CSV
  machinery is most of what bringing one in would need.

- **A billing schedule carries one line, through the screen.** The service takes many; the form
  takes one, because a multi-line editor is a different piece of work and one line covers a
  retainer.
- **No tax, no currency and no job on a schedule.** `createInvoice` supports all three and the
  schedule passes none of them, so a euro retainer or one with sales tax is raised by hand.
- **A schedule cannot be edited.** Its lines are written once at creation, so changing an amount
  means a new arrangement — which at least makes "changes the future, not the past" true by
  construction rather than by rule.
- **Nothing tells anybody a manual period is waiting.** It is at the top of the screen; Phase 24's
  scheduler and notifier could make it arrive and are not wired to it.
- **A voided recurring invoice has to be reissued by hand.** The occurrence stays claimed on
  purpose — the period *was* billed, and forgetting that would let the next run bill it again — but
  nothing re-offers it.
- **The forecast walks at most 200 occurrences per schedule.** A weekly arrangement forecast four
  years out would truncate silently.
- **Nothing is repaired automatically, and deliberately.** The nightly check says the books
  disagree; it does not decide which side is right. A tool that journalled a plug to make a control
  account agree would destroy the evidence of what actually went wrong.
- **`checkHistory` has no screen.** It answers "when did this start", which is the first question
  after being told two things disagree, and no page calls it yet.
- **The checks only ever run as at today.** A year-end review cannot ask whether the books agreed at
  the period end, only whether they agree now — and per Phase 31, a historic `asOf` is approximate
  anyway because invoices keep no record of what they were owed on a past date.
- **The bank is not in the register.** It is the one comparison a business does daily, and it is a
  human matching exercise against a statement rather than a two-sided sum, so Phase 2's
  reconciliation workflow stays what does it.
- **Card fees are not modelled.** A card batch settles net of the acquirer's cut, so Undeposited
  Funds cannot simply be swept to the bank at face value once card takings are in it.
- **Opening balances imported through Phase 17 post to AR directly**, so they will show as a
  control-account difference until they are represented as invoices.
- **No parts markup rule and no clocked labour.** Every line is priced by hand: there is no matrix
  turning cost into price, which is how most shops actually price parts, and a labour line is hours
  typed in rather than clocked. Phase 15 has timesheets and nothing joins them to a repair order.
- **A sublet's cost lands in the period its bill is entered**, not the period the job completed,
  because the repair order deliberately does not accrue it.
- **The odometer is a single running maximum.** A reading is checked against the vehicle's highest,
  so a genuine downward correction needs the rollback flag even when it is obviously a typo.
- **No MOT, service intervals or reminders** — most of what a garage's software sells on, and all of
  it schedulable on Phase 10's queue.
- **A retainer is not modelled on a cash basis.** Strictly, cash basis has no unearned revenue —
  money received in April is April's revenue. What happens instead is that the receipt has no
  recognition entry to take accounts from, so it stays on the balance sheet and the caveat names
  the amount. Guessing a revenue account would put income in a bucket nobody chose. A test asserts
  the limitation, so it stays a named shortcoming.
- **No timer, and no approval routing.** Time is typed after the fact, and anybody with journal
  permission can approve anybody's time including their own.
- **Billable expenses are not created from the transaction inbox.** A cost has to be marked
  recoverable by hand, when the natural moment is categorizing the transaction it arrived on.
- **Cost rates are recorded and unread.** Engagement profitability is what the column was added
  for and no report uses it yet.
- **Inventory has one location.** No warehouses, no bins, no transfers between them — which
  wholesale and multi-site retail both need. The movement table has the shape to carry them.
- **No recipes, so a day's takings relieve no stock.** Phase 27 gave the manufacturing pack a bill
  of materials, but nothing joins a menu item to its ingredients — so a restaurant importing a day
  through Phase 28 books food sales without touching food inventory, and its cost of sales comes
  from purchases rather than from consumption.
- **Landed cost is not apportioned.** Freight and duty go to their own expense accounts rather
  than into the cost of the stock they arrived with, so margin on imported goods is flattered.
- **Clearing Goods Received Not Invoiced has no screen.** `attachBillToReceipts` does it correctly
  and nothing in the interface calls it, so in practice the account is cleared by a manual entry.
- **A negative stock position values at zero.** Selling into a shortfall relieves what exists and
  no more, so cost of sales is understated until the replenishment arrives.
- **WIP still does not *post* its adjusting entry, and will not.** Since Phase 10 a monthly job
  *proposes* one as a draft — balanced, validated, and affecting no statement until an accountant
  posts it. Having a scheduler did not change ADR 0007's judgement: the objection was about who
  decides, not about whether the arithmetic could be automated.
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
- ~~**Nothing schedules the review nudge.**~~ Scheduled daily as of Phase 10.
- ~~**Idempotency keys are never pruned automatically.**~~ Scheduled daily as of Phase 10.
- **A parked operation explains itself but cannot be repaired.** If a period closed while a phone
  was offline, the outbox shows the error and offers retry or discard — not a way to redate the
  entry. See ADR 0008.

- **Nobody's withholding is calculated.** With `PAYROLL_PROVIDER=manual` (the default), figures
  come from a payroll bureau's report. This is the honest capability rather than a limitation, but
  it is worth stating plainly: there is no tax engine here.
- **The illustrative adapter's rates are invented.** They match no jurisdiction, they never update,
  and every run they produce is stamped `is_illustrative` in the database, flagged on screen, and
  blocked from a filing. It exists so the ledger machinery can be exercised end to end.
- **Sales tax on a bill is not tracked.** `document_tax_lines` has a `bill` document type and only
  invoices are ever written. Input tax credits are a real jurisdictional feature and half of one is
  worse than none.
- **Net Pay Payable is never cleared automatically.** Posting payroll credits 2350; actually paying
  people is a bank transaction somebody matches against it. The workpaper pack raises a standing
  balance as a warning.
- **Remittances do not reconcile against a bank feed.** A remittance credits the bank's chart
  account directly rather than creating a matchable transaction, so it shows as an unexplained
  difference in reconciliation until matched by hand.
- **The contractor threshold has no UI.** It is a service argument defaulting to 60,000 cents; a
  company outside the US passes its own, but not from a settings page yet.
- **Tax codes are not effective-dated in force.** `effectiveFrom` is stored and nothing enforces
  it, so a code can be applied before its date. The frozen `rate_bp` means this cannot corrupt a
  past return.
- **Employer taxes are not allocated to jobs.** Wage lines carry the job dimensions; liabilities do
  not, because a tax owed to an agency does not belong to a job. Fully burdened job cost is a
  policy question rather than a missing feature.
- ~~**Nothing reminds anybody a remittance is due.**~~ Monthly since Phase 10, on the 5th, to
  everyone who can manage tax. Net Pay Payable is excluded on purpose — it is outstanding between
  posting payroll and paying people, and a reminder that is always on is a reminder nobody reads.

- **Cash basis reads the whole ledger for the window.** No aggregate pushdown, so a company with
  years of history and a wide date range will feel it. The accrual path still aggregates in SQL.
- **The trial balance has no basis, on purpose.** It is a statement about the journal, and the
  journal is kept on one basis. A switch there would imply a choice that does not exist.
- **Credit notes are AR-only.** Spec §13 lists vendor credits too; a supplier credit note is the
  mirror image and is not built.
- **A statement is stored, never sent.** `sent_at` and `sent_to` exist and nothing populates them.
- **Statements are not rendered through the document engine**, so they do not carry the company's
  brand the way a proposal does. The engine exists; this is a template away.
- **Recurring entries have fixed amounts.** No formulas and no percentage-of-account templates, so
  an estimate that should move with a balance has to be edited.
- **A closed year is not protected from new entries.** Post into one and the close's frozen figures
  become stale, with no warning. Period locking is the existing control and the two are separate on
  purpose, but the combination is a foot-gun.

- **A deployment must run `npm run worker`.** Nothing schedules itself from the web process, and if
  no worker is running then nothing in the queue happens. The operations page says so in as many
  words rather than looking calm — but there is no supervisor, no restart policy, and no alerting
  beyond that page.
- **Nothing retries a dead job automatically**, which is deliberate — a job retrying forever hides
  the healthy queue behind it. ~~And nothing tells you about one.~~ Phase 24 sends a daily digest of
  dead jobs and bounced letters, and says nothing at all on a quiet day.
- **Jobs are polled, not pushed.** A five-second poll is five seconds of latency. `LISTEN/NOTIFY`
  would remove it and is not worth the complexity while the most urgent queued thing is an hourly
  campaign check.
- **No per-kind concurrency limit.** One slow job kind can fill a batch and starve the others;
  priority mitigates it and does not solve it.
- **`opportunity.won` and `payroll.posted` are declared event types with no publisher.** Kept
  because their obvious subscribers are near-term, but until then they are dead code and this is
  the honest label for it.
- **A handler that partly fails still succeeds.** `campaign.send_due` and `bank.sync_all` collect
  per-item failures rather than throwing, so one broken feed does not stop the healthy ones. The
  failures are in the stored result and on the page, but the job's status is `succeeded`.
- **The system actor is one global row**, shared across every tenant. It writes only through
  tenant-scoped services so it grants no cross-tenant read, but it is a shared identity.

- ~~**Campaign scheduling.**~~ Built in Phase 10: an hourly job sends campaigns whose scheduled
  time has passed, through the same `sendStep` that enforces consent, and queues each nurture step
  at its own delay measured from when the first one actually went out.
- **Provider delivery callbacks.** Bounces are recorded from the synchronous send result. Real
  ESPs report hard bounces and spam complaints by webhook hours later, so the suppression list
  under-counts until that endpoint exists.
- **Open tracking is a pixel**, so it under-reports wherever images are blocked. Click rate is the
  more honest figure, which is why the sales loop keys on clicks rather than opens.
- **QR codes do not render in the designer preview.** The encoder is server-side; the preview
  shows a labelled placeholder naming what will be encoded. Sent and printed output is correct.
- **A/B testing and send-time optimization** (spec §10) are not built.

- ~~**Cash-basis reporting.**~~ Built in Phase 11, as the transformation ADR 0002 described rather
  than the bank-movements approximation it warned against. **Retainage under cash basis remains
  approximate**: a progress billing's payment recognizes contract revenue and retainage receivable
  in proportion, which balances and is defensible, but a purist would say cash basis has no
  retainage receivable either.
- **The PDF renderer has no font embedding.** Built in Phase 21 — deterministic, dependency-free,
  and limited to the standard 14 fonts, so a company's brand font does not reach the printed page
  and anything outside Windows-1252 renders as `?`. Images and QR codes are labelled placeholders
  rather than pictures, there are no link annotations, and streams are uncompressed. All named in
  ADR 0021, and font embedding is the one change that unblocks most of them.
- **Illustrator-class vector editing** (spec §7). Deliberately deferred — §7 itself says to
  prioritize business-document layout first. No arbitrary positioning, layering, or path editing;
  a `canvas` block type is the extension point.
- **Rich text inside a paragraph.** Text blocks are plain with paragraph breaks. Bold, italics,
  and inline links need their own decision about format.
- **Comments and questions on a proposal** (spec §7). The acceptance endpoint is the model to
  copy when they are built.
- **The statements cannot be filtered by job.** Classes, departments and locations were built as
  user-defined dimensions in Phase 16, with their own dimensional P&L; the job and cost-code
  dimensions have been real since Phase 7. But a *statement* scoped to one job is still a query
  change to make — the WIP and job cost reports answer that question by another route.
- ~~Communications and file attachments on opportunities (spec §6) are not built.~~ Files arrived
  in Phase 20 and the communications log in Phase 22, so §6's "communications, files, and activity
  history" is met on all three counts and **§16's core data model is complete** —
  `Communication` and `Task` were the last two entities in it.
- **Inbound mail is not captured.** A reply from a client is logged by hand. There is no IMAP
  connection, no forwarding address and no threading, so the log records that somebody replied
  rather than the reply. The largest gap in Phase 22, and it needs a provider decision before it
  needs code.
- ~~**Nothing chases an overdue follow-up.**~~ Daily since Phase 24, one message per person with a
  count rather than one per task, and unclaimed overdue work told separately to whoever could claim
  it.
- **Communications carry no attachments.** Phase 20 attaches a document to eleven kinds of record
  and `communication` is not one of them, so "here is the quote I emailed them" is a sentence
  rather than a file. One row in the subject registry.
- **Campaign sends are invisible on the timeline**, deliberately (ADR 0022), so "why have we not
  heard from them since March?" will not show the four newsletters they were sent. The marketing
  workspace answers that separately.
- **Tasks have no recurrence and no dependencies.** A quarterly check-in is raised four times by
  hand. This is a follow-up list rather than a project-management surface, and the line is
  deliberate.
- **The timeline merges in memory**, each source capped and then the merge capped, so pagination is
  approximate past sixty entries. And an open task sits at its *due* date, which is right for "what
  is outstanding" and surprising for "what happened when".
- **No timeline on a contact or a job**, only on a client and a deal. The data supports both; the
  screens do not exist.

- **Rent is monthly.** Weekly tenancies, quarterly commercial rents and annual ground rents are not
  expressible. The period is a month because the idempotency key is a month, and widening it means
  a period *type* on the lease and a rethink of proration.
- ~~**Nothing schedules the rent run.**~~ Monthly on the 1st since Phase 24. It skips a company that
  lets no property rather than dead-lettering a job every month, and billing twice bills once because
  the unique index decides.
- **No late fees, and no CAM.** `4310 CAM Reimbursements` and `4320 Late Fee Income` are installed
  and unused. Service-charge apportionment by floor area is what `areaUnits` was recorded for, and
  half of it is worse than none.
- **No rent reviews.** Changing the rent means editing the lease, which correctly restates nothing
  already billed — but there is no record of what it was before or when it changed.
- **A deposit is not held per protection scheme.** Many jurisdictions require deposits in a
  registered scheme with a reference and statutory deadlines. Phase 23 models the money, not the
  compliance.
- **No tenant statement of its own.** Phase 11's customer statement covers a tenant, because a
  tenant is a customer — but it says "Invoice" rather than "Rent for March" and it does not show
  the deposit held.
- **Occupancy is by unit count, not by area or by rent.** One large unit and three small ones
  reports 25% let when the large one is empty, which understates the problem.
- **A property is not a fixed asset.** Phase 16's register would depreciate the building and this
  module does not link to it, so the same address can exist in both places with nothing reconciling
  them.

- **Retention is not configurable per company.** The days are the application's, not a setting. A
  jurisdiction requiring seven years of sign-in history has no way to say so, and one requiring
  thirty days has no way either. The policy being data is what makes that a small change; it is
  still a change.
- **Nothing is anonymised, only deleted.** A row past its window goes entirely, so an aggregate
  computed before a sweep and after it disagree, and nothing records that a sweep is why.
- **The audit log has no retention, deliberately, and grows for ever.** Spec §19 asks for complete
  auditability and this takes it literally. A busy company's `audit_events` will eventually be its
  largest table, and there is no plan beyond "that is the requirement".
- **A swept row is not recoverable from the application.** The backup is the answer and
  `db:verify-restore` is the tested half of it, but there is no undo on a sweep.
- **The failure digest reaches phones, not inboxes.** It goes through Phase 8's push channel, so
  somebody without a subscription is told nothing — and Phase 19's mail channel is right there,
  unused for this.
- **Nothing watches the watcher.** The digest is itself a scheduled job, so if the worker stops the
  digest stops with it and the only thing that says so is the operations page nobody is looking at.
  The same gap Phase 10 named, and not closed here — it cannot be, from inside.
- **The rent run is monthly on the 1st for everybody.** The run takes a month parameter; the
  schedule does not offer one.
- **Retention counts scan whole tables.** Nine `count(*)` pairs on every load of the operations
  page. Fine at this scale, wrong for a tenant with ten million campaign events.
- Renaming an organization does not propagate to its linked customer or vendor record. Client-
  facing documents read the organization, so they stay correct — but the accounting record drifts.
- A document's brand kit is captured when the document is composed. Changing the kit does not
  restyle existing documents: right for sent proposals, arguably surprising for drafts.
- **Tracked links in emails sent before Phase 81 no longer follow.** They carry no signature, so
  the click redirect treats them exactly as it treats a forged one and lands the reader on the home
  page. The alternative was leaving a live open redirect on the tenant's own domain. A deployment
  with real campaigns already in inboxes would want a grace window instead of this.
- **Anyone holding a recipient token can inflate that recipient's opens.** The tracking pixel takes
  a token and nothing else, by design — a failed analytic must never break a rendered email — but
  nothing distinguishes a mail client fetching the pixel from somebody replaying the URL. Checked in
  Phase 82 and left alone: the reported "opened" figure already counts distinct recipients rather
  than fetches, so a replay flips one recipient's flag and cannot run a number up. A GET anybody can
  replay is inherent to pixel tracking.
- ~~**No bounce or complaint webhook.**~~ Built in Phase 83. `EMAIL_WEBHOOK_SECRET` must be set for
  the endpoint to accept anything — it fails closed, so an unconfigured deployment silently has no
  bounce handling. Check it during setup rather than after a send.
- **Recipient rows written before Phase 83 do not distinguish a send failure from a bounce.** Both
  were stored as `bounced`, and nothing in the record says which a given row was, so they are left
  alone rather than migrated on a guess. New rows carry the distinction.
- ~~**A rising bounce rate tells nobody.**~~ Watched since Phase 84, in Phase 24's health digest
  and on the operations page.
- ~~**The reputation verdict is company-wide; the cause is usually one campaign.**~~ Attributed
  since Phase 85, on the operations page and in the digest.
- ~~**The verdict has no memory.**~~ Recorded daily since Phase 86, and the direction reported
  against a reading a whole window old.
- **No worker, no history.** The snapshot is written by the daily digest, so a deployment that
  never runs the worker gets no trend at all — the same dependency Phase 24 accepted for the digest
  itself.
- **Nothing is backfilled.** The verdicts already sitting in `background_jobs.result` could be
  mined for levels and deliberately are not: a level is not a rate, and a history half of whose
  readings are guesses is worse than one that starts today and is true. A new deployment says
  nothing about direction for its first week.
- **The trend compares two readings, not a line.** It is the most recent reading against one a
  window old, so a rate that spiked and recovered in between reads as steady. Enough to answer
  "which way", not enough to see a shape.
- **A changed `REPUTATION_WINDOW_DAYS` splits the history.** `window_days` is stored per row so
  nothing compares across the boundary silently — but nothing bridges it either, and the trend goes
  quiet until a window's worth of new readings exists.
- **A uniformly bad list gets no name.** Deliberate — the biggest campaign in it is the biggest
  campaign, not the cause — but it does mean the worst case for a sender, every send equally bad,
  is the case where the page is least specific about what to do.
- **Attribution names one campaign, never two.** A domain put over the line by a pair of bad
  imports is reported as whichever of them moves the number more, with `explainsIt` false, and the
  reader has to find the second one themselves.
- **Recipient rows written before Phase 83 still distort the window.** They were all stored as
  `bounced` whether the provider refused them or a mailbox rejected them, so within seven days of
  that upgrade the rate reads high. It settles as those rows age out.
- **The warning repeats every day the rate stays bad.** A real cost and the deliberate trade: the
  fact is still true tomorrow, and a warning that fires once about a condition that persists is a
  warning designed to be missed.
- **Below a hundred accepted messages there is no verdict at all.** A company that sends one small
  campaign a month never gets one, which is correct — a rate over forty emails is noise — but it
  does mean the smallest senders are unwatched rather than reassured.
- **Nothing acts on a bad rate.** No campaign is paused and no list is cleaned. An application that
  stopped sending on a threshold it chose would be making a commercial decision on somebody else's
  behalf.
- **Stored fonts predating Phase 80 are not swept.** `heading_font` and `body_font` had no
  validation until then, so the gate is on the way in and a row written before it is only checked
  when it is next saved. Every existing value came out of the Design Center's own picker, and
  rewriting a customer's stored font on the strength of a validator added afterwards would be doing
  more than the finding justifies.
- **The default brand kit is a colour nobody chose.** `#0d6e60` was copied from the application's
  own palette back when that palette was teal, and it outlived it by nine phases. Phase 79 made it
  one constant rather than six and deliberately left the value alone — changing it repaints the
  documents of every company that never picked one, which is a design decision about somebody
  else's letterhead rather than a refactor.
- **Brand assets still use the Phase 4 `AssetStore`**, which is a separate adapter from Phase 20's
  content-addressed object store and still gives every duplicate its own copy. Fine for logos, and
  one of the two should eventually absorb the other.
- **Object storage bytes are shared across tenants.** Content addressing means two companies with
  the same file share a blob, so storage cost is not attributable per company and physical
  separation between tenants is not available with this store. The tenancy guarantee is the
  `documents` row and nothing else.
- ~~**`sweepOrphanedBlobs` is not scheduled.**~~ Nightly since Phase 24, as one of the nine
  retention policies — the only one whose question is reachability rather than age.
- **No virus scanning.** Uploaded files are served back with `nosniff` and a restrictive CSP, which
  stops a text file becoming a script and does nothing about a malicious PDF.
- **No previews and no search inside documents.** A receipt is a link that opens in a new tab —
  worse than an inline image on a phone — and the filter is on filenames, so "find the invoice with
  88412 on it" needs OCR and an index and has neither.
- **The `jsonb` → tables backfill is exercised, not covered.** It was run against
  a database built at the Phase 19 schema and seeded by hand with the case that
  matters — two byte-identical receipts on two different transactions — which is
  how two defects in it were found. The automated suite cannot cover it: the
  suite starts from a schema where the old column no longer exists.
- **The evidence panel is wired into fixed assets only.** The registry knows eleven kinds of record
  and the component is generic; bills, invoices, journal entries and reconciliations can all carry
  evidence through the service and have no control that does it.
- **Deleting a document is silent about its links.** The button says how many records it will strip
  it from, and then does it. No undo, and no interstitial for a file used on ten records.
- **Row-level security as a second isolation layer** (spec §19) is still not in place; tenant
  isolation rests on `scoped()` at every query and on the tests that assert it. MFA, session and
  device controls were built in Phase 13.
- **Spec §18's infrastructure list is now complete.** Object storage arrived in Phase 20,
  server-side PDF generation and immutable snapshots in Phase 21, the background job queue and the
  outbox pattern in Phase 10.
- **Older sent proposals have no PDF**, and deliberately no backfill: rendering today's document
  and calling it the March file would be exactly the lie Phase 21 exists to prevent. Those versions
  show greyed out in the history.
- **A snapshot is not signed.** It proves what the system rendered, and the digest is in the audit
  log — but nothing external timestamps or countersigns it, so it is evidence of a system's own
  record rather than a notarised document.

Per spec §19, a security review is required before any production use involving real financial
integrations or payments.
