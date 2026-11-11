# 0209 — The tax code nothing could reach

**Status:** accepted
**Date:** 2026-11-11
**Phase:** 209

---

## The nomination, measured

ADR 0208 nominated **the four remaining `activeOnly` opt-in defaults**, read one
at a time, headed by `listEmployees` on the grounds that *"an employee who has
left appearing in a payroll run picker is the same class of defect as a closed
bank account on a refund"*. It came with the warning its two predecessors
earned: guessing which callers are offers and which are lists had produced a
wrong number twice.

The guessing was not the problem this time. **Every call site was already
correct.** Ten of them outside the tests:

| function | a register, correctly without the flag | a narrowed list, correctly with it | a check, correctly without it |
| --- | --- | --- | --- |
| `listEmployees` | `payroll/people` | `payroll/run` | `createPayrollRun` |
| `listTaxCodes` | `payroll/sales-tax` | — | — |
| `listCostCodes` | `jobs/cost-codes` | `jobs/[id]`, `db/seed` | — |
| `subcontractorSummaries` | `jobs/subcontractors` | `expiringDocuments` | `paymentCheck` |

`paymentCheck` is the one worth saying out loud, because it reads like a missed
flag and is not: it asks whether a subcontractor may be paid, so seeing *more*
of them than a picker would is the cautious direction. A deactivated
subcontractor still owed money is exactly the one whose expired insurance should
still block the payment.

The headline case is the one to look at: the payroll run page passes
`{ activeOnly: true }`, and has since it was built. The nominated defect was not
there to find at the call site.

So the flip is a refactor with no defect behind it, and it waits for one. The
deliverable was the reading, and the reading turned up two other things.

## What the reading found, one: a flag that filters on a column nothing can set

`employees` has **one insert and no update anywhere in the application.** So
`employees.is_active` has no writer, `employees.end_date` has no writer, and
**an employee cannot be recorded as having left at all.**

ADR 0208's headline is therefore a real defect reached by the opposite route.
It is not that a caller forgot the flag; the caller passes it, and it does
nothing, because nothing can make the predicate true. `tax_codes.is_active` is
the same.

**Neither is a column census finding, and that is the part worth keeping.**
`writerCandidates` marks a column a candidate only when something *names* it as
`table.column` — drizzle spells a select, a where and an order the same way, so
"something names it" is the honest proxy for "something reads it". Both of these
list functions select every row and filter in JavaScript:

```ts
return opts.activeOnly ? rows.filter((row) => row.isActive) : rows
```

The string `taxCodes.isActive` is never written, so the scan has nothing to see.
Phase 202 narrowed this register's default exclusion and closed *"all six
`isActive` switches"* that narrowing exposed; these two were never exposed,
because the exclusion that hides them is not the default — it is the shape of
the query. The `select`-then-`filter` pattern is both *why* the flag is opt-in
and *why* the column it reads is invisible.

That is declared rather than fixed here, and pinned as source assertions so a
retire control arriving goes red instead of leaving the declaration quietly
false (Phase 179's rule, and Phase 185's).

## What the reading found, two: the phase

`listTaxCodes` has **one caller**, a register. A list function with one caller
and no picker anywhere is worth following, and following it is this phase.

`createTaxCode`, `listTaxCodes`, `priceDocumentTax`, `recordDocumentTax` and
`salesTaxReturn` have been complete since Phase 2. Rates the company owns rather
than ones we guess; tax rounded once per code on the code's combined base;
`rate_bp` frozen onto the line so a rate change next quarter cannot restate last
quarter's return; a return grouped per jurisdiction with exempt sales reported
beside taxable ones. All of it works and all of it is tested.

**Nothing under `src/app` had ever handed it a tax line.** The string `taxLines`
appeared in no screen and no action. The only writer of `document_tax_lines` was
`db/seed.ts`. A company could enter the codes its jurisdictions registered it
for, see them listed, and never attach one to anything.

What the invoice composer took instead was sales tax as a single typed figure.
That path credits 2200 Sales Tax Payable and records no breakdown — so **on
every invoice the application itself raised, the ledger held the tax and the
return reported none of it.** The sales tax page prints the variance between
exactly those two numbers, under a docstring that says why it does: *"they
answer different questions, and quietly presenting one as the other is how a
return gets filed for the wrong amount."*

## Why it survived 208 phases

This is Phase 169's finding one table over. `invoice_lines.item_id` had existed
since Phase 14 with no writer but a test — so a stocked item sold through the
composer relieved no stock — and Phase 169 built the screen that fills it.

What let this one survive forty phases longer is that **it had seed data.** The
demo writes `document_tax_lines` through `createInvoice`'s own API, so the page
showed two jurisdictions, the runbook had a step about them, and browser
verification confirmed the return footed to the ledger exactly. Everything an
audit looks at said the feature was wired. Only the application could not
produce one.

And the module **detected the gap and attributed it to the reader.**
`hasUncodedSales` is `NOT EXISTS (document_tax_lines …)`, which is every invoice
raised through the composer, and the warning read:

> *{amount} of invoiced sales carry no tax code and so appear on no
> jurisdiction's return. Usually a company that has not set codes up yet;
> occasionally a real gap.*

