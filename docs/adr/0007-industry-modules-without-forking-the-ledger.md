# ADR 0007 — A dimension, not a second ledger

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §5 (industry packs and the construction row), §13 (accounting dimensions), §16 (entities), §20 (Phase 7), §22 (definition of done), §23 (product rules)
- **Builds on:** [ADR 0006](0006-ai-gateway-and-human-approval.md)

## Context

Spec §5 asks the construction pack for "job costing, estimates, change orders,
progress billing, retainage, subcontractors". Spec §20 attaches a constraint to
the phase that does the asking:

> Construction first or based on market validation; add specialized workflows
> **without forking the core ledger**.

and §23 restates it as a product rule:

> Industry customization extends the common platform rather than creating
> separate products.

Every decision below is downstream of that constraint. Construction accounting
is where accounting software usually grows a second set of books — a job cost
table maintained alongside the ledger, a construction invoice type that is not
quite an invoice, a WIP schedule assembled from figures nobody can trace. Each
of those is a fork, and each is why a contractor's job cost report and their
profit & loss disagree by December.

## Decisions

### 1. Job cost is two columns on `journal_lines`

`journal_lines` already carried `project_id` from Phase 2. Phase 7 adds
`cost_code_id` beside it, and that is the entire storage design for job costing.
Cost to date is:

```sql
SELECT cost_code_id, sum(debit_cents - credit_cents)
FROM journal_lines JOIN journal_entries … JOIN chart_accounts …
WHERE project_id = $1 AND status = 'posted' AND type IN ('cogs','expense')
GROUP BY cost_code_id
```

There is no `job_costs` table, no roll-up job, no cached total. A job's costs
and the trial balance are the same rows added up two different ways, so they
cannot drift — not because anything reconciles them, but because there is
nothing to reconcile.

`tests/jobs.test.ts` asserts it directly: total cost carrying a job, plus cost
carrying none, equals cost of sales plus operating expenses on the profit &
loss. That test is the ADR.

### 2. A cost code is a dimension, not an account

The tempting alternative is accounts: 5110-Framing, 5110-Concrete,
5110-Roofing. It works until the second job, at which point the chart needs an
account per phase per job and the P&L is unreadable.

Keeping the two orthogonal — the account says *what kind of cost*, the cost code
says *which part of the work* — keeps the chart at the construction pack's
eleven additions, keeps the P&L comparable with every other company on the
platform (§23), and makes "framing labour across all jobs" a `GROUP BY` rather
than a report that has to know account-naming conventions.

A database CHECK enforces that a cost code never appears without a job:
`cost_code_id IS NULL OR project_id IS NOT NULL`. A cost code without a job is
not a partial answer, it is an unanswerable one.

### 3. Retainage extends `createInvoice`; it is not a reclass afterwards

Retainage is the phase's one real change to a core service. `createInvoice` and
`createBill` each gained two optional parameters, and the posting becomes:

```
Dr Accounts Receivable      total − retained
Dr Retainage Receivable     retained
   Cr Revenue                          total
```

The obvious alternative — post the invoice normally, then a second entry moving
retainage out of AR — was rejected. It changes zero core code, and it breaks the
one identity a receivables ledger has to hold: **the AR control account equals
the sum of open invoice balances**. After a reclass the control account is short
by the retainage and the subledger is not, and every month-end close pays for
it. There is a test named after that identity.

