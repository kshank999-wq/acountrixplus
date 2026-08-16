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
**accounting dimensions with the fixed asset register**, and **bringing an
existing business's books in** from the
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
[ADR 0016](docs/adr/0016-the-parts-sum-to-the-whole.md), and
[ADR 0017](docs/adr/0017-nothing-is-imported-until-all-of-it-can-be.md).

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
    payroll/              Payroll runs, people, liabilities, sales tax, workpapers
    settings/operations/  The queue, schedules, events, and proposed entries
    accounting/receivables/  Credit notes, write-offs, and customer statements
    accounting/periods/   Recurring entries and the year-end close
    settings/modules/     Industry module switches
    accounting/dimensions/  Profit and loss by location, and the reclassify work list
    accounting/assets/    The fixed asset register and its reconciliation
    settings/import/      The migration wizard and the opening-balance check
    inventory/            Stock on hand, receiving, counts
    time/                 Timesheets, unbilled work, billing, retainers
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
    payroll/              Payroll provider, runs and the entry, remittance, sales tax, workpapers
    worker/               Queue, handler registry, runner, schedules, outbox, system actor
    studio/               Company profile, brand kits, assets, clause library
    ledger/               Journal engine, derived postings, balances, statements
    inventory/            Lot costing, stock movements, purchasing, valuation
    timebilling/          Rates, time entries, reimbursable expenses, retainers
    dimensions/           User-defined dimensions, assignment, dimensional reporting
    assets/               Depreciation schedules and the fixed asset register
    importing/            Delimited parsing, coercion, column mapping, opening balances
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
- **Dimension defaults are built and unused by the document paths.** `dimension_defaults` and
  `resolveDefaults` are tested; the invoice, bill and payroll paths do not call them, so a
  dimension is set by hand on a manual entry or by reclassifying afterwards. The largest gap in
  Phase 16.
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
- **No password reset by email.** Two-factor, lockout, and a password change are built; "I forgot
  my password" still needs the email provider wiring and a single-use token. A half-built reset flow
  is a bypass for everything above it, so it is absent rather than approximate.
- **No WebAuthn or passkeys.** TOTP works with any authenticator app and no hardware, but it is
  phishable in a way a passkey is not.
- **`login_attempts` is never pruned.** The table grows with every failed sign-in on the internet
  and an attacker controls that rate. A retention job belongs on the Phase 10 scheduler.
- **The export is built in memory.** Fine for a small company, wrong for a large one — it needs the
  object store §18 asks for and this repository does not have.
- **Accountant practice mode is not built**, which spec §14 itself defers ("can later allow one
  accountant to switch securely among multiple client companies").
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

- **Five of ten industry modules do nothing.** `job_costing`, `projects`, `inventory`, and
  `time_billing` are implemented; `pos_import`, `properties`, `funds`, `appointments`, `vehicles`,
  and `manufacturing` are declared, switched on by the packs that ask for them, and have no
  workflows. The module settings page lists them under "Not built yet" rather than hiding them.
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
- **No bill of materials.** The manufacturing pack gets stock without the ability to consume
  components into a finished good, which is the half of manufacturing that makes it manufacturing.
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
- **Nothing retries a dead job automatically, and nothing tells you about one.** Deliberate for the
  retry; the missing digest is the obvious next handler now that the notification machinery it
  needs exists.
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
- Recurring entries, closing entries, customer statements, credits, and write-offs were built in
  Phase 11. **Fixed assets and depreciation remain open** from spec §13 — §13 itself allows a
  depreciation register to be a later professional module. Contractor (1099) reporting is built as
  of Phase 9 — the figure and the blockers, not the form.
- Communications and file attachments on opportunities (spec §6) are not built;
  `opportunity_activities` is the seam they will hang from.
- Renaming an organization does not propagate to its linked customer or vendor record. Client-
  facing documents read the organization, so they stay correct — but the accounting record drifts.
- A document's brand kit is captured when the document is composed. Changing the kit does not
  restyle existing documents: right for sent proposals, arguably surprising for drafts.
- Assets are stored in Postgres through the default `AssetStore` adapter. Fine for logos; object
  storage is one adapter away when receipts arrive at volume.
- Infrastructure from spec §18 still open: object storage for receipts, and server-side PDF
  generation. The background job queue and the outbox pattern were built in Phase 10; bank sync now
  runs on a schedule rather than inline.
- Security from spec §14/§19 still open: MFA, session/device controls, row-level security as a
  second isolation layer.

Per spec §19, a security review is required before any production use involving real financial
integrations or payments.