It was a real gap every time, and not theirs. That is ADR 0134's rule at its
sharpest — an exclusion that *excuses* a site is worse than one that misses it —
printed in front of the user. The `Empty` state made it a promise as well:
*"Add the codes you are registered for below, and invoices raised against them
will appear here."* There was no way to raise an invoice against one.

## One code per line

A line already carries a job and a cost code, a return is filed per
jurisdiction, and `taxPerCode` was built to round a code's *combined* base once
and split the figure back across the lines it came from — so several lines
sharing one code is the shape this module was written for. A document carrying
one code could not have produced the exempt split at all.

The figure is **quoted by the server** as the lines are typed, for the reason
`quoteDocument` exists one module over (Phase 64): the arithmetic has to be the
posting's own. A composer that worked it out in the browser would be a second
answer to what the invoice charged, and it would get it wrong in exactly the way
Phase 145 found in the core — `round(a × r) + round(b × r)` is not
`round((a + b) × r)`. Until the quote comes back the tax reads `…` and the total
does too, because a subtotal wearing the word "Total" is Phase 61's defect in
front of somebody about to raise an invoice for it.

## Two defects found building it

**The precedence was backwards, and silent.** `createInvoice` read:

```ts
const taxCents = input.taxCents ?? pricedTax?.totalCents ?? 0
```

`0` is not nullish, so the composer's own `taxCents: parsed.tax || 0` would have
beaten every priced line it ever sent: a header reading nothing beside a
breakdown reading the lot. The exact disagreement `taxLines`' docstring promises
cannot happen — *"so a jurisdiction's return and the invoice it came from cannot
disagree"* — was one argument away the whole time.

It refuses the pair now, naming both figures (Phase 47), because two answers to
one invoice's tax is the defect rather than something to reconcile. A total that
*agrees* passes, since that is not two answers.

**`is_exempt` was consulted by no arithmetic anywhere.** Written by one form,
printed by one register, read by nothing that computes a figure — so a code
marked exempt at 8.25% charged 8.25%, beside a checkbox that has said *"sales
tracked, no tax charged"* since Phase 2. Nothing in the suite had ever created
one. Neither census could see it: the column has a writer and it has a reader.

`createTaxCode` refuses an exempt code with a rate (Phase 116: a constraint
beats a check), and the form stops offering the pair rather than waiting to be
refused. With the rate forced to zero, routing an exempt line's amount into
`exempt_cents` is a *reporting* decision and not a second answer about what was
charged — which is what makes it safe to derive from the code rather than ask
the caller for.

## The demo was on a path no screen could take

The seeded taxed invoice was one $4,800.00 line carrying two tax codes, with
$600.00 of exempt sales hung on the city line — a shape the composer cannot
build, and one where the exempt figure reached a return without appearing on the
invoice at all. It is three lines now, one code each, including a third code
that is exempt. The tax is unchanged at $328.00.

Reshaping it matters more than it looks: a demo that exercises a path the
application does not have is how this defect stayed hidden, and leaving the seed
where it was would have re-created the hiding place one layer up.

## What this does not do

**It does not give a tax code a retire control**, so this phase's own picker
passes `activeOnly: true` against a column nothing can set. The flag is passed
anyway, because the alternative is an offer site that goes wrong the moment the
control exists — and the inertness is stated in the comment beside it rather
than left to be discovered.

**It does not tax a bill.** `document_tax_lines.documentType` admits `'bill'`
and nothing writes it. §13 asks for sales tax and not purchase tax, so that is a
column the schema anticipates rather than a bullet left undone.

**It does not flip the four opt-in defaults.** Measured, not guessed: the reason
is above.

## What moved

Two new module functions, no new database read or write sites — `taxLinesFor`
and `quoteDocumentTax` both go through `codesFor`, so the isolation census stays
at **301 writes and 972 reads**. The column census stays at 29 candidates and no
findings; `columnsScanned` is unchanged at 185 tables and 2,179 columns, and
`insertOnlyColumns` at 770. No audit action: a priced invoice is still
`invoice.create`, and the breakdown is part of what that event created.

## Nominated for Phase 210

**An employee who cannot leave.**

`employees` has one insert and no update. `is_active` and `end_date` have no
writer, so somebody who left in March is still offered on every payroll run in
December, and `createPayrollRun` will accept a payslip for them because its own
check reads the same unnarrowed list. `tax_codes.is_active` is the same column
with the same absence.

It is nominated with its measurement already done, which is new for this run of
phases — and with the second half named, because the first half is the smaller
part: **the column census cannot see either of them**, since a
`select`-then-`filter` in JavaScript never writes the `table.column` string the
scan's read rule looks for. Phase 202 narrowed the default exclusion and closed
the six switches that narrowing exposed; the question this raises is how many
more sit behind the query shape rather than behind the exclusion. That is a
number to measure before anything is built on it, and this run of phases has
eight consecutive reasons to measure it first.

Behind that: a retire control for a tax code; the CRM account panel's missing
payables side (ADR 0208); the four joins from an unscoped primary (ADR 0198);
and §11's six remaining functions.
