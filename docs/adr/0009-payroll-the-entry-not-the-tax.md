# ADR 0009 — Authoritative about the entry, never about the tax

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §13 (sales tax and payroll modular/integration architecture; 1099 vendor fields; tax-workpaper-friendly reports), §19 (security review before production use of payroll or tax filing), §5 (industry packs), §23 (additive modules)
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md), [ADR 0008](0008-offline-first-and-replay-safety.md)

## Context

Spec §13 asks for payroll and sales tax, and says how:

> Sales tax and payroll should use **modular/integration architecture** due to
> jurisdictional and compliance complexity.

Spec §19 says when any of it may be relied on:

> Security review before production use of financial integrations, payment
> features, payroll, **tax filing**, or automated financial actions.

Those two sentences pull in opposite directions, and this phase is shaped by
the tension rather than by resolving it. The honest position is that there are
two different questions here and this codebase can answer exactly one of them
well:

|                                    | Can this system be authoritative? |
| ---------------------------------- | --------------------------------- |
| How much tax to withhold from Dana | **No.** Depends on jurisdiction, filing status, year-to-date position, benefit elections, and rules that change annually. |
| Given those figures, what entry    | **Yes.** Ordinary double-entry bookkeeping, and this codebase has a ledger. |

A wrong answer to the first takes money out of a real person's pay packet and
exposes their employer to penalties. A wrong answer to the second is an
accounting error, which is bad but is the kind of bad this project already
knows how to prevent.

So: the system *is* authoritative about the journal entry, and *is not*
authoritative about the tax. Every decision below is that sentence applied to
one more surface.

## Decisions

### 1. The default payroll adapter calculates nothing

`PayrollProvider` is the sixth use of this codebase's adapter pattern —
`BankProvider`, `AssetStore`, `EmailProvider`, `AiProvider`, `PushProvider`,
and now this. But the abstraction is not primarily about swappability. It
exists so that **this codebase is never the thing that decided how much tax to
withhold from somebody's wages.**

`ManualPayrollProvider` is the default and its `calculate()` returns
`{ok: false, reason: 'This adapter does not calculate payroll…'}`. That is not
a stub. A bookkeeper runs payroll through their bureau, gets a report, and
enters the figures so the books are right — which is how the overwhelming
majority of small businesses run payroll, and a system that recorded it
faithfully and posted a correct entry would be useful even if it never gained a
calculating adapter at all.

`IllustrativePayrollProvider` exists for the demo and the tests. Its rates are
invented, they correspond to no jurisdiction, and every run it produces is
stamped `is_illustrative` **on the row** rather than inferred later. The
overview says so, the workpaper pack raises it as a blocker, and
`prepareFiling` refuses on it.

**There is no fallback in the registry.** Every other provider in this codebase
degrades to a mock when the real one is unconfigured, because sending no email
beats crashing. Here, silently substituting one source of payroll figures for
another *is* the failure, so an unknown `PAYROLL_PROVIDER` throws.

### 2. The mistake the schema is shaped to prevent

The commonest payroll entry error is treating employee withholding as an
employer cost. It still balances — which is why it survives review — but it
overstates wage expense by the withheld amount and understates it by the
employer's own taxes. Wages are gross; withholding is the employer holding
somebody else's money on its way to an agency.

Three things guard it, at three different levels:

- **`payroll_item_kind` is an enum on every payslip line**, distinguishing
  `employee_tax` from `employer_tax` in the data rather than in a convention.
- **`expense_account_id` is null on a withholding line by construction** —
  `createPayrollRun` sets it to null for withholding kinds regardless of what
  the caller passed, so there is no code path that books withholding as cost.
- **`assertBalanced` checks the payroll identity before anything posts:**
  `gross + employerCost === netPay + everything owed to somebody else`. This is
  the double-entry balance restated in payroll terms, and it catches a
  mis-kinded line *before* the journal engine sees a set of numbers that happen
  to balance for the wrong reason.