So: the retained amount is part of `invoices.total_cents` (it is billed work,
and the client's copy shows it) and excluded from `invoices.balance_cents`
(the customer does not owe it yet).

Releasing retainage needed no new machinery at all. It is an ordinary invoice
whose single line credits Retainage Receivable instead of a revenue account —
Dr AR, Cr Retainage Receivable, revenue untouched because it was recognized when
the work was billed. That this falls out of the existing service without a
special case is the strongest available evidence the design sits in the right
place.

### 4. A progress billing produces an ordinary invoice

An application for payment is a `progress_billings` row holding what an invoice
does not: the application number, percent complete per contract item, and the
amount retained. Issuing it calls `createInvoice` — the same service a plumber
uses for a call-out — inside the same transaction.

The consequence is that a construction receivable is a receivable. It ages in
the AR aging report, accepts ordinary payments, and voids like anything else,
because there is no construction invoice type to keep in step with the ordinary
one.

To let the application and its invoice commit together, `createInvoice` gained
an optional executor parameter, the same convention `recordAudit`,
`createJournalEntry`, and `installChartOfAccounts` already use.

### 5. Approving a change order posts nothing

Approval revises the contract value on the job, revises the affected budget
lines, and adds a schedule-of-values item so the change becomes billable. It
writes no journal entry.

That is not an omission. A change order is an agreement about work that has not
happened. Revenue arrives when the work is billed and cost arrives when it is
incurred; posting on approval recognizes revenue for work nobody has done, which
is the error percentage-of-completion accounting exists to prevent. A test
snapshots the trial balance across an approval and asserts it is unchanged, and
the audit event records `postedToLedger: false` because it is the surprising
part.

Original and change amounts are stored as separate columns rather than a single
revised figure. "We are over the revised budget" and "we were over the original
bid" are different findings, and one number can only answer one of them.

### 6. Modules resolve as pack default plus company override

`INDUSTRY_MODULES` and the per-pack `terminology` map were declared in Phase 0
and consumed nowhere. `modules/industry/modules.ts` is where they start meaning
something.

A module's state is the industry pack's list, adjusted by rows in
`company_modules`. Two things follow, and both are why it is not a plain list of
enabled keys on the company row:

- A contractor gets job costing without configuring anything.
- A landscaper on the "general" pack can switch it on, and a contractor who does
  not want it can switch it off. Industry is a starting point, not a cage.

Returning a module to its pack default **deletes** the override rather than
storing a redundant row, so "has this company departed from its industry
defaults" stays answerable.

Terminology is display-only and always will be: a "Job" is a `projects` row and
a "Tenant" is an `organizations` row. Only the words change, which is exactly
why it is a rendering concern rather than a schema one.

### 7. Compliance status is derived, never stored

An insurance certificate that lapsed three weeks ago is *worse* than one that
was never collected, because the folder still has a certificate in it and nobody
looks. So `documentStatus()` is a pure function of an expiry date against a
date, and there is no status column. A stored status is correct on the day it is
written and wrong every day after — which is the precise failure the feature
exists to prevent.

Two consequences worth naming:

- A kind counts as expired only when *every* document of that kind has expired.
  A renewed certificate filed beside the old one is current cover, and flagging
  it would train people to ignore the flag.
- `paymentCheck` returns reasons; only an explicit `holdPayments` blocks.
  Software that silently refuses to pay a subcontractor because a form is a day
  out of date is software that gets worked around.

### 8. Percent complete is `null`, not zero, without a budget

Cost-to-cost percent complete needs a budget. A job without one reports `null`,
and earned revenue is not computed. Reporting 0% would show a fully cost-loaded
job as having earned nothing — a wrong answer where the honest one is "unknown".

Over- and under-billings are reported apart rather than netted, because one is a
liability (Billings in Excess of Costs) and the other an asset (Costs in Excess
of Billings). Netting them would be the balance-sheet equivalent of offsetting a
customer's debt against a supplier's.

## Consequences

- **Only two of ten modules are implemented.** `job_costing` and `projects` are
  real; `inventory`, `time_billing`, `pos_import`, `properties`, `funds`,
  `appointments`, `vehicles`, and `manufacturing` are declared, switched on by
  the packs that ask for them, and do nothing. The settings page lists them as
  "not built yet" rather than hiding them, so the gap is visible rather than
  discovered.
- **Percent complete is cost-to-cost only.** Units-complete and
  effort-expended methods are not offered. Cost-to-cost is what a contractor's
  accountant expects and the only one the data already supports.
- **WIP does not post.** The schedule reports over- and under-billings; it does
  not write the adjusting entries into 1160 and 2560. Those accounts install
  with the pack and stay empty until an accountant posts to them. Automating
  that entry is the natural next step, and deliberately not this phase's — an
  automated period-end adjustment nobody reviewed is how a WIP schedule becomes
  a source of surprises.
- **An application is issued immediately.** There is no prepare-then-review
  step; `priceApplication` gives the UI a preview, but `createProgressBilling`
  files and invoices in one action. The `draft` value in
  `progress_billing_status` is unused and reserved for that workflow.
- **Retainage release is all-or-part but not per-item.** A partial release takes
  an amount, not a schedule-of-values breakdown. Contracts that release
  retainage per trade as each finishes would need line-level release.
- **Subcontractor retainage is a default, not an automation.** A sub's
  `default_retainage_bp` is recorded and shown; `createBill` still takes the
  amount explicitly. Wiring the default through automatically would mean a bill
  whose total depends on a setting the person entering it cannot see.
- **No lien waiver tracking per payment.** Waivers are a compliance document
  kind and can be filed against a job, but nothing ties a waiver to a specific
  payment or blocks one for want of it.
- **`AppShell` now makes a database query.** Gating the Jobs workspace on a
  per-company module means the shell resolves module state on every page render.
  It is one indexed lookup and it is cached per request by React, but it is the
  first time the chrome has needed the database.

## Follow-up

Two things, in this order:

1. **The campaign scheduler**, outstanding since ADR 0005 and still the one gap
   that changes behaviour rather than adding surface. Two phases have now
   deferred it.
2. **The WIP adjusting entry.** The schedule computes over- and under-billings
   and the accounts to post them to already exist. The test of whether this
   ADR's design was right is whether that entry can be added as an ordinary
   period-end journal entry, derived like any other posting — if it needs a new
   kind of entry, or a way for a report to write to the ledger, the dimension
   was in the wrong place.