The run wizard's third step is the entry itself, itemised, with that identity
shown as arithmetic rather than asserted. A totals row looks identical whether
withholding was kinded correctly or not; the entry is the only place the
difference shows, so it is a step rather than a detail somebody can open
afterwards.

### 3. Balances come from the ledger, splits come from the runs

`liabilityPositions` reads **posted journal lines**, not payroll runs. The runs
are why the liability exists, but a figure somebody is about to pay an agency
has to come from the same place the balance sheet gets it, or the two disagree
at the worst possible moment.

`payrollSummary` reads the **runs**, because the split between employer cost
and employee withholding is a payroll concept the chart of accounts does not
carry — both credit account 2300. The two are reconciled by test: the pack
asserts `payroll.totalCostCents === operatingExpenses + costOfSales`.

A remittance posts `Dr` the liability, `Cr` the bank, and **no expense** — the
cost was recognised when the payroll ran or the sale was made. Booking a
remittance to an expense account is the second commonest payroll error after
mis-splitting withholding, and it double-counts the cost.

Two refusals guard it: over-remitting (which drives a liability negative, and
reads on a balance sheet as the agency owing *you* money) and a kind/account
mismatch. A payroll remittance against Sales Tax Payable balances perfectly and
leaves both accounts wrong — payroll understated, sales tax overstated — which
nobody notices until one of the two returns will not foot.

### 4. Sales tax rates are the company's data, not the software's

There is no shipped rate table and there will not be one. A rate table in a
release is correct on the day it ships and silently wrong afterwards, and
"silently wrong but authoritative-looking" is the worst state for a number
somebody is about to remit against. A company enters the codes it is registered
for, with the rates its jurisdictions gave it, and owns them.

**The rate is frozen onto the document.** `document_tax_lines.rate_bp` records
the rate *as applied*. Changing a code's rate next quarter must not restate
last quarter's return, and the only way to guarantee that is to stop reading
the rate from the code once the document exists.

`createInvoice` takes `taxLines` and prices them itself. The pricing happens
before the transaction opens (the total belongs on the invoice header) and the
breakdown is written inside it (it needs the invoice's id), from **one read of
the codes** — so a jurisdiction's return and the invoice behind it cannot
disagree.

The return reports exempt sales next to taxable ones, because most returns ask
for both. And it shows the ledger balance *beside* the period's collections
rather than instead of them: they answer different questions, and quietly
presenting one as the other is how a return gets filed for the wrong amount.

### 5. Only four digits of an employee's tax identifier

`employees.tax_id_last4` takes four characters, with a database CHECK, and
`createEmployee` **refuses** a longer value rather than truncating it —
somebody pasting a full number into that field has misunderstood what it is
for, and silently keeping four digits would hide that the rest was ever sent.
The system cannot leak what it never took.

A contractor's identifier *is* stored whole, because the report needs the full
number and there is nowhere else it lives. That is a genuine difference in
exposure, and it is why setting one needs `tax:manage` rather than the
`accounting:view` that creating a vendor needs. The number never enters the
audit log; recording that one was set is the useful fact, and recording what it
was would put a tax identifier in a table read by everyone with `audit:view`.

Payroll permissions are **not implied by any other permission**. A bookkeeper
gets `tax:view`/`tax:manage` and no payroll at all; a manager gets `tax:view`
only. What people are paid is the most sensitive data a small business holds,
and somebody who can see the books should not automatically see it.

### 6. Workpapers are the exceptions, not the figures

An accountant preparing a return needs three things from a set of books, and
most software gives them the first two: the figures, the trail back to the
transactions, and **an honest account of what is wrong with them**.

The third is what `workpaperPack` is for. Every pack carries an `exceptions`
list — sales with no tax code, a liability that will not reconcile, contractors
over the threshold with no identifier on file, payroll figures from the
illustrative adapter. An accountant finds those anyway: in January, under time
pressure, by hand. Producing them turns a discovery into a checklist.

`prepareFiling` **refuses** when a blocker exists, unless given an override
reason that is stored on the filing next to every blocker it overrode. The
exceptions travel with the frozen figures, so a return questioned later shows
what was known to be wrong when it was prepared.

### 7. There is no `file()`, and the enum says so

`tax_filings.status` has two values: `prepared` and `filed_externally`. There
is no `filed`, because this system does not submit returns and spec §19 requires
a security review before it could. What it can honestly hold is that a human
says they filed it, when, and with what reference — which is what an audit
trail actually needs.

The same reasoning names the contractor report after what it is rather than
after a jurisdiction's form number. Producing the figure needs the accounting
records and this system has them. Producing the form is a compliance claim it
has not earned.

**The §19 notice is in the product, not only in this file.** It sits at the top
of every screen in the workspace, because the person about to remit against
these figures is the one who needs to know the system has not been reviewed for
it, and they will never open the repository.

## Consequences

- **Nobody's withholding is calculated.** With `PAYROLL_PROVIDER=manual`
  (the default), figures are entered from a bureau report. That is the honest
  capability and it should not be described as a limitation.
- **The illustrative adapter can post.** It is allowed to, so the ledger
  machinery can be seen working end to end — but every run it produces is
  marked, every report says so, and it blocks a filing. A demo whose payroll
  figures are invented and *unmarked* would teach the wrong thing about what
  this system knows.
- **Sales tax on a bill is not tracked.** `document_tax_lines` has a
  `documentType` of `invoice` or `bill` and only invoices are written. Input
  tax credits are a real jurisdictional feature and doing half of one is worse
  than doing none.
- **Net Pay Payable is never cleared automatically.** Posting payroll credits
  2350; actually paying people is a bank transaction that has to be matched
  against it. The pack raises a standing balance as a warning, which is right
  mid-period and wants explaining at a year end.
- **Nothing reconciles a remittance to a bank feed.** A remittance credits the
  bank's chart account directly rather than creating a matchable transaction,
  so it will appear as an unexplained difference in reconciliation until
  somebody matches it by hand.
- **The threshold is a parameter, not a constant.** 60,000 cents is the
  default because it is the long-standing US 1099-NEC threshold and the demo
  data is in dollars. A company anywhere else passes its own. There is no UI
  for setting it yet — it is a service argument.
- **`taxCodes.isActive` and `effectiveFrom` are stored and only weakly used.**
  `listTaxCodes({activeOnly})` honours the first; nothing enforces the second,
  so a code can be applied before its effective date. The frozen `rate_bp`
  means this cannot corrupt a past return, but it is not a real effective-dating
  implementation.
- **Payroll runs carry job dimensions on wage lines only.** Labour lands on the
  job somebody worked on, exactly as Phase 7 intended; liabilities do not,
  because a tax owed to an agency does not belong to a job. A company wanting
  fully burdened job cost would need employer taxes allocated too, which is a
  policy question rather than a missing feature.

## Follow-up

1. **The background worker.** Now blocking four things: the campaign scheduler
   (ADR 0005), the WIP adjusting entry (ADR 0007), the review nudge (ADR 0008),
   and a "remittance due" reminder, which is the one an accountant would miss
   money over. Four phases of evidence is enough — this should be built before
   the next feature.
2. **A calculating adapter, behind the §19 review.** The interface is designed
   for one and `IllustrativePayrollProvider` proves the shape works end to end.
   What it must not become is a fallback: the registry throws on an unknown key
   precisely so that a half-configured integration fails loudly rather than
   quietly reverting to invented rates.
3. **Reconciling remittances and net pay.** Both currently post straight to a
   bank's chart account. Routing them through the same matching path as an
   ordinary payment would close the two reconciliation gaps above at once, and
   is a better use of effort than either in isolation.
